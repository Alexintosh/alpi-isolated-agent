'use strict';

/**
 * Additive durable journal for sandbox lifecycle intent.
 *
 * The work store owns reservations, workspace/job state, leases and quota. It
 * intentionally does not know about launch-scoped engine identity or
 * start/delete intent. This module is a separate SQLite database in the same
 * private state directory so it can never collide with another task's
 * migration of `work.sqlite`.
 *
 * It is storage-only. It never starts a VM, calls an engine or touches a
 * network. Callers persist intent here *before* an external side effect and
 * record the confirmed outcome afterwards.
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const JOURNAL_FILE = 'sandbox-journal.sqlite';
const BUSY_TIMEOUT_MS = 5000;

const MAX_STATE_DIR_LENGTH = 4096;
const MAX_PROJECT_LENGTH = 128;
const MAX_SANDBOX_ID_LENGTH = 128;
const MAX_CLIENT_ID_LENGTH = 128;
const MAX_REQUEST_ID_LENGTH = 128;
const MAX_ENGINE_LENGTH = 64;
const MAX_ENGINE_VERSION_LENGTH = 64;
const MAX_PROFILE_LENGTH = 128;
const MAX_IMAGE_DIGEST_LENGTH = 256;
const MAX_NATIVE_ID_LENGTH = 256;
const MAX_REASON_LENGTH = 256;
const MAX_HASH_LENGTH = 128;
const MAX_ERROR_CODE_LENGTH = 64;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NETWORK_MODES = new Set(['disabled', 'boundary']);
const RETENTIONS = new Set(['ephemeral', 'ttl', 'until-export']);
const CREATE_STATES = new Set(['pending', 'created', 'uncertain', 'failed']);
const OPERATIONS = new Set(['start', 'stop']);
const OPERATION_STATES = new Set(['idle', 'pending', 'done', 'uncertain', 'failed']);
const DELETE_STATES = new Set(['none', 'pending', 'uncertain', 'removed', 'deleted']);

class SandboxJournalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SandboxJournalError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new SandboxJournalError(code, message);
}

function invalidInput() {
  fail('invalid_input', 'Invalid journal input.');
}

function notFound() {
  fail('not_found', 'Journal entry not found.');
}

function translateError(error) {
  if (error instanceof SandboxJournalError) {
    return error;
  }
  if (
    error &&
    (error.errcode === 5 /* SQLITE_BUSY */ ||
      error.errcode === 6 /* SQLITE_LOCKED */)
  ) {
    return new SandboxJournalError('journal_busy', 'Sandbox journal is busy.');
  }
  return new SandboxJournalError('journal_error', 'Sandbox journal operation failed.');
}

function transact(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // SQLite may already have rolled the transaction back.
    }
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

function normalizeOptionalText(value, maxLength) {
  if (value === undefined || value === null) {
    return null;
  }
  return normalizeText(value, maxLength);
}

function normalizeUuid(value, label) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    invalidInput();
  }
  return value.toLowerCase();
}

function normalizePositiveInteger(value, label) {
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

function normalizeEnum(value, allowed, label) {
  if (typeof value !== 'string' || !allowed.has(value)) {
    invalidInput();
  }
  return value;
}

function normalizeResources(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalidInput();
  }
  return {
    vcpus: normalizePositiveInteger(value.vcpus, 'vcpus'),
    memoryMiB: normalizePositiveInteger(value.memoryMiB, 'memoryMiB'),
    diskMiB: normalizePositiveInteger(value.diskMiB, 'diskMiB'),
  };
}

function createClock(now) {
  if (now === undefined) {
    return () => Date.now();
  }
  if (typeof now !== 'function') {
    invalidInput();
  }
  return () => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) {
      invalidInput();
    }
    return value;
  };
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
      CREATE TABLE IF NOT EXISTS journal_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS sandbox_journal (
        project TEXT NOT NULL,
        sandbox_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        create_hash TEXT NOT NULL,
        allocation_id TEXT NOT NULL,
        launch_generation INTEGER NOT NULL,
        engine TEXT NOT NULL,
        engine_version TEXT NOT NULL,
        profile TEXT NOT NULL,
        image_digest TEXT NOT NULL,
        network_mode TEXT NOT NULL,
        resources_json TEXT NOT NULL,
        retention TEXT NOT NULL,
        expires_at INTEGER,
        create_state TEXT NOT NULL,
        native_id TEXT,
        operation TEXT,
        operation_state TEXT NOT NULL,
        operation_hash TEXT,
        operation_generation INTEGER NOT NULL,
        delete_state TEXT NOT NULL,
        delete_reason TEXT,
        discard INTEGER NOT NULL,
        delete_hash TEXT,
        native_absent_at INTEGER,
        last_error_code TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (project, sandbox_id),
        UNIQUE (project, allocation_id)
      );
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS sandbox_journal_by_project
        ON sandbox_journal (project, created_at, sandbox_id);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS sandbox_journal_by_expiry
        ON sandbox_journal (expires_at, project, sandbox_id);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS sandbox_journal_by_create_state
        ON sandbox_journal (create_state, project, sandbox_id);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS sandbox_journal_by_delete_state
        ON sandbox_journal (delete_state, project, sandbox_id);
    `);
    db.exec('PRAGMA user_version = 1');
  });
}

function parseResources(value) {
  try {
    const parsed = JSON.parse(value);
    return normalizeResources(parsed);
  } catch {
    fail('journal_error', 'Sandbox journal operation failed.');
  }
}

function receipt(row) {
  const recoveryRequired =
    row.create_state === 'pending' ||
    row.create_state === 'uncertain' ||
    row.operation_state === 'pending' ||
    row.operation_state === 'uncertain' ||
    row.delete_state === 'pending' ||
    row.delete_state === 'uncertain' ||
    row.delete_state === 'removed';
  return Object.freeze({
    project: row.project,
    sandboxId: row.sandbox_id,
    clientId: row.client_id,
    requestId: row.request_id,
    createHash: row.create_hash,
    allocationId: row.allocation_id,
    launchGeneration: row.launch_generation,
    engine: row.engine,
    engineVersion: row.engine_version,
    profile: row.profile,
    imageDigest: row.image_digest,
    networkMode: row.network_mode,
    resources: parseResources(row.resources_json),
    retention: row.retention,
    expiresAt: row.expires_at,
    createState: row.create_state,
    nativeId: row.native_id,
    operation: row.operation,
    operationState: row.operation_state,
    operationHash: row.operation_hash,
    operationGeneration: row.operation_generation,
    deleteState: row.delete_state,
    deleteReason: row.delete_reason,
    discard: row.discard === 1,
    deleteHash: row.delete_hash,
    nativeAbsentAt: row.native_absent_at,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    recoveryRequired,
  });
}

function openSandboxJournal(stateDir, options = {}) {
  try {
    return openSandboxJournalInternal(stateDir, options);
  } catch (error) {
    if (error instanceof SandboxJournalError) {
      throw error;
    }
    throw new SandboxJournalError('journal_unavailable', 'Sandbox journal is unavailable.');
  }
}

function openSandboxJournalInternal(stateDir, options = {}) {
  if (
    typeof stateDir !== 'string' ||
    stateDir.length === 0 ||
    stateDir.length > MAX_STATE_DIR_LENGTH ||
    stateDir.includes('\u0000')
  ) {
    fail('unsafe_state_directory', 'Unsafe state directory.');
  }
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    invalidInput();
  }

  const clock = createClock(options.now);
  const resolvedDir = path.resolve(stateDir);
  const parentDir = path.dirname(resolvedDir);

  assertTrustedParent(lstatOrNull(parentDir));

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

  const dbPath = path.join(resolvedDir, JOURNAL_FILE);
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
    fail('journal_unavailable', 'Sandbox journal is unavailable.');
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

  return new SandboxJournal(db, clock);
}

class SandboxJournal {
  constructor(db, clock) {
    this.db = db;
    this._clock = clock;
    this._closed = false;
  }

  close() {
    if (this._closed) {
      return;
    }
    this._closed = true;
    this.db.close();
  }

  _ensureOpen() {
    if (this._closed) {
      fail('journal_closed', 'Sandbox journal is closed.');
    }
  }

  _now() {
    const value = this._clock();
    if (!Number.isSafeInteger(value) || value < 0) {
      invalidInput();
    }
    return value;
  }

  _row(project, sandboxId) {
    return this.db
      .prepare(
        `SELECT * FROM sandbox_journal
          WHERE project = ? AND sandbox_id = ?`
      )
      .get(project, sandboxId);
  }

  /**
   * Persist a create intent before any engine side effect.
   *
   * Replaying the same sandbox/request/create hash returns the existing
   * receipt. A different create hash for the same request raises
   * `idempotency_conflict`.
   */
  beginCreate(input) {
    this._ensureOpen();
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      invalidInput();
    }
    const project = normalizeText(input.project, MAX_PROJECT_LENGTH);
    const sandboxId = normalizeUuid(input.sandboxId, 'sandboxId');
    const clientId = normalizeText(input.clientId, MAX_CLIENT_ID_LENGTH);
    const requestId = normalizeText(input.requestId, MAX_REQUEST_ID_LENGTH);
    const createHash = normalizeText(input.createHash, MAX_HASH_LENGTH);
    const allocationId = normalizeUuid(input.allocationId, 'allocationId');
    const launchGeneration = normalizePositiveInteger(
      input.launchGeneration,
      'launchGeneration'
    );
    const engine = normalizeText(input.engine, MAX_ENGINE_LENGTH);
    const engineVersion = normalizeText(
      input.engineVersion,
      MAX_ENGINE_VERSION_LENGTH
    );
    const profile = normalizeText(input.profile, MAX_PROFILE_LENGTH);
    const imageDigest = normalizeText(
      input.imageDigest,
      MAX_IMAGE_DIGEST_LENGTH
    );
    const networkMode = normalizeEnum(
      input.networkMode,
      NETWORK_MODES,
      'networkMode'
    );
    const resources = normalizeResources(input.resources);
    const retention = normalizeEnum(
      input.retention,
      RETENTIONS,
      'retention'
    );
    const expiresAt = normalizeOptionalPositiveInteger(input.expiresAt);
    const resourcesJson = JSON.stringify(resources);

    try {
      return transact(this.db, () => {
        const existing = this._row(project, sandboxId);
        if (existing) {
          if (
            existing.request_id !== requestId ||
            existing.create_hash !== createHash
          ) {
            fail(
              'idempotency_conflict',
              'Request key was already used with a different payload.'
            );
          }
          return receipt(existing);
        }
        const allocation = this.db
          .prepare(
            `SELECT sandbox_id FROM sandbox_journal
              WHERE project = ? AND allocation_id = ?`
          )
          .get(project, allocationId);
        if (allocation && allocation.sandbox_id !== sandboxId) {
          fail(
            'idempotency_conflict',
            'Allocation is already owned by another sandbox.'
          );
        }
        const nowMs = this._now();
        this.db
          .prepare(
            `INSERT INTO sandbox_journal
              (project, sandbox_id, client_id, request_id, create_hash,
               allocation_id, launch_generation, engine, engine_version,
               profile, image_digest, network_mode, resources_json,
               retention, expires_at, create_state, native_id, operation,
               operation_state, operation_hash, operation_generation,
               delete_state, delete_reason, discard, delete_hash,
               native_absent_at, last_error_code, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending',
                     NULL, NULL, 'idle', NULL, 0, 'none', NULL, 0, NULL,
                     NULL, NULL, ?, ?)`
          )
          .run(
            project,
            sandboxId,
            clientId,
            requestId,
            createHash,
            allocationId,
            launchGeneration,
            engine,
            engineVersion,
            profile,
            imageDigest,
            networkMode,
            resourcesJson,
            retention,
            expiresAt,
            nowMs,
            nowMs
          );
        return receipt(this._row(project, sandboxId));
      });
    } catch (error) {
      throw translateError(error);
    }
  }

  /**
   * Record the confirmed create outcome. `created` requires a native id.
   */
  markCreateResult(input) {
    this._ensureOpen();
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      invalidInput();
    }
    const project = normalizeText(input.project, MAX_PROJECT_LENGTH);
    const sandboxId = normalizeUuid(input.sandboxId, 'sandboxId');
    const state = normalizeEnum(input.state, CREATE_STATES, 'state');
    if (state === 'pending') {
      invalidInput();
    }
    const nativeId =
      input.nativeId === undefined || input.nativeId === null
        ? null
        : normalizeText(input.nativeId, MAX_NATIVE_ID_LENGTH);
    if (state === 'created' && nativeId === null) {
      invalidInput();
    }
    const errorCode = normalizeOptionalText(
      input.errorCode,
      MAX_ERROR_CODE_LENGTH
    );

    try {
      return transact(this.db, () => {
        const existing = this._row(project, sandboxId);
        if (!existing) {
          notFound();
        }
        const nowMs = this._now();
        this.db
          .prepare(
            `UPDATE sandbox_journal
                SET create_state = ?, native_id = coalesce(?, native_id),
                    last_error_code = ?, updated_at = ?
              WHERE project = ? AND sandbox_id = ?`
          )
          .run(state, nativeId, errorCode, nowMs, project, sandboxId);
        return receipt(this._row(project, sandboxId));
      });
    } catch (error) {
      throw translateError(error);
    }
  }

  /**
   * Persist a start/stop intent before the external mutation.
   */
  beginOperation(input) {
    this._ensureOpen();
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      invalidInput();
    }
    const project = normalizeText(input.project, MAX_PROJECT_LENGTH);
    const sandboxId = normalizeUuid(input.sandboxId, 'sandboxId');
    const operation = normalizeEnum(input.operation, OPERATIONS, 'operation');
    const hash = normalizeText(input.hash, MAX_HASH_LENGTH);

    try {
      return transact(this.db, () => {
        const existing = this._row(project, sandboxId);
        if (!existing) {
          notFound();
        }
        if (
          existing.operation === operation &&
          existing.operation_state === 'done' &&
          existing.operation_hash === hash
        ) {
          return receipt(existing);
        }
        const nowMs = this._now();
        this.db
          .prepare(
            `UPDATE sandbox_journal
                SET operation = ?, operation_state = 'pending',
                    operation_hash = ?,
                    operation_generation = operation_generation + 1,
                    last_error_code = NULL, updated_at = ?
              WHERE project = ? AND sandbox_id = ?`
          )
          .run(operation, hash, nowMs, project, sandboxId);
        return receipt(this._row(project, sandboxId));
      });
    } catch (error) {
      throw translateError(error);
    }
  }

  markOperationResult(input) {
    this._ensureOpen();
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      invalidInput();
    }
    const project = normalizeText(input.project, MAX_PROJECT_LENGTH);
    const sandboxId = normalizeUuid(input.sandboxId, 'sandboxId');
    const operation = normalizeEnum(input.operation, OPERATIONS, 'operation');
    const state = normalizeEnum(
      input.state,
      new Set(['done', 'uncertain', 'failed']),
      'state'
    );
    const errorCode = normalizeOptionalText(
      input.errorCode,
      MAX_ERROR_CODE_LENGTH
    );

    try {
      return transact(this.db, () => {
        const existing = this._row(project, sandboxId);
        if (!existing) {
          notFound();
        }
        if (existing.operation !== operation) {
          fail('invalid_transition', 'Journal operation changed.');
        }
        const nowMs = this._now();
        this.db
          .prepare(
            `UPDATE sandbox_journal
                SET operation_state = ?, last_error_code = ?, updated_at = ?
              WHERE project = ? AND sandbox_id = ?`
          )
          .run(state, errorCode, nowMs, project, sandboxId);
        return receipt(this._row(project, sandboxId));
      });
    } catch (error) {
      throw translateError(error);
    }
  }

  /**
   * Persist a delete intent before engine removal. A previously confirmed
   * removal is retained so a retry does not need to re-guess the native id.
   */
  beginDelete(input) {
    this._ensureOpen();
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      invalidInput();
    }
    const project = normalizeText(input.project, MAX_PROJECT_LENGTH);
    const sandboxId = normalizeUuid(input.sandboxId, 'sandboxId');
    const reason = normalizeOptionalText(input.reason, MAX_REASON_LENGTH);
    const discard = input.discard === true;
    const hash = normalizeText(input.hash, MAX_HASH_LENGTH);

    try {
      return transact(this.db, () => {
        const existing = this._row(project, sandboxId);
        if (!existing) {
          notFound();
        }
        if (existing.delete_state === 'deleted') {
          return receipt(existing);
        }
        const nowMs = this._now();
        const nextState =
          existing.delete_state === 'removed' ? 'removed' : 'pending';
        this.db
          .prepare(
            `UPDATE sandbox_journal
                SET delete_state = ?, delete_reason = ?, discard = ?,
                    delete_hash = ?, last_error_code = NULL, updated_at = ?
              WHERE project = ? AND sandbox_id = ?`
          )
          .run(
            nextState,
            reason,
            discard ? 1 : 0,
            hash,
            nowMs,
            project,
            sandboxId
          );
        return receipt(this._row(project, sandboxId));
      });
    } catch (error) {
      throw translateError(error);
    }
  }

  markDeleteResult(input) {
    this._ensureOpen();
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      invalidInput();
    }
    const project = normalizeText(input.project, MAX_PROJECT_LENGTH);
    const sandboxId = normalizeUuid(input.sandboxId, 'sandboxId');
    const state = normalizeEnum(
      input.state,
      new Set(['removed', 'uncertain']),
      'state'
    );
    const nativeAbsent = input.nativeAbsent === true;
    const nativeId =
      input.nativeId === undefined || input.nativeId === null
        ? null
        : normalizeText(input.nativeId, MAX_NATIVE_ID_LENGTH);
    const errorCode = normalizeOptionalText(
      input.errorCode,
      MAX_ERROR_CODE_LENGTH
    );

    try {
      return transact(this.db, () => {
        const existing = this._row(project, sandboxId);
        if (!existing) {
          notFound();
        }
        const nowMs = this._now();
        this.db
          .prepare(
            `UPDATE sandbox_journal
                SET delete_state = ?, native_id = coalesce(?, native_id),
                    native_absent_at = CASE WHEN ? THEN ? ELSE native_absent_at END,
                    last_error_code = ?, updated_at = ?
              WHERE project = ? AND sandbox_id = ?`
          )
          .run(
            state,
            nativeId,
            nativeAbsent ? 1 : 0,
            nowMs,
            errorCode,
            nowMs,
            project,
            sandboxId
          );
        return receipt(this._row(project, sandboxId));
      });
    } catch (error) {
      throw translateError(error);
    }
  }

  markDeleted(input) {
    this._ensureOpen();
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      invalidInput();
    }
    const project = normalizeText(input.project, MAX_PROJECT_LENGTH);
    const sandboxId = normalizeUuid(input.sandboxId, 'sandboxId');
    try {
      return transact(this.db, () => {
        const existing = this._row(project, sandboxId);
        if (!existing) {
          notFound();
        }
        const nowMs = this._now();
        this.db
          .prepare(
            `UPDATE sandbox_journal
                SET delete_state = 'deleted', updated_at = ?
              WHERE project = ? AND sandbox_id = ?`
          )
          .run(nowMs, project, sandboxId);
        return receipt(this._row(project, sandboxId));
      });
    } catch (error) {
      throw translateError(error);
    }
  }

  get(project, sandboxId) {
    this._ensureOpen();
    const normalizedProject = normalizeText(project, MAX_PROJECT_LENGTH);
    const normalizedId = normalizeUuid(sandboxId, 'sandboxId');
    try {
      const row = this._row(normalizedProject, normalizedId);
      return row ? receipt(row) : null;
    } catch (error) {
      throw translateError(error);
    }
  }

  getByRequest(project, clientId, requestId) {
    this._ensureOpen();
    const normalizedProject = normalizeText(project, MAX_PROJECT_LENGTH);
    const normalizedClient = normalizeText(clientId, MAX_CLIENT_ID_LENGTH);
    const normalizedRequest = normalizeText(
      requestId,
      MAX_REQUEST_ID_LENGTH
    );
    try {
      const row = this.db
        .prepare(
          `SELECT * FROM sandbox_journal
            WHERE project = ? AND client_id = ? AND request_id = ?`
        )
        .get(normalizedProject, normalizedClient, normalizedRequest);
      return row ? receipt(row) : null;
    } catch (error) {
      throw translateError(error);
    }
  }

  listByProject(project) {
    this._ensureOpen();
    const normalizedProject = normalizeText(project, MAX_PROJECT_LENGTH);
    try {
      return this.db
        .prepare(
          `SELECT * FROM sandbox_journal
            WHERE project = ?
            ORDER BY created_at ASC, sandbox_id ASC`
        )
        .all(normalizedProject)
        .map(receipt);
    } catch (error) {
      throw translateError(error);
    }
  }

  listAll() {
    this._ensureOpen();
    try {
      return this.db
        .prepare(
          `SELECT * FROM sandbox_journal
            ORDER BY created_at ASC, project ASC, sandbox_id ASC`
        )
        .all()
        .map(receipt);
    } catch (error) {
      throw translateError(error);
    }
  }

  listPending() {
    this._ensureOpen();
    try {
      return this.db
        .prepare(
          `SELECT * FROM sandbox_journal
            WHERE create_state IN ('pending', 'uncertain')
               OR operation_state IN ('pending', 'uncertain')
               OR delete_state IN ('pending', 'uncertain', 'removed')
            ORDER BY created_at ASC, project ASC, sandbox_id ASC`
        )
        .all()
        .map(receipt);
    } catch (error) {
      throw translateError(error);
    }
  }

  listTtlCandidates(nowMs) {
    this._ensureOpen();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      invalidInput();
    }
    const normalizedNow = nowMs;
    try {
      return this.db
        .prepare(
          `SELECT * FROM sandbox_journal
            WHERE expires_at IS NOT NULL AND expires_at <= ?
              AND delete_state <> 'deleted'
              AND create_state IN ('created', 'pending', 'uncertain')
            ORDER BY expires_at ASC, project ASC, sandbox_id ASC`
        )
        .all(normalizedNow)
        .map(receipt);
    } catch (error) {
      throw translateError(error);
    }
  }
}

module.exports = {
  JOURNAL_FILE,
  SandboxJournalError,
  openSandboxJournal,
};
