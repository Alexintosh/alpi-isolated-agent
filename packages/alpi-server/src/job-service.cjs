'use strict';

/**
 * Packaged job submission service for Alpi Server.
 *
 * This module owns the admission path for jobs submitted through the packaged
 * HTTPS API (POST /v1/sandboxes/:sandboxId/jobs) and the cooperative
 * cancellation path (POST /v1/jobs/:jobId/cancel). It contains no engine,
 * harness or guest execution: dispatch to a native session is a separate
 * milestone and nothing here starts one.
 *
 * Invariants:
 * - The engine choice is explicit. A submission without an engine is refused
 *   and no default engine is ever selected. Test-only engines resolve only
 *   through a registry created with allowTestAdapters: true (dev/test). A
 *   production registry cannot contain them, so a test engine can never be
 *   admitted there and an unavailable engine never falls back to another one.
 * - The job row is committed durably in the work store before the submission
 *   is acknowledged, and the returned receipt is the persisted receipt. A
 *   restart on the same state directory finds the acknowledged job.
 * - A job is scoped to the engine of its sandbox workspace. A submission that
 *   names a different engine than the workspace is refused.
 * - Workspaces are provisioned and released through the sandbox service; this
 *   module never widens retention and never deletes a workspace itself.
 * - Cancellation only advances the durable disposition graph. Because this
 *   milestone dispatches nothing after acknowledgement, a cooperative cancel
 *   completes immediately without claiming any native termination.
 */

const { EngineRegistryError } = require('./engines/registry.cjs');

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENGINE_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const TERMINAL_DISPOSITIONS = new Set(['completed', 'failed', 'cancelled']);

class JobServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JobServiceError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new JobServiceError(code, message);
}

function invalidInput(message) {
  fail('invalid_input', message || 'Invalid input.');
}

function normalizeInputObject(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    invalidInput();
  }
  return input;
}

function normalizeRequestId(value) {
  if (typeof value !== 'string' || !REQUEST_ID_PATTERN.test(value)) {
    invalidInput('A request key of 1-128 characters is required.');
  }
  return value;
}

/**
 * Create a job submission service.
 *
 * @param {{
 *   store: object,
 *   engineRegistry: object,
 * }} options
 */
function createJobService(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    fail('invalid_input', 'Job service options must be an object.');
  }
  const { store, engineRegistry } = options;
  if (!store || typeof store.submitJob !== 'function') {
    fail('invalid_input', 'A work store is required.');
  }
  if (!engineRegistry || typeof engineRegistry.requireSelectable !== 'function') {
    fail('invalid_input', 'An engine registry is required.');
  }
  function selectableEngine(value) {
    if (typeof value !== 'string' || !ENGINE_ID_PATTERN.test(value)) {
      invalidInput('An explicit engine is required for job submission.');
    }
    try {
      return engineRegistry.requireSelectable(value);
    } catch (error) {
      if (error instanceof EngineRegistryError) {
        fail('engine_unsupported', 'The requested engine is not available for jobs.');
      }
      throw error;
    }
  }

  function submitJob(principalInput, input) {
    const body = normalizeInputObject(input);
    const engine = selectableEngine(body.engine);
    const sandboxId = body.sandboxId;
    if (typeof sandboxId !== 'string' || !UUID_PATTERN.test(sandboxId)) {
      invalidInput('A sandbox identifier is required.');
    }
    const requestId = normalizeRequestId(body.requestId);

    // Project-scoped: a cross-project sandbox is indistinguishable from a
    // missing one, and a deleted workspace cannot accept new jobs.
    const workspace = store.getSandbox(principalInput, sandboxId);
    if (workspace.engine !== engine.id) {
      fail(
        'engine_identity_conflict',
        'The submitted engine does not match the sandbox engine.'
      );
    }

    // Durability boundary: the work store commits the acknowledged job row
    // (and its idempotency receipt) before this call returns, so the caller
    // is only acknowledged after the submission survives a restart.
    const job = store.submitJob(principalInput, {
      requestId,
      workspaceId: workspace.workspaceId,
      payload: body.payload === undefined ? {} : body.payload,
    });

    // The submission event gives observers a defined event cursor through the
    // same packaged route. A replay after a partial failure reuses the same
    // job id and converges on the same event stream.
    store.appendEvent(principalInput, {
      type: 'job.submitted',
      jobId: job.jobId,
    });
    return job;
  }

  function cancelJob(principalInput, input) {
    const body = normalizeInputObject(input);
    const jobId = normalizeRequestId(body.jobId);
    const job = store.getJob(principalInput, jobId);
    if (TERMINAL_DISPOSITIONS.has(job.disposition)) {
      return job;
    }
    // Nothing is dispatched after acknowledgement in this milestone, so the
    // cooperative cancel is complete once it is durably recorded. The strict
    // disposition graph keeps the request and the observed state separate.
    store.markJob(principalInput, { jobId, disposition: 'cancelRequested' });
    return store.markJob(principalInput, { jobId, disposition: 'cancelled' });
  }

  return Object.freeze({ submitJob, cancelJob });
}

module.exports = {
  JobServiceError,
  createJobService,
};
