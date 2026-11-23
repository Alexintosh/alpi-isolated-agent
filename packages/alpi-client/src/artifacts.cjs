'use strict';

// Client-side staging and retrieval for project artifacts.
//
// The caller injects a project-scoped API object. This module never sees a
// host filesystem path from the network and never passes a path to the server:
// it only exchanges opaque artifact IDs, offsets and base64 chunks.
//
// Local file access is restricted to explicitly selected allowed roots. Tree
// staging reuses the canonical file-stream.py helper (scan/send) into a
// temporary private spool, hashing the exact serialized record stream. Download
// fetches the same stream into a private spool, verifies every chunk and the
// whole-stream digest, then hands the bytes to file-stream.py receive/commit.
// Files are never executed.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { resourceRequest } = require('./shared/resource-routes.cjs');

const MAX_CHUNK_BYTES = 32 * 1024;
const MAX_BYTES = 1024 * 1024 * 1024;
const MAX_ENTRIES = 20000;
const MAX_DEPTH = 64;
const MAX_LINE = 70 * 1024;
const MAX_DATA_BYTES = 48 * 1024;
const MAX_PATH_LENGTH = 4096;
const DEFAULT_HELPER_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_HELPER_STDERR = 4096;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

class ArtifactClientError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ArtifactClientError';
    this.code = code;
    if (details.cleanupPending !== undefined) {
      this.cleanupPending = details.cleanupPending;
    }
  }
}

function clientFail(code, message, details) {
  throw new ArtifactClientError(code, message, details);
}

function comparable(value) {
  return process.platform === 'darwin'
    ? value.normalize('NFC').toLowerCase()
    : value;
}

function isInside(target, root) {
  const left = comparable(target);
  const right = comparable(root);
  return left === right || left.startsWith(right + path.sep);
}

function hasControlCharacters(value) {
  return /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value);
}

function nameOk(value) {
  return (
    typeof value === 'string' &&
    value !== '' &&
    value !== '.' &&
    value !== '..' &&
    Buffer.byteLength(value) <= 255 &&
    !/[\u0000-\u001f\u007f/\\]/.test(value)
  );
}

function normalizeUuid(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    clientFail('invalid_input', 'Invalid artifact or request identifier.');
  }
  return value.toLowerCase();
}

function normalizeDigest(value) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    clientFail('protocol_error', 'Invalid artifact digest.');
  }
  return value;
}

function decodeBase64(value, maximum) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > Math.ceil(maximum / 3) * 4 ||
    value.length % 4 !== 0 ||
    !BASE64_PATTERN.test(value)
  ) {
    clientFail('protocol_error', 'Invalid artifact chunk encoding.');
  }
  const buffer = Buffer.from(value, 'base64');
  if (
    buffer.length === 0 ||
    buffer.length > maximum ||
    buffer.toString('base64') !== value
  ) {
    clientFail('protocol_error', 'Invalid artifact chunk encoding.');
  }
  return buffer;
}

function digestOf(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function assertExactKeys(record, keys) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    clientFail('protocol_error', 'Invalid transfer record.');
  }
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    clientFail('protocol_error', 'Invalid transfer record.');
  }
}

// Validates the canonical file-stream.py record stream as it is staged or
// fetched. It is deliberately independent of the helper's own checks: both
// sides must agree before bytes are accepted or published.
class StreamParser {
  constructor({ maxBytes = MAX_BYTES, maxEntries = MAX_ENTRIES } = {}) {
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
    this.begun = false;
    this.finished = false;
    this.current = null;
    this.entries = 0;
    this.bytes = 0;
  }

  feed(line) {
    if (this.finished) {
      clientFail('protocol_error', 'Trailing transfer data.');
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      clientFail('protocol_error', 'Invalid transfer record.');
    }
    if (!this.begun) {
      assertExactKeys(record, ['type', 'version']);
      if (record.type !== 'begin' || record.version !== 1) {
        clientFail('protocol_error', 'Unsupported transfer protocol.');
      }
      this.begun = true;
      return;
    }

    if (this.current) {
      if (record.type === 'data') {
        assertExactKeys(record, ['type', 'value']);
        const chunk = decodeBase64(record.value, MAX_DATA_BYTES);
        if (this.current.written + chunk.length > this.current.size) {
          clientFail('protocol_error', 'Invalid transfer chunk size.');
        }
        this.current.written += chunk.length;
        this.current.hash.update(chunk);
        return;
      }
      if (record.type === 'end-file') {
        assertExactKeys(record, ['type', 'sha256']);
        if (
          this.current.written !== this.current.size ||
          record.sha256 !== this.current.hash.digest('hex')
        ) {
          clientFail('protocol_error', 'File integrity check failed.');
        }
        this.current = null;
        return;
      }
      clientFail('protocol_error', 'Unexpected record inside file.');
    }

    if (record.type === 'directory') {
      assertExactKeys(record, ['type', 'path']);
      this._path(record.path);
      this._entry();
      return;
    }
    if (record.type === 'file') {
      assertExactKeys(record, ['type', 'path', 'size', 'executable']);
      this._path(record.path);
      if (
        !Number.isSafeInteger(record.size) ||
        record.size < 0 ||
        record.size > this.maxBytes ||
        typeof record.executable !== 'boolean'
      ) {
        clientFail('protocol_error', 'Invalid file entry.');
      }
      this._entry();
      this.bytes += record.size;
      if (this.bytes > this.maxBytes) {
        clientFail('size_limit', 'Transfer exceeds the local size limit.');
      }
      this.current = {
        size: record.size,
        written: 0,
        hash: crypto.createHash('sha256'),
      };
      return;
    }
    if (record.type === 'finish') {
      assertExactKeys(record, ['type', 'entries', 'bytes']);
      if (
        !Number.isSafeInteger(record.entries) ||
        record.entries !== this.entries ||
        record.entries < 1 ||
        !Number.isSafeInteger(record.bytes) ||
        record.bytes !== this.bytes
      ) {
        clientFail('protocol_error', 'Transfer totals differ.');
      }
      this.finished = true;
      return;
    }
    clientFail('protocol_error', 'Invalid transfer record.');
  }

  _path(value) {
    if (
      !Array.isArray(value) ||
      value.length < 1 ||
      value.length > MAX_DEPTH ||
      !value.every(nameOk)
    ) {
      clientFail('protocol_error', 'Invalid entry path.');
    }
  }

  _entry() {
    this.entries += 1;
    if (this.entries > this.maxEntries) {
      clientFail('size_limit', 'Transfer exceeds the local entry limit.');
    }
  }

  end() {
    if (!this.begun || !this.finished || this.current) {
      clientFail('protocol_error', 'The transfer is incomplete.');
    }
    return { entries: this.entries, bytes: this.bytes };
  }
}

function validateSummary(value, limits) {
  assertExactKeys(value, ['type', 'entries', 'bytes']);
  if (
    value.type !== 'summary' ||
    !Number.isSafeInteger(value.entries) ||
    value.entries < 1 ||
    value.entries > limits.maxEntries ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0 ||
    value.bytes > limits.maxBytes
  ) {
    clientFail('protocol_error', 'Invalid source summary.');
  }
  return { entries: value.entries, bytes: value.bytes };
}

function validateReceipt(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    clientFail('protocol_error', 'Invalid artifact receipt.');
  }
  const artifactId = normalizeUuid(value.artifactId);
  if (
    value.totalLength !== expected.totalLength ||
    value.sha256 !== expected.sha256 ||
    !Number.isSafeInteger(value.receivedBytes) ||
    value.receivedBytes < 0 ||
    value.receivedBytes > expected.totalLength ||
    !['uploading', 'published'].includes(value.state)
  ) {
    clientFail('protocol_error', 'Artifact receipt does not match the upload.');
  }
  return { ...value, artifactId };
}

function validatePublished(value, expected) {
  const receipt = validateReceipt(value, expected);
  if (receipt.state !== 'published' || receipt.receivedBytes !== expected.totalLength) {
    clientFail('protocol_error', 'Artifact was not published.');
  }
  return receipt;
}

function validateJobOutputReceipt(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    clientFail('protocol_error', 'Invalid job output receipt.');
  }
  const artifactId = normalizeUuid(value.artifactId);
  if (
    normalizeUuid(value.jobId) !== expected.jobId ||
    value.label !== expected.label ||
    value.totalLength !== expected.totalLength ||
    value.sha256 !== expected.sha256 ||
    !Number.isSafeInteger(value.recordedAt) ||
    value.recordedAt < 0
  ) {
    clientFail('protocol_error', 'Job output receipt does not match the registration.');
  }
  return { ...value, artifactId, jobId: expected.jobId };
}

function resolveExecutable(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    clientFail('invalid_input', `Invalid ${label} path.`);
  }
  let real;
  try {
    real = fs.realpathSync(value);
  } catch {
    clientFail('invalid_input', `${label} is not available.`);
  }
  const info = fs.lstatSync(real);
  if (!info.isFile() || info.isSymbolicLink()) {
    clientFail('invalid_input', `${label} is not a regular file.`);
  }
  return real;
}

function resolvePython(value) {
  const real = resolveExecutable(value, 'Python executable');
  const info = fs.statSync(real);
  if ((info.mode & 0o111) === 0) {
    clientFail('invalid_input', 'Python executable is not executable.');
  }
  return real;
}

function resolveHelper(value) {
  const real = resolveExecutable(value, 'File transfer helper');
  const info = fs.statSync(real);
  if (info.size === 0 || info.size > 1024 * 1024) {
    clientFail('invalid_input', 'File transfer helper has an invalid size.');
  }
  return real;
}

function defaultPython() {
  return process.platform === 'darwin'
    ? '/opt/homebrew/bin/python3'
    : '/usr/bin/python3';
}

function defaultHelper() {
  return path.join(__dirname, 'shared', 'file-stream.py');
}

function createPrivateSpool(parent) {
  const resolvedParent = path.resolve(parent);
  let directory;
  try {
    directory = fs.mkdtempSync(path.join(resolvedParent, 'alpi-artifacts-'));
  } catch {
    clientFail('spool_unavailable', 'Unable to create a private staging directory.');
  }
  try {
    fs.chmodSync(directory, 0o700);
    const info = fs.lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
      throw new Error('unsafe');
    }
    if (
      typeof process.geteuid === 'function' &&
      info.uid !== process.geteuid()
    ) {
      throw new Error('unsafe');
    }
  } catch {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch {
      // The directory was just created by us; best-effort cleanup.
    }
    clientFail('spool_unavailable', 'Unable to create a private staging directory.');
  }
  return directory;
}

function cleanupSpool(directory) {
  if (typeof directory !== 'string') {
    return;
  }
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch {
    // Best effort: the spool is private and disposable.
  }
}

class ArtifactsClient {
  constructor(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      clientFail('invalid_input', 'Invalid client options.');
    }
    const api = options.api;
    if (!api || typeof api !== 'object') {
      clientFail('invalid_input', 'An artifact API is required.');
    }
    for (const method of [
      'beginUpload',
      'appendChunk',
      'finishUpload',
      'getArtifact',
      'readChunk',
      'acknowledge',
    ]) {
      if (typeof api[method] !== 'function') {
        clientFail('invalid_input', `Artifact API is missing ${method}.`);
      }
    }
    this._api = api;

    if (!Array.isArray(options.allowedRoots) || options.allowedRoots.length === 0) {
      clientFail('invalid_input', 'At least one allowed root is required.');
    }
    this._roots = options.allowedRoots.map((root) => {
      if (typeof root !== 'string' || !path.isAbsolute(root)) {
        clientFail('invalid_input', 'Allowed roots must be absolute paths.');
      }
      let real;
      try {
        real = fs.realpathSync(root);
      } catch {
        clientFail('invalid_input', 'Allowed root is not available.');
      }
      const info = fs.lstatSync(real);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        clientFail('invalid_input', 'Allowed root must be a directory.');
      }
      return real;
    });

    this._python = resolvePython(
      options.python || process.env.ALPI_PYTHON || defaultPython()
    );
    this._helper = resolveHelper(
      options.helper ||
        process.env.ALPI_FILE_STREAM_HELPER ||
        defaultHelper()
    );

    this._spoolParent = path.resolve(options.spoolParent || os.tmpdir());
    this._chunkBytes = options.chunkBytes === undefined
      ? MAX_CHUNK_BYTES
      : options.chunkBytes;
    if (
      !Number.isSafeInteger(this._chunkBytes) ||
      this._chunkBytes < 1 ||
      this._chunkBytes > MAX_CHUNK_BYTES
    ) {
      clientFail('invalid_input', 'Invalid chunk size.');
    }
    this._maxArtifactBytes = options.maxArtifactBytes === undefined
      ? MAX_BYTES
      : options.maxArtifactBytes;
    this._maxDownloadBytes = options.maxDownloadBytes === undefined
      ? MAX_BYTES
      : options.maxDownloadBytes;
    this._maxEntries = options.maxEntries === undefined
      ? MAX_ENTRIES
      : options.maxEntries;
    if (
      !Number.isSafeInteger(this._maxArtifactBytes) ||
      this._maxArtifactBytes < 1 ||
      !Number.isSafeInteger(this._maxDownloadBytes) ||
      this._maxDownloadBytes < 1 ||
      !Number.isSafeInteger(this._maxEntries) ||
      this._maxEntries < 1
    ) {
      clientFail('invalid_input', 'Invalid client limits.');
    }
    this._helperTimeoutMs = options.helperTimeoutMs === undefined
      ? DEFAULT_HELPER_TIMEOUT_MS
      : options.helperTimeoutMs;
    if (
      !Number.isSafeInteger(this._helperTimeoutMs) ||
      this._helperTimeoutMs < 1
    ) {
      clientFail('invalid_input', 'Invalid helper timeout.');
    }

    this._env = {
      PATH: `${path.dirname(this._python)}:/usr/bin:/bin:/usr/local/bin`,
      LANG: 'C',
      LC_ALL: 'C',
    };
  }

  _resolveSource(source) {
    if (
      typeof source !== 'string' ||
      !path.isAbsolute(source) ||
      source.length > MAX_PATH_LENGTH ||
      hasControlCharacters(source)
    ) {
      clientFail('invalid_path', 'Choose an absolute source path.');
    }
    let original;
    try {
      original = fs.lstatSync(source);
    } catch {
      clientFail('source_invalid', 'The selected source is not available.');
    }
    if (original.isSymbolicLink()) {
      clientFail('symlink_not_allowed', 'Symbolic links are not transferable.');
    }
    let real;
    try {
      real = fs.realpathSync(source);
    } catch {
      clientFail('source_invalid', 'The selected source is not available.');
    }
    const info = fs.lstatSync(real);
    if (
      (!info.isDirectory() && !info.isFile()) ||
      info.isSymbolicLink()
    ) {
      clientFail('source_invalid', 'The selected source is not transferable.');
    }
    if (!this._roots.some((root) => isInside(real, root))) {
      clientFail('path_outside_root', 'The source is outside the allowed roots.');
    }
    return real;
  }

  _resolveDestinationRoot(projectRoot) {
    if (
      typeof projectRoot !== 'string' ||
      !path.isAbsolute(projectRoot) ||
      projectRoot.length > MAX_PATH_LENGTH ||
      hasControlCharacters(projectRoot)
    ) {
      clientFail('invalid_path', 'Choose an absolute project root.');
    }
    let real;
    try {
      real = fs.realpathSync(projectRoot);
    } catch {
      clientFail('invalid_path', 'The project root is not available.');
    }
    const info = fs.lstatSync(real);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      clientFail('invalid_path', 'The project root must be a directory.');
    }
    if (!this._roots.some((root) => isInside(real, root))) {
      clientFail('path_outside_root', 'The project root is outside the allowed roots.');
    }
    return real;
  }

  _destination(projectRoot, name) {
    if (!nameOk(name)) {
      clientFail('invalid_input', 'Invalid destination name.');
    }
    const root = this._resolveDestinationRoot(projectRoot);
    const destination = path.join(root, name);
    if (path.dirname(destination) !== root || !isInside(destination, root)) {
      clientFail('path_outside_root', 'Invalid destination.');
    }
    try {
      fs.lstatSync(destination);
      clientFail('destination_exists', 'The destination already exists.');
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        if (error instanceof ArtifactClientError) {
          throw error;
        }
        clientFail('invalid_path', 'The destination cannot be verified.');
      }
    }
    return destination;
  }

  _streamLimit(summary) {
    // Base64 expansion per helper data record (48 KiB) rounds up independently,
    // so account for both the whole-stream expansion and per-record padding.
    const overhead =
      summary.entries * 512 +
      Math.ceil(summary.bytes / MAX_DATA_BYTES) * 4 +
      8192;
    const maximum =
      Math.ceil(this._maxArtifactBytes / 3) * 4 +
      Math.ceil(this._maxArtifactBytes / MAX_DATA_BYTES) * 4 +
      this._maxEntries * 512 +
      8192;
    const needed = Math.ceil(summary.bytes / 3) * 4 + overhead;
    return Math.min(maximum, needed);
  }

  _spawn(args, { stdinPath, collect, onLine, onChunk, maxStdoutBytes }) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(
          this._python,
          ['-I', '-B', this._helper, ...args],
          {
            stdio: [stdinPath ? 'pipe' : 'ignore', 'pipe', 'pipe'],
            env: this._env,
            shell: false,
            windowsHide: true,
          }
        );
      } catch {
        reject(new ArtifactClientError('helper_failed', 'Local transfer helper failed.'));
        return;
      }

      let settled = false;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let lineBuffer = Buffer.alloc(0);
      const collected = [];
      let collectedBytes = 0;
      let timer = null;
      let inputStream = null;

      const finish = (error, value) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        if (inputStream) {
          inputStream.destroy();
          inputStream = null;
        }
        if (!child.killed) {
          try {
            child.kill('SIGKILL');
          } catch {
            // Ignore kill failures after exit.
          }
        }
        if (error) {
          reject(error);
        } else {
          resolve(value);
        }
      };

      const fail = (code, message) =>
        finish(new ArtifactClientError(code, message));

      child.on('error', () => fail('helper_failed', 'Local transfer helper failed.'));

      child.stderr.on('data', (chunk) => {
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_HELPER_STDERR) {
          // The helper writes at most one fixed line to stderr. Excess output
          // is discarded; the exit status still decides the outcome.
          stderrBytes = MAX_HELPER_STDERR;
        }
      });

      child.stdout.on('data', (chunk) => {
        if (settled) {
          return;
        }
        stdoutBytes += chunk.length;
        if (maxStdoutBytes !== undefined && stdoutBytes > maxStdoutBytes) {
          fail('protocol_error', 'Transfer helper output exceeds the size limit.');
          return;
        }
        try {
          if (onChunk) {
            onChunk(chunk);
          }
        } catch (error) {
          finish(error);
          return;
        }
        if (collect) {
          collectedBytes += chunk.length;
          collected.push(chunk);
          return;
        }
        lineBuffer = Buffer.concat([lineBuffer, chunk]);
        let index;
        while ((index = lineBuffer.indexOf(0x0a)) !== -1) {
          if (index > MAX_LINE) {
            fail('protocol_error', 'Transfer record exceeds the line limit.');
            return;
          }
          const line = lineBuffer.subarray(0, index).toString('utf8');
          lineBuffer = lineBuffer.subarray(index + 1);
          try {
            if (onLine) {
              onLine(line);
            }
          } catch (error) {
            finish(error);
            return;
          }
        }
        if (lineBuffer.length > MAX_LINE) {
          fail('protocol_error', 'Transfer record exceeds the line limit.');
        }
      });

      child.on('close', (code) => {
        if (settled) {
          return;
        }
        if (code !== 0) {
          fail('helper_failed', 'Local transfer helper failed.');
          return;
        }
        if (collect) {
          finish(null, Buffer.concat(collected, collectedBytes));
          return;
        }
        if (lineBuffer.length !== 0) {
          fail('protocol_error', 'The transfer is incomplete.');
          return;
        }
        finish(null, null);
      });

      if (stdinPath) {
        inputStream = fs.createReadStream(stdinPath);
        inputStream.on('error', () => fail('spool_unavailable', 'Unable to read the staging stream.'));
        inputStream.pipe(child.stdin);
        child.stdin.on('error', () => {
          // EPIPE is expected when the helper rejects input early; the exit
          // status is authoritative.
        });
      }

      timer = setTimeout(() => {
        fail('helper_timeout', 'Local transfer helper timed out.');
      }, this._helperTimeoutMs);
    });
  }

  async _scan(source) {
    const output = await this._spawn(['scan', source], {
      collect: true,
      maxStdoutBytes: 4096,
    });
    let summary;
    try {
      summary = JSON.parse(output.toString('utf8'));
    } catch {
      clientFail('protocol_error', 'Invalid source summary.');
    }
    return validateSummary(summary, {
      maxEntries: this._maxEntries,
      maxBytes: this._maxArtifactBytes,
    });
  }

  // Stage a selected source tree into a private spool. Returns the spool path
  // and the digest/length of the exact serialized transfer stream. Callers must
  // call cleanupStaged() when they no longer need the spool.
  async stageTree({ source } = {}) {
    const resolvedSource = this._resolveSource(source);
    const summary = await this._scan(resolvedSource);
    const spoolDir = createPrivateSpool(this._spoolParent);
    const spoolPath = path.join(spoolDir, 'stream');
    let fd;
    try {
      fd = fs.openSync(spoolPath, 'wx', 0o600);
    } catch {
      cleanupSpool(spoolDir);
      clientFail('spool_unavailable', 'Unable to create a private staging stream.');
    }

    const parser = new StreamParser({
      maxBytes: this._maxArtifactBytes,
      maxEntries: this._maxEntries,
    });
    const hash = crypto.createHash('sha256');
    let length = 0;
    const limit = this._streamLimit(summary);

    try {
      await this._spawn(['send', resolvedSource], {
        maxStdoutBytes: limit,
        onChunk: (chunk) => {
          length += chunk.length;
          if (length > limit) {
            clientFail('size_limit', 'Transfer stream exceeds the size limit.');
          }
          hash.update(chunk);
          let written = 0;
          while (written < chunk.length) {
            written += fs.writeSync(fd, chunk, written, chunk.length - written);
          }
        },
        onLine: (line) => parser.feed(line),
      });
      const totals = parser.end();
      if (
        totals.entries !== summary.entries ||
        totals.bytes !== summary.bytes
      ) {
        clientFail('protocol_error', 'The source changed during staging.');
      }
      fs.fsyncSync(fd);
      return {
        source: resolvedSource,
        spoolDir,
        spoolPath,
        entries: totals.entries,
        bytes: totals.bytes,
        streamLength: length,
        sha256: hash.digest('hex'),
      };
    } catch (error) {
      cleanupSpool(spoolDir);
      if (error instanceof ArtifactClientError) {
        throw error;
      }
      throw new ArtifactClientError(
        'staging_failed',
        'The selected source could not be staged.'
      );
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // Ignore close failures after staging.
        }
      }
    }
  }

  cleanupStaged(staged) {
    if (staged && typeof staged.spoolDir === 'string') {
      cleanupSpool(staged.spoolDir);
    }
  }

  // Register a completed job patch through the packaged API. The server
  // stores the bytes in the durable artifact store under its own artifact id
  // and records the digest on the job; the returned receipt is what a
  // consumer later verifies against the fetched bytes.
  async uploadJobPatch({ jobId, label, data, requestId } = {}) {
    for (const method of ['registerJobOutput', 'getJobArtifacts']) {
      if (typeof this._api[method] !== 'function') {
        clientFail('invalid_input', `Job output API is missing ${method}.`);
      }
    }
    const job = normalizeUuid(jobId);
    const name = typeof label === 'string' &&
      label.trim().length > 0 &&
      label.length <= 128 &&
      !hasControlCharacters(label)
      ? label
      : clientFail('invalid_input', 'A label of 1-128 characters is required.');
    if (!Buffer.isBuffer(data) || data.length === 0 || data.length > MAX_CHUNK_BYTES) {
      clientFail('invalid_input', 'A patch payload of 1-32768 bytes is required.');
    }
    const id = requestId === undefined ? crypto.randomUUID() : normalizeUuid(requestId);
    const expected = {
      jobId: job,
      label: name,
      totalLength: data.length,
      sha256: digestOf(data),
    };
    const receipt = await this._api.registerJobOutput({
      jobId: job,
      requestId: id,
      label: name,
      totalLength: expected.totalLength,
      sha256: expected.sha256,
      data: data.toString('base64'),
    });
    return validateJobOutputReceipt(receipt, expected);
  }

  // List the output artifact receipts recorded on a job.
  async listJobOutputs({ jobId } = {}) {
    if (typeof this._api.getJobArtifacts !== 'function') {
      clientFail('invalid_input', 'Job output API is missing getJobArtifacts.');
    }
    const result = await this._api.getJobArtifacts({ jobId: normalizeUuid(jobId) });
    if (!result || typeof result !== 'object' || Array.isArray(result) ||
        !Array.isArray(result.artifacts) || result.count !== result.artifacts.length) {
      clientFail('protocol_error', 'Invalid job output list.');
    }
    return result.artifacts.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        clientFail('protocol_error', 'Invalid job output receipt.');
      }
      return {
        jobId: normalizeUuid(entry.jobId),
        artifactId: normalizeUuid(entry.artifactId),
        label: typeof entry.label === 'string' &&
          entry.label.length > 0 &&
          entry.label.length <= 128 &&
          !hasControlCharacters(entry.label)
          ? entry.label
          : clientFail('protocol_error', 'Invalid job output label.'),
        totalLength: entry.totalLength,
        sha256: normalizeDigest(entry.sha256),
        recordedAt: entry.recordedAt,
      };
    });
  }

  // Fetch a stored job patch through the packaged artifact routes and verify
  // it byte for byte against the recorded receipt: every chunk digest and the
  // whole-stream sha256 must match before the bytes are returned.
  async readPatchBytes({ jobId, artifactId, totalLength, sha256 } = {}) {
    const job = normalizeUuid(jobId);
    const id = normalizeUuid(artifactId);
    const expectedDigest = normalizeDigest(sha256);
    if (
      !Number.isSafeInteger(totalLength) ||
      totalLength < 1 ||
      totalLength > MAX_CHUNK_BYTES
    ) {
      clientFail('invalid_input', 'Invalid patch length.');
    }
    const metadata = await this._api.getArtifact({ artifactId: id });
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      clientFail('protocol_error', 'Invalid artifact metadata.');
    }
    if (metadata.state !== 'published' || metadata.totalLength !== totalLength ||
        normalizeDigest(metadata.sha256) !== expectedDigest) {
      clientFail('digest_mismatch', 'Artifact metadata does not match the receipt.');
    }
    const parts = [];
    let cursor = 0;
    while (cursor < totalLength) {
      const chunk = await this._api.readChunk({ artifactId: id, offset: cursor });
      if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) {
        clientFail('protocol_error', 'Invalid artifact chunk.');
      }
      if (
        chunk.artifactId !== undefined &&
        normalizeUuid(chunk.artifactId) !== id
      ) {
        clientFail('protocol_error', 'Artifact chunk identity mismatch.');
      }
      if (
        chunk.offset !== cursor ||
        !Number.isSafeInteger(chunk.length) ||
        chunk.length < 1 ||
        chunk.length > this._chunkBytes ||
        cursor + chunk.length > totalLength
      ) {
        clientFail('protocol_error', 'Artifact chunk offset or size mismatch.');
      }
      const bytes = decodeBase64(chunk.data, this._chunkBytes);
      if (
        bytes.length !== chunk.length ||
        normalizeDigest(chunk.sha256) !== digestOf(bytes)
      ) {
        clientFail('digest_mismatch', 'Artifact chunk digest does not match.');
      }
      parts.push(bytes);
      cursor += bytes.length;
    }
    const data = Buffer.concat(parts, cursor);
    if (cursor !== totalLength || digestOf(data) !== expectedDigest) {
      clientFail('digest_mismatch', 'Artifact digest does not match the receipt.');
    }
    return {
      jobId: job,
      artifactId: id,
      totalLength,
      sha256: expectedDigest,
      data,
    };
  }

  // Upload a staged stream under an idempotent request UUID. Reusing the same
  // requestId and metadata after a lost reply resumes at receivedBytes or
  // returns the already published receipt.
  async uploadTree({ source, requestId, acknowledge = false } = {}) {
    const id = requestId === undefined ? crypto.randomUUID() : normalizeUuid(requestId);
    const staged = await this.stageTree({ source });
    try {
      const expected = {
        totalLength: staged.streamLength,
        sha256: staged.sha256,
      };
      const begun = validateReceipt(
        await this._api.beginUpload({
          requestId: id,
          totalLength: staged.streamLength,
          sha256: staged.sha256,
        }),
        expected
      );

      let receipt = begun;
      if (receipt.state === 'uploading') {
        let offset = receipt.receivedBytes;
        const fd = fs.openSync(staged.spoolPath, 'r');
        try {
          while (offset < staged.streamLength) {
            const length = Math.min(
              this._chunkBytes,
              staged.streamLength - offset
            );
            const buffer = Buffer.alloc(length);
            let read = 0;
            while (read < length) {
              const count = fs.readSync(
                fd,
                buffer,
                read,
                length - read,
                offset + read
              );
              if (count === 0) {
                clientFail('staging_failed', 'The staged stream is incomplete.');
              }
              read += count;
            }
            const appended = validateReceipt(
              await this._api.appendChunk({
                artifactId: receipt.artifactId,
                offset,
                data: buffer.toString('base64'),
              }),
              expected
            );
            if (
              appended.state !== 'uploading' ||
              appended.receivedBytes < offset + length
            ) {
              clientFail('protocol_error', 'Chunk acknowledgement is inconsistent.');
            }
            offset = appended.receivedBytes;
          }
        } finally {
          fs.closeSync(fd);
        }
        receipt = validatePublished(
          await this._api.finishUpload({ artifactId: receipt.artifactId }),
          expected
        );
      } else {
        receipt = validatePublished(receipt, expected);
      }

      if (acknowledge) {
        const acknowledged = await this._api.acknowledge({
          artifactId: receipt.artifactId,
        });
        if (!acknowledged || acknowledged.acknowledgedAt === null) {
          clientFail('protocol_error', 'Artifact acknowledgement failed.');
        }
        receipt = { ...receipt, ...acknowledged };
      }

      return {
        ...receipt,
        entries: staged.entries,
        bytes: staged.bytes,
        streamLength: staged.streamLength,
        requestId: id,
      };
    } finally {
      cleanupSpool(staged.spoolDir);
    }
  }

  // Fetch an artifact into a private spool, verify every chunk and the
  // whole-stream digest, then receive/commit it below an explicit project root.
  // The destination must not exist. Files are written by file-stream.py only.
  async downloadTree({ artifactId, name, projectRoot } = {}) {
    const id = normalizeUuid(artifactId);
    const destination = this._destination(projectRoot, name);
    const metadata = await this._api.getArtifact({ artifactId: id });
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      clientFail('protocol_error', 'Invalid artifact metadata.');
    }
    const totalLength = metadata.totalLength;
    const expectedDigest = normalizeDigest(metadata.sha256);
    if (metadata.state !== 'published') {
      clientFail('artifact_not_ready', 'Artifact is not published.');
    }
    if (
      !Number.isSafeInteger(totalLength) ||
      totalLength < 1 ||
      totalLength > this._maxDownloadBytes ||
      totalLength > this._maxArtifactBytes
    ) {
      clientFail('size_limit', 'Artifact exceeds the local download limit.');
    }

    const spoolDir = createPrivateSpool(this._spoolParent);
    const spoolPath = path.join(spoolDir, 'stream');
    const transaction = crypto.randomBytes(32).toString('hex');
    const parser = new StreamParser({
      maxBytes: this._maxArtifactBytes,
      maxEntries: this._maxEntries,
    });
    const hash = crypto.createHash('sha256');
    let cursor = 0;
    let receiveStarted = false;

    try {
      let fd;
      try {
        fd = fs.openSync(spoolPath, 'wx', 0o600);
      } catch {
        clientFail('spool_unavailable', 'Unable to create a private staging stream.');
      }

      try {
        let pending = Buffer.alloc(0);
        while (cursor < totalLength) {
          const chunk = await this._api.readChunk({
            artifactId: id,
            offset: cursor,
          });
          if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) {
            clientFail('protocol_error', 'Invalid artifact chunk.');
          }
          if (
            chunk.artifactId !== undefined &&
            normalizeUuid(chunk.artifactId) !== id
          ) {
            clientFail('protocol_error', 'Artifact chunk identity mismatch.');
          }
          if (
            chunk.offset !== cursor ||
            !Number.isSafeInteger(chunk.length) ||
            chunk.length < 1 ||
            chunk.length > this._chunkBytes ||
            cursor + chunk.length > totalLength
          ) {
            clientFail('protocol_error', 'Artifact chunk offset or size mismatch.');
          }
          const bytes = decodeBase64(chunk.data, this._chunkBytes);
          if (
            bytes.length !== chunk.length ||
            normalizeDigest(chunk.sha256) !== digestOf(bytes)
          ) {
            clientFail('digest_mismatch', 'Artifact chunk digest does not match.');
          }
          hash.update(bytes);
          let written = 0;
          while (written < bytes.length) {
            written += fs.writeSync(fd, bytes, written, bytes.length - written);
          }
          pending = Buffer.concat([pending, bytes]);
          let index;
          while ((index = pending.indexOf(0x0a)) !== -1) {
            if (index > MAX_LINE) {
              clientFail('protocol_error', 'Transfer record exceeds the line limit.');
            }
            parser.feed(pending.subarray(0, index).toString('utf8'));
            pending = pending.subarray(index + 1);
          }
          if (pending.length > MAX_LINE) {
            clientFail('protocol_error', 'Transfer record exceeds the line limit.');
          }
          cursor += bytes.length;
        }
        if (pending.length !== 0) {
          clientFail('protocol_error', 'The transfer is incomplete.');
        }
        const totals = parser.end();
        if (cursor !== totalLength || hash.digest('hex') !== expectedDigest) {
          clientFail('digest_mismatch', 'Artifact digest does not match.');
        }
        fs.fsyncSync(fd);

        let complete = null;
        let previousBytes = 0;
        let previousEntries = 0;
        let records = 0;
        const maxRecords =
          totals.entries * 2 +
          Math.ceil(totals.bytes / (1024 * 1024)) +
          16;
        receiveStarted = true;
        await this._spawn(
          [
            'receive',
            destination,
            String(totals.entries),
            String(totals.bytes),
            transaction,
          ],
          {
            stdinPath: spoolPath,
            maxStdoutBytes:
              4096 +
              totals.entries * 128 +
              Math.ceil(totals.bytes / (1024 * 1024)) * 128 +
              256,
            onLine: (line) => {
              let record;
              try {
                record = JSON.parse(line);
              } catch {
                clientFail('protocol_error', 'Invalid receive response.');
              }
              records += 1;
              if (records > maxRecords) {
                clientFail('protocol_error', 'Too many receive responses.');
              }
              if (
                !record ||
                typeof record !== 'object' ||
                !['progress', 'complete'].includes(record.type) ||
                !Number.isSafeInteger(record.entries) ||
                record.entries < 0 ||
                record.entries > totals.entries ||
                !Number.isSafeInteger(record.bytes) ||
                record.bytes < 0 ||
                record.bytes > totals.bytes ||
                record.entries < previousEntries ||
                record.bytes < previousBytes
              ) {
                clientFail('protocol_error', 'Invalid receive response.');
              }
              previousEntries = record.entries;
              previousBytes = record.bytes;
              if (record.type === 'complete') {
                if (
                  record.entries !== totals.entries ||
                  record.bytes !== totals.bytes
                ) {
                  clientFail('protocol_error', 'Received totals differ.');
                }
                complete = record;
              }
            },
          }
        );
        if (!complete) {
          clientFail('protocol_error', 'The receive did not complete.');
        }

        const committed = await this._spawn(
          ['commit', destination, transaction],
          { collect: true, maxStdoutBytes: 4096 }
        );
        let commitRecord;
        try {
          commitRecord = JSON.parse(committed.toString('utf8'));
        } catch {
          clientFail('protocol_error', 'Invalid commit response.');
        }
        assertExactKeys(commitRecord, ['type']);
        if (commitRecord.type !== 'committed') {
          clientFail('protocol_error', 'The destination was not committed.');
        }

        return {
          artifactId: id,
          destination,
          entries: totals.entries,
          bytes: totals.bytes,
          streamLength: totalLength,
          sha256: expectedDigest,
          acknowledged: metadata.acknowledgedAt !== null,
        };
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      let cleanupPending = false;
      if (receiveStarted) {
        try {
          const discarded = await this._spawn(
            ['discard', destination, transaction],
            { collect: true, maxStdoutBytes: 4096 }
          );
          let record;
          try {
            record = JSON.parse(discarded.toString('utf8'));
          } catch {
            record = null;
          }
          if (!record || record.type !== 'discarded') {
            cleanupPending = true;
          }
        } catch {
          cleanupPending = true;
        }
      }
      cleanupSpool(spoolDir);
      if (error instanceof ArtifactClientError) {
        if (cleanupPending) {
          error.cleanupPending = true;
        }
        throw error;
      }
      throw new ArtifactClientError(
        'download_failed',
        'The artifact could not be downloaded.',
        { cleanupPending }
      );
    } finally {
      cleanupSpool(spoolDir);
    }
  }

  // Explicit receipt acknowledgement. Downloading alone does not acknowledge.
  async acknowledge({ artifactId } = {}) {
    const id = normalizeUuid(artifactId);
    const receipt = await this._api.acknowledge({ artifactId: id });
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
      clientFail('protocol_error', 'Invalid acknowledgement receipt.');
    }
    if (normalizeUuid(receipt.artifactId) !== id || receipt.acknowledgedAt === null) {
      clientFail('protocol_error', 'Artifact acknowledgement failed.');
    }
    return receipt;
  }
}

// Adapter for the existing bounded JSON transport. Routes are documented for
// daemon integration; the authenticated project is supplied by the server, not
// by these bodies.
function createHttpApi({
  requestJson,
  origin,
  fingerprint,
  credential,
  timeoutMs,
} = {}) {
  if (typeof requestJson !== 'function') {
    clientFail('invalid_input', 'requestJson is required.');
  }
  if (typeof origin !== 'string' || typeof fingerprint !== 'string') {
    clientFail('invalid_input', 'Origin and fingerprint are required.');
  }
  const call = (name, params, body) => {
    const route = resourceRequest(name, params);
    return requestJson({
      origin,
      fingerprint,
      method: route.method,
      path: route.path,
      credential,
      body,
      timeoutMs,
    });
  };

  return {
    beginUpload(input) {
      return call('beginUpload', {}, {
        requestId: normalizeUuid(input.requestId),
        totalLength: input.totalLength,
        sha256: input.sha256,
      });
    },
    appendChunk(input) {
      return call(
        'appendChunk',
        { artifactId: normalizeUuid(input.artifactId) },
        { offset: input.offset, data: input.data }
      );
    },
    finishUpload(input) {
      return call(
        'finishUpload',
        { artifactId: normalizeUuid(input.artifactId) },
        {}
      );
    },
    getArtifact(input) {
      return call(
        'getArtifact',
        { artifactId: normalizeUuid(input.artifactId) },
        undefined
      );
    },
    readChunk(input) {
      const id = normalizeUuid(input.artifactId);
      if (!Number.isSafeInteger(input.offset) || input.offset < 0) {
        clientFail('invalid_input', 'Invalid chunk offset.');
      }
      return call(
        'readChunk',
        { artifactId: id, offset: String(input.offset) },
        undefined
      );
    },
    acknowledge(input) {
      return call(
        'acknowledge',
        { artifactId: normalizeUuid(input.artifactId) },
        {}
      );
    },
    registerJobOutput(input) {
      return call('registerJobOutput', { jobId: normalizeUuid(input.jobId) }, {
        requestId: normalizeUuid(input.requestId),
        totalLength: input.totalLength,
        sha256: input.sha256,
        label: input.label,
        data: input.data,
      });
    },
    getJobArtifacts(input) {
      return call(
        'getJobArtifacts',
        { jobId: normalizeUuid(input.jobId) },
        undefined
      );
    },
  };
}

module.exports = {
  ArtifactsClient,
  ArtifactClientError,
  createHttpApi,
  StreamParser,
  MAX_CHUNK_BYTES,
};
