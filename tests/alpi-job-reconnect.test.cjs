'use strict';

// boxes-job-reconnect regression: a dropped client connection during active
// work is recoverable through the packaged stack.
//
// Covers, through the packaged HTTPS API and the paired alpi-client library
// (the same stack the MCP bridge and CLI use), with every reconnecting side
// running as a brand-new OS process that loads the persisted pairing
// context the packaged CLI wrote:
// - an abrupt connection loss at the acknowledgement boundary: the admission
//   committed, the receipt never reached the client, and a fresh process
//   reattaching with the persisted credential converges on the same job and
//   workspace through BOTH reconnect mechanisms — replaying the exact
//   submission (the store's duplicate-admission branch) and the explicit
//   request-key lookup (lookupJob);
// - restart survival: a full server restart between the drop and the
//   reattach still converges on the same persisted receipt;
// - the ambiguous mid-flight case where the drop may land before the server
//   has even read the request: the replay converges either way;
// - zero second side effects, asserted as store counts: exactly one job row,
//   one job.submitted event, one idempotency receipt, one workspace and one
//   enrolled client, and a request-key replay with a different payload is
//   refused as idempotency_conflict instead of charging a second receipt;
// - the request-key lookup is observer-safe: it is scoped to the caller's
//   own (project, clientId, requestId) key, so no other client's credential
//   can resolve the job.

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { spawn } = require('node:child_process');

const { startServer } = require('../packages/alpi-server/src/daemon.cjs');
const { issuePairing, listClients } = require('../packages/alpi-server/src/admin-client.cjs');
const { createClient } = require('../packages/alpi-client/src/client.cjs');
const { openStore } = require('../packages/alpi-client/src/context.cjs');
const { openWorkStore } = require('../packages/alpi-server/src/work-store.cjs');
const { createEngineRegistry } = require('../packages/alpi-server/src/engines/registry.cjs');
const { openHostResources } = require('../packages/alpi-server/src/host-resources.cjs');

const CLIENT_BIN = path.join(__dirname, '..', 'packages', 'alpi-client', 'bin', 'alpi.cjs');
const RECONNECT_CLIENT = path.join(__dirname, 'helpers', 'alpi-reconnect-client.cjs');
const PROJECT = 'test-project';
const CONTEXT_NAME = 'reconnect-runner';
const OBSERVER_CONTEXT_NAME = 'reconnect-observer';
const SEVER_CODES = ['CONNECTION_CLOSED', 'CONNECTION_ERROR'];

function fixtureEngineAdapter() {
  const boxes = new Map();
  let counter = 0;
  const info = (box) => ({
    allocationId: box.allocationId,
    launchGeneration: box.launchGeneration,
    name: box.name,
    nativeId: box.nativeId,
    state: box.running ? 'running' : 'stopped',
    running: box.running,
  });
  const adapter = {
    boxFor(ref) {
      const box = boxes.get(`${ref.allocationId}:${ref.launchGeneration}`);
      if (!box) throw { code: 'engine_box_missing', message: 'missing box' };
      return box;
    },
    async createBox(spec) {
      const key = `${spec.allocationId}:${spec.launchGeneration}`;
      let box = boxes.get(key);
      const created = !box;
      if (!box) {
        box = {
          allocationId: spec.allocationId,
          launchGeneration: spec.launchGeneration,
          name: `alpi-${spec.allocationId}-g${spec.launchGeneration}`,
          nativeId: `native-${++counter}`,
          running: false,
        };
        boxes.set(key, box);
      }
      return { allocationId: box.allocationId, launchGeneration: box.launchGeneration,
        name: box.name, nativeId: box.nativeId, created };
    },
    async inspect(ref) { return info(adapter.boxFor(ref)); },
    async start(ref) { adapter.boxFor(ref).running = true; return adapter.inspect(ref); },
    async stop(ref) { adapter.boxFor(ref).running = false; return adapter.inspect(ref); },
    async destroy(ref) {
      const box = adapter.boxFor(ref);
      boxes.delete(`${ref.allocationId}:${ref.launchGeneration}`);
      return { destroyed: true, alreadyGone: false, allocationId: ref.allocationId,
        launchGeneration: ref.launchGeneration, name: ref.name, nativeId: box.nativeId };
    },
    async listOwned() { return [...boxes.values()].map(info); },
    async exec() {
      return { exitCode: 0, stdout: 'ok', stderr: '', truncated: false,
        timedOut: false, cancelled: false, executionId: 'exec-1' };
    },
    async probe() {
      return { available: true, version: '0.14.1',
        capabilities: ['create', 'inspect', 'start', 'stop', 'destroy',
          'list-owned', 'exec', 'pty'] };
    },
    async close() {},
  };
  return adapter;
}

function fixtureProfileResolver() {
  return async ({ engine, profile }) => ({
    engine,
    profile,
    qualified: true,
    available: true,
    engineVersion: '0.14.1',
    imageDigest: 'sha256:' + 'a'.repeat(64),
    limits: { vcpus: 2, memoryMiB: 2048, diskMiB: 10240 },
    networkMode: 'disabled',
    capabilities: ['create', 'inspect', 'start', 'stop', 'destroy',
      'list-owned', 'exec', 'pty'],
  });
}

function devTestRegistry() {
  const registry = createEngineRegistry({ allowTestAdapters: true });
  registry.install({ id: 'fixture', testOnly: true, factory: async () => fixtureEngineAdapter() });
  return registry;
}

async function tempFixture(t, label) {
  const parent = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), `${label}-`));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  // The layout stays flat: the daemon refuses state directories whose
  // administration socket path would exceed 100 bytes, and the macOS temp
  // root is already long.
  const stateDir = path.join(parent, 'state');
  const configDir = path.join(parent, 'config');
  const keyFile = path.join(parent, 'context.key');
  const receiptFile = path.join(parent, 'job-receipt.json');
  // The context key lives outside the config directory, exactly as the
  // packaged CLI requires; the state and config directories are created by
  // the server and the client store with their private modes.
  await fs.writeFile(keyFile, randomBytes(32), { mode: 0o600 });
  return {
    root: parent,
    stateDir,
    configDir,
    keyFile,
    receiptFile,
    clientEnv: {
      ...process.env,
      ALPI_CONFIG_DIR: configDir,
      ALPI_CONTEXT_KEY_FILE: keyFile,
    },
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function runNode(args, env, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function lastJsonLine(stdout) {
  const lines = stdout.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

async function pairPersistedContext(t, fixture, invite, name) {
  const invitePath = path.join(fixture.root, `invite-${name}.json`);
  await fs.writeFile(invitePath, JSON.stringify(invite), { mode: 0o600 });
  const result = await runNode(
    [CLIENT_BIN, 'pair', '--name', name, '--invite-file', invitePath],
    fixture.clientEnv,
  );
  assert.equal(result.code, 0, `pairing ${name} exited ${result.code}: ${result.stderr}`);
}

async function runReconnectClient(t, mode, fixture, { contextName = CONTEXT_NAME, extra = [] } = {}) {
  const result = await runNode(
    [RECONNECT_CLIENT, mode, contextName, fixture.receiptFile, ...extra],
    fixture.clientEnv,
  );
  assert.equal(
    result.code,
    0,
    `reconnect client ${mode} exited ${result.code}: ${result.stderr} | stdout: ${result.stdout}`,
  );
  const report = lastJsonLine(result.stdout);
  assert.equal(report.ok, true, `reconnect client ${mode} failed: ${result.stdout}`);
  return report;
}

// Store-level audit of the reconnect invariants. Public store reads count
// the job rows, the submitted events and the workspaces; the idempotency
// receipt count reads the admission table directly (the same white-box
// count the work-store tests use).
function storeAudit(peer, principal, jobId, requestId) {
  const jobs = peer.listJobs(principal);
  const submittedEvents = peer.pollEvents(principal, { afterSeq: 0 }).events
    .filter((event) => event.type === 'job.submitted');
  return {
    totalJobs: jobs.length,
    jobRows: peer.db
      .prepare('SELECT COUNT(*) AS n FROM jobs WHERE project = ? AND request_id = ?')
      .get(principal.project, requestId).n,
    receipts: peer.db
      .prepare(
        `SELECT COUNT(*) AS n FROM idempotency
          WHERE project = ? AND operation = 'submitJob' AND request_key = ?`
      )
      .get(principal.project, requestId).n,
    submittedEvents: submittedEvents.length,
    submittedRows: peer.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE job_id = ? AND type = 'job.submitted'")
      .get(jobId).n,
    sandboxes: peer.listSandboxes(principal).length,
  };
}

function expectSingleSideEffect(counts, jobId, requestId) {
  assert.equal(counts.totalJobs, 1);
  assert.equal(counts.jobRows, 1);
  assert.equal(counts.receipts, 1);
  assert.equal(counts.submittedEvents, 1);
  assert.equal(counts.submittedRows, 1);
  assert.equal(counts.sandboxes, 1);
  assert.match(jobId, /^[0-9a-f-]{36}$/);
  assert.equal(typeof requestId, 'string');
}

test('a fresh client process reattaches with the persisted credential and reaches the same job and workspace', async (t) => {
  const fixture = await tempFixture(t, 'jr-ack');
  const engine = fixtureEngineAdapter();
  const port = await freePort();
  const open = () => startServer({
    stateDir: fixture.stateDir,
    port,
    handleSignals: false,
    openResources: (options) => openHostResources({
      ...options,
      engines: devTestRegistry(),
      sandboxHost: {
        resolveProfile: fixtureProfileResolver(),
        withEngine: (_record, use) => use(engine),
      },
    }),
  });
  const server = await open();
  t.after(async () => { await server.close(); });

  const invite = await issuePairing({ stateDir: fixture.stateDir, project: PROJECT, role: 'runner' });
  await pairPersistedContext(t, fixture, invite, CONTEXT_NAME);

  // Submit, then sever the client connection abruptly at the acknowledgement
  // boundary: the request was processed, the admission committed, and the
  // client process died without ever holding the job receipt.
  const severed = await runReconnectClient(t, 'sever-submit', fixture, { extra: ['on-response'] });
  assert.ok(SEVER_CODES.includes(severed.severedCode), `unexpected sever code ${severed.severedCode}`);

  const receipt = JSON.parse(await fs.readFile(fixture.receiptFile, 'utf8'));
  assert.equal(receipt.engine, 'fixture');
  const audit = { project: PROJECT, clientId: 'audit-peer', role: 'runner' };
  const peer = openWorkStore(fixture.stateDir);
  try {
    // The severed submission committed exactly one admission before the
    // receipt was lost.
    assert.equal(storeAudit(peer, audit, null, receipt.submission.requestId).jobRows, 1);

    // A brand-new client process/transport reattaches with the persisted
    // pairing credential: it replays the exact submission and additionally
    // resolves the job explicitly by its request key. Both reconnect
    // mechanisms must reach the same persisted receipt.
    const reconnected = await runReconnectClient(t, 'reconnect', fixture);
    const { replay, lookup, events, clientId } = reconnected;
    assert.equal(typeof replay.jobId, 'string');
    assert.equal(lookup.jobId, replay.jobId);
    assert.equal(lookup.workspaceId, replay.workspaceId);
    assert.equal(lookup.sessionUuid, replay.sessionUuid);
    assert.equal(lookup.disposition, 'acknowledged');
    // The same workspace the dropped submission ran against: no second
    // workspace was ever provisioned.
    assert.equal(lookup.workspaceId, receipt.workspaceId);
    // The resolved job is the admission of the persisted request key.
    const jobRow = peer.listJobs(audit).find((job) => job.jobId === lookup.jobId);
    assert.equal(jobRow.requestId, receipt.submission.requestId);

    // The packaged event stream shows exactly one job.submitted event.
    assert.equal(events.events.filter((event) => event.type === 'job.submitted').length, 1);
    assert.ok(events.events.every((event) => event.jobId === lookup.jobId));

    // Store counts: one job row, one submitted event, one idempotency
    // receipt, one workspace.
    const counts = storeAudit(peer, audit, lookup.jobId, receipt.submission.requestId);
    expectSingleSideEffect(counts, lookup.jobId, receipt.submission.requestId);
    const [workspace] = peer.listSandboxes(audit);
    assert.equal(workspace.workspaceId, receipt.workspaceId);

    // The reconnect reattached with the persisted credential: no second
    // client was ever enrolled.
    const clients = await listClients({ stateDir: fixture.stateDir });
    assert.equal(clients.clients.length, 1);
    assert.equal(clients.clients[0].clientId, clientId);

    // The idempotency receipt was not double-charged: the same request key
    // with a different payload still resolves to the original receipt, as a
    // conflict, through an independent reattach of the same credential.
    const contextStore = openStore({ configDir: fixture.configDir, keyFile: fixture.keyFile });
    try {
      const context = contextStore.get(CONTEXT_NAME);
      const client = createClient(context);
      await assert.rejects(
        client.requestResource(
          'submitJob',
          { sandboxId: receipt.sandboxId },
          { ...receipt.submission, payload: { prompt: 'different' } },
        ),
        { code: 'HTTP_STATUS', statusCode: 409, resourceCode: 'idempotency_conflict' },
      );
    } finally {
      contextStore.close();
    }
    // The refused replay changed nothing.
    assert.deepEqual(storeAudit(peer, audit, lookup.jobId, receipt.submission.requestId), counts);

    // The request-key lookup is observer-safe: a different client's
    // credential can never resolve the job by this request key.
    const observerInvite = await issuePairing({ stateDir: fixture.stateDir, project: PROJECT, role: 'observer' });
    await pairPersistedContext(t, fixture, observerInvite, OBSERVER_CONTEXT_NAME);
    const intruder = await runReconnectClient(t, 'lookup-expect-missing', fixture, { contextName: OBSERVER_CONTEXT_NAME });
    assert.notEqual(intruder.clientId, clientId);
    assert.equal(intruder.errorCode, 'not_found');
  } finally {
    peer.close();
  }
});

test('the reconnect converges after a server restart between the drop and the reattach', async (t) => {
  const fixture = await tempFixture(t, 'jr-restart');
  const engine = fixtureEngineAdapter();
  // The fixed port keeps the persisted origin valid across the restart, as
  // it would be for the packaged daemon's default port.
  const port = await freePort();
  const open = () => startServer({
    stateDir: fixture.stateDir,
    port,
    handleSignals: false,
    openResources: (options) => openHostResources({
      ...options,
      engines: devTestRegistry(),
      sandboxHost: {
        resolveProfile: fixtureProfileResolver(),
        withEngine: (_record, use) => use(engine),
      },
    }),
  });
  let server = await open();
  t.after(async () => { if (server) await server.close(); });

  const invite = await issuePairing({ stateDir: fixture.stateDir, project: PROJECT, role: 'runner' });
  await pairPersistedContext(t, fixture, invite, CONTEXT_NAME);

  const severed = await runReconnectClient(t, 'sever-submit', fixture, { extra: ['on-response'] });
  assert.ok(SEVER_CODES.includes(severed.severedCode), `unexpected sever code ${severed.severedCode}`);
  const receipt = JSON.parse(await fs.readFile(fixture.receiptFile, 'utf8'));

  // Full server restart on the same state directory between the drop and
  // the reattach.
  await server.close();
  server = await open();

  const audit = { project: PROJECT, clientId: 'audit-peer', role: 'runner' };
  const peer = openWorkStore(fixture.stateDir);
  try {
    // The persisted request key alone resolves the job after the restart.
    const resolved = await runReconnectClient(t, 'lookup-only', fixture);
    assert.equal(resolved.lookup.disposition, 'acknowledged');
    assert.equal(resolved.lookup.workspaceId, receipt.workspaceId);

    // A full replay through the duplicate-admission branch reaches the same
    // receipt after the restart.
    const reconnected = await runReconnectClient(t, 'reconnect', fixture);
    assert.equal(reconnected.replay.jobId, resolved.lookup.jobId);
    assert.equal(reconnected.lookup.jobId, resolved.lookup.jobId);
    assert.equal(reconnected.lookup.sessionUuid, resolved.lookup.sessionUuid);
    assert.equal(reconnected.lookup.workspaceId, receipt.workspaceId);

    expectSingleSideEffect(
      storeAudit(peer, audit, resolved.lookup.jobId, receipt.submission.requestId),
      resolved.lookup.jobId,
      receipt.submission.requestId,
    );
  } finally {
    peer.close();
  }
});

test('a drop that may land before the server reads the request still converges on replay', async (t) => {
  const fixture = await tempFixture(t, 'jr-mid');
  const engine = fixtureEngineAdapter();
  const port = await freePort();
  const server = await startServer({
    stateDir: fixture.stateDir,
    port,
    handleSignals: false,
    openResources: (options) => openHostResources({
      ...options,
      engines: devTestRegistry(),
      sandboxHost: {
        resolveProfile: fixtureProfileResolver(),
        withEngine: (_record, use) => use(engine),
      },
    }),
  });
  t.after(async () => { await server.close(); });

  const invite = await issuePairing({ stateDir: fixture.stateDir, project: PROJECT, role: 'runner' });
  await pairPersistedContext(t, fixture, invite, CONTEXT_NAME);

  // This sever lands right after the request bytes were written, so whether
  // the admission committed before the drop is unknowable from the client.
  const severed = await runReconnectClient(t, 'sever-submit', fixture, { extra: ['after-request'] });
  assert.ok(SEVER_CODES.includes(severed.severedCode), `unexpected sever code ${severed.severedCode}`);
  const receipt = JSON.parse(await fs.readFile(fixture.receiptFile, 'utf8'));

  // The replay must converge either way: a committed severed submission
  // resolves as a duplicate admission, a lost one is admitted exactly once.
  const reconnected = await runReconnectClient(t, 'reconnect', fixture);
  assert.equal(reconnected.lookup.jobId, reconnected.replay.jobId);
  assert.equal(reconnected.lookup.workspaceId, receipt.workspaceId);
  assert.equal(reconnected.lookup.disposition, 'acknowledged');
  assert.equal(
    reconnected.events.events.filter((event) => event.type === 'job.submitted').length,
    1,
  );

  const audit = { project: PROJECT, clientId: 'audit-peer', role: 'runner' };
  const peer = openWorkStore(fixture.stateDir);
  try {
    expectSingleSideEffect(
      storeAudit(peer, audit, reconnected.lookup.jobId, receipt.submission.requestId),
      reconnected.lookup.jobId,
      receipt.submission.requestId,
    );
  } finally {
    peer.close();
  }
});
