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
      'alpi_job_submit', 'alpi_job_get', 'alpi_job_events', 'alpi_job_lookup', 'alpi_job_outputs']) {
      assert.ok(names.includes(expected), expected + ' advertised');
    }

    const empty = await toolsCall(20, 'alpi_job_outputs', { jobId: randomUUID() });
    assert.equal(empty.result.isError, true);
    assert.match(empty.result.content[0].text, /not_found/);

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


const fs = require('node:fs/promises');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { createScriptedFixtureJobs, SCRIPTED_FIXTURE_PROFILE } =
  require('../packages/alpi-server/src/engines/scripted-fixture.cjs');

async function scriptedSetup(t, gateTimeoutMs = 10000) {
  const fixture = await tempClientFixture(t, 'script-job');
  const workspace = path.join(fixture.root, 'workspace');
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, 'counter.js'), 'module.exports = () => 1;\n');
  await fs.writeFile(path.join(workspace, 'check.cjs'),
    "require('node:assert/strict').equal(require('./counter.js')(), 42);\n");
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture',
    '-c', 'user.email=fixture@example.invalid', ...args], { cwd: workspace, encoding: 'utf8' });
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'baseline');
  const registry = createEngineRegistry({ allowTestAdapters: true });
  const testJob = createScriptedFixtureJobs({ allowTestEngines: true, stateDir: fixture.stateDir,
    workspaceDir: workspace, baselineCommit: git('rev-parse', 'HEAD').trim(), gateTimeoutMs });
  registry.install({ id: 'fixture', testOnly: true, factory: fixtureEngineAdapter, testJob });
  const server = await startFixtureServer({ stateDir: fixture.stateDir, engines: registry });
  t.after(() => server.close());
  const invite = await issuePairing({ stateDir: fixture.stateDir, project: PROJECT, role: 'runner' });
  const paired = await pairWithCli(fixture, invite, 'scripted');
  assert.equal(paired.code, 0, paired.stderr);
  // Read the encrypted local context in a separate process with the fixture's
  // own env; no globals or repository source imports enter the bridge.
  const context = JSON.parse(execFileSync(process.execPath, ['-e',
    `console.log(JSON.stringify(require(${JSON.stringify(path.resolve(__dirname,
      '../packages/alpi-client/src/context.cjs'))}).openStore().get('scripted')))`],
    { env: fixture.clientEnv, encoding: 'utf8' }));
  const client = createClient(context);
  const sandbox = await client.requestResource('createSandbox', {}, {
    requestId: randomUUID(), engine: 'fixture', profile: SCRIPTED_FIXTURE_PROFILE,
  });
  const body = { requestId: randomUUID(), engine: 'fixture',
    payload: { scriptedProfile: SCRIPTED_FIXTURE_PROFILE } };
  const job = await client.requestResource('submitJob', { sandboxId: sandbox.sandboxId }, body);
  const markers = path.join(fixture.stateDir, 'scripted-fixture', job.jobId);
  async function waitMarker(phase) {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      try { return JSON.parse(await fs.readFile(path.join(markers, phase + '.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await delay(20);
    }
    throw Error('Missing fixture phase ' + phase);
  }
  return { ...fixture, workspace, client, sandbox, body, job, markers, waitMarker };
}

test('scripted submission starts before its gate and attaches its own patch once through MCP', async t => {
  const f = await scriptedSetup(t);
  const started = await f.waitMarker('started');
  const parked = await f.waitMarker('parked');
  assert.ok(Date.parse(started.at) <= Date.parse(parked.at));
  assert.equal(parked.editCount, 0);
  assert.equal(await fs.readFile(path.join(f.workspace, 'counter.js'), 'utf8'), 'module.exports = () => 1;\n');
  assert.equal((await f.client.requestResource('getJobArtifacts', { jobId: f.job.jobId })).count, 0);
  const before = await f.client.requestResource('getEvents', { jobId: f.job.jobId, after: '0' });
  assert.ok(before.events.some(event => event.untrustedText?.includes('parked')));
  const replay = await f.client.requestResource('submitJob', { sandboxId: f.sandbox.sandboxId }, f.body);
  assert.equal(replay.jobId, f.job.jobId);
  await fs.writeFile(path.join(f.markers, 'release'), 'release\n');
  await f.waitMarker('completed');
  const job = await f.client.requestResource('getJob', { jobId: f.job.jobId });
  assert.equal(job.disposition, 'completed');
  execFileSync(process.execPath, ['check.cjs'], { cwd: f.workspace });

  const bridge = spawn(process.execPath, [CLIENT_BIN, 'mcp', '--context', 'scripted'],
    { env: f.clientEnv, stdio: ['pipe', 'pipe', 'ignore'] });
  t.after(() => { if (bridge.exitCode === null) bridge.kill('SIGKILL'); });
  const lines = createInterface({ input: bridge.stdout })[Symbol.asyncIterator]();
  async function rpc(id, method, params) {
    bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    const response = JSON.parse((await lines.next()).value);
    assert.equal(response.id, id);
    return response.result;
  }
  await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {},
    clientInfo: { name: 'scripted-fixture', version: '1' } });
  const output = await rpc(2, 'tools/call', { name: 'alpi_job_outputs', arguments: { jobId: f.job.jobId } });
  assert.ok(!output.isError, JSON.stringify(output));
  const page = output.structuredContent;
  assert.equal(page.count, 1);
  assert.equal(page.truncated, false);
  const patch = page.artifacts[0];
  const bytes = Buffer.from(patch.data, 'base64');
  assert.equal(bytes.length, patch.totalLength);
  assert.match(bytes.toString(), /\+module.exports = \(\) => 42;/);
  const registration = { requestId: f.job.jobId, label: patch.label, totalLength: patch.totalLength,
    sha256: patch.sha256, data: patch.data };
  const second = await f.client.requestResource('registerJobOutput', { jobId: f.job.jobId }, registration);
  assert.equal(second.artifactId, patch.artifactId);
  await assert.rejects(f.client.requestResource('registerJobOutput', { jobId: f.job.jobId },
    { ...registration, sha256: '0'.repeat(64) }), error => error.resourceCode === 'conflict');
  await f.client.requestResource('submitJob', { sandboxId: f.sandbox.sandboxId }, f.body);
  assert.equal((await f.client.requestResource('getJobArtifacts', { jobId: f.job.jobId })).count, 1);
  const events = await f.client.requestResource('getEvents', { jobId: f.job.jobId, after: '0' });
  for (const phase of ['started', 'edited', 'attached', 'completed']) {
    assert.equal(events.events.filter(event => event.untrustedText &&
      JSON.parse(event.untrustedText).phase === phase).length, 1, phase + ' emitted once');
  }
  bridge.stdin.end();
  await once(bridge, 'close');
});

test('scripted gate timeout fails without editing or attaching output', async t => {
  const f = await scriptedSetup(t, 200);
  await f.waitMarker('parked');
  await f.waitMarker('failed');
  assert.equal((await f.client.requestResource('getJob', { jobId: f.job.jobId })).disposition, 'failed');
  assert.equal((await f.client.requestResource('getJobArtifacts', { jobId: f.job.jobId })).count, 0);
  assert.equal(await fs.readFile(path.join(f.workspace, 'counter.js'), 'utf8'), 'module.exports = () => 1;\n');
});
