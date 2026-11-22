'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { makeProfileCatalog, readProfileCatalog } = require('../src/profile-catalog.cjs');

function config() {
  return { version: 1, providers: [{ name: 'gpu', models: ['coder/model'], upstream: {
    scheme: 'http', host: '127.0.0.1', port: 11434 }, credentialName: 'local-key', concurrency: 2 }],
    profiles: [{ name: 'pi-dev', engine: 'boxlite', image: 'registry.example/alpi/pi@sha256:' + 'a'.repeat(64),
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

test('profile image preparation is bound to an explicit candidate and uses a conservative admission bound', async () => {
  const { ensureImage, imageAdmissionBytes, IMAGE_CACHE_OVERHEAD_BYTES } = require('../src/profile-image.cjs');
  const profile = config().profiles[0];
  await assert.rejects(
    ensureImage({ stateDir: '/nonexistent-state', profile }),
    /prepared runtime set/
  );
  assert.equal(
    imageAdmissionBytes(profile),
    profile.limits.diskMiB * 1024 * 1024 + IMAGE_CACHE_OVERHEAD_BYTES
  );
  assert.throws(() => imageAdmissionBytes({ limits: {} }), /disk limit/);
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

    const result = await ensureImage({ stateDir, profile, set: candidateSet });
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
  } finally {
    installer.verifyRuntime = originalVerify;
    delete require.cache[imagePath];
  }
});
