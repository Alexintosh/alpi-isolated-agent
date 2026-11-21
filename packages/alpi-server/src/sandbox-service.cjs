'use strict';

/**
 * Sandbox control service for Alpi Server.
 *
 * This module owns the lifecycle *between* the durable work store and a
 * launch-scoped engine adapter supplied by the trusted coordinator:
 *
 *   caller -> authenticated principal -> sandbox-service -> work-store
 *                                                     -> sandbox-journal
 *                                                     -> withEngine(adapter)
 *
 * The service never imports an engine adapter and never falls back to a fake
 * adapter. `resolveProfile` and `withEngine` are injected by the host. The
 * caller names only an engine and profile; image digest, engine version,
 * resource limits and network mode come from the trusted operator resolver.
 *
 * Invariants:
 * - Intent is persisted before an external side effect.
 * - Operations are serialized per sandbox and bounded by a queue.
 * - The store generation and the native allocation generation are distinct.
 *   Stopping a sandbox advances the store generation but never the native
 *   allocation generation.
 * - A retried create with the same requestId returns the same sandbox and
 *   native id even after the operator profile pins change.
 * - Capacity is released only after confirmed engine absence and retention
 *   acknowledgement (or an explicit operator discard).
 * - Cross-project identifiers are indistinguishable from missing ones.
 * - Engine error text, host paths and raw provider output are never exposed.
 */

const crypto = require('node:crypto');

const {
  SandboxJournalError,
  openSandboxJournal,
} = require('./sandbox-journal.cjs');

const ROLES = new Set(['observer', 'runner', 'operator']);
const RETENTIONS = new Set(['ephemeral', 'ttl', 'until-export']);
const OPERATIONS = new Set([
  'create',
  'list',
  'get',
  'start',
  'stop',
  'delete',
  'exec',
  'status',
]);
const NETWORK_MODES = new Set(['disabled', 'boundary']);
const REQUIRED_ENGINE_CAPABILITIES = Object.freeze([
  'create',
  'inspect',
  'start',
  'stop',
  'destroy',
  'list-owned',
  'exec',
]);

const MAX_TEXT_LENGTH = 128;
const MAX_REQUEST_ID_LENGTH = 128;
const MAX_ENGINE_LENGTH = 64;
const MAX_ENGINE_VERSION_LENGTH = 64;
const MAX_PROFILE_LENGTH = 128;
const MAX_IMAGE_DIGEST_LENGTH = 256;
const MAX_REASON_LENGTH = 256;
const MAX_PATH_LENGTH = 2048;
const MAX_ARG_BYTES = 4096;
const MAX_ARGV_BYTES = 65536;
const MAX_WORKING_DIR_LENGTH = 4096;
const MAX_LIST_ITEMS = 1000;
const MAX_EXEC_TIMEOUT_MS = 300_000;
const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
const MAX_EXEC_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_EXEC_OUTPUT_BYTES = 1 * 1024 * 1024;
const DEFAULT_OPERATION_TIMEOUT_MS = 120_000;
const MAX_OPERATION_TIMEOUT_MS = 600_000;
const DEFAULT_QUEUE_PER_SANDBOX = 32;
const MAX_QUEUE_PER_SANDBOX = 256;
const DEFAULT_MAX_CONCURRENT_OPERATIONS = 8;
const MAX_CONCURRENT_OPERATIONS = 64;

const DEFAULT_PROJECT_QUOTA = Object.freeze({
  maxSandboxes: 16,
  maxVcpus: 16,
  maxMemoryMiB: 16384,
  maxDiskMiB: 102400,
});

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENGINE_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const PINNED_DIGEST_PATTERN =
  /^(?:[^\s@]+@)?sha256:[a-f0-9]{64}$/i;

const WORK_STORE_ERRORS = Object.freeze({
  invalid_input: { code: 'invalid_input', status: 400, retryable: false },
  forbidden: { code: 'forbidden', status: 403, retryable: false },
  not_found: { code: 'not_found', status: 404, retryable: false },
  idempotency_conflict: {
    code: 'idempotency_conflict',
    status: 409,
    retryable: false,
  },
  generation_conflict: {
    code: 'generation_conflict',
    status: 409,
    retryable: false,
  },
  invalid_transition: {
    code: 'invalid_transition',
    status: 409,
    retryable: false,
  },
  export_required: { code: 'export_required', status: 409, retryable: false },
  quota_exceeded: { code: 'quota_exceeded', status: 429, retryable: true },
  store_busy: { code: 'store_busy', status: 503, retryable: true },
  store_closed: { code: 'store_unavailable', status: 503, retryable: false },
  store_error: { code: 'store_error', status: 500, retryable: false },
  store_unavailable: {
    code: 'store_unavailable',
    status: 503,
    retryable: true,
  },
  payload_too_large: {
    code: 'payload_too_large',
    status: 413,
    retryable: false,
  },
  lease_held: { code: 'lease_held', status: 409, retryable: false },
  lease_missing: { code: 'lease_missing', status: 409, retryable: false },
  lease_stale: { code: 'lease_stale', status: 409, retryable: false },
  lease_expired: { code: 'lease_expired', status: 403, retryable: false },
  unsafe_state_directory: {
    code: 'internal_error',
    status: 500,
    retryable: false,
  },
  unsafe_database_file: {
    code: 'internal_error',
    status: 500,
    retryable: false,
  },
});

const JOURNAL_ERRORS = Object.freeze({
  invalid_input: { code: 'invalid_input', status: 400, retryable: false },
  not_found: { code: 'not_found', status: 404, retryable: false },
  idempotency_conflict: {
    code: 'idempotency_conflict',
    status: 409,
    retryable: false,
  },
  invalid_transition: {
    code: 'invalid_transition',
    status: 409,
    retryable: false,
  },
  journal_busy: { code: 'journal_busy', status: 503, retryable: true },
  journal_closed: {
    code: 'journal_unavailable',
    status: 503,
    retryable: false,
  },
  journal_error: { code: 'journal_error', status: 500, retryable: false },
  journal_unavailable: {
    code: 'journal_unavailable',
    status: 503,
    retryable: true,
  },
  unsafe_state_directory: {
    code: 'internal_error',
    status: 500,
    retryable: false,
  },
  unsafe_database_file: {
    code: 'internal_error',
    status: 500,
    retryable: false,
  },
});

const ENGINE_ERRORS = Object.freeze({
  unavailable_engine: {
    code: 'engine_unavailable',
    status: 503,
    retryable: true,
    message: 'Engine is unavailable.',
  },
  engine_unavailable: {
    code: 'engine_unavailable',
    status: 503,
    retryable: true,
    message: 'Engine is unavailable.',
  },
  unsupported_capability: {
    code: 'engine_unsupported',
    status: 422,
    retryable: false,
    message: 'Engine does not support the required capability.',
  },
  unsupported_profile: {
    code: 'engine_unsupported',
    status: 422,
    retryable: false,
    message: 'Engine does not support the selected profile.',
  },
  invalid_engine_config: {
    code: 'engine_unqualified',
    status: 503,
    retryable: false,
    message: 'Engine configuration is not qualified.',
  },
  network_unavailable: {
    code: 'network_unavailable',
    status: 503,
    retryable: false,
    message: 'Network mode is unavailable.',
  },
  network_boundary_invalid: {
    code: 'network_unavailable',
    status: 503,
    retryable: false,
    message: 'Network boundary is invalid.',
  },
  network_boundary_prepare_failed: {
    code: 'network_unavailable',
    status: 503,
    retryable: true,
    message: 'Network boundary preparation failed.',
  },
  network_boundary_verify_failed: {
    code: 'network_unavailable',
    status: 503,
    retryable: true,
    message: 'Network boundary verification failed.',
  },
  network_boundary_unverified: {
    code: 'network_unavailable',
    status: 503,
    retryable: false,
    message: 'Network boundary was not verified.',
  },
  engine_create_failed: {
    code: 'engine_uncertain',
    status: 503,
    retryable: true,
    message: 'Engine create outcome is uncertain.',
  },
  engine_identity_mismatch: {
    code: 'engine_identity_conflict',
    status: 409,
    retryable: false,
    message: 'Engine identity does not match the owned allocation.',
  },
  engine_generation_mismatch: {
    code: 'generation_conflict',
    status: 409,
    retryable: false,
    message: 'Engine allocation generation is stale.',
  },
  engine_unknown_allocation: {
    code: 'engine_uncertain',
    status: 409,
    retryable: true,
    message: 'Engine allocation is not owned by this adapter.',
  },
  engine_box_missing: {
    code: 'engine_uncertain',
    status: 410,
    retryable: true,
    message: 'Engine box is missing.',
  },
  engine_stop_unverified: {
    code: 'engine_uncertain',
    status: 503,
    retryable: true,
    message: 'Engine stop is unverified.',
  },
  engine_destroy_unverified: {
    code: 'engine_uncertain',
    status: 503,
    retryable: true,
    message: 'Engine removal is unverified.',
  },
  engine_state_corrupt: {
    code: 'engine_state_error',
    status: 500,
    retryable: false,
    message: 'Engine state is unavailable.',
  },
  engine_state_write_failed: {
    code: 'engine_state_error',
    status: 500,
    retryable: false,
    message: 'Engine state is unavailable.',
  },
  engine_closed: {
    code: 'engine_unavailable',
    status: 503,
    retryable: true,
    message: 'Engine is unavailable.',
  },
  engine_runtime_invalid: {
    code: 'engine_unavailable',
    status: 503,
    retryable: true,
    message: 'Engine runtime is invalid.',
  },
  engine_exec_stream_failed: {
    code: 'exec_failed',
    status: 502,
    retryable: false,
    message: 'Execution failed.',
  },
  engine_exec_failed: {
    code: 'exec_failed',
    status: 502,
    retryable: false,
    message: 'Execution failed.',
  },
  engine_exec_invalid_result: {
    code: 'exec_failed',
    status: 502,
    retryable: false,
    message: 'Execution returned an invalid result.',
  },
  engine_termination_unverified: {
    code: 'exec_uncertain',
    status: 504,
    retryable: false,
    message: 'Execution termination is unverified.',
  },
  engine_cancelled: {
    code: 'exec_cancelled',
    status: 409,
    retryable: false,
    message: 'Execution was cancelled.',
  },
});

class SandboxServiceError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'SandboxServiceError';
    this.code = code;
    this.status = options.status === undefined ? 500 : options.status;
    this.retryable = options.retryable === true;
    this.operation = options.operation;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      status: this.status,
      ...(this.operation === undefined ? {} : { operation: this.operation }),
    };
  }
}

function fail(code, message, options) {
  throw new SandboxServiceError(code, message, options);
}

function invalidInput(message = 'Invalid input.') {
  fail('invalid_input', message, { status: 400, retryable: false });
}

function forbidden(message = 'Operation is not permitted for this role.') {
  fail('forbidden', message, { status: 403, retryable: false });
}

function notFound(message = 'Resource not found.') {
  fail('not_found', message, { status: 404, retryable: false });
}

function invalidTransition(message) {
  fail('invalid_transition', message, { status: 409, retryable: false });
}

function normalizeText(value, maxLength) {
  if (typeof value !== 'string') {
    invalidInput();
  }
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > maxLength ||
    CONTROL_CHARACTERS.test(trimmed)
  ) {
    invalidInput();
  }
  return trimmed;
}

function normalizeOptionalText(value, maxLength) {
  if (value === undefined || value === null) {
    return null;
  }
  return normalizeText(value, maxLength);
}

function normalizeUuid(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    invalidInput();
  }
  return value.toLowerCase();
}

function normalizePositiveInteger(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    invalidInput();
  }
  return value;
}

function normalizeOptionalPositiveInteger(value) {
  if (value === undefined || value === null) {
    return null;
  }
  return normalizePositiveInteger(value);
}

function normalizeRole(value) {
  if (typeof value !== 'string' || !ROLES.has(value)) {
    invalidInput();
  }
  return value;
}

function normalizePrincipal(principal) {
  if (
    principal === null ||
    typeof principal !== 'object' ||
    Array.isArray(principal)
  ) {
    invalidInput();
  }
  return Object.freeze({
    clientId: normalizeText(principal.clientId, MAX_TEXT_LENGTH),
    project: normalizeText(principal.project, MAX_TEXT_LENGTH),
    role: normalizeRole(principal.role),
  });
}

function requireWriter(principal) {
  if (principal.role === 'observer') {
    forbidden();
  }
}

function requireOperator(principal) {
  if (principal.role !== 'operator') {
    forbidden();
  }
}

function normalizeInputObject(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    invalidInput();
  }
  return input;
}

function rejectUnknownKeys(input, allowed) {
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      invalidInput('Unsupported input field.');
    }
  }
}

function canonicalize(value) {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      invalidInput();
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const result = {};
    for (const key of keys) {
      result[key] = canonicalize(value[key]);
    }
    return result;
  }
  invalidInput();
}

function digestOf(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalize(value)), 'utf8')
    .digest('hex');
}

function createClock(now) {
  if (now === undefined) {
    return () => Date.now();
  }
  if (typeof now !== 'function') {
    invalidInput('Invalid clock.');
  }
  return () => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) {
      fail('internal_error', 'Internal service error.', {
        status: 500,
        retryable: false,
      });
    }
    return value;
  };
}

function mapFrom(table, error, operation) {
  const entry = table[error.code];
  if (!entry) {
    return new SandboxServiceError(
      'internal_error',
      'Internal service error.',
      { status: 500, retryable: false, operation }
    );
  }
  return new SandboxServiceError(entry.code, entry.message || 'Request failed.', {
    status: entry.status,
    retryable: entry.retryable,
    operation,
  });
}

function mapError(error, operation) {
  if (error instanceof SandboxServiceError) {
    return error;
  }
  if (error && error.name === 'WorkStoreError') {
    return mapFrom(WORK_STORE_ERRORS, error, operation);
  }
  if (error instanceof SandboxJournalError) {
    return mapFrom(JOURNAL_ERRORS, error, operation);
  }
  if (
    error &&
    typeof error.code === 'string' &&
    Object.prototype.hasOwnProperty.call(ENGINE_ERRORS, error.code)
  ) {
    const entry = ENGINE_ERRORS[error.code];
    return new SandboxServiceError(entry.code, entry.message, {
      status: entry.status,
      retryable: entry.retryable,
      operation,
    });
  }
  return new SandboxServiceError(
    'internal_error',
    'Internal service error.',
    { status: 500, retryable: false, operation }
  );
}

/**
 * Convert any thrown value into a sanitized HTTP-shaped error.
 *
 * The engine's raw message, stack, details and host paths are never copied.
 */
function httpErrorFor(error) {
  const mapped = mapError(error);
  return {
    status: mapped.status,
    body: {
      error: {
        code: mapped.code,
        message: mapped.message,
        retryable: mapped.retryable,
      },
    },
  };
}

function normalizeCreateInput(input) {
  const body = normalizeInputObject(input);
  rejectUnknownKeys(
    body,
    new Set(['requestId', 'engine', 'profile', 'retention', 'ttlSeconds'])
  );
  const requestId = normalizeText(body.requestId, MAX_REQUEST_ID_LENGTH);
  const engine = normalizeText(body.engine, MAX_ENGINE_LENGTH);
  if (!ENGINE_ID_PATTERN.test(engine)) {
    invalidInput();
  }
  const profile = normalizeText(body.profile, MAX_PROFILE_LENGTH);
  const retention =
    body.retention === undefined ? 'ephemeral' : body.retention;
  if (typeof retention !== 'string' || !RETENTIONS.has(retention)) {
    invalidInput();
  }
  const ttlSeconds = normalizeOptionalPositiveInteger(body.ttlSeconds);
  if (retention === 'ttl' && ttlSeconds === null) {
    invalidInput();
  }
  if (
    ttlSeconds !== null &&
    ttlSeconds > 365 * 24 * 60 * 60
  ) {
    invalidInput();
  }
  return Object.freeze({
    requestId,
    engine,
    profile,
    retention,
    ttlSeconds,
  });
}

function normalizeStartStopInput(input, label) {
  const body = normalizeInputObject(input);
  rejectUnknownKeys(
    body,
    new Set(['sandboxId', 'generation', 'requestId'])
  );
  const sandboxId = normalizeUuid(body.sandboxId);
  const generation = normalizeOptionalPositiveInteger(body.generation);
  const requestId = normalizeOptionalText(
    body.requestId,
    MAX_REQUEST_ID_LENGTH
  );
  return Object.freeze({ sandboxId, generation, requestId, operation: label });
}

function normalizeDeleteInput(input) {
  const body = normalizeInputObject(input);
  rejectUnknownKeys(
    body,
    new Set(['sandboxId', 'generation', 'discard', 'reason'])
  );
  const sandboxId = normalizeUuid(body.sandboxId);
  const generation = normalizeOptionalPositiveInteger(body.generation);
  if (body.discard !== undefined && typeof body.discard !== 'boolean') {
    invalidInput();
  }
  const discard = body.discard === true;
  const reason = normalizeOptionalText(body.reason, MAX_REASON_LENGTH);
  return Object.freeze({ sandboxId, generation, discard, reason });
}

function normalizeArgv(value) {
  if (!Array.isArray(value) || value.length === 0) {
    invalidInput('argv must be a non-empty array.');
  }
  let total = 0;
  for (const argument of value) {
    if (typeof argument !== 'string' || argument.length === 0) {
      invalidInput('Every argv entry must be a non-empty string.');
    }
    if (argument.length > MAX_ARG_BYTES) {
      invalidInput('An argv entry is too long.');
    }
    if (argument.includes('\u0000')) {
      invalidInput('argv entries must not contain NUL.');
    }
    total += Buffer.byteLength(argument, 'utf8');
  }
  if (total > MAX_ARGV_BYTES) {
    invalidInput('argv is too large.');
  }
  return Object.freeze([...value]);
}

function normalizeWorkingDir(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_WORKING_DIR_LENGTH ||
    !value.startsWith('/') ||
    value.includes('\u0000') ||
    CONTROL_CHARACTERS.test(value)
  ) {
    invalidInput('workingDir must be an absolute guest path.');
  }
  for (const segment of value.split('/')) {
    if (segment === '..') {
      invalidInput('workingDir must not traverse upward.');
    }
  }
  return value;
}

function normalizeExecInput(input) {
  const body = normalizeInputObject(input);
  rejectUnknownKeys(
    body,
    new Set([
      'sandboxId',
      'workspaceId',
      'leaseEpoch',
      'argv',
      'timeoutMs',
      'maxOutputBytes',
      'tty',
      'workingDir',
    ])
  );
  const sandboxId = normalizeUuid(body.sandboxId);
  const workspaceId = normalizeUuid(body.workspaceId);
  const leaseEpoch = normalizePositiveInteger(body.leaseEpoch);
  const argv = normalizeArgv(body.argv);
  let timeoutMs =
    body.timeoutMs === undefined
      ? DEFAULT_EXEC_TIMEOUT_MS
      : body.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    invalidInput('timeoutMs must be a positive integer.');
  }
  timeoutMs = Math.min(timeoutMs, MAX_EXEC_TIMEOUT_MS);
  let maxOutputBytes =
    body.maxOutputBytes === undefined
      ? DEFAULT_EXEC_OUTPUT_BYTES
      : body.maxOutputBytes;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
    invalidInput('maxOutputBytes must be a positive integer.');
  }
  maxOutputBytes = Math.min(maxOutputBytes, MAX_EXEC_OUTPUT_BYTES);
  if (body.tty !== undefined && typeof body.tty !== 'boolean') {
    invalidInput();
  }
  const tty = body.tty === true;
  const workingDir = normalizeWorkingDir(body.workingDir);
  return Object.freeze({
    sandboxId,
    workspaceId,
    leaseEpoch,
    argv,
    timeoutMs,
    maxOutputBytes,
    tty,
    workingDir,
  });
}

function normalizeListInput(input) {
  if (input === undefined || input === null) {
    return Object.freeze({ limit: MAX_LIST_ITEMS });
  }
  const body = normalizeInputObject(input);
  rejectUnknownKeys(body, new Set(['limit']));
  const limit =
    body.limit === undefined ? MAX_LIST_ITEMS : body.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_ITEMS) {
    invalidInput();
  }
  return Object.freeze({ limit });
}

function extractSandboxId(input) {
  if (typeof input === 'string') {
    return normalizeUuid(input);
  }
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    rejectUnknownKeys(input, new Set(['sandboxId']));
    return normalizeUuid(input.sandboxId);
  }
  invalidInput();
}

function normalizeStatusInput(input) {
  if (input === undefined || input === null) {
    return null;
  }
  if (typeof input === 'string') {
    return normalizeUuid(input);
  }
  const body = normalizeInputObject(input);
  rejectUnknownKeys(body, new Set(['sandboxId']));
  if (body.sandboxId === undefined) {
    return null;
  }
  return normalizeUuid(body.sandboxId);
}

function normalizeLimits(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalidInput('Profile limits are invalid.');
  }
  const vcpus = normalizePositiveInteger(value.vcpus);
  const memoryMiB = normalizePositiveInteger(value.memoryMiB);
  const diskMiB = normalizePositiveInteger(value.diskMiB);
  if (
    vcpus > 64 ||
    memoryMiB < 128 ||
    memoryMiB > 262_144 ||
    diskMiB > 4 * 1024 * 1024
  ) {
    invalidInput('Profile limits are outside the supported range.');
  }
  return Object.freeze({ vcpus, memoryMiB, diskMiB });
}

function normalizeProjectQuota(value) {
  if (value === false || value === null) {
    return null;
  }
  const source = value === undefined ? DEFAULT_PROJECT_QUOTA : value;
  if (typeof source !== 'object' || Array.isArray(source)) {
    invalidInput('Invalid project quota.');
  }
  rejectUnknownKeys(
    source,
    new Set(['maxSandboxes', 'maxVcpus', 'maxMemoryMiB', 'maxDiskMiB'])
  );
  const result = {};
  for (const key of [
    'maxSandboxes',
    'maxVcpus',
    'maxMemoryMiB',
    'maxDiskMiB',
  ]) {
    const raw = source[key];
    if (raw === undefined || raw === null) {
      result[key] = null;
    } else if (!Number.isSafeInteger(raw) || raw <= 0) {
      invalidInput('Invalid project quota.');
    } else {
      result[key] = raw;
    }
  }
  return Object.freeze(result);
}

function validateResolvedProfile(resolved, requested) {
  const unavailable = (message) => {
    fail('profile_unavailable', message, {
      status: 503,
      retryable: false,
    });
  };
  if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved)) {
    unavailable('Profile is unavailable.');
  }
  if (resolved.qualified !== true || resolved.available !== true) {
    unavailable('Profile is not qualified or available.');
  }
  if (resolved.engine !== requested.engine) {
    unavailable('Profile resolver returned a different engine.');
  }
  if (resolved.profile !== requested.profile) {
    unavailable('Profile resolver returned a different profile.');
  }
  let engineVersion;
  let imageDigest;
  let limits;
  try {
    engineVersion = normalizeText(
      resolved.engineVersion,
      MAX_ENGINE_VERSION_LENGTH
    );
    imageDigest = normalizeText(
      resolved.imageDigest,
      MAX_IMAGE_DIGEST_LENGTH
    );
    if (!PINNED_DIGEST_PATTERN.test(imageDigest)) {
      unavailable('Profile image is not pinned by digest.');
    }
    limits = normalizeLimits(resolved.limits);
  } catch (error) {
    if (error instanceof SandboxServiceError) {
      unavailable('Profile pins or limits are invalid.');
    }
    unavailable('Profile pins or limits are invalid.');
  }
  const networkMode = resolved.networkMode;
  if (typeof networkMode !== 'string' || !NETWORK_MODES.has(networkMode)) {
    fail('network_unavailable', 'Network mode is unavailable.', {
      status: 503,
      retryable: false,
    });
  }
  if (networkMode === 'boundary' && resolved.networkBoundaryVerified !== true) {
    fail('network_unavailable', 'Network boundary was not verified.', {
      status: 503,
      retryable: false,
    });
  }
  if (resolved.capabilities !== undefined) {
    if (!Array.isArray(resolved.capabilities)) {
      unavailable('Profile capabilities are invalid.');
    }
    const supported = new Set(
      resolved.capabilities.filter((item) => typeof item === 'string')
    );
    const missing = REQUIRED_ENGINE_CAPABILITIES.filter(
      (capability) => !supported.has(capability)
    );
    if (missing.length > 0) {
      fail('engine_unsupported', 'Engine is not qualified for this profile.', {
        status: 503,
        retryable: false,
      });
    }
  }
  return Object.freeze({
    engine: resolved.engine,
    profile: resolved.profile,
    engineVersion,
    imageDigest,
    limits,
    networkMode,
    capabilities:
      resolved.capabilities === undefined
        ? Object.freeze([])
        : Object.freeze([...resolved.capabilities]),
  });
}

function buildEngineLimits(resources) {
  return Object.freeze({
    cpus: resources.vcpus,
    memoryMib: resources.memoryMiB,
    diskSizeGb: Math.ceil(resources.diskMiB / 1024),
  });
}

function engineRecordFor(row, receipt) {
  return Object.freeze({
    sandboxId: row.sandboxId,
    workspaceId: receipt.workspaceId,
    project: row.project,
    requestId: row.requestId,
    allocationId: row.allocationId,
    launchGeneration: row.launchGeneration,
    engine: row.engine,
    engineVersion: row.engineVersion,
    profile: row.profile,
    imageDigest: row.imageDigest,
    networkMode: row.networkMode,
    resources: Object.freeze({ ...row.resources }),
    engineLimits: buildEngineLimits(row.resources),
    retention: row.retention,
    nativeId: row.nativeId,
  });
}

function allocationName(allocationId, launchGeneration) {
  return `alpi-${allocationId}-g${launchGeneration}`;
}

function refForRow(row) {
  if (!row || typeof row.nativeId !== 'string' || row.nativeId.length === 0) {
    invalidTransition('Sandbox engine allocation is not ready.');
  }
  return Object.freeze({
    allocationId: row.allocationId,
    launchGeneration: row.launchGeneration,
    name: allocationName(row.allocationId, row.launchGeneration),
    nativeId: row.nativeId,
  });
}

function validateAdapter(adapter, methods) {
  if (!adapter || typeof adapter !== 'object') {
    fail('engine_unavailable', 'Engine adapter is unavailable.', {
      status: 503,
      retryable: true,
    });
  }
  for (const method of methods) {
    if (typeof adapter[method] !== 'function') {
      fail('engine_unavailable', 'Engine adapter is incomplete.', {
        status: 503,
        retryable: true,
      });
    }
  }
}

function verifyCreateResult(result, row) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    fail('engine_identity_conflict', 'Engine create returned an invalid result.', {
      status: 502,
      retryable: false,
    });
  }
  if (typeof result.created !== 'boolean') {
    fail('engine_identity_conflict', 'Engine create returned no creation marker.', {
      status: 502,
      retryable: false,
    });
  }
  if (typeof result.nativeId !== 'string' || result.nativeId.length === 0) {
    fail('engine_identity_conflict', 'Engine create returned no native id.', {
      status: 502,
      retryable: false,
    });
  }
  if (
    String(result.allocationId).toLowerCase() !== row.allocationId ||
    result.launchGeneration !== row.launchGeneration ||
    result.name !== allocationName(row.allocationId, row.launchGeneration)
  ) {
    fail('engine_identity_conflict', 'Engine identity does not match the allocation.', {
      status: 409,
      retryable: false,
    });
  }
  return result;
}

function verifyDestroyResult(result, ref) {
  if (!result || typeof result !== 'object' || result.destroyed !== true) {
    fail('engine_uncertain', 'Engine removal is unverified.', {
      status: 503,
      retryable: true,
    });
  }
  if (
    String(result.allocationId).toLowerCase() !== ref.allocationId ||
    result.launchGeneration !== ref.launchGeneration ||
    result.nativeId !== ref.nativeId
  ) {
    fail('engine_identity_conflict', 'Engine removal identity does not match.', {
      status: 409,
      retryable: false,
    });
  }
  return result;
}

function validateExecResult(result, maxOutputBytes) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    fail('exec_failed', 'Execution returned an invalid result.', {
      status: 502,
      retryable: false,
    });
  }
  if (!Number.isInteger(result.exitCode)) {
    fail('exec_failed', 'Execution returned an invalid exit code.', {
      status: 502,
      retryable: false,
    });
  }
  if (typeof result.stdout !== 'string' || typeof result.stderr !== 'string') {
    fail('exec_failed', 'Execution returned invalid output.', {
      status: 502,
      retryable: false,
    });
  }
  let stdout = result.stdout;
  let stderr = result.stderr;
  let truncated = result.truncated === true;
  const bound = (text) => {
    const buffer = Buffer.from(text, 'utf8');
    if (buffer.length <= maxOutputBytes) {
      return { text, truncated: false };
    }
    return {
      text: buffer.subarray(0, maxOutputBytes).toString('utf8'),
      truncated: true,
    };
  };
  const out = bound(stdout);
  const err = bound(stderr);
  stdout = out.text;
  stderr = err.text;
  truncated = truncated || out.truncated || err.truncated;
  return Object.freeze({
    exitCode: result.exitCode,
    stdout,
    stderr,
    truncated,
    timedOut: result.timedOut === true,
    cancelled: result.cancelled === true,
    ...(typeof result.executionId === 'string' &&
    result.executionId.length > 0
      ? { executionId: result.executionId }
      : {}),
  });
}

function buildSandbox(receipt, row) {
  const observedState = receipt.observedState;
  const nativeId = row ? row.nativeId : receipt.nativeId;
  const nativeMismatch =
    row &&
    row.createState === 'created' &&
    row.nativeId !== null &&
    receipt.nativeId !== row.nativeId;
  const recoveryRequired = row
    ? row.recoveryRequired || nativeMismatch
    : false;
  return Object.freeze({
    sandboxId: receipt.sandboxId,
    workspaceId: receipt.workspaceId,
    project: receipt.project,
    ownerClientId: receipt.ownerClientId,
    requestId: receipt.requestId,
    engine: receipt.engine,
    engineVersion: receipt.engineVersion,
    profile: receipt.profile,
    imageDigest: receipt.imageDigest,
    resources: Object.freeze({ ...receipt.resources }),
    retention: receipt.retention,
    ttlSeconds: receipt.ttlSeconds,
    expiresAt: receipt.expiresAt,
    generation: receipt.generation,
    launchGeneration: row ? row.launchGeneration : null,
    allocationId: row ? row.allocationId : null,
    nativeId,
    desiredState: receipt.desiredState,
    observedState,
    running: observedState === 'running',
    vmStarted: observedState === 'running',
    createState: row ? row.createState : 'legacy',
    deleteState: row ? row.deleteState : 'none',
    operation: row ? row.operation : null,
    operationState: row ? row.operationState : 'idle',
    recoveryRequired,
    createdAt: receipt.createdAt,
    updatedAt: receipt.updatedAt,
    stoppedAt: receipt.stoppedAt,
    exportedAt: receipt.exportedAt,
    exportDigest: receipt.exportDigest,
    deletedAt: receipt.deletedAt,
    deletedReason: receipt.deletedReason,
  });
}

function verifyStoreJournal(receipt, row) {
  if (receipt.project !== row.project) {
    fail('engine_identity_conflict', 'Sandbox project does not match its journal.', {
      status: 409,
      retryable: false,
    });
  }
  if (
    receipt.engine !== row.engine ||
    receipt.engineVersion !== row.engineVersion ||
    receipt.profile !== row.profile ||
    receipt.imageDigest !== row.imageDigest
  ) {
    fail('engine_identity_conflict', 'Sandbox profile pins do not match its journal.', {
      status: 409,
      retryable: false,
    });
  }
  if (
    receipt.nativeId !== null &&
    row.nativeId !== null &&
    receipt.nativeId !== row.nativeId
  ) {
    fail('engine_identity_conflict', 'Sandbox native identity does not match its journal.', {
      status: 409,
      retryable: false,
    });
  }
}

function createSandboxService(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    invalidInput('Invalid service options.');
  }
  const store = options.store;
  if (!store || typeof store !== 'object') {
    invalidInput('A work store is required.');
  }
  for (const method of [
    'reserveSandbox',
    'getSandbox',
    'listSandboxes',
    'attachEngine',
    'recordObserved',
    'startSandbox',
    'stopSandbox',
    'deleteSandbox',
    'discardSandbox',
    'validateLease',
  ]) {
    if (typeof store[method] !== 'function') {
      invalidInput('The work store is missing a required method.');
    }
  }
  if (typeof options.resolveProfile !== 'function') {
    invalidInput('A trusted profile resolver is required.');
  }
  if (typeof options.withEngine !== 'function') {
    invalidInput('A trusted engine adapter provider is required.');
  }

  const resolveProfile = options.resolveProfile;
  const withEngine = options.withEngine;
  const clock = createClock(options.clock === undefined ? options.now : options.clock);

  const operationTimeoutMs = (() => {
    const raw =
      options.operationTimeoutMs === undefined
        ? DEFAULT_OPERATION_TIMEOUT_MS
        : options.operationTimeoutMs;
    if (
      !Number.isSafeInteger(raw) ||
      raw < 1 ||
      raw > MAX_OPERATION_TIMEOUT_MS
    ) {
      invalidInput('Invalid operation timeout.');
    }
    return raw;
  })();

  const maxQueuePerSandbox = (() => {
    const raw =
      options.maxQueuePerSandbox === undefined
        ? DEFAULT_QUEUE_PER_SANDBOX
        : options.maxQueuePerSandbox;
    if (
      !Number.isSafeInteger(raw) ||
      raw < 1 ||
      raw > MAX_QUEUE_PER_SANDBOX
    ) {
      invalidInput('Invalid sandbox queue bound.');
    }
    return raw;
  })();

  const maxConcurrentOperations = (() => {
    const raw =
      options.maxConcurrentOperations === undefined
        ? DEFAULT_MAX_CONCURRENT_OPERATIONS
        : options.maxConcurrentOperations;
    if (
      !Number.isSafeInteger(raw) ||
      raw < 1 ||
      raw > MAX_CONCURRENT_OPERATIONS
    ) {
      invalidInput('Invalid concurrency bound.');
    }
    return raw;
  })();

  const projectQuota = normalizeProjectQuota(options.projectQuota);

  let journal = options.journal;
  let ownedJournal = false;
  if (!journal) {
    if (typeof options.stateDir !== 'string') {
      invalidInput('A state directory or journal is required.');
    }
    journal = openSandboxJournal(options.stateDir, { now: clock });
    ownedJournal = true;
  } else {
    for (const method of [
      'beginCreate',
      'markCreateResult',
      'beginOperation',
      'markOperationResult',
      'beginDelete',
      'markDeleteResult',
      'markDeleted',
      'get',
      'getByRequest',
      'listByProject',
      'listAll',
      'listPending',
      'listTtlCandidates',
      'close',
    ]) {
      if (typeof journal[method] !== 'function') {
        invalidInput('The sandbox journal is incomplete.');
      }
    }
  }

  let closed = false;
  let activeOperations = 0;
  const locks = new Map();
  const pendingEngine = new Map();
  const authorize = options.authorize ?? (() => {});

  function nowMs() {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0) {
      fail('internal_error', 'Internal service error.', {
        status: 500,
        retryable: false,
      });
    }
    return value;
  }

  function ensureOpen() {
    if (closed) {
      fail('service_closed', 'Sandbox service is closed.', {
        status: 503,
        retryable: false,
      });
    }
  }

  function queueFull() {
    return new SandboxServiceError(
      'queue_full',
      'Sandbox operation queue is full.',
      { status: 429, retryable: true }
    );
  }

  function runExclusive(key, fn, countOperation = true) {
    if (closed) {
      return Promise.reject(
        new SandboxServiceError('service_closed', 'Sandbox service is closed.', {
          status: 503,
          retryable: false,
        })
      );
    }
    let lock = locks.get(key);
    if (!lock) {
      lock = { tail: Promise.resolve(), queued: 0 };
      locks.set(key, lock);
    }
    if (lock.queued >= maxQueuePerSandbox) {
      return Promise.reject(queueFull());
    }
    lock.queued += 1;
    const previous = lock.tail;
    const run = previous.then(async () => {
      if (closed) {
        throw new SandboxServiceError('service_closed', 'Sandbox service is closed.', {
          status: 503,
          retryable: false,
        });
      }
      if (countOperation && activeOperations >= maxConcurrentOperations) {
        throw queueFull();
      }
      authorize();
      if (countOperation) activeOperations += 1;
      try {
        return await fn();
      } finally {
        if (countOperation) activeOperations -= 1;
      }
    });
    lock.tail = run.then(
      () => undefined,
      () => undefined
    );
    const cleanup = () => {
      lock.queued -= 1;
      if (lock.queued === 0 && locks.get(key) === lock) {
        locks.delete(key);
      }
    };
    run.then(cleanup, cleanup);
    return run;
  }

  async function withOperationTimeout(promise, timeoutMs, operation) {
    let timer;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new SandboxServiceError(
            'operation_timeout',
            'Operation did not complete within the allowed time.',
            { status: 504, retryable: true, operation }
          )
        );
      }, timeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function callWithEngine(record, fn, operation, methods, timeoutMs) {
    ensureOpen();
    const required =
      methods ||
      (operation === 'create'
        ? ['createBox']
        : operation === 'start'
          ? ['start']
          : operation === 'stop'
            ? ['stop']
            : operation === 'delete'
              ? ['destroy']
              : operation === 'exec'
                ? ['exec']
                : operation === 'inspect'
                  ? ['inspect']
                  : operation === 'recovery'
                    ? ['listOwned']
                    : []);
    if (pendingEngine.has(record.sandboxId)) {
      fail('engine_uncertain', 'An earlier engine operation is still settling.', { status: 503, retryable: true });
    }
    if (pendingEngine.size >= maxConcurrentOperations) throw queueFull();
    const controller = new AbortController();
    const promise = Promise.resolve().then(() =>
      withEngine(record, async adapter => {
        controller.signal.throwIfAborted();
        authorize();
        validateAdapter(adapter, required);
        return fn(adapter, controller.signal);
      }, controller.signal)
    );
    pendingEngine.set(record.sandboxId, promise);
    const settled = () => pendingEngine.delete(record.sandboxId);
    promise.then(settled, settled);
    try {
      return await withOperationTimeout(promise, timeoutMs ?? operationTimeoutMs, operation);
    } finally {
      controller.abort();
    }
  }

  async function resolveAndValidate(principal, body) {
    let resolved;
    try {
      resolved = await withOperationTimeout(
        Promise.resolve().then(() =>
          resolveProfile({
            principal,
            engine: body.engine,
            profile: body.profile,
          })
        ),
        operationTimeoutMs,
        'resolve-profile'
      );
    } catch (error) {
      if (
        error instanceof SandboxServiceError &&
        error.code === 'operation_timeout'
      ) {
        fail('profile_unavailable', 'Profile resolution timed out.', {
          status: 503,
          retryable: true,
        });
      }
      if (error instanceof SandboxServiceError) {
        throw error;
      }
      fail('profile_unavailable', 'Profile is unavailable.', {
        status: 503,
        retryable: true,
      });
    }
    return validateResolvedProfile(resolved, body);
  }

  function checkProjectQuota(principal, resources) {
    if (!projectQuota) {
      return;
    }
    const active = store.listSandboxes(principal);
    if (
      projectQuota.maxSandboxes !== null &&
      active.length + 1 > projectQuota.maxSandboxes
    ) {
      fail('quota_exceeded', 'Project sandbox quota is exhausted.', {
        status: 429,
        retryable: true,
      });
    }
    let vcpus = 0;
    let memoryMiB = 0;
    let diskMiB = 0;
    for (const sandbox of active) {
      vcpus += sandbox.resources.vcpus;
      memoryMiB += sandbox.resources.memoryMiB;
      diskMiB += sandbox.resources.diskMiB;
    }
    if (
      (projectQuota.maxVcpus !== null &&
        vcpus + resources.vcpus > projectQuota.maxVcpus) ||
      (projectQuota.maxMemoryMiB !== null &&
        memoryMiB + resources.memoryMiB > projectQuota.maxMemoryMiB) ||
      (projectQuota.maxDiskMiB !== null &&
        diskMiB + resources.diskMiB > projectQuota.maxDiskMiB)
    ) {
      fail('quota_exceeded', 'Project capacity is insufficient.', {
        status: 429,
        retryable: true,
      });
    }
  }

  async function attachAndObserve(
    principal,
    receipt,
    row,
    nativeId,
    observedState
  ) {
    let latest = receipt;
    if (latest.nativeId === null) {
      latest = store.attachEngine(principal, {
        sandboxId: row.sandboxId,
        nativeId,
        generation: latest.generation,
      });
    } else if (latest.nativeId !== nativeId) {
      fail('engine_identity_conflict', 'Sandbox native identity changed.', {
        status: 409,
        retryable: false,
      });
    }
    if (observedState !== undefined && observedState !== null) {
      latest = store.recordObserved(principal, {
        sandboxId: row.sandboxId,
        generation: latest.generation,
        observedState,
      });
    }
    return latest;
  }

  async function ensureAttached(principal, receipt, row) {
    if (row.nativeId === null) {
      invalidTransition('Sandbox engine allocation is not ready.');
    }
    if (receipt.nativeId === row.nativeId) {
      return receipt;
    }
    if (receipt.nativeId !== null) {
      fail('engine_identity_conflict', 'Sandbox native identity changed.', {
        status: 409,
        retryable: false,
      });
    }
    let observedState = 'unknown';
    try {
      const info = await callWithEngine(
        engineRecordFor(row, receipt),
        (adapter) => adapter.inspect(refForRow(row)),
        'inspect',
        ['inspect']
      );
      observedState = info && info.running === true ? 'running' : 'stopped';
    } catch {
      observedState = 'unknown';
    }
    return attachAndObserve(principal, receipt, row, row.nativeId, observedState);
  }

  async function recordObservedIfNeeded(principal, receipt, observedState) {
    if (receipt.observedState === observedState) {
      return receipt;
    }
    return store.recordObserved(principal, {
      sandboxId: receipt.sandboxId,
      generation: receipt.generation,
      observedState,
    });
  }

  function replayResult(receipt, row) {
    const sandbox = buildSandbox(receipt, row);
    return Object.freeze({
      sandbox,
      created: false,
      metadataCreated: false,
      vmStarted: sandbox.vmStarted,
      replayed: true,
    });
  }

  function principalForRow(row) {
    return Object.freeze({
      clientId: row.clientId,
      project: row.project,
      role: 'operator',
    });
  }

  async function reconcileCreateLocked(principal, receipt, row) {
    let current = row;
    let owned;
    try {
      owned = await callWithEngine(
        engineRecordFor(current, receipt),
        (adapter) => adapter.listOwned(),
        'recovery',
        ['listOwned']
      );
    } catch (error) {
      const mapped = mapError(error, 'recovery');
      journal.markCreateResult({
        project: current.project,
        sandboxId: current.sandboxId,
        state: 'uncertain',
        errorCode: mapped.code,
      });
      return { status: 'uncertain', code: mapped.code };
    }
    if (!Array.isArray(owned)) {
      journal.markCreateResult({
        project: current.project,
        sandboxId: current.sandboxId,
        state: 'uncertain',
        errorCode: 'engine_invalid_result',
      });
      return { status: 'uncertain', code: 'engine_invalid_result' };
    }
    const match = owned.find(
      (entry) =>
        entry &&
        String(entry.allocationId).toLowerCase() === current.allocationId &&
        entry.launchGeneration === current.launchGeneration
    );
    if (match) {
      if (
        current.nativeId !== null &&
        current.nativeId !== match.nativeId
      ) {
        journal.markCreateResult({
          project: current.project,
          sandboxId: current.sandboxId,
          state: 'uncertain',
          errorCode: 'engine_native_lost',
        });
        return { status: 'uncertain', code: 'engine_native_lost' };
      }
      const observedState =
        match.running === true ? 'running' : 'stopped';
      const latestReceipt = store.getSandbox(
        principal,
        current.sandboxId
      );
      const latest = await attachAndObserve(
        principal,
        latestReceipt,
        current,
        match.nativeId,
        observedState
      );
      journal.markCreateResult({
        project: current.project,
        sandboxId: current.sandboxId,
        state: 'created',
        nativeId: match.nativeId,
      });
      return {
        status: 'reconciled',
        nativeId: match.nativeId,
        receipt: latest,
      };
    }
    if (current.nativeId !== null) {
      journal.markCreateResult({
        project: current.project,
        sandboxId: current.sandboxId,
        state: 'uncertain',
        errorCode: 'engine_native_lost',
      });
      return { status: 'uncertain', code: 'engine_native_lost' };
    }
    if (current.createState === 'failed') {
      return { status: 'skipped', code: 'create_failed' };
    }
    try {
      const result = await callWithEngine(
        engineRecordFor(current, receipt),
        (adapter) =>
          adapter.createBox({
            allocationId: current.allocationId,
            launchGeneration: current.launchGeneration,
            profile: { network: { mode: current.networkMode } },
          }),
        'recovery',
        ['createBox']
      );
      verifyCreateResult(result, current);
      journal.markCreateResult({
        project: current.project,
        sandboxId: current.sandboxId,
        state: 'created',
        nativeId: result.nativeId,
      });
      current = journal.get(current.project, current.sandboxId);
      let observedState = 'unknown';
      try {
        const latestReceipt = store.getSandbox(
          principal,
          current.sandboxId
        );
        const info = await callWithEngine(
          engineRecordFor(current, latestReceipt),
          (adapter) => adapter.inspect(refForRow(current)),
          'inspect',
          ['inspect']
        );
        observedState =
          info && info.running === true ? 'running' : 'stopped';
      } catch {
        observedState = 'unknown';
      }
      const latestReceipt = store.getSandbox(
        principal,
        current.sandboxId
      );
      const latest = await attachAndObserve(
        principal,
        latestReceipt,
        current,
        result.nativeId,
        observedState
      );
      return {
        status: 'reconciled',
        nativeId: result.nativeId,
        receipt: latest,
      };
    } catch (error) {
      const mapped = mapError(error, 'recovery');
      journal.markCreateResult({
        project: current.project,
        sandboxId: current.sandboxId,
        state: 'uncertain',
        errorCode: mapped.code,
      });
      return { status: 'uncertain', code: mapped.code };
    }
  }

  async function reconcileOperationLocked(principal, receipt, row) {
    if (row.nativeId === null) {
      journal.markOperationResult({
        project: row.project,
        sandboxId: row.sandboxId,
        operation: row.operation,
        state: 'uncertain',
        errorCode: 'engine_native_missing',
      });
      return { status: 'uncertain', code: 'engine_native_missing' };
    }
    let info;
    try {
      info = await callWithEngine(
        engineRecordFor(row, receipt),
        (adapter) => adapter.inspect(refForRow(row)),
        'inspect',
        ['inspect']
      );
    } catch (error) {
      const mapped = mapError(error, 'recovery');
      journal.markOperationResult({
        project: row.project,
        sandboxId: row.sandboxId,
        operation: row.operation,
        state: 'uncertain',
        errorCode: mapped.code,
      });
      return { status: 'uncertain', code: mapped.code };
    }
    const running = info && info.running === true;
    if (row.operation === 'start' && running) {
      const latest = await recordObservedIfNeeded(
        principal,
        receipt,
        'running'
      );
      journal.markOperationResult({
        project: row.project,
        sandboxId: row.sandboxId,
        operation: 'start',
        state: 'done',
      });
      return { status: 'reconciled', receipt: latest };
    }
    if (row.operation === 'stop' && !running) {
      const latest = await recordObservedIfNeeded(
        principal,
        receipt,
        'stopped'
      );
      journal.markOperationResult({
        project: row.project,
        sandboxId: row.sandboxId,
        operation: 'stop',
        state: 'done',
      });
      return { status: 'reconciled', receipt: latest };
    }
    journal.markOperationResult({
      project: row.project,
      sandboxId: row.sandboxId,
      operation: row.operation,
      state: 'uncertain',
      errorCode: 'engine_observation_mismatch',
    });
    return { status: 'uncertain', code: 'engine_observation_mismatch' };
  }

  async function destroyAllocationLocked(receipt, row) {
    if (row.nativeId !== null) {
      const ref = refForRow(row);
      const result = await callWithEngine(
        engineRecordFor(row, receipt),
        (adapter) => adapter.destroy(ref),
        'delete',
        ['destroy']
      );
      verifyDestroyResult(result, ref);
      journal.markDeleteResult({
        project: row.project,
        sandboxId: row.sandboxId,
        state: 'removed',
        nativeAbsent: true,
        nativeId: row.nativeId,
      });
      return;
    }
    let owned;
    try {
      owned = await callWithEngine(
        engineRecordFor(row, receipt),
        (adapter) => adapter.listOwned(),
        'recovery',
        ['listOwned']
      );
    } catch (error) {
      const mapped = mapError(error, 'recovery');
      journal.markDeleteResult({
        project: row.project,
        sandboxId: row.sandboxId,
        state: 'uncertain',
        nativeAbsent: false,
        errorCode: mapped.code,
      });
      throw new SandboxServiceError(
        'engine_uncertain',
        'Engine removal outcome is uncertain.',
        { status: 503, retryable: true, operation: 'delete' }
      );
    }
    if (!Array.isArray(owned)) {
      journal.markDeleteResult({
        project: row.project,
        sandboxId: row.sandboxId,
        state: 'uncertain',
        nativeAbsent: false,
        errorCode: 'engine_invalid_result',
      });
      throw new SandboxServiceError(
        'engine_uncertain',
        'Engine removal outcome is uncertain.',
        { status: 503, retryable: true, operation: 'delete' }
      );
    }
    const match = owned.find(
      (entry) =>
        entry &&
        String(entry.allocationId).toLowerCase() === row.allocationId &&
        entry.launchGeneration === row.launchGeneration
    );
    if (match) {
      const ref = Object.freeze({
        allocationId: match.allocationId,
        launchGeneration: match.launchGeneration,
        name: match.name,
        nativeId: match.nativeId,
      });
      const result = await callWithEngine(
        engineRecordFor(row, receipt),
        (adapter) => adapter.destroy(ref),
        'delete',
        ['destroy']
      );
      verifyDestroyResult(result, ref);
      journal.markDeleteResult({
        project: row.project,
        sandboxId: row.sandboxId,
        state: 'removed',
        nativeAbsent: true,
        nativeId: match.nativeId,
      });
      return;
    }
    journal.markDeleteResult({
      project: row.project,
      sandboxId: row.sandboxId,
      state: 'uncertain',
      nativeAbsent: false,
      errorCode: 'engine_native_lost',
    });
    throw new SandboxServiceError(
      'engine_uncertain',
      'Engine native identity is lost; removal cannot be confirmed.',
      { status: 503, retryable: true, operation: 'delete' }
    );
  }

  async function reconcileDeleteLocked(principal, receipt, row) {
    let current = row;
    if (current.deleteState !== 'removed') {
      try {
        await destroyAllocationLocked(receipt, current);
      } catch (error) {
        const mapped = mapError(error, 'recovery');
        return { status: 'uncertain', code: mapped.code };
      }
      current = journal.get(current.project, current.sandboxId);
    }
    if (!current) {
      return { status: 'uncertain', code: 'journal_missing' };
    }
    const latestReceipt = store.getSandbox(principal, current.sandboxId);
    if (latestReceipt.deletedAt !== null) {
      journal.markDeleted({
        project: current.project,
        sandboxId: current.sandboxId,
      });
      return { status: 'reconciled' };
    }
    if (latestReceipt.desiredState !== 'stopped') {
      return { status: 'uncertain', code: 'stop_unconfirmed' };
    }
    if (
      latestReceipt.retention === 'until-export' &&
      latestReceipt.exportedAt === null &&
      !current.discard
    ) {
      return { status: 'retained', code: 'export_required' };
    }
    let latest = latestReceipt;
    if (latest.observedState !== 'removed') {
      latest = store.recordObserved(principal, {
        sandboxId: current.sandboxId,
        generation: latest.generation,
        observedState: 'removed',
      });
    }
    if (current.discard) {
      latest = store.discardSandbox(principal, {
        sandboxId: current.sandboxId,
        generation: latest.generation,
        reason: current.deleteReason || 'discarded',
      });
    } else {
      latest = store.deleteSandbox(principal, {
        sandboxId: current.sandboxId,
        generation: latest.generation,
      });
    }
    journal.markDeleted({
      project: current.project,
      sandboxId: current.sandboxId,
    });
    return { status: 'reconciled', receipt: latest };
  }

  async function createLocked(principal, reservation, row) {
    let created;
    let observedState = 'unknown';
    try {
      const outcome = await callWithEngine(
        engineRecordFor(row, reservation),
        async (adapter) => {
          const result = await adapter.createBox({
            allocationId: row.allocationId,
            launchGeneration: row.launchGeneration,
            profile: { network: { mode: row.networkMode } },
          });
          verifyCreateResult(result, row);
          let info = null;
          try {
            info = await adapter.inspect({
              allocationId: row.allocationId,
              launchGeneration: row.launchGeneration,
              name: allocationName(row.allocationId, row.launchGeneration),
              nativeId: result.nativeId,
            });
          } catch {
            info = null;
          }
          return { result, info };
        },
        'create',
        ['createBox', 'inspect']
      );
      created = outcome.result;
      observedState =
        outcome.info && outcome.info.running === true ? 'running' : 'stopped';
      if (outcome.info === null) {
        observedState = 'unknown';
      }
    } catch (error) {
      const mapped = mapError(error, 'create');
      const definiteFailure =
        mapped.code === 'engine_unqualified' ||
        mapped.code === 'network_unavailable' ||
        mapped.code === 'engine_unsupported';
      journal.markCreateResult({
        project: row.project,
        sandboxId: row.sandboxId,
        state: definiteFailure ? 'failed' : 'uncertain',
        errorCode: mapped.code,
      });
      if (definiteFailure) {
        throw mapped;
      }
      throw new SandboxServiceError(
        'engine_uncertain',
        'Engine create outcome is uncertain.',
        { status: 503, retryable: true, operation: 'create' }
      );
    }

    journal.markCreateResult({
      project: row.project,
      sandboxId: row.sandboxId,
      state: 'created',
      nativeId: created.nativeId,
    });
    let latest;
    try {
      latest = await attachAndObserve(
        principal,
        reservation,
        row,
        created.nativeId,
        observedState
      );
    } catch (error) {
      const mapped = mapError(error, 'create');
      try {
        journal.markCreateResult({
          project: row.project,
          sandboxId: row.sandboxId,
          state: 'uncertain',
          errorCode: mapped.code,
        });
      } catch {
        // The journal retains the native id; recovery can still reconcile.
      }
      throw mapped;
    }
    const fresh = journal.get(row.project, row.sandboxId);
    return Object.freeze({
      sandbox: buildSandbox(latest, fresh),
      created: created.created === true,
      metadataCreated: true,
      vmStarted: observedState === 'running',
      replayed: false,
    });
  }

  async function replayExisting(principal, row) {
    return runExclusive(`sandbox:${row.sandboxId}`, async () => {
      const fresh = journal.get(row.project, row.sandboxId);
      if (!fresh) {
        notFound();
      }
      if (fresh.createHash !== row.createHash) {
        fail('idempotency_conflict', 'Request key was already used with a different payload.', {
          status: 409,
          retryable: false,
        });
      }
      if (
        fresh.engine !== row.engine ||
        fresh.profile !== row.profile
      ) {
        fail('idempotency_conflict', 'Request key was already used for a different profile.', {
          status: 409,
          retryable: false,
        });
      }
      const latestReceipt = store.getSandbox(principal, fresh.sandboxId);
      if (
        fresh.deleteState === 'deleted' ||
        latestReceipt.deletedAt !== null
      ) {
        return replayResult(latestReceipt, fresh);
      }
      if (
        fresh.createState === 'created' &&
        fresh.nativeId !== null &&
        latestReceipt.nativeId === fresh.nativeId
      ) {
        return replayResult(latestReceipt, fresh);
      }
      if (fresh.createState === 'failed') {
        throw new SandboxServiceError(
          'engine_uncertain',
          'Sandbox create failed and requires operator resolution.',
          { status: 503, retryable: true, operation: 'create' }
        );
      }
      const outcome = await reconcileCreateLocked(
        principal,
        latestReceipt,
        fresh
      );
      if (outcome.status === 'reconciled') {
        const updated = store.getSandbox(principal, fresh.sandboxId);
        const current = journal.get(fresh.project, fresh.sandboxId);
        return replayResult(updated, current);
      }
      throw new SandboxServiceError(
        'engine_uncertain',
        'Engine create outcome is uncertain.',
        { status: 503, retryable: true, operation: 'create' }
      );
    });
  }

  async function createSandbox(principalInput, input) {
    ensureOpen();
    const principal = normalizePrincipal(principalInput);
    requireWriter(principal);
    const body = normalizeCreateInput(input);
    const createHash = digestOf({
      requestId: body.requestId,
      engine: body.engine,
      profile: body.profile,
      retention: body.retention,
      ttlSeconds: body.ttlSeconds,
    });

    const existing = journal.getByRequest(
      principal.project,
      principal.clientId,
      body.requestId
    );
    if (existing) {
      if (existing.createHash !== createHash) {
        fail('idempotency_conflict', 'Request key was already used with a different payload.', {
          status: 409,
          retryable: false,
        });
      }
      if (
        existing.engine !== body.engine ||
        existing.profile !== body.profile
      ) {
        fail('idempotency_conflict', 'Request key was already used for a different profile.', {
          status: 409,
          retryable: false,
        });
      }
      return replayExisting(
        principal,
        existing
      );
    }

    const profile = await resolveAndValidate(principal, body);

    return runExclusive(`project-create:${principal.project}`, async () => {
      const rechecked = journal.getByRequest(
        principal.project,
        principal.clientId,
        body.requestId
      );
      if (rechecked) {
        if (rechecked.createHash !== createHash) {
          fail('idempotency_conflict', 'Request key was already used with a different payload.', {
            status: 409,
            retryable: false,
          });
        }
        return replayExisting(
          principal,
          rechecked
        );
      }

      const legacy = store
        .listSandboxes(principal)
        .find(
          (sandbox) =>
            sandbox.requestId === body.requestId &&
            sandbox.ownerClientId === principal.clientId
        );
      if (legacy) {
        return replayResult(legacy, null);
      }

      checkProjectQuota(principal, profile.limits);

      const reservation = store.reserveSandbox(principal, {
        requestId: body.requestId,
        engine: profile.engine,
        engineVersion: profile.engineVersion,
        profile: profile.profile,
        imageDigest: profile.imageDigest,
        resources: profile.limits,
        retention: body.retention,
        ...(body.ttlSeconds === null
          ? {}
          : { ttlSeconds: body.ttlSeconds }),
      });

      if (reservation.deletedAt !== null) {
        const row = journal.get(principal.project, reservation.sandboxId);
        return replayResult(reservation, row);
      }

      const row = journal.beginCreate({
        project: principal.project,
        sandboxId: reservation.sandboxId,
        clientId: principal.clientId,
        requestId: body.requestId,
        createHash,
        allocationId: reservation.sandboxId,
        launchGeneration: 1,
        engine: profile.engine,
        engineVersion: profile.engineVersion,
        profile: profile.profile,
        imageDigest: profile.imageDigest,
        networkMode: profile.networkMode,
        resources: profile.limits,
        retention: reservation.retention,
        expiresAt: reservation.expiresAt,
      });

      return runExclusive(`sandbox:${reservation.sandboxId}`, () =>
        createLocked(principal, reservation, row)
      );
    }, false); // The inner sandbox operation is counted against host concurrency.
  }

  async function listSandboxes(principalInput, input) {
    ensureOpen();
    const principal = normalizePrincipal(principalInput);
    const body = normalizeListInput(input);
    const active = store.listSandboxes(principal);
    const rows = journal.listByProject(principal.project);
    const byId = new Map(rows.map((row) => [row.sandboxId, row]));
    const limited = active.slice(0, body.limit);
    return Object.freeze({
      sandboxes: Object.freeze(
        limited.map((sandbox) =>
          buildSandbox(sandbox, byId.get(sandbox.sandboxId) || null)
        )
      ),
      count: active.length,
      truncated: active.length > limited.length,
    });
  }

  async function getSandbox(principalInput, input) {
    ensureOpen();
    const principal = normalizePrincipal(principalInput);
    const sandboxId = extractSandboxId(input);
    const receipt = store.getSandbox(principal, sandboxId);
    const row = journal.get(principal.project, sandboxId);
    return Object.freeze({ sandbox: buildSandbox(receipt, row) });
  }

  async function startLocked(principal, body) {
    let receipt = store.getSandbox(principal, body.sandboxId);
    if (receipt.deletedAt !== null) {
      invalidTransition('Sandbox is deleted.');
    }
    let row = journal.get(principal.project, body.sandboxId);
    if (!row || row.createState !== 'created' || row.nativeId === null) {
      invalidTransition('Sandbox engine allocation is not ready.');
    }
    verifyStoreJournal(receipt, row);
    if (receipt.expiresAt !== null && receipt.expiresAt <= nowMs()) {
      invalidTransition('Sandbox has expired.');
    }
    if (body.generation !== null && body.generation !== receipt.generation) {
      fail('generation_conflict', 'Sandbox generation is stale.', {
        status: 409,
        retryable: false,
      });
    }
    if (
      receipt.desiredState === 'running' &&
      receipt.observedState === 'running'
    ) {
      return Object.freeze({
        sandbox: buildSandbox(receipt, row),
        started: true,
        alreadyRunning: true,
      });
    }

    receipt = await ensureAttached(principal, receipt, row);

    if (receipt.observedState !== 'stopped') {
      let info;
      try {
        info = await callWithEngine(
          engineRecordFor(row, receipt),
          (adapter) => adapter.inspect(refForRow(row)),
          'inspect',
          ['inspect']
        );
      } catch (error) {
        throw mapError(error, 'start');
      }
      if (info && info.running === true) {
        if (receipt.desiredState === 'running') {
          const latest = await recordObservedIfNeeded(
            principal,
            receipt,
            'running'
          );
          return Object.freeze({
            sandbox: buildSandbox(latest, row),
            started: true,
            alreadyRunning: true,
          });
        }
        invalidTransition('Sandbox stop is unconfirmed.');
      }
      receipt = await recordObservedIfNeeded(principal, receipt, 'stopped');
    }

    const hash = digestOf({
      operation: 'start',
      sandboxId: body.sandboxId,
      generation: receipt.generation,
      requestId: body.requestId,
    });
    if (
      row.operation === 'start' &&
      row.operationState === 'done' &&
      row.operationHash === hash &&
      receipt.desiredState === 'running' &&
      receipt.observedState === 'running'
    ) {
      return Object.freeze({
        sandbox: buildSandbox(receipt, row),
        started: true,
        alreadyRunning: true,
      });
    }

    row = journal.beginOperation({
      project: row.project,
      sandboxId: row.sandboxId,
      operation: 'start',
      hash,
    });

    let desired;
    try {
      desired = store.startSandbox(principal, {
        sandboxId: body.sandboxId,
        generation: receipt.generation,
      });
    } catch (error) {
      const mapped = mapError(error, 'start');
      journal.markOperationResult({
        project: row.project,
        sandboxId: row.sandboxId,
        operation: 'start',
        state: 'failed',
        errorCode: mapped.code,
      });
      throw mapped;
    }

    try {
      const info = await callWithEngine(
        engineRecordFor(row, desired),
        (adapter) => adapter.start(refForRow(row)),
        'start',
        ['start']
      );
      if (!info || info.running !== true) {
        throw new SandboxServiceError(
          'engine_uncertain',
          'Engine start is unverified.',
          { status: 503, retryable: true, operation: 'start' }
        );
      }
      const latest = await recordObservedIfNeeded(
        principal,
        desired,
        'running'
      );
      journal.markOperationResult({
        project: row.project,
        sandboxId: row.sandboxId,
        operation: 'start',
        state: 'done',
      });
      return Object.freeze({
        sandbox: buildSandbox(
          latest,
          journal.get(row.project, row.sandboxId)
        ),
        started: true,
        alreadyRunning: false,
      });
    } catch (error) {
      const mapped = mapError(error, 'start');
      journal.markOperationResult({
        project: row.project,
        sandboxId: row.sandboxId,
        operation: 'start',
        state: 'uncertain',
        errorCode: mapped.code,
      });
      try {
        const info = await callWithEngine(
          engineRecordFor(row, desired),
          (adapter) => adapter.inspect(refForRow(row)),
          'inspect',
          ['inspect']
        );
        if (info && info.running === true) {
          const latest = await recordObservedIfNeeded(
            principal,
            desired,
            'running'
          );
          journal.markOperationResult({
            project: row.project,
            sandboxId: row.sandboxId,
            operation: 'start',
            state: 'done',
          });
          return Object.freeze({
            sandbox: buildSandbox(
              latest,
              journal.get(row.project, row.sandboxId)
            ),
            started: true,
            alreadyRunning: false,
          });
        }
      } catch {
        // Keep the original uncertainty.
      }
      throw new SandboxServiceError(
        'engine_uncertain',
        'Engine start outcome is uncertain.',
        { status: 503, retryable: true, operation: 'start' }
      );
    }
  }

  async function startSandbox(principalInput, input) {
    ensureOpen();
    const principal = normalizePrincipal(principalInput);
    requireWriter(principal);
    const body = normalizeStartStopInput(input, 'start');
    return runExclusive(`sandbox:${body.sandboxId}`, () =>
      startLocked(principal, body)
    );
  }

  async function stopLocked(principal, body) {
    let receipt = store.getSandbox(principal, body.sandboxId);
    if (receipt.deletedAt !== null) {
      invalidTransition('Sandbox is deleted.');
    }
    let row = journal.get(principal.project, body.sandboxId);
    if (!row || row.createState !== 'created' || row.nativeId === null) {
      invalidTransition('Sandbox engine allocation is not ready.');
    }
    verifyStoreJournal(receipt, row);
    if (body.generation !== null && body.generation !== receipt.generation) {
      fail('generation_conflict', 'Sandbox generation is stale.', {
        status: 409,
        retryable: false,
      });
    }
    if (
      receipt.desiredState === 'stopped' &&
      receipt.observedState === 'stopped'
    ) {
      return Object.freeze({
        sandbox: buildSandbox(receipt, row),
        stopped: true,
        alreadyStopped: true,
      });
    }

    receipt = await ensureAttached(principal, receipt, row);

    const hash = digestOf({
      operation: 'stop',
      sandboxId: body.sandboxId,
      generation: receipt.generation,
      requestId: body.requestId,
    });
    if (
      row.operation === 'stop' &&
      row.operationState === 'done' &&
      row.operationHash === hash &&
      receipt.desiredState === 'stopped' &&
      receipt.observedState === 'stopped'
    ) {
      return Object.freeze({
        sandbox: buildSandbox(receipt, row),
        stopped: true,
        alreadyStopped: true,
      });
    }

    row = journal.beginOperation({
      project: row.project,
      sandboxId: row.sandboxId,
      operation: 'stop',
      hash,
    });

    let desired;
    try {
      desired = store.stopSandbox(principal, {
        sandboxId: body.sandboxId,
        generation: receipt.generation,
      });
    } catch (error) {
      const mapped = mapError(error, 'stop');
      journal.markOperationResult({
        project: row.project,
        sandboxId: row.sandboxId,
        operation: 'stop',
        state: 'failed',
        errorCode: mapped.code,
      });
      throw mapped;
    }

    try {
      const info = await callWithEngine(
        engineRecordFor(row, desired),
        (adapter) => adapter.stop(refForRow(row)),
        'stop',
        ['stop']
      );
      if (!info || info.running === true) {
        throw new SandboxServiceError(
          'engine_uncertain',
          'Engine stop is unverified.',
          { status: 503, retryable: true, operation: 'stop' }
        );
      }
      const latest = await recordObservedIfNeeded(
        principal,
        desired,
        'stopped'
      );
      journal.markOperationResult({
        project: row.project,
        sandboxId: row.sandboxId,
        operation: 'stop',
        state: 'done',
      });
      return Object.freeze({
        sandbox: buildSandbox(
          latest,
          journal.get(row.project, row.sandboxId)
        ),
        stopped: true,
        alreadyStopped: false,
      });
    } catch (error) {
      const mapped = mapError(error, 'stop');
      journal.markOperationResult({
        project: row.project,
        sandboxId: row.sandboxId,
        operation: 'stop',
        state: 'uncertain',
        errorCode: mapped.code,
      });
      try {
        const info = await callWithEngine(
          engineRecordFor(row, desired),
          (adapter) => adapter.inspect(refForRow(row)),
          'inspect',
          ['inspect']
        );
        if (info && info.running !== true) {
          const latest = await recordObservedIfNeeded(
            principal,
            desired,
            'stopped'
          );
          journal.markOperationResult({
            project: row.project,
            sandboxId: row.sandboxId,
            operation: 'stop',
            state: 'done',
          });
          return Object.freeze({
            sandbox: buildSandbox(
              latest,
              journal.get(row.project, row.sandboxId)
            ),
            stopped: true,
            alreadyStopped: false,
          });
        }
      } catch {
        // Keep the original uncertainty.
      }
      throw new SandboxServiceError(
        'engine_uncertain',
        'Engine stop outcome is uncertain.',
        { status: 503, retryable: true, operation: 'stop' }
      );
    }
  }

  async function stopSandbox(principalInput, input) {
    ensureOpen();
    const principal = normalizePrincipal(principalInput);
    requireWriter(principal);
    const body = normalizeStartStopInput(input, 'stop');
    return runExclusive(`sandbox:${body.sandboxId}`, () =>
      stopLocked(principal, body)
    );
  }

  async function deleteLocked(principal, body) {
    let receipt = store.getSandbox(principal, body.sandboxId);
    let row = journal.get(principal.project, body.sandboxId);
    if (receipt.deletedAt !== null) {
      if (row && row.deleteState !== 'deleted') {
        journal.markDeleted({
          project: row.project,
          sandboxId: row.sandboxId,
        });
        row = journal.get(row.project, row.sandboxId);
      }
      return Object.freeze({
        sandbox: buildSandbox(receipt, row),
        deleted: true,
        discarded: row ? row.discard : body.discard,
        alreadyDeleted: true,
      });
    }
    if (!row) {
      invalidTransition('Sandbox lifecycle journal is missing.');
    }
    verifyStoreJournal(receipt, row);
    if (body.generation !== null && body.generation !== receipt.generation) {
      fail('generation_conflict', 'Sandbox generation is stale.', {
        status: 409,
        retryable: false,
      });
    }
    if (receipt.desiredState !== 'stopped') {
      invalidTransition('Sandbox must be stopped before deletion.');
    }
    if (
      receipt.observedState !== 'stopped' &&
      receipt.observedState !== 'removed' &&
      !body.discard
    ) {
      invalidTransition('Sandbox stop is unconfirmed.');
    }
    if (
      receipt.retention === 'until-export' &&
      receipt.exportedAt === null &&
      !body.discard
    ) {
      fail('export_required', 'Export must be acknowledged before deletion.', {
        status: 409,
        retryable: false,
      });
    }

    const hash = digestOf({
      operation: 'delete',
      sandboxId: body.sandboxId,
      generation: receipt.generation,
      discard: body.discard,
      reason: body.reason,
    });

    if (row.deleteState !== 'removed') {
      row = journal.beginDelete({
        project: row.project,
        sandboxId: row.sandboxId,
        reason: body.reason || (body.discard ? 'discarded' : 'deleted'),
        discard: body.discard,
        hash,
      });
      try {
        await destroyAllocationLocked(receipt, row);
      } catch (error) {
        const mapped = mapError(error, 'delete');
        journal.markDeleteResult({
          project: row.project,
          sandboxId: row.sandboxId,
          state: 'uncertain',
          nativeAbsent: false,
          errorCode: mapped.code,
        });
        throw new SandboxServiceError(
          'engine_uncertain',
          'Engine removal outcome is uncertain.',
          { status: 503, retryable: true, operation: 'delete' }
        );
      }
      row = journal.get(row.project, row.sandboxId);
    } else {
      row = journal.beginDelete({
        project: row.project,
        sandboxId: row.sandboxId,
        reason: body.reason || (body.discard ? 'discarded' : 'deleted'),
        discard: body.discard,
        hash,
      });
    }

    if (!row || row.deleteState !== 'removed') {
      throw new SandboxServiceError(
        'engine_uncertain',
        'Engine removal is not confirmed.',
        { status: 503, retryable: true, operation: 'delete' }
      );
    }

    let latest = receipt;
    if (latest.observedState !== 'removed') {
      latest = store.recordObserved(principal, {
        sandboxId: body.sandboxId,
        generation: latest.generation,
        observedState: 'removed',
      });
    }
    if (body.discard) {
      latest = store.discardSandbox(principal, {
        sandboxId: body.sandboxId,
        generation: latest.generation,
        reason: body.reason || 'discarded',
      });
    } else {
      latest = store.deleteSandbox(principal, {
        sandboxId: body.sandboxId,
        generation: latest.generation,
      });
    }
    journal.markDeleted({
      project: row.project,
      sandboxId: row.sandboxId,
    });
    return Object.freeze({
      sandbox: buildSandbox(
        latest,
        journal.get(row.project, row.sandboxId)
      ),
      deleted: true,
      discarded: body.discard,
      alreadyDeleted: false,
    });
  }

  async function deleteSandbox(principalInput, input) {
    ensureOpen();
    const principal = normalizePrincipal(principalInput);
    requireOperator(principal);
    const body = normalizeDeleteInput(input);
    return runExclusive(`sandbox:${body.sandboxId}`, () =>
      deleteLocked(principal, body)
    );
  }

  async function execLocked(principal, body) {
    let receipt = store.getSandbox(principal, body.sandboxId);
    if (receipt.deletedAt !== null) {
      invalidTransition('Sandbox is deleted.');
    }
    let row = journal.get(principal.project, body.sandboxId);
    if (!row || row.createState !== 'created' || row.nativeId === null) {
      invalidTransition('Sandbox engine allocation is not ready.');
    }
    verifyStoreJournal(receipt, row);
    if (receipt.expiresAt !== null && receipt.expiresAt <= nowMs()) {
      invalidTransition('Sandbox has expired.');
    }
    if (body.workspaceId !== receipt.workspaceId) {
      invalidInput('Workspace does not belong to this sandbox.');
    }
    if (
      receipt.desiredState !== 'running' ||
      receipt.observedState !== 'running'
    ) {
      invalidTransition('Sandbox is not running.');
    }
    receipt = await ensureAttached(principal, receipt, row);
    if (
      receipt.desiredState !== 'running' ||
      receipt.observedState !== 'running'
    ) {
      invalidTransition('Sandbox is not running.');
    }

    try {
      store.validateLease(principal, {
        workspaceId: body.workspaceId,
        epoch: body.leaseEpoch,
      });
    } catch (error) {
      throw mapError(error, 'exec');
    }

    const timeoutMs = Math.min(body.timeoutMs, MAX_EXEC_TIMEOUT_MS);
    const maxOutputBytes = Math.min(
      body.maxOutputBytes,
      MAX_EXEC_OUTPUT_BYTES
    );
    const execTimeoutMs = Math.min(
      timeoutMs + 5000,
      operationTimeoutMs
    );
    try {
      const result = await callWithEngine(
        engineRecordFor(row, receipt),
        (adapter, signal) => {
          store.validateLease(principal, { workspaceId: body.workspaceId, epoch: body.leaseEpoch });
          return adapter.exec(refForRow(row), {
            signal,
            argv: body.argv,
            timeoutMs,
            maxOutputBytes,
            tty: body.tty,
            workingDir: body.workingDir,
          });
        },
        'exec',
        ['exec'],
        execTimeoutMs
      );
      return validateExecResult(result, maxOutputBytes);
    } catch (error) {
      if (
        error instanceof SandboxServiceError &&
        error.code === 'operation_timeout'
      ) {
        throw new SandboxServiceError(
          'exec_uncertain',
          'Execution outcome is uncertain.',
          { status: 504, retryable: false, operation: 'exec' }
        );
      }
      throw mapError(error, 'exec');
    }
  }

  async function execInSandbox(principalInput, input) {
    ensureOpen();
    const principal = normalizePrincipal(principalInput);
    requireWriter(principal);
    const body = normalizeExecInput(input);
    return runExclusive(`sandbox:${body.sandboxId}`, () =>
      execLocked(principal, body)
    );
  }

  async function status(principalInput, input) {
    ensureOpen();
    const principal = normalizePrincipal(principalInput);
    const sandboxId = normalizeStatusInput(input);
    if (sandboxId !== null) {
      const receipt = store.getSandbox(principal, sandboxId);
      const row = journal.get(principal.project, sandboxId);
      return Object.freeze({ sandbox: buildSandbox(receipt, row) });
    }
    const active = store.listSandboxes(principal);
    const rows = journal.listByProject(principal.project);
    const byId = new Map(rows.map((row) => [row.sandboxId, row]));
    const enriched = active.map((sandbox) =>
      buildSandbox(sandbox, byId.get(sandbox.sandboxId) || null)
    );
    const pending = enriched.filter(
      (sandbox) => sandbox.recoveryRequired
    );
    return Object.freeze({
      project: principal.project,
      role: principal.role,
      quotas: Object.freeze({
        project:
          projectQuota === null
            ? null
            : Object.freeze({ ...projectQuota }),
      }),
      counts: Object.freeze({
        sandboxes: enriched.length,
        running: enriched.filter((sandbox) => sandbox.running).length,
        stopped: enriched.filter(
          (sandbox) => sandbox.observedState === 'stopped'
        ).length,
        pendingRecovery: pending.length,
      }),
      pendingRecovery: Object.freeze(
        pending.map((sandbox) => sandbox.sandboxId)
      ),
    });
  }

  async function recoverStartup() {
    ensureOpen();
    const all = journal.listAll();
    const candidates = [];
    for (const row of all) {
      if (row.deleteState === 'deleted') {
        continue;
      }
      const pending =
        row.createState === 'pending' ||
        row.createState === 'uncertain' ||
        row.operationState === 'pending' ||
        row.operationState === 'uncertain' ||
        row.deleteState === 'pending' ||
        row.deleteState === 'uncertain' ||
        row.deleteState === 'removed';
      if (pending) {
        candidates.push(row);
        continue;
      }
      if (row.createState === 'created' && row.nativeId !== null) {
        try {
          const receipt = store.getSandbox(
            principalForRow(row),
            row.sandboxId
          );
          if (receipt.nativeId !== row.nativeId) {
            candidates.push(row);
          }
        } catch {
          candidates.push(row);
        }
      }
    }

    const report = {
      checked: candidates.length,
      reconciled: [],
      uncertain: [],
      retained: [],
      skipped: [],
    };
    for (const row of candidates) {
      const principal = principalForRow(row);
      try {
        await runExclusive(`sandbox:${row.sandboxId}`, async () => {
          const current = journal.get(row.project, row.sandboxId);
          if (!current) {
            report.skipped.push({
              sandboxId: row.sandboxId,
              project: row.project,
              code: 'journal_missing',
            });
            return;
          }
          const receipt = store.getSandbox(principal, row.sandboxId);
          if (receipt.deletedAt !== null) {
            journal.markDeleted({
              project: current.project,
              sandboxId: current.sandboxId,
            });
            report.skipped.push({
              sandboxId: row.sandboxId,
              project: row.project,
              code: 'already_deleted',
            });
            return;
          }

          if (
            current.deleteState === 'pending' ||
            current.deleteState === 'uncertain' ||
            current.deleteState === 'removed'
          ) {
            const outcome = await reconcileDeleteLocked(
              principal,
              receipt,
              current
            );
            if (outcome.status === 'reconciled') {
              report.reconciled.push({
                sandboxId: row.sandboxId,
                project: row.project,
                action: 'delete',
              });
            } else if (outcome.status === 'retained') {
              report.retained.push({
                sandboxId: row.sandboxId,
                project: row.project,
                code: outcome.code,
              });
            } else {
              report.uncertain.push({
                sandboxId: row.sandboxId,
                project: row.project,
                code: outcome.code,
              });
            }
            return;
          }

          if (
            current.createState === 'pending' ||
            current.createState === 'uncertain'
          ) {
            const outcome = await reconcileCreateLocked(
              principal,
              receipt,
              current
            );
            if (outcome.status === 'reconciled') {
              report.reconciled.push({
                sandboxId: row.sandboxId,
                project: row.project,
                action: 'create',
              });
            } else if (outcome.status === 'skipped') {
              report.skipped.push({
                sandboxId: row.sandboxId,
                project: row.project,
                code: outcome.code,
              });
            } else {
              report.uncertain.push({
                sandboxId: row.sandboxId,
                project: row.project,
                code: outcome.code,
              });
            }
            if (outcome.status !== 'reconciled') {
              return;
            }
          }

          const fresh = journal.get(row.project, row.sandboxId);
          if (!fresh) {
            report.skipped.push({
              sandboxId: row.sandboxId,
              project: row.project,
              code: 'journal_missing',
            });
            return;
          }
          if (
            fresh.operationState === 'pending' ||
            fresh.operationState === 'uncertain'
          ) {
            const latestReceipt = store.getSandbox(
              principal,
              row.sandboxId
            );
            const outcome = await reconcileOperationLocked(
              principal,
              latestReceipt,
              fresh
            );
            if (outcome.status === 'reconciled') {
              report.reconciled.push({
                sandboxId: row.sandboxId,
                project: row.project,
                action: fresh.operation,
              });
            } else {
              report.uncertain.push({
                sandboxId: row.sandboxId,
                project: row.project,
                code: outcome.code,
              });
            }
          }
        });
      } catch (error) {
        const mapped = mapError(error, 'recovery');
        report.uncertain.push({
          sandboxId: row.sandboxId,
          project: row.project,
          code: mapped.code,
        });
      }
    }
    return Object.freeze(report);
  }

  async function sweepTtl() {
    ensureOpen();
    const now = nowMs();
    const candidates = journal.listTtlCandidates(now);
    const report = {
      checked: candidates.length,
      stopped: [],
      deleted: [],
      retained: [],
      uncertain: [],
      skipped: [],
    };
    for (const row of candidates) {
      const principal = principalForRow(row);
      try {
        await runExclusive(`sandbox:${row.sandboxId}`, async () => {
          const current = journal.get(row.project, row.sandboxId);
          if (!current || current.deleteState === 'deleted') {
            report.skipped.push({
              sandboxId: row.sandboxId,
              project: row.project,
              code: 'already_deleted',
            });
            return;
          }
          const receipt = store.getSandbox(principal, row.sandboxId);
          if (receipt.deletedAt !== null) {
            journal.markDeleted({
              project: current.project,
              sandboxId: current.sandboxId,
            });
            report.skipped.push({
              sandboxId: row.sandboxId,
              project: row.project,
              code: 'already_deleted',
            });
            return;
          }
          if (
            receipt.expiresAt === null ||
            receipt.expiresAt > now
          ) {
            report.skipped.push({
              sandboxId: row.sandboxId,
              project: row.project,
              code: 'not_expired',
            });
            return;
          }
          if (
            receipt.desiredState === 'running' ||
            receipt.observedState === 'running'
          ) {
            try {
              await stopLocked(principal, {
                sandboxId: row.sandboxId,
                generation: null,
                requestId: null,
                operation: 'stop',
              });
              report.stopped.push({
                sandboxId: row.sandboxId,
                project: row.project,
              });
            } catch (error) {
              report.uncertain.push({
                sandboxId: row.sandboxId,
                project: row.project,
                code: mapError(error, 'ttl').code,
              });
              return;
            }
          }
          const afterStop = store.getSandbox(principal, row.sandboxId);
          if (
            afterStop.retention === 'until-export' &&
            afterStop.exportedAt === null
          ) {
            report.retained.push({
              sandboxId: row.sandboxId,
              project: row.project,
              code: 'export_required',
            });
            return;
          }
          try {
            await deleteLocked(principal, {
              sandboxId: row.sandboxId,
              generation: null,
              discard: false,
              reason: 'ttl-expired',
            });
            report.deleted.push({
              sandboxId: row.sandboxId,
              project: row.project,
            });
          } catch (error) {
            report.uncertain.push({
              sandboxId: row.sandboxId,
              project: row.project,
              code: mapError(error, 'ttl').code,
            });
          }
        });
      } catch (error) {
        report.uncertain.push({
          sandboxId: row.sandboxId,
          project: row.project,
          code: mapError(error, 'ttl').code,
        });
      }
    }
    return Object.freeze(report);
  }

  function dispatchHttpImpl(principalInput, request) {
    ensureOpen();
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      invalidInput();
    }
    if (
      typeof request.method !== 'string' ||
      typeof request.path !== 'string'
    ) {
      invalidInput();
    }
    const method = request.method.toUpperCase();
    const rawPath = request.path;
    if (
      rawPath.length === 0 ||
      rawPath.length > MAX_PATH_LENGTH ||
      CONTROL_CHARACTERS.test(rawPath)
    ) {
      invalidInput();
    }
    let url;
    try {
      url = new URL(rawPath, 'https://localhost');
    } catch {
      invalidInput();
    }
    if (url.search !== '' || url.hash !== '') {
      invalidInput('Query and fragment are not supported.');
    }
    const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
    if (
      segments.length < 2 ||
      segments[0] !== 'v1' ||
      segments[1] !== 'sandboxes'
    ) {
      notFound();
    }
    const body =
      request.body === undefined || request.body === null
        ? {}
        : request.body;
    if (typeof body !== 'object' || Array.isArray(body)) {
      invalidInput();
    }

    if (segments.length === 2) {
      if (method === 'POST') {
        return createSandbox(principalInput, body);
      }
      if (method === 'GET') {
        return listSandboxes(principalInput, body);
      }
      fail('method_not_allowed', 'Method is not allowed for this resource.', {
        status: 405,
        retryable: false,
      });
    }
    if (segments.length === 3) {
      const sandboxId = segments[2];
      if (method === 'GET') {
        return getSandbox(principalInput, sandboxId);
      }
      if (method === 'DELETE') {
        return deleteSandbox(principalInput, {
          ...body,
          sandboxId,
        });
      }
      fail('method_not_allowed', 'Method is not allowed for this resource.', {
        status: 405,
        retryable: false,
      });
    }
    if (segments.length === 4) {
      const sandboxId = segments[2];
      const action = segments[3];
      const input = { ...body, sandboxId };
      if (action === 'start' && method === 'POST') {
        return startSandbox(principalInput, input);
      }
      if (action === 'stop' && method === 'POST') {
        return stopSandbox(principalInput, input);
      }
      if (action === 'exec' && method === 'POST') {
        return execInSandbox(principalInput, input);
      }
      if (action === 'status' && method === 'GET') {
        return status(principalInput, sandboxId);
      }
      fail('method_not_allowed', 'Method is not allowed for this resource.', {
        status: 405,
        retryable: false,
      });
    }
    notFound();
  }

  function dispatchImpl(principalInput, request) {
    ensureOpen();
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      invalidInput();
    }
    if (typeof request.operation === 'string') {
      if (!OPERATIONS.has(request.operation)) {
        fail('unsupported_operation', 'Operation is not supported.', {
          status: 404,
          retryable: false,
        });
      }
      const input =
        request.input !== undefined
          ? request.input
          : request.body !== undefined
            ? request.body
            : request.sandboxId !== undefined
              ? { sandboxId: request.sandboxId }
              : {};
      switch (request.operation) {
        case 'create':
          return createSandbox(principalInput, input);
        case 'list':
          return listSandboxes(principalInput, input);
        case 'get':
          return getSandbox(principalInput, input);
        case 'start':
          return startSandbox(principalInput, input);
        case 'stop':
          return stopSandbox(principalInput, input);
        case 'delete':
          return deleteSandbox(principalInput, input);
        case 'exec':
          return execInSandbox(principalInput, input);
        case 'status':
          return status(principalInput, input);
        default:
          fail('unsupported_operation', 'Operation is not supported.', {
            status: 404,
            retryable: false,
          });
      }
    }
    if (
      typeof request.method === 'string' &&
      typeof request.path === 'string'
    ) {
      return dispatchHttpImpl(principalInput, request);
    }
    invalidInput();
  }

  function close() {
    if (closed) {
      return;
    }
    closed = true;
    locks.clear();
    if (ownedJournal) {
      journal.close();
    }
  }

  function mapped(fn) {
    return async function mappedMethod(...args) {
      try {
        return await fn(...args);
      } catch (error) {
        throw mapError(error);
      }
    };
  }

  const publicCreate = mapped(createSandbox);
  const publicList = mapped(listSandboxes);
  const publicGet = mapped(getSandbox);
  const publicStart = mapped(startSandbox);
  const publicStop = mapped(stopSandbox);
  const publicDelete = mapped(deleteSandbox);
  const publicExec = mapped(execInSandbox);
  const publicStatus = mapped(status);
  const publicDispatchHttp = mapped(dispatchHttpImpl);
  const publicDispatch = mapped(dispatchImpl);
  const publicRecoverStartup = mapped(recoverStartup);
  const publicSweepTtl = mapped(sweepTtl);

  return Object.freeze({
    createSandbox: publicCreate,
    listSandboxes: publicList,
    getSandbox: publicGet,
    startSandbox: publicStart,
    stopSandbox: publicStop,
    deleteSandbox: publicDelete,
    execInSandbox: publicExec,
    status: publicStatus,
    create: publicCreate,
    list: publicList,
    get: publicGet,
    start: publicStart,
    stop: publicStop,
    delete: publicDelete,
    exec: publicExec,
    dispatch: publicDispatch,
    dispatchHttp: publicDispatchHttp,
    recoverStartup: publicRecoverStartup,
    sweepTtl: publicSweepTtl,
    settle: () => Promise.allSettled([...pendingEngine.values()]),
    close,
  });
}

module.exports = {
  SandboxServiceError,
  createSandboxService,
  httpErrorFor,
  DEFAULT_PROJECT_QUOTA,
  DEFAULT_EXEC_TIMEOUT_MS,
  MAX_EXEC_TIMEOUT_MS,
  MAX_EXEC_OUTPUT_BYTES,
};
