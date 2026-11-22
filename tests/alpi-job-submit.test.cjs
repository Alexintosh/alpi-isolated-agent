'use strict';

// boxes-job-submit regression: packaged job submission on an explicit engine.
//
// Covers, through the packaged HTTPS API and the paired alpi-client library
// (the same stack the MCP bridge and CLI use):
// - durable persistence: the acknowledged job survives a peer store handle
//   and a full server restart on the same state directory;
// - explicit engine scoping: a missing engine is refused, an unknown engine
//   is refused, a test-only engine is selectable only on a dev/test registry
//   and never on the packaged production path, and a submission naming an
//   engine other than the sandbox engine is refused;
// - disposable workspace lifecycle: the job runs against an ephemeral
//   workspace that the sandbox service destroys on explicit delete while the
//   durable job journal keeps the receipt.

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');

const { startServer } = require('../packages/alpi-server/src/daemon.cjs');
const { issuePairing } = require('../packages/alpi-server/src/admin-client.cjs');
const { requestJson } = require('../packages/alpi-client/src/transport.cjs');
const { createClient } = require('../packages/alpi-client/src/client.cjs');
const {
  createEngineRegistry,
  EngineRegistryError,
} = require('../packages/alpi-server/src/engines/registry.cjs');
const { openHostResources } = require('../packages/alpi-server/src/host-resources.cjs');
const { openWorkStore } = require('../packages/alpi-server/src/work-store.cjs');

const PROJECT = 'test-project';

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

function devTestRegistry() {
  const registry = createEngineRegistry({ allowTestAdapters: true });
  registry.install({ id: 'fixture', testOnly: true, factory: async () => fixtureEngineAdapter() });
  registry.install({ id: 'other', factory: async () => fixtureEngineAdapter() });
  return registry;
}

async function tempStateDir(t, label) {
  const parent = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), `${label}-`));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  return path.join(parent, 'state');
}

async function enroll(stateDir, server, role) {
  const invite = await issuePairing({ stateDir, project: PROJECT, role });
  const endpoint = { origin: server.origin, fingerprint: invite.fingerprint };
  const response = await requestJson({
    ...endpoint, method: 'POST', path: '/v1/pair/exchange',
    body: { invitation: invite.invitation, name: role },
  });
  return createClient({
    ...endpoint, serverId: invite.serverId, project: PROJECT, role,
    credential: response.credential, credentialExpiresAt: response.expiresAt,
  });
}

test('packaged production path never admits a job on a test engine', async (t) => {
  const stateDir = await tempStateDir(t, 'js-prod');
  const engine = fixtureEngineAdapter();
  // Even an adversarial host that qualifies the test engine cannot make the
  // packaged production admission path accept it.
  const server = await startServer({
    stateDir, port: 0, handleSignals: false,
    openResources: (options) => openHostResources({
      ...options,
      sandboxHost: {
        resolveProfile: fixtureProfileResolver(),
        withEngine: (_record, use) => use(engine),
      },
    }),
  });
  t.after(async () => { await server.close(); });
  const runner = await enroll(stateDir, server, 'runner');
  const sandbox = await runner.requestResource('createSandbox', {}, {
    requestId: randomUUID(), engine: 'fixture', profile: 'dev',
  });
  assert.equal(sandbox.engine, 'fixture');

  await assert.rejects(
    runner.requestResource('submitJob', { sandboxId: sandbox.sandboxId }, {
      requestId: randomUUID(), engine: 'fixture', payload: { prompt: 'hi' },
    }),
    { code: 'HTTP_STATUS', statusCode: 422, resourceCode: 'engine_unsupported' }
  );
  await assert.rejects(
    runner.requestResource('submitJob', { sandboxId: sandbox.sandboxId }, {
      requestId: randomUUID(), payload: { prompt: 'hi' },
    }),
    { code: 'HTTP_STATUS', statusCode: 400, resourceCode: 'invalid_input' }
  );

  // The registry-level guarantee behind the packaged refusal: a production
  // registry cannot even hold a test-only adapter.
  const production = createEngineRegistry();
  assert.throws(
    () => production.install({ id: 'fixture', testOnly: true, factory: async () => ({}) }),
    (error) => error instanceof EngineRegistryError &&
      error.code === 'test_adapter_forbidden'
  );
});

test('packaged job submission is durable before ack, engine-scoped, and survives restart', async (t) => {
  const stateDir = await tempStateDir(t, 'js-dev');
  const engine = fixtureEngineAdapter();
  const open = () => startServer({
    stateDir, port: 0, handleSignals: false,
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
  const runner = await enroll(stateDir, server, 'runner');
  const observer = await enroll(stateDir, server, 'observer');

  // The submission runs in a disposable workspace: ephemeral by default.
  const sandbox = await runner.requestResource('createSandbox', {}, {
    requestId: randomUUID(), engine: 'fixture', profile: 'dev',
  });
  assert.equal(sandbox.retention, 'ephemeral');
  assert.equal(sandbox.engine, 'fixture');

  const submit = { requestId: randomUUID(), engine: 'fixture', payload: { prompt: 'hello' } };
  const job = await runner.requestResource('submitJob', { sandboxId: sandbox.sandboxId }, submit);
  assert.equal(job.disposition, 'acknowledged');
  assert.equal(job.workspaceId, sandbox.workspaceId);

  // Idempotent replay through the packaged path returns the same job.
  const replay = await runner.requestResource('submitJob', { sandboxId: sandbox.sandboxId }, submit);
  assert.equal(replay.jobId, job.jobId);
  assert.equal(replay.disposition, 'acknowledged');

  // Explicit engine scoping through the packaged path.
  await assert.rejects(
    runner.requestResource('submitJob', { sandboxId: sandbox.sandboxId }, {
      requestId: randomUUID(), payload: { prompt: 'hi' },
    }),
    { code: 'HTTP_STATUS', statusCode: 400, resourceCode: 'invalid_input' }
  );
  await assert.rejects(
    runner.requestResource('submitJob', { sandboxId: sandbox.sandboxId }, {
      requestId: randomUUID(), engine: 'boxlite', payload: { prompt: 'hi' },
    }),
    { code: 'HTTP_STATUS', statusCode: 422, resourceCode: 'engine_unsupported' }
  );
  await assert.rejects(
    runner.requestResource('submitJob', { sandboxId: sandbox.sandboxId }, {
      requestId: randomUUID(), engine: 'other', payload: { prompt: 'hi' },
    }),
    { code: 'HTTP_STATUS', statusCode: 409, resourceCode: 'engine_identity_conflict' }
  );

  // Durable before ack: an independent store handle on the same state
  // directory already sees the acknowledged job.
  const peer = openWorkStore(stateDir);
  try {
    const persisted = peer.getJob(
      { project: PROJECT, clientId: 'peer-reader', role: 'runner' },
      job.jobId
    );
    assert.equal(persisted.disposition, 'acknowledged');
    assert.equal(persisted.requestId, submit.requestId);
  } finally {
    peer.close();
  }

  // The submission is observable through the same packaged path.
  const status = await observer.requestResource('getJob', { jobId: job.jobId });
  assert.equal(status.sessionUuid, job.sessionUuid);
  assert.ok(!JSON.stringify(status).includes('hello'));
  const page = await observer.requestResource('getEvents', { jobId: job.jobId, after: '0' });
  assert.equal(page.events[0].type, 'job.submitted');
  assert.equal(page.events[0].jobId, job.jobId);

  // The acknowledged job survives a full server restart.
  await server.close();
  const restarted = await open();
  try {
    const afterRestartObserver = await enroll(stateDir, restarted, 'observer');
    const afterRestart = await afterRestartObserver.requestResource('getJob', { jobId: job.jobId });
    assert.equal(afterRestart.jobId, job.jobId);
    assert.equal(afterRestart.disposition, 'acknowledged');
  } finally {
    await restarted.close();
  }
});

test('a cancelled job releases its disposable workspace while the receipt stays durable', async (t) => {
  const stateDir = await tempStateDir(t, 'js-lifecycle');
  const engine = fixtureEngineAdapter();
  const server = await startServer({
    stateDir, port: 0, handleSignals: false,
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
  const runner = await enroll(stateDir, server, 'runner');
  const operator = await enroll(stateDir, server, 'operator');
  const observer = await enroll(stateDir, server, 'observer');

  const sandbox = await runner.requestResource('createSandbox', {}, {
    requestId: randomUUID(), engine: 'fixture', profile: 'dev',
  });
  const job = await runner.requestResource('submitJob', { sandboxId: sandbox.sandboxId }, {
    requestId: randomUUID(), engine: 'fixture', payload: { prompt: 'hello' },
  });
  assert.equal(job.disposition, 'acknowledged');

  const cancelled = await runner.requestResource('cancelJob', { jobId: job.jobId }, {});
  assert.equal(cancelled.disposition, 'cancelled');
  // A repeated cancel is idempotent at the terminal disposition.
  const repeat = await runner.requestResource('cancelJob', { jobId: job.jobId }, {});
  assert.equal(repeat.disposition, 'cancelled');

  // The sandbox must be stopped before the operator can release it.
  await runner.requestResource('stopSandbox', { sandboxId: sandbox.sandboxId }, {});
  // Release the disposable workspace; the engine observes the destroy.
  await operator.requestResource('deleteSandbox', { sandboxId: sandbox.sandboxId }, {
    reason: 'job-collected',
  });
  assert.equal(engine.destroyed.length, 1);
  assert.equal(engine.destroyed[0].allocationId, sandbox.sandboxId);
  const listed = await observer.requestResource('listSandboxes');
  assert.equal(listed.sandboxes.length, 0);

  // The durable job journal keeps the terminal receipt after the workspace
  // is gone.
  const receipt = await observer.requestResource('getJob', { jobId: job.jobId });
  assert.equal(receipt.disposition, 'cancelled');
  assert.equal(receipt.workspaceId, sandbox.workspaceId);
});
