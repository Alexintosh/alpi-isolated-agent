'use strict';

/**
 * Contract tests for the engine registry and the BoxLite adapter.
 *
 * The fake SDK deliberately mirrors the stock @boxlite-ai/boxlite 0.14.1
 * shapes: getOrCreate returns { created, box }, JsBox exposes id/name/info/
 * exec/start/stop/export, JsExecution exposes id/stdout/stderr/wait/kill, and
 * JsBoxInfo carries state { status, running, exitCode? }. No VM is started.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const {
  EngineRegistryError,
  createEngineRegistry,
} = require('../src/engines/registry.cjs');
const {
  BoxliteEngineError,
  createBoxliteAdapter,
} = require('../src/engines/boxlite.cjs');

const WORKSPACE = process.cwd();
const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';
const IMAGE = `registry.example/alpi@sha256:${'a'.repeat(64)}`;
const LIMITS = Object.freeze({ cpus: 2, memoryMib: 2048, diskSizeGb: 10 });

function tempDirectory(t, label) {
  const directory = fs.mkdtempSync(
    path.join(WORKSPACE, `.engines-test-${label}-`)
  );
  fs.chmodSync(directory, 0o700);
  t.after(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function assertCode(expectedCode) {
  return (error) => {
    assert.ok(
      error instanceof BoxliteEngineError || error instanceof EngineRegistryError
    );
    assert.equal(error.code, expectedCode);
    return true;
  };
}

class FakeBox {
  constructor(runtime, { id, name, image, cpus, memoryMib, createdAt }) {
    this.runtime = runtime;
    this.id = id;
    this.name = name;
    this.image = image;
    this.cpus = cpus;
    this.memoryMib = memoryMib;
    this.createdAt = createdAt;
    this.startedAt = undefined;
    this.state = { status: 'created', running: false };
    this.execCalls = [];
    this.startCalls = 0;
    this.stopCalls = 0;
  }

  async info() {
    return {
      id: this.id,
      name: this.name,
      state: { ...this.state },
      createdAt: this.createdAt,
      ...(this.startedAt === undefined ? {} : { startedAt: this.startedAt }),
      image: this.image,
      cpus: this.cpus,
      memoryMib: this.memoryMib,
      network: this.network ?? {
        outbound: { mode: 'disabled', allowNet: [] },
        inbound: { mode: 'disabled', allowNet: [] },
        mode: 'disabled',
        allowNet: [],
        publishedPorts: [],
      },
      autoStop: 0,
      autoDelete: 0,
      autoResume: false,
      healthStatus: { state: 'None', failures: 0 },
    };
  }

  async start() {
    this.startCalls += 1;
    this.startedAt = new Date().toISOString();
    this.state = { status: 'running', running: true, pid: 1234 };
  }

  async stop() {
    this.stopCalls += 1;
    this.state = { status: 'stopped', running: false, exitCode: 0 };
  }

  async export(destination) {
    fs.writeFileSync(destination, 'fake-archive', { mode: 0o600 });
    return destination;
  }

  async exec(command, args, env, tty, user, timeoutSecs, workingDir) {
    this.execCalls.push({
      command,
      args,
      env,
      tty,
      user,
      timeoutSecs,
      workingDir,
    });
    return this.runtime.execFactory({ command, args, tty });
  }
}

class FakeJsBoxlite {
  constructor(options) {
    this.options = options;
    this.boxes = new Map();
    this.calls = [];
    this.execFactory = () => normalExecution({ stdoutChunks: ['ok'] });
    this.counter = 0;
    this.closed = false;
    FakeJsBoxlite.lastInstance = this;
  }

  find(idOrName) {
    if (this.boxes.has(idOrName)) {
      return this.boxes.get(idOrName);
    }
    for (const box of this.boxes.values()) {
      if (box.name === idOrName) {
        return box;
      }
    }
    return null;
  }

  async getOrCreate(options, name) {
    this.calls.push({ method: 'getOrCreate', options, name });
    const existing = this.find(name);
    if (existing) {
      return { created: false, box: existing };
    }
    this.counter += 1;
    const box = new FakeBox(this, {
      id: `native-${this.counter}`,
      name,
      image: options.image,
      cpus: options.cpus,
      memoryMib: options.memoryMib,
      createdAt: new Date().toISOString(),
    });
    box.network = structuredClone(options.network);
    this.boxes.set(box.id, box);
    return { created: true, box };
  }

  async listInfo() {
    return Promise.all([...this.boxes.values()].map((box) => box.info()));
  }

  async getInfo(idOrName) {
    const box = this.find(idOrName);
    return box === null ? null : box.info();
  }

  async get(idOrName) {
    return this.find(idOrName);
  }

  async remove(idOrName, force) {
    const box = this.find(idOrName);
    if (box === null) {
      if (force === true) {
        return;
      }
      throw new Error('missing box');
    }
    this.boxes.delete(box.id);
  }

  async importBox(archivePath, name) {
    this.calls.push({ method: 'importBox', archivePath, name });
    this.counter += 1;
    const box = new FakeBox(this, {
      id: `native-${this.counter}`,
      name,
      image: IMAGE,
      cpus: LIMITS.cpus,
      memoryMib: LIMITS.memoryMib,
      createdAt: new Date().toISOString(),
    });
    this.boxes.set(box.id, box);
    return box;
  }

  close() {
    this.closed = true;
  }
}

function normalExecution({ stdoutChunks = [], stderrChunks = [] }) {
  let stdoutIndex = 0;
  let stderrIndex = 0;
  const execution = {
    killCalls: 0,
    async id() {
      return 'exec-normal';
    },
    async stdout() {
      return {
        async next() {
          if (stdoutIndex >= stdoutChunks.length) {
            return null;
          }
          const chunk = stdoutChunks[stdoutIndex];
          stdoutIndex += 1;
          return chunk;
        },
      };
    },
    async stderr() {
      return {
        async next() {
          if (stderrIndex >= stderrChunks.length) {
            return null;
          }
          const chunk = stderrChunks[stderrIndex];
          stderrIndex += 1;
          return chunk;
        },
      };
    },
    async wait() {
      return { exitCode: 0 };
    },
    async kill() {
      execution.killCalls += 1;
    },
    async resizeTty() {},
  };
  return execution;
}

function blockingExecution({ stdoutChunks = [], stderrChunks = [] } = {}) {
  let killed = false;
  let resolveKill;
  const killPromise = new Promise((resolve) => {
    resolveKill = resolve;
  });
  let stdoutIndex = 0;
  let stderrIndex = 0;
  const execution = {
    killCalls: 0,
    async id() {
      return 'exec-blocking';
    },
    async stdout() {
      return {
        async next() {
          if (stdoutIndex < stdoutChunks.length) {
            const chunk = stdoutChunks[stdoutIndex];
            stdoutIndex += 1;
            return chunk;
          }
          if (!killed) {
            await killPromise;
          }
          return null;
        },
      };
    },
    async stderr() {
      return {
        async next() {
          if (stderrIndex < stderrChunks.length) {
            const chunk = stderrChunks[stderrIndex];
            stderrIndex += 1;
            return chunk;
          }
          if (!killed) {
            await killPromise;
          }
          return null;
        },
      };
    },
    async wait() {
      if (!killed) {
        await killPromise;
      }
      return { exitCode: killed ? 137 : 0, errorMessage: killed ? 'killed' : undefined };
    },
    async kill() {
      execution.killCalls += 1;
      if (!killed) {
        killed = true;
        resolveKill();
      }
    },
    async resizeTty() {},
  };
  return execution;
}

function makeAdapter(t, options = {}) {
  const base = tempDirectory(t, options.label || 'adapter');
  const homeDir = path.join(base, 'home');
  const stagingDir = options.staging ? path.join(base, 'staging') : undefined;
  const runtime = options.runtime || new FakeJsBoxlite();
  const adapter = createBoxliteAdapter({
    homeDir,
    image: IMAGE,
    limits: LIMITS,
    sdk: { JsBoxlite: FakeJsBoxlite, version: '0.14.1' },
    runtime,
    stagingDir,
    networkBoundary: options.networkBoundary,
    execLimits: options.execLimits,
  });
  return { adapter, runtime, homeDir, stagingDir, base };
}

test('registry requires an explicit engine and refuses test adapters in production', async () => {
  const production = createEngineRegistry();
  assert.throws(
    () =>
      production.install({
        id: 'fake',
        testOnly: true,
        factory: async () => ({
          probe: async () => ({ available: true, version: '1', capabilities: [] }),
        }),
      }),
    assertCode('test_adapter_forbidden')
  );
  await assert.rejects(
    production.select({ engineId: 'missing' }),
    assertCode('unknown_engine')
  );
  await assert.rejects(production.select({}), assertCode('invalid_input'));
  assert.equal(production.has('missing'), false);
});

test('registry probes availability, version and capabilities without fallback', async () => {
  const registry = createEngineRegistry({ allowTestAdapters: true });
  registry.install({
    id: 'limited',
    testOnly: true,
    factory: async () => ({
      probe: async () => ({
        available: true,
        version: '0.14.1',
        capabilities: ['exec'],
      }),
    }),
  });
  registry.install({
    id: 'broken',
    testOnly: true,
    factory: async () => ({
      probe: async () => ({
        available: false,
        version: null,
        capabilities: [],
        reason: 'missing-module',
      }),
    }),
  });

  const probe = await registry.probe('limited');
  assert.equal(probe.engineId, 'limited');
  assert.equal(probe.available, true);
  assert.equal(probe.version, '0.14.1');
  assert.deepEqual(probe.capabilities, ['exec']);

  const selected = await registry.select({
    engineId: 'limited',
    capabilities: ['exec'],
  });
  assert.equal(selected.engineId, 'limited');
  assert.equal(selected.version, '0.14.1');

  await assert.rejects(
    registry.select({ engineId: 'limited', capabilities: ['pty'] }),
    assertCode('unsupported_capability')
  );
  await assert.rejects(
    registry.select({ engineId: 'broken' }),
    assertCode('unavailable_engine')
  );
});

test('two independent owned allocations stay distinct through lifecycle', async (t) => {
  const { adapter, runtime } = makeAdapter(t, { label: 'two' });

  const first = await adapter.createBox({
    allocationId: UUID_A,
    launchGeneration: 1,
  });
  const second = await adapter.createBox({
    allocationId: UUID_B,
    launchGeneration: 1,
  });

  assert.equal(first.name, `alpi-${UUID_A}-g1`);
  assert.equal(second.name, `alpi-${UUID_B}-g1`);
  assert.equal(first.created, true);
  assert.equal(second.created, true);
  assert.notEqual(first.nativeId, second.nativeId);
  assert.equal(runtime.boxes.size, 2);

  const owned = await adapter.listOwned();
  assert.equal(owned.length, 2);
  assert.deepEqual(
    owned.map((box) => box.nativeId).sort(),
    [first.nativeId, second.nativeId].sort()
  );

  const started = await adapter.start(first);
  assert.equal(started.running, true);
  const stopped = await adapter.stop(first);
  assert.equal(stopped.running, false);

  const destroyed = await adapter.destroy(second);
  assert.equal(destroyed.destroyed, true);
  assert.equal((await adapter.listOwned()).length, 1);
  assert.equal(runtime.boxes.size, 1);
});

test('wrong native id, name and stale generation are refused before mutation', async (t) => {
  const { adapter, runtime } = makeAdapter(t, { label: 'identity' });
  const ref = await adapter.createBox({
    allocationId: UUID_A,
    launchGeneration: 1,
  });
  const box = runtime.boxes.get(ref.nativeId);
  const stopCalls = box.stopCalls;

  await assert.rejects(
    adapter.stop({ ...ref, nativeId: 'native-foreign' }),
    assertCode('engine_identity_mismatch')
  );
  await assert.rejects(
    adapter.stop({ ...ref, name: `alpi-${UUID_A}-g9` }),
    assertCode('engine_identity_mismatch')
  );
  await assert.rejects(
    adapter.stop({
      ...ref,
      launchGeneration: 2,
      name: `alpi-${UUID_A}-g2`,
    }),
    assertCode('engine_generation_mismatch')
  );
  assert.equal(box.stopCalls, stopCalls);

  const originalName = box.name;
  box.name = `alpi-${UUID_B}-g1`;
  await assert.rejects(adapter.inspect(ref), assertCode('engine_identity_mismatch'));
  box.name = originalName;

  assert.equal((await adapter.inspect(ref)).nativeId, ref.nativeId);
});

test('allocation is idempotent, recoverable and cleanup is bounded', async (t) => {
  const base = tempDirectory(t, 'recovery');
  const homeDir = path.join(base, 'home');
  const runtime = new FakeJsBoxlite();
  const options = {
    homeDir,
    image: IMAGE,
    limits: LIMITS,
    sdk: { JsBoxlite: FakeJsBoxlite, version: '0.14.1' },
    runtime,
  };

  const firstAdapter = createBoxliteAdapter(options);
  const ref = await firstAdapter.createBox({
    allocationId: UUID_A,
    launchGeneration: 1,
  });
  const repeated = await firstAdapter.createBox({
    allocationId: UUID_A,
    launchGeneration: 1,
  });
  assert.equal(repeated.created, false);
  assert.equal(repeated.nativeId, ref.nativeId);
  assert.equal(runtime.boxes.size, 1);
  await firstAdapter.close();

  const secondAdapter = createBoxliteAdapter(options);
  const recovered = await secondAdapter.createBox({
    allocationId: UUID_A,
    launchGeneration: 1,
  });
  assert.equal(recovered.created, false);
  assert.equal(recovered.nativeId, ref.nativeId);
  assert.equal((await secondAdapter.listOwned()).length, 1);

  const destroyed = await secondAdapter.destroy(recovered);
  assert.equal(destroyed.destroyed, true);
  assert.equal(runtime.boxes.size, 0);

  const next = await secondAdapter.createBox({
    allocationId: UUID_A,
    launchGeneration: 2,
  });
  assert.equal(next.name, `alpi-${UUID_A}-g2`);
  assert.notEqual(next.nativeId, ref.nativeId);
  await assert.rejects(
    secondAdapter.createBox({ allocationId: UUID_A, launchGeneration: 3 }),
    assertCode('engine_generation_mismatch')
  );

  runtime.boxes.delete(next.nativeId);
  const alreadyGone = await secondAdapter.destroy(next);
  assert.equal(alreadyGone.alreadyGone, true);
  assert.equal((await secondAdapter.listOwned()).length, 0);
});

test('adapter constructs JsBoxlite with the private home, never default config', async (t) => {
  const base = tempDirectory(t, 'sdk');
  const homeDir = path.join(base, 'home');
  const adapter = createBoxliteAdapter({
    homeDir,
    image: IMAGE,
    limits: LIMITS,
    sdk: { JsBoxlite: FakeJsBoxlite, version: '0.14.1' },
    expectedSdkVersion: '0.14.1',
  });

  const ref = await adapter.createBox({
    allocationId: UUID_A,
    launchGeneration: 1,
  });
  const runtime = FakeJsBoxlite.lastInstance;
  assert.ok(runtime);
  assert.deepEqual(runtime.options, { homeDir });
  assert.equal(runtime.boxes.size, 1);
  assert.equal(ref.created, true);

  await adapter.close();
  assert.equal(runtime.closed, true);
});

test('untrusted SDK module paths fail probe and allocation early', async (t) => {
  const base = tempDirectory(t, 'untrusted');
  const homeDir = path.join(base, 'home');
  const modulePath = path.join(base, 'boxlite.js');
  fs.writeFileSync(modulePath, 'module.exports = {};', { mode: 0o666 });
  fs.chmodSync(modulePath, 0o666);

  const adapter = createBoxliteAdapter({
    homeDir,
    image: IMAGE,
    limits: LIMITS,
    sdkModulePath: modulePath,
  });

  const probe = await adapter.probe();
  assert.equal(probe.available, false);
  assert.equal(probe.reason, 'untrusted_module_path');
  await assert.rejects(
    adapter.createBox({ allocationId: UUID_A, launchGeneration: 1 }),
    assertCode('engine_unavailable')
  );
});

test('exec passes argv directly, caps output, times out and cancels', async (t) => {
  const { adapter, runtime } = makeAdapter(t, { label: 'exec' });
  const ref = await adapter.createBox({
    allocationId: UUID_A,
    launchGeneration: 1,
  });
  const box = runtime.boxes.get(ref.nativeId);

  runtime.execFactory = () =>
    normalExecution({ stdoutChunks: ['hello'], stderrChunks: ['warn'] });
  const normal = await adapter.exec(ref, {
    argv: ['printf', '%s', 'hello; rm -rf /'],
    timeoutMs: 1000,
    maxOutputBytes: 1024,
  });
  assert.equal(normal.exitCode, 0);
  assert.equal(normal.stdout, 'hello');
  assert.equal(normal.stderr, 'warn');
  assert.equal(normal.truncated, false);
  assert.equal(box.execCalls[0].command, 'printf');
  assert.deepEqual(box.execCalls[0].args, ['%s', 'hello; rm -rf /']);
  assert.equal(box.execCalls[0].tty, false);
  assert.equal(box.execCalls[0].timeoutSecs, 1);
  assert.equal(box.execCalls[0].env, null);
  assert.equal(box.execCalls[0].user, '1000');

  let truncationExecution;
  runtime.execFactory = () => {
    truncationExecution = blockingExecution({ stdoutChunks: ['a'.repeat(20)] });
    return truncationExecution;
  };
  const truncated = await adapter.exec(ref, {
    argv: ['echo', 'long'],
    maxOutputBytes: 5,
  });
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.stdout.length, 5);
  assert.equal(truncationExecution.killCalls, 1);

  let timeoutExecution;
  runtime.execFactory = () => {
    timeoutExecution = blockingExecution();
    return timeoutExecution;
  };
  const timed = await adapter.exec(ref, {
    argv: ['sleep', '10'],
    timeoutMs: 25,
    maxOutputBytes: 1024,
  });
  assert.equal(timed.timedOut, true);
  assert.equal(timeoutExecution.killCalls, 1);

  let cancelExecution;
  runtime.execFactory = () => {
    cancelExecution = blockingExecution();
    return cancelExecution;
  };
  const controller = new AbortController();
  const pending = adapter.exec(ref, {
    argv: ['sleep', '10'],
    timeoutMs: 1000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 10);
  const cancelled = await pending;
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelExecution.killCalls, 1);

  await assert.rejects(
    adapter.exec(ref, { argv: 'echo hello' }),
    assertCode('invalid_input')
  );
  await assert.rejects(
    adapter.exec(ref, { argv: ['echo'], timeoutMs: 300_001 }),
    assertCode('invalid_input')
  );
  await assert.rejects(
    adapter.exec(ref, { argv: ['echo'], maxOutputBytes: 0 }),
    assertCode('invalid_input')
  );

  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    adapter.exec(ref, { argv: ['echo'], signal: aborted.signal }),
    assertCode('engine_cancelled')
  );
});

test('PTY capability is explicit and network profiles fail closed', async (t) => {
  const { adapter, runtime } = makeAdapter(t, { label: 'caps' });
  const ref = await adapter.createBox({
    allocationId: UUID_A,
    launchGeneration: 1,
  });
  const box = runtime.boxes.get(ref.nativeId);

  runtime.execFactory = () => normalExecution({ stdoutChunks: ['tty-ok'] });
  const pty = await adapter.exec(ref, { argv: ['echo', 'tty'], tty: true });
  assert.equal(pty.exitCode, 0);
  assert.equal(box.execCalls.at(-1).tty, true);

  await assert.rejects(
    adapter.createBox({
      allocationId: UUID_B,
      launchGeneration: 1,
      profile: { network: 'enabled' },
    }),
    assertCode('network_unavailable')
  );
  await assert.rejects(
    adapter.createBox({
      allocationId: UUID_B,
      launchGeneration: 1,
      profile: { network: 'boundary' },
    }),
    assertCode('network_unavailable')
  );

  const registry = createEngineRegistry({ allowTestAdapters: true });
  registry.install({
    id: 'boxlite',
    testOnly: true,
    factory: async () => adapter,
  });
  const selected = await registry.select({
    engineId: 'boxlite',
    capabilities: ['exec', 'pty'],
  });
  assert.equal(selected.engineId, 'boxlite');
  await assert.rejects(
    registry.select({
      engineId: 'boxlite',
      capabilities: ['network-boundary'],
    }),
    assertCode('unsupported_capability')
  );
});

test('network boundary provider is launch-scoped and restricted', async (t) => {
  const calls = [];
  const provider = {
    async prepare(launch) {
      calls.push({ method: 'prepare', launch });
      return {
        network: {
          outbound: { mode: 'enabled', allowNet: ['api.example.com'] },
          inbound: { mode: 'disabled' },
        },
      };
    },
    async verify(launch) {
      calls.push({ method: 'verify', launch });
      return true;
    },
  };
  const { adapter, runtime } = makeAdapter(t, {
    label: 'boundary',
    networkBoundary: provider,
  });

  const ref = await adapter.createBox({
    allocationId: UUID_A,
    launchGeneration: 1,
    profile: { network: 'boundary' },
  });
  assert.equal(ref.created, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'prepare');
  assert.equal(calls[1].method, 'verify');
  assert.equal(calls[0].launch.allocationId, UUID_A);
  assert.equal(calls[0].launch.launchGeneration, 1);
  assert.equal(calls[1].launch.nativeId, ref.nativeId);
  assert.deepEqual(runtime.calls[0].options.network, {
    outbound: { mode: 'enabled', allowNet: ['api.example.com'] },
    inbound: { mode: 'disabled' },
  });

  const unrestricted = {
    async prepare() {
      return {
        network: {
          outbound: { mode: 'enabled', allowNet: [] },
          inbound: { mode: 'disabled' },
        },
      };
    },
    async verify() {
      return true;
    },
  };
  const { adapter: unsafeAdapter } = makeAdapter(t, {
    label: 'boundary-unsafe',
    networkBoundary: unrestricted,
  });
  await assert.rejects(
    unsafeAdapter.createBox({
      allocationId: UUID_B,
      launchGeneration: 1,
      profile: { network: 'boundary' },
    }),
    assertCode('network_boundary_invalid')
  );
});

test('exports remain staged and unqualified archive imports are unavailable', async (t) => {
  const { adapter, runtime, stagingDir } = makeAdapter(t, {
    label: 'staging',
    staging: true,
  });
  const ref = await adapter.createBox({
    allocationId: UUID_A,
    launchGeneration: 1,
  });

  const destination = path.join(stagingDir, 'box.tar');
  const exported = await adapter.exportBox(ref, { destinationPath: destination });
  assert.equal(exported.path, destination);
  assert.equal(fs.statSync(destination).isFile(), true);

  await assert.rejects(
    adapter.exportBox(ref, {
      destinationPath: path.join(stagingDir, '..', 'outside.tar'),
    }),
    assertCode('staging_path_forbidden')
  );
  await assert.rejects(
    adapter.exportBox(ref, { destinationPath: destination }),
    assertCode('staging_path_conflict')
  );

  const archive = path.join(stagingDir, 'import.tar');
  fs.writeFileSync(archive, 'archive', { mode: 0o600 });
  const capabilities = (await adapter.probe()).capabilities;
  assert.equal(capabilities.includes('import'), false);
  assert.ok(capabilities.includes('export'));
  await assert.rejects(adapter.importBox({
    archivePath: archive, allocationId: UUID_B, launchGeneration: 1,
  }), assertCode('engine_import_unsupported'));
  assert.equal(runtime.boxes.size, 1);

});

test('an importable SDK on a host without a usable runtime has no capabilities', async t => {
  class UnavailableRuntime {
    constructor() { throw new Error('host-specific diagnostic'); }
  }
  const options = {
    homeDir: path.join(tempDirectory(t, 'no-kvm'), 'home'), image: IMAGE, limits: LIMITS,
    sdk: { JsBoxlite: UnavailableRuntime, version: '0.14.1' },
  };
  const adapter = createBoxliteAdapter(options);
  assert.deepEqual(await adapter.probe(), {
    available: false, version: '0.14.1', capabilities: [], reason: 'runtime_unavailable',
  });
  assert.throws(() => createBoxliteAdapter({ ...options, guestUid: 0 }), assertCode('invalid_engine_config'));
  await adapter.close();
});

test('a stopped sandbox requires a verified boundary before explicit or implicit start', async t => {
  let permit = true;
  const networkBoundary = {
    async prepare() {
      return { network: { outbound: { mode: 'enabled', allowNet: ['api.example.com'] },
        inbound: { mode: 'disabled' } } };
    },
    async verify() { return permit; },
  };
  const { adapter, runtime } = makeAdapter(t, { label: 'activation', networkBoundary });
  t.after(() => adapter.close());
  const ref = await adapter.createBox({ allocationId: UUID_A, profile: { network: 'boundary' } });
  const box = runtime.boxes.get(ref.nativeId);
  permit = false;
  await assert.rejects(adapter.start(ref), assertCode('engine_network_unverified'));
  await assert.rejects(adapter.exec(ref, { argv: ['true'] }), assertCode('engine_network_unverified'));
  assert.equal(box.startCalls, 0);
  assert.equal(box.execCalls.length, 0);
});

test('a name collision without an allocation receipt leaves the existing box untouched', async t => {
  const { adapter, runtime } = makeAdapter(t, { label: 'collision' });
  t.after(() => adapter.close());
  const name = `alpi-${UUID_A}-g1`;
  const { box } = await runtime.getOrCreate({ image: IMAGE, ...LIMITS }, name);
  const callsBefore = runtime.calls.length;
  await assert.rejects(adapter.createBox({ allocationId: UUID_A }), assertCode('engine_intent_conflict'));
  assert.equal(runtime.calls.length, callsBefore);
  assert.equal(runtime.boxes.get(box.id), box);
  assert.equal((await adapter.listOwned()).length, 0);
});
