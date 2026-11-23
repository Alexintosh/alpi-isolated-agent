'use strict';

// boxes-real-t3 regression: the paired stdio MCP bridge advertises and serves
// the job workflow tools against the real packaged stack. The daemon runs with
// an explicitly allowed dev/test registry (the --allow-test-engines gate) and a
// disposable fixture workspace; the client pairs through the real CLI, and the
// exercised tools run inside the real bridge process over the pinned TLS
// transport.

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createInterface } = require('node:readline');
const { test } = require('node:test');

const { startServer } = require('../packages/alpi-server/src/daemon.cjs');
const { issuePairing } = require('../packages/alpi-server/src/admin-client.cjs');
const { createClient } = require('../packages/alpi-client/src/client.cjs');
const { openStore } = require('../packages/alpi-client/src/context.cjs');
const { createEngineRegistry } = require('../packages/alpi-server/src/engines/registry.cjs');
const { openHostResources } = require('../packages/alpi-server/src/host-resources.cjs');
const { openWorkStore } = require('../packages/alpi-server/src/work-store.cjs');

const PROJECT = 'mcp-job-project';
const CLIENT_BIN = path.resolve(__dirname, '../packages/alpi-client/bin/alpi.cjs');
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fixtureEngineAdapter() {
  const boxes = new Map();
  const destroyed = [];
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
    destroyed,
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
      destroyed.push({ nativeId: box.nativeId, allocationId: ref.allocationId });
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

async function runNode(args, env) {
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await once(child, 'close');
  return { code: code[0], stdout: Buffer.concat(stdout).toString('utf8'), stderr };
}

test('the paired MCP bridge serves the job workflow on an explicit test engine', async (t) => {
  const temp = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'alpi-job-mcp-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const stateDir = path.join(temp, 'state');
  const env = {
    ...process.env,
    ALPI_CONFIG_DIR: path.join(temp, 'contexts'),
    ALPI_CONTEXT_KEY_FILE: path.join(temp, 'context.key'),
  };
  await fs.writeFile(env.ALPI_CONTEXT_KEY_FILE, randomBytes(32), { mode: 0o600 });
  // The test process itself opens the persisted context store with the same
  // disposable environment the CLI children receive.
  process.env.ALPI_CONFIG_DIR = env.ALPI_CONFIG_DIR;
  process.env.ALPI_CONTEXT_KEY_FILE = env.ALPI_CONTEXT_KEY_FILE;

  const registry = createEngineRegistry({ allowTestAdapters: true });
  registry.install({ id: 'fixture', testOnly: true, factory: fixtureEngineAdapter });
  // A second selectable engine, so the identity-conflict path (sandbox
  // engine mismatch) is reachable past the registry gate.
  registry.install({ id: 'second', testOnly: true, factory: fixtureEngineAdapter });
  const server = await startServer({
    stateDir, port: 0, handleSignals: false,
    openResources: (options) => openHostResources({
      ...options,
      engines: registry,
      sandboxHost: {
        resolveProfile: fixtureProfileResolver(),
        withEngine: (_record, use) => use(fixtureEngineAdapter()),
      },
    }),
  });
  t.after(async () => { await server.close(); });

  const invite = await issuePairing({ stateDir, project: PROJECT, role: 'runner' });
  const invitePath = path.join(temp, 'invite.json');
  await fs.writeFile(invitePath, JSON.stringify(invite), { mode: 0o600 });
  const paired = await runNode(
    [CLIENT_BIN, 'pair', '--name', 'mcp-job', '--invite-file', invitePath], env);
  assert.equal(paired.code, 0, paired.stderr);
  assert.ok(!paired.stdout.includes(invite.invitation), 'the invitation is never echoed');

  // Setup outside the MCP surface: one disposable sandbox on the explicit
  // test engine, created through the same paired client library the bridge
  // uses, so the MCP flow below starts from a real sandbox.
  const store = openStore();
  try {
    const context = store.get('mcp-job');
    assert.ok(context, 'the paired context is persisted');
    const client = createClient(context);
    const sandbox = await client.requestResource('createSandbox', {}, {
      requestId: randomUUID(), engine: 'fixture', profile: 'dev',
    });
    assert.match(sandbox.sandboxId, UUID_PATTERN);

    // The real stdio bridge process, driven exactly like an MCP client would.
    const mcp = spawn(process.execPath, [CLIENT_BIN, 'mcp', '--context', 'mcp-job'],
      { env, stdio: ['pipe', 'pipe', 'ignore'] });
    t.after(() => { if (mcp.exitCode === null) mcp.kill('SIGKILL'); });
    const lines = createInterface({ input: mcp.stdout, crlfDelay: Infinity });
    const output = lines[Symbol.asyncIterator]();
    const send = (frame) => mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
    async function call(id, method, params) {
      send({ id, method, params });
      const line = await output.next();
      assert.equal(line.done, false, 'MCP closed before responding');
      const response = JSON.parse(line.value);
      assert.equal(response.id, id);
      assert.equal(response.jsonrpc, '2.0');
      return response;
    }
    const toolsCall = (id, name, args) =>
      call(id, 'tools/call', { name, arguments: args });

    const init = await call(1, 'initialize', {
      protocolVersion: '2025-06-18',
      clientInfo: { name: 'alpi-job-mcp-test', version: '1' }, capabilities: {},
    });
    assert.ok(init.result.capabilities.tools);
    send({ method: 'notifications/initialized' });

    const listing = await call(2, 'tools/list', {});
    const names = listing.result.tools.map((tool) => tool.name);
    for (const expected of ['alpi_capabilities', 'alpi_sandbox_list',
      'alpi_job_submit', 'alpi_job_get', 'alpi_job_events', 'alpi_job_lookup']) {
      assert.ok(names.includes(expected), expected + ' advertised');
    }

    const requestId = randomUUID();
    const submit = await toolsCall(3, 'alpi_job_submit', {
      sandboxId: sandbox.sandboxId, engine: 'fixture', requestId,
      payload: { prompt: 'patch the counter' },
    });
    assert.ok(!submit.result.isError, JSON.stringify(submit.result));
    const job = submit.result.structuredContent;
    assert.match(job.jobId, UUID_PATTERN);
    assert.equal(job.disposition, 'acknowledged');
    assert.match(job.workspaceId, UUID_PATTERN);
    assert.equal(job.project, PROJECT);

    // An idempotent replay with the same request key returns the same job.
    const replay = await toolsCall(4, 'alpi_job_submit', {
      sandboxId: sandbox.sandboxId, engine: 'fixture', requestId,
      payload: { prompt: 'patch the counter' },
    });
    assert.ok(!replay.result.isError, JSON.stringify(replay.result));
    assert.equal(replay.result.structuredContent.jobId, job.jobId);

    // Durability is checked through an independent store handle before any
    // reconnect: one job row, one admission receipt, one job.submitted event.
    const peer = openWorkStore(stateDir);
    try {
      const peerPrincipal = { project: PROJECT, clientId: 'peer-reader', role: 'runner' };
      const stored = peer.db.prepare(
        'SELECT * FROM jobs WHERE project = ? AND request_id = ?')
        .get(PROJECT, requestId);
      assert.ok(stored, 'the job row is durable in the independent store handle');
      assert.equal(stored.job_id, job.jobId);
      assert.equal(stored.disposition, 'acknowledged');
      assert.equal(peer.db.prepare(
        'SELECT COUNT(*) AS n FROM jobs WHERE request_id = ?').get(requestId).n, 1);
      assert.equal(peer.db.prepare(
        "SELECT COUNT(*) AS n FROM idempotency WHERE operation = 'submitJob' AND request_key = ?")
        .get(requestId).n, 1);
      const page = peer.pollJobEvents(peerPrincipal, { jobId: job.jobId, afterSeq: 0 });
      assert.deepEqual(page.events.map((event) => event.type), ['job.submitted']);
      assert.equal(peer.db.prepare(
        "SELECT COUNT(*) AS n FROM events WHERE job_id = ? AND type = 'job.submitted'")
        .get(job.jobId).n, 1);
      const sandboxRows = peer.db.prepare(
        'SELECT COUNT(*) AS n FROM sandboxes WHERE sandbox_id = ?')
        .get(sandbox.sandboxId).n;
      assert.equal(sandboxRows, 1);
    } finally {
      peer.close();
    }

    const got = await toolsCall(5, 'alpi_job_get', { jobId: job.jobId });
    assert.ok(!got.result.isError, JSON.stringify(got.result));
    assert.equal(got.result.structuredContent.jobId, job.jobId);

    const events = await toolsCall(6, 'alpi_job_events', { jobId: job.jobId, after: 0 });
    assert.ok(!events.result.isError, JSON.stringify(events.result));
    assert.equal(events.result.structuredContent.events[0].type, 'job.submitted');
    assert.equal(events.result.structuredContent.nextSeq, 1);

    const lookup = await toolsCall(7, 'alpi_job_lookup', { requestId });
    assert.ok(!lookup.result.isError, JSON.stringify(lookup.result));
    assert.equal(lookup.result.structuredContent.jobId, job.jobId);

    const mismatch = await toolsCall(8, 'alpi_job_submit', {
      sandboxId: sandbox.sandboxId, engine: 'second', requestId: randomUUID(),
    });
    assert.equal(mismatch.result.isError, true);
    assert.ok(mismatch.result.content[0].text.includes('engine_identity_conflict'),
      mismatch.result.content[0].text);

    mcp.stdin.end();
    await once(mcp, 'close');
  } finally {
    store.close();
  }
});

