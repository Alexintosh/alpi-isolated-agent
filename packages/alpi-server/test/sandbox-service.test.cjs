'use strict';

/**
 * CONTROL-SANDBOX-1 contract tests.
 *
 * The work store and sandbox journal are real SQLite databases. The engine is
 * a deterministic fake injected only through `withEngine`; the service has no
 * production engine fallback. No VM, KVM or host service is touched; the
 * worker-composition tests below use only a real loopback Unix-domain socket
 * with injected kernel, proc and systemd evidence.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { test } = require('node:test');

const { openWorkStore, WorkStoreError } = require('../src/work-store.cjs');
const {
  SandboxServiceError,
  createSandboxService,
  httpErrorFor,
} = require('../src/sandbox-service.cjs');
const {
  SandboxJournalError,
  openSandboxJournal,
} = require('../src/sandbox-journal.cjs');
const { createEngineWorker } = require('../src/network/engine-worker.cjs');
const {
  createSystemctlClient,
  createWorkerClient,
} = require('../src/network/worker-client.cjs');

const WORKSPACE = process.cwd();
const UUID_1 = '11111111-1111-4111-8111-111111111111';
const UUID_2 = '22222222-2222-4222-8222-222222222222';
const UUID_3 = '33333333-3333-4333-8333-333333333333';
const IMAGE = `sha256:${'a'.repeat(64)}`;
const IMAGE_V2 = `sha256:${'b'.repeat(64)}`;
const LIMITS = Object.freeze({
  vcpus: 2,
  memoryMiB: 2048,
  diskMiB: 10240,
});
const CAPABILITIES = Object.freeze([
  'create',
  'inspect',
  'start',
  'stop',
  'destroy',
  'list-owned',
  'exec',
  'pty',
]);

const ALPHA_RUNNER = Object.freeze({
  clientId: 'alpha-runner',
  project: 'alpha',
  role: 'runner',
});
const ALPHA_RUNNER_2 = Object.freeze({
  clientId: 'alpha-runner-2',
  project: 'alpha',
  role: 'runner',
});
const ALPHA_OPERATOR = Object.freeze({
  clientId: 'alpha-operator',
  project: 'alpha',
  role: 'operator',
});
const ALPHA_OBSERVER = Object.freeze({
  clientId: 'alpha-observer',
  project: 'alpha',
  role: 'observer',
});
const BETA_OPERATOR = Object.freeze({
  clientId: 'beta-operator',
  project: 'beta',
  role: 'operator',
});

function tempDirectory(t, label) {
  const directory = fs.mkdtempSync(
    path.join(WORKSPACE, `.sandbox-service-${label}-`)
  );
  fs.chmodSync(directory, 0o700);
  t.after(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function createClock(start = 1_000_000) {
  let current = start;
  return {
    now: () => current,
    set(value) {
      current = value;
    },
    advance(ms) {
      current += ms;
    },
  };
}

function assertServiceCode(expectedCode) {
  return (error) => {
    assert.ok(error instanceof SandboxServiceError);
    assert.equal(error.code, expectedCode);
    return true;
  };
}

function assertStoreCode(expectedCode) {
  return (error) => {
    assert.ok(error instanceof WorkStoreError);
    assert.equal(error.code, expectedCode);
    return true;
  };
}

class FakeEngineAdapter {
  constructor() {
    this.boxes = new Map();
    this.counter = 0;
    this.calls = {
      create: [],
      inspect: [],
      start: [],
      stop: [],
      destroy: [],
      listOwned: [],
      exec: [],
    };
    this.createHook = null;
    this.destroyHook = null;
    this.execHook = null;
  }

  key(allocationId, launchGeneration) {
    return `${allocationId}:${launchGeneration}`;
  }

  info(box) {
    return Object.freeze({
      allocationId: box.allocationId,
      launchGeneration: box.launchGeneration,
      name: box.name,
      nativeId: box.nativeId,
      state: box.running ? 'running' : 'stopped',
      running: box.running,
    });
  }

  boxFor(ref) {
    const key = this.key(ref.allocationId, ref.launchGeneration);
    const box = this.boxes.get(key);
    if (!box) {
      throw {
        code: 'engine_box_missing',
        message: 'RAW ENGINE TEXT: /host/private/box',
      };
    }
    if (
      box.nativeId !== ref.nativeId ||
      box.name !== ref.name
    ) {
      throw {
        code: 'engine_identity_mismatch',
        message: 'RAW ENGINE TEXT: /host/private/identity',
      };
    }
    return box;
  }

  async createBox(spec) {
    this.calls.create.push(spec);
    if (this.createHook) {
      const outcome = await this.createHook(spec);
      if (outcome) {
        return outcome;
      }
    }
    const key = this.key(spec.allocationId, spec.launchGeneration);
    const existing = this.boxes.get(key);
    if (existing) {
      return {
        allocationId: spec.allocationId,
        launchGeneration: spec.launchGeneration,
        name: existing.name,
        nativeId: existing.nativeId,
        created: false,
      };
    }
    const box = {
      allocationId: spec.allocationId,
      launchGeneration: spec.launchGeneration,
      name: `alpi-${spec.allocationId}-g${spec.launchGeneration}`,
      nativeId: `native-${++this.counter}`,
      running: false,
    };
    this.boxes.set(key, box);
    return {
      allocationId: box.allocationId,
      launchGeneration: box.launchGeneration,
      name: box.name,
      nativeId: box.nativeId,
      created: true,
    };
  }

  async inspect(ref) {
    this.calls.inspect.push(ref);
    return this.info(this.boxFor(ref));
  }

  async start(ref) {
    this.calls.start.push(ref);
    const box = this.boxFor(ref);
    box.running = true;
    return this.info(box);
  }

  async stop(ref) {
    this.calls.stop.push(ref);
    const box = this.boxFor(ref);
    box.running = false;
    return this.info(box);
  }

  async destroy(ref) {
    this.calls.destroy.push(ref);
    if (this.destroyHook) {
      const outcome = await this.destroyHook(ref);
      if (outcome) {
        return outcome;
      }
    }
    const key = this.key(ref.allocationId, ref.launchGeneration);
    const box = this.boxes.get(key);
    if (!box) {
      return {
        destroyed: true,
        alreadyGone: true,
        allocationId: ref.allocationId,
        launchGeneration: ref.launchGeneration,
        name: ref.name,
        nativeId: ref.nativeId,
      };
    }
    if (box.nativeId !== ref.nativeId || box.name !== ref.name) {
      throw {
        code: 'engine_identity_mismatch',
        message: 'RAW ENGINE TEXT: /host/private/destroy',
      };
    }
    this.boxes.delete(key);
    return {
      destroyed: true,
      alreadyGone: false,
      allocationId: box.allocationId,
      launchGeneration: box.launchGeneration,
      name: box.name,
      nativeId: box.nativeId,
    };
  }

  async listOwned() {
    this.calls.listOwned.push(true);
    return [...this.boxes.values()]
      .map((box) => this.info(box))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async exec(ref, spec) {
    this.calls.exec.push({ ref, spec });
    this.boxFor(ref);
    if (this.execHook) {
      return this.execHook(ref, spec);
    }
    return {
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      truncated: false,
      timedOut: false,
      cancelled: false,
      executionId: 'exec-1',
    };
  }

  async probe() {
    return Object.freeze({
      available: true,
      version: '0.14.1',
      capabilities: Object.freeze([...CAPABILITIES]),
    });
  }

  async close() {}
}

function makeResolver(overrides = {}) {
  return async ({ engine, profile }) => ({
    engine,
    profile,
    qualified: true,
    available: true,
    engineVersion: '0.14.1',
    imageDigest: IMAGE,
    limits: { ...LIMITS },
    networkMode: 'disabled',
    capabilities: [...CAPABILITIES],
    ...overrides,
  });
}

function setup(t, options = {}) {
  const directory = tempDirectory(t, options.label || 'main');
  const clock = createClock(options.start || 1_000_000);
  const store = openWorkStore(directory, {
    now: clock.now,
    ...(options.storeOptions || {}),
  });
  const engine = new FakeEngineAdapter();
  const withEngineCalls = [];
  const withEngine = async (record, fn) => {
    withEngineCalls.push(record);
    return fn(engine);
  };
  const resolveProfile = options.resolveProfile || makeResolver();
  const service = createSandboxService({
    store,
    stateDir: directory,
    resolveProfile,
    withEngine,
    clock: clock.now,
    ...(options.serviceOptions || {}),
  });
  t.after(() => {
    service.close();
    store.close();
  });
  return {
    directory,
    clock,
    store,
    engine,
    service,
    withEngineCalls,
    resolveProfile,
  };
}

function baseCreate(overrides = {}) {
  return {
    requestId: 'request-1',
    engine: 'boxlite',
    profile: 'pi-dev',
    retention: 'ephemeral',
    ...overrides,
  };
}

function createSandbox(service, principal = ALPHA_RUNNER, overrides = {}) {
  return service.createSandbox(principal, baseCreate(overrides));
}

function startSandbox(service, principal = ALPHA_RUNNER, sandboxId, extra = {}) {
  return service.startSandbox(principal, { sandboxId, ...extra });
}

function stopSandbox(service, principal = ALPHA_RUNNER, sandboxId, extra = {}) {
  return service.stopSandbox(principal, { sandboxId, ...extra });
}

function acquireLease(store, principal, workspaceId, ttlSeconds = 60) {
  return store.acquireLease(principal, { workspaceId, ttlSeconds });
}

function readJournal(directory, clock) {
  return openSandboxJournal(directory, { now: clock.now });
}

// ---------------------------------------------------------------------------
// FI-2 composition fixture: the real in-process engine worker behind a real
// Unix-domain socket, reached through the real worker client. Kernel, proc
// and systemd evidence is injected; no VM, KVM or host service is touched.
// ---------------------------------------------------------------------------

const UUID_4 = '44444444-4444-4444-8444-444444444444';
const WORKER_IMAGE = `ghcr.io/alpi/pi-dev@sha256:${'a'.repeat(64)}`;
const WORKER_IMAGE_DIGEST = `sha256:${'a'.repeat(64)}`;
const WORKER_TOKEN = 'd'.repeat(64);
const WORKER_PROFILE = Object.freeze({
  network: 'boundary',
  cpus: 2,
  memoryMib: 2048,
  diskSizeGb: 10,
});

function currentUid() {
  return typeof process.geteuid === 'function'
    ? process.geteuid()
    : process.getuid();
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// The worker control socket must fit the UDS path bound, so the composition
// fixture roots its state in a short temporary directory instead of the
// repository-relative directories used by the pure service tests.
function workerTempDirectory(t) {
  const directory = fs.mkdtempSync(path.join('/tmp', 'sandbox-worker-comp-'));
  fs.chmodSync(directory, 0o700);
  t.after(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function makeWorkerNetEvidence() {
  const netDevHeader =
    'Inter-|   Receive                                                |  Transmit\n' +
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n';
  const loopbackDev = '  lo: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n';
  const loopbackRoute4 =
    'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n' +
    'lo\t0000007F\t00000000\t0001\t0\t0\t0\t000000FF\t0\t0\t0\n';
  const loopbackRoute6 =
    '00000000000000000000000000000001 80 00000000000000000000000000000000 00 ' +
    '00000000000000000000000000000000 00000400 00000000 0000000000000001 lo\n';
  return {
    async readlink(target) {
      if (target.endsWith('/ns/net')) return 'net:[4026532001]';
      throw new Error(`unexpected readlink ${target}`);
    },
    async readFile(target) {
      if (target.endsWith('/net/dev')) return netDevHeader + loopbackDev;
      if (target.endsWith('/net/route')) return loopbackRoute4;
      if (target.endsWith('/net/ipv6_route')) return loopbackRoute6;
      throw new Error(`unexpected readFile ${target}`);
    },
  };
}

function makeWorkerProcEvidence() {
  const workerPid = process.pid;
  const shimPid = workerPid + 1;
  const cgroup = `/system.slice/alpi-worker@${UUID_4}.service`;
  const uid = currentUid();
  const shimExe = '/usr/libexec/boxlite-shim';
  const startTime = 9001;
  const procStat = (() => {
    const fields = new Array(20).fill('0');
    fields[0] = 'S';
    fields[19] = String(startTime);
    return `${shimPid} (boxlite-shim) ${fields.join(' ')}`;
  })();
  return {
    async readlink(target) {
      if (target === `/proc/${shimPid}/exe`) return shimExe;
      if (
        target === `/proc/${shimPid}/ns/net` ||
        target === `/proc/${workerPid}/ns/net`
      ) {
        return 'net:[4026532001]';
      }
      if (target === '/proc/self/ns/net') return 'net:[4026531999]';
      throw new Error(`unexpected readlink ${target}`);
    },
    async readFile(target) {
      if (target === `/sys/fs/cgroup${cgroup}/cgroup.events`) {
        return 'populated 0\n';
      }
      if (target === `/proc/${shimPid}/stat`) return procStat;
      if (
        target === `/proc/${shimPid}/status` ||
        target === `/proc/${workerPid}/status`
      ) {
        return `Name:\tboxlite-shim\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`;
      }
      if (
        target === `/proc/${shimPid}/cgroup` ||
        target === `/proc/${workerPid}/cgroup`
      ) {
        return `0::${cgroup}\n`;
      }
      if (target === '/proc/self/cgroup') return `0::${cgroup}\n`;
      throw new Error(`unexpected readFile ${target}`);
    },
  };
}

// Worker-side engine adapter. start/stop return the normalized running-state
// shape the sandbox service consumes; exec records the exact spec the worker
// normalized so the test can assert the omitted optional field stays absent.
function makeWorkerAdapter() {
  let running = false;
  let destroyed = false;
  const workerName = `alpi-${UUID_4}-g1`;
  const nativeInfo = () => ({
    id: 'native-1',
    name: workerName,
    state: {
      status: running ? 'running' : 'stopped',
      running,
      pid: process.pid + 1,
    },
    image: WORKER_IMAGE,
    cpus: 2,
    memoryMib: 2048,
  });
  const serviceInfo = (ref) => ({
    allocationId: ref.allocationId,
    launchGeneration: ref.launchGeneration,
    name: ref.name,
    nativeId: ref.nativeId,
    state: running ? 'running' : 'stopped',
    running,
  });
  const adapter = {
    id: 'boxlite',
    execCalls: [],
    async createBox(spec) {
      return {
        allocationId: spec.allocationId,
        launchGeneration: spec.launchGeneration,
        name: workerName,
        nativeId: 'native-1',
        created: true,
      };
    },
    async inspect(ref) {
      return serviceInfo(ref);
    },
    async start(ref) {
      running = true;
      return serviceInfo(ref);
    },
    async stop(ref) {
      running = false;
      return serviceInfo(ref);
    },
    async destroy() {
      destroyed = true;
      running = false;
      return { destroyed: true, alreadyGone: false };
    },
    async listOwned() {
      if (destroyed) return [];
      return [
        {
          allocationId: UUID_4,
          launchGeneration: 1,
          name: workerName,
          nativeId: 'native-1',
          state: running ? 'running' : 'stopped',
          running,
        },
      ];
    },
    async exec(ref, spec) {
      adapter.execCalls.push({ argv: spec.argv, workingDir: spec.workingDir });
      return {
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        truncated: false,
        timedOut: false,
        cancelled: false,
      };
    },
    async probe() {
      return {
        available: true,
        version: '0.14.1',
        capabilities: [...CAPABILITIES],
      };
    },
    async close() {},
    getInfo: () => nativeInfo(),
  };
  return adapter;
}

function makeWorkerConfig(root, overrides = {}) {
  const allocationRoot = path.join(root, 'workers', UUID_4);
  const homeDir = path.join(allocationRoot, 'home');
  fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(homeDir, 0o700);
  const ironIngressRoot = path.join(root, 'iron');
  fs.mkdirSync(ironIngressRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(ironIngressRoot, 0o700);
  return {
    version: 1,
    protocolVersion: 1,
    stateRoot: root,
    allocationId: UUID_4,
    launchGeneration: 1,
    image: WORKER_IMAGE,
    imageDigest: WORKER_IMAGE_DIGEST,
    sdkModulePath: path.join(root, 'sdk.cjs'),
    profile: WORKER_PROFILE,
    homeDir,
    controlSocketPath: path.join(allocationRoot, 'control.sock'),
    token: WORKER_TOKEN,
    tunnelPort: overrides.tunnelPort,
    ironIngressRoot,
    createdAt: new Date().toISOString(),
    serviceUnit: `alpi-worker@${UUID_4}.service`,
  };
}

function makeWorkerSystemctl() {
  const state = { active: false, startCalls: 0, stopCalls: 0 };
  const client = createSystemctlClient({
    launcher: async (argv) => {
      if (argv[0] === 'start') {
        state.startCalls += 1;
        state.active = true;
        return { code: 0, stdout: '', stderr: '' };
      }
      if (argv[0] === 'stop') {
        state.stopCalls += 1;
        state.active = false;
        return { code: 0, stdout: '', stderr: '' };
      }
      if (argv[0] === 'show') {
        return {
          code: 0,
          stdout:
            'LoadState=loaded\n' +
            `ActiveState=${state.active ? 'active' : 'inactive'}\n` +
            `SubState=${state.active ? 'running' : 'dead'}\n` +
            `MainPID=${state.active ? process.pid : 0}\n` +
            `ControlGroup=/system.slice/alpi-worker@${UUID_4}.service\n`,
          stderr: '',
        };
      }
      throw new Error(`unexpected systemctl argv ${argv.join(' ')}`);
    },
  });
  return { client, state };
}

async function startCompositionWorker(t, options) {
  const root = workerTempDirectory(t);
  fs.writeFileSync(
    path.join(root, 'sdk.cjs'),
    'module.exports = {};\n',
    { mode: 0o600 }
  );
  const tunnelPort = await freePort();
  const config = makeWorkerConfig(root, { tunnelPort });
  const configPath = path.join(root, 'workers', UUID_4, 'worker.json');
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.chmodSync(configPath, 0o600);
  const worker = createEngineWorker({
    config,
    adapter: options.adapter,
    getInfo: options.adapter.getInfo,
    proc: options.proc,
    net: options.net,
    uid: currentUid(),
    proofMaxAgeMs: 5000,
    ownerHeartbeatTimeoutMs: 5000,
    watchdogMs: 100,
  });
  await worker.start();
  t.after(async () => {
    await worker.close().catch(() => {});
  });
  return { config };
}

async function connectCompositionClient(t, workerSetup, proc, workerNet) {
  const { client: systemctl, state } = makeWorkerSystemctl();
  const client = createWorkerClient({
    allocationId: workerSetup.config.allocationId,
    launchGeneration: workerSetup.config.launchGeneration,
    controlSocketPath: workerSetup.config.controlSocketPath,
    token: workerSetup.config.token,
    serviceUid: currentUid(),
    tunnelPort: workerSetup.config.tunnelPort,
    systemctl,
    proc,
    net: workerNet,
    heartbeatIntervalMs: 500,
    proofMaxAgeMs: 5000,
    startTimeoutMs: 3000,
    stopTimeoutMs: 3000,
    connectRetryMs: 50,
  });
  t.after(async () => {
    try {
      client.close();
    } catch {
      // Already closed.
    }
    try {
      await client.stop();
    } catch {
      // Unit already stopped.
    }
  });
  return { client, systemctlState: state };
}

test('an exec that omits workingDir reaches the real worker without a null directory and never fences', async (t) => {
  const proc = makeWorkerProcEvidence();
  const workerNet = makeWorkerNetEvidence();
  const adapter = makeWorkerAdapter();
  const workerSetup = await startCompositionWorker(t, {
    adapter,
    proc,
    net: workerNet,
  });
  const { client } = await connectCompositionClient(t, workerSetup, proc, workerNet);
  await client.start();

  const f = setup(t, {
    label: 'worker-exec-composition',
    resolveProfile: makeResolver({
      networkMode: 'boundary',
      networkBoundaryVerified: true,
    }),
    serviceOptions: { withEngine: (_record, use) => use(client.engine) },
  });

  // Bind the reserved sandbox id to the worker's fixed owned allocation.
  const randomUUID = crypto.randomUUID;
  let pinned = true;
  crypto.randomUUID = () => {
    if (pinned) {
      pinned = false;
      return UUID_4;
    }
    return randomUUID();
  };
  let created;
  try {
    created = await createSandbox(f.service);
  } finally {
    crypto.randomUUID = randomUUID;
  }
  assert.equal(created.sandbox.sandboxId, UUID_4);
  await startSandbox(f.service, ALPHA_RUNNER, UUID_4);
  const lease = acquireLease(f.store, ALPHA_RUNNER, created.sandbox.workspaceId);
  const input = {
    sandboxId: UUID_4,
    workspaceId: created.sandbox.workspaceId,
    leaseEpoch: lease.epoch,
    argv: ['true'],
  };

  // An omitted workingDir must reach the worker as absent, succeed with zero
  // writer fences, and never leave an uncertain intent behind.
  const omitted = await f.service.execInSandbox(ALPHA_RUNNER, input);
  assert.equal(omitted.exitCode, 0);
  assert.equal(adapter.execCalls.length, 1);
  assert.equal(adapter.execCalls[0].workingDir, undefined);
  assert.equal(f.store.listWriterFences().length, 0);
  assert.equal(f.store.listPendingExecIntents().length, 0);

  // An explicit directory keeps working end to end through the same seam.
  const explicit = await f.service.execInSandbox(ALPHA_RUNNER, {
    ...input,
    workingDir: '/workspace',
  });
  assert.equal(explicit.exitCode, 0);
  assert.equal(adapter.execCalls[1].workingDir, '/workspace');
  assert.equal(f.store.listWriterFences().length, 0);

  // The public API normalizes an explicit null to absent: the engine request
  // must omit the field, not send null.
  const nullDir = await f.service.execInSandbox(ALPHA_RUNNER, {
    ...input,
    workingDir: null,
  });
  assert.equal(nullDir.exitCode, 0);
  assert.equal(adapter.execCalls[2].workingDir, undefined);
  assert.equal(f.store.listWriterFences().length, 0);
  assert.equal(f.store.listPendingExecIntents().length, 0);
});

test('service argv admission matches the worker contract before any intent is persisted', async (t) => {
  const proc = makeWorkerProcEvidence();
  const workerNet = makeWorkerNetEvidence();
  const adapter = makeWorkerAdapter();
  const workerSetup = await startCompositionWorker(t, {
    adapter,
    proc,
    net: workerNet,
  });
  const { client } = await connectCompositionClient(t, workerSetup, proc, workerNet);
  await client.start();

  const f = setup(t, {
    label: 'worker-argv-composition',
    resolveProfile: makeResolver({
      networkMode: 'boundary',
      networkBoundaryVerified: true,
    }),
    serviceOptions: { withEngine: (_record, use) => use(client.engine) },
  });

  // Bind the reserved sandbox id to the worker's fixed owned allocation.
  const randomUUID = crypto.randomUUID;
  let pinned = true;
  crypto.randomUUID = () => {
    if (pinned) {
      pinned = false;
      return UUID_4;
    }
    return randomUUID();
  };
  let created;
  try {
    created = await createSandbox(f.service);
  } finally {
    crypto.randomUUID = randomUUID;
  }
  assert.equal(created.sandbox.sandboxId, UUID_4);
  await startSandbox(f.service, ALPHA_RUNNER, UUID_4);
  const lease = acquireLease(f.store, ALPHA_RUNNER, created.sandbox.workspaceId);
  const input = {
    sandboxId: UUID_4,
    workspaceId: created.sandbox.workspaceId,
    leaseEpoch: lease.epoch,
  };

  const assertCleanSeam = () => {
    assert.equal(f.store.listWriterFences().length, 0);
    assert.equal(f.store.listPendingExecIntents().length, 0);
  };

  // The real worker admits at most 64 argv entries: 64 must succeed end to
  // end through the service, client and worker seam.
  const fullArgv = Array.from({ length: 64 }, (_, index) => `arg-${index}`);
  const full = await f.service.execInSandbox(ALPHA_RUNNER, {
    ...input,
    argv: fullArgv,
  });
  assert.equal(full.exitCode, 0);
  assert.equal(adapter.execCalls.length, 1);
  assert.deepEqual(adapter.execCalls[0].argv, fullArgv);
  assertCleanSeam();

  // A 65th entry is invalid input at the service seam: it must be refused
  // before any exec intent is persisted, with no dispatch and no fence.
  await assert.rejects(
    f.service.execInSandbox(ALPHA_RUNNER, {
      ...input,
      argv: [...fullArgv, 'one-entry-too-many'],
    }),
    assertServiceCode('invalid_input')
  );
  assert.equal(adapter.execCalls.length, 1);
  assertCleanSeam();

  // A multibyte argument at exactly the worker's 4096 UTF-8-byte boundary is
  // inside the shared contract and still reaches the adapter, proving the
  // rejection above was pre-intent rather than a lingering fence.
  const boundary = await f.service.execInSandbox(ALPHA_RUNNER, {
    ...input,
    argv: ['é'.repeat(2048)],
  });
  assert.equal(boundary.exitCode, 0);
  assert.equal(adapter.execCalls.length, 2);
  assert.equal(
    Buffer.byteLength(adapter.execCalls[1].argv[0], 'utf8'),
    4096
  );
  assertCleanSeam();

  // One code point beyond the boundary is 4098 UTF-8 bytes. A JavaScript
  // string-length check (2049 characters) would admit it, but the worker
  // rejects it pre-adapter, so the service must refuse it before the intent.
  await assert.rejects(
    f.service.execInSandbox(ALPHA_RUNNER, {
      ...input,
      argv: ['é'.repeat(2049)],
    }),
    assertServiceCode('invalid_input')
  );
  assert.equal(adapter.execCalls.length, 2);
  assertCleanSeam();

  // The workspace stays usable after both pre-intent rejections.
  const after = await f.service.execInSandbox(ALPHA_RUNNER, {
    ...input,
    argv: ['true'],
  });
  assert.equal(after.exitCode, 0);
  assert.equal(adapter.execCalls.length, 3);
  assertCleanSeam();
});

test('create allocates metadata without starting a VM and is idempotent', async (t) => {
  const { service, engine, store } = setup(t, { label: 'create' });

  const first = await createSandbox(service);
  assert.equal(first.metadataCreated, true);
  assert.equal(first.created, true);
  assert.equal(first.replayed, false);
  assert.equal(first.vmStarted, false);
  assert.equal(first.sandbox.project, 'alpha');
  assert.equal(first.sandbox.desiredState, 'running');
  assert.equal(first.sandbox.observedState, 'stopped');
  assert.equal(first.sandbox.running, false);
  assert.match(first.sandbox.sandboxId, /^[0-9a-f-]{36}$/);
  assert.equal(first.sandbox.allocationId, first.sandbox.sandboxId);
  assert.equal(first.sandbox.launchGeneration, 1);
  assert.match(first.sandbox.nativeId, /^native-/);
  assert.equal(engine.calls.create.length, 1);
  assert.equal(engine.calls.start.length, 0);
  assert.equal(engine.boxes.size, 1);

  const retry = await createSandbox(service);
  assert.equal(retry.replayed, true);
  assert.equal(retry.created, false);
  assert.equal(retry.metadataCreated, false);
  assert.equal(retry.sandbox.sandboxId, first.sandbox.sandboxId);
  assert.equal(retry.sandbox.nativeId, first.sandbox.nativeId);
  assert.equal(retry.sandbox.generation, first.sandbox.generation);
  assert.equal(engine.calls.create.length, 1);

  const got = await service.getSandbox(ALPHA_RUNNER, first.sandbox.sandboxId);
  assert.deepEqual(got.sandbox, retry.sandbox);
  const listed = await service.listSandboxes(ALPHA_RUNNER);
  assert.equal(listed.count, 1);
  assert.equal(listed.sandboxes[0].sandboxId, first.sandbox.sandboxId);
  assert.equal(store.listSandboxes(ALPHA_RUNNER).length, 1);
});

test('concurrent create retries share one allocation', async (t) => {
  const { service, engine } = setup(t, { label: 'concurrent-create' });

  const results = await Promise.all(
    Array.from({ length: 6 }, () => createSandbox(service))
  );
  const first = results[0];
  for (const result of results) {
    assert.equal(result.sandbox.sandboxId, first.sandbox.sandboxId);
    assert.equal(result.sandbox.nativeId, first.sandbox.nativeId);
  }
  assert.equal(engine.calls.create.length, 1);
  assert.equal(engine.boxes.size, 1);
  const listed = await service.listSandboxes(ALPHA_RUNNER);
  assert.equal(listed.count, 1);
});

test('create rejects unavailable or unqualified engines before reservation', async (t) => {
  const variants = [
    {
      label: 'unavailable',
      resolver: makeResolver({ available: false }),
      code: 'profile_unavailable',
    },
    {
      label: 'unqualified',
      resolver: makeResolver({ qualified: false }),
      code: 'profile_unavailable',
    },
    {
      label: 'egress',
      resolver: makeResolver({ networkMode: 'enabled' }),
      code: 'network_unavailable',
    },
    {
      label: 'unverified-boundary',
      resolver: makeResolver({
        networkMode: 'boundary',
        networkBoundaryVerified: false,
      }),
      code: 'network_unavailable',
    },
    {
      label: 'missing-digest',
      resolver: makeResolver({ imageDigest: undefined }),
      code: 'profile_unavailable',
    },
    {
      label: 'missing-capability',
      resolver: makeResolver({
        capabilities: ['create', 'inspect', 'start', 'stop', 'destroy'],
      }),
      code: 'engine_unsupported',
    },
  ];

  for (const variant of variants) {
    const fixture = setup(t, {
      label: `reject-${variant.label}`,
      resolveProfile: variant.resolver,
    });
    await assert.rejects(
      createSandbox(fixture.service),
      assertServiceCode(variant.code)
    );
    assert.equal(fixture.engine.calls.create.length, 0);
    assert.equal(fixture.store.listSandboxes(ALPHA_RUNNER).length, 0);
    const journal = readJournal(fixture.directory, fixture.clock);
    assert.equal(journal.listByProject('alpha').length, 0);
    journal.close();
    const summary = await fixture.service.status(ALPHA_RUNNER);
    assert.equal(summary.counts.sandboxes, 0);
  }
});

test('retained profile pins survive an operator upgrade', async (t) => {
  let version = '0.14.1';
  let digest = IMAGE;
  let limits = { ...LIMITS };
  const resolver = async ({ engine, profile }) => ({
    engine,
    profile,
    qualified: true,
    available: true,
    engineVersion: version,
    imageDigest: digest,
    limits: { ...limits },
    networkMode: 'disabled',
    capabilities: [...CAPABILITIES],
  });
  const fixture = setup(t, {
    label: 'pins',
    resolveProfile: resolver,
  });

  const first = await createSandbox(fixture.service);
  assert.equal(first.sandbox.engineVersion, '0.14.1');
  assert.equal(first.sandbox.imageDigest, IMAGE);
  assert.deepEqual(first.sandbox.resources, LIMITS);

  version = '0.15.0';
  digest = IMAGE_V2;
  limits = { vcpus: 4, memoryMiB: 4096, diskMiB: 20480 };

  const retry = await createSandbox(fixture.service);
  assert.equal(retry.replayed, true);
  assert.equal(retry.sandbox.engineVersion, '0.14.1');
  assert.equal(retry.sandbox.imageDigest, IMAGE);
  assert.deepEqual(retry.sandbox.resources, LIMITS);
  assert.equal(fixture.engine.calls.create.length, 1);

  const started = await startSandbox(
    fixture.service,
    ALPHA_RUNNER,
    first.sandbox.sandboxId
  );
  assert.equal(started.started, true);
  const lifecycleRecord = fixture.withEngineCalls.at(-1);
  assert.equal(lifecycleRecord.engineVersion, '0.14.1');
  assert.equal(lifecycleRecord.imageDigest, IMAGE);
  assert.deepEqual(lifecycleRecord.resources, LIMITS);
  assert.equal(lifecycleRecord.launchGeneration, 1);
});

test('stop and restart retain the same native allocation and disk', async (t) => {
  const { service, engine, store } = setup(t, { label: 'restart' });
  const created = await createSandbox(service);
  const sandboxId = created.sandbox.sandboxId;

  const started = await startSandbox(service, ALPHA_RUNNER, sandboxId);
  assert.equal(started.started, true);
  assert.equal(started.alreadyRunning, false);
  const beforeStop = (await service.getSandbox(ALPHA_RUNNER, sandboxId)).sandbox;

  const stopped = await stopSandbox(service, ALPHA_RUNNER, sandboxId);
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.sandbox.observedState, 'stopped');
  assert.equal(stopped.sandbox.desiredState, 'stopped');
  assert.ok(stopped.sandbox.generation > beforeStop.generation);
  assert.equal(stopped.sandbox.launchGeneration, 1);
  assert.equal(stopped.sandbox.nativeId, created.sandbox.nativeId);
  assert.equal(engine.calls.create.length, 1);

  const resumed = await startSandbox(service, ALPHA_RUNNER, sandboxId);
  assert.equal(resumed.started, true);
  assert.equal(resumed.sandbox.nativeId, created.sandbox.nativeId);
  assert.equal(resumed.sandbox.launchGeneration, 1);
  assert.equal(resumed.sandbox.workspaceId, created.sandbox.workspaceId);
  assert.equal(resumed.sandbox.observedState, 'running');
  assert.equal(engine.calls.create.length, 1);
  assert.equal(engine.calls.start.length, 2);
  assert.equal(engine.calls.stop.length, 1);
  assert.equal(engine.boxes.size, 1);
  assert.equal(store.listSandboxes(ALPHA_RUNNER).length, 1);
});

test('delete requires confirmed engine absence before releasing capacity', async (t) => {
  const { service, engine, store } = setup(t, { label: 'delete-proof' });
  const created = await createSandbox(service);
  const sandboxId = created.sandbox.sandboxId;
  await startSandbox(service, ALPHA_RUNNER, sandboxId);
  await stopSandbox(service, ALPHA_RUNNER, sandboxId);

  engine.destroyHook = async () => {
    throw {
      code: 'engine_destroy_unverified',
      message: 'RAW ENGINE TEXT: /host/private/destroy',
    };
  };

  let error;
  try {
    await service.deleteSandbox(ALPHA_OPERATOR, { sandboxId });
    assert.fail('delete should have failed');
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof SandboxServiceError);
  assert.equal(error.code, 'engine_uncertain');
  assert.equal(error.retryable, true);
  assert.doesNotMatch(error.message, /RAW|host|private/);
  assert.equal(store.listSandboxes(ALPHA_RUNNER).length, 1);
  const afterFailure = await service.getSandbox(ALPHA_RUNNER, sandboxId);
  assert.equal(afterFailure.sandbox.deleteState, 'uncertain');
  assert.equal(afterFailure.sandbox.deletedAt, null);
  assert.equal(afterFailure.sandbox.recoveryRequired, true);

  engine.destroyHook = null;
  const deleted = await service.deleteSandbox(ALPHA_OPERATOR, { sandboxId });
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.alreadyDeleted, false);
  assert.notEqual(deleted.sandbox.deletedAt, null);
  assert.equal(store.listSandboxes(ALPHA_RUNNER).length, 0);
  assert.equal(engine.calls.destroy.length, 2);
  assert.equal(engine.boxes.size, 0);

  const again = await service.deleteSandbox(ALPHA_OPERATOR, { sandboxId });
  assert.equal(again.deleted, true);
  assert.equal(again.alreadyDeleted, true);
  assert.equal(engine.calls.destroy.length, 2);

  const next = await createSandbox(service, ALPHA_RUNNER, {
    requestId: 'request-2',
  });
  assert.equal(next.created, true);
  assert.notEqual(next.sandbox.sandboxId, sandboxId);
});

test('retained export is not released until acknowledged or explicitly discarded', async (t) => {
  const { service, engine, store } = setup(t, { label: 'retention' });
  const retained = await createSandbox(service, ALPHA_RUNNER, {
    requestId: 'retained',
    retention: 'until-export',
  });
  await startSandbox(service, ALPHA_RUNNER, retained.sandbox.sandboxId);
  await stopSandbox(service, ALPHA_RUNNER, retained.sandbox.sandboxId);

  await assert.rejects(
    service.deleteSandbox(ALPHA_OPERATOR, {
      sandboxId: retained.sandbox.sandboxId,
    }),
    assertServiceCode('export_required')
  );
  assert.equal(engine.calls.destroy.length, 0);
  assert.equal(store.listSandboxes(ALPHA_RUNNER).length, 1);

  store.acknowledgeExport(ALPHA_OPERATOR, {
    sandboxId: retained.sandbox.sandboxId,
    digest: `sha256:${'c'.repeat(64)}`,
  });
  const deleted = await service.deleteSandbox(ALPHA_OPERATOR, {
    sandboxId: retained.sandbox.sandboxId,
  });
  assert.equal(deleted.deleted, true);
  assert.equal(store.listSandboxes(ALPHA_RUNNER).length, 0);

  const discarded = await createSandbox(service, ALPHA_RUNNER, {
    requestId: 'discard',
    retention: 'until-export',
  });
  await startSandbox(service, ALPHA_RUNNER, discarded.sandbox.sandboxId);
  await stopSandbox(service, ALPHA_RUNNER, discarded.sandbox.sandboxId);
  const discardedResult = await service.deleteSandbox(ALPHA_OPERATOR, {
    sandboxId: discarded.sandbox.sandboxId,
    discard: true,
    reason: 'operator-discard',
  });
  assert.equal(discardedResult.deleted, true);
  assert.equal(discardedResult.discarded, true);
  assert.equal(discardedResult.sandbox.deletedReason, 'operator-discard');
  assert.equal(store.listSandboxes(ALPHA_RUNNER).length, 0);
});

test('ambiguous create is reconciled by owned allocation without guessing', async (t) => {
  const { service, engine, store } = setup(t, { label: 'ambiguous-create' });

  engine.createHook = async (spec) => {
    const key = engine.key(spec.allocationId, spec.launchGeneration);
    if (!engine.boxes.has(key)) {
      engine.boxes.set(key, {
        allocationId: spec.allocationId,
        launchGeneration: spec.launchGeneration,
        name: `alpi-${spec.allocationId}-g${spec.launchGeneration}`,
        nativeId: 'native-ambiguous',
        running: false,
      });
    }
    throw {
      code: 'engine_create_failed',
      message: 'RAW ENGINE TEXT: /host/private/create',
    };
  };

  let error;
  try {
    await createSandbox(service);
    assert.fail('create should have failed');
  } catch (caught) {
    error = caught;
  }
  assert.equal(error.code, 'engine_uncertain');
  assert.doesNotMatch(error.message, /RAW|host|private/);
  assert.equal(store.listSandboxes(ALPHA_RUNNER).length, 1);

  const pending = await service.getSandbox(
    ALPHA_RUNNER,
    store.listSandboxes(ALPHA_RUNNER)[0].sandboxId
  );
  assert.equal(pending.sandbox.createState, 'uncertain');
  assert.equal(pending.sandbox.nativeId, null);
  assert.equal(pending.sandbox.recoveryRequired, true);

  const recovery = await service.recoverStartup();
  assert.equal(recovery.reconciled.length, 1);
  assert.equal(recovery.reconciled[0].action, 'create');
  assert.equal(recovery.uncertain.length, 0);

  const recovered = await service.getSandbox(
    ALPHA_RUNNER,
    pending.sandbox.sandboxId
  );
  assert.equal(recovered.sandbox.createState, 'created');
  assert.equal(recovered.sandbox.nativeId, 'native-ambiguous');
  assert.equal(recovered.sandbox.recoveryRequired, false);
  assert.equal(engine.calls.create.length, 1);
  assert.equal(engine.boxes.size, 1);

  const retry = await createSandbox(service);
  assert.equal(retry.replayed, true);
  assert.equal(retry.sandbox.sandboxId, pending.sandbox.sandboxId);
  assert.equal(retry.sandbox.nativeId, 'native-ambiguous');
  assert.equal(engine.calls.create.length, 1);
});

test('create failure before a side effect is recovered by getOrCreate', async (t) => {
  const { service, engine, store } = setup(t, { label: 'failed-before' });
  engine.createHook = async () => {
    throw {
      code: 'engine_create_failed',
      message: 'RAW ENGINE TEXT: /host/private/create',
    };
  };
  await assert.rejects(
    createSandbox(service),
    assertServiceCode('engine_uncertain')
  );
  const sandboxId = store.listSandboxes(ALPHA_RUNNER)[0].sandboxId;
  const pending = await service.getSandbox(ALPHA_RUNNER, sandboxId);
  assert.equal(pending.sandbox.nativeId, null);
  assert.equal(pending.sandbox.createState, 'uncertain');

  engine.createHook = null;
  const recovery = await service.recoverStartup();
  assert.equal(recovery.reconciled.length, 1);
  const recovered = await service.getSandbox(ALPHA_RUNNER, sandboxId);
  assert.equal(recovered.sandbox.createState, 'created');
  assert.match(recovered.sandbox.nativeId, /^native-/);
  assert.equal(engine.boxes.size, 1);

  const retry = await createSandbox(service);
  assert.equal(retry.replayed, true);
  assert.equal(retry.sandbox.nativeId, recovered.sandbox.nativeId);
});

test('startup recovery survives a service restart without an MCP', async (t) => {
  const directory = tempDirectory(t, 'restart-recovery');
  const clock = createClock();
  const engine = new FakeEngineAdapter();
  const withEngine = async (record, fn) => fn(engine);
  const resolver = makeResolver();

  let store = openWorkStore(directory, { now: clock.now });
  let service = createSandboxService({
    store,
    stateDir: directory,
    resolveProfile: resolver,
    withEngine,
    clock: clock.now,
  });

  engine.createHook = async (spec) => {
    const key = engine.key(spec.allocationId, spec.launchGeneration);
    engine.boxes.set(key, {
      allocationId: spec.allocationId,
      launchGeneration: spec.launchGeneration,
      name: `alpi-${spec.allocationId}-g${spec.launchGeneration}`,
      nativeId: 'native-restart',
      running: false,
    });
    throw {
      code: 'engine_create_failed',
      message: 'RAW ENGINE TEXT: /host/private/create',
    };
  };

  await assert.rejects(
    createSandbox(service),
    assertServiceCode('engine_uncertain')
  );
  const sandboxId = store.listSandboxes(ALPHA_RUNNER)[0].sandboxId;
  service.close();
  store.close();

  store = openWorkStore(directory, { now: clock.now });
  service = createSandboxService({
    store,
    stateDir: directory,
    resolveProfile: resolver,
    withEngine,
    clock: clock.now,
  });
  t.after(() => {
    service.close();
    store.close();
  });

  const recovery = await service.recoverStartup();
  assert.equal(recovery.reconciled.length, 1);
  const recovered = await service.getSandbox(ALPHA_RUNNER, sandboxId);
  assert.equal(recovered.sandbox.createState, 'created');
  assert.equal(recovered.sandbox.nativeId, 'native-restart');
  assert.equal(recovered.sandbox.launchGeneration, 1);
  assert.equal(engine.calls.create.length, 1);
  assert.equal(engine.boxes.size, 1);
});

test('TTL sweep stops and removes expired sandboxes but retains unexported content', async (t) => {
  const { service, engine, store, clock } = setup(t, {
    label: 'ttl',
    start: 1_000_000,
  });

  const ephemeral = await createSandbox(service, ALPHA_RUNNER, {
    requestId: 'ttl-ephemeral',
    retention: 'ttl',
    ttlSeconds: 60,
  });
  const exported = await createSandbox(service, ALPHA_RUNNER, {
    requestId: 'ttl-exported',
    retention: 'until-export',
    ttlSeconds: 60,
  });
  const retained = await createSandbox(service, ALPHA_RUNNER, {
    requestId: 'ttl-retained',
    retention: 'until-export',
    ttlSeconds: 60,
  });
  const beta = await createSandbox(service, BETA_OPERATOR, {
    requestId: 'ttl-beta',
    retention: 'ttl',
    ttlSeconds: 60,
  });

  for (const sandbox of [ephemeral, exported, retained, beta]) {
    await startSandbox(
      service,
      sandbox.sandbox.project === 'beta' ? BETA_OPERATOR : ALPHA_RUNNER,
      sandbox.sandbox.sandboxId
    );
  }
  store.acknowledgeExport(ALPHA_OPERATOR, {
    sandboxId: exported.sandbox.sandboxId,
    digest: `sha256:${'d'.repeat(64)}`,
  });

  clock.advance(120_000);
  const sweep = await service.sweepTtl();
  assert.equal(sweep.checked, 4);
  assert.equal(sweep.stopped.length, 4);
  assert.equal(sweep.deleted.length, 3);
  assert.equal(sweep.retained.length, 1);
  assert.equal(sweep.uncertain.length, 0);
  assert.equal(sweep.retained[0].sandboxId, retained.sandbox.sandboxId);
  assert.equal(store.listSandboxes(ALPHA_RUNNER).length, 1);
  assert.equal(store.listSandboxes(BETA_OPERATOR).length, 0);
  assert.equal(engine.boxes.size, 1);

  const retainedAfterSweep = await service.getSandbox(
    ALPHA_RUNNER,
    retained.sandbox.sandboxId
  );
  assert.equal(retainedAfterSweep.sandbox.observedState, 'stopped');
  assert.equal(retainedAfterSweep.sandbox.deletedAt, null);

  store.acknowledgeExport(ALPHA_OPERATOR, {
    sandboxId: retained.sandbox.sandboxId,
    digest: `sha256:${'e'.repeat(64)}`,
  });
  const secondSweep = await service.sweepTtl();
  assert.equal(secondSweep.deleted.length, 1);
  assert.equal(store.listSandboxes(ALPHA_RUNNER).length, 0);
  assert.equal(engine.boxes.size, 0);
});

test('cross-project access is indistinguishable from missing', async (t) => {
  const { service, engine } = setup(t, { label: 'cross-scope' });
  const created = await createSandbox(service);
  const sandboxId = created.sandbox.sandboxId;
  await startSandbox(service, ALPHA_RUNNER, sandboxId);
  const startCalls = engine.calls.start.length;

  await assert.rejects(
    service.getSandbox(BETA_OPERATOR, sandboxId),
    assertServiceCode('not_found')
  );
  await assert.rejects(
    service.startSandbox(BETA_OPERATOR, { sandboxId }),
    assertServiceCode('not_found')
  );
  await assert.rejects(
    service.stopSandbox(BETA_OPERATOR, { sandboxId }),
    assertServiceCode('not_found')
  );
  await assert.rejects(
    service.deleteSandbox(BETA_OPERATOR, { sandboxId }),
    assertServiceCode('not_found')
  );
  assert.equal(engine.calls.start.length, startCalls);
  const betaList = await service.listSandboxes(BETA_OPERATOR);
  assert.equal(betaList.count, 0);
  const betaStatus = await service.status(BETA_OPERATOR);
  assert.equal(betaStatus.counts.sandboxes, 0);

  const observerGet = await service.getSandbox(ALPHA_OBSERVER, sandboxId);
  assert.equal(observerGet.sandbox.sandboxId, sandboxId);
  await assert.rejects(
    service.createSandbox(ALPHA_OBSERVER, baseCreate({ requestId: 'obs' })),
    assertServiceCode('forbidden')
  );
  await assert.rejects(
    service.startSandbox(ALPHA_OBSERVER, { sandboxId }),
    assertServiceCode('forbidden')
  );
  await assert.rejects(
    service.deleteSandbox(ALPHA_RUNNER, { sandboxId }),
    assertServiceCode('forbidden')
  );
});

test('exec requires a validated writer lease and is bounded', async (t) => {
  const { service, engine, store, clock } = setup(t, { label: 'exec' });
  const created = await createSandbox(service);
  const sandboxId = created.sandbox.sandboxId;
  const workspaceId = created.sandbox.workspaceId;
  await startSandbox(service, ALPHA_RUNNER, sandboxId);
  const lease = acquireLease(store, ALPHA_RUNNER, workspaceId);

  engine.execHook = async () => ({
    exitCode: 0,
    stdout: 'abcdefgh',
    stderr: 'ERRORS',
    truncated: false,
    timedOut: false,
    cancelled: false,
    executionId: 'exec-2',
  });

  const execution = await service.execInSandbox(ALPHA_RUNNER, {
    sandboxId,
    workspaceId,
    leaseEpoch: lease.epoch,
    argv: ['/usr/bin/node', '-e', 'console.log(1)'],
    timeoutMs: 5,
    maxOutputBytes: 4,
    workingDir: '/workspace',
  });
  assert.equal(execution.exitCode, 0);
  assert.equal(execution.stdout, 'abcd');
  assert.equal(execution.stderr, 'ERRO');
  assert.equal(execution.truncated, true);
  assert.equal(execution.executionId, 'exec-2');
  const lastExec = engine.calls.exec.at(-1);
  assert.deepEqual(lastExec.spec.argv, [
    '/usr/bin/node',
    '-e',
    'console.log(1)',
  ]);
  assert.equal(lastExec.spec.timeoutMs, 5);
  assert.equal(lastExec.spec.maxOutputBytes, 4);
  assert.equal(lastExec.spec.workingDir, '/workspace');
  assert.equal(lastExec.spec.env, undefined);
  assert.equal(lastExec.spec.user, undefined);

  await assert.rejects(
    service.execInSandbox(ALPHA_RUNNER, {
      sandboxId,
      workspaceId,
      argv: ['echo', 'hi'],
    }),
    assertServiceCode('invalid_input')
  );
  await assert.rejects(
    service.execInSandbox(ALPHA_RUNNER, {
      sandboxId,
      workspaceId: UUID_3,
      leaseEpoch: lease.epoch,
      argv: ['echo', 'hi'],
    }),
    assertServiceCode('invalid_input')
  );
  await assert.rejects(
    service.execInSandbox(ALPHA_RUNNER, {
      sandboxId,
      workspaceId,
      leaseEpoch: lease.epoch,
      argv: ['echo', 'hi'],
      workingDir: '/workspace/../host',
    }),
    assertServiceCode('invalid_input')
  );
  await assert.rejects(
    service.execInSandbox(ALPHA_RUNNER, {
      sandboxId,
      workspaceId,
      leaseEpoch: lease.epoch,
      argv: ['echo', 'hi'],
      env: {},
    }),
    assertServiceCode('invalid_input')
  );
  await assert.rejects(
    service.execInSandbox(ALPHA_RUNNER, {
      sandboxId,
      workspaceId,
      leaseEpoch: lease.epoch,
      argv: ['echo', 'hi'],
      user: 'root',
    }),
    assertServiceCode('invalid_input')
  );
  await assert.rejects(
    service.execInSandbox(ALPHA_RUNNER, {
      sandboxId,
      workspaceId,
      leaseEpoch: lease.epoch,
      argv: ['echo', 'hi'],
      command: 'sh',
    }),
    assertServiceCode('invalid_input')
  );
  await assert.rejects(
    service.execInSandbox(ALPHA_RUNNER, {
      sandboxId,
      workspaceId,
      leaseEpoch: lease.epoch,
      argv: Array.from({ length: 20 }, () => 'x'.repeat(4000)),
    }),
    assertServiceCode('invalid_input')
  );

  store.releaseLease(ALPHA_RUNNER, {
    workspaceId,
    epoch: lease.epoch,
  });
  await assert.rejects(
    service.execInSandbox(ALPHA_RUNNER, {
      sandboxId,
      workspaceId,
      leaseEpoch: lease.epoch,
      argv: ['echo', 'hi'],
    }),
    assertServiceCode('lease_missing')
  );

  const nextLease = acquireLease(store, ALPHA_RUNNER, workspaceId, 5);
  await assert.rejects(
    service.execInSandbox(ALPHA_RUNNER, {
      sandboxId,
      workspaceId,
      leaseEpoch: lease.epoch,
      argv: ['echo', 'hi'],
    }),
    assertServiceCode('lease_stale')
  );
  clock.advance(10_000);
  await assert.rejects(
    service.execInSandbox(ALPHA_RUNNER, {
      sandboxId,
      workspaceId,
      leaseEpoch: nextLease.epoch,
      argv: ['echo', 'hi'],
    }),
    assertServiceCode('lease_expired')
  );

  const freshLease = acquireLease(store, ALPHA_RUNNER, workspaceId);
  await assert.rejects(
    service.execInSandbox(ALPHA_RUNNER_2, {
      sandboxId,
      workspaceId,
      leaseEpoch: freshLease.epoch,
      argv: ['echo', 'hi'],
    }),
    assertServiceCode('forbidden')
  );
  await assert.rejects(
    service.execInSandbox(ALPHA_OBSERVER, {
      sandboxId,
      workspaceId,
      leaseEpoch: freshLease.epoch,
      argv: ['echo', 'hi'],
    }),
    assertServiceCode('forbidden')
  );

  await stopSandbox(service, ALPHA_RUNNER, sandboxId);
  await assert.rejects(
    service.execInSandbox(ALPHA_RUNNER, {
      sandboxId,
      workspaceId,
      leaseEpoch: freshLease.epoch,
      argv: ['echo', 'hi'],
    }),
    assertServiceCode('invalid_transition')
  );

  await startSandbox(service, ALPHA_RUNNER, sandboxId);
  engine.execHook = async (ref, spec) => {
    assert.equal(spec.timeoutMs, 300_000);
    assert.equal(spec.maxOutputBytes, 8 * 1024 * 1024);
    return {
      exitCode: 0,
      stdout: 'clamped',
      stderr: '',
      truncated: false,
      timedOut: false,
      cancelled: false,
    };
  };
  const clamped = await service.execInSandbox(ALPHA_RUNNER, {
    sandboxId,
    workspaceId,
    leaseEpoch: freshLease.epoch,
    argv: ['echo', 'hi'],
    timeoutMs: 999_999,
    maxOutputBytes: 999_999_999,
  });
  assert.equal(clamped.stdout, 'clamped');

  engine.execHook = async () => {
    throw {
      code: 'engine_exec_failed',
      message: 'RAW ENGINE TEXT: /host/private/exec',
    };
  };
  let execError;
  try {
    await service.execInSandbox(ALPHA_RUNNER, {
      sandboxId,
      workspaceId,
      leaseEpoch: freshLease.epoch,
      argv: ['echo', 'hi'],
    });
    assert.fail('exec should have failed');
  } catch (caught) {
    execError = caught;
  }
  assert.equal(execError.code, 'exec_failed');
  assert.doesNotMatch(execError.message, /RAW|host|private/);

  // A dispatched execution whose termination was not confirmed fences the
  // workspace writer until a verified stop is observed.
  await assert.rejects(
    service.execInSandbox(ALPHA_RUNNER, {
      sandboxId,
      workspaceId,
      leaseEpoch: freshLease.epoch,
      argv: ['echo', 'hi'],
    }),
    assertServiceCode('writer_fenced')
  );
  await stopSandbox(service, ALPHA_RUNNER, sandboxId);
  await startSandbox(service, ALPHA_RUNNER, sandboxId);

  engine.execHook = async () => {
    throw {
      code: 'engine_termination_unverified',
      message: 'RAW ENGINE TEXT: /host/private/termination',
    };
  };
  let terminationError;
  try {
    await service.execInSandbox(ALPHA_RUNNER, {
      sandboxId,
      workspaceId,
      leaseEpoch: freshLease.epoch,
      argv: ['echo', 'hi'],
    });
    assert.fail('exec should have failed');
  } catch (caught) {
    terminationError = caught;
  }
  assert.equal(terminationError.code, 'exec_uncertain');
  assert.equal(terminationError.retryable, false);
  assert.doesNotMatch(terminationError.message, /RAW|host|private/);

  await assert.rejects(
    service.execInSandbox(ALPHA_RUNNER, {
      sandboxId,
      workspaceId,
      leaseEpoch: freshLease.epoch,
      argv: ['echo', 'hi'],
    }),
    assertServiceCode('writer_fenced')
  );

  // The fence also blocks lease handoff while it is active.
  store.releaseLease(ALPHA_RUNNER, { workspaceId, epoch: freshLease.epoch });
  assert.throws(
    () => acquireLease(store, ALPHA_RUNNER, workspaceId),
    assertStoreCode('writer_fenced')
  );
  assert.throws(
    () => acquireLease(store, ALPHA_RUNNER_2, workspaceId),
    assertStoreCode('writer_fenced')
  );

  // A verified stop clears the fence and writes resume afterwards.
  await stopSandbox(service, ALPHA_RUNNER, sandboxId);
  await startSandbox(service, ALPHA_RUNNER, sandboxId);
  const resumedLease = acquireLease(store, ALPHA_RUNNER, workspaceId);

  engine.execHook = async () => ({
    exitCode: 0,
    stdout: '',
    stderr: '',
    truncated: false,
    timedOut: true,
    cancelled: false,
  });
  const timedOut = await service.execInSandbox(ALPHA_RUNNER, {
    sandboxId,
    workspaceId,
    leaseEpoch: resumedLease.epoch,
    argv: ['echo', 'hi'],
  });
  assert.equal(timedOut.timedOut, true);
});

test('bounded queue rejects excess concurrent operations', async (t) => {
  const { service, engine, store } = setup(t, {
    label: 'queue',
    serviceOptions: {
      maxQueuePerSandbox: 2,
      maxConcurrentOperations: 4,
      operationTimeoutMs: 50,
    },
  });
  const created = await createSandbox(service);
  const sandboxId = created.sandbox.sandboxId;
  const workspaceId = created.sandbox.workspaceId;
  await startSandbox(service, ALPHA_RUNNER, sandboxId);
  const lease = acquireLease(store, ALPHA_RUNNER, workspaceId);

  engine.execHook = () => new Promise(() => {});
  const input = {
    sandboxId,
    workspaceId,
    leaseEpoch: lease.epoch,
    argv: ['sleep', '1'],
    timeoutMs: 1,
  };
  const first = service.execInSandbox(ALPHA_RUNNER, input);
  const second = service.execInSandbox(ALPHA_RUNNER, input);
  const third = service.execInSandbox(ALPHA_RUNNER, input);
  const settled = await Promise.allSettled([first, second, third]);
  const rejected = settled.filter((entry) => entry.status === 'rejected');
  assert.equal(rejected.length, 3);
  const codes = rejected.map((entry) => entry.reason.code);
  assert.ok(codes.includes('queue_full'));
  assert.ok(codes.filter((code) => code === 'exec_uncertain').length >= 1);
});

test('dispatch exposes structured operations and trusts only the caller principal', async (t) => {
  const { service, engine, store } = setup(t, { label: 'dispatch' });

  const created = await service.dispatch(ALPHA_RUNNER, {
    operation: 'create',
    input: baseCreate(),
  });
  assert.equal(created.sandbox.project, 'alpha');
  assert.equal(created.sandbox.ownerClientId, ALPHA_RUNNER.clientId);

  await assert.rejects(
    service.dispatch(ALPHA_RUNNER, {
      operation: 'create',
      input: {
        ...baseCreate({ requestId: 'body-project' }),
        project: 'beta',
        principal: { project: 'beta', role: 'operator' },
      },
    }),
    assertServiceCode('invalid_input')
  );
  const betaSummary = await service.status(BETA_OPERATOR);
  assert.equal(betaSummary.counts.sandboxes, 0);

  const listed = await service.dispatchHttp(ALPHA_RUNNER, {
    method: 'GET',
    path: '/v1/sandboxes',
  });
  assert.equal(listed.count, 1);

  const started = await service.dispatchHttp(ALPHA_RUNNER, {
    method: 'POST',
    path: `/v1/sandboxes/${created.sandbox.sandboxId}/start`,
    body: {},
  });
  assert.equal(started.started, true);

  const workspaceId = created.sandbox.workspaceId;
  const lease = acquireLease(store, ALPHA_RUNNER, workspaceId);
  engine.execHook = async () => ({
    exitCode: 0,
    stdout: 'dispatched',
    stderr: '',
    truncated: false,
    timedOut: false,
    cancelled: false,
  });
  const executed = await service.dispatchHttp(ALPHA_RUNNER, {
    method: 'POST',
    path: `/v1/sandboxes/${created.sandbox.sandboxId}/exec`,
    body: {
      workspaceId,
      leaseEpoch: lease.epoch,
      argv: ['echo', 'hi'],
    },
  });
  assert.equal(executed.stdout, 'dispatched');

  const status = await service.dispatchHttp(ALPHA_RUNNER, {
    method: 'GET',
    path: `/v1/sandboxes/${created.sandbox.sandboxId}/status`,
  });
  assert.equal(status.sandbox.sandboxId, created.sandbox.sandboxId);

  const summary = await service.dispatch(ALPHA_RUNNER, {
    operation: 'status',
    input: {},
  });
  assert.equal(summary.counts.sandboxes, 1);

  const stopped = await service.dispatchHttp(ALPHA_RUNNER, {
    method: 'POST',
    path: `/v1/sandboxes/${created.sandbox.sandboxId}/stop`,
    body: {},
  });
  assert.equal(stopped.stopped, true);

  const deleted = await service.dispatchHttp(ALPHA_OPERATOR, {
    method: 'DELETE',
    path: `/v1/sandboxes/${created.sandbox.sandboxId}`,
    body: {},
  });
  assert.equal(deleted.deleted, true);

  await assert.rejects(
    service.dispatchHttp(ALPHA_RUNNER, {
      method: 'GET',
      path: '/v1/unknown',
    }),
    assertServiceCode('not_found')
  );
  await assert.rejects(
    service.dispatchHttp(ALPHA_RUNNER, {
      method: 'PUT',
      path: '/v1/sandboxes',
    }),
    assertServiceCode('method_not_allowed')
  );
  await assert.rejects(
    service.dispatch(ALPHA_RUNNER, { operation: 'unknown' }),
    assertServiceCode('unsupported_operation')
  );

  const httpError = httpErrorFor(new SandboxServiceError(
    'forbidden',
    'Operation is not permitted for this role.',
    { status: 403, retryable: false }
  ));
  assert.equal(httpError.status, 403);
  assert.equal(httpError.body.error.code, 'forbidden');
  assert.equal(httpError.body.error.retryable, false);
});

test('status reports project quotas and pending recovery', async (t) => {
  const { service, engine, store } = setup(t, { label: 'status' });
  await createSandbox(service);

  engine.createHook = async (spec) => {
    const key = engine.key(spec.allocationId, spec.launchGeneration);
    engine.boxes.set(key, {
      allocationId: spec.allocationId,
      launchGeneration: spec.launchGeneration,
      name: `alpi-${spec.allocationId}-g${spec.launchGeneration}`,
      nativeId: 'native-pending-status',
      running: false,
    });
    throw {
      code: 'engine_create_failed',
      message: 'RAW ENGINE TEXT: /host/private/create',
    };
  };
  await assert.rejects(
    createSandbox(service, ALPHA_RUNNER, { requestId: 'pending-status' }),
    assertServiceCode('engine_uncertain')
  );
  engine.createHook = null;

  const summary = await service.status(ALPHA_RUNNER);
  assert.equal(summary.project, 'alpha');
  assert.equal(summary.counts.sandboxes, 2);
  assert.equal(summary.counts.pendingRecovery, 1);
  assert.equal(summary.quotas.project.maxSandboxes, 16);
  assert.equal(summary.pendingRecovery.length, 1);
  assert.equal(store.listSandboxes(ALPHA_RUNNER).length, 2);
});

test('trusted dependencies are mandatory and callers cannot supply pins', async (t) => {
  const directory = tempDirectory(t, 'dependencies');
  const clock = createClock();
  const store = openWorkStore(directory, { now: clock.now });
  t.after(() => store.close());

  assert.throws(
    () => createSandboxService({ store }),
    assertServiceCode('invalid_input')
  );
  assert.throws(
    () =>
      createSandboxService({
        store,
        resolveProfile: makeResolver(),
      }),
    assertServiceCode('invalid_input')
  );
  assert.throws(
    () =>
      createSandboxService({
        store,
        withEngine: async () => {},
      }),
    assertServiceCode('invalid_input')
  );

  const service = createSandboxService({
    store,
    stateDir: directory,
    resolveProfile: makeResolver(),
    withEngine: async () => {
      throw new Error('no production engine fallback');
    },
    clock: clock.now,
  });
  t.after(() => service.close());

  for (const field of [
    { imageDigest: IMAGE },
    { engineVersion: '0.14.1' },
    { resources: { ...LIMITS } },
    { networkMode: 'disabled' },
    { limits: { ...LIMITS } },
  ]) {
    await assert.rejects(
      service.createSandbox(ALPHA_RUNNER, {
        ...baseCreate(),
        ...field,
      }),
      assertServiceCode('invalid_input')
    );
  }
  assert.equal(store.listSandboxes(ALPHA_RUNNER).length, 0);
  const journal = readJournal(directory, clock);
  assert.equal(journal.listByProject('alpha').length, 0);
  journal.close();
});

test('journal persists lifecycle intent and survives reopen', async (t) => {
  const directory = tempDirectory(t, 'journal');
  const clock = createClock(2_000_000);
  const journal = openSandboxJournal(directory, { now: clock.now });
  assert.equal(
    fs.statSync(path.join(directory, 'sandbox-journal.sqlite')).mode & 0o777,
    0o600
  );

  const begin = journal.beginCreate({
    project: 'alpha',
    sandboxId: UUID_1,
    clientId: 'client-alpha',
    requestId: 'journal-request',
    createHash: 'create-hash',
    allocationId: UUID_1,
    launchGeneration: 1,
    engine: 'boxlite',
    engineVersion: '0.14.1',
    profile: 'pi-dev',
    imageDigest: IMAGE,
    networkMode: 'disabled',
    resources: LIMITS,
    retention: 'ttl',
    expiresAt: 2_000_100,
  });
  assert.equal(begin.createState, 'pending');
  assert.equal(begin.launchGeneration, 1);
  assert.equal(begin.recoveryRequired, true);

  const created = journal.markCreateResult({
    project: 'alpha',
    sandboxId: UUID_1,
    state: 'created',
    nativeId: 'native-journal',
  });
  assert.equal(created.createState, 'created');
  assert.equal(created.nativeId, 'native-journal');

  const started = journal.beginOperation({
    project: 'alpha',
    sandboxId: UUID_1,
    operation: 'start',
    hash: 'start-hash',
  });
  assert.equal(started.operation, 'start');
  assert.equal(started.operationState, 'pending');
  assert.equal(started.operationGeneration, 1);

  const done = journal.markOperationResult({
    project: 'alpha',
    sandboxId: UUID_1,
    operation: 'start',
    state: 'done',
  });
  assert.equal(done.operationState, 'done');

  const deleteIntent = journal.beginDelete({
    project: 'alpha',
    sandboxId: UUID_1,
    reason: 'test-delete',
    discard: false,
    hash: 'delete-hash',
  });
  assert.equal(deleteIntent.deleteState, 'pending');
  assert.equal(deleteIntent.deleteReason, 'test-delete');

  const removed = journal.markDeleteResult({
    project: 'alpha',
    sandboxId: UUID_1,
    state: 'removed',
    nativeAbsent: true,
    nativeId: 'native-journal',
  });
  assert.equal(removed.deleteState, 'removed');
  assert.equal(removed.nativeAbsentAt, 2_000_000);
  assert.equal(removed.recoveryRequired, true);

  journal.close();
  const reopened = openSandboxJournal(directory, { now: clock.now });
  const persisted = reopened.get('alpha', UUID_1);
  assert.equal(persisted.createState, 'created');
  assert.equal(persisted.nativeId, 'native-journal');
  assert.equal(persisted.deleteState, 'removed');
  assert.equal(persisted.deleteReason, 'test-delete');
  assert.equal(persisted.resources.memoryMiB, LIMITS.memoryMiB);
  assert.equal(reopened.listTtlCandidates(2_000_100).length, 1);
  assert.equal(reopened.listPending().length, 1);

  const marked = reopened.markDeleted({ project: 'alpha', sandboxId: UUID_1 });
  assert.equal(marked.deleteState, 'deleted');
  assert.equal(reopened.listPending().length, 0);
  reopened.close();
});

test('paired HTTPS client resumes the same sandbox after a server restart', async t => {
  const { randomUUID } = require('node:crypto');
  const { startServer } = require('../src/daemon.cjs');
  const { issuePairing } = require('../src/admin-client.cjs');
  const { openHostResources } = require('../src/host-resources.cjs');
  const { requestJson } = require('../../alpi-client/src/transport.cjs');
  const { createClient } = require('../../alpi-client/src/client.cjs');
  const parent = fs.mkdtempSync(path.join(fs.realpathSync(require('node:os').tmpdir()), 'as-'));
  const stateDir = path.join(parent, 'state');
  const engine = new FakeEngineAdapter();
  let daemon;
  t.after(async () => { try { await daemon?.close(); } finally { fs.rmSync(parent, { recursive: true, force: true }); } });
  const open = port => startServer({ stateDir, port, handleSignals: false,
    openResources: options => openHostResources({ ...options, sandboxHost: {
      resolveProfile: makeResolver(), withEngine: (_, use) => use(engine),
    } }),
  });
  daemon = await open(0);
  const invite = await issuePairing({ stateDir, project: 'demo', role: 'operator' });
  const endpoint = { origin: daemon.origin, fingerprint: invite.fingerprint };
  const grant = await requestJson({ ...endpoint, method: 'POST', path: '/v1/pair/exchange',
    body: { invitation: invite.invitation, name: 'testing' } });
  const client = createClient({ ...endpoint, ...grant, serverId: invite.serverId, credentialExpiresAt: grant.expiresAt });
  const create = baseCreate({ requestId: randomUUID() });
  const first = await client.requestResource('createSandbox', {}, create);
  const ref = { sandboxId: first.sandboxId };
  assert.equal(first.vmStarted, false);
  assert.equal(first.nativeId, undefined);
  assert.equal((await client.requestResource('startSandbox', ref, {})).observedState, 'running');
  const port = Number(new URL(daemon.origin).port);
  await daemon.close();
  daemon = await open(port);
  const replay = await client.requestResource('createSandbox', {}, create);
  assert.equal(replay.workspaceId, first.workspaceId);
  assert.equal(replay.replayed, true);
  assert.equal(engine.calls.create.length, 1);
  assert.equal((await client.requestResource('getSandbox', ref)).observedState, 'running');
  assert.equal((await client.requestResource('stopSandbox', ref, {})).observedState, 'stopped');
  assert.equal((await client.requestResource('deleteSandbox', ref, {})).deleted, true);
  assert.deepEqual((await client.requestResource('listSandboxes')).sandboxes, []);
});

test('an engine provider arriving after the deadline cannot create the allocation', async t => {
  const engine = new FakeEngineAdapter();
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const { service } = setup(t, { serviceOptions: {
    maxConcurrentOperations: 1,
    operationTimeoutMs: 40,
    async withEngine(record, use, signal) {
      entered.resolve(signal);
      await gate.promise;
      return use(engine);
    },
  } });
  const rejected = assert.rejects(createSandbox(service), assertServiceCode('engine_uncertain'));
  const signal = await entered.promise;
  // Keep the event loop alive while the production deadline is unref'd.
  const guard = setTimeout(() => gate.resolve(), 2000);
  try {
    await rejected;
    assert.equal(signal.aborted, true);
  } finally {
    clearTimeout(guard);
    gate.resolve();
    await service.settle();
  }
  assert.equal(engine.calls.create.length, 0);
});

test('durable deletion fences later starts and recovery checks the current generation', async t => {
  const { service, engine, store } = setup(t);
  const { sandbox: { sandboxId } } = await createSandbox(service);
  await startSandbox(service, ALPHA_RUNNER, sandboxId);
  await stopSandbox(service, ALPHA_RUNNER, sandboxId);
  engine.destroyHook = () => { throw new Error('Removal unavailable'); };
  await assert.rejects(service.deleteSandbox(ALPHA_OPERATOR, { sandboxId }), assertServiceCode('engine_uncertain'));
  await assert.rejects(startSandbox(service, ALPHA_RUNNER, sandboxId), assertServiceCode('invalid_transition'));
  assert.equal(engine.calls.start.length, 1);
  engine.destroyHook = null;
  // A database left by the earlier server can contain a later admitted start.
  const receipt = store.getSandbox(ALPHA_RUNNER, sandboxId);
  const running = store.startSandbox(ALPHA_RUNNER, { sandboxId, generation: receipt.generation });
  assert.equal((await service.recoverStartup()).uncertain[0].code, 'stop_unconfirmed');
  store.stopSandbox(ALPHA_RUNNER, { sandboxId, generation: running.generation });
  assert.equal((await service.recoverStartup()).uncertain[0].code, 'generation_conflict');
  assert.equal(engine.calls.destroy.length, 1);
  assert.equal(engine.boxes.size, 1);
});

test('recovery finishes an interrupted delete when its original intent still matches', async t => {
  const { service, engine } = setup(t);
  const { sandbox: { sandboxId } } = await createSandbox(service);
  await stopSandbox(service, ALPHA_RUNNER, sandboxId);
  engine.destroyHook = () => { throw new Error('Removal unavailable'); };
  await assert.rejects(service.deleteSandbox(ALPHA_OPERATOR, { sandboxId }), assertServiceCode('engine_uncertain'));
  engine.destroyHook = null;
  assert.equal((await service.recoverStartup()).reconciled[0].action, 'delete');
  assert.equal(engine.boxes.size, 0);
});

test('recovery attaches a completed journal record only after inspecting its owned box', async t => {
  const { service, engine, directory, store } = setup(t);
  const { sandbox } = await createSandbox(service);
  // Model a restart after the journal commit and before the work-store attachment.
  const db = new (require('node:sqlite').DatabaseSync)(path.join(directory, 'work.sqlite'));
  try {
    db.prepare("UPDATE sandboxes SET native_id = NULL, observed_state = 'unknown' WHERE sandbox_id = ?").run(sandbox.sandboxId);
  } finally { db.close(); }
  const inspect = engine.inspect.bind(engine);
  engine.inspect = async ref => ({ ...await inspect(ref), nativeId: 'different-box' });
  const denied = await service.recoverStartup();
  assert.equal(denied.uncertain[0].code, 'engine_identity_conflict');
  assert.equal(store.getSandbox(ALPHA_RUNNER, sandbox.sandboxId).nativeId, null);
  engine.inspect = inspect;
  const recovered = await service.recoverStartup();
  assert.deepEqual(recovered.reconciled, [{ sandboxId: sandbox.sandboxId, project: 'alpha', action: 'attach' }]);
  const receipt = store.getSandbox(ALPHA_RUNNER, sandbox.sandboxId);
  assert.equal(receipt.nativeId, sandbox.nativeId);
  assert.equal(receipt.observedState, 'stopped');
  assert.equal((await service.recoverStartup()).checked, 0);
  assert.equal(engine.calls.create.length, 1);
});

test('an interrupted reservation is completed by a create replay without losing quota', async (t) => {
  const directory = tempDirectory(t, 'orphan-replay');
  const clock = createClock();
  const store = openWorkStore(directory, { now: clock.now });
  const realJournal = openSandboxJournal(directory, { now: clock.now });
  t.after(() => {
    service.close();
    store.close();
    realJournal.close();
  });

  // Synthetic fault exactly between the reservation commit and the
  // journal intent commit.
  let faulted = false;
  const journal = Object.create(realJournal);
  journal.beginCreate = (input) => {
    if (!faulted) {
      faulted = true;
      throw new SandboxJournalError(
        'journal_error',
        'synthetic interruption between the commit boundaries'
      );
    }
    return realJournal.beginCreate(input);
  };

  const engine = new FakeEngineAdapter();
  const service = createSandboxService({
    store,
    journal,
    resolveProfile: makeResolver(),
    withEngine: async (record, fn) => fn(engine),
    clock: clock.now,
  });

  await assert.rejects(
    createSandbox(service),
    assertServiceCode('journal_error')
  );
  assert.equal(engine.calls.create.length, 0);
  assert.equal(realJournal.listByProject('alpha').length, 0);
  const stranded = store.listSandboxes(ALPHA_RUNNER);
  assert.equal(stranded.length, 1);
  assert.equal(stranded[0].reservationState, 'pending');
  assert.notEqual(stranded[0].reservationFingerprint, null);
  assert.equal(stranded[0].reservationNetworkMode, 'disabled');
  const summary = await service.status(ALPHA_RUNNER);
  assert.equal(summary.counts.sandboxes, 1);
  assert.deepEqual(summary.pendingRecovery, []);

  // The retry through the normal entry point verifies the original
  // fingerprint and completes the interrupted reservation.
  const completed = await createSandbox(service);
  assert.equal(completed.replayed, false);
  assert.equal(completed.created, true);
  assert.equal(completed.metadataCreated, true);
  assert.equal(engine.calls.create.length, 1);
  assert.equal(realJournal.listByProject('alpha').length, 1);
  const receipt = store.listSandboxes(ALPHA_RUNNER)[0];
  assert.equal(receipt.reservationState, 'committed');
  assert.equal(store.listSandboxes(ALPHA_RUNNER).length, 1);

  // Quota accounting stays intact: exactly one unit is held.
  const next = await createSandbox(service, ALPHA_RUNNER, {
    requestId: 'request-2',
  });
  assert.equal(next.created, true);
  assert.equal(store.listSandboxes(ALPHA_RUNNER).length, 2);
});

test('startup recovery completes a reservation interrupted between the commit boundaries', async (t) => {
  const directory = tempDirectory(t, 'orphan-restart');
  const clock = createClock();
  const engine = new FakeEngineAdapter();
  const resolver = makeResolver();
  const realJournal = openSandboxJournal(directory, { now: clock.now });

  let faulted = false;
  const journal = Object.create(realJournal);
  journal.beginCreate = (input) => {
    if (!faulted) {
      faulted = true;
      throw new SandboxJournalError('journal_error', 'synthetic interruption');
    }
    return realJournal.beginCreate(input);
  };

  let store = openWorkStore(directory, { now: clock.now });
  let service = createSandboxService({
    store,
    journal,
    resolveProfile: resolver,
    withEngine: async (record, fn) => fn(engine),
    clock: clock.now,
  });

  await assert.rejects(
    createSandbox(service),
    assertServiceCode('journal_error')
  );
  const sandboxId = store.listSandboxes(ALPHA_RUNNER)[0].sandboxId;
  service.close();
  store.close();
  journal.beginCreate = (input) => realJournal.beginCreate(input);

  store = openWorkStore(directory, { now: clock.now });
  service = createSandboxService({
    store,
    stateDir: directory,
    resolveProfile: resolver,
    withEngine: async (record, fn) => fn(engine),
    clock: clock.now,
  });
  t.after(() => {
    service.close();
    store.close();
    realJournal.close();
  });

  const recovery = await service.recoverStartup();
  assert.equal(recovery.checked, 1);
  assert.deepEqual(recovery.reconciled, [
    { sandboxId, project: 'alpha', action: 'create' },
  ]);
  assert.equal(recovery.uncertain.length, 0);
  assert.equal(engine.calls.create.length, 1);
  assert.equal(engine.boxes.size, 1);
  const receipt = store.getSandbox(ALPHA_RUNNER, sandboxId);
  assert.equal(receipt.reservationState, 'committed');

  const replay = await createSandbox(service);
  assert.equal(replay.replayed, true);
  assert.equal(replay.created, false);
  assert.equal(replay.sandbox.sandboxId, sandboxId);
  assert.equal(engine.calls.create.length, 1);
  assert.equal((await service.recoverStartup()).checked, 0);

  // Quota is held exactly once for the recovered reservation.
  const next = await createSandbox(service, ALPHA_RUNNER, {
    requestId: 'request-2',
  });
  assert.equal(next.created, true);
  assert.equal(store.listSandboxes(ALPHA_RUNNER).length, 2);
});

test('an interrupted create never replays across a changed fingerprint', async (t) => {
  const directory = tempDirectory(t, 'orphan-conflict');
  const clock = createClock();
  const engine = new FakeEngineAdapter();
  let digest = IMAGE;
  const resolver = async ({ engine, profile }) => ({
    engine,
    profile,
    qualified: true,
    available: true,
    engineVersion: '0.14.1',
    imageDigest: digest,
    limits: { ...LIMITS },
    networkMode: 'disabled',
    capabilities: [...CAPABILITIES],
  });
  const realJournal = openSandboxJournal(directory, { now: clock.now });
  t.after(() => realJournal.close());

  let faulted = false;
  const journal = Object.create(realJournal);
  journal.beginCreate = (input) => {
    if (!faulted) {
      faulted = true;
      throw new SandboxJournalError('journal_error', 'synthetic interruption');
    }
    return realJournal.beginCreate(input);
  };
  const store = openWorkStore(directory, { now: clock.now });
  const service = createSandboxService({
    store,
    journal,
    resolveProfile: resolver,
    withEngine: async (record, fn) => fn(engine),
    clock: clock.now,
  });
  t.after(() => {
    service.close();
    store.close();
  });

  await assert.rejects(
    createSandbox(service),
    assertServiceCode('journal_error')
  );
  const orphan = store.listSandboxes(ALPHA_RUNNER)[0];
  assert.equal(orphan.reservationState, 'pending');

  // A retry whose resolved pins differ conflicts and never re-resolves the
  // stored profile silently.
  digest = IMAGE_V2;
  await assert.rejects(
    createSandbox(service),
    assertServiceCode('idempotency_conflict')
  );
  assert.equal(store.listSandboxes(ALPHA_RUNNER).length, 1);
  assert.equal(realJournal.listByProject('alpha').length, 0);
  assert.equal(engine.calls.create.length, 0);

  // Recovery completes the original create with the stored pins.
  const recovery = await service.recoverStartup();
  assert.equal(recovery.checked, 1);
  assert.deepEqual(recovery.reconciled, [
    { sandboxId: orphan.sandboxId, project: 'alpha', action: 'create' },
  ]);
  const row = realJournal.listByProject('alpha')[0];
  assert.equal(row.imageDigest, IMAGE);
  const receipt = store.getSandbox(ALPHA_RUNNER, orphan.sandboxId);
  assert.equal(receipt.imageDigest, IMAGE);
  assert.equal(receipt.reservationState, 'committed');
  assert.equal(engine.calls.create.length, 1);
});

test('a legacy work-store row without a journal keeps the legacy replay path', async (t) => {
  const { service, engine, store, directory } = setup(t, {
    label: 'legacy-row',
  });

  const reserved = store.reserveSandbox(ALPHA_RUNNER, {
    requestId: 'request-1',
    engine: 'boxlite',
    engineVersion: '0.14.1',
    profile: 'pi-dev',
    imageDigest: IMAGE,
    resources: { ...LIMITS },
    retention: 'ephemeral',
  });

  // Model a row written before reservation state existed.
  const db = new (require('node:sqlite').DatabaseSync)(
    path.join(directory, 'work.sqlite')
  );
  try {
    db.prepare(
      `UPDATE sandboxes SET reservation_state = NULL,
        reservation_fingerprint = NULL, reservation_network_mode = NULL
        WHERE sandbox_id = ?`
    ).run(reserved.sandboxId);
  } finally {
    db.close();
  }
  assert.equal(
    store.getSandbox(ALPHA_RUNNER, reserved.sandboxId).reservationState,
    null
  );

  const replay = await createSandbox(service);
  assert.equal(replay.replayed, true);
  assert.equal(replay.created, false);
  assert.equal(replay.metadataCreated, false);
  assert.equal(replay.sandbox.sandboxId, reserved.sandboxId);
  assert.equal(replay.sandbox.createState, 'legacy');
  assert.equal(engine.calls.create.length, 0);
});

test('an uncertain execution fences the workspace across restart until a verified stop', async (t) => {
  const directory = tempDirectory(t, 'fence-restart');
  const clock = createClock();
  const engine = new FakeEngineAdapter();
  const resolver = makeResolver();
  let store = openWorkStore(directory, { now: clock.now });
  let service = createSandboxService({
    store,
    stateDir: directory,
    resolveProfile: resolver,
    withEngine: async (record, fn) => fn(engine),
    clock: clock.now,
  });
  t.after(() => {
    service.close();
    store.close();
  });

  const created = await createSandbox(service);
  const sandboxId = created.sandbox.sandboxId;
  const workspaceId = created.sandbox.workspaceId;
  await startSandbox(service, ALPHA_RUNNER, sandboxId);
  const lease = acquireLease(store, ALPHA_RUNNER, workspaceId);
  const execInput = {
    sandboxId,
    workspaceId,
    leaseEpoch: lease.epoch,
    argv: ['echo', 'hi'],
  };

  engine.execHook = async () => {
    throw {
      code: 'engine_termination_unverified',
      message: 'RAW ENGINE TEXT: /host/private/termination',
    };
  };
  await assert.rejects(
    service.execInSandbox(ALPHA_RUNNER, execInput),
    assertServiceCode('exec_uncertain')
  );
  await assert.rejects(
    service.execInSandbox(ALPHA_RUNNER, execInput),
    assertServiceCode('writer_fenced')
  );
  store.releaseLease(ALPHA_RUNNER, { workspaceId, epoch: lease.epoch });
  assert.throws(
    () => acquireLease(store, ALPHA_RUNNER, workspaceId),
    assertStoreCode('writer_fenced')
  );
  assert.throws(
    () => acquireLease(store, ALPHA_RUNNER_2, workspaceId),
    assertStoreCode('writer_fenced')
  );

  // The fence is durable: it survives a service restart.
  service.close();
  store.close();
  store = openWorkStore(directory, { now: clock.now });
  service = createSandboxService({
    store,
    stateDir: directory,
    resolveProfile: resolver,
    withEngine: async (record, fn) => fn(engine),
    clock: clock.now,
  });

  assert.equal(store.listWriterFences().length, 1);
  await assert.rejects(
    service.execInSandbox(ALPHA_RUNNER, execInput),
    assertServiceCode('writer_fenced')
  );
  const recovery = await service.recoverStartup();
  assert.equal(recovery.checked, 1);
  assert.equal(recovery.reconciled.length, 0);
  await assert.rejects(
    service.execInSandbox(ALPHA_RUNNER, execInput),
    assertServiceCode('writer_fenced')
  );

  // A verified stop clears the fence; writes resume afterwards.
  await stopSandbox(service, ALPHA_RUNNER, sandboxId);
  await startSandbox(service, ALPHA_RUNNER, sandboxId);
  assert.equal(store.listWriterFences().length, 0);
  const resumedLease = acquireLease(store, ALPHA_RUNNER, workspaceId);
  engine.execHook = async () => ({
    exitCode: 0,
    stdout: 'resumed',
    stderr: '',
    truncated: false,
    timedOut: false,
    cancelled: false,
  });
  const result = await service.execInSandbox(ALPHA_RUNNER, {
    ...execInput,
    leaseEpoch: resumedLease.epoch,
  });
  assert.equal(result.stdout, 'resumed');
});

test('a crashed execution intent becomes a durable writer fence on restart', async (t) => {
  const directory = tempDirectory(t, 'intent-restart');
  const clock = createClock();
  const engine = new FakeEngineAdapter();
  let store = openWorkStore(directory, { now: clock.now });
  let service = createSandboxService({
    store,
    stateDir: directory,
    resolveProfile: makeResolver(),
    withEngine: async (record, fn) => fn(engine),
    clock: clock.now,
  });
  t.after(() => {
    service.close();
    store.close();
  });

  const created = await createSandbox(service);
  const sandboxId = created.sandbox.sandboxId;
  const workspaceId = created.sandbox.workspaceId;
  await startSandbox(service, ALPHA_RUNNER, sandboxId);
  const lease = acquireLease(store, ALPHA_RUNNER, workspaceId);
  const execInput = {
    sandboxId,
    workspaceId,
    leaseEpoch: lease.epoch,
    argv: ['echo', 'hi'],
  };

  // Simulate a crash after the intent is persisted and before the outcome
  // is recorded: the outcome marking fails and the intent stays pending.
  const originalMark = store.markExecIntent.bind(store);
  store.markExecIntent = () => {
    throw new WorkStoreError('store_error', 'synthetic crash');
  };
  engine.execHook = async () => {
    throw {
      code: 'engine_termination_unverified',
      message: 'RAW ENGINE TEXT: /host/private/termination',
    };
  };
  await assert.rejects(
    service.execInSandbox(ALPHA_RUNNER, execInput),
    assertServiceCode('exec_uncertain')
  );
  assert.equal(store.listPendingExecIntents().length, 1);
  store.markExecIntent = originalMark;

  service.close();
  store.close();
  store = openWorkStore(directory, { now: clock.now });
  service = createSandboxService({
    store,
    stateDir: directory,
    resolveProfile: makeResolver(),
    withEngine: async (record, fn) => fn(engine),
    clock: clock.now,
  });

  const recovery = await service.recoverStartup();
  assert.equal(recovery.checked, 1);
  assert.equal(recovery.uncertain.length, 1);
  assert.equal(recovery.uncertain[0].code, 'exec_unverified');
  const fence = store.listWriterFences()[0];
  assert.equal(fence.sandboxId, sandboxId);
  assert.equal(fence.reasonCode, 'restart_unverified');

  await assert.rejects(
    service.execInSandbox(ALPHA_RUNNER, execInput),
    assertServiceCode('writer_fenced')
  );
  assert.throws(
    () => acquireLease(store, ALPHA_RUNNER_2, workspaceId),
    assertStoreCode('writer_fenced')
  );
});

test('a create replay completes from the reservation stored network policy', async (t) => {
  const f = setup(t, {
    label: 'network-replay',
    resolveProfile: makeResolver({
      networkMode: 'boundary',
      networkBoundaryVerified: true,
    }),
  });

  // Seed the exact post-reservation/pre-journal state with a disabled
  // network mode pinned on the reservation.
  f.store.reserveSandbox(ALPHA_RUNNER, {
    requestId: 'request-1',
    engine: 'boxlite',
    engineVersion: '0.14.1',
    profile: 'pi-dev',
    imageDigest: IMAGE,
    resources: { ...LIMITS },
    retention: 'ephemeral',
    networkMode: 'disabled',
  });

  // The retry resolves a changed network mode, but the reservation's
  // persisted policy is authoritative for the missing journal.
  const created = await createSandbox(f.service);
  assert.equal(created.created, true);
  assert.equal(f.engine.calls.create.length, 1);
  assert.equal(f.engine.calls.create[0].profile.network.mode, 'disabled');
  const receipt = f.store.getSandbox(ALPHA_RUNNER, created.sandbox.sandboxId);
  assert.equal(receipt.reservationNetworkMode, 'disabled');
});

test('a pending exec intent fences lease handoff and new lease validation', async (t) => {
  const f = setup(t, { label: 'intent-handoff' });

  const created = await createSandbox(f.service);
  const sandboxId = created.sandbox.sandboxId;
  const workspaceId = created.sandbox.workspaceId;
  await startSandbox(f.service, ALPHA_RUNNER, sandboxId);
  const lease = acquireLease(f.store, ALPHA_RUNNER, workspaceId);

  const entered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  f.engine.execHook = () => {
    entered.resolve();
    return finish.promise;
  };
  const execution = f.service.execInSandbox(ALPHA_RUNNER, {
    sandboxId,
    workspaceId,
    leaseEpoch: lease.epoch,
    argv: ['true'],
  });
  await entered.promise;

  // The dispatched command owns a durable pending intent that records its
  // lease identity.
  assert.equal(f.store.listPendingExecIntents().length, 1);
  const intent = f.store.listPendingExecIntents()[0];
  assert.equal(intent.ownerClientId, ALPHA_RUNNER.clientId);
  assert.equal(intent.leaseEpoch, lease.epoch);

  // The initiating dispatch's own lease identity stays valid while the
  // command runs.
  f.store.validateLease(ALPHA_RUNNER, { workspaceId, epoch: lease.epoch });

  // Handoff is refused while the intent is unresolved, before completion...
  f.store.releaseLease(ALPHA_RUNNER, { workspaceId, epoch: lease.epoch });
  assert.throws(
    () => acquireLease(f.store, ALPHA_RUNNER_2, workspaceId),
    assertStoreCode('writer_fenced')
  );
  assert.throws(
    () => acquireLease(f.store, ALPHA_RUNNER, workspaceId),
    assertStoreCode('writer_fenced')
  );

  // ...and after the lease expires.
  f.clock.advance(61_000);
  assert.throws(
    () => acquireLease(f.store, ALPHA_RUNNER_2, workspaceId),
    assertStoreCode('writer_fenced')
  );

  // Unrelated writers cannot validate authority either.
  assert.throws(
    () => f.store.validateLease(ALPHA_RUNNER_2, { workspaceId, epoch: 2 }),
    assertStoreCode('writer_fenced')
  );

  finish.resolve({
    exitCode: 0,
    stdout: '',
    stderr: '',
    truncated: false,
    timedOut: false,
    cancelled: false,
  });
  await execution;
  assert.equal(f.store.listPendingExecIntents().length, 0);
  const next = acquireLease(f.store, ALPHA_RUNNER_2, workspaceId);
  assert.ok(next.epoch > lease.epoch);
});

test('a failed uncertainty write keeps the pending intent fencing handoff', async (t) => {
  const f = setup(t, { label: 'intent-pending-fault' });

  const created = await createSandbox(f.service);
  const sandboxId = created.sandbox.sandboxId;
  const workspaceId = created.sandbox.workspaceId;
  await startSandbox(f.service, ALPHA_RUNNER, sandboxId);
  const lease = acquireLease(f.store, ALPHA_RUNNER, workspaceId);
  const execInput = {
    sandboxId,
    workspaceId,
    leaseEpoch: lease.epoch,
    argv: ['true'],
  };

  const originalMark = f.store.markExecIntent.bind(f.store);
  f.store.markExecIntent = () => {
    throw new WorkStoreError('store_busy', 'synthetic transient');
  };
  f.engine.execHook = async () => {
    throw { code: 'engine_termination_unverified' };
  };
  await assert.rejects(
    f.service.execInSandbox(ALPHA_RUNNER, execInput),
    assertServiceCode('exec_uncertain')
  );
  f.store.markExecIntent = originalMark;
  assert.equal(f.store.listPendingExecIntents().length, 1);
  assert.equal(f.store.listWriterFences().length, 0);

  // The initiating identity keeps validating its own lease, but handoff is
  // fenced even though no writer_fences row exists yet.
  f.store.validateLease(ALPHA_RUNNER, { workspaceId, epoch: lease.epoch });
  f.store.releaseLease(ALPHA_RUNNER, { workspaceId, epoch: lease.epoch });
  assert.throws(
    () => acquireLease(f.store, ALPHA_RUNNER_2, workspaceId),
    assertStoreCode('writer_fenced')
  );
  assert.throws(
    () => acquireLease(f.store, ALPHA_RUNNER, workspaceId),
    assertStoreCode('writer_fenced')
  );

  // Restart recovery promotes the retained intent to a durable fence.
  const recovery = await f.service.recoverStartup();
  assert.equal(recovery.uncertain.length, 1);
  assert.equal(recovery.uncertain[0].code, 'exec_unverified');
  assert.equal(f.store.listWriterFences().length, 1);
});

test('recovery keeps a pending intent when the store read fails transiently', async (t) => {
  const f = setup(t, { label: 'intent-read-fault' });

  const created = await createSandbox(f.service);
  const sandboxId = created.sandbox.sandboxId;
  const workspaceId = created.sandbox.workspaceId;
  await startSandbox(f.service, ALPHA_RUNNER, sandboxId);
  const lease = acquireLease(f.store, ALPHA_RUNNER, workspaceId);
  const execInput = {
    sandboxId,
    workspaceId,
    leaseEpoch: lease.epoch,
    argv: ['true'],
  };

  const originalMark = f.store.markExecIntent.bind(f.store);
  f.store.markExecIntent = () => {
    throw new WorkStoreError('store_busy', 'synthetic transient');
  };
  f.engine.execHook = async () => {
    throw { code: 'engine_termination_unverified' };
  };
  await assert.rejects(
    f.service.execInSandbox(ALPHA_RUNNER, execInput),
    assertServiceCode('exec_uncertain')
  );
  f.store.markExecIntent = originalMark;

  const originalGet = f.store.getSandbox.bind(f.store);
  let reads = 0;
  f.store.getSandbox = (...args) => {
    reads += 1;
    if (reads === 2) {
      throw new WorkStoreError('store_busy', 'synthetic transient');
    }
    return originalGet(...args);
  };
  const report = await f.service.recoverStartup();
  f.store.getSandbox = originalGet;

  // A failed read is not evidence of deletion: the intent is retained and
  // the operational failure is reported.
  assert.equal(report.uncertain.length, 1);
  assert.equal(report.uncertain[0].code, 'store_busy');
  assert.equal(f.store.listPendingExecIntents().length, 1);
  assert.equal(f.store.listWriterFences().length, 0);

  await assert.rejects(
    f.service.execInSandbox(ALPHA_RUNNER, execInput),
    assertServiceCode('writer_fenced')
  );
  assert.equal(f.engine.calls.stop.length, 0);
});

test('recovery keeps an active writer fence when the store read fails transiently', async (t) => {
  const f = setup(t, { label: 'fence-read-fault' });

  const created = await createSandbox(f.service);
  const sandboxId = created.sandbox.sandboxId;
  const workspaceId = created.sandbox.workspaceId;
  await startSandbox(f.service, ALPHA_RUNNER, sandboxId);
  const lease = acquireLease(f.store, ALPHA_RUNNER, workspaceId);
  const execInput = {
    sandboxId,
    workspaceId,
    leaseEpoch: lease.epoch,
    argv: ['true'],
  };

  f.engine.execHook = async () => {
    throw { code: 'engine_termination_unverified' };
  };
  await assert.rejects(
    f.service.execInSandbox(ALPHA_RUNNER, execInput),
    assertServiceCode('exec_uncertain')
  );
  assert.equal(f.store.listWriterFences().length, 1);

  const originalGet = f.store.getSandbox.bind(f.store);
  let reads = 0;
  f.store.getSandbox = (...args) => {
    reads += 1;
    if (reads === 2) {
      throw new WorkStoreError('store_busy', 'synthetic transient');
    }
    return originalGet(...args);
  };
  const report = await f.service.recoverStartup();
  f.store.getSandbox = originalGet;

  assert.equal(report.uncertain.length, 1);
  assert.equal(report.uncertain[0].code, 'store_busy');
  assert.equal(f.store.listWriterFences().length, 1);
  assert.equal(f.store.listPendingExecIntents().length, 0);

  await assert.rejects(
    f.service.execInSandbox(ALPHA_RUNNER, execInput),
    assertServiceCode('writer_fenced')
  );
  assert.equal(f.engine.calls.stop.length, 0);
});

test('a verified stop settles a pending intent left by a failed success outcome', async (t) => {
  const f = setup(t, { label: 'stop-settles-success' });

  const created = await createSandbox(f.service);
  const sandboxId = created.sandbox.sandboxId;
  const workspaceId = created.sandbox.workspaceId;
  await startSandbox(f.service, ALPHA_RUNNER, sandboxId);
  const lease = acquireLease(f.store, ALPHA_RUNNER, workspaceId);
  const execInput = {
    sandboxId,
    workspaceId,
    leaseEpoch: lease.epoch,
    argv: ['true'],
  };

  const originalMark = f.store.markExecIntent.bind(f.store);
  f.store.markExecIntent = () => {
    throw new WorkStoreError('store_busy', 'synthetic transient');
  };
  const result = await f.service.execInSandbox(ALPHA_RUNNER, execInput);
  assert.equal(result.stdout, 'ok');
  f.store.markExecIntent = originalMark;
  assert.equal(f.store.listPendingExecIntents().length, 1);

  // Make the first verified-stop cleanup fail once; protection is kept.
  const originalClear = f.store.clearWriterFence.bind(f.store);
  const failOnce = () => {
    throw new WorkStoreError('store_busy', 'synthetic transient');
  };
  f.store.clearWriterFence = failOnce;
  f.store.settleWriterOwnership = failOnce;
  await stopSandbox(f.service, ALPHA_RUNNER, sandboxId);
  assert.equal(f.store.listPendingExecIntents().length, 1);

  // Retrying the verified-stop cleanup settles the intent.
  f.store.clearWriterFence = originalClear;
  delete f.store.settleWriterOwnership;
  await stopSandbox(f.service, ALPHA_RUNNER, sandboxId);
  assert.equal(f.store.listPendingExecIntents().length, 0);
  assert.equal(f.store.listWriterFences().length, 0);

  await startSandbox(f.service, ALPHA_RUNNER, sandboxId);
  f.store.releaseLease(ALPHA_RUNNER, { workspaceId, epoch: lease.epoch });
  const resumed = acquireLease(f.store, ALPHA_RUNNER, workspaceId);
  const next = await f.service.execInSandbox(ALPHA_RUNNER, {
    ...execInput,
    leaseEpoch: resumed.epoch,
  });
  assert.equal(next.stdout, 'ok');
});

test('a verified stop settles a pending intent left by a failed uncertain outcome', async (t) => {
  const f = setup(t, { label: 'stop-settles-uncertain' });

  const created = await createSandbox(f.service);
  const sandboxId = created.sandbox.sandboxId;
  const workspaceId = created.sandbox.workspaceId;
  await startSandbox(f.service, ALPHA_RUNNER, sandboxId);
  const lease = acquireLease(f.store, ALPHA_RUNNER, workspaceId);
  const execInput = {
    sandboxId,
    workspaceId,
    leaseEpoch: lease.epoch,
    argv: ['true'],
  };

  const originalMark = f.store.markExecIntent.bind(f.store);
  f.store.markExecIntent = () => {
    throw new WorkStoreError('store_busy', 'synthetic transient');
  };
  f.engine.execHook = async () => {
    throw { code: 'engine_termination_unverified' };
  };
  await assert.rejects(
    f.service.execInSandbox(ALPHA_RUNNER, execInput),
    assertServiceCode('exec_uncertain')
  );
  f.store.markExecIntent = originalMark;
  assert.equal(f.store.listPendingExecIntents().length, 1);

  await stopSandbox(f.service, ALPHA_RUNNER, sandboxId);
  assert.equal(f.store.listPendingExecIntents().length, 0);
  assert.equal(f.store.listWriterFences().length, 0);

  await startSandbox(f.service, ALPHA_RUNNER, sandboxId);
  f.engine.execHook = null;
  f.store.releaseLease(ALPHA_RUNNER, { workspaceId, epoch: lease.epoch });
  const resumed = acquireLease(f.store, ALPHA_RUNNER, workspaceId);
  const next = await f.service.execInSandbox(ALPHA_RUNNER, {
    ...execInput,
    leaseEpoch: resumed.epoch,
  });
  assert.equal(next.stdout, 'ok');
});
