'use strict';

// Portable headless context store. The configured private root is the single
// store; each context is one AES-256-GCM record in contexts/<name>.ctx and the
// pairing reservation is one owner-only file in reservations/<name>.reservation.
// Context publication uses a hardlink from a private temporary file so an
// existing context can never be replaced. A crash may leave a reservation or a
// temporary link; operators remove a stale reservation only when no alpi process
// is pairing. There is no keychain, fallback, key creation or key prompt.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STORE_VERSION = 1;
const STORE_FORMAT = 'alpi-context';
const KEY_BYTES = 32;
const MAX_CONTEXT_NAME_LENGTH = 64;
const MAX_PROJECT_LENGTH = 128;
const MAX_CLIENT_NAME_LENGTH = 64;
const MAX_PATH_LENGTH = 4096;
const MAX_CONTEXT_FILE_BYTES = 64 * 1024;
const MAX_INVITE_BYTES = 8 * 1024;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTEXT_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const ROLES = new Set(['observer', 'runner', 'operator']);
const INVITE_KEYS = ['origin', 'serverId', 'fingerprint', 'invitation', 'expiresAt'];
const CONTEXT_KEYS = [
  'version',
  'name',
  'origin',
  'serverId',
  'fingerprint',
  'credential',
  'clientId',
  'project',
  'role',
  'credentialExpiresAt',
  'createdAt',
];
const RECORD_KEYS = ['format', 'version', 'nonce', 'ciphertext', 'tag'];

class ContextError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ContextError';
    this.code = code;
    if (details && typeof details === 'object') {
      for (const key of Object.keys(details)) {
        if (key !== 'message' && key !== 'stack') {
          this[key] = details[key];
        }
      }
    }
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ContextError);
    }
  }
}

function fail(code, message, details) {
  throw new ContextError(code, message, details);
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

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function hasExactKeys(value, keys) {
  if (!isPlainObject(value)) {
    return false;
  }
  const own = Object.keys(value);
  if (own.length !== keys.length) {
    return false;
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      return false;
    }
  }
  return true;
}

function validateText(value, maxLength, code, message) {
  if (typeof value !== 'string') {
    fail(code, message);
  }
  if (value.length === 0 || value.length > maxLength || value !== value.trim()) {
    fail(code, message);
  }
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)) {
    fail(code, message);
  }
  return value;
}

function validateContextName(name) {
  if (typeof name !== 'string' || name.length === 0 ||
      name.length > MAX_CONTEXT_NAME_LENGTH ||
      !CONTEXT_NAME_PATTERN.test(name) ||
      name.includes('..') || name.endsWith('.')) {
    fail('INVALID_CONTEXT_NAME', 'Invalid context name.');
  }
  return name;
}

function normalizeServerId(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    fail('INVALID_SERVER_ID', 'Invalid server identity.');
  }
  return value.toLowerCase();
}

function normalizeClientId(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    fail('INVALID_CLIENT_ID', 'Invalid client identity.');
  }
  return value.toLowerCase();
}

function normalizeFingerprint(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    fail('INVALID_FINGERPRINT', 'Invalid certificate fingerprint.');
  }

  let hex;
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    hex = value;
  } else if (/^[0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){31}$/.test(value)) {
    hex = value.replace(/:/g, '');
  } else {
    fail('INVALID_FINGERPRINT', 'Invalid certificate fingerprint.');
  }
  return hex.toLowerCase();
}

function validateOrigin(origin) {
  if (typeof origin !== 'string' || origin.length === 0 || origin.length > 2048) {
    fail('INVALID_ORIGIN', 'Invalid HTTPS origin.');
  }
  if (origin !== origin.trim() || !/^https:\/\//i.test(origin)) {
    fail('INVALID_ORIGIN', 'Invalid HTTPS origin.');
  }

  let url;
  try {
    url = new URL(origin);
  } catch {
    fail('INVALID_ORIGIN', 'Invalid HTTPS origin.');
  }

  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
      url.pathname !== '/' || url.search !== '' || url.hash !== '' ||
      !url.hostname) {
    fail('INVALID_ORIGIN', 'Invalid HTTPS origin.');
  }
  if (url.port !== '') {
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      fail('INVALID_ORIGIN', 'Invalid HTTPS origin.');
    }
  }

  const afterScheme = origin.slice(origin.indexOf('//') + 2);
  const authorityEnd = afterScheme.search(/[/?#\\]/);
  const authority = authorityEnd === -1
    ? afterScheme
    : afterScheme.slice(0, authorityEnd);
  if (authority.includes('@') || authority.includes('\\')) {
    fail('INVALID_ORIGIN', 'Invalid HTTPS origin.');
  }
  if (authorityEnd !== -1 && afterScheme.slice(authorityEnd) !== '/') {
    fail('INVALID_ORIGIN', 'Invalid HTTPS origin.');
  }
  if (/[\u0000-\u0020\u007f]/.test(url.hostname)) {
    fail('INVALID_ORIGIN', 'Invalid HTTPS origin.');
  }

  return origin;
}

function validateToken(value, kind) {
  const code = kind === 'invitation' ? 'INVALID_INVITATION' : 'INVALID_CREDENTIAL';
  const message = kind === 'invitation'
    ? 'Invalid invitation.'
    : 'Invalid credential.';

  if (typeof value !== 'string' || !TOKEN_PATTERN.test(value)) {
    fail(code, message);
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== KEY_BYTES ||
      decoded.toString('base64url') !== value) {
    fail(code, message);
  }
  return value;
}

function validateRole(role) {
  if (typeof role !== 'string' || !ROLES.has(role)) {
    fail('INVALID_ROLE', 'Invalid role.');
  }
  return role;
}

function validateProject(project) {
  return validateText(
    project,
    MAX_PROJECT_LENGTH,
    'INVALID_PROJECT',
    'Invalid project.',
  );
}

function validateClientName(name) {
  return validateText(
    name,
    MAX_CLIENT_NAME_LENGTH,
    'INVALID_NAME',
    'Invalid client name.',
  );
}

function validateCredentialExpiresAt(expiresAt) {
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0 ||
      expiresAt > MAX_TIMESTAMP_MS) {
    fail('INVALID_EXPIRES_AT', 'Invalid credential expiry.');
  }
  return expiresAt;
}

function validateInviteEnvelope(envelope, options = {}) {
  const now = options.now === undefined ? Date.now() : options.now;
  if (!Number.isSafeInteger(now) || now < 0) {
    fail('INVALID_ENVELOPE', 'Invalid invitation envelope.');
  }
  if (!hasExactKeys(envelope, INVITE_KEYS)) {
    fail('INVALID_ENVELOPE', 'Invalid invitation envelope.');
  }

  const origin = validateOrigin(envelope.origin);
  const serverId = normalizeServerId(envelope.serverId);
  const fingerprint = normalizeFingerprint(envelope.fingerprint);
  const invitation = validateToken(envelope.invitation, 'invitation');
  if (!Number.isSafeInteger(envelope.expiresAt) || envelope.expiresAt <= 0 ||
      envelope.expiresAt > MAX_TIMESTAMP_MS) {
    fail('INVALID_ENVELOPE', 'Invalid invitation envelope.');
  }
  if (envelope.expiresAt <= now) {
    fail('INVITE_EXPIRED', 'Invitation has expired.');
  }

  return Object.freeze({
    origin,
    serverId,
    fingerprint,
    invitation,
    expiresAt: envelope.expiresAt,
  });
}

function parseInviteEnvelope(raw, options = {}) {
  let buffer;
  if (Buffer.isBuffer(raw)) {
    buffer = raw;
  } else if (typeof raw === 'string') {
    buffer = Buffer.from(raw, 'utf8');
  } else {
    fail('INVALID_ENVELOPE', 'Invalid invitation envelope.');
  }

  if (buffer.length === 0 || buffer.length > MAX_INVITE_BYTES) {
    fail('INVALID_ENVELOPE', 'Invalid invitation envelope.');
  }

  let parsed;
  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch {
    fail('INVALID_ENVELOPE', 'Invalid invitation envelope.');
  }
  try {
    return validateInviteEnvelope(parsed, options);
  } catch (error) {
    if (error instanceof ContextError && error.code === 'INVITE_EXPIRED') {
      throw error;
    }
    fail('INVALID_ENVELOPE', 'Invalid invitation envelope.');
  }
}

function validateContextRecord(record, expectedName) {
  if (!hasExactKeys(record, CONTEXT_KEYS)) {
    fail('CONTEXT_CORRUPT', 'Context record is invalid.');
  }
  if (record.version !== STORE_VERSION) {
    fail('CONTEXT_CORRUPT', 'Context record is invalid.');
  }
  if (record.name !== expectedName) {
    fail('CONTEXT_CORRUPT', 'Context record is invalid.');
  }

  const origin = validateOrigin(record.origin);
  const serverId = normalizeServerId(record.serverId);
  const fingerprint = normalizeFingerprint(record.fingerprint);
  const credential = validateToken(record.credential, 'credential');
  const clientId = normalizeClientId(record.clientId);
  const project = validateProject(record.project);
  const role = validateRole(record.role);
  const credentialExpiresAt = validateCredentialExpiresAt(record.credentialExpiresAt);
  if (!Number.isSafeInteger(record.createdAt) || record.createdAt < 0 ||
      record.createdAt > MAX_TIMESTAMP_MS) {
    fail('CONTEXT_CORRUPT', 'Context record is invalid.');
  }

  return Object.freeze({
    version: STORE_VERSION,
    name: expectedName,
    origin,
    serverId,
    fingerprint,
    credential,
    clientId,
    project,
    role,
    credentialExpiresAt,
    createdAt: record.createdAt,
  });
}

function resolveConfigDir(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const homedir = options.homedir || os.homedir();

  const configured = env.ALPI_CONFIG_DIR;
  if (configured !== undefined) {
    if (typeof configured !== 'string' || configured.length === 0 ||
        configured.length > MAX_PATH_LENGTH ||
        configured.includes('\u0000') ||
        !path.isAbsolute(configured)) {
      fail('INVALID_CONFIG_DIR', 'Invalid configuration directory.');
    }
    return path.normalize(configured);
  }

  const xdg = env.XDG_CONFIG_HOME;
  if (xdg !== undefined) {
    if (typeof xdg !== 'string' || xdg.length === 0 ||
        xdg.length > MAX_PATH_LENGTH ||
        xdg.includes('\u0000') ||
        !path.isAbsolute(xdg)) {
      fail('INVALID_CONFIG_DIR', 'Invalid configuration directory.');
    }
    return path.join(path.normalize(xdg), 'alpi');
  }

  if (typeof homedir !== 'string' || homedir.length === 0 ||
      homedir.length > MAX_PATH_LENGTH ||
      homedir.includes('\u0000') ||
      !path.isAbsolute(homedir)) {
    fail('INVALID_CONFIG_DIR', 'Invalid configuration directory.');
  }
  if (platform === 'darwin') {
    return path.join(homedir, 'Library', 'Application Support', 'alpi');
  }
  return path.join(homedir, '.config', 'alpi');
}

function assertPrivateDirectory(stat) {
  const uid = currentUid();
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink() ||
      (uid !== null && stat.uid !== uid) ||
      (stat.mode & 0o077) !== 0 ||
      (stat.mode & 0o700) !== 0o700) {
    fail('UNSAFE_CONFIG_DIR', 'Unsafe configuration directory.');
  }
}

function ensurePrivateDirectory(directory) {
  let stat;
  try {
    stat = fs.lstatSync(directory);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      fail('UNSAFE_CONFIG_DIR', 'Unsafe configuration directory.');
    }
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    } catch {
      fail('UNSAFE_CONFIG_DIR', 'Unsafe configuration directory.');
    }
    try {
      stat = fs.lstatSync(directory);
    } catch {
      fail('UNSAFE_CONFIG_DIR', 'Unsafe configuration directory.');
    }
  }
  assertPrivateDirectory(stat);
  return directory;
}

function isPathInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' ||
    (!path.isAbsolute(relative) &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`));
}

function readExactFile(filePath, options = {}) {
  const maxBytes = options.maxBytes;
  const minBytes = options.minBytes === undefined ? 1 : options.minBytes;
  const unsafeCode = options.unsafeCode || 'UNSAFE_FILE';
  const unsafeMessage = options.unsafeMessage || 'Unsafe private file.';
  const sizeCode = options.sizeCode || 'FILE_SIZE';
  const sizeMessage = options.sizeMessage || 'Private file has an invalid size.';
  const requireLinkCount = options.requireLinkCount === true;

  if (typeof filePath !== 'string' || filePath.length === 0 ||
      filePath.length > MAX_PATH_LENGTH || !path.isAbsolute(filePath) ||
      filePath.includes('\u0000')) {
    fail(unsafeCode, unsafeMessage);
  }

  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      fail('FILE_NOT_FOUND', 'File not found.');
    }
    fail(unsafeCode, unsafeMessage);
  }

  const uid = currentUid();
  if (!stat.isFile() || stat.isSymbolicLink() ||
      (uid !== null && stat.uid !== uid) ||
      (stat.mode & 0o077) !== 0 ||
      (stat.mode & 0o400) === 0 ||
      (requireLinkCount && stat.nlink !== 1)) {
    fail(unsafeCode, unsafeMessage);
  }
  if (stat.size < minBytes || stat.size > maxBytes) {
    fail(sizeCode, sizeMessage);
  }

  let fd;
  try {
    fd = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
  } catch {
    fail(unsafeCode, unsafeMessage);
  }

  try {
    let current;
    try {
      current = fs.fstatSync(fd);
    } catch {
      fail(unsafeCode, unsafeMessage);
    }
    if (!current.isFile() || current.ino !== stat.ino ||
        current.dev !== stat.dev ||
        (uid !== null && current.uid !== uid) ||
        (current.mode & 0o077) !== 0 ||
        (current.mode & 0o400) === 0 ||
        current.size < minBytes || current.size > maxBytes ||
        (requireLinkCount && current.nlink !== 1)) {
      fail(unsafeCode, unsafeMessage);
    }

    const buffer = Buffer.alloc(current.size);
    let offset = 0;
    while (offset < buffer.length) {
      let read;
      try {
        read = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      } catch {
        fail(unsafeCode, unsafeMessage);
      }
      if (read <= 0) {
        fail('FILE_CHANGED', 'Private file changed while reading.');
      }
      offset += read;
    }
    return buffer;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // The read already completed; a close failure does not expose data.
    }
  }
}

function readInviteFile(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0 ||
      filePath.length > MAX_PATH_LENGTH || filePath.includes('\u0000')) {
    fail('INVALID_INVITE_FILE', 'Invalid invitation file.');
  }
  const resolved = path.resolve(filePath);
  try {
    return readExactFile(resolved, {
      maxBytes: MAX_INVITE_BYTES,
      unsafeCode: 'UNSAFE_INVITE_FILE',
      unsafeMessage: 'Unsafe invitation file.',
      sizeCode: 'INVITE_TOO_LARGE',
      sizeMessage: 'Invitation file is too large.',
      requireLinkCount: true,
    });
  } catch (error) {
    if (error instanceof ContextError && error.code === 'FILE_NOT_FOUND') {
      fail('INVITE_FILE_NOT_FOUND', 'Invitation file not found.');
    }
    throw error;
  }
}

function readProtectedStdin(options = {}) {
  const fd = options.fd === undefined ? 0 : options.fd;
  const maxBytes = options.maxBytes === undefined ? MAX_INVITE_BYTES : options.maxBytes;

  let stat;
  try {
    stat = fs.fstatSync(fd);
  } catch {
    fail('INVITE_STDIN_UNAVAILABLE', 'Invitation input is unavailable.');
  }
  if (stat.isCharacterDevice() || stat.isDirectory() ||
      (!stat.isFile() && !stat.isFIFO() && !stat.isSocket())) {
    fail(
      'INVITE_STDIN_TTY',
      'Refusing to read an invitation from an interactive terminal; use --invite-file or pipe protected JSON.',
    );
  }
  if (stat.isFile()) {
    const uid = currentUid();
    if ((uid !== null && stat.uid !== uid) ||
        (stat.mode & 0o077) !== 0 ||
        (stat.mode & 0o400) === 0 ||
        stat.nlink !== 1) {
      fail('UNSAFE_INVITE_STDIN', 'Unsafe invitation input.');
    }
    if (stat.size > maxBytes) {
      fail('INVITE_TOO_LARGE', 'Invitation input is too large.');
    }
  }

  const chunks = [];
  let total = 0;
  const scratch = Buffer.alloc(4096);
  while (total <= maxBytes) {
    let read;
    try {
      read = fs.readSync(fd, scratch, 0, scratch.length, null);
    } catch {
      fail('INVITE_STDIN_UNAVAILABLE', 'Invitation input is unavailable.');
    }
    if (read <= 0) {
      break;
    }
    total += read;
    if (total > maxBytes) {
      fail('INVITE_TOO_LARGE', 'Invitation input is too large.');
    }
    chunks.push(Buffer.from(scratch.subarray(0, read)));
  }

  if (total === 0) {
    fail('INVALID_ENVELOPE', 'Invalid invitation envelope.');
  }
  return Buffer.concat(chunks, total);
}

function readKeyFile(keyFile, configDir) {
  if (typeof keyFile !== 'string' || keyFile.length === 0 ||
      keyFile.length > MAX_PATH_LENGTH || !path.isAbsolute(keyFile) ||
      keyFile.includes('\u0000')) {
    fail('UNSAFE_KEY_FILE', 'Unsafe context key file.');
  }

  let realConfig;
  let realKey;
  try {
    realConfig = fs.realpathSync(configDir);
    realKey = fs.realpathSync(keyFile);
  } catch {
    fail('UNSAFE_KEY_FILE', 'Unsafe context key file.');
  }
  if (isPathInside(realConfig, realKey)) {
    fail(
      'KEY_FILE_INSIDE_CONFIG',
      'The context key file must be outside the configuration directory.',
    );
  }

  const key = readExactFile(keyFile, {
    maxBytes: KEY_BYTES,
    minBytes: KEY_BYTES,
    unsafeCode: 'UNSAFE_KEY_FILE',
    unsafeMessage: 'Unsafe context key file.',
    sizeCode: 'UNSAFE_KEY_FILE',
    sizeMessage: 'The context key file must contain exactly 32 bytes.',
    requireLinkCount: true,
  });
  if (key.length !== KEY_BYTES) {
    fail('UNSAFE_KEY_FILE', 'The context key file must contain exactly 32 bytes.');
  }
  return key;
}

function writeExclusivePrivate(filePath, data) {
  let fd;
  let failed = false;
  try {
    fd = fs.openSync(
      filePath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      fail('FILE_EXISTS', 'Private file already exists.');
    }
    fail('STORE_ERROR', 'Unable to write the context store.');
  }

  try {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    let offset = 0;
    while (offset < buffer.length) {
      let written;
      try {
        written = fs.writeSync(fd, buffer, offset, buffer.length - offset);
      } catch {
        fail('STORE_ERROR', 'Unable to write the context store.');
      }
      if (written <= 0) {
        fail('STORE_ERROR', 'Unable to write the context store.');
      }
      offset += written;
    }
    try {
      fs.fsyncSync(fd);
    } catch {
      fail('STORE_ERROR', 'Unable to write the context store.');
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // The caller observes a failed write through the error above.
    }
    if (failed) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Best effort cleanup of an incomplete private file.
      }
    }
  }
}

function fsyncDirectory(directory) {
  let fd;
  try {
    fd = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(fd);
  } catch {
    // Directory fsync is best effort on platforms that reject it.
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Best effort only.
      }
    }
  }
}

function decodeBase64(value, expectedLength, code, message) {
  if (typeof value !== 'string' || value.length === 0 ||
      value.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    fail(code, message);
  }
  const buffer = Buffer.from(value, 'base64');
  if (buffer.toString('base64') !== value ||
      (expectedLength !== undefined && buffer.length !== expectedLength)) {
    fail(code, message);
  }
  return buffer;
}

function contextAad(name) {
  return Buffer.from(`alpi-context\u0000${STORE_VERSION}\u0000${name}`, 'utf8');
}

function encryptContext(name, record, key) {
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(contextAad(name));
  const plaintext = Buffer.from(JSON.stringify(record), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    format: STORE_FORMAT,
    version: STORE_VERSION,
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: tag.toString('base64'),
  };
}

function decryptContext(name, document, key) {
  if (!hasExactKeys(document, RECORD_KEYS) ||
      document.format !== STORE_FORMAT ||
      document.version !== STORE_VERSION) {
    fail('CONTEXT_CORRUPT', 'Context record is invalid.');
  }

  const nonce = decodeBase64(
    document.nonce,
    NONCE_BYTES,
    'CONTEXT_CORRUPT',
    'Context record is invalid.',
  );
  const tag = decodeBase64(
    document.tag,
    TAG_BYTES,
    'CONTEXT_CORRUPT',
    'Context record is invalid.',
  );
  const ciphertext = decodeBase64(
    document.ciphertext,
    undefined,
    'CONTEXT_CORRUPT',
    'Context record is invalid.',
  );
  if (ciphertext.length === 0 || ciphertext.length > MAX_CONTEXT_FILE_BYTES) {
    fail('CONTEXT_CORRUPT', 'Context record is invalid.');
  }

  let plaintext;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(contextAad(name));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
  } catch {
    fail('CONTEXT_DECRYPT_FAILED', 'Context could not be decrypted.');
  }

  let record;
  try {
    record = JSON.parse(plaintext.toString('utf8'));
  } catch {
    fail('CONTEXT_DECRYPT_FAILED', 'Context could not be decrypted.');
  }
  return validateContextRecord(record, name);
}

function parseReservation(buffer, name) {
  let document;
  try {
    document = JSON.parse(buffer.toString('utf8'));
  } catch {
    fail('RESERVATION_CORRUPT', 'Pairing reservation is unreadable.');
  }
  if (!hasExactKeys(document, ['version', 'name', 'id', 'pid', 'createdAt']) ||
      document.version !== STORE_VERSION ||
      document.name !== name ||
      typeof document.id !== 'string' ||
      !/^[0-9a-f]{32}$/.test(document.id) ||
      !Number.isSafeInteger(document.pid) ||
      document.pid <= 0 ||
      !Number.isSafeInteger(document.createdAt) ||
      document.createdAt < 0) {
    fail('RESERVATION_CORRUPT', 'Pairing reservation is unreadable.');
  }
  return document;
}

class ContextStore {
  #key;

  constructor(configDir, key) {
    this.configDir = configDir;
    this.contextsDir = path.join(configDir, 'contexts');
    this.reservationsDir = path.join(configDir, 'reservations');
    this.#key = key;
    this.closed = false;
  }

  _ensureOpen() {
    if (this.closed) {
      fail('STORE_CLOSED', 'Context store is closed.');
    }
  }

  contextPath(name) {
    return path.join(this.contextsDir, `${validateContextName(name)}.ctx`);
  }

  reservationPath(name) {
    return path.join(this.reservationsDir, `${validateContextName(name)}.reservation`);
  }

  get(name) {
    this._ensureOpen();
    const target = this.contextPath(name);
    let stat;
    try {
      stat = fs.lstatSync(target);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return null;
      }
      fail('STORE_ERROR', 'Unable to read the context store.');
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      fail('UNSAFE_CONTEXT_FILE', 'Unsafe context file.');
    }

    const raw = readExactFile(target, {
      maxBytes: MAX_CONTEXT_FILE_BYTES,
      unsafeCode: 'UNSAFE_CONTEXT_FILE',
      unsafeMessage: 'Unsafe context file.',
      sizeCode: 'CONTEXT_CORRUPT',
      sizeMessage: 'Context record is invalid.',
    });

    let document;
    try {
      document = JSON.parse(raw.toString('utf8'));
    } catch {
      fail('CONTEXT_CORRUPT', 'Context record is invalid.');
    }
    return decryptContext(name, document, this.#key);
  }

  reserve(name) {
    this._ensureOpen();
    validateContextName(name);

    const contextPath = this.contextPath(name);
    try {
      fs.lstatSync(contextPath);
      fail('CONTEXT_EXISTS', 'A context with that name already exists.');
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        throw error;
      }
    }

    const reservationPath = this.reservationPath(name);
    const id = crypto.randomBytes(16).toString('hex');
    const document = {
      version: STORE_VERSION,
      name,
      id,
      pid: process.pid,
      createdAt: Date.now(),
    };

    try {
      writeExclusivePrivate(reservationPath, `${JSON.stringify(document)}\n`);
    } catch (error) {
      if (error instanceof ContextError && error.code === 'FILE_EXISTS') {
        fail(
          'RESERVATION_EXISTS',
          `A pairing reservation already exists at ${reservationPath}. ` +
            'If no alpi process is pairing, remove it and retry with a fresh invitation.',
          { reservationPath },
        );
      }
      throw error;
    }
    fsyncDirectory(this.reservationsDir);
    return { id, path: reservationPath };
  }

  getReservation(name) {
    this._ensureOpen();
    validateContextName(name);
    const reservationPath = this.reservationPath(name);
    let stat;
    try {
      stat = fs.lstatSync(reservationPath);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return null;
      }
      fail('STORE_ERROR', 'Unable to read the pairing reservation.');
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      fail('UNSAFE_RESERVATION_FILE', 'Unsafe pairing reservation.');
    }

    const raw = readExactFile(reservationPath, {
      maxBytes: 4096,
      unsafeCode: 'UNSAFE_RESERVATION_FILE',
      unsafeMessage: 'Unsafe pairing reservation.',
      sizeCode: 'RESERVATION_CORRUPT',
      sizeMessage: 'Pairing reservation is unreadable.',
      requireLinkCount: true,
    });
    const reservation = parseReservation(raw, name);
    reservation.path = reservationPath;
    return reservation;
  }

  releaseReservation(name, reservationId) {
    this._ensureOpen();
    validateContextName(name);
    if (typeof reservationId !== 'string' ||
        !/^[0-9a-f]{32}$/.test(reservationId)) {
      fail('RESERVATION_MISMATCH', 'Pairing reservation does not match.');
    }

    const reservation = this.getReservation(name);
    if (!reservation) {
      return false;
    }
    if (reservation.id !== reservationId) {
      fail('RESERVATION_MISMATCH', 'Pairing reservation does not match.');
    }

    try {
      fs.unlinkSync(this.reservationPath(name));
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return false;
      }
      fail('STORE_ERROR', 'Unable to release the pairing reservation.');
    }
    fsyncDirectory(this.reservationsDir);
    return true;
  }

  publish(name, record, reservationId) {
    this._ensureOpen();
    validateContextName(name);
    const normalized = validateContextRecord(record, name);

    const reservation = this.getReservation(name);
    if (!reservation || reservation.id !== reservationId) {
      fail('RESERVATION_MISMATCH', 'Pairing reservation does not match.');
    }

    const target = this.contextPath(name);
    const encrypted = encryptContext(name, normalized, this.#key);
    const data = `${JSON.stringify(encrypted)}\n`;
    if (Buffer.byteLength(data, 'utf8') > MAX_CONTEXT_FILE_BYTES) {
      fail('STORE_ERROR', 'Context record is too large.');
    }

    const tempPath = path.join(
      this.contextsDir,
      `.tmp-${crypto.randomBytes(16).toString('hex')}`,
    );
    writeExclusivePrivate(tempPath, data);
    try {
      try {
        fs.linkSync(tempPath, target);
      } catch (error) {
        if (error && error.code === 'EEXIST') {
          fail('CONTEXT_EXISTS', 'A context with that name already exists.');
        }
        fail('STORE_ERROR', 'Unable to publish the context.');
      }
      fsyncDirectory(this.contextsDir);
    } finally {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // A crash after link leaves a stale temp link; it is harmless and the
        // published context remains readable.
      }
    }
    return target;
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (Buffer.isBuffer(this.#key)) {
      this.#key.fill(0);
    }
  }
}

function openStore(options = {}) {
  const env = options.env || process.env;
  const configDir = options.configDir || resolveConfigDir(options);
  if (typeof configDir !== 'string' || configDir.length === 0 ||
      configDir.length > MAX_PATH_LENGTH ||
      configDir.includes('\u0000') || !path.isAbsolute(configDir)) {
    fail('INVALID_CONFIG_DIR', 'Invalid configuration directory.');
  }

  ensurePrivateDirectory(configDir);
  const contextsDir = ensurePrivateDirectory(path.join(configDir, 'contexts'));
  const reservationsDir = ensurePrivateDirectory(path.join(configDir, 'reservations'));

  const keyFile = options.keyFile !== undefined
    ? options.keyFile
    : env.ALPI_CONTEXT_KEY_FILE;
  if (typeof keyFile !== 'string' || keyFile.length === 0) {
    fail(
      'KEY_FILE_REQUIRED',
      'ALPI_CONTEXT_KEY_FILE must name a separate owner-only 32-byte key file.',
    );
  }

  const key = readKeyFile(keyFile, configDir);
  const store = new ContextStore(configDir, key);
  store.contextsDir = contextsDir;
  store.reservationsDir = reservationsDir;
  return store;
}

module.exports = {
  ContextError,
  MAX_CONTEXT_FILE_BYTES,
  MAX_INVITE_BYTES,
  ROLES,
  STORE_VERSION,
  ContextStore,
  decryptContext,
  encryptContext,
  normalizeClientId,
  normalizeFingerprint,
  normalizeServerId,
  openStore,
  parseInviteEnvelope,
  readInviteFile,
  readProtectedStdin,
  resolveConfigDir,
  validateClientName,
  validateContextName,
  validateContextRecord,
  validateCredentialExpiresAt,
  validateInviteEnvelope,
  validateOrigin,
  validateProject,
  validateRole,
  validateToken,
};
