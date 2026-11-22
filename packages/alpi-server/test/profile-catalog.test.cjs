'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { makeProfileCatalog, readProfileCatalog } = require('../src/profile-catalog.cjs');

function config() {
  return { version: 1, providers: [{ name: 'gpu', models: ['coder/model'], upstream: {
    scheme: 'http', host: '127.0.0.1', port: 11434 }, credentialName: 'local-key', concurrency: 2 }],
    profiles: [{ name: 'pi-dev', engine: 'boxlite', image: 'registry.example/alpi/pi@sha256:' + 'a'.repeat(64),
      imagePreparationMiB: 512,
      projects: ['demo'], harnesses: ['pi'], providers: ['gpu'], limits: { vcpus: 2, memoryMiB: 2048, diskMiB: 8192 } }] };
}

test('project discovery excludes private inference destinations and limits model selection', () => {
  const catalog = makeProfileCatalog(config());
  assert.deepEqual(catalog.forProject('other'), []);
  const exposed = catalog.forProject('demo');
  assert.deepEqual(exposed[0].providers, [{ name: 'gpu', models: ['coder/model'] }]);
  assert.doesNotMatch(JSON.stringify(exposed), /11434|127\.0\.0\.1|local-key/);
  assert.equal(catalog.modelRoute('demo', 'boxlite', 'pi-dev', 'pi', 'gpu', 'coder/model').concurrency, 2);
  assert.throws(() => catalog.modelRoute('demo', 'boxlite', 'pi-dev', 'pi', 'gpu', 'other'), { code: 'model_unavailable' });
  assert.throws(() => catalog.resolve('other', 'boxlite', 'pi-dev'), { code: 'profile_unavailable' });
});

test('operator configuration must pin its image and name exact inference authorities', () => {
  for (const edit of [
    c => { c.profiles[0].image = 'registry.example/alpi/pi:latest'; },
    c => { c.providers[0].upstream.host = 'arbitrary.example'; },
    c => { c.providers[0].token = 'do-not-store'; },
    c => { c.profiles[0].providers = ['unknown']; },
  ]) {
    const c = config(); edit(c);
    assert.throws(() => makeProfileCatalog(c), { code: 'invalid_host_config' });
  }
});

test('operator file is bounded and read only from a trusted regular file', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'alpi-catalog-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'profiles.json');
  await fs.writeFile(file, JSON.stringify(config()), { mode: 0o600 });
  assert.equal((await readProfileCatalog(file)).forProject('demo').length, 1);
  await fs.symlink(file, path.join(dir, 'link'));
  await assert.rejects(readProfileCatalog(path.join(dir, 'link')));
  await fs.chmod(file, 0o666);
  await assert.rejects(readProfileCatalog(file), { code: 'invalid_host_config' });
  await fs.chmod(file, 0o600);
  await fs.writeFile(file, Buffer.alloc(65537));
  await assert.rejects(readProfileCatalog(file), { code: 'invalid_host_config' });
});

test('profile image install verifies the registry manifest and reuses its cached layers', async () => {
  const { cachePinnedImage } = require('../src/profile-image.cjs');
  const image = config().profiles[0].image;
  const digest = image.split('@')[1];
  const versions = [];
  let pulls = 0;
  const runtime = { images: {
    async get() { return { versions }; },
    async pull(ref) { assert.equal(ref, image); pulls++; versions.push({ digest }); },
  } };
  assert.equal(await cachePinnedImage(runtime, image), digest);
  assert.equal(await cachePinnedImage(runtime, image), digest);
  assert.equal(pulls, 1);
  await assert.rejects(cachePinnedImage({ images: {
    get: async () => ({ versions: [] }), pull: async () => ({ configDigest: digest }),
  } }, image));
});

test('image admission is derived from the pinned image preparation, not the guest disk limit', async () => {
  const { ensureImage, imageAdmissionBytes, IMAGE_CACHE_OVERHEAD_BYTES } = require('../src/profile-image.cjs');
  const profile = config().profiles[0];
  await assert.rejects(
    ensureImage({ stateDir: '/nonexistent-state', profile }),
    /prepared runtime set/
  );

  const required = await imageAdmissionBytes(profile);
  assert.equal(required, 512 * 1024 * 1024 + IMAGE_CACHE_OVERHEAD_BYTES);
  // The same pinned image behind a 1 MiB guest disk allowance has an
  // identical, larger-than-guest preparation bound.
  const tiny = { ...profile, limits: { ...profile.limits, diskMiB: 1 } };
  assert.equal(await imageAdmissionBytes(tiny), required);
  assert.ok(required > tiny.limits.diskMiB * 1024 * 1024);
  // The retired guest-disk formula would have admitted this acquisition with
  // well under 100 MiB available.
  assert.ok(required > 100 * 1024 * 1024);

  await assert.rejects(
    imageAdmissionBytes({ limits: profile.limits }),
    /image preparation bound/
  );
  await assert.rejects(
    imageAdmissionBytes(profile, { stateDir: '/tmp/alpi-state' }),
    /state directory and prepared runtime set/
  );
});

test('image admission rejects short capacity before acquisition', async (t) => {
  const { assertImageAdmission, IMAGE_CACHE_OVERHEAD_BYTES } = require('../src/profile-image.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'alpi-image-admission-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const profile = config().profiles[0];
  const required = 512 * 1024 * 1024 + IMAGE_CACHE_OVERHEAD_BYTES;
  const statfsWith = (bytes) => async () => ({ bavail: BigInt(bytes), bsize: 1n });

  await assert.rejects(
    assertImageAdmission({
      stateDir: dir, profile, set: 'boxlite-0.9.0-0123456789abcdef', statfs: statfsWith(required - 1),
    }),
    (error) => error.name === 'RuntimeInstallerError' && error.code === 'insufficient_disk_space'
  );
  const admitted = await assertImageAdmission({
    stateDir: dir, profile, set: 'boxlite-0.9.0-0123456789abcdef', statfs: statfsWith(required),
  });
  assert.equal(admitted.required, required);
  assert.equal(admitted.available, BigInt(required));
});

test('a verified image cache entry is not charged as a fresh acquisition', async (t) => {
  const { imageAdmissionBytes, assertImageAdmission } = require('../src/profile-image.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'alpi-image-cache-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const stateDir = path.join(dir, 'state');
  const profile = config().profiles[0];
  const set = 'boxlite-0.9.0-0123456789abcdef';
  const required = await imageAdmissionBytes(profile);
  const cacheKey = createHash('sha256').update(set + '\n' + profile.image).digest('hex');
  const markerPath = path.join(stateDir, 'profile-images', cacheKey, 'manifest.json');
  await fs.mkdir(path.dirname(markerPath), { recursive: true, mode: 0o700 });

  // The private cache directory alone is not credited: nothing verified it.
  assert.equal(await imageAdmissionBytes(profile, { stateDir, set }), required);

  await fs.writeFile(markerPath,
    JSON.stringify({ image: profile.image, runtime: set, manifestDigest: 'sha256:' + 'c'.repeat(64) }),
    { mode: 0o600 });
  assert.equal(await imageAdmissionBytes(profile, { stateDir, set }), 0);
  // With the credit, admission passes at capacity that could not fund any
  // fresh acquisition.
  const admitted = await assertImageAdmission({
    stateDir, profile, set, statfs: async () => ({ bavail: 1024n, bsize: 1n }),
  });
  assert.equal(admitted.required, 0);

  // A marker for a different candidate is not credited.
  await fs.writeFile(markerPath,
    JSON.stringify({ image: profile.image, runtime: 'other-set', manifestDigest: 'sha256:' + 'c'.repeat(64) }),
    { mode: 0o600 });
  assert.equal(await imageAdmissionBytes(profile, { stateDir, set }), required);
});

test('profile image pull observes cancellation', async () => {
  const { cachePinnedImage } = require('../src/profile-image.cjs');
  const controller = new AbortController();
  controller.abort();
  let pulls = 0;
  await assert.rejects(
    cachePinnedImage(
      {
        images: {
          async get() { return { versions: [] }; },
          async pull() { pulls += 1; },
        },
      },
      config().profiles[0].image,
      controller.signal
    ),
    (error) => error && error.name === 'AbortError'
  );
  assert.equal(pulls, 0);
});

test('cancellation during the cache lookup never dispatches a pull', async () => {
  const { cachePinnedImage } = require('../src/profile-image.cjs');
  const image = config().profiles[0].image;
  let releaseLookup;
  const lookupGate = new Promise((resolve) => { releaseLookup = resolve; });
  let pulls = 0;
  const controller = new AbortController();
  const pending = cachePinnedImage(
    {
      images: {
        async get() { await lookupGate; return { versions: [] }; },
        async pull() { pulls += 1; },
      },
    },
    image,
    controller.signal
  );
  // The wrapper is parked inside the deferred lookup here.
  controller.abort();
  releaseLookup();
  await assert.rejects(pending, (error) => error && error.name === 'AbortError');
  assert.equal(pulls, 0);
});

test('a failed cache lookup is not converted into a fresh pull', async () => {
  const { cachePinnedImage } = require('../src/profile-image.cjs');
  const image = config().profiles[0].image;
  let pulls = 0;
  await assert.rejects(
    cachePinnedImage(
      {
        images: {
          async get() { throw new Error('lookup failed'); },
          async pull() { pulls += 1; },
        },
      },
      image
    ),
    /lookup failed/
  );
  assert.equal(pulls, 0);
});

test('real ensureImage verifies the supplied candidate set on a fresh unselected state', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'alpi-image-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const stateDir = path.join(dir, 'state');
  await fs.mkdir(stateDir, { mode: 0o700 });
  const profile = config().profiles[0];
  const candidateSet = 'boxlite-0.9.0-0123456789abcdef';
  const digest = profile.image.split('@')[1];

  // Fixture SDK standing in for the real boxed runtime SDK import.
  const sdkRoot = path.join(dir, 'sdk');
  await fs.mkdir(path.join(sdkRoot, 'dist'), { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(sdkRoot, 'dist', 'index.js'),
    [
      'const events = (globalThis.__alpiImageProbe ??= []);',
      'let versions = [];',
      'export class JsBoxlite {',
      '  constructor(options) {',
      '    events.push({ type: "construct", homeDir: options.homeDir });',
      '    this.images = {',
      '      async get(repository) {',
      '        events.push({ type: "get", repository });',
      '        return { versions };',
      '      },',
      '      async pull(reference) {',
      '        events.push({ type: "pull", reference });',
      '        versions = [{ digest: reference.split("@")[1] }];',
      '      },',
      '    };',
      '  }',
      '  close() {}',
      '}',
    ].join('\n') + '\n',
    { mode: 0o600 }
  );

  // Substitute only the verifyRuntime external boundary; ensureImage itself is
  // the real production wrapper, freshly loaded so it captures the sentinel.
  const installerPath = require.resolve('../src/runtime-installer.cjs');
  const imagePath = require.resolve('../src/profile-image.cjs');
  const installer = require(installerPath);
  const originalVerify = installer.verifyRuntime;
  const verified = [];
  installer.verifyRuntime = async (options) => {
    verified.push(options);
    return { set: candidateSet, paths: { sdk: sdkRoot } };
  };
  delete require.cache[imagePath];
  try {
    const { ensureImage } = require(imagePath);

    // A missing candidate set is rejected before any verification or import.
    await assert.rejects(
      ensureImage({ stateDir, profile }),
      /prepared runtime set/
    );
    assert.deepEqual(verified, []);

    // An already aborted signal rejects before verification too.
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      ensureImage({ stateDir, profile, set: candidateSet, signal: controller.signal }),
      (error) => error && error.name === 'AbortError'
    );
    assert.deepEqual(verified, []);

    const result = await ensureImage({
      stateDir, profile, set: candidateSet, statfs: async () => ({ bavail: 1n << 40n, bsize: 1n }),
    });
    assert.deepEqual(result, {
      profile: 'pi-dev',
      image: profile.image,
      runtime: candidateSet,
      manifestDigest: digest,
    });
    // Exactly the supplied candidate was verified; the state directory has no
    // selection at all, so a current-selection fallback could not have worked.
    assert.deepEqual(verified, [{ stateDir, set: candidateSet }]);
    await assert.rejects(
      fs.lstat(path.join(stateDir, 'runtimes', 'current.json')),
      { code: 'ENOENT' }
    );

    const cacheKey = require('node:crypto')
      .createHash('sha256')
      .update(candidateSet + '\n' + profile.image)
      .digest('hex');
    const events = globalThis.__alpiImageProbe;
    assert.deepEqual(
      events.map((event) => event.type),
      ['construct', 'get', 'pull', 'get']
    );
    assert.equal(events[0].homeDir, path.join(stateDir, 'profile-images', cacheKey));
    assert.equal(events[1].repository, 'registry.example/alpi/pi');
    assert.equal(events[2].reference, profile.image);
    assert.ok((await fs.stat(path.join(stateDir, 'profile-images', cacheKey))).isDirectory());
    // The verified acquisition is recorded so a later admission can credit
    // this cache instead of charging a fresh pull.
    const marker = JSON.parse(
      await fs.readFile(path.join(stateDir, 'profile-images', cacheKey, 'manifest.json'), 'utf8')
    );
    assert.deepEqual(marker, { image: profile.image, runtime: candidateSet, manifestDigest: digest });
  } finally {
    installer.verifyRuntime = originalVerify;
    delete require.cache[imagePath];
  }
});

// Real ensureImage with only its external boundaries substituted: candidate
// verification resolves a fixture SDK and the SDK module is a synthetic
// stand-in that records events on globalThis.__alpiImageProbe (in process).
async function imageHarness(t, { sdkSource } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'alpi-image-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const stateDir = path.join(dir, 'state');
  await fs.mkdir(stateDir, { mode: 0o700 });
  const sdkRoot = path.join(dir, 'sdk');
  await fs.mkdir(path.join(sdkRoot, 'dist'), { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(sdkRoot, 'dist', 'index.js'),
    sdkSource ?? [
      'const events = (globalThis.__alpiImageProbe ??= []);',
      'let versions = [];',
      'export class JsBoxlite {',
      '  constructor(options) {',
      '    events.push({ type: "construct", homeDir: options.homeDir });',
      '    this.images = {',
      '      async get(repository) {',
      '        events.push({ type: "get", repository });',
      '        return { versions };',
      '      },',
      '      async pull(reference) {',
      '        events.push({ type: "pull", reference });',
      '        versions = [{ digest: reference.split("@")[1] }];',
      '      },',
      '    };',
      '  }',
      '  close() { events.push({ type: "close" }); }',
      '}',
    ].join('\n') + '\n',
    { mode: 0o600 }
  );

  const installerPath = require.resolve('../src/runtime-installer.cjs');
  const imagePath = require.resolve('../src/profile-image.cjs');
  const installer = require(installerPath);
  const originalVerify = installer.verifyRuntime;
  const verified = [];
  installer.verifyRuntime = async (options) => {
    verified.push(options);
    return { set: options.set, paths: { sdk: sdkRoot } };
  };
  delete require.cache[imagePath];
  const { ensureImage } = require(imagePath);
  t.after(() => {
    installer.verifyRuntime = originalVerify;
    delete require.cache[imagePath];
  });
  const events = (globalThis.__alpiImageProbe ??= []);
  events.length = 0;
  return { dir, stateDir, events, verified, ensureImage };
}

async function waitForProbeEvent(events, type) {
  const deadline = Date.now() + 5000;
  while (!events.some((event) => event.type === type)) {
    if (Date.now() > deadline) throw new Error('event ' + type + ' did not appear');
    await delay(5);
  }
}

test('real ensureImage rejects a pinned image whose preparation exceeds capacity before any pull', async (t) => {
  const { IMAGE_CACHE_OVERHEAD_BYTES } = require('../src/profile-image.cjs');
  const harness = await imageHarness(t);
  const profile = config().profiles[0];
  const candidateSet = 'boxlite-0.9.0-0123456789abcdef';
  const required = 512 * 1024 * 1024 + IMAGE_CACHE_OVERHEAD_BYTES;

  // (a) The pinned image's preparation requirement exceeds the available
  // capacity: rejected before verification, SDK import or pull.
  await assert.rejects(
    harness.ensureImage({
      stateDir: harness.stateDir, profile, set: candidateSet,
      statfs: async () => ({ bavail: BigInt(required - 1), bsize: 1n }),
    }),
    (error) => error.name === 'RuntimeInstallerError' && error.code === 'insufficient_disk_space'
  );
  assert.deepEqual(harness.verified, []);
  assert.deepEqual(harness.events, []);

  // (b) A 1 MiB guest disk allowance cannot suffice for the larger pinned
  // image requirement: the retired guest-disk formula (1 MiB plus fixed
  // overhead) would have admitted this acquisition at 100 MiB available.
  const tiny = { ...profile, limits: { ...profile.limits, diskMiB: 1 } };
  await assert.rejects(
    harness.ensureImage({
      stateDir: harness.stateDir, profile: tiny, set: candidateSet,
      statfs: async () => ({ bavail: 100n * 1024n * 1024n, bsize: 1n }),
    }),
    (error) => error.name === 'RuntimeInstallerError' && error.code === 'insufficient_disk_space'
  );
  assert.deepEqual(harness.events, []);
});

test('real ensureImage admits a verified cached image at low capacity without re-pulling', async (t) => {
  const harness = await imageHarness(t);
  const profile = config().profiles[0];
  const candidateSet = 'boxlite-0.9.0-0123456789abcdef';
  const digest = profile.image.split('@')[1];

  const first = await harness.ensureImage({
    stateDir: harness.stateDir, profile, set: candidateSet,
    statfs: async () => ({ bavail: 1n << 40n, bsize: 1n }),
  });
  assert.deepEqual(first, {
    profile: 'pi-dev', image: profile.image, runtime: candidateSet, manifestDigest: digest,
  });
  assert.deepEqual(
    harness.events.map((event) => event.type),
    ['construct', 'get', 'pull', 'get', 'close']
  );

  // Second call at capacity far below any fresh-acquisition bound: the
  // verified cache is credited and the image is not pulled again.
  const second = await harness.ensureImage({
    stateDir: harness.stateDir, profile, set: candidateSet,
    statfs: async () => ({ bavail: 1024n, bsize: 1n }),
  });
  assert.deepEqual(second, first);
  assert.deepEqual(
    harness.events.slice(5).map((event) => event.type),
    ['construct', 'get', 'close']
  );
});

test('real ensureImage never starts a pull after a lookup-window cancellation', async (t) => {
  let releaseLookup;
  const lookupGate = new Promise((resolve) => { releaseLookup = resolve; });
  const harness = await imageHarness(t, { sdkSource: [
    'const events = (globalThis.__alpiImageProbe ??= []);',
    'const gate = (globalThis.__alpiImageLookupGate ??= {});',
    'export class JsBoxlite {',
    '  constructor(options) {',
    '    events.push({ type: "construct", homeDir: options.homeDir });',
    '    this.images = {',
    '      async get(repository) {',
    '        events.push({ type: "get", repository });',
    '        await gate.promise;',
    '        return { versions: [] };',
    '      },',
    '      async pull(reference) {',
    '        events.push({ type: "pull", reference });',
    '      },',
    '    };',
    '  }',
    '  close() { events.push({ type: "close" }); }',
    '}',
  ].join('\n') + '\n' });
  const profile = config().profiles[0];
  const candidateSet = 'boxlite-0.9.0-0123456789abcdef';
  const controller = new AbortController();
  globalThis.__alpiImageLookupGate = { promise: lookupGate };

  const pending = harness.ensureImage({
    stateDir: harness.stateDir, profile, set: candidateSet,
    signal: controller.signal,
    statfs: async () => ({ bavail: 1n << 40n, bsize: 1n }),
  });
  try {
    // Deterministic: the wrapper is parked inside the deferred lookup.
    await waitForProbeEvent(harness.events, 'get');
    controller.abort();
  } finally {
    releaseLookup();
  }
  await assert.rejects(pending, (error) => error && error.name === 'AbortError');
  assert.equal(harness.events.some((event) => event.type === 'pull'), false);
  assert.equal(harness.events[harness.events.length - 1].type, 'close');
  await assert.rejects(
    fs.lstat(path.join(harness.stateDir, 'runtimes', 'current.json')),
    { code: 'ENOENT' }
  );
});

test('a cache miss revokes the receipt credit and enforces the full fresh admission before pulling', async (t) => {
  const { cachePinnedImage, IMAGE_CACHE_OVERHEAD_BYTES } = require('../src/profile-image.cjs');
  const image = config().profiles[0].image;
  const digest = image.split('@')[1];
  const profile = config().profiles[0];
  const set = 'boxlite-0.9.0-0123456789abcdef';
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'alpi-image-miss-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const stateDir = path.join(dir, 'state');
  await fs.mkdir(stateDir, { mode: 0o700 });
  const required = 512 * 1024 * 1024 + IMAGE_CACHE_OVERHEAD_BYTES;
  const statfsWith = (bytes) => async () => ({ bavail: BigInt(bytes), bsize: 1n });
  let pulls = 0;
  const native = { images: {
    async get() { return { versions: pulls > 0 ? [{ digest }] : [] }; },
    async pull(ref) { assert.equal(ref, image); pulls += 1; },
  } };
  const admission = { stateDir, profile, set };

  // The lookup reports a miss while available capacity is below the fresh
  // requirement: fail closed with the typed rejection and zero pulls.
  await assert.rejects(
    cachePinnedImage(native, image, undefined, { ...admission, statfs: statfsWith(required - 1) }),
    (error) => error.name === 'RuntimeInstallerError' && error.code === 'insufficient_disk_space'
  );
  assert.equal(pulls, 0);

  // The same miss at ample capacity proceeds to a successful pull.
  assert.equal(
    await cachePinnedImage(native, image, undefined, { ...admission, statfs: statfsWith(required) }),
    digest
  );
  assert.equal(pulls, 1);
});

test('real ensureImage re-enforces the fresh requirement when a retained receipt misses the native cache', async (t) => {
  const harness = await imageHarness(t, { sdkSource: [
    'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
    'const events = (globalThis.__alpiImageProbe ??= []);',
    'export class JsBoxlite {',
    '  constructor(options) {',
    '    events.push({ type: "construct", homeDir: options.homeDir });',
    '    // The native cache state lives in its own store file, independent of',
    '    // the wrapper receipt marker, so a receipt can survive a native miss.',
    '    const store = options.homeDir + "/native-store.json";',
    '    let versions = existsSync(store) ? JSON.parse(readFileSync(store, "utf8")) : [];',
    '    this.images = {',
    '      async get(repository) {',
    '        events.push({ type: "get", repository });',
    '        return { versions };',
    '      },',
    '      async pull(reference) {',
    '        events.push({ type: "pull", reference });',
    '        versions = [{ digest: reference.split("@")[1] }];',
    '        writeFileSync(store, JSON.stringify(versions));',
    '      },',
    '    };',
    '  }',
    '  close() { events.push({ type: "close" }); }',
    '}',
  ].join('\n') + '\n' });
  const profile = config().profiles[0];
  const candidateSet = 'boxlite-0.9.0-0123456789abcdef';
  const digest = profile.image.split('@')[1];
  const cacheKey = require('node:crypto')
    .createHash('sha256')
    .update(candidateSet + '\n' + profile.image)
    .digest('hex');
  const cacheDir = path.join(harness.stateDir, 'profile-images', cacheKey);
  const receiptPath = path.join(cacheDir, 'manifest.json');

  // First acquisition at ample capacity: an authentic receipt written by the
  // real wrapper after a fully verified pull.
  const first = await harness.ensureImage({
    stateDir: harness.stateDir, profile, set: candidateSet,
    statfs: async () => ({ bavail: 1n << 40n, bsize: 1n }),
  });
  assert.deepEqual(first, {
    profile: 'pi-dev', image: profile.image, runtime: candidateSet, manifestDigest: digest,
  });
  const receiptBefore = await fs.readFile(receiptPath, 'utf8');

  // The native cache loses the pinned manifest while the receipt survives.
  await fs.rm(path.join(cacheDir, 'native-store.json'));

  // The wrapper must fail closed at 1024 available bytes: typed rejection,
  // zero new pulls, receipt and selection untouched.
  await assert.rejects(
    harness.ensureImage({
      stateDir: harness.stateDir, profile, set: candidateSet,
      statfs: async () => ({ bavail: 1024n, bsize: 1n }),
    }),
    (error) => error.name === 'RuntimeInstallerError' && error.code === 'insufficient_disk_space'
  );
  assert.deepEqual(
    harness.events.slice(5).map((event) => event.type),
    ['construct', 'get', 'close']
  );
  assert.equal(await fs.readFile(receiptPath, 'utf8'), receiptBefore);
  await assert.rejects(
    fs.lstat(path.join(harness.stateDir, 'runtimes', 'current.json')),
    { code: 'ENOENT' }
  );

  // The same miss at ample capacity pulls and succeeds; the receipt stays valid.
  const third = await harness.ensureImage({
    stateDir: harness.stateDir, profile, set: candidateSet,
    statfs: async () => ({ bavail: 1n << 40n, bsize: 1n }),
  });
  assert.deepEqual(third, first);
  assert.deepEqual(
    harness.events.slice(8).map((event) => event.type),
    ['construct', 'get', 'pull', 'get', 'close']
  );
  assert.deepEqual(JSON.parse(await fs.readFile(receiptPath, 'utf8')), {
    image: profile.image, runtime: candidateSet, manifestDigest: digest,
  });
});
