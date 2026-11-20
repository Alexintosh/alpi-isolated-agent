'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_INVITE_TTL_MS = 5 * 60 * 1000;
const MAX_INVITE_TTL_MS = 5 * 60 * 1000;
const BEARER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const ROLES = new Set(['observer', 'runner', 'operator']);
const MAX_PROJECT_LENGTH = 128;
const MAX_NAME_LENGTH = 64;
const MAX_STATE_DIR_LENGTH = 4096;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const BUSY_TIMEOUT_MS = 5000;

class PairingStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PairingStoreError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new PairingStoreError(code, message);
}

function invalidInput() {
  fail('invalid_input', 'Invalid input.');
}

function digestOf(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function assertToken(value, code) {
  if (typeof value !== 'string' || !TOKEN_PATTERN.test(value)) {
    fail(
      code,
      code === 'invalid_invitation' ? 'Invalid invitation.' : 'Invalid credential.'
    );
  }
  return value;
}

function normalizeText(value, maxLength) {
  if (typeof value !== 'string') {
    invalidInput();
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) {
    invalidInput();
  }
  // Reject control characters so names stay printable and log-safe.
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(trimmed)) {
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

function normalizeTtl(ttlMs) {
  if (ttlMs === undefined) {
    return DEFAULT_INVITE_TTL_MS;
  }
  if (
    !Number.isInteger(ttlMs) ||
    ttlMs <= 0 ||
    ttlMs > MAX_INVITE_TTL_MS
  ) {
    invalidInput();
  }
  return ttlMs;
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

function futureTime(nowMs, deltaMs) {
  const value = nowMs + deltaMs;
  if (!Number.isSafeInteger(value)) {
    fail('store_error', 'Pairing store operation failed.');
  }
  return value;
}

function translateError(error) {
  if (error instanceof PairingStoreError) {
    return error;
  }
  if (
    error &&
    (error.errcode === 5 /* SQLITE_BUSY */ ||
      error.errcode === 6 /* SQLITE_LOCKED */)
  ) {
    return new PairingStoreError('store_busy', 'Pairing store is busy.');
  }
  return new PairingStoreError(
    'store_error',
    'Pairing store operation failed.'
  );
}

function runImmediate(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The transaction may already have been rolled back by SQLite.
    }
    throw error;
  }
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
  runImmediate(db, () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS invites (
        digest TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        role TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER,
        consumed_by TEXT
      );
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS clients (
        client_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        project TEXT NOT NULL,
        role TEXT NOT NULL,
        credential_digest TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
    `);
    db.prepare(
      'INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)'
    ).run('server_id', crypto.randomUUID());
  });
}

function readServerId(db) {
  const row = db
    .prepare('SELECT value FROM meta WHERE key = ?')
    .get('server_id');
  if (
    !row ||
    typeof row.value !== 'string' ||
    !UUID_PATTERN.test(row.value)
  ) {
    fail('store_error', 'Pairing store operation failed.');
  }
  return row.value;
}

class PairingStore {
  constructor(db, serverId, clock) {
    this.db = db;
    Object.defineProperty(this, 'serverId', {
      value: serverId,
      enumerable: true,
      writable: false,
      configurable: false,
    });
    this._clock = clock;
    this._closed = false;
  }

  _ensureOpen() {
    if (this._closed) {
      fail('store_closed', 'Pairing store is closed.');
    }
  }

  _now() {
    const value = this._clock();
    if (!Number.isSafeInteger(value) || value < 0) {
      invalidInput();
    }
    return value;
  }

  issueInvite(input = {}) {
    this._ensureOpen();
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      invalidInput();
    }

    const project = normalizeText(input.project, MAX_PROJECT_LENGTH);
    const role = normalizeRole(input.role);
    const ttlMs = normalizeTtl(input.ttlMs);
    const nowMs = this._now();
    const expiresAt = futureTime(nowMs, ttlMs);
    const invitation = randomToken();
    const digest = digestOf(invitation);

    try {
      this.db
        .prepare(
          `INSERT INTO invites
            (digest, project, role, expires_at, consumed_at, consumed_by)
           VALUES (?, ?, ?, ?, NULL, NULL)`
        )
        .run(digest, project, role, expiresAt);
    } catch (error) {
      throw translateError(error);
    }

    return { invitation, expiresAt };
  }

  exchange(input = {}) {
    this._ensureOpen();
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      invalidInput();
    }

    const invitation = assertToken(
      input.invitation,
      'invalid_invitation'
    );
    const name = normalizeText(input.name, MAX_NAME_LENGTH);
    const digest = digestOf(invitation);

    try {
      return runImmediate(this.db, () => {
        const nowMs = this._now();
        const row = this.db
          .prepare(
            `SELECT project, role, expires_at, consumed_at
               FROM invites
              WHERE digest = ?`
          )
          .get(digest);

        if (
          !row ||
          row.consumed_at !== null ||
          row.expires_at <= nowMs
        ) {
          fail('invalid_invitation', 'Invalid invitation.');
        }

        const credential = randomToken();
        const clientId = crypto.randomUUID();
        const expiresAt = futureTime(nowMs, BEARER_TTL_MS);

        const consumed = this.db
          .prepare(
            `UPDATE invites
                SET consumed_at = ?, consumed_by = ?
              WHERE digest = ?
                AND consumed_at IS NULL
                AND expires_at > ?`
          )
          .run(nowMs, clientId, digest, nowMs);

        if (consumed.changes !== 1) {
          fail('invalid_invitation', 'Invalid invitation.');
        }

        this.db
          .prepare(
            `INSERT INTO clients
              (client_id, name, project, role, credential_digest,
               created_at, expires_at, revoked_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`
          )
          .run(
            clientId,
            name,
            row.project,
            row.role,
            digestOf(credential),
            nowMs,
            expiresAt
          );

        return {
          credential,
          clientId,
          project: row.project,
          role: row.role,
          expiresAt,
        };
      });
    } catch (error) {
      throw translateError(error);
    }
  }

  authenticate(credential) {
    this._ensureOpen();
    assertToken(credential, 'invalid_credential');
    const nowMs = this._now();
    const digest = digestOf(credential);

    try {
      const row = this.db
        .prepare(
          `SELECT client_id, name, project, role, expires_at, revoked_at
             FROM clients
            WHERE credential_digest = ?`
        )
        .get(digest);

      if (!row || row.revoked_at !== null || row.expires_at <= nowMs) {
        fail('invalid_credential', 'Invalid credential.');
      }

      return {
        clientId: row.client_id,
        name: row.name,
        project: row.project,
        role: row.role,
        expiresAt: row.expires_at,
      };
    } catch (error) {
      throw translateError(error);
    }
  }

  listClients() {
    this._ensureOpen();
    const nowMs = this._now();

    try {
      const rows = this.db
        .prepare(
          `SELECT client_id, name, project, role, created_at,
                  expires_at, revoked_at
             FROM clients
            ORDER BY created_at ASC, client_id ASC`
        )
        .all();

      return rows.map((row) => ({
        clientId: row.client_id,
        name: row.name,
        project: row.project,
        role: row.role,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        revoked: row.revoked_at !== null,
        revokedAt: row.revoked_at,
        expired: row.expires_at <= nowMs,
      }));
    } catch (error) {
      throw translateError(error);
    }
  }

  revoke(clientId) {
    this._ensureOpen();
    if (typeof clientId !== 'string' || !UUID_PATTERN.test(clientId)) {
      invalidInput();
    }
    const normalizedClientId = clientId.toLowerCase();
    const nowMs = this._now();

    try {
      return runImmediate(this.db, () => {
        const row = this.db
          .prepare('SELECT revoked_at FROM clients WHERE client_id = ?')
          .get(normalizedClientId);

        if (!row) {
          fail('unknown_client', 'Unknown client.');
        }

        if (row.revoked_at !== null) {
          return { clientId: normalizedClientId, revokedAt: row.revoked_at };
        }

        const updated = this.db
          .prepare(
            `UPDATE clients
                SET revoked_at = ?
              WHERE client_id = ?
                AND revoked_at IS NULL`
          )
          .run(nowMs, normalizedClientId);

        if (updated.changes !== 1) {
          const current = this.db
            .prepare('SELECT revoked_at FROM clients WHERE client_id = ?')
            .get(normalizedClientId);
          if (!current || current.revoked_at === null) {
            fail('store_error', 'Pairing store operation failed.');
          }
          return {
            clientId: normalizedClientId,
            revokedAt: current.revoked_at,
          };
        }

        return { clientId: normalizedClientId, revokedAt: nowMs };
      });
    } catch (error) {
      throw translateError(error);
    }
  }

  close() {
    if (this._closed) {
      return;
    }
    this._closed = true;
    this.db.close();
  }
}

function openPairingStore(stateDir, options = {}) {
  try {
    return openPairingStoreInternal(stateDir, options);
  } catch (error) {
    if (error instanceof PairingStoreError) {
      throw error;
    }
    throw new PairingStoreError(
      'store_unavailable',
      'Pairing store is unavailable.'
    );
  }
}

function openPairingStoreInternal(stateDir, options = {}) {
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
      // We created this directory, so normalizing its mode is safe.
      try {
        fs.chmodSync(resolvedDir, 0o700);
      } catch {
        fail('unsafe_state_directory', 'Unsafe state directory.');
      }
      dirStat = lstatOrNull(resolvedDir);
    }
  }
  assertPrivateDirectory(dirStat);

  const dbPath = path.join(resolvedDir, 'pairing.sqlite');
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
      // We created this file, so normalizing its mode is safe.
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
    fail('store_unavailable', 'Pairing store is unavailable.');
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

  let serverId;
  try {
    serverId = readServerId(db);
  } catch (error) {
    try {
      db.close();
    } catch {
      // Ignore close failures while reporting the original error.
    }
    throw error;
  }
  return new PairingStore(db, serverId, clock);
}

module.exports = {
  openPairingStore,
  PairingStoreError,
};
