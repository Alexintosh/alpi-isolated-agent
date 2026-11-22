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
 * - The `job.submitted` event is committed atomically with the job row:
 *   the work store appends it inside the same admission transaction, so an
 *   acknowledged job always has exactly one submitted event, even if the
 *   process dies between the commit and the caller receiving the receipt.
 *   An idempotent replay returns the persisted receipt without appending
 *   another event.
 * - A job is scoped to the engine of its sandbox workspace. A submission that
 *   names a different engine than the workspace is refused by the work store
 *   inside the admission transaction, after the not_found gate that treats an
 *   unknown or deleted sandbox as missing regardless of the engine named.
 * - Workspaces are provisioned and released through the sandbox service; this
 *   module never widens retention and never deletes a workspace itself.
 * - Reconnection never duplicates admission. A fresh client process
 *   reattaching with the persisted credential either replays the original
 *   submission (the store's duplicate-admission branch returns the persisted
 *   receipt) or resolves the job explicitly with lookupJob, a read scoped to
 *   the caller's own (project, clientId, requestId) key. The lookup is
 *   observer-safe: whatever the caller's role, only its own row is reachable
 *   and nothing is allocated, so exactly one job row, one job.submitted
 *   event, one workspace and one idempotency receipt ever exist.
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

    // Durability boundary: the work store commits the acknowledged job row,
    // its idempotency receipt and the `job.submitted` event in a single
    // BEGIN IMMEDIATE transaction, so the caller is only acknowledged after
    // the submission survives a restart and the event can never lag the job.
    // The store is the single admission authority for the sandbox: an
    // unknown, cross-project or deleted sandbox is `not_found` inside that
    // transaction, before any engine comparison, so this service performs no
    // separate workspace read and cannot disagree with the committed state
    // it admits against.
    const { job } = store.submitJob(principalInput, {
      requestId,
      sandboxId,
      engine: engine.id,
      payload: body.payload === undefined ? {} : body.payload,
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

  function lookupJob(principalInput, input) {
    const body = normalizeInputObject(input);
    const requestId = normalizeRequestId(body.requestId);
    return store.getJobByRequestId(principalInput, requestId);
  }

  return Object.freeze({ submitJob, cancelJob, lookupJob });
}

module.exports = {
  JobServiceError,
  createJobService,
};
