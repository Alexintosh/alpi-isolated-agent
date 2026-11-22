'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');

const { installRuntime, listRuntimes, diskAdmissionBytes } = require('../src/runtime-installer.cjs');
const {
  makeRelease,
  pinnedProfile,
  statfsWithAvailable,
} = require('./runtime-fixture.cjs');

const WORKSPACE = process.cwd();
const PACKAGE_ROOT = path.resolve(__dirname, '..');
const BIN = path.join(PACKAGE_ROOT, 'bin', 'alpi-server.cjs');
const INSTALLER_PATH = path.join(PACKAGE_ROOT, 'src', 'runtime-installer.cjs');
const PLENTIFUL_DISK = statfsWithAvailable(1n << 40n);

function tempDirectory(t, label) {
  const directory = fs.mkdtempSync(
    path.join(WORKSPACE, `.runtime-cli-test-${label}-`)
  );
  fs.chmodSync(directory, 0o700);
  t.after(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function writeArchives(directory, release) {
  const archiveDirectory = path.join(directory, 'archives');
  fs.mkdirSync(archiveDirectory, { recursive: true, mode: 0o700 });
  const archives = {};
  for (const [url, archive] of Object.entries(release.archives)) {
    const file = path.join(
      archiveDirectory,
      `${require('node:crypto').createHash('sha256').update(url).digest('hex')}.tgz`
    );
    fs.writeFileSync(file, archive, { mode: 0o600 });
    archives[url] = file;
  }
  return archives;
}

// An SDK fixture that behaves like the real boxed SDK for image work: an ESM
// dist/index.js exposing a JsBoxlite whose digest-addressed image cache
// persists through the manifest marker written by the production wrapper.
function cliSdkEntries(version) {
  const sdkSource = [
    "import { appendFileSync, readFileSync, existsSync } from 'node:fs';",
    'const config = JSON.parse(readFileSync(process.env.ALPI_CLI_TEST_CONFIG, "utf8"));',
    'const record = (event) => appendFileSync(config.eventsPath, JSON.stringify({ source: "sdk", ...event }) + "\\n");',
    'export class JsBoxlite {',
    '  constructor(options) {',
    '    record({ type: "sdk-construct", homeDir: options.homeDir });',
    '    let versions = [];',
    '    const marker = options.homeDir + "/manifest.json";',
    '    if (existsSync(marker)) {',
    '      versions = [{ digest: JSON.parse(readFileSync(marker, "utf8")).manifestDigest }];',
    '    }',
    '    this.images = {',
    '      async get(repository) { record({ type: "sdk-get", repository }); return { versions }; },',
    '      async pull(reference) { record({ type: "sdk-pull", reference }); versions = [{ digest: reference.split("@")[1] }]; },',
    '    };',
    '  }',
    '  close() { record({ type: "sdk-close" }); }',
    '}',
  ].join('\n') + '\n';
  return [
    {
      name: 'package/package.json',
      mode: 0o644,
      content: Buffer.from(JSON.stringify({ name: '@boxlite-ai/boxlite', version, type: 'module' })),
    },
    { name: 'package/dist/index.js', mode: 0o644, content: Buffer.from(sdkSource) },
    { name: 'package/dist/agents.js', mode: 0o644, content: Buffer.from('sdk-agents-' + version) },
    { name: 'package/native/boxlite.js', mode: 0o644, content: Buffer.from('sdk-native-' + version) },
  ];
}

function preloadSource() {
  return `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const config = JSON.parse(fs.readFileSync(process.env.ALPI_CLI_TEST_CONFIG, 'utf8'));
const fsp = require('node:fs/promises');
fsp.statfs = async () => ({ bavail: BigInt(config.availableBytes), bsize: 1n });
function record(event) {
  fs.appendFileSync(config.eventsPath, JSON.stringify(event) + '\\n');
}
function fetchImpl(url) {
  const file = config.archives[url];
  if (!file) return Promise.reject(new Error('Unexpected URL ' + url));
  const body = fs.readFileSync(file);
  return Promise.resolve(new Response(body, {
    status: 200,
    headers: { 'content-length': String(body.length) },
  }));
}
const installer = require(config.installerPath);
const realPrepare = installer.prepareRuntime;
installer.prepareRuntime = (options) => {
  record({ type: 'prepare', additionalBytes: options.additionalBytes });
  return realPrepare({
    ...options,
    manifests: config.manifests,
    fetch: fetchImpl,
    statfs: async () => ({ bavail: BigInt(config.availableBytes), bsize: 1n }),
  });
};
const realCommit = installer.commitRuntimeSelection;
installer.commitRuntimeSelection = (options) => {
  record({ type: 'commit', set: options.set });
  return realCommit({ ...options, manifests: config.manifests });
};
const realVerifyRuntime = installer.verifyRuntime;
installer.verifyRuntime = (options) => realVerifyRuntime({
  ...options,
  manifests: config.manifests,
});
const callbackPath = require.resolve(
  path.join(config.packageRoot, 'src/network/callback-install.cjs')
);
if (!config.useRealDependencyModules) {
  require.cache[callbackPath] = {
    id: callbackPath,
    filename: callbackPath,
    loaded: true,
    exports: {
      callbackAdmissionBytes: async () => config.callbackBytes,
      ensureIronCallback: async (stateDir, { signal } = {}) => {
        record({ type: 'callback' });
        if (config.callbackMode === 'fail') {
          throw Object.assign(new Error('synthetic callback failure'), {
            name: 'IronError',
            code: 'npm_install_failed',
          });
        }
        if (config.callbackMode === 'hang') {
          return new Promise((resolve, reject) => {
            const timer = setInterval(() => {}, 1000);
            const abort = () => {
              clearInterval(timer);
              reject(signal.reason);
            };
            if (signal && signal.aborted) abort();
            else signal && signal.addEventListener('abort', abort, { once: true });
          });
        }
        return { digest: config.callbackDigest };
      },
    },
  };
}
const imagePath = require.resolve(
  path.join(config.packageRoot, 'src/profile-image.cjs')
);
if (!config.useRealDependencyModules && !config.useRealImageModule) {
  require.cache[imagePath] = {
    id: imagePath,
    filename: imagePath,
    loaded: true,
    exports: {
      imageAdmissionBytes: () => config.imageBytes,
      ensureImage: async (options) => {
        record({ type: 'image', set: options.set });
        if (config.imageMode === 'fail') throw new Error('synthetic image failure');
        return {
          profile: options.profile.name,
          image: options.profile.image,
          runtime: options.set,
          manifestDigest: options.profile.image.split('@')[1],
        };
      },
    },
  };
}
`;
}

function prepareHarness(t, label, options = {}) {
  const directory = tempDirectory(t, label);
  const release = options.release ?? makeRelease({
    version: options.version ?? '0.1.0',
    ...(options.sdkEntries ? { archiveEntries: { 'boxlite-sdk': options.sdkEntries } } : {}),
  });
  const stateDir = options.stateDir ?? path.join(directory, 'state');
  const preload = path.join(directory, 'preload.cjs');
  fs.writeFileSync(preload, preloadSource(), { mode: 0o600 });
  const config = {
    installerPath: INSTALLER_PATH,
    packageRoot: PACKAGE_ROOT,
    stateDir,
    manifests: release.manifests,
    archives: writeArchives(directory, release),
    eventsPath: path.join(directory, 'events.jsonl'),
    availableBytes: String(options.availableBytes ?? (1n << 40n)),
    callbackBytes: options.callbackBytes ?? 64 * 1024 * 1024,
    callbackMode: options.callbackMode ?? 'success',
    callbackDigest: 'b'.repeat(64),
    imageBytes: 8 * 1024 * 1024 * 1024,
    imageMode: options.imageMode ?? 'success',
    useRealDependencyModules: options.useRealDependencyModules ?? false,
    useRealImageModule: options.useRealImageModule ?? false,
  };
  const configPath = path.join(directory, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const profile = pinnedProfile('pi-dev', options.diskMiB ?? 8192, options.imagePreparationMiB ?? 512);
  const profilesPath = path.join(directory, 'profiles.json');
  fs.writeFileSync(
    profilesPath,
    JSON.stringify({ version: 1, providers: [], profiles: [profile] }),
    { mode: 0o600 }
  );
  return {
    directory,
    release,
    stateDir,
    config,
    configPath,
    preload,
    profilesPath,
    env: {
      ...process.env,
      NODE_OPTIONS: `--require=${preload}`,
      ALPI_CLI_TEST_CONFIG: configPath,
    },
    args: [
      'runtime',
      'install',
      '--state-dir',
      stateDir,
      '--engine',
      'boxlite',
      '--profile',
      'pi-dev',
      '--profiles',
      profilesPath,
    ],
  };
}

function readEvents(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function waitForEvent(file, type, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (readEvents(file).some((event) => event.type === type)) return;
    if (Date.now() >= deadline) throw new Error(`event ${type} did not appear`);
    await delay(25);
  }
}

function runCli(harness) {
  return spawnSync(process.execPath, [BIN, ...harness.args], {
    env: harness.env,
    encoding: 'utf8',
    timeout: 60_000,
  });
}

test('CLI prepares core, callback and requested image, then commits the exact candidate once', async (t) => {
  const harness = prepareHarness(t, 'success');

  const cli = runCli(harness);
  assert.equal(cli.status, 0, cli.stderr);
  const result = JSON.parse(cli.stdout);
  assert.match(result.set, /^boxlite-\d+\.\d+\.\d+-[a-f0-9]{16}$/);
  assert.deepEqual(result.ironCallback, { digest: harness.config.callbackDigest });
  assert.equal(result.profile.runtime, result.set);

  const events = readEvents(harness.config.eventsPath);
  assert.deepEqual(
    events.map((event) => event.type),
    ['prepare', 'callback', 'image', 'commit']
  );
  assert.equal(events[2].set, result.set);
  assert.equal(events[3].set, result.set);

  const inventory = await listRuntimes({ stateDir: harness.stateDir });
  assert.equal(inventory.active.id, result.set);
  assert.equal(inventory.previous, null);
});

test('CLI callback failure leaves active and previous unchanged and never commits', async (t) => {
  const firstRelease = makeRelease({ version: '0.1.0' });
  const secondRelease = makeRelease({ version: '0.2.0' });
  const baseState = path.join(tempDirectory(t, 'callback-base'), 'state');
  const first = await installRuntime({
    stateDir: baseState,
    manifests: firstRelease.manifests,
    fetch: require('./runtime-fixture.cjs').makeFetch(firstRelease.archives).fetch,
    statfs: PLENTIFUL_DISK,
  });
  const second = await installRuntime({
    stateDir: baseState,
    manifests: secondRelease.manifests,
    fetch: require('./runtime-fixture.cjs').makeFetch(secondRelease.archives).fetch,
    statfs: PLENTIFUL_DISK,
  });
  const harness = prepareHarness(t, 'callback-fail', {
    release: makeRelease({ version: '0.3.0' }),
    callbackMode: 'fail',
    stateDir: baseState,
  });
  assert.equal(path.resolve(harness.stateDir), path.resolve(baseState));

  const cli = runCli(harness);
  assert.equal(cli.status, 1);
  const events = readEvents(harness.config.eventsPath);
  assert.deepEqual(
    events.map((event) => event.type),
    ['prepare', 'callback']
  );
  const inventory = await listRuntimes({ stateDir: harness.stateDir });
  assert.equal(inventory.active.id, second.set);
  assert.equal(inventory.previous.id, first.set);
});

test('CLI requested image failure leaves active and previous unchanged and never commits', async (t) => {
  const harness = prepareHarness(t, 'image-fail', {
    version: '0.1.0',
    imageMode: 'fail',
  });
  const installed = await installRuntime({
    stateDir: harness.stateDir,
    manifests: harness.release.manifests,
    fetch: require('./runtime-fixture.cjs').makeFetch(harness.release.archives).fetch,
    statfs: PLENTIFUL_DISK,
  });

  const secondHarness = prepareHarness(t, 'image-fail-second', {
    release: makeRelease({ version: '0.2.0' }),
    imageMode: 'fail',
    stateDir: harness.stateDir,
  });
  const selectionPath = path.join(harness.stateDir, 'runtimes', 'current.json');
  const selectionBefore = fs.readFileSync(selectionPath);

  const cli = runCli(secondHarness);
  assert.equal(cli.status, 1);
  const events = readEvents(secondHarness.config.eventsPath);
  assert.deepEqual(
    events.map((event) => event.type),
    ['prepare', 'callback', 'image']
  );
  assert.match(events[2].set, /^boxlite-0\.2\.0-[a-f0-9]{16}$/);
  assert.notEqual(events[2].set, installed.set);
  // The child really used this directory: its selection bytes are untouched.
  assert.ok(fs.readFileSync(selectionPath).equals(selectionBefore));
  const inventory = await listRuntimes({ stateDir: harness.stateDir });
  assert.equal(inventory.active.id, installed.set);
  assert.equal(inventory.previous, null);
});

test('CLI termination during callback preparation preserves the active selection', async (t) => {
  const harness = prepareHarness(t, 'sigterm', {
    version: '0.1.0',
    callbackMode: 'hang',
  });
  const installed = await installRuntime({
    stateDir: harness.stateDir,
    manifests: harness.release.manifests,
    fetch: require('./runtime-fixture.cjs').makeFetch(harness.release.archives).fetch,
    statfs: PLENTIFUL_DISK,
  });

  const secondHarness = prepareHarness(t, 'sigterm-second', {
    release: makeRelease({ version: '0.2.0' }),
    callbackMode: 'hang',
    stateDir: harness.stateDir,
  });
  const selectionPath = path.join(harness.stateDir, 'runtimes', 'current.json');
  const selectionBefore = fs.readFileSync(selectionPath);

  const child = spawn(process.execPath, [BIN, ...secondHarness.args], {
    env: secondHarness.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise((resolve) => child.once('close', resolve));
  await waitForEvent(secondHarness.config.eventsPath, 'callback');
  child.kill('SIGTERM');
  const code = await exited;

  assert.notEqual(code, 0);
  const events = readEvents(secondHarness.config.eventsPath);
  assert.equal(events.some((event) => event.type === 'commit'), false);
  assert.ok(fs.readFileSync(selectionPath).equals(selectionBefore));
  const inventory = await listRuntimes({ stateDir: harness.stateDir });
  assert.equal(inventory.active.id, installed.set);
  assert.equal(inventory.previous, null);
});

test('CLI surfaces insufficient disk admission before acquisition or callback work', async (t) => {
  const harness = prepareHarness(t, 'low-disk', { availableBytes: 1 });

  const cli = runCli(harness);
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /Insufficient free space/);
  const events = readEvents(harness.config.eventsPath);
  assert.deepEqual(
    events.map((event) => event.type),
    ['prepare']
  );
  const inventory = await listRuntimes({ stateDir: harness.stateDir });
  assert.deepEqual(inventory, { active: null, previous: null, runtimes: [] });
});

test('real admission estimates flow through the CLI and reject before acquisition', async (t) => {
  const harness = prepareHarness(t, 'admission-real', {
    version: '0.1.0',
    availableBytes: 1,
    useRealDependencyModules: true,
  });

  // The expectation is computed from the REAL production exports: a fresh
  // state directory charges the full callback estimate; pinned-image
  // admission is separate and runs inside ensureImage once the candidate set
  // is known.
  const callbackInstall = require('../src/network/callback-install.cjs');
  const { imageAdmissionBytes } = require('../src/profile-image.cjs');
  const profile = pinnedProfile('pi-dev', 8192);
  const callbackBytes = await callbackInstall.callbackAdmissionBytes(harness.stateDir);
  assert.ok(callbackBytes > 0);
  assert.ok((await imageAdmissionBytes(profile)) > 0);

  const cli = runCli(harness);
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /Insufficient free space/);
  // The recorded core admission requirement is exactly the real callback
  // estimate, and nothing was acquired afterwards.
  const events = readEvents(harness.config.eventsPath);
  assert.deepEqual(events, [
    { type: 'prepare', additionalBytes: callbackBytes },
  ]);
  assert.deepEqual(await listRuntimes({ stateDir: harness.stateDir }), {
    active: null,
    previous: null,
    runtimes: [],
  });
});

test('CLI pinned-image admission is image-specific and rejects before any pull', async (t) => {
  const release = makeRelease({
    version: '0.1.0',
    archiveEntries: { 'boxlite-sdk': cliSdkEntries('0.1.0') },
  });
  const coreBytes = diskAdmissionBytes({
    manifests: release.manifests,
    existingValid: false,
    cacheValid: {},
  });
  const callbackBytes = 64 * 1024 * 1024;
  const harness = prepareHarness(t, 'image-admission', {
    release,
    imagePreparationMiB: 512,
    useRealImageModule: true,
    availableBytes: coreBytes + callbackBytes,
  });

  const cli = runCli(harness);
  assert.equal(cli.status, 1, cli.stderr);
  assert.match(cli.stderr, /Insufficient free space/);
  // Core admission carries only the callback estimate: the image bound is no
  // longer charged into runtime preparation.
  const events = readEvents(harness.config.eventsPath);
  assert.deepEqual(events, [
    { type: 'prepare', additionalBytes: callbackBytes },
    { type: 'callback' },
  ]);
  // The pinned image admission rejected before any SDK import or pull.
  assert.equal(events.some((event) => event.source === 'sdk'), false);
  assert.deepEqual(await listRuntimes({ stateDir: harness.stateDir }), {
    active: null,
    previous: null,
    runtimes: [],
  });
});

test('a small guest disk allowance cannot admit a larger pinned-image requirement', async (t) => {
  const release = makeRelease({
    version: '0.1.0',
    archiveEntries: { 'boxlite-sdk': cliSdkEntries('0.1.0') },
  });
  const coreBytes = diskAdmissionBytes({
    manifests: release.manifests,
    existingValid: false,
    cacheValid: {},
  });
  const callbackBytes = 64 * 1024 * 1024;
  const availableBytes = coreBytes + callbackBytes;
  // The retired formula (a 1 MiB guest disk limit plus 64 MiB headroom) would
  // have been admitted by this capacity and started the pull.
  assert.ok(availableBytes > 1024 * 1024 + 64 * 1024 * 1024);
  const harness = prepareHarness(t, 'image-admission-tiny-guest', {
    release,
    diskMiB: 1,
    imagePreparationMiB: 512,
    useRealImageModule: true,
    availableBytes,
  });

  const cli = runCli(harness);
  assert.equal(cli.status, 1, cli.stderr);
  assert.match(cli.stderr, /Insufficient free space/);
  const events = readEvents(harness.config.eventsPath);
  assert.equal(events.some((event) => event.source === 'sdk'), false);
  assert.deepEqual(await listRuntimes({ stateDir: harness.stateDir }), {
    active: null,
    previous: null,
    runtimes: [],
  });
});

test('CLI reuses a verified image cache without charging a fresh acquisition', async (t) => {
  const { createHash } = require('node:crypto');
  const { imageAdmissionBytes } = require('../src/profile-image.cjs');
  const profile = pinnedProfile('pi-dev', 8192, 512);
  const release = makeRelease({
    version: '0.1.0',
    archiveEntries: { 'boxlite-sdk': cliSdkEntries('0.1.0') },
  });

  const first = prepareHarness(t, 'image-cache-first', {
    release,
    imagePreparationMiB: 512,
    useRealImageModule: true,
  });
  const firstRun = runCli(first);
  assert.equal(firstRun.status, 0, firstRun.stderr);
  const set = JSON.parse(firstRun.stdout).set;
  const digest = profile.image.split('@')[1];
  const firstEvents = readEvents(first.config.eventsPath);
  assert.equal(firstEvents.filter((event) => event.type === 'sdk-pull').length, 1);

  // The real wrapper recorded the verified acquisition for this candidate.
  const cacheKey = createHash('sha256').update(set + '\n' + profile.image).digest('hex');
  const marker = JSON.parse(fs.readFileSync(
    path.join(first.stateDir, 'profile-images', cacheKey, 'manifest.json'),
    'utf8'
  ));
  assert.deepEqual(marker, { image: profile.image, runtime: set, manifestDigest: digest });

  // The second run's capacity only funds the intact core reinstall: it could
  // never fund a fresh image acquisition.
  const requiredFresh = await imageAdmissionBytes(profile);
  const availableBytes = diskAdmissionBytes({
    manifests: release.manifests,
    existingValid: true,
  });
  assert.ok(requiredFresh > availableBytes);

  const second = prepareHarness(t, 'image-cache-second', {
    release,
    stateDir: first.stateDir,
    imagePreparationMiB: 512,
    useRealImageModule: true,
    callbackBytes: 0,
    availableBytes,
  });
  const secondRun = runCli(second);
  assert.equal(secondRun.status, 0, secondRun.stderr);
  assert.equal(JSON.parse(secondRun.stdout).set, set);
  const secondEvents = readEvents(second.config.eventsPath);
  assert.deepEqual(
    secondEvents.map((event) => event.type),
    ['prepare', 'callback', 'sdk-construct', 'sdk-get', 'sdk-close', 'commit']
  );
  assert.equal(secondEvents.some((event) => event.type === 'sdk-pull'), false);
  const inventory = await listRuntimes({ stateDir: first.stateDir });
  assert.equal(inventory.active.id, set);
  assert.equal(inventory.previous, null);
});
