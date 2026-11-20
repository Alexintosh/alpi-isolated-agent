'use strict';

const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const GUARD_SUFFIX = '.sqlite';
const MAX_LOCK_PATH_LENGTH = 4096;
const DEFAULT_POLL_MS = 50;
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

class ProcessLockError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProcessLockError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProcessLockError(code, message);
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

function sleepSync(milliseconds) {
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(4)),
    0,
    0,
    milliseconds
  );
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

function isBusyError(error) {
  if (!error) {
    return false;
  }
  if (error.errcode === SQLITE_BUSY || error.errcode === SQLITE_LOCKED) {
    return true;
  }
  return typeof error.message === 'string' && /database is (?:locked|busy)/i.test(error.message);
}

function guardPathFor(lockPath) {
  if (
    typeof lockPath !== 'string' ||
    lockPath.length === 0 ||
    lockPath.length > MAX_LOCK_PATH_LENGTH ||
    lockPath.includes('\u0000')
  ) {
    fail('lock_unavailable', 'Process lock is unavailable.');
  }
  return `${lockPath}${GUARD_SUFFIX}`;
}

function ensureGuardFile(guardPath) {
  let stat = lstatOrNull(guardPath);
  if (!stat) {
    let descriptor = null;
    try {
      descriptor = fs.openSync(guardPath, 'wx', 0o600);
    } catch (error) {
      if (!error || error.code !== 'EEXIST') {
        fail('lock_unavailable', 'Process lock is unavailable.');
      }
    } finally {
      if (descriptor !== null) {
        try {
          fs.closeSync(descriptor);
        } catch {
          fail('lock_unavailable', 'Process lock is unavailable.');
        }
      }
    }
    stat = lstatOrNull(guardPath);
  }

  if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
    fail('lock_unavailable', 'Process lock is unavailable.');
  }
  const uid = currentUid();
  if (uid !== null && stat.uid !== uid) {
    fail('lock_unavailable', 'Process lock is unavailable.');
  }
  if ((stat.mode & 0o077) !== 0) {
    try {
      fs.chmodSync(guardPath, 0o600);
    } catch {
      fail('lock_unavailable', 'Process lock is unavailable.');
    }
    stat = lstatOrNull(guardPath);
    if (!stat || (stat.mode & 0o077) !== 0) {
      fail('lock_unavailable', 'Process lock is unavailable.');
    }
  }
  return guardPath;
}

/**
 * Acquire an OS-released exclusive guard backed by a private, persistent
 * SQLite database. BEGIN IMMEDIATE takes SQLite's write lock on the database
 * file; the operating system releases it when the process exits, so a crashed
 * owner cannot leave a lock that another owner must "reclaim" by deletion.
 *
 * The guard file is never unlinked or replaced: it is the stable identity of
 * the lock, and SQLite itself serializes acquisition through it.
 */
function acquireProcessGuard(lockPath, options = {}) {
  const guardPath = ensureGuardFile(guardPathFor(lockPath));
  const failFast = options.failFast === true;
  const timeoutMs =
    Number.isInteger(options.timeoutMs) && options.timeoutMs >= 0
      ? options.timeoutMs
      : 60_000;
  const pollMs =
    Number.isInteger(options.pollMs) && options.pollMs > 0
      ? options.pollMs
      : DEFAULT_POLL_MS;
  const deadline = Date.now() + timeoutMs;

  let database;
  try {
    database = new DatabaseSync(guardPath);
    database.exec('PRAGMA busy_timeout = 0');
  } catch {
    if (database) {
      try {
        database.close();
      } catch {
        // Ignore close failures while reporting the acquisition error.
      }
    }
    fail('lock_unavailable', 'Process lock is unavailable.');
  }

  let released = false;
  for (;;) {
    try {
      database.exec('BEGIN IMMEDIATE');
      return {
        lockPath,
        guardPath,
        release() {
          if (released) {
            return;
          }
          released = true;
          try {
            database.exec('ROLLBACK');
          } catch {
            // The transaction may already be gone after an abrupt stop.
          }
          try {
            database.close();
          } catch {
            // Closing the connection is best effort on release.
          }
        },
      };
    } catch (error) {
      if (!isBusyError(error)) {
        try {
          database.close();
        } catch {
          // Ignore close failures while reporting the acquisition error.
        }
        fail('lock_unavailable', 'Process lock is unavailable.');
      }
      if (failFast || Date.now() >= deadline) {
        try {
          database.close();
        } catch {
          // Ignore close failures while reporting the busy lock.
        }
        fail('lock_busy', 'Process lock is busy.');
      }
      sleepSync(pollMs);
    }
  }
}

function readLegacyOwner(filePath, magic) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { missing: true };
    }
    throw error;
  }

  const stat = lstatOrNull(filePath);
  const ageMs = stat ? Math.max(0, Date.now() - stat.mtimeMs) : 0;
  const lines = raw.split('\n');
  if ((lines[0] || '').trim() !== magic) {
    return { malformed: true, ageMs };
  }
  const pidText = (lines[1] || '').trim();
  if (!/^\d+$/.test(pidText)) {
    return { malformed: true, ageMs };
  }
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { malformed: true, ageMs };
  }
  return { pid, ageMs };
}

function writeLegacyOwner(filePath, magic) {
  let descriptor = null;
  try {
    descriptor = fs.openSync(filePath, 'wx', 0o600);
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      return false;
    }
    throw error;
  }
  try {
    fs.writeFileSync(
      descriptor,
      `${magic}\n${process.pid}\n${Date.now()}\n`,
      'utf8'
    );
    fs.fsyncSync(descriptor);
    return true;
  } catch (error) {
    try {
      fs.closeSync(descriptor);
    } catch {
      // Ignore close failures while removing a partial metadata file.
    }
    descriptor = null;
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Best effort; a partial file is detected as malformed on next start.
    }
    throw error;
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The metadata is advisory; a close failure is not fatal here.
      }
    }
  }
}

function unlinkLegacyOwner(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      throw error;
    }
  }
}

function unlinkOwnLegacyOwner(filePath, magic) {
  const owner = readLegacyOwner(filePath, magic);
  if (!owner || owner.missing || owner.pid !== process.pid) {
    return;
  }
  unlinkLegacyOwner(filePath);
}

/**
 * Claim the advisory metadata file while the guard is held. Returns false when
 * another owner (usually an older process that does not use the guard) still
 * holds the metadata, so the caller should wait and retry rather than remove
 * anything.
 */
function claimLegacyMetadata(lockPath, magic, staleMs) {
  const owner = readLegacyOwner(lockPath, magic);
  if (owner.missing) {
    return writeLegacyOwner(lockPath, magic);
  }
  if (owner.malformed) {
    if (owner.ageMs <= staleMs) {
      return false;
    }
    unlinkLegacyOwner(lockPath);
    return writeLegacyOwner(lockPath, magic);
  }
  if (processIsAlive(owner.pid)) {
    return false;
  }
  unlinkLegacyOwner(lockPath);
  return writeLegacyOwner(lockPath, magic);
}

module.exports = {
  ProcessLockError,
  acquireProcessGuard,
  claimLegacyMetadata,
  guardPathFor,
  lstatOrNull,
  processIsAlive,
  readLegacyOwner,
  sleepSync,
  unlinkLegacyOwner,
  unlinkOwnLegacyOwner,
  writeLegacyOwner,
};
