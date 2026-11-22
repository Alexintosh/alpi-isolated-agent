'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { startServer } = require('../packages/alpi-server/src/daemon.cjs');
const { issuePairing, revokeClient } = require('../packages/alpi-server/src/admin-client.cjs');
const { requestJson } = require('../packages/alpi-client/src/transport.cjs');
const { createClient } = require('../packages/alpi-client/src/client.cjs');
const { matchResource, resourceRequest } = require('../packages/alpi-server/src/resource-routes.cjs');

// ---------------------------------------------------------------------------
// FI-1 regression: a writer_fenced quarantine (active uncertain-writer fence
// or a pending exec intent) must reach the authenticated HTTPS client as
// HTTP 423 with resourceCode 'writer_fenced', without any extra engine
// dispatch, and must survive a daemon restart on the same persisted state.
// ---------------------------------------------------------------------------

const { openHostResources } = require('../packages/alpi-server/src/host-resources.cjs');
const { WorkStoreError } = require('../packages/alpi-server/src/work-store.cjs');
const { matchesResourceError } = require('../packages/alpi-server/src/resource-routes.cjs');
const { TransportError } = require('../packages/alpi-client/src/transport.cjs');

function quarantineProfileResolver() {
  return async ({ engine, profile }) => ({
    engine,
    profile,
    qualified: true,
    available: true,
    engineVersion: '0.14.1',
    imageDigest: 'sha256:' + 'a'.repeat(64),
    limits: { vcpus: 2, memoryMiB: 2048, diskMiB: 10240 },
    networkMode: 'disabled',
    capabilities: ['create', 'inspect', 'start', 'stop', 'destroy', 'list-owned', 'exec', 'pty'],
  });
}

// Deterministic engine adapter with the same result shapes the service
// expects from a real BoxLite adapter. No VM, network or host path is used.
function quarantineEngineAdapter() {
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
    execCalls: 0,
    execHook: null,
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
      return { allocationId: box.allocationId, launchGeneration: box.launchGeneration, name: box.name, nativeId: box.nativeId, created };
    },
    async inspect(ref) {
      return info(adapter.boxFor(ref));
    },
    async start(ref) {
      adapter.boxFor(ref).running = true;
      return adapter.inspect(ref);
    },
    async stop(ref) {
      adapter.boxFor(ref).running = false;
      return adapter.inspect(ref);
    },
    async destroy(ref) {
      const box = boxes.get(`${ref.allocationId}:${ref.launchGeneration}`);
      boxes.delete(`${ref.allocationId}:${ref.launchGeneration}`);
      return { destroyed: true, alreadyGone: !box, allocationId: ref.allocationId,
        launchGeneration: ref.launchGeneration, name: ref.name, nativeId: ref.nativeId };
    },
    async listOwned() {
      return [...boxes.values()].map(info);
    },
    async exec(ref, spec) {
      adapter.execCalls += 1;
      adapter.boxFor(ref);
      if (adapter.execHook) return adapter.execHook(ref, spec);
      return { exitCode: 0, stdout: 'ok', stderr: '', truncated: false,
        timedOut: false, cancelled: false, executionId: 'exec-1' };
    },
    async probe() {
      return { available: true, version: '0.14.1',
        capabilities: ['create', 'inspect', 'start', 'stop', 'destroy', 'list-owned', 'exec', 'pty'] };
    },
    async close() {},
  };
  return adapter;
}

async function errorOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the request to fail');
}

async function quarantineScenario(t, mode) {
  const engine = quarantineEngineAdapter();
  const parent = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'af-'));
  const stateDir = path.join(parent, 's');
  let store;
  const open = (port) => startServer({
    stateDir, port, handleSignals: false,
    openResources: async (options) => {
      const opened = await openHostResources({
        ...options,
        sandboxHost: {
          resolveProfile: quarantineProfileResolver(),
          withEngine: (_record, use) => use(engine),
        },
        services: { capture: (_request, captured) => { store = captured; return {}; } },
      });
      // The capture route is only reachable through the trusted resource
      // layer; use it to hold the live work-store instance for lease setup.
      await opened.execute({
        name: 'capture', params: {}, body: {},
        principal: { project: 'alpha', role: 'runner', clientId: 'fixture-bootstrap' },
        authenticate() {},
      });
      return opened;
    },
  });
  let server = await open(0);
  t.after(async () => {
    await server.close();
    await fs.rm(parent, { recursive: true, force: true });
  });
  const invite = await issuePairing({ stateDir, project: 'alpha', role: 'runner' });
  const endpoint = { origin: server.origin, fingerprint: invite.fingerprint };
  const grant = await requestJson({ ...endpoint, method: 'POST', path: '/v1/pair/exchange',
    body: { invitation: invite.invitation, name: 'quarantine' } });
  const client = createClient({ ...endpoint, ...grant, serverId: invite.serverId,
    credentialExpiresAt: grant.expiresAt });
  const principal = { project: 'alpha', role: 'runner', clientId: grant.clientId };
  const created = await client.requestResource('createSandbox', {},
    { requestId: randomUUID(), engine: 'boxlite', profile: 'pi-dev' });
  const ref = { sandboxId: created.sandboxId };
  await client.requestResource('startSandbox', ref, {});
  const lease = store.acquireLease(principal, { workspaceId: created.workspaceId });
  const input = { workspaceId: created.workspaceId, leaseEpoch: lease.epoch, argv: ['true'] };
  if (mode === 'uncertain') {
    engine.execHook = () => { throw { code: 'engine_termination_unverified' }; };
    const first = await errorOf(client.requestResource('exec', ref, input));
    assert.equal(first.statusCode, 504);
    assert.equal(first.resourceCode, 'exec_uncertain');
  } else {
    const mark = store.markExecIntent.bind(store);
    store.markExecIntent = () => { throw new WorkStoreError('store_busy', 'synthetic store_busy'); };
    try {
      await client.requestResource('exec', ref, input);
    } finally {
      store.markExecIntent = mark;
    }
    assert.equal(store.listPendingExecIntents().length, 1);
  }
  engine.execHook = null;
  const dispatched = engine.execCalls;
  const quarantined = await errorOf(client.requestResource('exec', ref, input));
  assert.equal(quarantined.statusCode, 423);
  assert.equal(quarantined.resourceCode, 'writer_fenced');
  assert.equal(engine.execCalls, dispatched);
  // Reopen the daemon on the same state and port; the quarantine contract
  // must survive the restart unchanged.
  const port = Number(new URL(server.origin).port);
  await server.close();
  server = await open(port);
  const afterRestart = await errorOf(client.requestResource('exec', ref, input));
  assert.equal(afterRestart.statusCode, 423);
  assert.equal(afterRestart.resourceCode, 'writer_fenced');
  assert.equal(engine.execCalls, dispatched);
  // Verified stop/start settles ownership; the same exec then succeeds.
  await client.requestResource('stopSandbox', ref, {});
  await client.requestResource('startSandbox', ref, {});
  await client.requestResource('exec', ref, input);
  assert.equal(engine.execCalls, dispatched + 1);
}

test('an active writer fence reaches the client as 423 writer_fenced and survives restart', async (t) => {
  await quarantineScenario(t, 'uncertain');
});

test('a pending exec intent reaches the client as 423 writer_fenced and survives restart', async (t) => {
  await quarantineScenario(t, 'pending');
});

test('resource code filtering keeps matched codes and drops unknown or mismatched ones', () => {
  assert.equal(matchesResourceError('writer_fenced', 423), true);
  assert.equal(matchesResourceError('writer_fenced', 500), false);
  assert.equal(matchesResourceError('not_a_registered_code', 423), false);
  const kept = new TransportError('HTTP_STATUS', 'test', { statusCode: 423, resourceCode: 'writer_fenced' });
  assert.equal(kept.resourceCode, 'writer_fenced');
  const mismatched = new TransportError('HTTP_STATUS', 'test', { statusCode: 500, resourceCode: 'writer_fenced' });
  assert.equal(mismatched.resourceCode, undefined);
  const unknown = new TransportError('HTTP_STATUS', 'test', { statusCode: 423, resourceCode: 'not_a_registered_code' });
  assert.equal(unknown.resourceCode, undefined);
  const client = createClient({
    origin: 'https://127.0.0.1:4443',
    fingerprint: '1'.repeat(64),
    credential: Buffer.alloc(32, 1).toString('base64url'),
    serverId: '11111111-1111-4111-8111-111111111111',
    project: 'alpha',
    role: 'runner',
    credentialExpiresAt: Date.now() + 60000,
    requestJson: async () => { throw { code: 'HTTP_STATUS', statusCode: 423, resourceCode: 'writer_fenced' }; },
  });
  return assert.rejects(client.requestResource('listSandboxes'),
    { statusCode: 423, resourceCode: 'writer_fenced' });
});

test('work route identifiers and event cursors have a single safe transport representation', () => {
  const jobId = randomUUID();
  const route = resourceRequest('getEvents', { jobId, after: '7' });
  assert.deepEqual(matchResource(route.method, route.path), matchResource('GET', '/v1/jobs/' + jobId + '/events?after=7'));
  assert.throws(() => resourceRequest('getJob', { jobId: '../identity' }));
  assert.throws(() => resourceRequest('getJob', { jobId, project: 'another' }));
  assert.equal(matchResource('GET', '/v1/sandboxes/%2e%2e/identity'), null);
  assert.equal(matchResource('GET', '/v1/jobs/' + jobId + '/events/9007199254740992'), null);
});

test('paired resource calls use the enrolled role and project and observe revocation', async t => {
  const parent = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'ar-'));
  const stateDir = path.join(parent, 's');
  const invocations = [];
  let closed = false;
  let reads = 0;
  const server = await startServer({
    stateDir, port: 0, handleSignals: false,
    runtimeInventory: async () => { reads++; return []; },
    openResources: async () => ({
      async execute({ name, params, body, principal }) {
        if (name === 'createSandbox') {
          throw Object.assign(new Error('private conflict detail'), { code: 'idempotency_conflict' });
        }
        if (name === 'getJob') {
          const error = new Error('private backend error');
          error.code = 'not_found';
          throw error;
        }
        invocations.push({ name, params, body, principal });
        return { project: principal.project, name };
      },
      async close() { closed = true; },
    }),
  });
  t.after(async () => { await server.close(); await fs.rm(parent, { recursive: true, force: true }); });
  async function enroll(role) {
    const invite = await issuePairing({ stateDir, project: 'test-project', role });
    const { credential, clientId, expiresAt } = await requestJson({
      origin: server.origin, fingerprint: invite.fingerprint, method: 'POST', path: '/v1/pair/exchange',
      body: { invitation: invite.invitation, name: role },
    });
    return { clientId, client: createClient({ origin: server.origin, fingerprint: invite.fingerprint,
      credential, serverId: invite.serverId, project: 'test-project', role, credentialExpiresAt: expiresAt }) };
  }
  const observer = await enroll('observer');
  const runner = await enroll('runner');
  assert.deepEqual(await observer.client.requestResource('listSandboxes'), { project: 'test-project', name: 'listSandboxes' });
  await assert.rejects(observer.client.requestResource('createSandbox', {}, {}), { statusCode: 403 });
  await assert.rejects(observer.client.requestResource('getJob', { jobId: randomUUID() }), { statusCode: 404 });
  await assert.rejects(runner.client.requestResource('createSandbox', {}, { requestId: randomUUID() }),
    { code: 'HTTP_STATUS', statusCode: 409, resourceCode: 'idempotency_conflict',
      message: 'Server rejected the request.' });
  const sandboxId = randomUUID();
  await runner.client.requestResource('stopSandbox', { sandboxId }, { requestId: randomUUID() });
  assert.equal(reads, 3);
  assert.equal(invocations.length, 2);
  assert.equal(invocations[1].principal.clientId, runner.clientId);
  assert.deepEqual(invocations[1].params, { sandboxId });
  await revokeClient({ stateDir, clientId: runner.clientId });
  await assert.rejects(runner.client.requestResource('getSandbox', { sandboxId }), { statusCode: 401 });
  assert.equal(invocations.length, 2);
  await server.close();
  assert.equal(closed, true);
});

test('paired observer follows a persisted job after restart using its own cursor', async t => {
  const { openWorkStore } = require('../packages/alpi-server/src/work-store.cjs');
  const { openHostResources } = require('../packages/alpi-server/src/host-resources.cjs');
  const parent = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aj-'));
  const stateDir = path.join(parent, 's');
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const principal = { project: 'one', clientId: randomUUID(), role: 'runner' };
  const store = openWorkStore(stateDir);
  let sandbox, job;
  try {
    sandbox = store.reserveSandbox(principal, { requestId: randomUUID(), engine: 'boxlite', engineVersion: '0.14.1',
      profile: 'pi-dev', imageDigest: 'sha256:' + '1'.repeat(64), resources: { vcpus: 1, memoryMiB: 512, diskMiB: 2048 } });
    job = store.submitJob(principal, { requestId: randomUUID(), workspaceId: sandbox.workspaceId, payload: { prompt: 'private-input' } });
    store.appendEvent(principal, { type: 'message', jobId: job.jobId, data: { text: 'result', rawProviderBody: 'hidden' } });
  } finally { store.close(); }
  const server = await startServer({ stateDir, port: 0, handleSignals: false, openResources: openHostResources });
  try {
    async function clientFor(project) {
      const invite = await issuePairing({ stateDir, project, role: 'observer' });
      const endpoint = { origin: server.origin, fingerprint: invite.fingerprint };
      const response = await requestJson({ ...endpoint, method: 'POST', path: '/v1/pair/exchange',
        body: { invitation: invite.invitation, name: 'reader' } });
      return createClient({ ...endpoint, serverId: invite.serverId, project, role: 'observer',
        credential: response.credential, credentialExpiresAt: response.expiresAt });
    }
    const reader = await clientFor('one');
    const other = await clientFor('two');
    const listed = await reader.requestResource('listSandboxes');
    assert.deepEqual(listed.sandboxes.map(item => item.workspaceId), [job.workspaceId]);
    const status = await reader.requestResource('getJob', { jobId: job.jobId });
    assert.equal(status.sessionUuid, job.sessionUuid);
    assert.ok(!JSON.stringify(status).includes('private-input'));
    const page = await reader.requestResource('getEvents', { jobId: job.jobId, after: '0' });
    assert.equal(page.events[0].untrustedText, 'result');
    assert.ok(!JSON.stringify(page).includes('rawProviderBody'));
    const next = await reader.requestResource('getEvents', { jobId: job.jobId, after: String(page.nextSeq) });
    assert.deepEqual(next.events, []);
    await assert.rejects(other.requestResource('getJob', { jobId: job.jobId }), { statusCode: 404 });
  } finally { await server.close(); }
});

test('paired artifact client transfers a tree in verified chunks and acknowledges receipt', async () => {
  const { openHostResources } = require('../packages/alpi-server/src/host-resources.cjs');
  const { ArtifactsClient, createHttpApi } = require('../packages/alpi-client/src/artifacts.cjs');
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aa-'));
  const stateDir = path.join(root, 'state');
  let server;
  try {
    server = await startServer({ stateDir, port: 0, handleSignals: false, openResources: openHostResources });
    async function enroll(project, role) {
      const invite = await issuePairing({ stateDir, project, role });
      const endpoint = { origin: server.origin, fingerprint: invite.fingerprint };
      const { credential } = await requestJson({ ...endpoint, method: 'POST', path: '/v1/pair/exchange',
        body: { invitation: invite.invitation, name: role } });
      return createHttpApi({ requestJson, ...endpoint, credential });
    }
    const api = await enroll('alpha', 'runner');
    const other = await enroll('beta', 'runner');
    const reader = await enroll('alpha', 'observer');
    const client = new ArtifactsClient({ api, allowedRoots: [root], python: '/usr/bin/python3' });
    const source = path.join(root, 'source');
    await fs.mkdir(source);
    const bytes = Buffer.alloc(70000, 70);
    await fs.writeFile(path.join(source, 'sample'), bytes);
    const upload = await client.uploadTree({ source, requestId: randomUUID() });
    const { artifactId } = upload;
    assert.ok(upload.streamLength > 32768);
    assert.equal((await reader.getArtifact({ artifactId })).sha256, upload.sha256);
    await assert.rejects(reader.readChunk({ artifactId, offset: 0 }), { statusCode: 403 });
    await assert.rejects(other.getArtifact({ artifactId }), { statusCode: 404 });
    const downloaded = await client.downloadTree({ artifactId, projectRoot: root, name: 'received' });
    assert.equal(downloaded.sha256, upload.sha256);
    assert.equal(downloaded.acknowledged, false);
    assert.deepEqual(await fs.readFile(path.join(downloaded.destination, 'source', 'sample')), bytes);
    await client.acknowledge({ artifactId });
    assert.ok((await api.getArtifact({ artifactId })).acknowledgedAt);
  } finally {
    if (server) await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
