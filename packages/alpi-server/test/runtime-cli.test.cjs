'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');

const { installRuntime, listRuntimes } = require('../src/runtime-installer.cjs');
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

function preloadSource() {
  return `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const config = JSON.parse(fs.readFileSync(process.env.ALPI_CLI_TEST_CONFIG, 'utf8'));
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
if (!config.useRealDependencyModules) {
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
  const release = options.release ?? makeRelease({ version: options.version ?? '0.1.0' });
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
    callbackBytes: 64 * 1024 * 1024,
    callbackMode: options.callbackMode ?? 'success',
    callbackDigest: 'b'.repeat(64),
    imageBytes: 8 * 1024 * 1024 * 1024,
    imageMode: options.imageMode ?? 'success',
    useRealDependencyModules: options.useRealDependencyModules ?? false,
  };
  const configPath = path.join(directory, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const profile = pinnedProfile('pi-dev', 8192);
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
  // state directory charges the full callback estimate plus the trusted
  // profile's image admission bound (diskMiB 8192 plus fixed headroom).
  const callbackInstall = require('../src/network/callback-install.cjs');
  const { imageAdmissionBytes } = require('../src/profile-image.cjs');
  const profile = pinnedProfile('pi-dev', 8192);
  const callbackBytes = await callbackInstall.callbackAdmissionBytes(harness.stateDir);
  const expectedAdditional = callbackBytes + imageAdmissionBytes(profile);
  assert.ok(callbackBytes > 0);
  assert.ok(imageAdmissionBytes(profile) > 0);

  const cli = runCli(harness);
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /Insufficient free space/);
  // The recorded admission requirement is exactly the sum of the real
  // callback and image estimates, and nothing was acquired afterwards.
  const events = readEvents(harness.config.eventsPath);
  assert.deepEqual(events, [
    { type: 'prepare', additionalBytes: expectedAdditional },
  ]);
  assert.deepEqual(await listRuntimes({ stateDir: harness.stateDir }), {
    active: null,
    previous: null,
    runtimes: [],
  });
});
