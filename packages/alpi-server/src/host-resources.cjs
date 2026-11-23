'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { createSandboxService, SandboxServiceError } = require('./sandbox-service.cjs');
const { openArtifactStore, MAX_CHUNK_BYTES } = require('./artifact-store.cjs');
const { openWorkStore } = require('./work-store.cjs');
const { createJobService } = require('./job-service.cjs');
const { createEngineRegistry } = require('./engines/registry.cjs');
const { createBoxliteAdapter } = require('./engines/boxlite.cjs');

const maxEventPageBytes = 48 * 1024;

function publicJob(job) {
  const { jobId, project, workspaceId, sessionUuid, disposition, createdAt, updatedAt } = job;
  return { jobId, project, workspaceId, sessionUuid, disposition, createdAt, updatedAt };
}

function publicEvents(page, after) {
  const events = [];
  let bytes = 0;
  for (const event of page.events) {
    const { type, seq, jobId, createdAt, data } = event;
    const item = { type, seq, jobId, createdAt };
    // Only the normalized text emitted by the job adapter is part of the public event contract.
    if (typeof data?.text === 'string') {
      item.untrustedText = data.text.slice(0, 2048);
      item.truncated = item.untrustedText.length !== data.text.length;
    }
    const size = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (bytes + size > maxEventPageBytes) break;
    events.push(item);
    bytes += size;
  }
  return { events, nextSeq: events.at(-1)?.seq ?? (page.events.length ? after : page.nextSeq),
    firstSeq: page.firstSeq, lastSeq: page.lastSeq, gap: page.gap, reset: page.reset };
}

const lifecycleRoutes = new Set(['listSandboxes', 'getSandbox', 'createSandbox',
  'startSandbox', 'stopSandbox', 'deleteSandbox', 'exec']);

// Route parameters come from the path; a body that repeats one is a client
// error. The merge would let the path value win silently, so conflicts are
// rejected before it, identically for every parameterised route.
function rejectDuplicateRouteParams(request) {
  if (Object.keys(request.params).some(key => Object.hasOwn(request.body, key))) {
    throw Object.assign(new Error('Duplicate route parameter.'), { code: 'invalid_input' });
  }
}

// The packaged production registry installs only verified production engine
// factories and never allows test-only adapters. Dev/test hosts may supply
// their own registry or enable the test gate explicitly.
function defaultEngineRegistry(allowTestEngines) {
  const registry = createEngineRegistry({ allowTestAdapters: allowTestEngines === true });
  if (allowTestEngines !== true) {
    registry.install({
      id: 'boxlite',
      factory: (adapterOptions) => createBoxliteAdapter(adapterOptions),
    });
  }
  return registry;
}

function publicSandbox(sandbox) {
  const { sandboxId, workspaceId, project, engine, engineVersion, profile, imageDigest, resources,
    generation, desiredState, observedState, recoveryRequired, retention, expiresAt, createdAt, updatedAt } = sandbox;
  return { sandboxId, workspaceId, project, engine, engineVersion, profile, imageDigest, resources,
    generation, desiredState, observedState, recoveryRequired, retention, expiresAt, createdAt, updatedAt };
}

async function openHostResources({ stateDir, limits, services = {}, sandboxHost, engines, allowTestEngines, sweepIntervalMs = 60000 }) {
  const store = openWorkStore(stateDir, { limits });
  const admission = new AsyncLocalStorage();
  const active = new Set();
  const testWork = new Set();
  const testAbort = new AbortController();
  let closing = false;
  let artifacts;
  let sandbox;
  let jobService;
  try {
    artifacts = openArtifactStore(stateDir);
    artifacts.collectGarbage();
    sandbox = createSandboxService({ store, stateDir,
      resolveProfile: sandboxHost?.resolveProfile ?? (() => {
        throw new SandboxServiceError('profile_unavailable', 'Profile unavailable.', { status: 503 });
      }),
      withEngine: sandboxHost?.withEngine ?? (() => {
        throw new SandboxServiceError('engine_unavailable', 'Engine unavailable.', { status: 503 });
      }),
      authorize() {
        const authenticate = admission.getStore();
        if (authenticate) authenticate();
      },
    });
    jobService = createJobService({
      store,
      engineRegistry: engines || defaultEngineRegistry(allowTestEngines),
    });
    await sandbox.recoverStartup();
  } catch (error) {
    sandbox?.close();
    artifacts?.close();
    store.close();
    throw error;
  }
  let sweep;
  const timer = setInterval(() => {
    if (closing || sweep) return;
    sweep = sandbox.sweepTtl().catch(() => {}).finally(() => { sweep = undefined; });
  }, sweepIntervalMs);
  timer.unref();
  let nextCollection = Date.now() + 60000;
  const artifactFields = {
    beginUpload: ['requestId', 'totalLength', 'sha256'], appendChunk: ['offset', 'data'],
    finishUpload: [], getArtifact: [], readChunk: [], acknowledge: [],
  };
  // Job output registration accepts the complete artifact in one bounded
  // body: it is delegated to the durable artifact store (begin, one chunk,
  // finish) instead of any parallel storage mechanism. The single-chunk
  // bound keeps the attachment atomic for patches; larger outputs go through
  // the generic artifact routes.
  const jobOutputFields = ['requestId', 'totalLength', 'sha256', 'label', 'data'];
  const jobOutputBase64 = /^[A-Za-z0-9+/]+={0,2}$/;
  async function execute(request) {
    const { name, principal, params } = request;
    if (lifecycleRoutes.has(name)) {
      rejectDuplicateRouteParams(request);
      const input = { ...request.body, ...params };
      const method = name === 'exec' ? 'execInSandbox' : name;
      if (name === 'exec' && (input.maxOutputBytes === undefined ||
          (Number.isSafeInteger(input.maxOutputBytes) && input.maxOutputBytes > 8192))) {
        // The pinned JSON transport also needs room for escaping control characters.
        input.maxOutputBytes = 8192;
      }
      const result = await admission.run(request.authenticate, () => sandbox[method](principal, input))
        .catch(error => { request.authenticate?.(); throw error; });
      if (name === 'listSandboxes') {
        const page = [];
        let bytes = 0;
        for (const entry of result.sandboxes) {
          const row = publicSandbox(entry);
          bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
          if (bytes > maxEventPageBytes) break;
          page.push(row);
        }
        return { sandboxes: page, count: result.count, truncated: page.length < result.count };
      }
      if (name === 'exec') return result;
      const { sandbox: receipt, ...operation } = result;
      return { ...publicSandbox(receipt), ...operation };
    }
    if (Object.hasOwn(artifactFields, name)) {
      const fields = artifactFields[name];
      const body = request.body;
      if (Object.keys(body).length !== fields.length || fields.some(key => !Object.hasOwn(body, key))) {
        throw Object.assign(new Error('Unexpected artifact request.'), { code: 'invalid_input' });
      }
      if (name === 'beginUpload' && Date.now() >= nextCollection) {
        artifacts.collectGarbage();
        nextCollection = Date.now() + 60000;
      }
      const input = { ...body, ...params, project: principal.project };
      if (name === 'readChunk') input.offset = Number(params.offset);
      return artifacts[name](input);
    }
    switch (name) {
      case 'registerJobOutput': {
        rejectDuplicateRouteParams(request);
        const body = request.body;
        if (Object.keys(body).length !== jobOutputFields.length ||
            jobOutputFields.some(key => !Object.hasOwn(body, key))) {
          throw Object.assign(new Error('Unexpected job output request.'),
            { code: 'invalid_input' });
        }
        if (typeof body.data !== 'string' || body.data.length === 0 ||
            body.data.length % 4 !== 0 || !jobOutputBase64.test(body.data)) {
          throw Object.assign(new Error('Invalid job output encoding.'),
            { code: 'invalid_input' });
        }
        if (Date.now() >= nextCollection) {
          artifacts.collectGarbage();
          nextCollection = Date.now() + 60000;
        }
        // The artifact store is the only byte authority: it assigns the
        // artifact id, enforces the declared length and digest, and refuses
        // to publish bytes that do not hash to the declared sha256.
        const begun = artifacts.beginUpload({
          project: principal.project,
          requestId: body.requestId,
          totalLength: body.totalLength,
          sha256: body.sha256,
        });
        if (begun.state === 'uploading') {
          const decoded = Buffer.from(body.data, 'base64');
          if (decoded.length === 0 || decoded.length !== begun.totalLength ||
              decoded.length > MAX_CHUNK_BYTES || decoded.toString('base64') !== body.data) {
            throw Object.assign(new Error('Job output length mismatch.'),
              { code: 'invalid_input' });
          }
          if (begun.receivedBytes < decoded.length) {
            // A replay after a lost reply resumes from the stored prefix; the
            // finish below still hashes the assembled stream, so bytes that
            // differ from a previous attempt fail as digest_mismatch.
            artifacts.appendChunk({
              project: principal.project,
              artifactId: begun.artifactId,
              offset: begun.receivedBytes,
              data: decoded.subarray(begun.receivedBytes).toString('base64'),
            });
          }
        }
        const published = artifacts.finishUpload({
          project: principal.project, artifactId: begun.artifactId,
        });
        const recorded = store.recordJobArtifact(principal, {
          jobId: params.jobId,
          artifactId: published.artifactId,
          label: body.label,
          totalLength: published.totalLength,
          sha256: published.sha256,
        });
        // The request key the caller used is echoed so a lost reply can be
        // correlated with its idempotent replay without a second lookup.
        return { ...recorded, requestId: published.requestId };
      }
      case 'getJobArtifacts': {
        const outputs = store.getJobArtifacts(principal, params.jobId);
        return { artifacts: outputs, count: outputs.length };
      }
      case 'submitJob': {
        rejectDuplicateRouteParams(request);
        const job = jobService.submitJob(principal, { ...request.body, ...params });
        // Only an explicitly configured local test registry can dispatch this
        // hook. Admission is already durable; work belongs to the daemon and
        // is independent of the request socket or the MCP process lifetime.
        const pending = engines?.runTestJob?.(request.body.engine, {
          job, sandboxId: params.sandboxId, principal, store, signal: testAbort.signal,
          attachPatch: (body) => execute({ name: 'registerJobOutput', principal,
            params: { jobId: job.jobId }, body }),
        });
        if (pending) {
          testWork.add(pending);
          const settled = () => testWork.delete(pending);
          pending.then(settled, settled);
        }
        return publicJob(job);
      }
      case 'cancelJob':
        rejectDuplicateRouteParams(request);
        return publicJob(jobService.cancelJob(principal, { ...request.body, ...params }));
      case 'getJob':
        return publicJob(store.getJob(principal, params.jobId));
      case 'getEvents': {
        const after = Number(params.after);
        return publicEvents(store.pollJobEvents(principal, { jobId: params.jobId, afterSeq: after }), after);
      }
      case 'lookupJob': {
        // Like the artifact routes, the lookup body carries exactly its
        // declared keys: a missing or unknown field is a client error
        // instead of a silent ignore, so a malformed reconnect lookup can
        // never be mistaken for a missing job.
        const fields = ['requestId'];
        const body = request.body;
        if (Object.keys(body).length !== fields.length ||
            fields.some(key => !Object.hasOwn(body, key))) {
          throw Object.assign(new Error('Unexpected job lookup request.'), { code: 'invalid_input' });
        }
        return publicJob(jobService.lookupJob(principal, request.body));
      }
      default:
        if (Object.hasOwn(services, name)) return services[name](request, store);
        throw Object.assign(new Error('Requested service unavailable.'),
          { code: 'service_unavailable' });
    }
  }
  return {
    execute(request) {
      if (closing) throw Object.assign(new Error('Service is closing.'), { code: 'service_unavailable' });
      const pending = execute(request);
      active.add(pending);
      const settled = () => active.delete(pending);
      pending.then(settled, settled);
      return pending;
    },
    async close() {
      closing = true;
      clearInterval(timer);
      await Promise.allSettled([...active, sweep]);
      testAbort.abort();
      await Promise.allSettled([...testWork]);
      await sandbox.settle();
      try { sandbox.close(); } finally {
        try { artifacts.close(); } finally { store.close(); }
      }
    },
  };
}

module.exports = { openHostResources };
