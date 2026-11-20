'use strict';

const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const {
  ProcessLockError,
  acquireProcessGuard,
  claimLegacyMetadata,
  sleepSync,
  unlinkOwnLegacyOwner,
} = require('./process-lock.cjs');

const TLS_DIRECTORY = 'tls';
const CERT_FILE = 'cert.pem';
const KEY_FILE = 'key.pem';
const LOCK_FILE = 'identity.lock';
const LOCK_MAGIC = 'alpi-identity-v1';
const MAX_STATE_DIR_LENGTH = 4096;
const LOCK_TIMEOUT_MS = 60_000;
const LOCK_POLL_MS = 50;
const LOCK_STALE_MS = 10_000;
const CERTIFICATE_DAYS = 3650;
const OPENSSL_TIMEOUT_MS = 30_000;
const MAX_IDENTITY_FILE_BYTES = 64 * 1024;

class IdentityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'IdentityError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new IdentityError(code, message);
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

function ensurePrivateStateDirectory(stateDir) {
  if (
    typeof stateDir !== 'string' ||
    stateDir.length === 0 ||
    stateDir.length > MAX_STATE_DIR_LENGTH ||
    stateDir.includes('\u0000')
  ) {
    fail('unsafe_state_directory', 'Unsafe state directory.');
  }

  const resolvedDir = path.resolve(stateDir);
  const parentStat = lstatOrNull(path.dirname(resolvedDir));
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
  return resolvedDir;
}

function ensurePrivateSubdirectory(parentDir, name) {
  const directory = path.join(parentDir, name);
  let stat = lstatOrNull(directory);
  if (!stat) {
    let created = false;
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') {
        fail('unsafe_identity_directory', 'Unsafe identity directory.');
      }
    }
    stat = lstatOrNull(directory);
    if (!stat) {
      fail('unsafe_identity_directory', 'Unsafe identity directory.');
    }
    if (created && (stat.mode & 0o777) !== 0o700) {
      try {
        fs.chmodSync(directory, 0o700);
      } catch {
        fail('unsafe_identity_directory', 'Unsafe identity directory.');
      }
      stat = lstatOrNull(directory);
    }
  }
  assertPrivateDirectory(stat);
  return directory;
}

function identityPaths(stateDir) {
  const resolvedDir = path.resolve(stateDir);
  const tlsDir = path.join(resolvedDir, TLS_DIRECTORY);
  return {
    stateDir: resolvedDir,
    tlsDir,
    certPath: path.join(tlsDir, CERT_FILE),
    keyPath: path.join(tlsDir, KEY_FILE),
    lockPath: path.join(resolvedDir, LOCK_FILE),
  };
}

/**
 * Serialize identity publication with an OS-released SQLite guard and, while
 * that guard is held, claim the legacy advisory metadata file. A competing
 * process (including an older version that only knows the metadata file) is
 * observed before any cleanup; nothing is removed while its owner is alive.
 */
function acquireIdentityOwnership(lockPath) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  for (;;) {
    const remaining = Math.max(1, deadline - Date.now());
    let guard;
    try {
      guard = acquireProcessGuard(lockPath, {
        timeoutMs: remaining,
        pollMs: LOCK_POLL_MS,
      });
    } catch (error) {
      if (error instanceof ProcessLockError && error.code === 'lock_busy') {
        fail('identity_busy', 'TLS identity is busy.');
      }
      fail('identity_unavailable', 'TLS identity is unavailable.');
    }

    let claimed;
    try {
      claimed = claimLegacyMetadata(lockPath, LOCK_MAGIC, LOCK_STALE_MS);
    } catch (error) {
      guard.release();
      if (error instanceof ProcessLockError) {
        fail('identity_unavailable', 'TLS identity is unavailable.');
      }
      throw error;
    }

    if (claimed) {
      return guard;
    }

    guard.release();
    if (Date.now() >= deadline) {
      fail('identity_busy', 'TLS identity is busy.');
    }
    sleepSync(LOCK_POLL_MS);
  }
}

function readPrivateFile(filePath, label) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      fail('identity_corrupt', `${label} is missing.`);
    }
    fail('identity_unavailable', 'TLS identity is unavailable.');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail('identity_corrupt', `${label} is not a regular file.`);
  }
  const uid = currentUid();
  if (uid !== null && stat.uid !== uid) {
    fail('identity_corrupt', `${label} is owned by another user.`);
  }
  if (stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) {
    fail('identity_corrupt', `${label} has unsafe permissions.`);
  }
  if (stat.size > MAX_IDENTITY_FILE_BYTES) {
    fail('identity_corrupt', `${label} is too large.`);
  }
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    fail('identity_unavailable', 'TLS identity is unavailable.');
  }
}

function parseIdentity(certPem, keyPem) {
  let certificate;
  let privateKey;
  try {
    certificate = new crypto.X509Certificate(certPem);
    privateKey = crypto.createPrivateKey(keyPem);
  } catch {
    fail('identity_corrupt', 'TLS identity is corrupt.');
  }

  let publicFromKey;
  let publicFromCert;
  try {
    publicFromKey = crypto
      .createPublicKey(privateKey)
      .export({ type: 'spki', format: 'der' });
    publicFromCert = certificate.publicKey.export({
      type: 'spki',
      format: 'der',
    });
  } catch {
    fail('identity_corrupt', 'TLS identity is corrupt.');
  }

  if (
    publicFromKey.length !== publicFromCert.length ||
    !crypto.timingSafeEqual(publicFromKey, publicFromCert)
  ) {
    fail('identity_corrupt', 'TLS identity key does not match its certificate.');
  }

  let selfSigned = false;
  try {
    selfSigned = certificate.verify(certificate.publicKey);
  } catch {
    selfSigned = false;
  }
  if (!selfSigned) {
    fail('identity_corrupt', 'TLS certificate is not self-signed.');
  }

  const notBefore = Date.parse(certificate.validFrom);
  const notAfter = Date.parse(certificate.validTo);
  const now = Date.now();
  if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter)) {
    fail('identity_corrupt', 'TLS certificate validity is invalid.');
  }
  if (notAfter <= now) {
    fail('identity_corrupt', 'TLS certificate has expired.');
  }
  if (notBefore > now + 5 * 60 * 1000) {
    fail('identity_corrupt', 'TLS certificate is not yet valid.');
  }

  return {
    certPem,
    keyPem,
    certificate,
    fingerprint: certificate.fingerprint256,
  };
}

function loadExistingIdentity(paths) {
  const certStat = lstatOrNull(paths.certPath);
  const keyStat = lstatOrNull(paths.keyPath);

  if (!certStat && !keyStat) {
    return null;
  }
  if (!certStat || !keyStat) {
    fail(
      'identity_corrupt',
      'TLS identity is incomplete; refusing to rotate it.'
    );
  }

  const certPem = readPrivateFile(paths.certPath, 'TLS certificate');
  const keyPem = readPrivateFile(paths.keyPath, 'TLS private key');
  return parseIdentity(certPem, keyPem);
}

function fsyncFile(filePath) {
  const descriptor = fs.openSync(filePath, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function fsyncDirectory(directory) {
  let descriptor = null;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch {
    // Directory fsync is best effort on platforms that do not support it.
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Ignore close failures after a best-effort fsync.
      }
    }
  }
}

function cleanupStaleTemporaryFiles(tlsDir) {
  let entries;
  try {
    entries = fs.readdirSync(tlsDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!/^\.(?:key|cert)-[0-9a-f]{24}\.tmp$/.test(entry)) {
      continue;
    }
    try {
      fs.unlinkSync(path.join(tlsDir, entry));
    } catch {
      // Best-effort cleanup of a previous crashed generation.
    }
  }
}

function generateIdentity(paths) {
  const suffix = crypto.randomBytes(12).toString('hex');
  const tempKeyPath = path.join(paths.tlsDir, `.key-${suffix}.tmp`);
  const tempCertPath = path.join(paths.tlsDir, `.cert-${suffix}.tmp`);

  cleanupStaleTemporaryFiles(paths.tlsDir);

  try {
    try {
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          tempKeyPath,
          '-out',
          tempCertPath,
          '-days',
          String(CERTIFICATE_DAYS),
          '-subj',
          '/CN=alpi-server',
          '-addext',
          'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1',
        ],
        {
          stdio: ['ignore', 'ignore', 'pipe'],
          timeout: OPENSSL_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
          env: {
            PATH: process.env.PATH || '/usr/bin:/bin',
            LANG: 'C',
          },
        }
      );
    } catch {
      fail('identity_unavailable', 'TLS identity could not be generated.');
    }

    fs.chmodSync(tempKeyPath, 0o600);
    fs.chmodSync(tempCertPath, 0o600);

    const certPem = fs.readFileSync(tempCertPath, 'utf8');
    const keyPem = fs.readFileSync(tempKeyPath, 'utf8');
    const identity = parseIdentity(certPem, keyPem);

    fsyncFile(tempKeyPath);
    fsyncFile(tempCertPath);

    // Publish each file with an atomic rename inside the locked directory.
    // A crash between the two renames leaves a detectable incomplete
    // identity; the next start fails instead of silently rotating it. If the
    // second rename fails, remove the first published file so a failed
    // generation does not leave a misleading partial identity.
    let certificatePublished = false;
    try {
      fs.renameSync(tempCertPath, paths.certPath);
      certificatePublished = true;
      fs.renameSync(tempKeyPath, paths.keyPath);
    } catch (error) {
      if (certificatePublished) {
        try {
          fs.unlinkSync(paths.certPath);
        } catch {
          // Best effort; an incomplete identity is detected on next start.
        }
      }
      throw error;
    }
    fsyncDirectory(paths.tlsDir);
    fsyncDirectory(paths.stateDir);

    return identity;
  } finally {
    for (const temporary of [tempKeyPath, tempCertPath]) {
      try {
        fs.unlinkSync(temporary);
      } catch (error) {
        if (!error || error.code !== 'ENOENT') {
          // Temporary cleanup is best effort; never mask the original error.
        }
      }
    }
  }
}

/**
 * Load an existing persistent TLS identity or generate a new one.
 *
 * The identity is generated once with the system openssl binary and published
 * under an exclusive lock. Corrupt or incomplete identities are never rotated;
 * they raise IdentityError('identity_corrupt') instead.
 */
function ensureIdentity(stateDir) {
  try {
    const resolvedDir = ensurePrivateStateDirectory(stateDir);
    const paths = identityPaths(resolvedDir);
    ensurePrivateSubdirectory(resolvedDir, TLS_DIRECTORY);

    const guard = acquireIdentityOwnership(paths.lockPath);
    try {
      const existing = loadExistingIdentity(paths);
      const identity = existing || generateIdentity(paths);
      return {
        stateDir: resolvedDir,
        certPath: paths.certPath,
        keyPath: paths.keyPath,
        certPem: identity.certPem,
        keyPem: identity.keyPem,
        fingerprint: identity.fingerprint,
      };
    } finally {
      try {
        unlinkOwnLegacyOwner(paths.lockPath, LOCK_MAGIC);
      } finally {
        guard.release();
      }
    }
  } catch (error) {
    if (error instanceof IdentityError) {
      throw error;
    }
    throw new IdentityError('identity_unavailable', 'TLS identity is unavailable.');
  }
}

/**
 * Load an existing identity without generating one. Intended for inspection.
 */
function loadIdentity(stateDir) {
  try {
    const resolvedDir = ensurePrivateStateDirectory(stateDir);
    const paths = identityPaths(resolvedDir);
    const stat = lstatOrNull(paths.tlsDir);
    if (!stat) {
      fail('identity_corrupt', 'TLS identity is missing.');
    }
    assertPrivateDirectory(stat);
    const identity = loadExistingIdentity(paths);
    if (!identity) {
      fail('identity_corrupt', 'TLS identity is missing.');
    }
    return {
      stateDir: resolvedDir,
      certPath: paths.certPath,
      keyPath: paths.keyPath,
      certPem: identity.certPem,
      keyPem: identity.keyPem,
      fingerprint: identity.fingerprint,
    };
  } catch (error) {
    if (error instanceof IdentityError) {
      throw error;
    }
    throw new IdentityError('identity_unavailable', 'TLS identity is unavailable.');
  }
}

module.exports = {
  ensureIdentity,
  loadIdentity,
  identityPaths,
  IdentityError,
};
