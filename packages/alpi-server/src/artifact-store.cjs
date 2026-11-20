'use strict';

// Durable, project-isolated artifact store for bounded streaming uploads.
//
// An artifact is an opaque byte stream (for tree transfers, the serialized
// file-stream.py record stream) identified by a server-assigned UUID. The
// store never accepts filesystem paths or URLs from the network. Every query
// is scoped by the authenticated project supplied by the caller.
//
// Storage model:
//   artifacts  one row per stream, with declared length, digest and state
//   chunks     one row per <=32 KiB slice, keyed by artifact and exact offset
//   requests   begin idempotency receipts keyed by project + request UUID
//
// Chunks are stored in SQLite BLOBs so publication, acknowledgement and
// reclamation are transactional with metadata. Quota reservations are derived
// from artifact rows (declared totalLength) inside BEGIN IMMEDIATE, so parallel
// begins cannot over-admit a project or the host.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const MAX_CHUNK_BYTES = 32 * 1024;
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;
const MAX_PROJECT_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_GLOBAL_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_UPLOADS_PER_PROJECT = 16;
const MAX_ARTIFACTS_PER_PROJECT = 512;
const MAX_ARTIFACTS_GLOBAL = 8192;
const MAX_CHUNKS_PER_ARTIFACT = 262144;
const MAX_CHUNK_ROWS_GLOBAL = 2000000;
const MAX_PROJECT_LENGTH = 128;
const MAX_STATE_DIR_LENGTH = 4096;
const DEFAULT_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ACKNOWLEDGED_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_FAILED_RETENTION_MS = 60 * 60 * 1000;
const BUSY_TIMEOUT_MS = 5000;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

const ARTIFACT_COLUMNS = `artifact_id, project, total_length, sha256, state,
  received_bytes, chunk_count, created_at, expires_at, published_at,
  acknowledged_at, failed_at, request_id`;

class ArtifactStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ArtifactStoreError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ArtifactStoreError(code, message);
}

function invalidInput() {
  fail('invalid_input', 'Invalid input.');
}

function normalizeProject(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_PROJECT_LENGTH ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)
  ) {
    invalidInput();
  }
  return value;
}

function normalizeUuid(value, code = 'invalid_input') {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    fail(code, 'Invalid identifier.');
  }
  return value.toLowerCase();
}

function normalizeDigest(value) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    fail('invalid_digest', 'Invalid SHA-256 digest.');
  }
  return value;
}

function normalizeSize(value, maximum, code) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > maximum
  ) {
    fail(code, 'Invalid size.');
  }
  return value;
}

function normalizeOffset(value, totalLength) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > totalLength
  ) {
    fail('invalid_offset', 'Invalid chunk offset.');
  }
  return value;
}

function decodeChunk(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > Math.ceil(MAX_CHUNK_BYTES / 3) * 4 ||
    value.length % 4 !== 0 ||
    !BASE64_PATTERN.test(value)
  ) {
    fail('invalid_chunk', 'Invalid chunk encoding.');
  }
  const buffer = Buffer.from(value, 'base64');
  if (
    buffer.length === 0 ||
    buffer.length > MAX_CHUNK_BYTES ||
    buffer.toString('base64') !== value
  ) {
    fail('invalid_chunk', 'Invalid chunk encoding.');
  }
  return buffer;
}

function digestOf(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function translateError(error) {
  if (error instanceof ArtifactStoreError) {
    return error;
  }
  if (
    error &&
    (error.errcode === 5 /* SQLITE_BUSY */ ||
      error.errcode === 6 /* SQLITE_LOCKED */)
  ) {
    return new ArtifactStoreError('store_busy', 'Artifact store is busy.');
  }
  return new ArtifactStoreError(
    'store_error',
    'Artifact store operation failed.'
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
      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        total_length INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        state TEXT NOT NULL,
        received_bytes INTEGER NOT NULL DEFAULT 0,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        published_at INTEGER,
        acknowledged_at INTEGER,
        failed_at INTEGER,
        request_id TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL
      );
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        artifact_id TEXT NOT NULL,
        offset INTEGER NOT NULL,
        length INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        data BLOB NOT NULL,
        PRIMARY KEY (artifact_id, offset),
        FOREIGN KEY (artifact_id) REFERENCES artifacts (artifact_id)
          ON DELETE CASCADE
      );
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS requests (
        project TEXT NOT NULL,
        request_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (project, request_id)
      );
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS artifacts_project_state
        ON artifacts (project, state);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS artifacts_state_expiry
        ON artifacts (state, expires_at);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS artifacts_published
        ON artifacts (state, published_at);
    `);
  });
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
    fail('store_error', 'Artifact store operation failed.');
  }
  return value;
}

function retentionOf(row) {
  if (row.state === 'uploading') {
    return 'uploading';
  }
  if (row.state === 'failed') {
    return 'failed';
  }
  if (row.acknowledged_at !== null) {
    return 'acknowledged';
  }
  return 'retained-until-acknowledged';
}

function receiptOf(row) {
  return {
    artifactId: row.artifact_id,
    project: row.project,
    totalLength: row.total_length,
    sha256: row.sha256,
    state: row.state,
    receivedBytes: row.received_bytes,
    chunkCount: row.chunk_count,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    publishedAt: row.published_at,
    acknowledgedAt: row.acknowledged_at,
    failedAt: row.failed_at,
    retention: retentionOf(row),
    requestId: row.request_id,
  };
}

function chunkLimitFor(totalLength, configuredMaximum) {
  return Math.min(
    configuredMaximum,
    Math.ceil(totalLength / 4096) + 8
  );
}

class ArtifactStore {
  constructor(db, clock, limits) {
    this.db = db;
    this._clock = clock;
    this._limits = limits;
    this._closed = false;
  }

  _ensureOpen() {
    if (this._closed) {
      fail('store_closed', 'Artifact store is closed.');
    }
  }

  _now() {
    const value = this._clock();
    if (!Number.isSafeInteger(value) || value < 0) {
      invalidInput();
    }
    return value;
  }

  _row(project, artifactId) {
    return this.db
      .prepare(
        `SELECT ${ARTIFACT_COLUMNS} FROM artifacts
          WHERE artifact_id = ? AND project = ?`
      )
      .get(artifactId, project);
  }

  _requireRow(project, artifactId) {
    const row = this._row(project, artifactId);
    if (!row) {
      fail('not_found', 'Artifact not found.');
    }
    return row;
  }

  _usage(project) {
    const projectBytes = this.db
      .prepare(
        `SELECT COALESCE(SUM(total_length), 0) AS value FROM artifacts
          WHERE project = ? AND state IN ('uploading', 'published')`
      )
      .get(project).value;
    const globalBytes = this.db
      .prepare(
        `SELECT COALESCE(SUM(total_length), 0) AS value FROM artifacts
          WHERE state IN ('uploading', 'published')`
      )
      .get().value;
    const projectUploads = this.db
      .prepare(
        `SELECT COUNT(*) AS value FROM artifacts
          WHERE project = ? AND state = 'uploading'`
      )
      .get(project).value;
    const projectArtifacts = this.db
      .prepare(
        'SELECT COUNT(*) AS value FROM artifacts WHERE project = ?'
      )
      .get(project).value;
    const globalArtifacts = this.db
      .prepare('SELECT COUNT(*) AS value FROM artifacts').get().value;
    const chunkRows = this.db
      .prepare('SELECT COUNT(*) AS value FROM chunks').get().value;
    return {
      projectBytes,
      globalBytes,
      projectUploads,
      projectArtifacts,
      globalArtifacts,
      chunkRows,
    };
  }

  usage(project) {
    this._ensureOpen();
    normalizeProject(project);
    try {
      return this._usage(project);
    } catch (error) {
      throw translateError(error);
    }
  }

  // POST /v1/artifacts
  // { requestId, totalLength, sha256 } -> receipt
  beginUpload(input = {}) {
    this._ensureOpen();
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      invalidInput();
    }
    const project = normalizeProject(input.project);
    const requestId = normalizeUuid(input.requestId);
    const totalLength = normalizeSize(
      input.totalLength,
      this._limits.maxArtifactBytes,
      'invalid_size'
    );
    const sha256 = normalizeDigest(input.sha256);
    const fingerprint = JSON.stringify([1, totalLength, sha256]);

    try {
      return runImmediate(this.db, () => {
        const existing = this.db
          .prepare(
            `SELECT fingerprint, artifact_id FROM requests
              WHERE project = ? AND request_id = ?`
          )
          .get(project, requestId);
        if (existing) {
          if (existing.fingerprint !== fingerprint) {
            fail('conflict', 'Request identifier reused with different metadata.');
          }
          const row = this._row(project, existing.artifact_id);
          if (!row) {
            fail('not_found', 'Artifact not found.');
          }
          return receiptOf(row);
        }

        const nowMs = this._now();
        const usage = this._usage(project);
        if (
          usage.projectBytes + totalLength > this._limits.maxProjectBytes ||
          usage.globalBytes + totalLength > this._limits.maxGlobalBytes
        ) {
          fail('quota_exceeded', 'Artifact storage quota exceeded.');
        }
        if (usage.projectUploads >= this._limits.maxUploadsPerProject) {
          fail('quota_exceeded', 'Too many concurrent uploads for this project.');
        }
        if (
          usage.projectArtifacts >= this._limits.maxArtifactsPerProject ||
          usage.globalArtifacts >= this._limits.maxArtifactsGlobal
        ) {
          fail('quota_exceeded', 'Artifact metadata limit reached.');
        }

        const artifactId = crypto.randomUUID();
        const expiresAt = futureTime(nowMs, this._limits.uploadTtlMs);
        this.db
          .prepare(
            `INSERT INTO artifacts
              (artifact_id, project, total_length, sha256, state,
               received_bytes, chunk_count, created_at, expires_at,
               published_at, acknowledged_at, failed_at, request_id,
               request_fingerprint)
             VALUES (?, ?, ?, ?, 'uploading', 0, 0, ?, ?, NULL, NULL,
                     NULL, ?, ?)`
          )
          .run(
            artifactId,
            project,
            totalLength,
            sha256,
            nowMs,
            expiresAt,
            requestId,
            fingerprint
          );
        this.db
          .prepare(
            `INSERT INTO requests
              (project, request_id, fingerprint, artifact_id, created_at)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run(project, requestId, fingerprint, artifactId, nowMs);

        return receiptOf(this._row(project, artifactId));
      });
    } catch (error) {
      throw translateError(error);
    }
  }

  // POST /v1/artifacts/{artifactId}/chunks
  // { offset, data } -> receipt
  appendChunk(input = {}) {
    this._ensureOpen();
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      invalidInput();
    }
    const project = normalizeProject(input.project);
    const artifactId = normalizeUuid(input.artifactId);
    const data = decodeChunk(input.data);
    const chunkDigest = digestOf(data);

    try {
      return runImmediate(this.db, () => {
        const row = this._requireRow(project, artifactId);
        if (row.state === 'failed') {
          fail('artifact_failed', 'Artifact upload failed.');
        }
        if (row.state !== 'uploading') {
          fail('not_ready', 'Artifact is not accepting chunks.');
        }
        const nowMs = this._now();
        if (row.expires_at !== null && row.expires_at <= nowMs) {
          fail('upload_expired', 'Upload reservation expired.');
        }
        const offset = normalizeOffset(input.offset, row.total_length);
        if (offset + data.length > row.total_length) {
          fail('invalid_offset', 'Chunk exceeds the declared artifact length.');
        }

        if (offset < row.received_bytes) {
          // Exact retry: the same bytes at the same offset are already durable.
          const existing = this.db
            .prepare(
              `SELECT length, sha256, data FROM chunks
                WHERE artifact_id = ? AND offset = ?`
            )
            .get(artifactId, offset);
          if (
            existing &&
            existing.length === data.length &&
            existing.sha256 === chunkDigest &&
            Buffer.from(existing.data).equals(data)
          ) {
            return receiptOf(row);
          }
          fail('conflict', 'Chunk conflicts with stored data.');
        }
        if (offset !== row.received_bytes) {
          fail('offset_mismatch', 'Chunk offset does not follow received bytes.');
        }

        const chunkLimit = chunkLimitFor(
          row.total_length,
          this._limits.maxChunksPerArtifact
        );
        if (row.chunk_count >= chunkLimit) {
          fail('chunk_limit', 'Chunk metadata limit reached for this artifact.');
        }
        const globalChunks = this.db
          .prepare('SELECT COUNT(*) AS value FROM chunks')
          .get().value;
        if (globalChunks >= this._limits.maxChunkRowsGlobal) {
          fail('quota_exceeded', 'Chunk metadata limit reached.');
        }

        this.db
          .prepare(
            `INSERT INTO chunks (artifact_id, offset, length, sha256, data)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run(artifactId, offset, data.length, chunkDigest, data);
        this.db
          .prepare(
            `UPDATE artifacts
                SET received_bytes = received_bytes + ?,
                    chunk_count = chunk_count + 1
              WHERE artifact_id = ? AND project = ?`
          )
          .run(data.length, artifactId, project);

        return receiptOf(this._requireRow(project, artifactId));
      });
    } catch (error) {
      throw translateError(error);
    }
  }

  // POST /v1/artifacts/{artifactId}/finish
  finishUpload(input = {}) {
    this._ensureOpen();
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      invalidInput();
    }
    const project = normalizeProject(input.project);
    const artifactId = normalizeUuid(input.artifactId);

    try {
      const outcome = runImmediate(this.db, () => {
        const row = this._requireRow(project, artifactId);
        if (row.state === 'published') {
          return { receipt: receiptOf(row) };
        }
        if (row.state === 'failed') {
          fail('artifact_failed', 'Artifact upload failed.');
        }
        if (row.state !== 'uploading') {
          fail('not_ready', 'Artifact is not ready to publish.');
        }
        const nowMs = this._now();
        if (row.received_bytes !== row.total_length) {
          // Incomplete uploads stay resumable: throwing rolls the transaction
          // back without changing state.
          fail('incomplete', 'Artifact is incomplete.');
        }

        // Hash the stored chunks in offset order without materialising the
        // whole stream. Each row is at most MAX_CHUNK_BYTES.
        const hash = crypto.createHash('sha256');
        let expectedOffset = 0;
        let rows = 0;
        let corrupt = false;
        const statement = this.db.prepare(
          `SELECT offset, length, sha256, data FROM chunks
            WHERE artifact_id = ? ORDER BY offset ASC`
        );
        for (const chunk of statement.iterate(artifactId)) {
          rows += 1;
          const bytes = Buffer.from(chunk.data);
          if (
            chunk.offset !== expectedOffset ||
            chunk.length !== bytes.length ||
            bytes.length === 0 ||
            bytes.length > MAX_CHUNK_BYTES ||
            chunk.sha256 !== digestOf(bytes)
          ) {
            corrupt = true;
            break;
          }
          hash.update(bytes);
          expectedOffset += bytes.length;
        }
        const digest = hash.digest('hex');
        if (
          corrupt ||
          rows !== row.chunk_count ||
          expectedOffset !== row.total_length ||
          digest !== row.sha256
        ) {
          return { failure: 'integrity' };
        }

        this.db
          .prepare(
            `UPDATE artifacts
                SET state = 'published', published_at = ?, expires_at = NULL
              WHERE artifact_id = ? AND project = ? AND state = 'uploading'`
          )
          .run(nowMs, artifactId, project);
        return { receipt: receiptOf(this._requireRow(project, artifactId)) };
      });

      if (outcome.failure) {
        // Failure state is committed separately so the partial cannot be
        // published later. Chunk bytes are discarded and quota is released.
        runImmediate(this.db, () => {
          const row = this._row(project, artifactId);
          if (row && row.state === 'uploading') {
            this.db
              .prepare('DELETE FROM chunks WHERE artifact_id = ?')
              .run(artifactId);
            this.db
              .prepare(
                `UPDATE artifacts
                    SET state = 'failed', failed_at = ?, chunk_count = 0
                  WHERE artifact_id = ? AND project = ?`
              )
              .run(this._now(), artifactId, project);
          }
        });
        fail('digest_mismatch', 'Artifact digest or length does not match.');
      }

      return outcome.receipt;
    } catch (error) {
      throw translateError(error);
    }
  }

  // GET /v1/artifacts/{artifactId}
  getArtifact(input = {}) {
    this._ensureOpen();
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      invalidInput();
    }
    const project = normalizeProject(input.project);
    const artifactId = normalizeUuid(input.artifactId);
    try {
      return receiptOf(this._requireRow(project, artifactId));
    } catch (error) {
      throw translateError(error);
    }
  }

  // GET /v1/artifacts/{artifactId}/chunks/{offset}
  readChunk(input = {}) {
    this._ensureOpen();
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      invalidInput();
    }
    const project = normalizeProject(input.project);
    const artifactId = normalizeUuid(input.artifactId);
    if (!Number.isSafeInteger(input.offset) || input.offset < 0) {
      fail('invalid_offset', 'Invalid chunk offset.');
    }
    try {
      const row = this._requireRow(project, artifactId);
      if (row.state !== 'published') {
        fail('not_ready', 'Artifact is not published.');
      }
      if (input.offset >= row.total_length) {
        fail('invalid_offset', 'Invalid chunk offset.');
      }
      const chunk = this.db
        .prepare(
          `SELECT offset, length, sha256, data FROM chunks
            WHERE artifact_id = ? AND offset = ?`
        )
        .get(artifactId, input.offset);
      if (!chunk) {
        fail('not_found', 'Chunk not found.');
      }
      const bytes = Buffer.from(chunk.data);
      if (
        bytes.length !== chunk.length ||
        digestOf(bytes) !== chunk.sha256
      ) {
        fail('store_error', 'Artifact chunk is corrupt.');
      }
      return {
        artifactId,
        offset: chunk.offset,
        length: chunk.length,
        sha256: chunk.sha256,
        data: bytes.toString('base64'),
      };
    } catch (error) {
      throw translateError(error);
    }
  }

  // POST /v1/artifacts/{artifactId}/acknowledge
  acknowledge(input = {}) {
    this._ensureOpen();
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      invalidInput();
    }
    const project = normalizeProject(input.project);
    const artifactId = normalizeUuid(input.artifactId);
    try {
      return runImmediate(this.db, () => {
        const row = this._requireRow(project, artifactId);
        if (row.state !== 'published') {
          fail('not_ready', 'Artifact is not published.');
        }
        if (row.acknowledged_at !== null) {
          return receiptOf(row);
        }
        this.db
          .prepare(
            `UPDATE artifacts SET acknowledged_at = ?
              WHERE artifact_id = ? AND project = ? AND state = 'published'
                AND acknowledged_at IS NULL`
          )
          .run(this._now(), artifactId, project);
        return receiptOf(this._requireRow(project, artifactId));
      });
    } catch (error) {
      throw translateError(error);
    }
  }

  listArtifacts(project) {
    this._ensureOpen();
    normalizeProject(project);
    try {
      const rows = this.db
        .prepare(
          `SELECT ${ARTIFACT_COLUMNS} FROM artifacts
            WHERE project = ? ORDER BY created_at ASC, artifact_id ASC`
        )
        .all(project);
      return rows.map(receiptOf);
    } catch (error) {
      throw translateError(error);
    }
  }

  // Reclaims only rows owned by this database that meet an explicit expiry or
  // retention rule. No filesystem path is touched.
  collectGarbage() {
    this._ensureOpen();
    try {
      return runImmediate(this.db, () => {
        const nowMs = this._now();
        const removed = {
          expiredUploads: 0,
          acknowledged: 0,
          publishedExpired: 0,
          failed: 0,
          releasedBytes: 0,
        };

        const collect = (selector, counter) => {
          const rows = this.db.prepare(selector).all(nowMs);
          for (const row of rows) {
            this.db
              .prepare('DELETE FROM chunks WHERE artifact_id = ?')
              .run(row.artifact_id);
            this.db
              .prepare('DELETE FROM requests WHERE artifact_id = ?')
              .run(row.artifact_id);
            this.db
              .prepare('DELETE FROM artifacts WHERE artifact_id = ?')
              .run(row.artifact_id);
            removed[counter] += 1;
            // Failed rows already released their reservation at failure time.
            if (counter !== 'failed') {
              removed.releasedBytes += row.total_length;
            }
          }
        };

        collect(
          `SELECT artifact_id, total_length FROM artifacts
            WHERE state = 'uploading'
              AND expires_at IS NOT NULL AND expires_at <= ?`,
          'expiredUploads'
        );

        collect(
          `SELECT artifact_id, total_length FROM artifacts
            WHERE state = 'published' AND acknowledged_at IS NOT NULL
              AND acknowledged_at <= ?`,
          'acknowledged'
        );

        if (this._limits.publishedTtlMs !== null) {
          collect(
            `SELECT artifact_id, total_length FROM artifacts
              WHERE state = 'published' AND acknowledged_at IS NULL
                AND published_at IS NOT NULL
                AND published_at <= ?`,
            'publishedExpired'
          );
        }

        collect(
          `SELECT artifact_id, total_length FROM artifacts
            WHERE state = 'failed' AND failed_at IS NOT NULL
              AND failed_at <= ?`,
          'failed'
        );

        return removed;
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

function normalizeLimit(value, fallback, code) {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(code, 'Invalid limit.');
  }
  return value;
}

function normalizeRetention(value, fallback, code) {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(code, 'Invalid retention.');
  }
  return value;
}

function openArtifactStore(stateDir, options = {}) {
  try {
    return openArtifactStoreInternal(stateDir, options);
  } catch (error) {
    if (error instanceof ArtifactStoreError) {
      throw error;
    }
    throw new ArtifactStoreError(
      'store_unavailable',
      'Artifact store is unavailable.'
    );
  }
}

function openArtifactStoreInternal(stateDir, options = {}) {
  if (
    typeof stateDir !== 'string' ||
    stateDir.length === 0 ||
    stateDir.length > MAX_STATE_DIR_LENGTH ||
    stateDir.includes('\u0000')
  ) {
    fail('unsafe_state_directory', 'Unsafe state directory.');
  }
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    invalidInput();
  }

  const clock = createClock(options.now);
  const limits = {
    maxArtifactBytes: normalizeLimit(
      options.maxArtifactBytes,
      MAX_ARTIFACT_BYTES,
      'invalid_limit'
    ),
    maxProjectBytes: normalizeLimit(
      options.maxProjectBytes,
      MAX_PROJECT_BYTES,
      'invalid_limit'
    ),
    maxGlobalBytes: normalizeLimit(
      options.maxGlobalBytes,
      MAX_GLOBAL_BYTES,
      'invalid_limit'
    ),
    maxUploadsPerProject: normalizeLimit(
      options.maxUploadsPerProject,
      MAX_UPLOADS_PER_PROJECT,
      'invalid_limit'
    ),
    maxArtifactsPerProject: normalizeLimit(
      options.maxArtifactsPerProject,
      MAX_ARTIFACTS_PER_PROJECT,
      'invalid_limit'
    ),
    maxArtifactsGlobal: normalizeLimit(
      options.maxArtifactsGlobal,
      MAX_ARTIFACTS_GLOBAL,
      'invalid_limit'
    ),
    maxChunksPerArtifact: normalizeLimit(
      options.maxChunksPerArtifact,
      MAX_CHUNKS_PER_ARTIFACT,
      'invalid_limit'
    ),
    maxChunkRowsGlobal: normalizeLimit(
      options.maxChunkRowsGlobal,
      MAX_CHUNK_ROWS_GLOBAL,
      'invalid_limit'
    ),
    uploadTtlMs: normalizeLimit(
      options.uploadTtlMs,
      DEFAULT_UPLOAD_TTL_MS,
      'invalid_limit'
    ),
    acknowledgedRetentionMs: normalizeRetention(
      options.acknowledgedRetentionMs,
      DEFAULT_ACKNOWLEDGED_RETENTION_MS,
      'invalid_limit'
    ),
    failedRetentionMs: normalizeRetention(
      options.failedRetentionMs,
      DEFAULT_FAILED_RETENTION_MS,
      'invalid_limit'
    ),
    publishedTtlMs:
      options.publishedTtlMs === undefined || options.publishedTtlMs === null
        ? null
        : normalizeRetention(options.publishedTtlMs, null, 'invalid_limit'),
  };

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

  const dbPath = path.join(resolvedDir, 'artifacts.sqlite');
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

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: false });
  } catch {
    fail('unsafe_database_file', 'Unsafe database file.');
  }

  try {
    const openedFile = lstatOrNull(dbPath);
    if (
      !openedFile ||
      openedFile.dev !== dbStat.dev ||
      openedFile.ino !== dbStat.ino
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

  return new ArtifactStore(db, clock, limits);
}

module.exports = {
  openArtifactStore,
  ArtifactStoreError,
  MAX_CHUNK_BYTES,
  MAX_ARTIFACT_BYTES,
};
