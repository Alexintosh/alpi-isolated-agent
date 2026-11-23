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
//   can resolve the job;
// - the same request key presented by a different PROJECT's enrolled
//   credential gets not_found, and resubmission under that credential's own
//   (project, client, key) admits an independent job: request keys are
//   namespaced by principal, never global;
// - the lookup body carries exactly its declared keys: an extra or missing
//   field is invalid_input, never a silent ignore that could be mistaken
//   for a missing job;
// - two concurrent FIRST-TIME submissions with the same key through the
//   packaged HTTP stack (two fresh client processes, no coordination)
//   converge on the same jobId with exactly one job row, one job.submitted
//   event and one idempotency receipt;
// - the ack-boundary proof's transport assumption is pinned: at the moment
//   the first response byte arrives (the sever point), an independent store
//   connection in the dying client process already sees the committed
//   admission.

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');

const {
  fixtureEngineAdapter, startFixtureServer, tempClientFixture, runNode, pairWithCli
} = require('./helpers/alpi-job-fixture.cjs');

const { issuePairing, listClients } = require('../packages/alpi-server/src/admin-client.cjs');
const { createClient } = require('../packages/alpi-client/src/client.cjs');
const { openStore } = require('../packages/alpi-client/src/context.cjs');
const { openWorkStore } = require('../packages/alpi-server/src/work-store.cjs');

const RECONNECT_CLIENT = path.join(__dirname, 'helpers', 'alpi-reconnect-client.cjs');
const PROJECT = 'test-project';
const CONTEXT_NAME = 'reconnect-runner';
const OBSERVER_CONTEXT_NAME = 'reconnect-observer';
const CROSS_PROJECT = 'other-project';
const CROSS_CONTEXT_NAME = 'reconnect-cross-runner';
const SEVER_CODES = ['CONNECTION_CLOSED', 'CONNECTION_ERROR'];

async function tempFixture(t, label) {
  const fixture = await tempClientFixture(t, label);
  return {
    ...fixture,
    receiptFile: path.join(fixture.root, 'job-receipt.json'),
    clientEnv: {
      ...fixture.clientEnv,
      // The fresh process audits the committed admission at the sever instant.
      ALPI_TEST_SERVER_STATE_DIR: fixture.stateDir,
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

function lastJsonLine(stdout) {
  const lines = stdout.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

async function pairPersistedContext(t, fixture, invite, name) {
  const result = await pairWithCli(fixture, invite, name);
  assert.equal(result.code, 0, `pairing ${name} exited ${result.code}: ${result.stderr}`);
}

async function runReconnectClient(t, mode, fixture, { contextName = CONTEXT_NAME, extra = [], receiptPath = fixture.receiptFile } = {}) {
  const result = await runNode(
    [RECONNECT_CLIENT, mode, contextName, receiptPath, ...extra],
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
  const open = () => startFixtureServer({
    stateDir: fixture.stateDir,
    port,
    withEngine: (_record, use) => use(engine),
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
  // Ack-boundary pin: the sever fired on the first response byte, and an
  // independent store connection in the dying client process already saw
  // the committed admission at that instant. A transport that streamed
  // bytes before the commit would fail here instead of silently weakening
  // the reconnect reasoning below.
  assert.deepEqual(severed.admissionAtSever, { jobRows: 1, submittedRows: 1 });

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
      // The lookup enforces exact body keys like the artifact routes: an
      // extra or missing field is a client error, never a silent ignore
      // that could be mistaken for a missing job.
      await assert.rejects(
        client.requestResource('lookupJob', {}, { requestId: receipt.submission.requestId, probe: 'extra' }),
        { code: 'HTTP_STATUS', statusCode: 400, resourceCode: 'invalid_input' },
      );
      await assert.rejects(
        client.requestResource('lookupJob', {}, {}),
        { code: 'HTTP_STATUS', statusCode: 400, resourceCode: 'invalid_input' },
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

    // Cross-project probe: an enrolled credential from a DIFFERENT project
    // presenting the SAME request key gets not_found, and once it submits
    // under its own (project, client, key) the key admits independently —
    // request keys are namespaced by principal, never global.
    const crossInvite = await issuePairing({ stateDir: fixture.stateDir, project: CROSS_PROJECT, role: 'runner' });
    await pairPersistedContext(t, fixture, crossInvite, CROSS_CONTEXT_NAME);
    const crossMissing = await runReconnectClient(t, 'lookup-expect-missing', fixture, { contextName: CROSS_CONTEXT_NAME });
    assert.notEqual(crossMissing.clientId, clientId);
    assert.equal(crossMissing.errorCode, 'not_found');
    const crossReceiptPath = path.join(fixture.root, 'job-receipt-cross.json');
    const crossSubmit = await runReconnectClient(t, 'submit-fresh', fixture, {
      contextName: CROSS_CONTEXT_NAME,
      receiptPath: crossReceiptPath,
      extra: [receipt.submission.requestId],
    });
    assert.equal(crossSubmit.project, CROSS_PROJECT);
    assert.equal(crossSubmit.requestId, receipt.submission.requestId);
    assert.notEqual(crossSubmit.jobId, lookup.jobId);
    assert.notEqual(crossSubmit.workspaceId, receipt.workspaceId);
    // With the same key now admitted in its own namespace, the cross
    // project's lookup resolves its own job, never the first project's.
    const crossResolved = await runReconnectClient(t, 'lookup-only', fixture, {
      contextName: CROSS_CONTEXT_NAME,
      receiptPath: crossReceiptPath,
    });
    assert.equal(crossResolved.lookup.jobId, crossSubmit.jobId);
    assert.notEqual(crossResolved.lookup.jobId, lookup.jobId);
    // Store counts: the first project's admission is untouched, and the
    // cross project has its own job row, idempotency receipt and submitted
    // event for the same key.
    const crossAudit = { project: CROSS_PROJECT, clientId: 'audit-peer', role: 'runner' };
    const crossCounts = storeAudit(peer, crossAudit, crossSubmit.jobId, receipt.submission.requestId);
    assert.equal(crossCounts.jobRows, 1);
    assert.equal(crossCounts.receipts, 1);
    assert.equal(crossCounts.submittedEvents, 1);
    assert.equal(crossCounts.submittedRows, 1);
    assert.deepEqual(storeAudit(peer, audit, lookup.jobId, receipt.submission.requestId), counts);
  } finally {
    peer.close();
  }
});

test('two concurrent first-time submissions with the same key through the packaged HTTP stack converge on one admission', async (t) => {
  const fixture = await tempFixture(t, 'jr-race');
  const engine = fixtureEngineAdapter();
  const port = await freePort();
  const server = await startFixtureServer({
    stateDir: fixture.stateDir,
    port,
    withEngine: (_record, use) => use(engine),
  });
  t.after(async () => { await server.close(); });

  const invite = await issuePairing({ stateDir: fixture.stateDir, project: PROJECT, role: 'runner' });
  await pairPersistedContext(t, fixture, invite, CONTEXT_NAME);

  // One fresh process provisions the sandbox and the fixed request key;
  // then TWO brand-new client processes race the same first-time
  // submission over the packaged HTTPS API with no coordination between
  // them: each loads the persisted credential and POSTs the identical
  // submission independently.
  const prepared = await runReconnectClient(t, 'prepare-race', fixture);
  const racers = await Promise.all([
    runReconnectClient(t, 'race-submit', fixture),
    runReconnectClient(t, 'race-submit', fixture),
  ]);
  assert.equal(racers[0].clientId, racers[1].clientId);

  // Same-payload races must converge: the identical submission resolves to
  // the same persisted receipt on every racer, whichever one wins the
  // serialized admission. The losing racer takes the duplicate-admission
  // branch, so it is neither a conflict nor a second admission.
  for (const racer of racers) {
    assert.equal(racer.admitted, true, `racer failed to converge: ${JSON.stringify(racer)}`);
  }
  const jobIds = new Set(racers.map((racer) => racer.jobId));
  assert.equal(jobIds.size, 1);
  const [jobId] = jobIds;

  // Store counts: the race left exactly one job row for the request key,
  // one idempotency receipt, one job.submitted event and one workspace,
  // and enrolled no second client.
  const audit = { project: PROJECT, clientId: 'audit-peer', role: 'runner' };
  const peer = openWorkStore(fixture.stateDir);
  try {
    expectSingleSideEffect(
      storeAudit(peer, audit, jobId, prepared.requestId),
      jobId,
      prepared.requestId,
    );
    const [jobRow] = peer.listJobs(audit);
    assert.equal(jobRow.jobId, jobId);
    assert.equal(jobRow.requestId, prepared.requestId);
    const clients = await listClients({ stateDir: fixture.stateDir });
    assert.equal(clients.clients.length, 1);
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
  const open = () => startFixtureServer({
    stateDir: fixture.stateDir,
    port,
    withEngine: (_record, use) => use(engine),
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
  const server = await startFixtureServer({
    stateDir: fixture.stateDir,
    port,
    withEngine: (_record, use) => use(engine),
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
