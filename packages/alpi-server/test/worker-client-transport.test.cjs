'use strict';

/**
 * NETNS-WORKER-1 client transport tests.
 *
 * Focused coverage for the host-side control transport:
 * - B5: per-connection handshake state, bounded reconnect, stale socket safety.
 * - B3: exec transport deadlines cover the per-command execution budget while
 *   other control requests keep the default bound.
 * - B6: chunked large-result transport with backpressure awareness and an
 *   explicit bounded-limit result, over a real Unix-domain socket.
 *
 * No privilege, no KVM, no VM, no network beyond loopback and UDS fixtures.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');

const { createEngineWorker } = require('../src/network/engine-worker.cjs');
const {
  createSystemctlClient,
  createWorkerClient,
  unitFor,
} = require('../src/network/worker-client.cjs');

const UUID_A = '11111111-1111-4111-8111-111111111111';
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
  const directory = fs.mkdtempSync('/tmp/alpi-wt-');
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
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
  return header + interfaces.map((name) => `  ${name}: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n`).join('');
}

function ipv4LoopbackRoute() {
  return (
    'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n' +
    'lo\t0000007F\t00000000\t0001\t0\t0\t0\t000000FF\t0\t0\t0\n'
  );
}

function ipv6LoopbackRoute() {
  return (
    '00000000000000000000000000000001 80 00000000000000000000000000000000 00 ' +
    '00000000000000000000000000000000 00000400 00000000 00000000 00000001 lo\n'
  );
}

function makeNetEvidence(options = {}) {
  const netnsInode = options.netnsInode ?? 4026532001;
  const interfaces = options.interfaces ?? ['lo'];
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
        return ipv4LoopbackRoute();
      }
      if (target.endsWith('/net/ipv6_route')) {
        return ipv6LoopbackRoute();
      }
      throw new Error(`unexpected readFile ${target}`);
    },
  });
}

function makeProcEvidence(options = {}) {
  const workerPid = options.workerPid ?? process.pid;
  const cgroup = options.cgroup ?? `/system.slice/alpi-worker@${UUID_A}.service`;
  const netnsInode = options.netnsInode ?? 4026532001;
  const uid = options.uid ?? currentUid();
  return {
    workerPid,
    cgroup,
    netnsInode,
    uid,
    async readlink(target) {
      if (target === `/proc/${workerPid}/ns/net`) {
        return `net:[${netnsInode}]`;
      }
      if (target === '/proc/self/ns/net') {
        return 'net:[4026531999]';
      }
      throw new Error(`unexpected readlink ${target}`);
    },
    async readFile(target) {
      if (target === `/sys/fs/cgroup${cgroup}/cgroup.events`) return 'populated 0\n';
      if (target === `/proc/${workerPid}/status`) {
        return `Name:\tboxlite-shim\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`;
      }
      if (target === `/proc/${workerPid}/cgroup` || target === '/proc/self/cgroup') {
        return `0::${cgroup}\n`;
      }
      throw new Error(`unexpected readFile ${target}`);
    },
  };
}

function makeInfo(pid, running = true, nativeId = 'native-1') {
  return {
    id: nativeId,
    name: `alpi-${UUID_A}-g1`,
    state: { status: running ? 'running' : 'stopped', running, pid },
    image: IMAGE,
    cpus: 2,
    memoryMib: 2048,
  };
}

function makeAdapter(options = {}) {
  const nativeId = options.nativeId ?? 'native-1';
  const name = `alpi-${UUID_A}-g1`;
  let running = false;
  let destroyed = false;
  const info = () => makeInfo(options.pid ?? process.pid + 1, running, nativeId);
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
      return { exitCode: 0, stdout: 'ok', stderr: '', truncated: false, timedOut: false, cancelled: false };
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
  const ironIngressRoot = path.join(root, 'iron');
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
    sdkModulePath: path.join(root, 'sdk.cjs'),
    profile: PROFILE,
    homeDir,
    controlSocketPath: path.join(allocationRoot, 'control.sock'),
    token: overrides.token ?? TOKEN,
    tunnelPort: overrides.tunnelPort,
    ironIngressRoot,
    createdAt: new Date().toISOString(),
    serviceUnit: `alpi-worker@${allocationId}.service`,
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

async function setupWorker(t, options = {}) {
  const root = makeTempDirectory(t);
  const tunnelPort = await freePort();
  const config = makeWorkerConfig(root, { tunnelPort, ...options.config });
  const configPath = path.join(root, 'workers', config.allocationId, 'worker.json');
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
  const proc = options.proc ?? makeProcEvidence();
  const netEvidence = options.net ?? makeNetEvidence();
  const adapter = options.adapter ?? makeAdapter();
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
  await worker.start();
  t.after(async () => {
    await worker.close().catch(() => {});
  });
  return { root, tunnelPort, config, configPath, proc, netEvidence, adapter, worker };
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

async function createOwnedRef(client) {
  const created = await client.engine.createBox({
    allocationId: UUID_A,
    launchGeneration: 1,
    profile: { network: 'boundary' },
  });
  return {
    allocationId: UUID_A,
    launchGeneration: 1,
    name: `alpi-${UUID_A}-g1`,
    nativeId: created.nativeId,
  };
}

// ---------------------------------------------------------------------------
// Malformed-peer fixture: a local fake control peer that can inject arbitrary
// response frames. Used only for protocol-failure regressions; the real
// worker never produces these frames.
// ---------------------------------------------------------------------------

const FAKE_HANDSHAKE_RESULT = {
  protocolVersion: 1,
  workerVersion: 1,
  networkMode: 'boundary',
  allocationId: UUID_A,
  launchGeneration: 1,
  pid: process.pid,
  uid: currentUid(),
  netnsInode: 4026532001,
  interfaces: ['lo'],
  tunnelPort: 41000,
};

async function startFakeWorker(t, respond) {
  const root = makeTempDirectory(t);
  const socketPath = path.join(root, 'fake-worker.sock');
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          socket.destroy();
          return;
        }
        if (message.op === 'hello') {
          socket.write(`${JSON.stringify({ id: null, ok: true, result: FAKE_HANDSHAKE_RESULT })}\n`);
          continue;
        }
        respond(message, socket);
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  fs.chmodSync(socketPath, 0o600);
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  return { server, socketPath };
}

async function setupFakeClient(t, socketPath) {
  const { client, state } = makeSystemctl(UUID_A);
  const clientApi = createWorkerClient({
    allocationId: UUID_A,
    launchGeneration: 1,
    controlSocketPath: socketPath,
    token: TOKEN,
    serviceUid: currentUid(),
    systemctl: client,
    proc: makeProcEvidence(),
    net: makeNetEvidence(),
    heartbeatIntervalMs: 60_000,
    startTimeoutMs: 3000,
    stopTimeoutMs: 3000,
    connectRetryMs: 50,
  });
  t.after(() => {
    try {
      clientApi.close();
    } catch {}
  });
  await clientApi.start();
  return { client: clientApi, systemctlState: state };
}

async function settleWithin(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), timeoutMs);
  });
  const outcome = await Promise.race([
    promise.then(
      (value) => ({ settled: true, value }),
      (error) => ({ settled: true, error })
    ),
    timeout,
  ]);
  clearTimeout(timer);
  return outcome;
}

// ---------------------------------------------------------------------------
// B5: connection lifecycle and handshake recovery
// ---------------------------------------------------------------------------

test('a client reconnects after a lost control connection and completes a fresh handshake', async (t) => {
  const setup = await setupWorker(t);
  const { client } = await setupClient(t, setup);
  const first = await client.start();
  assert.equal(first.hello.allocationId, UUID_A);
  const ref = await createOwnedRef(client);
  assert.equal((await client.engine.inspect(ref)).nativeId, 'native-1');

  // The unit stays active; only the control stream is lost.
  client.socket.destroy();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(client.connected, false);

  const second = await client.start();
  assert.equal(second.hello.allocationId, UUID_A);
  assert.equal(second.hello.pid, first.hello.pid);
  assert.equal(client.connected, true);
  assert.equal((await client.engine.inspect(ref)).nativeId, 'native-1');
});

test('a stale socket callback cannot clear a replacement connection', async (t) => {
  const setup = await setupWorker(t);
  const stale = new EventEmitter();
  stale.destroyed = false;
  stale.setEncoding = () => {};
  stale.setNoDelay = () => {};
  stale.write = () => true;
  stale.destroy = () => {
    stale.destroyed = true;
  };
  let attempt = 0;
  const { client } = await setupClient(t, setup, {
    clientOptions: {
      connect: (socketPath) => {
        attempt += 1;
        if (attempt === 1) {
          process.nextTick(() => {
            stale.emit('connect');
            // The post-connect handlers are registered on the following
            // microtask; a real socket error also arrives after them.
            setImmediate(() => stale.emit('error', new Error('simulated stale failure')));
          });
          return stale;
        }
        return net.connect({ path: socketPath });
      },
    },
  });
  await client.start();
  assert.ok(attempt >= 2, 'a replacement connection attempt was made');
  assert.equal(client.connected, true);

  // The superseded socket fires a late close; it must be ignored.
  stale.emit('close');
  assert.equal(client.connected, true);
  const ref = await createOwnedRef(client);
  assert.equal((await client.engine.inspect(ref)).nativeId, 'native-1');
});

test('a peer that connects but never completes hello fails within the start deadline and closes the attempt', async (t) => {
  const root = makeTempDirectory(t);
  const silentPath = path.join(root, 'silent.sock');
  const closed = Promise.withResolvers();
  const server = net.createServer((socket) => {
    socket.once('close', () => closed.resolve());
    socket.resume();
  });
  await new Promise((resolve) => server.listen(silentPath, resolve));
  fs.chmodSync(silentPath, 0o600);
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const setup = await setupWorker(t);
  const { client } = await setupClient(t, setup, {
    clientOptions: {
      controlSocketPath: silentPath,
      startTimeoutMs: 500,
      connectRetryMs: 50,
    },
  });
  const startedAt = Date.now();
  await expectCode(client.start(), 'worker_timeout');
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 5000, `start took ${elapsed}ms to fail; the hello wait is unbounded`);
  await closed.promise;
  assert.equal(client.connected, false);
});

// ---------------------------------------------------------------------------
// B3: exec transport deadlines vs control request deadlines
// ---------------------------------------------------------------------------

test('exec transport deadline covers the per-command budget while control requests stay bounded', async (t) => {
  const adapter = makeAdapter();
  adapter.exec = async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    return { exitCode: 0, stdout: 'slow-but-in-budget', stderr: '', truncated: false, timedOut: false, cancelled: false };
  };
  const setup = await setupWorker(t, { adapter });
  const { client } = await setupClient(t, setup, {
    clientOptions: { requestTimeoutMs: 100 },
  });
  await client.start();
  const ref = await createOwnedRef(client);

  // A 300-second accepted exec budget must not be clipped by the default
  // 60-second request deadline (here tightened to 100ms).
  const result = await client.engine.exec(ref, { argv: ['slow'], timeoutMs: 300_000 });
  assert.equal(result.stdout, 'slow-but-in-budget');

  // Non-exec control requests keep the tightened default deadline.
  adapter.inspect = () => new Promise(() => {});
  await expectCode(client.engine.inspect(ref), 'worker_timeout');
});

test('exec transport deadline still bounds timeoutMs plus cleanup when the adapter stalls', async (t) => {
  const adapter = makeAdapter();
  adapter.exec = (ref, { signal }) =>
    new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({ exitCode: 1 }), { once: true });
    });
  const setup = await setupWorker(t, { adapter });
  const { client } = await setupClient(t, setup, {
    clientOptions: { execCleanupGraceMs: 100 },
  });
  await client.start();
  const ref = await createOwnedRef(client);
  const startedAt = Date.now();
  await expectCode(
    client.engine.exec(ref, { argv: ['stalled'], timeoutMs: 200 }),
    'engine_termination_unverified'
  );
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 2000, `exec deadline took ${elapsed}ms`);
});

// ---------------------------------------------------------------------------
// B6: chunked large-result transport
// ---------------------------------------------------------------------------

test('small exec results stay ordinary single-frame responses', async (t) => {
  const setup = await setupWorker(t);
  const { client } = await setupClient(t, setup);
  await client.start();
  const ref = await createOwnedRef(client);
  const result = await client.engine.exec(ref, { argv: ['echo', 'hello'] });
  assert.equal(result.stdout, 'ok');
  assert.equal(result.chunked, undefined);
  assert.equal(client.connected, true);
});

test('short escaped exec output at the raw chunk threshold still recovers exactly and keeps the connection', async (t) => {
  const adapter = makeAdapter();
  // Both streams sit exactly at the 32 KiB raw threshold, but JSON escaping
  // of NUL bytes expands the encoded success frame far past the owner frame
  // bound. The framing decision must be made on encoded size.
  const stdout = '\u0000'.repeat(32 * 1024);
  const stderr = '\u0000'.repeat(32 * 1024);
  adapter.exec = async () => ({ exitCode: 0, stdout, stderr, truncated: false, timedOut: false, cancelled: false });
  const setup = await setupWorker(t, { adapter });
  const { client } = await setupClient(t, setup, {
    clientOptions: { heartbeatIntervalMs: 60_000 },
  });
  await client.start();
  const ref = await createOwnedRef(client);

  const result = await client.engine.exec(ref, { argv: ['nul'], timeoutMs: 30_000 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, stdout);
  assert.equal(result.stderr, stderr);
  assert.equal(client.connected, true, 'the owner connection survived the escaped result');
  assert.equal((await client.engine.inspect(ref)).nativeId, 'native-1');
});

test('escaped oversized exec results round-trip through ordered chunks without dropping the connection', async (t) => {
  const adapter = makeAdapter();
  // Quotes force JSON escaping that would blow the single-line frame bound,
  // and the emoji straddles a 32 KiB chunk boundary to prove UTF-8 reassembly.
  const stdout = '"'.repeat(200_000) + '\n\t\\' + '\u{1F600}'.repeat(64);
  const stderr = 'err-\u00e9\u00e8'.repeat(4_000);
  adapter.exec = async () => ({ exitCode: 3, stdout, stderr, truncated: false, timedOut: false, cancelled: false });
  const setup = await setupWorker(t, { adapter });
  const { client } = await setupClient(t, setup);
  await client.start();
  const ref = await createOwnedRef(client);

  const result = await client.engine.exec(ref, { argv: ['big'], timeoutMs: 30_000 });
  assert.equal(result.exitCode, 3);
  assert.equal(result.stdout, stdout);
  assert.equal(result.stderr, stderr);
  assert.equal(result.chunked, undefined, 'the reassembled result hides the wire detail');

  // The control connection survived the large result.
  assert.equal(client.connected, true);
  assert.equal((await client.engine.inspect(ref)).nativeId, 'native-1');
});

test('the maximum accepted exec output round-trips through chunks', async (t) => {
  const adapter = makeAdapter();
  const stdout = 'a'.repeat(8 * 1024 * 1024);
  // The exec output budget is aggregate across stdout and stderr (matching
  // the BoxLite collector's shared totalBytes budget), so the maximum
  // single-stream round-trip uses the entire budget on stdout.
  const stderr = '';
  adapter.exec = async () => ({ exitCode: 0, stdout, stderr, truncated: false, timedOut: false, cancelled: false });
  const setup = await setupWorker(t, { adapter });
  const { client } = await setupClient(t, setup, {
    clientOptions: { heartbeatIntervalMs: 60_000 },
  });
  await client.start();
  const ref = await createOwnedRef(client);
  const result = await client.engine.exec(ref, {
    argv: ['max'],
    timeoutMs: 30_000,
    maxOutputBytes: 8 * 1024 * 1024,
  });
  assert.equal(result.stdout, stdout);
  assert.equal(result.stderr, stderr);
  assert.equal(client.connected, true);
});

test('a blocked writer does not advance until the paused reader drains', async (t) => {
  const adapter = makeAdapter();
  // 8 MiB cannot fit in socket buffers, so a paused reader forces the
  // worker's chunked writer to block on real backpressure.
  const stdout = 'x'.repeat(8 * 1024 * 1024);
  adapter.exec = async () => ({ exitCode: 0, stdout, stderr: '', truncated: false, timedOut: false, cancelled: false });
  const setup = await setupWorker(t, { adapter });
  const { client } = await setupClient(t, setup, {
    clientOptions: { heartbeatIntervalMs: 60_000 },
  });
  await client.start();
  const ref = await createOwnedRef(client);

  // Pause the reader before dispatch so the writer actually blocks instead
  // of completing the transfer while the test is setting up a pause.
  client.socket.pause();
  let settled = false;
  const execPromise = client.engine.exec(ref, {
    argv: ['big'],
    timeoutMs: 30_000,
    maxOutputBytes: 8 * 1024 * 1024,
  }).then(
    (value) => {
      settled = true;
      return value;
    },
    (error) => {
      settled = true;
      throw error;
    }
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(settled, false, 'the exec completed while the reader was paused; no real backpressure was established');

  client.socket.resume();
  const result = await execPromise;
  assert.equal(result.stdout, stdout);
  assert.equal(client.connected, true);
});

test('a disconnect while the chunked writer is blocked settles the exec as unverified', async (t) => {
  const adapter = makeAdapter();
  const stdout = 'x'.repeat(8 * 1024 * 1024);
  adapter.exec = async () => ({ exitCode: 0, stdout, stderr: '', truncated: false, timedOut: false, cancelled: false });
  const setup = await setupWorker(t, { adapter });
  const { client } = await setupClient(t, setup, {
    clientOptions: { heartbeatIntervalMs: 60_000 },
  });
  await client.start();
  const ref = await createOwnedRef(client);

  client.socket.pause();
  const execPromise = client.engine.exec(ref, {
    argv: ['big'],
    timeoutMs: 30_000,
    maxOutputBytes: 8 * 1024 * 1024,
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(client.connected, true, 'the exec is still waiting behind the blocked writer');

  client.socket.destroy();
  await expectCode(execPromise, 'engine_termination_unverified');
});

test('the exec output budget is shared across stdout and stderr', async (t) => {
  const adapter = makeAdapter();
  const stdout = 'a'.repeat(6 * 1024 * 1024);
  const stderr = 'b'.repeat(3 * 1024 * 1024);
  adapter.exec = async (ref, spec) =>
    spec.argv[0] === 'mixed'
      ? { exitCode: 0, stdout, stderr, truncated: false, timedOut: false, cancelled: false }
      : { exitCode: 0, stdout: 'ok', stderr: '', truncated: false, timedOut: false, cancelled: false };
  const setup = await setupWorker(t, { adapter });
  const { client } = await setupClient(t, setup, {
    clientOptions: { heartbeatIntervalMs: 60_000 },
  });
  await client.start();
  const ref = await createOwnedRef(client);

  // 6 MiB + 3 MiB exceeds the shared 8 MiB budget even though each stream
  // stays within it individually.
  await expectCode(
    client.engine.exec(ref, {
      argv: ['mixed'],
      timeoutMs: 30_000,
      maxOutputBytes: 8 * 1024 * 1024,
    }),
    'output_limit_exceeded'
  );
  assert.equal(client.connected, true);
  const small = await client.engine.exec(ref, { argv: ['echo', 'hello'], timeoutMs: 30_000 });
  assert.equal(small.stdout, 'ok');
});

// ---------------------------------------------------------------------------
// Protocol failures on injected malformed chunked responses: every invalid
// terminator must settle the pending operation instead of hanging it.
// ---------------------------------------------------------------------------

test('an invalid chunked terminator settles the exec as an uncertain failure', async (t) => {
  const { socketPath } = await startFakeWorker(t, (message, socket) => {
    if (message.op !== 'exec') return;
    socket.write(`${JSON.stringify({
      id: message.id,
      part: 'stdout',
      seq: 0,
      data: Buffer.from('partial').toString('base64'),
    })}\n`);
    socket.write(`${JSON.stringify({ id: message.id, ok: true, result: null, chunked: true })}\n`);
  });
  const { client } = await setupFakeClient(t, socketPath);
  const ref = { allocationId: UUID_A, launchGeneration: 1, name: `alpi-${UUID_A}-g1`, nativeId: 'native-1' };

  const outcome = await settleWithin(
    client.engine.exec(ref, { argv: ['broken'], timeoutMs: 30_000 }),
    1000
  );
  assert.equal(outcome.settled, true, 'the exec promise must not hang on an invalid terminator');
  assert.equal(outcome.error.code, 'engine_termination_unverified');
  assert.equal(client.connected, false);
});

test('a chunked terminator on a request without stream state settles as a protocol failure', async (t) => {
  const { socketPath } = await startFakeWorker(t, (message, socket) => {
    if (message.op !== 'inspect') return;
    socket.write(`${JSON.stringify({
      id: message.id,
      ok: true,
      result: { nativeId: 'native-1' },
      chunked: true,
    })}\n`);
  });
  const { client } = await setupFakeClient(t, socketPath);
  const ref = { allocationId: UUID_A, launchGeneration: 1, name: `alpi-${UUID_A}-g1`, nativeId: 'native-1' };

  const outcome = await settleWithin(client.engine.inspect(ref), 1000);
  assert.equal(outcome.settled, true, 'the inspect promise must not hang on a spurious chunked terminator');
  assert.equal(outcome.error.code, 'worker_unavailable');
  assert.equal(client.connected, false);
});

test('a chunk sequence violation settles the exec and drops the connection', async (t) => {
  const { socketPath } = await startFakeWorker(t, (message, socket) => {
    if (message.op !== 'exec') return;
    socket.write(`${JSON.stringify({
      id: message.id,
      part: 'stdout',
      seq: 7,
      data: Buffer.from('out-of-order').toString('base64'),
    })}\n`);
  });
  const { client } = await setupFakeClient(t, socketPath);
  const ref = { allocationId: UUID_A, launchGeneration: 1, name: `alpi-${UUID_A}-g1`, nativeId: 'native-1' };

  const outcome = await settleWithin(
    client.engine.exec(ref, { argv: ['disordered'], timeoutMs: 30_000 }),
    1000
  );
  assert.equal(outcome.settled, true);
  assert.equal(outcome.error.code, 'engine_termination_unverified');
  assert.equal(client.connected, false);
});

test('a malformed chunk marker settles the exec and drops the connection', async (t) => {
  const { socketPath } = await startFakeWorker(t, (message, socket) => {
    if (message.op !== 'exec') return;
    socket.write(`${JSON.stringify({
      id: message.id,
      part: 'stdout',
      seq: 0,
      data: '%%%not-canonical-base64',
    })}\n`);
  });
  const { client } = await setupFakeClient(t, socketPath);
  const ref = { allocationId: UUID_A, launchGeneration: 1, name: `alpi-${UUID_A}-g1`, nativeId: 'native-1' };

  const outcome = await settleWithin(
    client.engine.exec(ref, { argv: ['garbled'], timeoutMs: 30_000 }),
    1000
  );
  assert.equal(outcome.settled, true);
  assert.equal(outcome.error.code, 'engine_termination_unverified');
  assert.equal(client.connected, false);
});

test('output beyond the encoded budget yields an explicit bounded-limit result and keeps the connection', async (t) => {
  const adapter = makeAdapter();
  const stdout = 'y'.repeat(200 * 1024);
  adapter.exec = async (ref, spec) =>
    spec.argv[0] === 'over'
      ? { exitCode: 0, stdout, stderr: '', truncated: false, timedOut: false, cancelled: false }
      : { exitCode: 0, stdout: 'ok', stderr: '', truncated: false, timedOut: false, cancelled: false };
  const setup = await setupWorker(t, { adapter });
  const { client } = await setupClient(t, setup, {
    clientOptions: { heartbeatIntervalMs: 60_000 },
  });
  await client.start();
  const ref = await createOwnedRef(client);

  await expectCode(
    client.engine.exec(ref, {
      argv: ['over'],
      timeoutMs: 30_000,
      maxOutputBytes: 16 * 1024,
    }),
    'output_limit_exceeded'
  );
  assert.equal(client.connected, true);
  assert.equal((await client.engine.inspect(ref)).nativeId, 'native-1');
  const small = await client.engine.exec(ref, { argv: ['echo', 'hello'], timeoutMs: 30_000 });
  assert.equal(small.stdout, 'ok');
});
