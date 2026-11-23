'use strict';

// boxes-real-t3 regression: the paired stdio MCP bridge advertises and serves
// the job workflow tools against the real packaged stack. The daemon runs with
// an explicitly allowed dev/test registry (the --allow-test-engines gate) and a
// disposable fixture workspace; the client pairs through the real CLI, and the
// exercised tools run inside the real bridge process over the pinned TLS
// transport.

const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createInterface } = require('node:readline');
const { test } = require('node:test');

const {
  fixtureEngineAdapter, startFixtureServer, tempClientFixture, pairWithCli
} = require('./helpers/alpi-job-fixture.cjs');

const { issuePairing } = require('../packages/alpi-server/src/admin-client.cjs');
const { createClient } = require('../packages/alpi-client/src/client.cjs');
const { openStore } = require('../packages/alpi-client/src/context.cjs');
const { createEngineRegistry } = require('../packages/alpi-server/src/engines/registry.cjs');
const { openWorkStore } = require('../packages/alpi-server/src/work-store.cjs');

const PROJECT = 'mcp-job-project';
const CLIENT_BIN = path.resolve(__dirname, '../packages/alpi-client/bin/alpi.cjs');
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test('the paired MCP bridge serves the job workflow on an explicit test engine', async (t) => {
  const fixture = await tempClientFixture(t, 'alpi-job-mcp', { configName: 'contexts' });
  const { stateDir, clientEnv: env } = fixture;
  // The test process itself opens the persisted context store with the same
  // disposable environment the CLI children receive.
  process.env.ALPI_CONFIG_DIR = env.ALPI_CONFIG_DIR;
  process.env.ALPI_CONTEXT_KEY_FILE = env.ALPI_CONTEXT_KEY_FILE;

  const registry = createEngineRegistry({ allowTestAdapters: true });
  registry.install({ id: 'fixture', testOnly: true, factory: fixtureEngineAdapter });
  // A second selectable engine, so the identity-conflict path (sandbox
  // engine mismatch) is reachable past the registry gate.
  registry.install({ id: 'second', testOnly: true, factory: fixtureEngineAdapter });
  const server = await startFixtureServer({
    stateDir,
    engines: registry,
    withEngine: (_record, use) => use(fixtureEngineAdapter({ trackDestroyed: true })),
  });
  t.after(async () => { await server.close(); });

  const invite = await issuePairing({ stateDir, project: PROJECT, role: 'runner' });
  const paired = await pairWithCli(fixture, invite, 'mcp-job', {
    invitationFile: 'invite.json', timeoutMs: 0,
  });
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

    // A second durable event, appended through the real store, gives the
    // events read a page-boundary continuation to prove: with limit below
    // the page, the first read must resume at the last returned event so
    // the appended event is observed instead of silently skipped.
    const writer = openWorkStore(stateDir);
    try {
      writer.appendEvent(
        { project: PROJECT, clientId: 'peer-writer', role: 'runner' },
        { type: 'job.log', jobId: job.jobId, data: { text: 'continuation marker' } },
      );
    } finally {
      writer.close();
    }

    const paged = await toolsCall(9, 'alpi_job_events',
      { jobId: job.jobId, after: 0, limit: 1 });
    assert.ok(!paged.result.isError, JSON.stringify(paged.result));
    assert.deepEqual(
      paged.result.structuredContent.events.map((event) => event.type),
      ['job.submitted'],
    );
    assert.equal(paged.result.structuredContent.nextSeq, 1);

    const continued = await toolsCall(10, 'alpi_job_events',
      { jobId: job.jobId, after: paged.result.structuredContent.nextSeq, limit: 1 });
    assert.ok(!continued.result.isError, JSON.stringify(continued.result));
    assert.deepEqual(
      continued.result.structuredContent.events.map((event) => event.type),
      ['job.log'],
    );
    assert.equal(continued.result.structuredContent.nextSeq, 2);

    const drained = await toolsCall(11, 'alpi_job_events',
      { jobId: job.jobId, after: continued.result.structuredContent.nextSeq, limit: 1 });
    assert.ok(!drained.result.isError, JSON.stringify(drained.result));
    assert.deepEqual(drained.result.structuredContent.events, []);
    assert.equal(drained.result.structuredContent.nextSeq, 2);

    // Uppercase UUIDs are valid to the server routes; the bridge must accept
    // them too instead of failing closed with a local argument error. The
    // not-found verdict proves the request crossed local validation.
    const upperGet = await toolsCall(12, 'alpi_job_get', {
      jobId: 'ABCDEFAB-CDEF-ABCD-EFAB-CDEFABCDEFAB',
    });
    assert.equal(upperGet.result.isError, true);
    assert.ok(upperGet.result.content[0].text.includes('not_found'),
      upperGet.result.content[0].text);

    mcp.stdin.end();
    await once(mcp, 'close');
  } finally {
    store.close();
  }
});

