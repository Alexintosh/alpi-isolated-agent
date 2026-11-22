'use strict';

/**
 * NETNS-WORKER-1 tests.
 *
 * These tests run on Node 24 with no privilege, no real systemd, no KVM and no
 * VM. They use real loopback TCP and real filesystem Unix-domain sockets for
 * the worker control/bridge paths, and inject kernel/proc, systemctl, SDK and
 * adapter evidence. That separation is deliberate: the tests verify the
 * contract and fail-closed ordering, not a live systemd/KVM qualification.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  EngineWorkerError,
  createEngineWorker,
  observeLoopbackOnly,
  verifyShimProof,
} = require('../src/network/engine-worker.cjs');
const {
  WorkerClientError,
  createSystemctlClient,
  createWorkerClient,
  unitFor,
} = require('../src/network/worker-client.cjs');
const {
  LaunchBoundaryError,
  createLaunchBoundary,
} = require('../src/network/launch-boundary.cjs');

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const IMAGE = `ghcr.io/alpi/pi-dev@sha256:${'a'.repeat(64)}`;
const IMAGE_DIGEST = `sha256:${'a'.repeat(64)}`;
const TOKEN = 'b'.repeat(64);
const PROFILE = Object.freeze({
  network: 'boundary',
  cpus: 2,
  memoryMib: 2048,
  diskSizeGb: 10,
});

function currentUid() {
  return typeof process.geteuid === 'function' ? process.geteuid() : process.getuid();
}

function makeTempDirectory(t) {
  const directory = fs.mkdtempSync('/tmp/alpi-w-');
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function makeSdkFile(root) {
  const file = path.join(root, 'boxlite-sdk.cjs');
  fs.writeFileSync(file, 'module.exports = {};\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function netDev(interfaces) {
  const header =
    'Inter-|   Receive                                                |  Transmit\n' +
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n';
  return header + interfaces.map((name) => `  ${name}: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n`).join('');
}

function ipv4LoopbackRoute() {
  return (
    'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n' +
    'lo\t0000007F\t00000000\t0001\t0\t0\t0\t000000FF\t0\t0\t0\n'
  );
}

function ipv4DefaultRoute() {
  return (
    'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n' +
    'eth0\t00000000\t0101A8C0\t0003\t0\t0\t0\t00000000\t0\t0\t0\n'
  );
}

function ipv6LoopbackRoute() {
  return (
    '00000000000000000000000000000001 80 00000000000000000000000000000000 00 ' +
    '00000000000000000000000000000000 00000400 00000000 00000000 00000001 lo\n'
  );
}

function ipv6DefaultRoute() {
  return (
    '00000000000000000000000000000000 00 00000000000000000000000000000000 00 ' +
    '00000000000000000000000000000000 00000400 00000000 00000000 00000001 lo\n'
  );
}

function makeNetEvidence(options = {}) {
  const netnsInode = options.netnsInode ?? 4026532001;
  const interfaces = options.interfaces ?? ['lo'];
  const ipv4 = options.ipv4 ?? ipv4LoopbackRoute();
  const ipv6 = options.ipv6 ?? ipv6LoopbackRoute();
  return Object.freeze({
    async readlink(target) {
      if (target.endsWith('/ns/net')) {
        return `net:[${netnsInode}]`;
      }
      throw new Error(`unexpected readlink ${target}`);
    },
    async readFile(target) {
      if (target.endsWith('/net/dev')) {
        return netDev(interfaces);
      }
      if (target.endsWith('/net/route')) {
        return ipv4;
      }
      if (target.endsWith('/net/ipv6_route')) {
        return ipv6;
      }
      throw new Error(`unexpected readFile ${target}`);
    },
  });
}

function makeProcStat(pid, startTime) {
  const fields = new Array(20).fill('0');
  fields[0] = 'S';
  fields[19] = String(startTime);
  return `${pid} (boxlite-shim) ${fields.join(' ')}`;
}

function makeProcEvidence(options = {}) {
  const workerPid = options.workerPid ?? process.pid;
  const shimPid = options.shimPid ?? workerPid + 1;
  const cgroup = options.cgroup ?? '/system.slice/alpi-worker@' + UUID_A + '.service';
  const netnsInode = options.netnsInode ?? 4026532001;
  const uid = options.uid ?? currentUid();
  let exe = options.exe ?? '/usr/libexec/boxlite-shim';
  let startTime = options.startTime ?? 9001;

  return {
    shimPid,
    workerPid,
    cgroup,
    netnsInode,
    uid,
    setExe(value) {
      exe = value;
    },
    setStartTime(value) {
      startTime = value;
    },
    async readlink(target) {
      if (target === `/proc/${shimPid}/exe`) {
        return exe;
      }
      if (target === `/proc/${shimPid}/ns/net` || target === `/proc/${workerPid}/ns/net`) {
        return `net:[${netnsInode}]`;
      }
      if (target === '/proc/self/ns/net') {
        return 'net:[4026531999]';
      }
      throw new Error(`unexpected readlink ${target}`);
    },
    async readFile(target) {
      if (target === `/sys/fs/cgroup${cgroup}/cgroup.events`) return 'populated 0\n';
      if (target === `/proc/${shimPid}/stat`) {
        return makeProcStat(shimPid, startTime);
      }
      if (target === `/proc/${shimPid}/status` || target === `/proc/${workerPid}/status`) {
        return `Name:\tboxlite-shim\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`;
      }
      if (target === `/proc/${shimPid}/cgroup` || target === `/proc/${workerPid}/cgroup`) {
        return `0::${cgroup}\n`;
      }
      if (target === '/proc/self/cgroup') {
        return `0::${cgroup}\n`;
      }
      throw new Error(`unexpected readFile ${target}`);
    },
  };
}

function makeInfo(pid, running = true, nativeId = 'native-1', name = null) {
  return {
    id: nativeId,
    name: name ?? `alpi-${UUID_A}-g1`,
    state: { status: running ? 'running' : 'stopped', running, pid },
    image: IMAGE,
    cpus: 2,
    memoryMib: 2048,
  };
}

function makeAdapter(options = {}) {
  const nativeId = options.nativeId ?? 'native-1';
  const name = options.name ?? `alpi-${UUID_A}-g1`;
  let running = false;
  let destroyed = false;
  const info = () => makeInfo(options.pid ?? process.pid + 1, running, nativeId, name);
  return {
    id: 'boxlite',
    async createBox(spec) {
      return {
        allocationId: spec.allocationId,
        launchGeneration: spec.launchGeneration,
        name,
        nativeId,
        created: true,
      };
    },
    async inspect(ref) {
      return {
        allocationId: ref.allocationId,
        launchGeneration: ref.launchGeneration,
        name: ref.name,
        nativeId: ref.nativeId,
        state: running ? 'running' : 'stopped',
        running,
        image: IMAGE,
      };
    },
    async start() {
      running = true;
      return info();
    },
    async stop() {
      running = false;
      return info();
    },
    async destroy() {
      destroyed = true;
      running = false;
      return { destroyed: true, alreadyGone: false };
    },
    async listOwned() {
      if (destroyed) {
        return [];
      }
      return [
        {
          allocationId: UUID_A,
          launchGeneration: 1,
          name,
          nativeId,
          state: running ? 'running' : 'stopped',
          running,
        },
      ];
    },
    async exec() {
      return {
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        truncated: false,
        timedOut: false,
        cancelled: false,
      };
    },
    async close() {},
    getInfo: () => info(),
  };
}

function makeWorkerConfig(root, overrides = {}) {
  const allocationId = overrides.allocationId ?? UUID_A;
  const launchGeneration = overrides.launchGeneration ?? 1;
  const allocationRoot = path.join(root, 'workers', allocationId);
  const homeDir = path.join(allocationRoot, 'home');
  fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(homeDir, 0o700);
  const ironIngressRoot = overrides.ironIngressRoot ?? path.join(root, 'iron');
  fs.mkdirSync(ironIngressRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(ironIngressRoot, 0o700);
  return {
    version: 1,
    protocolVersion: 1,
    stateRoot: root,
    allocationId,
    launchGeneration,
    image: IMAGE,
    imageDigest: IMAGE_DIGEST,
    sdkModulePath: overrides.sdkModulePath ?? path.join(root, 'sdk.cjs'),
    profile: PROFILE,
    homeDir,
    controlSocketPath: path.join(allocationRoot, 'control.sock'),
    token: overrides.token ?? TOKEN,
    tunnelPort: overrides.tunnelPort,
    ironIngressRoot,
    createdAt: new Date().toISOString(),
    serviceUnit: `alpi-worker@${allocationId}.service`,
    ...overrides.extra,
  };
}

function makeSystemctl(allocationId = UUID_A) {
  const state = {
    active: false,
    startCalls: 0,
    stopCalls: 0,
    unit: unitFor(allocationId),
  };
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
            `ControlGroup=/system.slice/${state.unit}\n`,
          stderr: '',
        };
      }
      throw new Error(`unexpected systemctl argv ${argv.join(' ')}`);
    },
  });
  return { client, state };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, `expected ${code}, received ${error.code}: ${error.message}`);
    return true;
  });
}

function onceClose(socket, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    if (socket.destroyed) {
      resolve();
      return;
    }
    const timer = setTimeout(() => reject(new Error('socket did not close')), timeoutMs);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function connectTcp(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

function readOnce(socket, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket read timed out')), timeoutMs);
    socket.once('data', (chunk) => {
      clearTimeout(timer);
      resolve(chunk.toString('utf8'));
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function rawWorkerRequest(socketPath, hello, message, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ path: socketPath });
    let buffer = '';
    let phase = 'hello';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('raw worker request timed out'));
    }, timeoutMs);
    const finish = (error, value) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ id: null, op: 'hello', ...hello })}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (!line) continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch (error) {
          finish(error);
          return;
        }
        if (phase === 'hello') {
          if (!parsed.ok) {
            finish(Object.assign(new Error(parsed.error.message), { code: parsed.error.code }));
            return;
          }
          phase = 'request';
          socket.write(`${JSON.stringify({ id: 1, ...message })}\n`);
        } else {
          if (parsed.ok) finish(null, parsed.result);
          else finish(Object.assign(new Error(parsed.error.message), { code: parsed.error.code }));
        }
      }
    });
    socket.on('error', (error) => finish(error));
  });
}

async function setupWorker(t, options = {}) {
  const root = options.root ?? makeTempDirectory(t);
  const tunnelPort = options.tunnelPort ?? (await freePort());
  const sdkModulePath = options.sdkModulePath ?? makeSdkFile(root);
  const config = makeWorkerConfig(root, {
    tunnelPort,
    sdkModulePath,
    ...options.config,
  });
  const configPath = path.join(root, 'workers', config.allocationId, 'worker.json');
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
  const proc = options.proc ?? makeProcEvidence({ cgroup: `/system.slice/alpi-worker@${config.allocationId}.service` });
  const netEvidence = options.net ?? makeNetEvidence();
  const adapter = options.adapter ?? makeAdapter({ name: `alpi-${config.allocationId}-g${config.launchGeneration}` });
  const worker = createEngineWorker({
    config,
    adapter,
    getInfo: adapter.getInfo,
    proc,
    net: netEvidence,
    uid: currentUid(),
    proofMaxAgeMs: 5000,
    ownerHeartbeatTimeoutMs: 5000,
    watchdogMs: 100,
    ...options.workerOptions,
  });
  const address = await worker.start();
  t.after(async () => {
    await worker.close().catch(() => {});
  });
  return { root, tunnelPort, config, configPath, proc, netEvidence, adapter, worker, address };
}

async function setupClient(t, workerSetup, options = {}) {
  const { client, state } = options.systemctl ?? makeSystemctl(workerSetup.config.allocationId);
  const clientApi = createWorkerClient({
    allocationId: workerSetup.config.allocationId,
    launchGeneration: workerSetup.config.launchGeneration,
    controlSocketPath: workerSetup.config.controlSocketPath,
    token: workerSetup.config.token,
    serviceUid: currentUid(),
    tunnelPort: workerSetup.config.tunnelPort,
    systemctl: client,
    proc: workerSetup.proc,
    net: workerSetup.netEvidence,
    heartbeatIntervalMs: 500,
    proofMaxAgeMs: 5000,
    startTimeoutMs: 3000,
    stopTimeoutMs: 3000,
    connectRetryMs: 50,
    ...options.clientOptions,
  });
  t.after(async () => {
    try {
      clientApi.close();
    } catch {}
    try {
      await clientApi.stop();
    } catch {}
  });
  return { client: clientApi, systemctlState: state };
}

function makeLaunch(root, overrides = {}) {
  return {
    allocationId: UUID_A,
    launchGeneration: 1,
    image: IMAGE,
    imageDigest: IMAGE_DIGEST,
    profile: PROFILE,
    ...overrides,
  };
}

function makeBoundary(t, options = {}) {
  const root = options.root ?? makeTempDirectory(t);
  const sdkModulePath = options.sdkModulePath ?? makeSdkFile(root);
  const ironIngressRoot = options.ironIngressRoot ?? path.join(root, 'iron');
  fs.mkdirSync(ironIngressRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(ironIngressRoot, 0o700);
  const systemctl = options.systemctl ?? makeSystemctl(UUID_A);
  const boundary = createLaunchBoundary({
    stateRoot: root,
    tunnelPort: options.tunnelPort ?? 41000,
    ironIngressRoot,
    sdkModulePath,
    image: IMAGE,
    imageDigest: IMAGE_DIGEST,
    profile: PROFILE,
    uid: currentUid(),
    systemctl: systemctl.client,
    proc: options.proc ?? makeProcEvidence(),
    net: options.net ?? makeNetEvidence(),
    heartbeatIntervalMs: 500,
    proofMaxAgeMs: 5000,
    ownerHeartbeatTimeoutMs: 5000,
    startTimeoutMs: 3000,
    stopTimeoutMs: 3000,
    connectRetryMs: 50,
    ...options.boundaryOptions,
  });
  t.after(() => boundary.close());
  return { boundary, root, sdkModulePath, ironIngressRoot, systemctl };
}

// ---------------------------------------------------------------------------
// Namespace and process proof
// ---------------------------------------------------------------------------

test('loopback-only namespace evidence is accepted; non-loopback interface or route is denied', async () => {
  const good = await observeLoopbackOnly(makeNetEvidence());
  assert.equal(good.netnsInode, 4026532001);
  assert.deepEqual(good.interfaces, ['lo']);

  await expectCode(
    observeLoopbackOnly(makeNetEvidence({ interfaces: ['lo', 'eth0'] })),
    'worker_network_unsafe'
  );
  await expectCode(
    observeLoopbackOnly(makeNetEvidence({ ipv4: ipv4DefaultRoute() })),
    'worker_network_unsafe'
  );
  await expectCode(
    observeLoopbackOnly(makeNetEvidence({ ipv6: ipv6DefaultRoute() })),
    'worker_network_unsafe'
  );
});

test('worker denies an unsafe namespace before importing or constructing the SDK', async (t) => {
  const root = makeTempDirectory(t);
  const config = makeWorkerConfig(root, { tunnelPort: await freePort() });
  config.sdkModulePath = path.join(root, 'missing-sdk.cjs');
  const worker = createEngineWorker({
    config,
    proc: makeProcEvidence(),
    net: makeNetEvidence({ interfaces: ['lo', 'eth0'] }),
    uid: currentUid(),
  });
  await expectCode(worker.start(), 'worker_network_unsafe');
  await worker.close();
});

test('shim proof requires boxlite-shim, start time, service cgroup, namespace and uid', async () => {
  const proc = makeProcEvidence({ netnsInode: 4026532001 });
  const info = makeInfo(proc.shimPid, true, 'native-1', `alpi-${UUID_A}-g1`);
  const proof = await verifyShimProof({
    info,
    nativeId: 'native-1',
    name: `alpi-${UUID_A}-g1`,
    proc,
    workerNetnsInode: 4026532001,
    workerCgroup: proc.cgroup,
    expectedUid: currentUid(),
  });
  assert.equal(proof.exe, '/usr/libexec/boxlite-shim');
  assert.equal(proof.startTime, 9001);

  proc.setExe('/usr/bin/evil');
  await expectCode(
    verifyShimProof({
      info,
      nativeId: 'native-1',
      name: `alpi-${UUID_A}-g1`,
      proc,
      workerNetnsInode: 4026532001,
      workerCgroup: proc.cgroup,
      expectedUid: currentUid(),
    }),
    'worker_shim_unverified'
  );
  proc.setExe('/usr/libexec/boxlite-shim');

  await expectCode(
    verifyShimProof({
      info,
      nativeId: 'native-1',
      name: `alpi-${UUID_A}-g1`,
      proc,
      workerNetnsInode: 4026532999,
      workerCgroup: proc.cgroup,
      expectedUid: currentUid(),
    }),
    'worker_shim_unverified'
  );

  proc.setStartTime(9002);
  await expectCode(
    verifyShimProof({
      info,
      nativeId: 'native-1',
      name: `alpi-${UUID_A}-g1`,
      proc,
      workerNetnsInode: 4026532001,
      workerCgroup: proc.cgroup,
      expectedUid: currentUid(),
      previousStartTime: 9001,
    }),
    'worker_shim_unverified'
  );
});

// ---------------------------------------------------------------------------
// Configuration trust
// ---------------------------------------------------------------------------

test('worker rejects private-config, path, ownership, allocation and image violations', async (t) => {
  const root = makeTempDirectory(t);
  const good = makeWorkerConfig(root, { tunnelPort: await freePort() });
  const allocationRoot = path.join(root, 'workers', UUID_A);
  const configPath = path.join(allocationRoot, 'worker.json');
  fs.writeFileSync(configPath, JSON.stringify(good), { mode: 0o644 });
  fs.chmodSync(configPath, 0o644);
  await expectCode(
    (async () => createEngineWorker({ configPath, proc: makeProcEvidence(), net: makeNetEvidence(), uid: currentUid() }).start())(),
    'unsafe_config'
  );
  fs.chmodSync(configPath, 0o600);

  const wrongPathConfig = { ...good, homeDir: path.join(root, 'elsewhere') };
  fs.writeFileSync(configPath, JSON.stringify(wrongPathConfig), { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
  await expectCode(
    (async () => createEngineWorker({ configPath, proc: makeProcEvidence(), net: makeNetEvidence(), uid: currentUid() }).start())(),
    'invalid_config'
  );

  const unpinned = { ...good, image: 'ghcr.io/alpi/pi-dev:latest' };
  fs.writeFileSync(configPath, JSON.stringify(unpinned), { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
  await expectCode(
    (async () => createEngineWorker({ configPath, proc: makeProcEvidence(), net: makeNetEvidence(), uid: currentUid() }).start())(),
    'invalid_config'
  );

  const otherOwner = { ...good };
  fs.writeFileSync(configPath, JSON.stringify(otherOwner), { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
  await expectCode(
    (async () => createEngineWorker({
      configPath,
      proc: makeProcEvidence(),
      net: makeNetEvidence(),
      uid: currentUid() + 1,
    }).start())(),
    'unsafe_config'
  );

  const symlink = path.join(allocationRoot, 'worker-link.json');
  fs.symlinkSync(configPath, symlink);
  await expectCode(
    (async () => createEngineWorker({
      configPath: symlink,
      proc: makeProcEvidence(),
      net: makeNetEvidence(),
      uid: currentUid(),
    }).start())(),
    'unsafe_config'
  );
});

// ---------------------------------------------------------------------------
// Bounded worker operations over a real UDS
// ---------------------------------------------------------------------------

test('worker serves only its own bounded operations over a private Unix socket', async (t) => {
  const setup = await setupWorker(t);
  const { client } = await setupClient(t, setup);
  const ready = await client.start();
  assert.equal(ready.hello.allocationId, UUID_A);
  assert.equal(ready.hello.netnsInode, setup.address.netnsInode);
  assert.equal(fs.statSync(setup.config.controlSocketPath).mode & 0o777, 0o600);

  const created = await client.engine.createBox({
    allocationId: UUID_A,
    launchGeneration: 1,
    profile: { network: 'boundary' },
  });
  assert.equal(created.nativeId, 'native-1');
  const ref = {
    allocationId: UUID_A,
    launchGeneration: 1,
    name: `alpi-${UUID_A}-g1`,
    nativeId: created.nativeId,
  };

  const inspected = await client.engine.inspect(ref);
  assert.equal(inspected.nativeId, 'native-1');
  await client.engine.start(ref);
  const exec = await client.engine.exec(ref, { argv: ['echo', 'hello'] });
  assert.equal(exec.stdout, 'ok');
  const owned = await client.engine.listOwned();
  assert.equal(owned.length, 1);
  assert.equal(owned[0].allocationId, UUID_A);
  await client.engine.stop(ref);
  const destroyed = await client.engine.destroy(ref);
  assert.equal(destroyed.destroyed, true);

  // Mixed sandbox and host-controlled fields are refused before any wire call.
  await expectCode(
    client.engine.createBox({ allocationId: UUID_B, launchGeneration: 1 }),
    'mixed_sandbox'
  );
  await expectCode(
    client.engine.createBox({ allocationId: UUID_A, launchGeneration: 1, image: IMAGE }),
    'invalid_input'
  );
  await expectCode(
    client.engine.inspect({ ...ref, allocationId: UUID_B }),
    'mixed_sandbox'
  );
  await expectCode(
    client.engine.exec(ref, { argv: ['id'], env: { PATH: '/tmp' } }),
    'invalid_exec'
  );
  await expectCode(
    client.engine.exec(ref, { argv: ['id'], homeDir: '/tmp' }),
    'invalid_exec'
  );
});

test('worker rejects wrong generation, wrong name and a foreign allocation over the wire', async (t) => {
  const setup = await setupWorker(t);
  const hello = {
    protocolVersion: 1,
    allocationId: UUID_A,
    launchGeneration: 1,
    token: TOKEN,
  };
  await expectCode(
    rawWorkerRequest(setup.config.controlSocketPath, hello, {
      op: 'create',
      ref: {
        allocationId: UUID_A,
        launchGeneration: 2,
        name: `alpi-${UUID_A}-g2`,
      },
    }),
    'generation_mismatch'
  );
  await expectCode(
    rawWorkerRequest(setup.config.controlSocketPath, hello, {
      op: 'create',
      ref: {
        allocationId: UUID_B,
        launchGeneration: 1,
        name: `alpi-${UUID_B}-g1`,
      },
    }),
    'mixed_sandbox'
  );
  await expectCode(
    rawWorkerRequest(setup.config.controlSocketPath, hello, {
      op: 'create',
      ref: {
        allocationId: UUID_A,
        launchGeneration: 1,
        name: `alpi-${UUID_A}-g9`,
      },
    }),
    'mixed_sandbox'
  );
});

// ---------------------------------------------------------------------------
// Forwarding gate and bridge fencing
// ---------------------------------------------------------------------------

async function startIronEchoServer(t, directory) {
  const socketPath = path.join(directory, 'iron-ingress.sock');
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => socket.write(chunk));
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  fs.chmodSync(socketPath, 0o600);
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  return socketPath;
}

async function openBridgeAfterStart(t, setup, client) {
  const created = await client.engine.createBox({
    allocationId: UUID_A,
    launchGeneration: 1,
    profile: { network: 'boundary' },
  });
  const ref = {
    allocationId: UUID_A,
    launchGeneration: 1,
    name: `alpi-${UUID_A}-g1`,
    nativeId: created.nativeId,
  };
  await client.engine.start(ref);
  const ironSocketPath = await startIronEchoServer(t, setup.config.ironIngressRoot);
  const bridge = await client.openBridge(ironSocketPath);
  return { ref, bridge, ironSocketPath };
}

test('bridge is denied before an observed owned shim and no tunnel listener exists', async (t) => {
  const setup = await setupWorker(t);
  const { client } = await setupClient(t, setup);
  await client.start();
  await client.engine.createBox({
    allocationId: UUID_A,
    launchGeneration: 1,
    profile: { network: 'boundary' },
  });
  const ironSocketPath = await startIronEchoServer(t, setup.config.ironIngressRoot);
  await expectCode(client.openBridge(ironSocketPath), 'forward_denied');
  await assert.rejects(connectTcp(setup.tunnelPort));
});

test('established bridge transfers are destroyed synchronously on proof failure', async (t) => {
  const setup = await setupWorker(t);
  const { client } = await setupClient(t, setup);
  await client.start();
  const { bridge } = await openBridgeAfterStart(t, setup, client);
  const tcp = await connectTcp(bridge.port);
  tcp.write('ping');
  assert.equal(await readOnce(tcp), 'ping');

  // The trusted SDK still reports the box, but kernel proc evidence now points
  // at a different executable. The heartbeat must fence the bridge.
  setup.proc.setExe('/usr/bin/evil');
  await expectCode(client.heartbeatNow(), 'worker_shim_unverified');
  await onceClose(tcp);
});

test('owner disconnect destroys established bridge transfers', async (t) => {
  const setup = await setupWorker(t);
  const { client } = await setupClient(t, setup);
  await client.start();
  const { bridge } = await openBridgeAfterStart(t, setup, client);
  const tcp = await connectTcp(bridge.port);
  tcp.write('ping');
  assert.equal(await readOnce(tcp), 'ping');

  client.socket.destroy();
  await onceClose(tcp);
  assert.equal(client.connected, false);
});

test('stop fences active bridges before stopping the owned box', async (t) => {
  const setup = await setupWorker(t);
  const { client } = await setupClient(t, setup);
  await client.start();
  const { ref, bridge } = await openBridgeAfterStart(t, setup, client);
  const tcp = await connectTcp(bridge.port);
  tcp.write('ping');
  assert.equal(await readOnce(tcp), 'ping');
  await client.engine.stop(ref);
  await onceClose(tcp);
});

// ---------------------------------------------------------------------------
// Host identity and generation checks
// ---------------------------------------------------------------------------

test('host refuses a worker whose observed namespace differs from its report', async (t) => {
  const setup = await setupWorker(t);
  const wrongProc = makeProcEvidence({
    cgroup: `/system.slice/alpi-worker@${UUID_A}.service`,
    netnsInode: 4026532999,
  });
  const { client } = await setupClient(t, setup, {
    clientOptions: { proc: wrongProc },
  });
  await expectCode(client.start(), 'worker_namespace_mismatch');
});

test('host refuses a shim proof failure and fences before returning', async (t) => {
  const setup = await setupWorker(t);
  const { client } = await setupClient(t, setup);
  await client.start();
  const created = await client.engine.createBox({
    allocationId: UUID_A,
    launchGeneration: 1,
    profile: { network: 'boundary' },
  });
  const ref = {
    allocationId: UUID_A,
    launchGeneration: 1,
    name: `alpi-${UUID_A}-g1`,
    nativeId: created.nativeId,
  };
  setup.proc.setExe('/usr/bin/evil');
  await expectCode(client.engine.start(ref), 'worker_shim_unverified');
});

test('systemctl client accepts only the exact worker unit and start/stop/show actions', async () => {
  const calls = [];
  const systemctl = createSystemctlClient({
    launcher: async (argv) => {
      calls.push(argv);
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  await expectCode(systemctl.start('not-a-uuid'), 'invalid_allocation');
  await expectCode(systemctl.stop(`${UUID_A}; reboot`), 'invalid_allocation');
  await systemctl.start(UUID_A);
  await systemctl.stop(UUID_A);
  assert.deepEqual(calls[0], ['start', unitFor(UUID_A)]);
  assert.deepEqual(calls[1], ['stop', unitFor(UUID_A)]);
  assert.equal(calls.length, 2);
});

// ---------------------------------------------------------------------------
// Launch boundary: trusted config, host prefetch, arm/recover/withEngine
// ---------------------------------------------------------------------------

test('launch boundary writes private atomic config and refuses unsafe existing files', async (t) => {
  const { boundary, root } = makeBoundary(t);
  const record = await boundary.provision(makeLaunch(root));
  const configPath = record.configPath;
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(record.homeDir).mode & 0o777, 0o700);
  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(parsed.allocationId, UUID_A);
  assert.equal(parsed.imageDigest, IMAGE_DIGEST);
  assert.equal(parsed.serviceUnit, `alpi-worker@${UUID_A}.service`);
  assert.equal(parsed.token.length, 64);

  // Re-provisioning the same identity reuses the token and file.
  const again = await boundary.provision(makeLaunch(root));
  assert.equal(again.token, record.token);

  fs.chmodSync(configPath, 0o644);
  await expectCode(boundary.provision(makeLaunch(root)), 'unsafe_config');

  fs.chmodSync(configPath, 0o600);
  fs.unlinkSync(configPath);
  const target = path.join(path.dirname(configPath), 'real.json');
  fs.writeFileSync(target, JSON.stringify(record), { mode: 0o600 });
  fs.chmodSync(target, 0o600);
  fs.symlinkSync(target, configPath);
  await expectCode(boundary.provision(makeLaunch(root)), 'unsafe_config');
});

test('launch boundary refuses unpinned images and missing SDK setup with a fixed diagnostic', async (t) => {
  const { boundary } = makeBoundary(t);
  await expectCode(
    boundary.provision(makeLaunch('', { image: 'ghcr.io/alpi/pi-dev:latest' })),
    'invalid_image'
  );
  await expectCode(
    boundary.provision(makeLaunch('', { imageDigest: `sha256:${'c'.repeat(64)}` })),
    'invalid_image'
  );

  const missing = createLaunchBoundary({
    stateRoot: makeTempDirectory(t),
    tunnelPort: 41001,
    ironIngressRoot: path.join(makeTempDirectory(t), 'iron'),
    sdkModulePath: '/nonexistent/alpi/boxlite.cjs',
    image: IMAGE,
    imageDigest: IMAGE_DIGEST,
    profile: PROFILE,
    uid: currentUid(),
    systemctl: makeSystemctl().client,
  });
  await expectCode(missing.provision(makeLaunch('')), 'worker_setup_missing');
  missing.close();
});

test('host prefetch pulls the pinned image only and starts no guest', async (t) => {
  const { boundary, root } = makeBoundary(t);
  const calls = { pull: 0, create: 0, start: 0, exec: 0 };
  const runtime = {
    images: {
      async get() { return { versions: calls.pull ? [{ digest: IMAGE_DIGEST }] : [] }; },
      async pull(reference) {
        calls.pull += 1;
        return { reference, configDigest: 'sha256:config', layerCount: 3 };
      },
    },
    async create() {
      calls.create += 1;
    },
    async start() {
      calls.start += 1;
    },
    async exec() {
      calls.exec += 1;
    },
  };
  const prefetchBoundary = createLaunchBoundary({
    stateRoot: root,
    tunnelPort: 41002,
    ironIngressRoot: path.join(root, 'iron'),
    sdkModulePath: makeSdkFile(root),
    image: IMAGE,
    imageDigest: IMAGE_DIGEST,
    profile: PROFILE,
    uid: currentUid(),
    systemctl: makeSystemctl().client,
    runtime,
  });
  t.after(() => prefetchBoundary.close());
  const result = await prefetchBoundary.prefetch(makeLaunch(root));
  assert.equal(result.pulled, true);
  assert.equal(calls.pull, 1);
  assert.equal(calls.create, 0);
  assert.equal(calls.start, 0);
  assert.equal(calls.exec, 0);
});

test('launch boundary keeps forwarding fenced until an explicit proof-backed arm', async (t) => {
  const setup = await setupWorker(t);
  const systemctl = makeSystemctl(UUID_A);
  const boundary = createLaunchBoundary({
    stateRoot: setup.root,
    tunnelPort: setup.tunnelPort,
    ironIngressRoot: setup.config.ironIngressRoot,
    sdkModulePath: setup.config.sdkModulePath,
    image: IMAGE,
    imageDigest: IMAGE_DIGEST,
    profile: PROFILE,
    uid: currentUid(),
    systemctl: systemctl.client,
    proc: setup.proc,
    net: setup.netEvidence,
    heartbeatIntervalMs: 500,
    proofMaxAgeMs: 5000,
    ownerHeartbeatTimeoutMs: 5000,
    startTimeoutMs: 3000,
    stopTimeoutMs: 3000,
    connectRetryMs: 50,
    connect: undefined,
  });
  t.after(() => boundary.close());
  // The worker is already listening; start the boundary client against it.
  const ready = await boundary.start(makeLaunch(setup.root));
  const created = await ready.client.engine.createBox({
    allocationId: UUID_A,
    launchGeneration: 1,
    profile: { network: 'boundary' },
  });
  const ref = {
    allocationId: UUID_A,
    launchGeneration: 1,
    name: `alpi-${UUID_A}-g1`,
    nativeId: created.nativeId,
  };
  await ready.client.engine.start(ref);

  const ironSocketPath = await startIronEchoServer(t, setup.config.ironIngressRoot);
  await expectCode(boundary.openIngress({ directory: path.dirname(ironSocketPath) }), 'forward_denied');
  await expectCode(
    boundary.arm({ ...makeLaunch(setup.root), nativeId: ref.nativeId, ironReady: false, callbackReady: true }),
    'forward_denied'
  );

  const armed = await boundary.arm({
    ...makeLaunch(setup.root),
    nativeId: ref.nativeId,
    ironReady: true,
    callbackReady: true,
  });
  assert.equal(armed.armed, true);
  const ingress = await boundary.openIngress({ directory: path.dirname(ironSocketPath) });
  const tcp = await connectTcp(ingress.port);
  tcp.write('arm');
  assert.equal(await readOnce(tcp), 'arm');
  await boundary.fence('test-fault');
  await onceClose(tcp);
});

test('recovery never auto-forwards while the worker service is inactive', async (t) => {
  const { boundary } = makeBoundary(t);
  const result = await boundary.recover(makeLaunch(''));
  assert.equal(result.forwarding, false);
  assert.equal(result.reason, 'worker-not-attached');
});

test('withEngine always fences and stops the exact unit in finally', async (t) => {
  const setup = await setupWorker(t);
  const systemctl = makeSystemctl(UUID_A);
  const boundary = createLaunchBoundary({
    stateRoot: setup.root,
    tunnelPort: setup.tunnelPort,
    ironIngressRoot: setup.config.ironIngressRoot,
    sdkModulePath: setup.config.sdkModulePath,
    image: IMAGE,
    imageDigest: IMAGE_DIGEST,
    profile: PROFILE,
    uid: currentUid(),
    systemctl: systemctl.client,
    proc: setup.proc,
    net: setup.netEvidence,
    heartbeatIntervalMs: 500,
    proofMaxAgeMs: 5000,
    ownerHeartbeatTimeoutMs: 5000,
    startTimeoutMs: 3000,
    stopTimeoutMs: 3000,
    connectRetryMs: 50,
  });
  t.after(() => boundary.close());
  let ran = false;
  await boundary.withEngine(
    makeLaunch(setup.root),
    async (engine) => {
      ran = true;
      assert.equal(typeof engine.createBox, 'function');
    },
    { skipPrefetch: true }
  );
  assert.equal(ran, true);
  assert.equal(systemctl.state.stopCalls, 1);
});

// ---------------------------------------------------------------------------
// Packaged systemd and polkit contracts
// ---------------------------------------------------------------------------

test('systemd template enforces nonroot isolated cgroup and no capabilities', () => {
  const unitPath = path.join(__dirname, '..', 'deploy', 'linux', 'alpi-worker@.service');
  const unit = fs.readFileSync(unitPath, 'utf8');
  assert.match(unit, /^User=alpi-server$/m);
  assert.match(unit, /^Group=alpi-server$/m);
  assert.match(unit, /^SupplementaryGroups=kvm$/m);
  assert.match(unit, /^PrivateNetwork=yes$/m);
  assert.match(unit, /^KillMode=control-group$/m);
  assert.match(unit, /^NoNewPrivileges=yes$/m);
  assert.match(unit, /^CapabilityBoundingSet=$/m);
  assert.match(unit, /^AmbientCapabilities=$/m);
  assert.match(unit, /^IPAddressDeny=any$/m);
  assert.match(unit, /^IPAddressAllow=127\.0\.0\.1\/32$/m);
  assert.match(unit, /^IPAddressAllow=::1\/128$/m);
  assert.match(unit, /^ProtectSystem=strict$/m);
  assert.match(unit, /^ProtectHome=yes$/m);
  assert.match(unit, /^RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK$/m);
  assert.match(unit, /^DeviceAllow=\/dev\/kvm rw$/m);
  assert.match(unit, /^ExecStart=.*engine-worker\.cjs --config %S\/alpi-server\/workers\/%i\/worker\.json$/m);
  assert.doesNotMatch(unit, /^\[Install\]/m);
  assert.doesNotMatch(unit, /\bsudo\b|\bpkexec\b|\bAmbientCapabilities=CAP_/);
});

test('polkit rule permits only start/stop of the exact UUID worker template', () => {
  const rulePath = path.join(__dirname, '..', 'deploy', 'linux', '50-alpi-worker.rules');
  const rule = fs.readFileSync(rulePath, 'utf8');
  assert.match(rule, /subject\.user !== "alpi-server"/);
  assert.match(rule, /verb !== "start" && verb !== "stop"/);
  assert.match(rule, /org\.freedesktop\.systemd1\.manage-units/);
  assert.match(
    rule,
    /\^alpi-worker@\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\\\.service\$/
  );
  assert.doesNotMatch(rule, /manage-unit-files/);
  assert.doesNotMatch(rule, /subject\.user !== "root"|subject\.user === "root"/);
});

test('strict systemctl client has no sudo, shell or generic command surface', async () => {
  const calls = [];
  const systemctl = createSystemctlClient({
    launcher: async (argv) => {
      calls.push(argv);
      return {
        code: 0,
        stdout: 'LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=123\nControlGroup=/system.slice/x\n',
        stderr: '',
      };
    },
  });
  const check = await systemctl.check(UUID_A);
  assert.equal(check.unit, unitFor(UUID_A));
  assert.deepEqual(calls[0], [
    'show',
    '--no-pager',
    '--property=LoadState,ActiveState,SubState,MainPID,ControlGroup',
    unitFor(UUID_A),
  ]);
  assert.equal(Object.keys(systemctl).length, 3);
});

test('generation expiry fences an established bridge and refuses a new open', async (t) => {
  const setup = await setupWorker(t, {
    config: { extra: { expiresAt: Date.now() + 250 } },
  });
  const { client } = await setupClient(t, setup);
  await client.start();
  const { bridge } = await openBridgeAfterStart(t, setup, client);
  const tcp = await connectTcp(bridge.port);
  tcp.write('expiring');
  assert.equal(await readOnce(tcp), 'expiring');
  await new Promise((resolve) => setTimeout(resolve, 400));
  await onceClose(tcp);
  await expectCode(client.openBridge(setup.config.ironIngressRoot + '/iron-ingress.sock'), 'generation_expired');
});

test('recovery on an active worker requires an explicit re-arm before ingress', async (t) => {
  const setup = await setupWorker(t);
  const systemctl = makeSystemctl(UUID_A);
  const boundary = createLaunchBoundary({
    stateRoot: setup.root,
    tunnelPort: setup.tunnelPort,
    ironIngressRoot: setup.config.ironIngressRoot,
    sdkModulePath: setup.config.sdkModulePath,
    image: IMAGE,
    imageDigest: IMAGE_DIGEST,
    profile: PROFILE,
    uid: currentUid(),
    systemctl: systemctl.client,
    proc: setup.proc,
    net: setup.netEvidence,
    heartbeatIntervalMs: 500,
    proofMaxAgeMs: 5000,
    ownerHeartbeatTimeoutMs: 5000,
    startTimeoutMs: 3000,
    stopTimeoutMs: 3000,
    connectRetryMs: 50,
  });
  t.after(() => boundary.close());
  const ready = await boundary.start(makeLaunch(setup.root));
  const created = await ready.client.engine.createBox({
    allocationId: UUID_A,
    launchGeneration: 1,
    profile: { network: 'boundary' },
  });
  const ref = {
    allocationId: UUID_A,
    launchGeneration: 1,
    name: `alpi-${UUID_A}-g1`,
    nativeId: created.nativeId,
  };
  await ready.client.engine.start(ref);
  const recovered = await boundary.recover({
    ...makeLaunch(setup.root),
    nativeId: ref.nativeId,
  });
  assert.equal(recovered.forwarding, false);
  assert.equal(recovered.reason, 'requires-explicit-arm');
  const ironSocketPath = await startIronEchoServer(t, setup.config.ironIngressRoot);
  await expectCode(boundary.openIngress({ directory: path.dirname(ironSocketPath) }), 'forward_denied');
  const armed = await boundary.arm({
    ...makeLaunch(setup.root),
    nativeId: ref.nativeId,
    ironReady: true,
    callbackReady: true,
  });
  assert.equal(armed.armed, true);
  const ingress = await boundary.openIngress({ directory: path.dirname(ironSocketPath) });
  const tcp = await connectTcp(ingress.port);
  tcp.write('recovered');
  assert.equal(await readOnce(tcp), 'recovered');
  await boundary.fence('test-end');
  await onceClose(tcp);
});

test('offline service profile uses a disabled BoxLite adapter and cannot open ingress', async t => {
  const adapter = makeAdapter();
  const create = adapter.createBox;
  let effectiveMode;
  adapter.createBox = spec => { effectiveMode = spec.profile.network; return create(spec); };
  const worker = await setupWorker(t, { adapter, config: { extra: { profile: { ...PROFILE, network: 'disabled' } } } });
  const { client } = await setupClient(t, worker);
  const ready = await client.start();
  assert.equal(ready.hello.networkMode, 'disabled');
  await expectCode(client.engine.createBox({ profile: { network: { mode: 'boundary' } } }), 'invalid_input');
  await client.engine.createBox({ profile: { network: { mode: 'disabled' } } });
  assert.equal(effectiveMode, 'disabled');
  await expectCode(client.openBridge(path.join(worker.config.ironIngressRoot, 'iron-ingress.sock')), 'forward_denied');
});

test('packaged polkit rule recognizes the headless daemon account', () => {
  const rule = fs.readFileSync(path.join(__dirname, '../deploy/linux/50-alpi-worker.rules'), 'utf8');
  let evaluate;
  require('node:vm').runInNewContext(rule, { polkit: { addRule(fn) { evaluate = fn; }, Result: { YES: true } } });
  const action = { id: 'org.freedesktop.systemd1.manage-units', lookup(key) { return { unit: unitFor(UUID_A), verb: 'start' }[key]; } };
  assert.equal(evaluate(action, { user: 'alpi-server', local: false, active: false }), true);
  assert.equal(evaluate(action, { user: 'test-operator' }), undefined);
});

test('cancelling a dispatched exec cancels the adapter and reports unverified termination', async t => {
  const adapter = makeAdapter();
  const entered = Promise.withResolvers();
  const cancelled = Promise.withResolvers();
  adapter.exec = async (ref, { signal }) => {
    signal.addEventListener('abort', () => cancelled.resolve(), { once: true });
    entered.resolve();
    await cancelled.promise;
    return { exitCode: 1 };
  };
  const worker = await setupWorker(t, { adapter });
  const { client } = await setupClient(t, worker);
  await client.start();
  const { allocationId, launchGeneration, name, nativeId } = await client.engine.createBox();
  const controller = new AbortController();
  const result = client.engine.exec({ allocationId, launchGeneration, name, nativeId }, {
    argv: ['echo', 'ok'], signal: controller.signal,
  });
  await entered.promise;
  controller.abort();
  await expectCode(result, 'engine_termination_unverified');
  await cancelled.promise;
});

test('worker uses the installed SDK package version and reports the actual adapter probe', async t => {
  for (const version of ['0.14.1', '0.14.0']) {
    const root = makeTempDirectory(t);
    const sdkModulePath = path.join(root, 'dist', 'index.mjs');
    fs.mkdirSync(path.dirname(sdkModulePath), { mode: 0o700 });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@boxlite-ai/boxlite', version }));
    fs.writeFileSync(sdkModulePath, `export class JsBoxlite {
      async listInfo() { return []; }
      getOrCreate() {} getInfo() {} get() {} remove() {} importBox() {} close() {}
    }`, { mode: 0o600 });
    const setup = await setupWorker(t, { root, sdkModulePath, config: {
      extra: { profile: { ...PROFILE, network: 'disabled' } },
    }, workerOptions: { adapter: undefined, getInfo: undefined } });
    const { client, systemctlState } = await setupClient(t, setup);
    assert.equal((await client.engine.probe()).available, false);
    await client.start();
    const actual = await client.engine.probe();
    assert.equal(actual.version, version);
    assert.equal(actual.available, version === '0.14.1');
    assert.equal(actual.capabilities.includes('create'), actual.available);
    assert.equal(actual.capabilities.includes('network-boundary'), false);
    systemctlState.active = false;
    assert.equal((await client.engine.probe()).available, false);
  }
});

test('fresh worker reattaches a retained running allocation before explicitly reopening ingress', async t => {
  const setup = await setupWorker(t, { workerOptions: { watchdogMs: 10 } });
  const { client } = await setupClient(t, setup, { clientOptions: { heartbeatIntervalMs: 20 } });
  const ref = { allocationId: UUID_A, launchGeneration: 1, name: `alpi-${UUID_A}-g1`, nativeId: 'native-1' };
  await setup.adapter.start(ref);
  await client.start();
  const status = await client.engine.status(ref);
  assert.ok(status.proof);
  assert.equal(status.bridge.open, false);
  const endpoint = await startIronEchoServer(t, setup.config.ironIngressRoot);
  await client.openBridge(endpoint);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(setup.worker.snapshot().bridge.open, true);
  await client.engine.stop(ref);
  await client.engine.start(ref);
  await client.openBridge(endpoint);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(setup.worker.snapshot().bridge.open, true);
});

test('scoped engine use surfaces an unconfirmed worker stop', async t => {
  const setup = await setupWorker(t);
  const unit = makeSystemctl();
  const systemctl = { ...unit.client, async stop() { throw new Error('unit stop unavailable'); } };
  const opts = { systemctl, proc: setup.proc, net: setup.netEvidence, tunnelPort: setup.tunnelPort };
  const { withEngine } = require('../src/network/worker-client.cjs');
  await assert.rejects(withEngine({
    ...opts, allocationId: UUID_A, launchGeneration: 1, token: setup.config.token,
    controlSocketPath: setup.config.controlSocketPath, serviceUid: currentUid(),
  }, async () => 'ok'), /unit stop unavailable/);
  const boundary = createLaunchBoundary({
    ...opts, stateRoot: setup.root, ironIngressRoot: setup.config.ironIngressRoot, sdkModulePath: setup.config.sdkModulePath,
    image: IMAGE, imageDigest: IMAGE_DIGEST, profile: PROFILE, uid: currentUid(),
  });
  t.after(() => boundary.close());
  await assert.rejects(boundary.withEngine(makeLaunch(setup.root), async () => 'ok', { skipPrefetch: true }),
    /unit stop unavailable/);
});

// ---------------------------------------------------------------------------
// Watchdog independence and control scheduling (worker-r1 findings B2 and B3)
// ---------------------------------------------------------------------------

test('a stalled evidence provider fences an established bridge within the proof freshness bound', async (t) => {
  const adapter = makeAdapter();
  const held = Promise.withResolvers();
  let stall = false;
  const setup = await setupWorker(t, {
    adapter,
    workerOptions: {
      getInfo: async (nativeId) => {
        if (stall) {
          return held.promise;
        }
        return adapter.getInfo(nativeId);
      },
      proofMaxAgeMs: 120,
      ownerHeartbeatTimeoutMs: 60_000,
      watchdogMs: 20,
    },
  });
  const { client } = await setupClient(t, setup, {
    clientOptions: { heartbeatIntervalMs: 60_000 },
  });
  await client.start();
  const { bridge } = await openBridgeAfterStart(t, setup, client);
  const tcp = await connectTcp(bridge.port);
  tcp.write('ping');
  assert.equal(await readOnce(tcp), 'ping');

  // The watchdog verifier hangs on the held SDK getInfo. Later watchdog ticks
  // must still enforce the proof freshness bound and fence the bridge; the
  // in-progress verifier must not be able to suppress the checks.
  stall = true;
  const stalledAt = Date.now();
  while (setup.worker.snapshot().bridge.open) {
    if (Date.now() - stalledAt > 1_000) {
      assert.fail('bridge was not fenced within the proof freshness bound');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const elapsed = Date.now() - stalledAt;
  assert.ok(elapsed < 1_000, `fencing took ${elapsed}ms`);
  assert.notEqual(setup.worker.snapshot().bridge.reason, null);
  await onceClose(tcp);
});

test('a long adapter exec does not expire owner heartbeats that keep arriving', async (t) => {
  const adapter = makeAdapter();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  adapter.exec = async () => {
    entered.resolve();
    await release.promise;
    return { exitCode: 0, stdout: 'ok', stderr: '', truncated: false, timedOut: false, cancelled: false };
  };
  const setup = await setupWorker(t, {
    adapter,
    workerOptions: { ownerHeartbeatTimeoutMs: 300, watchdogMs: 30 },
  });
  const { client } = await setupClient(t, setup, {
    clientOptions: { heartbeatIntervalMs: 60_000 },
  });
  await client.start();
  const { ref, bridge } = await openBridgeAfterStart(t, setup, client);
  const tcp = await connectTcp(bridge.port);
  tcp.write('ping');
  assert.equal(await readOnce(tcp), 'ping');

  const execPromise = client.engine.exec(ref, {
    argv: ['long-running', 'command'],
    timeoutMs: 30_000,
  });
  await entered.promise;
  let heartbeatCount = 0;
  const pump = setInterval(() => {
    client.heartbeatNow()
      .then(() => { heartbeatCount += 1; })
      .catch(() => {});
  }, 80);
  await new Promise((resolve) => setTimeout(resolve, 900));
  clearInterval(pump);
  assert.ok(heartbeatCount >= 5, `only ${heartbeatCount} heartbeats were processed`);
  assert.equal(setup.worker.snapshot().bridge.open, true);
  assert.equal(setup.worker.snapshot().bridge.reason, null);

  release.resolve();
  const execResult = await execPromise;
  assert.equal(execResult.exitCode, 0);
  tcp.write('pong');
  assert.equal(await readOnce(tcp), 'pong');
});

test('an explicit fence arriving during a long exec is applied promptly', async (t) => {
  const adapter = makeAdapter();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  adapter.exec = async () => {
    entered.resolve();
    await release.promise;
    return { exitCode: 0, stdout: 'ok', stderr: '', truncated: false, timedOut: false, cancelled: false };
  };
  const setup = await setupWorker(t, { adapter });
  const { client } = await setupClient(t, setup);
  await client.start();
  const { ref, bridge } = await openBridgeAfterStart(t, setup, client);
  const tcp = await connectTcp(bridge.port);
  tcp.write('ping');
  assert.equal(await readOnce(tcp), 'ping');

  const execPromise = client.engine.exec(ref, {
    argv: ['long-running', 'command'],
    timeoutMs: 30_000,
  });
  await entered.promise;
  // Do not await the fence response: with the repaired scheduling it arrives
  // while the exec is still pending; worker-side state proves promptness.
  const fencePromise = client.fence('fence-during-exec');
  const fenceStartedAt = Date.now();
  while (setup.worker.snapshot().bridge.open) {
    if (Date.now() - fenceStartedAt > 1_000) {
      assert.fail('fence was not applied within one second of receipt');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const fenceElapsed = Date.now() - fenceStartedAt;
  assert.ok(fenceElapsed < 1_000, `fence waited ${fenceElapsed}ms behind the long exec`);
  assert.equal(setup.worker.snapshot().bridge.open, false);
  assert.equal(setup.worker.snapshot().bridge.reason, 'fenced');
  await onceClose(tcp);

  release.resolve();
  const execResult = await execPromise;
  assert.equal(execResult.exitCode, 0);
  await fencePromise;
});

test('late watchdog verifier results are discarded after an epoch advance', async (t) => {
  const adapter = makeAdapter();
  const held = Promise.withResolvers();
  let stall = false;
  const setup = await setupWorker(t, {
    adapter,
    workerOptions: {
      getInfo: async (nativeId) => {
        if (stall) {
          return held.promise;
        }
        return adapter.getInfo(nativeId);
      },
      proofMaxAgeMs: 5_000,
      ownerHeartbeatTimeoutMs: 60_000,
      watchdogMs: 20,
    },
  });
  const { client } = await setupClient(t, setup, {
    clientOptions: { heartbeatIntervalMs: 60_000 },
  });
  await client.start();
  await openBridgeAfterStart(t, setup, client);
  const proofAtBeforeStall = setup.worker.snapshot().lastProofAt;

  // The next watchdog tick enters verifyOwnedShim and hangs on the held SDK
  // read (first tick lands within 20ms; 80ms guarantees it is in flight).
  stall = true;
  await new Promise((resolve) => setTimeout(resolve, 80));

  // Advance the fence epoch while the verifier is still in flight.
  await client.fence('epoch-advance');
  assert.equal(setup.worker.snapshot().bridge.open, false);

  // Release the stalled verifier; the late successful result must not
  // refresh the proof timestamp.
  stall = false;
  held.resolve(await adapter.getInfo('native-1'));
  await new Promise((resolve) => setTimeout(resolve, 120));

  const snapshot = setup.worker.snapshot();
  assert.equal(snapshot.lastProofAt, proofAtBeforeStall);
  assert.equal(snapshot.bridge.open, false);
});
