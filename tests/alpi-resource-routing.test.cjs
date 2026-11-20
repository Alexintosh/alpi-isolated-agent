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
  const sandboxId = randomUUID();
  await runner.client.requestResource('stopSandbox', { sandboxId }, { requestId: randomUUID() });
  assert.equal(reads, 2);
  assert.equal(invocations.length, 2);
  assert.equal(invocations[1].principal.clientId, runner.clientId);
  assert.deepEqual(invocations[1].params, { sandboxId });
  await revokeClient({ stateDir, clientId: runner.clientId });
  await assert.rejects(runner.client.requestResource('getSandbox', { sandboxId }), { statusCode: 401 });
  assert.equal(invocations.length, 2);
  await server.close();
  assert.equal(closed, true);
});
