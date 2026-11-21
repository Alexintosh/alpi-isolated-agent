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
