'use strict';

/**
 * Durable workspace/job journal for the trusted local daemon.
 *
 * This module is deliberately storage-only. It never starts a VM, calls an
 * engine, spawns a process or talks to the network. The orchestrator reserves
 * capacity here *before* an external side effect, then records the engine's
 * native identifiers and observed state afterwards. Ambiguous external
 * outcomes are represented as `uncertain` jobs rather than being retried by
 * the store.
 *
 * Every mutation runs inside `BEGIN IMMEDIATE` on a private SQLite database in
 * the same preverified 0700 state directory as the pairing database. Reads are
 * project-scoped in SQL so a cross-project identifier is indistinguishable
 * from a missing one.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_LIMITS = Object.freeze({
  vcpus: 8,
  memoryMiB: 8192,
  diskMiB: 51200,
});
const DEFAULT_MAX_EVENTS = 1000;
const MAX_MAX_EVENTS = 100000;
const DEFAULT_LEASE_TTL_SECONDS = 60;
const MAX_LEASE_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_POLL_LIMIT = 100;

const MAX_STATE_DIR_LENGTH = 4096;
const MAX_PROJECT_LENGTH = 128;
const MAX_CLIENT_ID_LENGTH = 128;
const MAX_REQUEST_ID_LENGTH = 128;
const MAX_ENGINE_LENGTH = 64;
const MAX_ENGINE_VERSION_LENGTH = 64;
const MAX_PROFILE_LENGTH = 128;
const MAX_IMAGE_DIGEST_LENGTH = 256;
const MAX_NATIVE_ID_LENGTH = 256;
const MAX_HOLDER_LENGTH = 128;
const MAX_EVENT_TYPE_LENGTH = 64;
const MAX_CURSOR_LENGTH = 512;
const MAX_EXPORT_DIGEST_LENGTH = 256;
const MAX_REASON_LENGTH = 256;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_DETAIL_BYTES = 16 * 1024;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const MAX_JSON_DEPTH = 16;

const ROLES = new Set(['observer', 'runner', 'operator']);
const RETENTIONS = new Set(['ephemeral', 'ttl', 'until-export']);
const OBSERVED_STATES = new Set([
  'unknown',
  'starting',
  'running',
  'stopped',
  'failed',
  'removed',
]);
const DESIRED_STATES = new Set(['running', 'stopped']);
const JOB_DISPOSITIONS = new Set([
  'acknowledged',
  'uncertain',
  'completed',
  'cancelRequested',
  'cancelled',
  'failed',
]);

const JOB_TRANSITIONS = Object.freeze({
  acknowledged: new Set([
    'uncertain',
    'completed',
    'failed',
    'cancelRequested',
  ]),
  uncertain: new Set(['completed', 'failed', 'cancelRequested']),
  cancelRequested: new Set(['cancelled', 'completed', 'failed']),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
});

const BUSY_TIMEOUT_MS = 5000;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

class WorkStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorkStoreError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new WorkStoreError(code, message);
}

function invalidInput() {
  fail('invalid_input', 'Invalid input.');
}

function forbidden() {
  fail('forbidden', 'Operation is not permitted for this role.');
}

function notFound() {
  fail('not_found', 'Resource not found.');
}

function translateError(error) {
  if (error instanceof WorkStoreError) {
    return error;
  }
  if (
    error &&
    (error.errcode === 5 /* SQLITE_BUSY */ ||
      error.errcode === 6 /* SQLITE_LOCKED */)
  ) {
    return new WorkStoreError('store_busy', 'Work store is busy.');
  }
  return new WorkStoreError('store_error', 'Work store operation failed.');
}

function transact(db, operation, readOnly = false) {
  try {
    db.exec(readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE');
  } catch (error) { throw translateError(error); }
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* SQLite may already have rolled back. */ }
    throw translateError(error);
  }
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

function normalizeRole(role) {
  if (typeof role !== 'string' || !ROLES.has(role)) {
    invalidInput();
  }
  return role;
}

function normalizePrincipal(principal) {
  if (
    principal === null ||
    typeof principal !== 'object' ||
    Array.isArray(principal)
  ) {
    invalidInput();
  }
  return {
    clientId: normalizeText(principal.clientId, MAX_CLIENT_ID_LENGTH),
    project: normalizeText(principal.project, MAX_PROJECT_LENGTH),
    role: normalizeRole(principal.role),
  };
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

function normalizePositiveInteger(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    invalidInput();
  }
  return value;
}

function normalizeOptionalPositiveInteger(value) {
  if (value === undefined) {
    return undefined;
  }
  return normalizePositiveInteger(value);
}

function normalizeLimits(input) {
  if (input === undefined) {
    return { ...DEFAULT_LIMITS };
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    invalidInput();
  }
  const limits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    if (input[key] !== undefined) {
      limits[key] = normalizePositiveInteger(input[key]);
    }
  }
  return limits;
}

function normalizeMaxEvents(value) {
  if (value === undefined) {
    return DEFAULT_MAX_EVENTS;
  }
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_MAX_EVENTS
  ) {
    invalidInput();
  }
  return value;
}

function createClock(now) {
  if (now === undefined) {
    return () => Date.now();
  }
  if (typeof now === 'function') {
    return () => {
      const value = now();
      if (!Number.isSafeInteger(value) || value < 0) {
        invalidInput();
      }
      return value;
    };
  }
  if (Number.isSafeInteger(now) && now >= 0) {
    return () => now;
  }
  invalidInput();
}

function canonicalize(value, depth) {
  if (depth > MAX_JSON_DEPTH) {
    invalidInput();
  }
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
    return value.map((item) => canonicalize(item, depth + 1));
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) invalidInput();
    const result = Object.create(null);
    for (const key of keys) {
      if (key.length === 0 || key.length > 128) {
        invalidInput();
      }
      result[key] = canonicalize(value[key], depth + 1);
    }
    return result;
  }
  // undefined, functions, symbols and bigints cannot be persisted.
  invalidInput();
}

function canonicalJson(value, maxBytes) {
  let serialized;
  try {
    serialized = JSON.stringify(canonicalize(value, 0));
  } catch (error) {
    if (error instanceof WorkStoreError) {
      throw error;
    }
    invalidInput();
  }
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    fail('payload_too_large', 'Payload is too large.');
  }
  return serialized;
}

function digestOf(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function parseJson(value, fallback) {
  if (value === null || value === undefined) {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch {
    fail('store_error', 'Work store operation failed.');
  }
}

function sandboxReceipt(row) {
  return {
    sandboxId: row.sandbox_id,
    workspaceId: row.workspace_id,
    project: row.project,
    ownerClientId: row.client_id,
    ownerMarker: row.client_id,
    requestId: row.request_id,
    engine: row.engine,
    engineVersion: row.engine_version,
    profile: row.profile,
    imageDigest: row.image_digest,
    resources: {
      vcpus: row.vcpus,
      memoryMiB: row.memory_mib,
      diskMiB: row.disk_mib,
    },
    retention: row.retention,
    ttlSeconds: row.ttl_seconds,
    expiresAt: row.expires_at,
    generation: row.generation,
    desiredState: row.desired_state,
    observedState: row.observed_state,
    nativeId: row.native_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stoppedAt: row.stopped_at,
    exportedAt: row.exported_at,
    exportDigest: row.export_digest,
    deletedAt: row.deleted_at,
    deletedReason: row.deleted_reason,
  };
}

function jobReceipt(row) {
  return {
    jobId: row.job_id,
    project: row.project,
    ownerClientId: row.client_id,
    ownerMarker: row.client_id,
    requestId: row.request_id,
    workspaceId: row.workspace_id,
    sessionUuid: row.session_uuid,
    disposition: row.disposition,
    payload: parseJson(row.payload_json, {}),
    detail: parseJson(row.detail_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function eventReceipt(row) {
  return {
    seq: row.seq,
    type: row.type,
    sandboxId: row.sandbox_id,
    jobId: row.job_id,
    cursor: row.upstream_cursor,
    data: parseJson(row.data_json, {}),
    createdAt: row.created_at,
  };
}

function leaseReceipt(row, nowMs) {
  return {
    workspaceId: row.workspace_id,
    epoch: row.epoch_counter,
    holder: row.holder,
    expiresAt: row.expires_at,
    active:
      row.holder !== null &&
      row.expires_at !== null &&
      row.expires_at > nowMs,
  };
}

function lstatOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function currentUid() {
  if (typeof process.geteuid === 'function') {
    return process.geteuid();
  }
  if (typeof process.getuid === 'function') {
    return process.getuid();
  }
  return null;
}

function assertTrustedParent(stat) {
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    fail('unsafe_state_directory', 'Unsafe state directory.');
  }
  const uid = currentUid();
  if (uid !== null && stat.uid !== uid && stat.uid !== 0) {
    fail('unsafe_state_directory', 'Unsafe state directory.');
  }
  if ((stat.mode & 0o022) !== 0) {
    fail('unsafe_state_directory', 'Unsafe state directory.');
  }
}

function assertPrivateDirectory(stat) {
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    fail('unsafe_state_directory', 'Unsafe state directory.');
  }
  const uid = currentUid();
  if (uid !== null && stat.uid !== uid) {
    fail('unsafe_state_directory', 'Unsafe state directory.');
  }
  if ((stat.mode & 0o077) !== 0 || (stat.mode & 0o700) !== 0o700) {
    fail('unsafe_state_directory', 'Unsafe state directory.');
  }
}

function assertPrivateDatabaseFile(stat) {
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
    fail('unsafe_database_file', 'Unsafe database file.');
  }
  const uid = currentUid();
  if (uid !== null && stat.uid !== uid) {
    fail('unsafe_database_file', 'Unsafe database file.');
  }
  if ((stat.mode & 0o777) !== 0o600 || stat.nlink !== 1) {
    fail('unsafe_database_file', 'Unsafe database file.');
  }
}

function initializeSchema(db) {
  transact(db, () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS sandboxes (
        sandbox_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL UNIQUE,
        project TEXT NOT NULL,
        client_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        engine TEXT NOT NULL,
        engine_version TEXT NOT NULL,
        profile TEXT NOT NULL,
        image_digest TEXT NOT NULL,
        vcpus INTEGER NOT NULL,
        memory_mib INTEGER NOT NULL,
        disk_mib INTEGER NOT NULL,
        retention TEXT NOT NULL,
        ttl_seconds INTEGER,
        expires_at INTEGER,
        generation INTEGER NOT NULL,
        desired_state TEXT NOT NULL,
        observed_state TEXT NOT NULL,
        native_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        stopped_at INTEGER,
        exported_at INTEGER,
        export_digest TEXT,
        deleted_at INTEGER,
        deleted_reason TEXT,
        UNIQUE (project, client_id, request_id)
      );
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS sandboxes_by_project
        ON sandboxes (project, created_at, sandbox_id);
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        client_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        session_uuid TEXT NOT NULL,
        disposition TEXT NOT NULL,
        last_event_seq INTEGER NOT NULL DEFAULT 0,
        payload_json TEXT NOT NULL,
        detail_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (project, client_id, request_id)
      );
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS jobs_by_project
        ON jobs (project, created_at, job_id);
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS idempotency (
        project TEXT NOT NULL,
        client_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        request_key TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (project, client_id, operation, request_key)
      );
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_leases (
        workspace_id TEXT NOT NULL,
        project TEXT NOT NULL,
        epoch_counter INTEGER NOT NULL,
        holder TEXT,
        holder_client_id TEXT,
        expires_at INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, project)
      );
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        project TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        sandbox_id TEXT,
        job_id TEXT,
        upstream_cursor TEXT,
        job_seq INTEGER,
        data_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (project, seq)
      );
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS event_meta (
        project TEXT PRIMARY KEY,
        first_seq INTEGER NOT NULL,
        last_seq INTEGER NOT NULL
      );
    `);
    if (!db.prepare('PRAGMA table_info(events)').all().some(column => column.name === 'job_seq')) {
      db.exec(`
        ALTER TABLE events ADD COLUMN job_seq INTEGER;
        ALTER TABLE jobs ADD COLUMN last_event_seq INTEGER NOT NULL DEFAULT 0;
        WITH numbered AS MATERIALIZED (
          SELECT e.rowid AS rid, row_number() OVER (PARTITION BY e.project, e.job_id ORDER BY e.seq)
            + m.first_seq - 1 AS n
          FROM events e JOIN event_meta m ON m.project = e.project WHERE e.job_id IS NOT NULL
        ) UPDATE events SET job_seq = numbered.n FROM numbered WHERE events.rowid = numbered.rid;
        UPDATE jobs SET last_event_seq = coalesce(
          (SELECT max(job_seq) FROM events WHERE job_id = jobs.job_id),
          (SELECT first_seq - 1 FROM event_meta WHERE project = jobs.project), 0);
      `);
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS events_per_job ON events(job_id, job_seq) WHERE job_id IS NOT NULL');
    if (!db.prepare('PRAGMA table_info(workspace_leases)').all().some(column => column.name === 'holder_client_id')) {
      db.exec('ALTER TABLE workspace_leases ADD COLUMN holder_client_id TEXT');
      // Historical holder labels are operator-selected, so they cannot identify a client.
      db.exec('UPDATE workspace_leases SET holder = NULL, expires_at = NULL WHERE holder IS NOT NULL');
    }
  });
}

function openWorkStore(stateDir, options = {}) {
  try {
    return openWorkStoreInternal(stateDir, options);
  } catch (error) {
    if (error instanceof WorkStoreError) {
      throw error;
    }
    throw new WorkStoreError('store_unavailable', 'Work store is unavailable.');
  }
}

function openWorkStoreInternal(stateDir, options = {}) {
  if (
    typeof stateDir !== 'string' ||
    stateDir.length === 0 ||
    stateDir.length > MAX_STATE_DIR_LENGTH ||
    stateDir.includes('\u0000')
  ) {
    fail('unsafe_state_directory', 'Unsafe state directory.');
  }
  if (
    options === null ||
    typeof options !== 'object' ||
    Array.isArray(options)
  ) {
    invalidInput();
  }

  const clock = createClock(options.now);
  const limits = normalizeLimits(options.limits);
  const maxEvents = normalizeMaxEvents(options.maxEvents);
  const resolvedDir = path.resolve(stateDir);
  const parentDir = path.dirname(resolvedDir);

  const parentStat = lstatOrNull(parentDir);
  assertTrustedParent(parentStat);

  let dirStat = lstatOrNull(resolvedDir);
  if (!dirStat) {
    let created = false;
    try {
      fs.mkdirSync(resolvedDir, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') {
        fail('unsafe_state_directory', 'Unsafe state directory.');
      }
    }
    dirStat = lstatOrNull(resolvedDir);
    if (!dirStat) {
      fail('unsafe_state_directory', 'Unsafe state directory.');
    }
    if (created && (dirStat.mode & 0o777) !== 0o700) {
      try {
        fs.chmodSync(resolvedDir, 0o700);
      } catch {
        fail('unsafe_state_directory', 'Unsafe state directory.');
      }
      dirStat = lstatOrNull(resolvedDir);
    }
  }
  assertPrivateDirectory(dirStat);

  const dbPath = path.join(resolvedDir, 'work.sqlite');
  let dbStat = lstatOrNull(dbPath);
  if (!dbStat) {
    let created = false;
    try {
      const fd = fs.openSync(dbPath, 'wx', 0o600);
      fs.closeSync(fd);
      created = true;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') {
        fail('unsafe_database_file', 'Unsafe database file.');
      }
    }
    dbStat = lstatOrNull(dbPath);
    if (!dbStat) {
      fail('unsafe_database_file', 'Unsafe database file.');
    }
    if (created && (dbStat.mode & 0o777) !== 0o600) {
      try {
        fs.chmodSync(dbPath, 0o600);
      } catch {
        fail('unsafe_database_file', 'Unsafe database file.');
      }
      dbStat = lstatOrNull(dbPath);
    }
  }
  assertPrivateDatabaseFile(dbStat);

  const expectedFile = dbStat;
  let db;
  try {
    db = new DatabaseSync(dbPath);
  } catch {
    fail('store_unavailable', 'Work store is unavailable.');
  }

  try {
    const openedFile = lstatOrNull(dbPath);
    if (
      !openedFile ||
      openedFile.dev !== expectedFile.dev ||
      openedFile.ino !== expectedFile.ino
    ) {
      fail('unsafe_database_file', 'Unsafe database file.');
    }
  } catch (error) {
    try {
      db.close();
    } catch {
      // Ignore close failures while refusing an unsafe file.
    }
    throw error;
  }

  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    const journalMode = db.prepare('PRAGMA journal_mode').get();
    if (
      !journalMode ||
      String(journalMode.journal_mode).toLowerCase() !== 'delete'
    ) {
      db.exec('PRAGMA journal_mode = DELETE');
    }
    db.exec('PRAGMA synchronous = FULL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA temp_store = MEMORY');
    initializeSchema(db);
  } catch (error) {
    try {
      db.close();
    } catch {
      // Ignore close failures while reporting the original error.
    }
    throw translateError(error);
  }

  return new WorkStore(db, clock, limits, maxEvents);
}

class WorkStore {
  constructor(db, clock, limits, maxEvents) {
    this.db = db;
    this._clock = clock;
    this._limits = limits;
    this._maxEvents = maxEvents;
    this._closed = false;
  }

  /**
   * Close this connection. Other connections remain usable.
   */
  close() {
    if (this._closed) {
      return;
    }
    this._closed = true;
    this.db.close();
  }

  _ensureOpen() {
    if (this._closed) {
      fail('store_closed', 'Work store is closed.');
    }
  }

  _now() {
    const value = this._clock();
    if (!Number.isSafeInteger(value) || value < 0) {
      invalidInput();
    }
    return value;
  }

  _sandbox(project, sandboxId) {
    return this.db
      .prepare(
        `SELECT * FROM sandboxes
          WHERE sandbox_id = ? AND project = ?`
      )
      .get(sandboxId, project);
  }

  _activeSandbox(project, sandboxId) {
    return this.db
      .prepare(
        `SELECT * FROM sandboxes
          WHERE sandbox_id = ? AND project = ? AND deleted_at IS NULL`
      )
      .get(sandboxId, project);
  }

  _job(project, jobId) {
    return this.db
      .prepare('SELECT * FROM jobs WHERE job_id = ? AND project = ?')
      .get(jobId, project);
  }

  _workspace(project, workspaceId) {
    return this.db
      .prepare(
        `SELECT * FROM sandboxes
          WHERE workspace_id = ? AND project = ? AND deleted_at IS NULL`
      )
      .get(workspaceId, project);
  }

  _lease(project, workspaceId) {
    return this.db
      .prepare(
        `SELECT * FROM workspace_leases
          WHERE workspace_id = ? AND project = ?`
      )
      .get(workspaceId, project);
  }

  _checkIdempotency(project, clientId, operation, key, payloadHash) {
    const row = this.db
      .prepare(
        `SELECT payload_hash, result_json FROM idempotency
          WHERE project = ? AND client_id = ? AND operation = ?
            AND request_key = ?`
      )
      .get(project, clientId, operation, key);
    if (!row) {
      return null;
    }
    if (row.payload_hash !== payloadHash) {
      fail(
        'idempotency_conflict',
        'Request key was already used with a different payload.'
      );
    }
    return parseJson(row.result_json, null);
  }

  _rememberIdempotency(
    project,
    clientId,
    operation,
    key,
    payloadHash,
    result
  ) {
    this.db
      .prepare(
        `INSERT INTO idempotency
          (project, client_id, operation, request_key, payload_hash,
           result_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        project,
        clientId,
        operation,
        key,
        payloadHash,
        JSON.stringify(result),
        this._now()
      );
  }

  /**
   * Reserve host capacity and durably allocate a sandbox/workspace pair.
   *
   * principal: {clientId, project, role}
   * input: {requestId, engine, engineVersion, profile, imageDigest,
   *         resources: {vcpus, memoryMiB, diskMiB},
   *         retention: 'ephemeral'|'ttl'|'until-export',
   *         ttlSeconds?: integer}
   *
   * Returns a sandbox receipt. Replaying the same requestId with an identical
   * normalized payload returns the current receipt; a changed payload raises
   * `idempotency_conflict`. Capacity is checked atomically across every
   * project before the row is written.
   */
  reserveSandbox(principalInput, input) {
    this._ensureOpen();
    const principal = normalizePrincipal(principalInput);
    requireWriter(principal);
    const body = normalizeInputObject(input);

    const requestId = normalizeText(
      body.requestId,
      MAX_REQUEST_ID_LENGTH
    );
    const engine = normalizeText(body.engine, MAX_ENGINE_LENGTH);
    const engineVersion = normalizeText(
      body.engineVersion,
      MAX_ENGINE_VERSION_LENGTH
    );
    const profile = normalizeText(body.profile, MAX_PROFILE_LENGTH);
    const imageDigest = normalizeText(
      body.imageDigest,
      MAX_IMAGE_DIGEST_LENGTH
    );

    const resources = normalizeInputObject(body.resources);
    const vcpus = normalizePositiveInteger(resources.vcpus);
    const memoryMiB = normalizePositiveInteger(resources.memoryMiB);
    const diskMiB = normalizePositiveInteger(resources.diskMiB);

    const retention =
      body.retention === undefined ? 'ephemeral' : body.retention;
    if (typeof retention !== 'string' || !RETENTIONS.has(retention)) {
      invalidInput();
    }

    let ttlSeconds;
    if (body.ttlSeconds !== undefined) {
      ttlSeconds = normalizeOptionalPositiveInteger(body.ttlSeconds);
    } else if (retention === 'ttl') {
      invalidInput();
    }
    if (
      ttlSeconds !== undefined &&
      (!Number.isSafeInteger(ttlSeconds) ||
        ttlSeconds <= 0 ||
        ttlSeconds > 365 * 24 * 60 * 60)
    ) {
      invalidInput();
    }

    const normalized = {
      requestId,
      engine,
      engineVersion,
      profile,
      imageDigest,
      resources: { vcpus, memoryMiB, diskMiB },
      retention,
      ttlSeconds: ttlSeconds === undefined ? null : ttlSeconds,
    };
    const payloadHash = digestOf(canonicalJson(normalized, MAX_JSON_BYTES));

    try {
      return transact(this.db, () => {
        const existing = this._checkIdempotency(
          principal.project,
          principal.clientId,
          'reserveSandbox',
          requestId,
          payloadHash
        );
        if (existing !== null) {
          const row = this._sandbox(
            principal.project,
            existing.sandboxId
          );
          if (!row) {
            fail('store_error', 'Work store operation failed.');
          }
          return sandboxReceipt(row);
        }

        if (
          vcpus > this._limits.vcpus ||
          memoryMiB > this._limits.memoryMiB ||
          diskMiB > this._limits.diskMiB
        ) {
          fail('quota_exceeded', 'Host capacity is insufficient.');
        }

        const used = this.db
          .prepare(
            `SELECT COALESCE(SUM(vcpus), 0) AS vcpus,
                    COALESCE(SUM(memory_mib), 0) AS memory,
                    COALESCE(SUM(disk_mib), 0) AS disk
               FROM sandboxes
              WHERE deleted_at IS NULL`
          )
          .get();
        if (
          used.vcpus + vcpus > this._limits.vcpus ||
          used.memory + memoryMiB > this._limits.memoryMiB ||
          used.disk + diskMiB > this._limits.diskMiB
        ) {
          fail('quota_exceeded', 'Host capacity is insufficient.');
        }

        const nowMs = this._now();
        const sandboxId = crypto.randomUUID();
        const workspaceId = crypto.randomUUID();
        const expiresAt =
          ttlSeconds === undefined ? null : nowMs + ttlSeconds * 1000;
        if (expiresAt !== null && !Number.isSafeInteger(expiresAt)) {
          fail('store_error', 'Work store operation failed.');
        }

        this.db
          .prepare(
            `INSERT INTO sandboxes
              (sandbox_id, workspace_id, project, client_id, request_id,
               engine, engine_version, profile, image_digest,
               vcpus, memory_mib, disk_mib, retention, ttl_seconds,
               expires_at, generation, desired_state, observed_state,
               native_id, created_at, updated_at, stopped_at, exported_at,
               export_digest, deleted_at, deleted_reason)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                     NULL, ?, ?, NULL, NULL, NULL, NULL, NULL)`
          )
          .run(
            sandboxId,
            workspaceId,
            principal.project,
            principal.clientId,
            requestId,
            engine,
            engineVersion,
            profile,
            imageDigest,
            vcpus,
            memoryMiB,
            diskMiB,
            retention,
            ttlSeconds === undefined ? null : ttlSeconds,
            expiresAt,
            1,
            'running',
            'unknown',
            nowMs,
            nowMs
          );

        this._rememberIdempotency(
          principal.project,
          principal.clientId,
          'reserveSandbox',
          requestId,
          payloadHash,
          { sandboxId }
        );

        return sandboxReceipt(
          this._sandbox(principal.project, sandboxId)
        );
      });
    } catch (error) {
      throw translateError(error);
    }
  }

  /**
   * Read one sandbox. A sandbox in another project is reported as
   * `not_found`, exactly like an unknown identifier.
   */
  getSandbox(principalInput, sandboxId) {
    this._ensureOpen();
    const principal = normalizePrincipal(principalInput);
    const id = normalizeText(sandboxId, MAX_REQUEST_ID_LENGTH);
    try {
      const row = this._sandbox(principal.project, id);
      if (!row) {
        notFound();
      }
      return sandboxReceipt(row);
    } catch (error) {
      throw translateError(error);
    }
  }

  /**
   * List non-deleted sandboxes in the principal's project, oldest first.
   */
  listSandboxes(principalInput) {
    this._ensureOpen();
    const principal = normalizePrincipal(principalInput);
    try {
      const rows = this.db
        .prepare(
          `SELECT * FROM sandboxes
            WHERE project = ? AND deleted_at IS NULL
            ORDER BY created_at ASC, sandbox_id ASC`
        )
        .all(principal.project);
      return rows.map(sandboxReceipt);
    } catch (error) {
      throw translateError(error);
    }
  }

  /**
   * Attach an engine-native identifier after a successful launch.
   *
   * The caller must pass the generation it read. A stale generation is
   * rejected with `generation_conflict`; the update is never applied.
   */
  attachEngine(principalInput, input) {
    this._ensureOpen();
    const principal = normalizePrincipal(principalInput);
    requireWriter(principal);
    const body = normalizeInputObject(input);
    const sandboxId = normalizeText(
      body.sandboxId,
      MAX_REQUEST_ID_LENGTH
    );
    const nativeId = normalizeText(body.nativeId, MAX_NATIVE_ID_LENGTH);
    const generation = normalizePositiveInteger(body.generation);

    try {
      return transact(this.db, () => {
        const row = this._activeSandbox(principal.project, sandboxId);
        if (!row) {
          notFound();
        }
        if (row.generation !== generation) {
          fail('generation_conflict', 'Sandbox generation is stale.');
        }
        if (row.desired_state !== 'running') {
          fail(
            'invalid_transition',
            'Cannot attach an engine to a stopped sandbox.'
          );
        }
        if (row.native_id !== null && row.native_id !== nativeId) fail('generation_conflict', 'Native identity changed.');
        if (row.native_id === nativeId && row.observed_state === 'running') return sandboxReceipt(row);
        const nowMs = this._now();
        this.db
          .prepare(
            `UPDATE sandboxes
                SET native_id = ?, observed_state = 'running',
                    generation = generation + 1, updated_at = ?
              WHERE sandbox_id = ? AND project = ?
                AND generation = ? AND deleted_at IS NULL`
          )
          .run(nativeId, nowMs, sandboxId, principal.project, generation);
        return sandboxReceipt(
          this._sandbox(principal.project, sandboxId)
        );
      });
    } catch (error) {
      throw translateError(error);
    }
  }

  /**
   * Record an observed engine state with a generation check.
   *
   * observedState is one of unknown|starting|running|stopped|failed.
   */
  recordObserved(principalInput, input) {
    this._ensureOpen();
    const principal = normalizePrincipal(principalInput);
    requireWriter(principal);
    const body = normalizeInputObject(input);
    const sandboxId = normalizeText(
      body.sandboxId,
      MAX_REQUEST_ID_LENGTH
    );
    const generation = normalizePositiveInteger(body.generation);
    const observedState = body.observedState;
    if (
      typeof observedState !== 'string' ||
      !OBSERVED_STATES.has(observedState)
    ) {
      invalidInput();
    }

    try {
      return transact(this.db, () => {
        const row = this._activeSandbox(principal.project, sandboxId);
        if (!row) {
          notFound();
        }
        if (row.generation !== generation) {
          fail('generation_conflict', 'Sandbox generation is stale.');
        }
        const nowMs = this._now();
        const stoppedAt =
          observedState === 'stopped'
            ? row.stopped_at === null
              ? nowMs
              : row.stopped_at
            : row.stopped_at;
        this.db
          .prepare(
            `UPDATE sandboxes
                SET observed_state = ?, stopped_at = ?,
                    generation = generation + 1, updated_at = ?
              WHERE sandbox_id = ? AND project = ?
                AND generation = ? AND deleted_at IS NULL`
          )
          .run(
            observedState,
            stoppedAt,
            nowMs,
            sandboxId,
            principal.project,
            generation
          );
        return sandboxReceipt(
          this._sandbox(principal.project, sandboxId)
        );
      });
    } catch (error) {
      throw translateError(error);
    }
  }

  /**
   * Request that a sandbox stop. This only changes desired state; the
   * orchestrator performs the external stop and then records observed state.
   */
  stopSandbox(principalInput, input) {
    this._ensureOpen();
    const principal = normalizePrincipal(principalInput);
    requireWriter(principal);
    const body = normalizeInputObject(input);
    const sandboxId = normalizeText(
      body.sandboxId,
      MAX_REQUEST_ID_LENGTH
    );
    const generation = normalizeOptionalPositiveInteger(body.generation);

    try {
      return transact(this.db, () => {
        const row = this._activeSandbox(principal.project, sandboxId);
        if (!row) {
          notFound();
        }
        if (generation !== undefined && row.generation !== generation) {
          fail('generation_conflict', 'Sandbox generation is stale.');
        }
        if (row.desired_state === 'stopped') {
          return sandboxReceipt(row);
        }
        const nowMs = this._now();
        this.db
          .prepare(
            `UPDATE sandboxes
                SET desired_state = 'stopped',
                    generation = generation + 1, updated_at = ?
              WHERE sandbox_id = ? AND project = ?
                AND deleted_at IS NULL`
          )
          .run(nowMs, sandboxId, principal.project);
        return sandboxReceipt(
          this._sandbox(principal.project, sandboxId)
        );
      });
    } catch (error) {
      throw translateError(error);
    }
  }

  startSandbox(principalInput, input) {
    this._ensureOpen();
    const principal = normalizePrincipal(principalInput);
    requireWriter(principal);
    const body = normalizeInputObject(input);
    const id = normalizeText(body.sandboxId, MAX_REQUEST_ID_LENGTH);
    const generation = normalizePositiveInteger(body.generation);
    return transact(this.db, () => {
      const row = this._activeSandbox(principal.project, id);
      if (!row) notFound();
      if (generation !== row.generation) fail('generation_conflict', 'Sandbox generation is stale.');
      const now = this._now();
      if (row.expires_at !== null && row.expires_at <= now) fail('invalid_transition', 'Sandbox expired.');
      if (row.observed_state === 'removed') fail('invalid_transition', 'Sandbox has been removed.');
      if (row.desired_state === 'running') return sandboxReceipt(row);
      if (row.observed_state !== 'stopped') fail('invalid_transition', 'Sandbox stop is unconfirmed.');
      this.db.prepare(`UPDATE sandboxes SET desired_state = 'running', stopped_at = NULL,
        generation = generation + 1, updated_at = ? WHERE sandbox_id = ? AND project = ?`).run(now, id, principal.project);
      return sandboxReceipt(this._sandbox(principal.project, id));
    });
  }

  /**
   * Acknowledge that the workspace content was exported. Required before a
   * normal deletion when retention is `until-export`.
   */
  acknowledgeExport(principalInput, input) {
    this._ensureOpen();
    const principal = normalizePrincipal(principalInput);
    requireWriter(principal);
    const body = normalizeInputObject(input);
    const sandboxId = normalizeText(
      body.sandboxId,
      MAX_REQUEST_ID_LENGTH
    );
    const exportDigest =
      body.digest === undefined
        ? null
        : normalizeText(body.digest, MAX_EXPORT_DIGEST_LENGTH);

    try {
      return transact(this.db, () => {
        const row = this._activeSandbox(principal.project, sandboxId);
        if (!row) {
          notFound();
        }
        if (row.exported_at !== null) {
          return sandboxReceipt(row);
        }
        const nowMs = this._now();
        this.db
          .prepare(
            `UPDATE sandboxes
                SET exported_at = ?, export_digest = ?,
                    generation = generation + 1, updated_at = ?
              WHERE sandbox_id = ? AND project = ?
                AND deleted_at IS NULL`
          )
          .run(
            nowMs,
            exportDigest,
            nowMs,
            sandboxId,
            principal.project
          );
        return sandboxReceipt(
          this._sandbox(principal.project, sandboxId)
        );
      });
    } catch (error) {
      throw translateError(error);
    }
  }

  /**
   * Delete a stopped sandbox and release its quota. Operator only.
   *
   * When retention is `until-export` and no export was acknowledged, this
   * fails with `export_required`; use `discardSandbox` for an explicit
   * destructive operator decision.
   */
  deleteSandbox(principalInput, input) {
    this._ensureOpen();
    const principal = normalizePrincipal(principalInput);
    requireOperator(principal);
    const body = normalizeInputObject(input);
    const sandboxId = normalizeText(
      body.sandboxId,
      MAX_REQUEST_ID_LENGTH
    );

    try {
      return transact(this.db, () => {
        const row = this._sandbox(principal.project, sandboxId);
        if (!row) {
          notFound();
        }
        if (row.deleted_at !== null) return sandboxReceipt(row);
        if (body.generation !== undefined && normalizePositiveInteger(body.generation) !== row.generation) {
          fail('generation_conflict', 'Sandbox generation is stale.');
        }
        if (row.desired_state !== 'stopped') {
          fail(
            'invalid_transition',
            'Sandbox must be stopped before deletion.'
          );
        }
        if (row.retention === 'until-export' && row.exported_at === null) {
          fail(
            'export_required',
            'Export must be acknowledged before deletion.'
          );
        }
        if (row.observed_state !== 'removed') fail('invalid_transition', 'Engine removal is unconfirmed.');
        const nowMs = this._now();
        this.db
          .prepare(
            `UPDATE sandboxes
                SET deleted_at = ?, deleted_reason = 'deleted',
                    generation = generation + 1, updated_at = ?
              WHERE sandbox_id = ? AND project = ?
                AND deleted_at IS NULL`
          )
          .run(nowMs, nowMs, sandboxId, principal.project);
        return sandboxReceipt(
          this._sandbox(principal.project, sandboxId)
        );
      });
    } catch (error) {
      throw translateError(error);
    }
  }

  /**
   * Destructively discard a sandbox regardless of export state. Operator
   * only. This is the explicit escape hatch for retained content.
   */
  discardSandbox(principalInput, input) {
    this._ensureOpen();
    const principal = normalizePrincipal(principalInput);
    requireOperator(principal);
    const body = normalizeInputObject(input);
    const sandboxId = normalizeText(
      body.sandboxId,
      MAX_REQUEST_ID_LENGTH
    );
    const reason =
      body.reason === undefined
        ? 'discarded'
        : normalizeText(body.reason, MAX_REASON_LENGTH);

    try {
      return transact(this.db, () => {
        const row = this._sandbox(principal.project, sandboxId);
        if (!row) {
          notFound();
        }
        if (row.deleted_at !== null) return sandboxReceipt(row);
        if (body.generation !== undefined && normalizePositiveInteger(body.generation) !== row.generation) {
          fail('generation_conflict', 'Sandbox generation is stale.');
        }
        if (row.observed_state !== 'removed') fail('invalid_transition', 'Engine removal is unconfirmed.');
        const nowMs = this._now();
        this.db
          .prepare(
            `UPDATE sandboxes
                SET deleted_at = ?, deleted_reason = ?,
                    generation = generation + 1, updated_at = ?
              WHERE sandbox_id = ? AND project = ?
                AND deleted_at IS NULL`
          )
          .run(nowMs, reason, nowMs, sandboxId, principal.project);
        return sandboxReceipt(
          this._sandbox(principal.project, sandboxId)
        );
      });
    } catch (error) {
      throw translateError(error);
    }
  }

  /**
   * Enumerate work that may need recovery in the principal's project:
   * sandboxes whose desired/observed states disagree and jobs that are not
   * terminal. The store performs no external recovery itself.
   */
  listPendingRecovery(principalInput) {
    this._ensureOpen();
    const principal = normalizePrincipal(principalInput);
    requireWriter(principal);
    try {
      const sandboxes = this.db
        .prepare(
          `SELECT * FROM sandboxes
            WHERE project = ? AND deleted_at IS NULL
              AND (desired_state <> observed_state
                   OR observed_state IN ('unknown', 'starting', 'failed'))
            ORDER BY created_at ASC, sandbox_id ASC`
        )
        .all(principal.project);
      const jobs = this.db
        .prepare(
          `SELECT * FROM jobs
            WHERE project = ?
              AND disposition IN
                ('acknowledged', 'uncertain', 'cancelRequested')
            ORDER BY created_at ASC, job_id ASC`
        )
        .all(principal.project);
      return {
        sandboxes: sandboxes.map(sandboxReceipt),
        jobs: jobs.map(jobReceipt),
      };
    } catch (error) {
      throw translateError(error);
    }
  }

  /**
   * Persist a job admission before any external side effect.
   *
   * input: {requestId, workspaceId, payload?}
   *
   * Returns a job receipt with a stable jobId and a persisted `sessionUuid`
   * used for the native session. Replaying the same requestId/payload returns
   * the same job in its current disposition; a changed payload raises
   * `idempotency_conflict`.
   */
  submitJob(principalInput, input) {
    this._ensureOpen();
    const principal = normalizePrincipal(principalInput);
    requireWriter(principal);
    const body = normalizeInputObject(input);
    const requestId = normalizeText(
      body.requestId,
      MAX_REQUEST_ID_LENGTH
    );
    const workspaceId = normalizeText(
      body.workspaceId,
      MAX_REQUEST_ID_LENGTH
    );
    const payloadJson = canonicalJson(
      body.payload === undefined ? {} : body.payload,
      MAX_JSON_BYTES
    );

    const payloadHash = digestOf(
      canonicalJson(
        { requestId, workspaceId, payload: JSON.parse(payloadJson) },
        MAX_JSON_BYTES
      )
    );

    try {
      return transact(this.db, () => {
        const existing = this._checkIdempotency(
          principal.project,
          principal.clientId,
          'submitJob',
          requestId,
          payloadHash
        );
        if (existing !== null) {
          const row = this._job(principal.project, existing.jobId);
          if (!row) {
            fail('store_error', 'Work store operation failed.');
          }
          return jobReceipt(row);
        }

        const workspace = this._workspace(
          principal.project,
          workspaceId
        );
        if (!workspace) {
          notFound();
        }

        const nowMs = this._now();
        const jobId = crypto.randomUUID();
        const sessionUuid = crypto.randomUUID();
        this.db
          .prepare(
            `INSERT INTO jobs
              (job_id, project, client_id, request_id, workspace_id,
               session_uuid, disposition, payload_json, detail_json,
               created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'acknowledged', ?, NULL, ?, ?)`
          )
          .run(
            jobId,
            principal.project,
            principal.clientId,
            requestId,
            workspaceId,
            sessionUuid,
            payloadJson,
            nowMs,
            nowMs
          );

        this._rememberIdempotency(
          principal.project,
          principal.clientId,
          'submitJob',
          requestId,
          payloadHash,
          { jobId }
        );

        return jobReceipt(this._job(principal.project, jobId));
      });
    } catch (error) {
      throw translateError(error);
    }
  }

  /**
   * Read one job, project-scoped.
   */
  getJob(principalInput, jobId) {
    this._ensureOpen();
    const principal = normalizePrincipal(principalInput);
    const id = normalizeText(jobId, MAX_REQUEST_ID_LENGTH);
    try {
      const row = this._job(principal.project, id);
      if (!row) {
        notFound();
      }
      return jobReceipt(row);
    } catch (error) {
      throw translateError(error);
    }
  }

  /**
   * List jobs in the principal's project, oldest first.
   */
  listJobs(principalInput) {
    this._ensureOpen();
    const principal = normalizePrincipal(principalInput);
    try {
      const rows = this.db
        .prepare(
          `SELECT * FROM jobs
            WHERE project = ?
            ORDER BY created_at ASC, job_id ASC`
        )
        .all(principal.project);
      return rows.map(jobReceipt);
    } catch (error) {
      throw translateError(error);
    }
  }

  /**
   * Advance a job through the strict disposition graph:
   *
   *   acknowledged -> uncertain | completed | failed | cancelRequested
   *   uncertain    -> completed | failed | cancelRequested
   *   cancelRequested -> cancelled | completed | failed
   *   completed | failed | cancelled -> terminal
   *
   * `uncertain` means an external submission may have happened but its
   * outcome is unknown. It can never return to `acknowledged`, so a caller
   * cannot accidentally resend an ambiguous submission.
   */
  markJob(principalInput, input) {
    this._ensureOpen();
    const principal = normalizePrincipal(principalInput);
    requireWriter(principal);
    const body = normalizeInputObject(input);
    const jobId = normalizeText(body.jobId, MAX_REQUEST_ID_LENGTH);
    const disposition = body.disposition;
    if (
      typeof disposition !== 'string' ||
      !JOB_DISPOSITIONS.has(disposition)
    ) {
      invalidInput();
    }
    const detailJson =
      body.detail === undefined
        ? null
        : canonicalJson(body.detail, MAX_DETAIL_BYTES);

    try {
      return transact(this.db, () => {
        const row = this._job(principal.project, jobId);
        if (!row) {
          notFound();
        }
        if (row.disposition === disposition) {
          return jobReceipt(row);
        }
        if (!JOB_TRANSITIONS[row.disposition].has(disposition)) {
          fail(
            'invalid_transition',
            'Job disposition transition is not permitted.'
          );
        }
        const nowMs = this._now();
        this.db
          .prepare(
            `UPDATE jobs
                SET disposition = ?, detail_json = ?, updated_at = ?
              WHERE job_id = ? AND project = ?`
          )
          .run(disposition, detailJson, nowMs, jobId, principal.project);
        return jobReceipt(this._job(principal.project, jobId));
      });
    } catch (error) {
      throw translateError(error);
    }
  }

  /**
   * Append a project-scoped ordered event.
   *
   * input: {type, sandboxId?, jobId?, cursor?, data?}
   *
   * `cursor` is an opaque upstream cursor retained with the event. Events are
   * trimmed to the store's `maxEvents` bound per project.
   */
  appendEvent(principalInput, input) {
    this._ensureOpen();
    const principal = normalizePrincipal(principalInput);
    requireWriter(principal);
    const body = normalizeInputObject(input);
    const type = normalizeText(body.type, MAX_EVENT_TYPE_LENGTH);
    const sandboxId =
      body.sandboxId === undefined
        ? null
        : normalizeText(body.sandboxId, MAX_REQUEST_ID_LENGTH);
    const jobId =
      body.jobId === undefined
        ? null
        : normalizeText(body.jobId, MAX_REQUEST_ID_LENGTH);
    const cursor =
      body.cursor === undefined
        ? null
        : normalizeText(body.cursor, MAX_CURSOR_LENGTH);
    const dataJson = canonicalJson(
      body.data === undefined ? {} : body.data,
      MAX_JSON_BYTES
    );

    try {
      return transact(this.db, () => {
        if (sandboxId !== null && !this._activeSandbox(
          principal.project,
          sandboxId
        )) {
          notFound();
        }
        let jobSeq = null;
        if (jobId !== null) {
          const job = this._job(principal.project, jobId);
          if (!job || (sandboxId !== null && this._sandbox(principal.project, sandboxId).workspace_id !== job.workspace_id)) notFound();
          jobSeq = job.last_event_seq + 1;
          this.db.prepare('UPDATE jobs SET last_event_seq = ? WHERE job_id = ?').run(jobSeq, jobId);
        }

        let meta = this.db
          .prepare(
            'SELECT first_seq, last_seq FROM event_meta WHERE project = ?'
          )
          .get(principal.project);
        if (!meta) {
          this.db
            .prepare(
              `INSERT INTO event_meta (project, first_seq, last_seq)
               VALUES (?, 1, 0)`
            )
            .run(principal.project);
          meta = { first_seq: 1, last_seq: 0 };
        }

        const seq = meta.last_seq + 1;
        const nowMs = this._now();
        this.db
          .prepare(
            `INSERT INTO events
              (project, seq, type, sandbox_id, job_id, job_seq, upstream_cursor,
               data_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            principal.project,
            seq,
            type,
            sandboxId,
            jobId,
            jobSeq,
            cursor,
            dataJson,
            nowMs
          );

        let firstSeq = meta.first_seq;
        if (seq - firstSeq + 1 > this._maxEvents) {
          const newFirst = seq - this._maxEvents + 1;
          this.db
            .prepare(
              `DELETE FROM events
                WHERE project = ? AND seq < ?`
            )
            .run(principal.project, newFirst);
          firstSeq = newFirst;
        }

        this.db
          .prepare(
            `UPDATE event_meta
                SET first_seq = ?, last_seq = ?
              WHERE project = ?`
          )
          .run(firstSeq, seq, principal.project);

        return {
          seq,
          type,
          sandboxId,
          jobId,
          cursor,
          data: parseJson(dataJson, {}),
          createdAt: nowMs,
        };
      });
    } catch (error) {
      throw translateError(error);
    }
  }

  /**
   * Poll events strictly after `afterSeq`.
   *
   * Returns {events, nextSeq, firstSeq, lastSeq, gap, reset}.
   * - `gap` is true when the requested cursor predates the retained window;
   *   replay starts at `firstSeq`.
   * - `reset` is true when `afterSeq` is beyond the store's last sequence
   *   (for example after a database reset); the retained window is replayed.
   */
  pollEvents(principalInput, input) {
    this._ensureOpen();
    const principal = normalizePrincipal(principalInput);
    const body = normalizeInputObject(input);
    const afterSeq =
      body.afterSeq === undefined ? 0 : body.afterSeq;
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
      invalidInput();
    }
    const limit =
      body.limit === undefined
        ? Math.min(DEFAULT_POLL_LIMIT, this._maxEvents)
        : normalizePositiveInteger(body.limit);
    if (limit > this._maxEvents) {
      invalidInput();
    }

    return transact(this.db, () => {
      const meta = this.db
        .prepare(
          'SELECT first_seq, last_seq FROM event_meta WHERE project = ?'
        )
        .get(principal.project);
      if (!meta) {
        return {
          events: [],
          nextSeq: 0,
          firstSeq: 1,
          lastSeq: 0,
          gap: false,
          reset: afterSeq > 0,
        };
      }

      let gap = false;
      let reset = false;
      let fromSeq;
      if (afterSeq > meta.last_seq) {
        reset = true;
        fromSeq = meta.first_seq;
      } else if (afterSeq < meta.first_seq - 1) {
        gap = true;
        fromSeq = meta.first_seq;
      } else {
        fromSeq = afterSeq + 1;
      }

      const rows = this.db
        .prepare(
          `SELECT * FROM events
            WHERE project = ? AND seq >= ?
            ORDER BY seq ASC
            LIMIT ?`
        )
        .all(principal.project, fromSeq, limit);

      const events = rows.map(eventReceipt);
      const nextSeq =
        events.length === 0 ? afterSeq : events[events.length - 1].seq;

      return {
        events,
        nextSeq,
        firstSeq: meta.first_seq,
        lastSeq: meta.last_seq,
        gap,
        reset,
      };
    }, true);
  }

  pollJobEvents(principalInput, input) {
    this._ensureOpen();
    const principal = normalizePrincipal(principalInput);
    const body = normalizeInputObject(input);
    const jobId = normalizeText(body.jobId, MAX_REQUEST_ID_LENGTH);
    const after = body.afterSeq ?? 0;
    const limit = body.limit ?? Math.min(DEFAULT_POLL_LIMIT, this._maxEvents);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > this._maxEvents) invalidInput();
    return transact(this.db, () => {
      const job = this._job(principal.project, jobId);
      if (!job) notFound();
      const lastSeq = job.last_event_seq;
      const firstSeq = this.db.prepare('SELECT min(job_seq) AS n FROM events WHERE job_id = ?').get(jobId).n ?? lastSeq + 1;
      const reset = after > lastSeq;
      const gap = after < firstSeq - 1;
      const from = reset || gap ? firstSeq : after + 1;
      const rows = this.db.prepare(
        'SELECT * FROM events WHERE job_id = ? AND job_seq >= ? ORDER BY job_seq LIMIT ?'
      ).all(jobId, from, limit);
      const events = rows.map(row => ({ ...eventReceipt(row), seq: row.job_seq }));
      return { events, firstSeq, lastSeq, nextSeq: events.at(-1)?.seq ?? lastSeq, reset, gap };
    }, true);
  }

  /**
   * Acquire the writer lease for a workspace.
   *
   * input: {workspaceId, holder?, ttlSeconds?}
   *
   * The epoch is persisted and strictly increases on every acquisition,
   * including across release/acquire, handoff and process restart. An active
   * unexpired lease raises `lease_held`. Expired leases may be replaced.
   */
  acquireLease(principalInput, input) {
    this._ensureOpen();
    const principal = normalizePrincipal(principalInput);
    requireWriter(principal);
    const body = normalizeInputObject(input);
    const workspaceId = normalizeText(
      body.workspaceId,
      MAX_REQUEST_ID_LENGTH
    );
    const holder =
      body.holder === undefined
        ? principal.clientId
        : normalizeText(body.holder, MAX_HOLDER_LENGTH);
    const ttlSeconds =
      body.ttlSeconds === undefined
        ? DEFAULT_LEASE_TTL_SECONDS
        : normalizePositiveInteger(body.ttlSeconds);
    if (ttlSeconds > MAX_LEASE_TTL_SECONDS) {
      invalidInput();
    }

    try {
      return transact(this.db, () => {
        if (!this._workspace(principal.project, workspaceId)) {
          notFound();
        }
        const nowMs = this._now();
        const expiresAt = nowMs + ttlSeconds * 1000;
        if (!Number.isSafeInteger(expiresAt)) {
          fail('store_error', 'Work store operation failed.');
        }
        const row = this._lease(principal.project, workspaceId);
        if (!row) {
          this.db
            .prepare(
              `INSERT INTO workspace_leases
                (workspace_id, project, epoch_counter, holder, holder_client_id,
                 expires_at, updated_at)
               VALUES (?, ?, 1, ?, ?, ?, ?)`
            )
            .run(
              workspaceId,
              principal.project,
              holder,
              principal.clientId,
              expiresAt,
              nowMs
            );
        } else {
          if (
            row.holder !== null &&
            row.expires_at !== null &&
            row.expires_at > nowMs
          ) {
            fail('lease_held', 'Workspace lease is held.');
          }
          this.db
            .prepare(
              `UPDATE workspace_leases
                  SET epoch_counter = epoch_counter + 1,
                      holder = ?, holder_client_id = ?, expires_at = ?, updated_at = ?
                WHERE workspace_id = ? AND project = ?`
            )
            .run(
              holder,
              principal.clientId,
              expiresAt,
              nowMs,
              workspaceId,
              principal.project
            );
        }
        return leaseReceipt(
          this._lease(principal.project, workspaceId),
          nowMs
        );
      });
    } catch (error) {
      throw translateError(error);
    }
  }

  /**
   * Validate that a queued write still owns the workspace at `epoch`.
   * Raises `lease_missing`, `lease_stale` or `lease_expired`.
   */
  validateLease(principalInput, input) {
    this._ensureOpen();
    const principal = normalizePrincipal(principalInput);
    requireWriter(principal);
    const body = normalizeInputObject(input);
    const workspaceId = normalizeText(
      body.workspaceId,
      MAX_REQUEST_ID_LENGTH
    );
    const epoch = normalizePositiveInteger(body.epoch);

    try {
      if (!this._workspace(principal.project, workspaceId)) {
        notFound();
      }
      const row = this._lease(principal.project, workspaceId);
      if (!row || row.holder === null) {
        fail('lease_missing', 'Workspace lease is missing.');
      }
      if (row.holder !== null && row.holder_client_id !== principal.clientId) forbidden();
      if (row.epoch_counter !== epoch) {
        fail('lease_stale', 'Workspace lease epoch is stale.');
      }
      const nowMs = this._now();
      if (row.expires_at === null || row.expires_at <= nowMs) {
        fail('lease_expired', 'Workspace lease has expired.');
      }
      return {
        workspaceId: row.workspace_id,
        epoch: row.epoch_counter,
        holder: row.holder,
        expiresAt: row.expires_at,
        valid: true,
      };
    } catch (error) {
      throw translateError(error);
    }
  }

  /**
   * Extend an existing lease at the given epoch.
   */
  renewLease(principalInput, input) {
    this._ensureOpen();
    const principal = normalizePrincipal(principalInput);
    requireWriter(principal);
    const body = normalizeInputObject(input);
    const workspaceId = normalizeText(
      body.workspaceId,
      MAX_REQUEST_ID_LENGTH
    );
    const epoch = normalizePositiveInteger(body.epoch);
    const ttlSeconds =
      body.ttlSeconds === undefined
        ? DEFAULT_LEASE_TTL_SECONDS
        : normalizePositiveInteger(body.ttlSeconds);
    if (ttlSeconds > MAX_LEASE_TTL_SECONDS) {
      invalidInput();
    }

    try {
      return transact(this.db, () => {
        if (!this._workspace(principal.project, workspaceId)) notFound();
        const row = this._lease(principal.project, workspaceId);
        if (!row || row.holder === null) {
          fail('lease_missing', 'Workspace lease is missing.');
        }
        if (row.holder !== null && row.holder_client_id !== principal.clientId) forbidden();
        if (row.epoch_counter !== epoch) {
          fail('lease_stale', 'Workspace lease epoch is stale.');
        }
        const nowMs = this._now();
        if (row.expires_at === null || row.expires_at <= nowMs) {
          fail('lease_expired', 'Workspace lease has expired.');
        }
        const expiresAt = nowMs + ttlSeconds * 1000;
        this.db
          .prepare(
            `UPDATE workspace_leases
                SET expires_at = ?, updated_at = ?
              WHERE workspace_id = ? AND project = ?`
          )
          .run(expiresAt, nowMs, workspaceId, principal.project);
        return leaseReceipt(
          this._lease(principal.project, workspaceId),
          nowMs
        );
      });
    } catch (error) {
      throw translateError(error);
    }
  }

  /**
   * Release a lease at the given epoch. The epoch counter is retained so the
   * next acquisition always gets a strictly greater epoch.
   */
  releaseLease(principalInput, input) {
    this._ensureOpen();
    const principal = normalizePrincipal(principalInput);
    requireWriter(principal);
    const body = normalizeInputObject(input);
    const workspaceId = normalizeText(
      body.workspaceId,
      MAX_REQUEST_ID_LENGTH
    );
    const epoch = normalizePositiveInteger(body.epoch);

    try {
      return transact(this.db, () => {
        const row = this._lease(principal.project, workspaceId);
        if (!row) {
          fail('lease_missing', 'Workspace lease is missing.');
        }
        if (row.holder !== null && row.holder_client_id !== principal.clientId) forbidden();
        if (row.epoch_counter !== epoch) {
          fail('lease_stale', 'Workspace lease epoch is stale.');
        }
        if (row.holder !== null) {
          const nowMs = this._now();
          this.db
            .prepare(
              `UPDATE workspace_leases
                  SET holder = NULL, holder_client_id = NULL, expires_at = NULL, updated_at = ?
                WHERE workspace_id = ? AND project = ?`
            )
            .run(nowMs, workspaceId, principal.project);
        }
        return {
          workspaceId,
          epoch,
          released: true,
        };
      });
    } catch (error) {
      throw translateError(error);
    }
  }
}

module.exports = {
  openWorkStore,
  WorkStoreError,
  DEFAULT_LIMITS,
  DEFAULT_MAX_EVENTS,
  DEFAULT_LEASE_TTL_SECONDS,
};
