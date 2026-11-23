'use strict';

// boxes-verified-patch regression: a job's patch output is durable in the
// packaged artifact store, retrievable through the packaged artifact routes,
// independently verifiable against the recorded digest and applicable on a
// fresh checkout of the recorded base.
//
// How the patch enters the store (the production trust boundary): a runner
// registers a completed job output through POST /v1/jobs/:jobId/outputs with
// the full bounded patch body {requestId, totalLength, sha256, label, data}.
// The packaged server does not keep any parallel storage: it delegates the
// bytes to the durable artifact store (begin, single chunk, finish), which
// assigns the artifact id and refuses to publish bytes that do not hash to
// the declared sha256, then records the digest receipt on the job row. There
// is no test-engine fallback and no remote host-shell interface on this path;
// harness dispatch stays a later milestone. Consumers fetch the bytes through
// the actual artifact routes (GET /v1/artifacts/:artifactId and chunk reads)
// and recompute the hash against the receipt before using the patch.

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { execFile: execFileCallback } = require('node:child_process');
const { promisify } = require('node:util');
const { test } = require('node:test');

const { startServer } = require('../packages/alpi-server/src/daemon.cjs');
const { issuePairing } = require('../packages/alpi-server/src/admin-client.cjs');
const { requestJson } = require('../packages/alpi-client/src/transport.cjs');
const { createClient } = require('../packages/alpi-client/src/client.cjs');
const {
  ArtifactsClient,
  createHttpApi,
} = require('../packages/alpi-client/src/artifacts.cjs');
const { createEngineRegistry } = require('../packages/alpi-server/src/engines/registry.cjs');
const { openHostResources } = require('../packages/alpi-server/src/host-resources.cjs');
const { openArtifactStore } = require('../packages/alpi-server/src/artifact-store.cjs');
const { openWorkStore } = require('../packages/alpi-server/src/work-store.cjs');

const execFile = promisify(execFileCallback);

const PROJECT = 'test-project';
const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_DIR = 'boxes-verified-patch-fixture';
const PATCH_LABEL = 'boxes-verified-patch';
const BASE_COUNTER = 'module.exports = () => 1;';
const PATCHED_COUNTER = 'module.exports = () => 42;';

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
  const context = {
    ...endpoint, serverId: invite.serverId, project: PROJECT, role,
    credential: response.credential, credentialExpiresAt: response.expiresAt,
  };
  const client = createClient(context);
  const artifacts = new ArtifactsClient({
    api: createHttpApi({
      requestJson,
      origin: endpoint.origin,
      fingerprint: endpoint.fingerprint,
      credential: context.credential,
    }),
    allowedRoots: [REPO_ROOT],
  });
  return { client, artifacts };
}

// Build the recorded base and the intended change with real git, so the
// verified patch is a genuine git diff between two committed states.
async function buildBaseAndPatch(t) {
  const parent = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'bvp-git-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const baseDir = path.join(parent, 'base');
  const git = (...args) => execFile('git',
    ['-c', 'user.email=boxes-verified-patch@example.invalid',
      '-c', 'user.name=boxes-verified-patch', ...args],
    { cwd: baseDir, maxBuffer: 1024 * 1024 });
  await fs.mkdir(baseDir);
  await git('init', '--initial-branch=main', '--quiet');
  await fs.mkdir(path.join(baseDir, FIXTURE_DIR));
  await fs.writeFile(path.join(baseDir, FIXTURE_DIR, 'counter.js'), BASE_COUNTER + '\n');
  // The change's own test: it asserts the exact intended change, so it fails
  // on the recorded base and passes only after the patch applies.
  await fs.writeFile(path.join(baseDir, FIXTURE_DIR, 'check.cjs'),
    "'use strict';\nconst assert = require('node:assert/strict');\n" +
    "const counter = require('./counter.js');\n" +
    "assert.equal(counter(), 42);\nconsole.log('patch fixture test passed');\n");
  await git('add', '.');
  await git('commit', '--quiet', '--message', 'recorded base');
  const baseCommit = (await git('rev-parse', 'HEAD')).stdout.trim();

  await fs.writeFile(path.join(baseDir, FIXTURE_DIR, 'counter.js'), PATCHED_COUNTER + '\n');
  const diff = await git('diff', '--binary');
  assert.ok(diff.stdout.length > 0, 'the intended change produces a patch');
  const patchBytes = Buffer.from(diff.stdout, 'utf8');
  return { parent, baseDir, baseCommit, patchBytes };
}

function recomputeDigest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

test('a job patch is durable, retrievable through the artifact routes, verifiable and applies', async (t) => {
  const { baseDir, baseCommit, patchBytes } = await buildBaseAndPatch(t);
  const stateDir = await tempStateDir(t, 'bvp');
  const open = () => startServer({
    stateDir, port: 0, handleSignals: false,
    openResources: (options) => openHostResources({
      ...options,
      engines: devTestRegistry(),
      sandboxHost: {
        resolveProfile: fixtureProfileResolver(),
        withEngine: (_record, use) => use(fixtureEngineAdapter()),
      },
    }),
  });
  const server = await open();
  t.after(async () => { await server.close(); });
  const author = await enroll(stateDir, server, 'runner');

  const sandbox = await author.client.requestResource('createSandbox', {}, {
    requestId: randomUUID(), engine: 'fixture', profile: 'dev',
  });
  const job = await author.client.requestResource('submitJob',
    { sandboxId: sandbox.sandboxId },
    { requestId: randomUUID(), engine: 'fixture', payload: { prompt: 'patch the counter' } });
  assert.equal(job.disposition, 'acknowledged');

  // The patch enters the durable store through the packaged registration
  // route; the client keeps only the returned digest receipt.
  const uploadRequestId = randomUUID();
  const receipt = await author.artifacts.uploadJobPatch({
    jobId: job.jobId, label: PATCH_LABEL, data: patchBytes, requestId: uploadRequestId,
  });
  assert.match(receipt.artifactId, /^[0-9a-f-]{36}$/);
  assert.equal(receipt.jobId, job.jobId);
  assert.equal(receipt.label, PATCH_LABEL);
  assert.equal(receipt.totalLength, patchBytes.length);
  assert.equal(receipt.sha256, recomputeDigest(patchBytes));
  assert.equal(receipt.requestId, uploadRequestId);

  // (1) The bytes are in the durable artifact store, seen by an independent
  // store handle, and the job row records the same digest receipt.
  const peerArtifacts = openArtifactStore(stateDir);
  const peerWork = openWorkStore(stateDir);
  try {
    const stored = peerArtifacts.listArtifacts(PROJECT)
      .find(entry => entry.artifactId === receipt.artifactId);
    assert.ok(stored, 'the patch artifact is durably stored');
    assert.equal(stored.state, 'published');
    assert.equal(stored.totalLength, patchBytes.length);
    assert.equal(stored.sha256, receipt.sha256);
    const recorded = peerWork.getJobArtifacts(
      { project: PROJECT, clientId: 'peer-reader', role: 'runner' }, job.jobId);
    assert.deepEqual(recorded.map(entry => ({
      artifactId: entry.artifactId, label: entry.label,
      totalLength: entry.totalLength, sha256: entry.sha256,
    })), [{
      artifactId: receipt.artifactId, label: PATCH_LABEL,
      totalLength: patchBytes.length, sha256: receipt.sha256,
    }]);
  } finally {
    peerArtifacts.close();
    peerWork.close();
  }

  // A replay with the same request key returns the same receipt without a
  // second artifact row.
  const replay = await author.artifacts.uploadJobPatch({
    jobId: job.jobId, label: PATCH_LABEL, data: patchBytes, requestId: uploadRequestId,
  });
  assert.equal(replay.artifactId, receipt.artifactId);

  // (2) A fresh packaged client retrieves the bytes through the actual
  // artifact routes and they are byte-identical.
  const consumer = await enroll(stateDir, server, 'runner');
  const fetched = await consumer.artifacts.readPatchBytes({
    jobId: job.jobId, artifactId: receipt.artifactId,
    totalLength: receipt.totalLength, sha256: receipt.sha256,
  });
  assert.ok(fetched.data.equals(patchBytes), 'retrieved bytes are byte-identical');

  // (3) An independent verifier recomputes the digest and compares it to the
  // receipt; a mismatch is detectable.
  const verifier = async (bytes, expected) => recomputeDigest(bytes) === expected;
  assert.equal(await verifier(fetched.data, receipt.sha256), true,
    'the recomputed digest matches the receipt');
  const tampered = Buffer.from(patchBytes);
  tampered[tampered.length - 2] = tampered[tampered.length - 2] ^ 0x20;
  assert.equal(await verifier(tampered, receipt.sha256), false,
    'a mismatch between recomputed and recorded digest is detectable');
  await assert.rejects(
    consumer.artifacts.readPatchBytes({
      jobId: job.jobId, artifactId: receipt.artifactId,
      totalLength: receipt.totalLength, sha256: recomputeDigest(tampered),
    }),
    (error) => error.code === 'digest_mismatch'
  );

  // The digest is enforced on the server, not only by the client: a
  // registration whose declared sha256 does not match its bytes is refused
  // and publishes nothing.
  await assert.rejects(
    author.client.requestResource('registerJobOutput', { jobId: job.jobId }, {
      requestId: randomUUID(), totalLength: patchBytes.length,
      sha256: recomputeDigest(tampered), label: PATCH_LABEL,
      data: patchBytes.toString('base64'),
    }),
    { code: 'HTTP_STATUS', statusCode: 422, resourceCode: 'digest_mismatch' }
  );

  // The receipt list is the consumer's durable index of the job output.
  const outputs = await consumer.artifacts.listJobOutputs({ jobId: job.jobId });
  assert.deepEqual(outputs.map(entry => ({
    artifactId: entry.artifactId, label: entry.label, sha256: entry.sha256,
  })), [{ artifactId: receipt.artifactId, label: PATCH_LABEL, sha256: receipt.sha256 }]);

  // The patch survives a full server restart and a fresh client credential.
  await server.close();
  const restarted = await open();
  t.after(async () => { await restarted.close(); });
  try {
    const afterRestart = await enroll(stateDir, restarted, 'runner');
    const refetched = await afterRestart.artifacts.readPatchBytes({
      jobId: job.jobId, artifactId: receipt.artifactId,
      totalLength: receipt.totalLength, sha256: receipt.sha256,
    });
    assert.ok(refetched.data.equals(patchBytes), 'the patch survives a restart');

    // (4) On a fresh checkout of the recorded base the patch applies and the
    // exact intended change is asserted, then its own test passes.
    const checkout = path.join(path.dirname(baseDir), 'fresh-checkout');
    await execFile('git', ['clone', '--quiet', baseDir, checkout]);
    await execFile('git', ['checkout', '--quiet', baseCommit], { cwd: checkout });
    const checkoutBase = await fs.readFile(
      path.join(checkout, FIXTURE_DIR, 'counter.js'), 'utf8');
    assert.equal(checkoutBase, BASE_COUNTER + '\n');
    const patchFile = path.join(path.dirname(checkout), 'recorded.patch');
    await fs.writeFile(patchFile, fetched.data);
    await execFile('git', ['apply', '--check', patchFile], { cwd: checkout });
    await execFile('git', ['apply', patchFile], { cwd: checkout });
    const patched = await fs.readFile(
      path.join(checkout, FIXTURE_DIR, 'counter.js'), 'utf8');
    assert.equal(patched, PATCHED_COUNTER + '\n', 'the exact intended change applied');
    const applied = await execFile(process.execPath,
      [path.join(FIXTURE_DIR, 'check.cjs')], { cwd: checkout });
    assert.match(applied.stdout, /patch fixture test passed/);
  } finally {
    await restarted.close();
  }
});

test('job output registration enforces role, body shape and job scope', async (t) => {
  const { baseDir, patchBytes } = await buildBaseAndPatch(t);
  const stateDir = await tempStateDir(t, 'bvp-guard');
  const server = await startServer({
    stateDir, port: 0, handleSignals: false,
    openResources: (options) => openHostResources({
      ...options,
      engines: devTestRegistry(),
      sandboxHost: {
        resolveProfile: fixtureProfileResolver(),
        withEngine: (_record, use) => use(fixtureEngineAdapter()),
      },
    }),
  });
  t.after(async () => { await server.close(); });
  const runner = await enroll(stateDir, server, 'runner');
  const observer = await enroll(stateDir, server, 'observer');

  const sandbox = await runner.client.requestResource('createSandbox', {}, {
    requestId: randomUUID(), engine: 'fixture', profile: 'dev',
  });
  const job = await runner.client.requestResource('submitJob',
    { sandboxId: sandbox.sandboxId },
    { requestId: randomUUID(), engine: 'fixture', payload: { prompt: 'hello' } });

  // An observer cannot attach an output, but may read the (empty) list.
  await assert.rejects(
    observer.artifacts.uploadJobPatch({
      jobId: job.jobId, label: PATCH_LABEL, data: patchBytes, requestId: randomUUID(),
    }),
    { code: 'HTTP_STATUS', statusCode: 403, resourceCode: 'forbidden' }
  );
  assert.deepEqual(await observer.artifacts.listJobOutputs({ jobId: job.jobId }), []);

  // The registration body carries exactly its declared keys.
  await assert.rejects(
    runner.client.requestResource('registerJobOutput', { jobId: job.jobId }, {
      requestId: randomUUID(), totalLength: patchBytes.length,
      sha256: recomputeDigest(patchBytes), label: PATCH_LABEL,
      data: patchBytes.toString('base64'), extra: true,
    }),
    { code: 'HTTP_STATUS', statusCode: 400, resourceCode: 'invalid_input' }
  );
  // A body that repeats the path parameter is rejected like submitJob.
  await assert.rejects(
    runner.client.requestResource('registerJobOutput', { jobId: job.jobId }, {
      jobId: job.jobId, requestId: randomUUID(), totalLength: patchBytes.length,
      sha256: recomputeDigest(patchBytes), label: PATCH_LABEL,
      data: patchBytes.toString('base64'),
    }),
    { code: 'HTTP_STATUS', statusCode: 400, resourceCode: 'invalid_input' }
  );
  // An unknown job identifier is not_found, never an attachment.
  await assert.rejects(
    runner.artifacts.uploadJobPatch({
      jobId: randomUUID(), label: PATCH_LABEL, data: patchBytes, requestId: randomUUID(),
    }),
    { code: 'HTTP_STATUS', statusCode: 404, resourceCode: 'not_found' }
  );
  await assert.rejects(
    observer.artifacts.listJobOutputs({ jobId: randomUUID() }),
    { code: 'HTTP_STATUS', statusCode: 404, resourceCode: 'not_found' }
  );
  // Nothing was attached by the refused attempts.
  assert.deepEqual(await runner.artifacts.listJobOutputs({ jobId: job.jobId }), []);
  assert.equal(baseDir.length > 0, true);
});

// The registerJobOutput replay branch is the subtle part of the route: a
// replay of a lost reply must resume the stored upload instead of starting a
// second artifact, and it must never republish bytes that disagree with the
// declared digest. This matrix pins the three replay outcomes:
//   (a) exact replay of a completed registration returns the same receipt;
//   (b) replay that resumes an interrupted upload with differing suffix
//       bytes fails digest_mismatch at finish and republishes nothing;
//   (c) replay with changed metadata (sha256 or length) conflicts at begin,
//       before any byte handling.
test('registerJobOutput replay: exact replay is idempotent, differing suffix bytes fail at finish, changed metadata conflicts at begin', async (t) => {
  const { patchBytes } = await buildBaseAndPatch(t);
  const stateDir = await tempStateDir(t, 'bvp-replay');
  const server = await startServer({
    stateDir, port: 0, handleSignals: false,
    openResources: (options) => openHostResources({
      ...options,
      engines: devTestRegistry(),
      sandboxHost: {
        resolveProfile: fixtureProfileResolver(),
        withEngine: (_record, use) => use(fixtureEngineAdapter()),
      },
    }),
  });
  t.after(async () => { await server.close(); });
  const runner = await enroll(stateDir, server, 'runner');

  const sandbox = await runner.client.requestResource('createSandbox', {}, {
    requestId: randomUUID(), engine: 'fixture', profile: 'dev',
  });
  const job = await runner.client.requestResource('submitJob',
    { sandboxId: sandbox.sandboxId },
    { requestId: randomUUID(), engine: 'fixture', payload: { prompt: 'replay' } });

  const declared = {
    totalLength: patchBytes.length,
    sha256: recomputeDigest(patchBytes),
    label: PATCH_LABEL,
    data: patchBytes.toString('base64'),
  };

  // (a) An exact replay of a completed registration is idempotent: the
  // identical receipt comes back and no second artifact row appears.
  const requestId = randomUUID();
  const first = await runner.client.requestResource('registerJobOutput',
    { jobId: job.jobId }, { requestId, ...declared });
  assert.equal(first.requestId, requestId);
  assert.match(first.artifactId, /^[0-9a-f-]{36}$/);
  assert.equal(first.sha256, declared.sha256);
  assert.equal(first.totalLength, declared.totalLength);
  const replay = await runner.client.requestResource('registerJobOutput',
    { jobId: job.jobId }, { requestId, ...declared });
  assert.deepEqual(replay, first);
  const receiptsAfterReplay = await runner.artifacts.listJobOutputs({ jobId: job.jobId });
  assert.equal(receiptsAfterReplay.length, 1);
  assert.equal(receiptsAfterReplay[0].artifactId, first.artifactId);

  // (c) A replay of the same request key with changed metadata conflicts at
  // begin, before any byte is read or stored: a changed declared sha256 and
  // a changed declared totalLength are both request-key reuse conflicts.
  await assert.rejects(
    runner.client.requestResource('registerJobOutput', { jobId: job.jobId }, {
      requestId, ...declared, sha256: recomputeDigest(Buffer.from('differing')),
    }),
    { code: 'HTTP_STATUS', statusCode: 409, resourceCode: 'conflict' }
  );
  await assert.rejects(
    runner.client.requestResource('registerJobOutput', { jobId: job.jobId }, {
      requestId, ...declared,
      totalLength: declared.totalLength - 1,
      data: patchBytes.subarray(0, declared.totalLength - 1).toString('base64'),
    }),
    { code: 'HTTP_STATUS', statusCode: 409, resourceCode: 'conflict' }
  );

  // (b) A replay that resumes an interrupted upload with differing suffix
  // bytes fails digest_mismatch at finish and republishes nothing. The
  // interrupted first attempt is prepared at the store level: its request
  // fingerprint and a matching byte prefix are durable, while the reply and
  // the finish never happened. The route replay must resume from the stored
  // prefix (a full re-append from offset 0 would fail as a chunk conflict,
  // not as a digest mismatch) and the finish re-hash must reject the
  // assembled bytes because their suffix differs from the declared digest.
  const interruptedRequestId = randomUUID();
  const prefixLength = Math.floor(patchBytes.length / 2);
  const preparer = openArtifactStore(stateDir);
  let interrupted;
  try {
    interrupted = preparer.beginUpload({
      project: PROJECT, requestId: interruptedRequestId,
      totalLength: declared.totalLength, sha256: declared.sha256,
    });
    preparer.appendChunk({
      project: PROJECT, artifactId: interrupted.artifactId,
      offset: 0, data: patchBytes.subarray(0, prefixLength).toString('base64'),
    });
  } finally {
    preparer.close();
  }
  assert.equal(interrupted.state, 'uploading');

  const tampered = Buffer.from(patchBytes);
  tampered[prefixLength] = tampered[prefixLength] ^ 0x20;
  assert.notEqual(tampered.toString('base64'), declared.data);
  await assert.rejects(
    runner.client.requestResource('registerJobOutput', { jobId: job.jobId }, {
      requestId: interruptedRequestId, ...declared,
      data: tampered.toString('base64'),
    }),
    { code: 'HTTP_STATUS', statusCode: 422, resourceCode: 'digest_mismatch' }
  );

  // Nothing was republished: the interrupted artifact failed closed with its
  // chunk bytes discarded, the job receipt list is unchanged, and the exact
  // bytes registered in (a) remain the job's only published output.
  const peerArtifacts = openArtifactStore(stateDir);
  const peerWork = openWorkStore(stateDir);
  try {
    const failed = peerArtifacts.getArtifact({
      project: PROJECT, artifactId: interrupted.artifactId,
    });
    assert.equal(failed.state, 'failed');
    assert.equal(failed.chunkCount, 0);
    assert.equal(failed.publishedAt, null);
    const published = peerArtifacts.listArtifacts(PROJECT)
      .filter(entry => entry.state === 'published');
    assert.deepEqual(published.map(entry => entry.artifactId), [first.artifactId]);
    const receipts = peerWork.getJobArtifacts(
      { project: PROJECT, clientId: 'peer-reader', role: 'runner' }, job.jobId);
    assert.deepEqual(receipts.map(entry => entry.artifactId), [first.artifactId]);
    // The store queries the same normalized job id it validated: a padded
    // id resolves the same receipts instead of silently missing them.
    const padded = peerWork.getJobArtifacts(
      { project: PROJECT, clientId: 'peer-reader', role: 'runner' },
      `  ${job.jobId}  `);
    assert.deepEqual(padded.map(entry => entry.artifactId), [first.artifactId]);
  } finally {
    peerArtifacts.close();
    peerWork.close();
  }
  const stillReadable = await runner.artifacts.readPatchBytes({
    jobId: job.jobId, artifactId: first.artifactId,
    totalLength: first.totalLength, sha256: first.sha256,
  });
  assert.ok(stillReadable.data.equals(patchBytes), 'the registered bytes are unchanged');
});

