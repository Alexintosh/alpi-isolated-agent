#!/usr/bin/env node
'use strict';

/**
 * Alpi Pi guest supervisor.
 *
 * THIS FILE RUNS ONLY INSIDE THE GUEST. The host-side adapter in
 * `src/harnesses/pi.cjs` never requires, imports or spawns this file. It only
 * addresses it through the injected guest-only `exec` contract using an
 * operator-configured guest path and checked argv arrays (never a shell).
 *
 * The supervisor owns one stock Pi 1.6 RPC child, one native Pi session UUID,
 * one guest working directory and one private guest Unix socket. It is the
 * resident process. Short-lived CLI subcommands (`status`, `submit`, `events`,
 * `pause`, ...) connect to that socket, send one JSON record and exit. This
 * keeps every host-to-guest call cheap and bounded while retaining the same Pi
 * conversation and process across requests and across host reconnects.
 *
 * Boundaries that belong to other components:
 * - Durable job/workspace state, idempotency receipts, event cursors and writer
 *   leases belong to the STATE journal. This supervisor records only enough
 *   guest-local state to survive its own restart and to report honestly.
 * - The host adapter must persist submission intent before calling `submit`.
 *   This supervisor also persists a pending prompt record before writing to Pi,
 *   but a lost response is reported as `uncertain`; neither layer may retry a
 *   prompt on ambiguity.
 * - Orchestration owns model/provider selection. The supervisor receives an
 *   operator-selected provider/model and never resolves credentials, installs
 *   packages or contacts a model server itself.
 * - All stdout from this process is guest-produced data. The host must treat
 *   responses, events, messages and error strings as untrusted input.
 */

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const PROTOCOL_VERSION = 1;
const STATE_VERSION = 1;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const NAME_PATTERN = /^[A-Za-z0-9._:/+-]{1,128}$/;
const OWNER_PATTERN = /^[A-Za-z0-9._:@/-]{1,64}$/;

const MAX_SOCKET_PATH_BYTES = 100;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_EVENT_BYTES = 256 * 1024;
const MAX_MESSAGE_BYTES = 65_536;
const MAX_CHUNK_BYTES = 4_096;
const MAX_STDERR_TAIL = 4_096;
const MAX_LOG_BYTES = 1_048_576;

const DEFAULT_MAX_EVENTS = 512;
const DEFAULT_SUBMIT_DEADLINE_MS = 15_000;
const DEFAULT_COMMAND_DEADLINE_MS = 10_000;
const DEFAULT_QUIESCE_DEADLINE_MS = 10_000;
const DEFAULT_STOP_DEADLINE_MS = 8_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const MAX_DEADLINE_MS = 300_000;
const TERMINATION_GRACE_MS = 3_000;

const PI_ARGV_FIXED = Object.freeze([
  '--mode',
  'rpc',
  '--no-context-files',
  '--no-approve',
  '--no-extensions',
  '--no-mcp',
]);

class SupervisorError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'SupervisorError';
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

function fail(code, message, details) {
  throw new SupervisorError(code, message, details);
}

function nowIso() {
  return new Date().toISOString();
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

function assertNoControl(value, label) {
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    fail('invalid_input', `${label} contains control characters.`);
  }
}

function assertGuestPath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    fail('invalid_input', `${label} must be a non-empty guest path.`);
  }
  assertNoControl(value, label);
  if (!value.startsWith('/') || value.includes('\\')) {
    fail('invalid_input', `${label} must be an absolute POSIX guest path.`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value && normalized !== value.replace(/\/+$/, '')) {
    fail('invalid_input', `${label} must be a normalized guest path.`);
  }
  if (normalized.split('/').includes('..')) {
    fail('invalid_input', `${label} must not contain '..'.`);
  }
  if (Buffer.byteLength(normalized, 'utf8') > MAX_SOCKET_PATH_BYTES && label === 'Socket path') {
    fail('socket_path_too_long', 'Guest socket path is too long for a Unix socket.');
  }
  return normalized;
}

function assertUuid(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    fail('invalid_input', 'Session id must be a UUID.');
  }
  return value.toLowerCase();
}

function assertInteger(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('invalid_input', `${label} is outside the supported range.`);
  }
  return value;
}

function assertName(value, label) {
  if (typeof value !== 'string' || !NAME_PATTERN.test(value)) {
    fail('invalid_input', `${label} is invalid.`);
  }
  return value;
}

function assertOwner(value) {
  if (typeof value !== 'string' || !OWNER_PATTERN.test(value)) {
    fail('invalid_input', 'Owner label is invalid.');
  }
  return value;
}

function ensureDirectory(directory, { privateMode = false } = {}) {
  let stat = null;
  try {
    stat = fs.lstatSync(directory);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      fail('guest_filesystem_error', 'Guest directory could not be inspected.');
    }
  }
  if (!stat) {
    try {
      fs.mkdirSync(directory, { recursive: true, mode: privateMode ? 0o700 : 0o755 });
    } catch {
      fail('guest_filesystem_error', 'Guest directory could not be created.');
    }
    stat = fs.lstatSync(directory);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail('unsafe_guest_path', 'Guest directory is not a real directory.');
  }
  const uid = currentUid();
  if (uid !== null && stat.uid !== uid && stat.uid !== 0) {
    fail('unsafe_guest_path', 'Guest directory is not owned by the guest user.');
  }
  if (privateMode) {
    if ((stat.mode & 0o077) !== 0) {
      try {
        fs.chmodSync(directory, 0o700);
      } catch {
        fail('unsafe_guest_path', 'Guest private directory could not be secured.');
      }
    }
  }
  return directory;
}

/**
 * Persist a directory entry so that a rename or unlink is durable. Unsupported
 * directory fsync is the only error that may be ignored; anything else means
 * the caller cannot claim the change was committed.
 */
function fsyncDirectory(directory) {
  let fd;
  try {
    fd = fs.openSync(directory, 'r');
    fs.fsyncSync(fd);
  } catch (error) {
    if (error && ['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EBADF'].includes(error.code)) {
      return;
    }
    fail('state_write_failed', 'Guest supervisor directory could not be synced.');
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // The original failure is reported by fsyncDirectory.
      }
    }
  }
}

function writeAtomic(filePath, data) {
  const directory = path.dirname(filePath);
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${crypto.randomBytes(8).toString('hex')}.tmp`
  );
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, data, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, filePath);
    // File contents and the directory entry must both be durable before the
    // caller treats the write as committed.
    fsyncDirectory(directory);
  } catch {
    fail('state_write_failed', 'Guest supervisor state could not be written.');
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // The original failure above is the one that matters.
      }
    }
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // Keep the original failure.
      }
    }
  }
}

/**
 * Remove a file and persist the directory entry. Only ENOENT is tolerable
 * because the desired end state (file absent) already holds.
 */
function unlinkDurable(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      fail('state_write_failed', 'Guest supervisor marker could not be removed.');
    }
    return;
  }
  fsyncDirectory(path.dirname(filePath));
}

/**
 * Linux start time (field 22 of /proc/<pid>/stat). Together with the pid this
 * identifies a process across pid reuse. Other platforms cannot provide it.
 */
function readProcStartTime(pid) {
  if (process.platform !== 'linux') {
    return null;
  }
  let raw;
  try {
    raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  const close = raw.lastIndexOf(')');
  if (close < 0) {
    return null;
  }
  const fields = raw.slice(close + 2).split(' ');
  const startTime = fields[19];
  return typeof startTime === 'string' && /^\d+$/.test(startTime) ? startTime : null;
}

/**
 * Existence probe only. Signal 0 delivers nothing; ESRCH is the one answer
 * that proves the pid is gone, and EPERM still means the process exists.
 */
function processPresent(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error && error.code === 'ESRCH');
  }
}

function normalizeChildRecord(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  if (!['none', 'spawning', 'running', 'exited'].includes(value.state)) {
    return null;
  }
  const pid = value.pid === null || value.pid === undefined
    ? null
    : (Number.isSafeInteger(value.pid) && value.pid > 0 ? value.pid : null);
  const startTime = typeof value.startTime === 'string' && /^\d+$/.test(value.startTime)
    ? value.startTime
    : null;
  return {
    state: value.state,
    pid,
    startTime,
    at: typeof value.at === 'string' ? value.at : null,
    exitCode: Number.isInteger(value.exitCode) ? value.exitCode : null,
    signal: typeof value.signal === 'string' ? value.signal : null,
  };
}

/**
 * Classify a persisted child record without ever signalling a pid. Only
 * 'absent' is proof that exclusive ownership can be released. 'spawning' and
 * pid-only records are treated as unknown and fail closed.
 */
function probeChildPresence(child) {
  if (!child || typeof child !== 'object') {
    return 'unknown';
  }
  if (child.state === 'none' || child.state === 'exited') {
    return 'absent';
  }
  if (child.state !== 'running') {
    return 'unknown';
  }
  const pid = child.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return 'unknown';
  }
  if (process.platform === 'linux' && child.startTime) {
    let present = true;
    try {
      fs.lstatSync(`/proc/${pid}`);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        present = false;
      }
    }
    if (!present) {
      return 'absent';
    }
    const current = readProcStartTime(pid);
    if (current === null) {
      return 'unknown';
    }
    return current === child.startTime ? 'alive' : 'absent';
  }
  // Conservative fallback: a live pid is ambiguous because it may have been
  // reused, and a missing pid is the only independent proof of absence.
  return processPresent(pid) ? 'alive-unverified' : 'absent';
}

function readStateFile(filePath) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return null;
    }
    fail('state_read_failed', 'Guest supervisor state could not be inspected.');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail('state_corrupt', 'Guest supervisor state is not a regular file.');
  }
  const uid = currentUid();
  if (uid !== null && stat.uid !== uid && stat.uid !== 0) {
    fail('state_corrupt', 'Guest supervisor state is not owned by the guest user.');
  }
  if ((stat.mode & 0o077) !== 0) {
    fail('state_corrupt', 'Guest supervisor state is not private.');
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    fail('state_corrupt', 'Guest supervisor state is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('state_corrupt', 'Guest supervisor state has an invalid shape.');
  }
  if (parsed.version !== STATE_VERSION) {
    fail('state_corrupt', 'Guest supervisor state has an unsupported version.');
  }
  return parsed;
}

function truncateText(value, maxBytes) {
  if (typeof value !== 'string') {
    return value;
  }
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes <= maxBytes) {
    return value;
  }
  return Buffer.from(value, 'utf8').subarray(0, maxBytes).toString('utf8');
}

function sanitizeRecord(record) {
  let serialized;
  try {
    serialized = JSON.stringify(record);
  } catch {
    return { type: 'unserializable' };
  }
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes <= MAX_EVENT_BYTES) {
    return record;
  }
  return {
    type: 'truncated',
    originalType: typeof record.type === 'string' ? record.type : null,
    bytes,
  };
}

function sanitizeModel(model) {
  if (!model || typeof model !== 'object' || Array.isArray(model)) {
    return null;
  }
  const result = {};
  for (const key of ['provider', 'id', 'name']) {
    if (typeof model[key] === 'string') {
      result[key] = truncateText(model[key], 256);
    }
  }
  return Object.keys(result).length === 0 ? null : result;
}

function sanitizeState(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    fail('protocol_error', 'Pi returned an invalid get_state payload.');
  }
  const result = {
    sessionId: data.sessionId,
    isStreaming: data.isStreaming === true,
    isCompacting: data.isCompacting === true,
    messageCount: Number.isSafeInteger(data.messageCount) ? data.messageCount : 0,
    pendingMessageCount: Number.isSafeInteger(data.pendingMessageCount)
      ? data.pendingMessageCount
      : 0,
  };
  if (typeof data.sessionFile === 'string') {
    result.sessionFile = truncateText(data.sessionFile, 1024);
  }
  if (typeof data.sessionName === 'string') {
    result.sessionName = truncateText(data.sessionName, 256);
  }
  if (typeof data.thinkingLevel === 'string') {
    result.thinkingLevel = truncateText(data.thinkingLevel, 64);
  }
  if (typeof data.steeringMode === 'string') {
    result.steeringMode = truncateText(data.steeringMode, 64);
  }
  if (typeof data.followUpMode === 'string') {
    result.followUpMode = truncateText(data.followUpMode, 64);
  }
  if (typeof data.autoCompactionEnabled === 'boolean') {
    result.autoCompactionEnabled = data.autoCompactionEnabled;
  }
  const model = sanitizeModel(data.model);
  if (model) {
    result.model = model;
  }
  return result;
}

function parseCli(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    fail('invalid_input', 'A guest supervisor subcommand is required.');
  }
  const command = argv[0];
  if (typeof command !== 'string' || !/^[a-z][a-z0-9-]{1,31}$/.test(command)) {
    fail('invalid_input', 'Invalid guest supervisor subcommand.');
  }
  const flags = Object.create(null);
  const booleanFlags = new Set(['foreground', 'operator', 'abort-active']);
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (typeof argument !== 'string' || !argument.startsWith('--')) {
      fail('invalid_input', 'Guest supervisor arguments must be --name value pairs.');
    }
    const name = argument.slice(2);
    if (booleanFlags.has(name)) {
      if (flags[name] !== undefined) {
        fail('invalid_input', `Duplicate flag: --${name}.`);
      }
      flags[name] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined) {
      fail('invalid_input', `Missing value for --${name}.`);
    }
    index += 1;
    if (typeof value !== 'string') {
      fail('invalid_input', `Invalid value for --${name}.`);
    }
    if (name === 'chunk') {
      (flags.chunk ??= []).push(value);
      continue;
    }
    if (flags[name] !== undefined) {
      fail('invalid_input', `Duplicate flag: --${name}.`);
    }
    flags[name] = value;
  }
  return { command, flags };
}

function requireFlag(flags, name) {
  const value = flags[name];
  if (value === undefined) {
    fail('invalid_input', `--${name} is required.`);
  }
  return value;
}

function parseBooleanFlag(flags, name) {
  const value = flags[name];
  if (value === undefined) {
    return false;
  }
  if (value !== true) {
    fail('invalid_input', `--${name} is a boolean flag.`);
  }
  return true;
}

function allowedFlags(flags, allowed) {
  const known = new Set(allowed);
  for (const key of Object.keys(flags)) {
    if (key === 'chunk' && allowed.includes('chunk')) {
      continue;
    }
    if (!known.has(key)) {
      fail('invalid_input', `Unsupported flag: --${key}.`);
    }
  }
}

function parseDeadline(flags, name, fallback, min, max) {
  if (flags[name] === undefined) {
    return fallback;
  }
  const value = Number(flags[name]);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('invalid_input', `--${name} is outside the supported range.`);
  }
  return value;
}

function joinChunks(chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    fail('invalid_input', 'A message is required.');
  }
  let total = 0;
  const parts = [];
  for (const chunk of chunks) {
    if (typeof chunk !== 'string' || chunk.length === 0) {
      fail('invalid_input', 'Message chunks must be non-empty strings.');
    }
    if (/[\u0000]/.test(chunk)) {
      fail('invalid_input', 'Message chunks must not contain NUL.');
    }
    const bytes = Buffer.byteLength(chunk, 'utf8');
    if (bytes > MAX_CHUNK_BYTES) {
      fail('invalid_input', 'A message chunk is too large.');
    }
    total += bytes;
    parts.push(chunk);
  }
  if (total > MAX_MESSAGE_BYTES) {
    fail('message_too_large', 'The message exceeds the guest argv limit.');
  }
  return parts.join('');
}

function logLine(logPath, message) {
  if (!logPath) {
    return;
  }
  try {
    const stat = fs.lstatSync(logPath);
    if (stat.size > MAX_LOG_BYTES) {
      fs.truncateSync(logPath, 0);
    }
  } catch {
    // The log is diagnostic only.
  }
  try {
    fs.appendFileSync(logPath, `${nowIso()} ${message}\n`, { mode: 0o600 });
  } catch {
    // The log is diagnostic only.
  }
}

/**
 * Create the resident supervisor. All arguments are guest-local and come from
 * the operator profile; none are supplied by an agent or remote caller.
 */
function createSupervisor(config) {
  const socketPath = assertGuestPath(config.socketPath, 'Socket path');
  if (Buffer.byteLength(socketPath, 'utf8') > MAX_SOCKET_PATH_BYTES) {
    fail('socket_path_too_long', 'Guest socket path is too long for a Unix socket.');
  }
  const statePath = assertGuestPath(config.statePath, 'State path');
  const sessionId = assertUuid(config.sessionId);
  const cwd = assertGuestPath(config.cwd, 'Working directory');
  const sessionDir = assertGuestPath(config.sessionDir, 'Session directory');
  const agentDir = assertGuestPath(config.agentDir, 'Agent directory');
  const guestHome = assertGuestPath(config.guestHome, 'Guest home');
  const piExecutable = assertGuestPath(config.piExecutable, 'Pi executable');
  const provider = assertName(config.provider, 'Provider');
  const model = assertName(config.model, 'Model');
  const pathEnv = config.pathEnv;
  if (
    typeof pathEnv !== 'string' ||
    pathEnv.length === 0 ||
    pathEnv.length > 4096 ||
    /[\u0000-\u001f\u007f]/.test(pathEnv)
  ) {
    fail('invalid_input', 'PATH environment value is invalid.');
  }
  const maxEvents = config.maxEvents === undefined
    ? DEFAULT_MAX_EVENTS
    : assertInteger(config.maxEvents, 16, 4096, 'maxEvents');
  const submitDeadlineMs = config.submitDeadlineMs === undefined
    ? DEFAULT_SUBMIT_DEADLINE_MS
    : assertInteger(config.submitDeadlineMs, 100, MAX_DEADLINE_MS, 'submit deadline');
  const commandDeadlineMs = config.commandDeadlineMs === undefined
    ? DEFAULT_COMMAND_DEADLINE_MS
    : assertInteger(config.commandDeadlineMs, 100, MAX_DEADLINE_MS, 'command deadline');
  const quiesceDeadlineMs = config.quiesceDeadlineMs === undefined
    ? DEFAULT_QUIESCE_DEADLINE_MS
    : assertInteger(config.quiesceDeadlineMs, 100, MAX_DEADLINE_MS, 'quiesce deadline');
  const stopDeadlineMs = config.stopDeadlineMs === undefined
    ? DEFAULT_STOP_DEADLINE_MS
    : assertInteger(config.stopDeadlineMs, 100, MAX_DEADLINE_MS, 'stop deadline');
  const logPath = config.logPath === undefined
    ? null
    : assertGuestPath(config.logPath, 'Log path');

  ensureDirectory(cwd);
  ensureDirectory(sessionDir, { privateMode: true });
  ensureDirectory(agentDir, { privateMode: true });
  ensureDirectory(path.dirname(socketPath), { privateMode: true });
  ensureDirectory(path.dirname(statePath), { privateMode: true });

  let state = null;
  let generation = 1;
  let paused = false;
  let pauseOwner = null;
  let status = 'starting';
  let activeTurn = null;
  let pendingPrompt = null;
  let seq = 0;
  let events = [];
  let earliestSeq = 0;
  let lastError = null;
  let piChild = null;
  let piPid = null;
  let piExitCode = null;
  let piSignal = null;
  let piExited = false;
  let stopping = false;
  let stoppingResult = null;
  let server = null;
  let lockPath = null;
  let saveTimer = null;
  let saveDirty = false;
  let stdoutBuffer = Buffer.alloc(0);
  let stderrTail = '';
  let waiters = new Set();
  let protocolErrors = 0;
  let resumed = false;
  const pending = new Map();
  let idCounter = 0;
  let storageFault = null;
  let childState = {
    state: 'none',
    pid: null,
    startTime: null,
    at: null,
    exitCode: null,
    signal: null,
  };
  const ownershipPath = `${statePath}.owner`;
  let reclaimPath = null;
  let lockStartedAt = null;

  function nextRequestId(prefix) {
    idCounter += 1;
    return `${prefix}-${idCounter}-${crypto.randomBytes(4).toString('hex')}`;
  }

  function serializeState() {
    return {
      version: STATE_VERSION,
      sessionId,
      cwd,
      socketPath,
      statePath,
      sessionDir,
      agentDir,
      provider,
      model,
      generation,
      paused,
      pauseOwner,
      status,
      activeTurn,
      pendingPrompt,
      seq,
      earliestSeq,
      events,
      lastError,
      piPid,
      piExitCode,
      child: childState,
      createdAt: state && state.createdAt ? state.createdAt : nowIso(),
      updatedAt: nowIso(),
    };
  }

  function recordStorageFault(operation, error) {
    const code = error instanceof SupervisorError
      ? error.code
      : (error && typeof error.code === 'string' ? error.code : 'state_write_failed');
    storageFault = {
      code,
      message: 'Guest supervisor storage failed.',
      operation,
      at: nowIso(),
    };
    lastError = {
      code: 'state_write_failed',
      message: `Guest supervisor could not persist ${operation}.`,
    };
  }

  /**
   * Diagnostic journal writes are best effort and never latch a storage fault.
   * Once a critical write fails, no further state writes are attempted so an
   * ambiguous durable marker is never silently overwritten.
   */
  function writeStateBestEffort() {
    saveDirty = false;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (storageFault) {
      return false;
    }
    const data = JSON.stringify(serializeState(), null, 2);
    try {
      writeAtomic(statePath, data);
      return true;
    } catch (error) {
      lastError = {
        code: error instanceof SupervisorError ? error.code : 'state_write_failed',
        message: 'State write failed.',
      };
      return false;
    }
  }

  /**
   * Critical ownership/lifecycle state. Throws when the transition was not
   * durably committed, and refuses further writes after any critical failure.
   */
  function writeStateCritical(operation) {
    if (storageFault) {
      fail('storage_unavailable', 'Guest supervisor storage is unavailable.', {
        fault: storageFault,
      });
    }
    saveDirty = false;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const data = JSON.stringify(serializeState(), null, 2);
    try {
      writeAtomic(statePath, data);
    } catch (error) {
      if (!storageFault) {
        recordStorageFault(operation, error);
      }
      throw error instanceof SupervisorError
        ? error
        : new SupervisorError('state_write_failed', 'Guest supervisor state could not be committed.', {
          operation,
        });
    }
  }

  function ownershipMarkerPayload() {
    return {
      version: 1,
      sessionId,
      supervisorPid: process.pid,
      supervisorStartedAt: lockStartedAt || (state && state.createdAt) || nowIso(),
      child: childState,
      updatedAt: nowIso(),
    };
  }

  function writeOwnershipMarkerCritical(operation) {
    if (storageFault) {
      fail('storage_unavailable', 'Guest supervisor storage is unavailable.', {
        fault: storageFault,
      });
    }
    try {
      writeAtomic(ownershipPath, JSON.stringify(ownershipMarkerPayload(), null, 2));
    } catch (error) {
      if (!storageFault) {
        recordStorageFault(operation, error);
      }
      throw error instanceof SupervisorError
        ? error
        : new SupervisorError('state_write_failed', 'Guest supervisor ownership marker could not be committed.', {
          operation,
        });
    }
  }

  /**
   * Used only when absence is independently established (an observed child
   * exit or no child ever spawned). It may run after a storage fault because
   * it records a proof rather than granting ownership; if it fails, the prior
   * guard stays and restart fails closed until the probe verifies absence.
   */
  function writeOwnershipMarkerRaw(operation) {
    try {
      writeAtomic(ownershipPath, JSON.stringify(ownershipMarkerPayload(), null, 2));
      return true;
    } catch (error) {
      if (!storageFault) {
        recordStorageFault(operation, error);
      }
      return false;
    }
  }

  function readOwnershipMarker() {
    let stat;
    try {
      stat = fs.lstatSync(ownershipPath);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return null;
      }
      fail('cleanup_pending', 'Guest supervisor ownership marker could not be inspected.', {
        reason: 'ownership_unreadable',
        cleanupPending: true,
      });
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail('cleanup_pending', 'Guest supervisor ownership marker is not a regular file.', {
        reason: 'ownership_unreadable',
        cleanupPending: true,
      });
    }
    const uid = currentUid();
    if (uid !== null && stat.uid !== uid && stat.uid !== 0) {
      fail('cleanup_pending', 'Guest supervisor ownership marker is not owned by the guest user.', {
        reason: 'ownership_unreadable',
        cleanupPending: true,
      });
    }
    if ((stat.mode & 0o077) !== 0) {
      fail('cleanup_pending', 'Guest supervisor ownership marker is not private.', {
        reason: 'ownership_unreadable',
        cleanupPending: true,
      });
    }
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(ownershipPath, 'utf8'));
    } catch {
      fail('cleanup_pending', 'Guest supervisor ownership marker is not valid JSON.', {
        reason: 'ownership_unreadable',
        cleanupPending: true,
      });
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.version !== 1) {
      fail('cleanup_pending', 'Guest supervisor ownership marker has an unsupported shape.', {
        reason: 'ownership_unreadable',
        cleanupPending: true,
      });
    }
    if (parsed.sessionId !== sessionId) {
      fail('state_conflict', 'Guest supervisor ownership marker belongs to a different session.');
    }
    const child = normalizeChildRecord(parsed.child);
    if (!child) {
      fail('cleanup_pending', 'Guest supervisor ownership marker has an invalid child record.', {
        reason: 'ownership_unreadable',
        cleanupPending: true,
      });
    }
    return { child, raw: parsed };
  }

  /**
   * Serialize ownership recovery. Returns true when a prior marker was proven
   * absent and cleared; throws cleanup_pending when the prior child may live
   * or its identity cannot be verified. Recovery runs while holding the
   * supervisor lock, and the probe never signals an unverified pid.
   */
  function reconcileOwnership() {
    const marker = readOwnershipMarker();
    if (!marker) {
      return false;
    }
    const verdict = probeChildPresence(marker.child);
    if (verdict !== 'absent') {
      fail('cleanup_pending', 'A previous Pi child cannot be proven absent; guest cleanup is required.', {
        verdict,
        child: marker.child,
        cleanupPending: true,
      });
    }
    unlinkDurable(ownershipPath);
    return true;
  }

  function persistChildTransition(nextChild, operation) {
    childState = nextChild;
    writeOwnershipMarkerCritical(operation);
    writeStateCritical(operation);
  }

  function scheduleSave() {
    saveDirty = true;
    if (saveTimer) {
      return;
    }
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (saveDirty) {
        writeStateBestEffort();
      }
    }, 50);
  }

  function notifyWaiters() {
    for (const waiter of waiters) {
      waiter();
    }
    waiters.clear();
  }

  function waitForChange(timeoutMs) {
    if (timeoutMs <= 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let timer = null;
      const done = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        waiters.delete(done);
        resolve();
      };
      waiters.add(done);
      timer = setTimeout(done, timeoutMs);
    });
  }

  function summarizeTurn(turn) {
    if (!turn) {
      return null;
    }
    return {
      requestId: turn.requestId,
      generation: turn.generation,
      submittedAt: turn.submittedAt,
      settled: turn.settled === true,
      uncertain: turn.uncertain === true,
      disposition: typeof turn.disposition === 'string' ? turn.disposition : null,
      aborted: turn.aborted === true,
      error: turn.error === true,
    };
  }

  function appendEvent(record) {
    const safe = sanitizeRecord(record);
    seq += 1;
    events.push({ seq, at: nowIso(), record: safe });
    if (events.length > maxEvents) {
      events = events.slice(events.length - maxEvents);
    }
    earliestSeq = events.length > 0 ? events[0].seq : seq + 1;
    if (safe && safe.type === 'agent_settled' && activeTurn) {
      activeTurn.settled = true;
      activeTurn.settledAt = nowIso();
      if (pendingPrompt) {
        pendingPrompt.settled = true;
      }
      if (activeTurn.uncertain) {
        status = 'uncertain';
      } else if (paused) {
        status = 'paused';
      } else {
        status = 'settled';
      }
      // A settlement changes ownership/pending semantics; try to commit it
      // strictly, but never throw out of the Pi stdout handler.
      try {
        writeStateCritical('agent-settled');
      } catch {
        // The storage fault is recorded and further dispatch is denied.
      }
    } else if (safe && (safe.type === 'agent_start' || safe.type === 'message_start' ||
      safe.type === 'message_update' || safe.type === 'message_end' ||
      safe.type === 'tool_execution_start' || safe.type === 'tool_execution_update' ||
      safe.type === 'tool_execution_end')) {
      if (!paused && activeTurn && !activeTurn.settled) {
        status = 'running';
      }
    } else if (safe && (safe.type === 'error' || typeof safe.error === 'string')) {
      lastError = { code: 'pi_event_error', message: truncateText(String(safe.error || safe.type), 512) };
      if (activeTurn && !activeTurn.settled) {
        activeTurn.error = true;
      }
    }
    scheduleSave();
    notifyWaiters();
  }

  function protocolError(message) {
    protocolErrors += 1;
    lastError = { code: 'protocol_error', message };
    appendEvent({ type: 'protocol_error', message });
    if (protocolErrors >= 5 && piChild && !piExited) {
      try {
        piChild.kill('SIGKILL');
      } catch {
        // The exit handler reports the terminal state.
      }
    }
  }

  function handlePiRecord(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      protocolError('Pi emitted a non-object protocol record.');
      return;
    }
    if (record.type === 'response') {
      const id = record.id;
      if (typeof id !== 'string' || id.length === 0) {
        protocolError('Pi emitted a response without a correlating id.');
        return;
      }
      const entry = pending.get(id);
      if (!entry) {
        appendEvent({ type: 'orphan_response', id, command: record.command });
        return;
      }
      pending.delete(id);
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
      if (record.command !== entry.command) {
        entry.reject(new SupervisorError(
          'protocol_error',
          'Pi response command did not match the outstanding request.'
        ));
        return;
      }
      entry.resolve(record);
      return;
    }
    if (record.type === 'extension_ui_request') {
      // The guest profile disables extensions. If one still asks for UI input,
      // cancel it deterministically rather than leaving Pi blocked.
      if (typeof record.id === 'string' && piChild && !piExited) {
        try {
          piChild.stdin.write(
            `${JSON.stringify({ type: 'extension_ui_response', id: record.id, cancelled: true })}\n`
          );
        } catch {
          // Pi will be handled by the exit path.
        }
      }
      appendEvent({ type: 'extension_ui_cancelled', id: record.id, method: record.method });
      return;
    }
    appendEvent(record);
  }

  function handleStdoutChunk(chunk) {
    stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
    if (stdoutBuffer.length > MAX_RECORD_BYTES && stdoutBuffer.indexOf(0x0a) === -1) {
      stdoutBuffer = Buffer.alloc(0);
      protocolError('Pi emitted an oversized record without LF framing.');
      return;
    }
    let newline;
    while ((newline = stdoutBuffer.indexOf(0x0a)) !== -1) {
      let line = stdoutBuffer.subarray(0, newline);
      stdoutBuffer = stdoutBuffer.subarray(newline + 1);
      if (line.length > 0 && line[line.length - 1] === 0x0d) {
        line = line.subarray(0, line.length - 1);
      }
      if (line.length === 0) {
        continue;
      }
      if (line.length > MAX_RECORD_BYTES) {
        protocolError('Pi emitted an oversized protocol record.');
        continue;
      }
      let record;
      try {
        record = JSON.parse(line.toString('utf8'));
      } catch {
        protocolError('Pi emitted malformed JSON.');
        continue;
      }
      handlePiRecord(record);
    }
  }

  function failPending(error) {
    for (const entry of pending.values()) {
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
      entry.reject(error);
    }
    pending.clear();
  }

  function handlePiExit(code, signal) {
    if (piExited) {
      return;
    }
    piExited = true;
    piExitCode = Number.isInteger(code) ? code : null;
    piSignal = typeof signal === 'string' ? signal : null;
    childState = {
      state: 'exited',
      pid: childState.pid === null ? piPid : childState.pid,
      startTime: childState.startTime,
      at: nowIso(),
      exitCode: piExitCode,
      signal: piSignal,
    };
    failPending(new SupervisorError('pi_exited', 'Pi exited before completing the request.', {
      exitCode: piExitCode,
      signal: piSignal,
    }));
    // An observed exit is independent proof of absence. Record it durably so a
    // later supervisor can clear the guard; if this write fails the previous
    // marker (possibly 'running') remains and restart fails closed.
    writeOwnershipMarkerRaw('pi-exit');
    if (!stopping) {
      status = 'exited';
      lastError = {
        code: 'pi_exited',
        message: 'Pi exited unexpectedly.',
        exitCode: piExitCode,
        signal: piSignal,
      };
      if (activeTurn && !activeTurn.settled) {
        activeTurn.uncertain = true;
      }
      if (pendingPrompt && !pendingPrompt.settled) {
        pendingPrompt.uncertain = true;
      }
      try {
        writeStateCritical('pi-exit');
      } catch {
        // The storage fault is recorded and further dispatch is denied.
      }
    }
    notifyWaiters();
  }

  function spawnPi() {
    const argv = [
      ...PI_ARGV_FIXED,
      '--session-id',
      sessionId,
      '--session-dir',
      sessionDir,
      '--provider',
      provider,
      '--model',
      model,
    ];
    const env = {
      PATH: pathEnv,
      HOME: guestHome,
      PI_CODING_AGENT_DIR: agentDir,
    };
    // A durable spawning marker closes the window in which a crashed
    // supervisor could leave an unidentified child: any restart over this
    // marker fails closed until an operator has verified the guest. It is
    // overwritten with the running record immediately after the spawn.
    childState = {
      state: 'spawning',
      pid: null,
      startTime: null,
      at: nowIso(),
      exitCode: null,
      signal: null,
    };
    writeOwnershipMarkerCritical('pi-spawning');
    let child;
    try {
      child = childProcess.spawn(piExecutable, argv, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false,
      });
    } catch {
      // A synchronous spawn failure means no child exists; record that proof
      // so the spawning guard does not fence every future restart.
      childState = {
        state: 'none',
        pid: null,
        startTime: null,
        at: nowIso(),
        exitCode: null,
        signal: null,
      };
      writeOwnershipMarkerRaw('pi-spawn-failed');
      fail('pi_unavailable', 'Pi could not be started inside the guest.');
    }
    piChild = child;
    piPid = child.pid || null;
    piExited = false;
    childState = {
      state: 'running',
      pid: piPid,
      startTime: piPid ? readProcStartTime(piPid) : null,
      at: nowIso(),
      exitCode: null,
      signal: null,
    };
    try {
      persistChildTransition(childState, 'pi-start');
    } catch (error) {
      // The child exists but its ownership record is not durable. Kill the
      // child this supervisor just spawned (verified ours) and fail closed; a
      // later restart probes absence before reclaiming the session.
      try {
        child.kill('SIGKILL');
      } catch {
        // Reported by the close handler.
      }
      throw error;
    }
    child.on('error', () => {
      lastError = { code: 'pi_unavailable', message: 'Pi process failed to start.' };
      if (!piExited) {
        piExited = true;
        childState = {
          state: 'exited',
          pid: childState.pid,
          startTime: childState.startTime,
          at: nowIso(),
          exitCode: null,
          signal: null,
        };
        writeOwnershipMarkerRaw('pi-start-error');
        failPending(new SupervisorError('pi_unavailable', 'Pi process failed to start.'));
        if (!stopping) {
          status = 'exited';
        }
        try {
          writeStateCritical('pi-start-error');
        } catch {
          // The storage fault is recorded and further dispatch is denied.
        }
        notifyWaiters();
      }
    });
    child.stdout.on('data', (chunk) => handleStdoutChunk(chunk));
    child.stderr.on('data', (chunk) => {
      stderrTail += chunk.toString('utf8');
      if (stderrTail.length > MAX_STDERR_TAIL) {
        stderrTail = stderrTail.slice(-MAX_STDERR_TAIL);
      }
    });
    child.on('close', (code, signal) => handlePiExit(code, signal));
    return child;
  }

  function requestPi(command, timeoutMs) {
    if (!piChild || piExited) {
      return Promise.reject(new SupervisorError('pi_exited', 'Pi is not running.'));
    }
    if (!command || typeof command !== 'object' || typeof command.id !== 'string') {
      return Promise.reject(new SupervisorError('protocol_error', 'Invalid Pi command.'));
    }
    return new Promise((resolve, reject) => {
      const entry = { command: command.type, resolve, reject, timer: null };
      pending.set(command.id, entry);
      entry.timer = setTimeout(() => {
        if (pending.get(command.id) === entry) {
          pending.delete(command.id);
          reject(new SupervisorError('guest_timeout', 'Pi did not answer within the deadline.'));
        }
      }, timeoutMs);
      try {
        piChild.stdin.write(`${JSON.stringify(command)}\n`, 'utf8', (error) => {
          if (error && pending.get(command.id) === entry) {
            pending.delete(command.id);
            clearTimeout(entry.timer);
            reject(new SupervisorError('pi_write_failed', 'Pi command could not be written.'));
          }
        });
      } catch {
        pending.delete(command.id);
        clearTimeout(entry.timer);
        reject(new SupervisorError('pi_write_failed', 'Pi command could not be written.'));
      }
    });
  }

  async function getStateInternal() {
    const response = await requestPi(
      { id: nextRequestId('state'), type: 'get_state' },
      commandDeadlineMs
    );
    if (!response.success) {
      fail('guest_error', typeof response.error === 'string' ? response.error : 'Pi get_state failed.');
    }
    const data = sanitizeState(response.data);
    if (data.sessionId !== sessionId) {
      fail('session_identity_mismatch', 'Pi reported a different native session id.');
    }
    return data;
  }

  async function getMessagesInternal() {
    const response = await requestPi(
      { id: nextRequestId('messages'), type: 'get_messages' },
      commandDeadlineMs
    );
    if (!response.success) {
      fail('guest_error', typeof response.error === 'string' ? response.error : 'Pi get_messages failed.');
    }
    if (!response.data || !Array.isArray(response.data.messages)) {
      fail('protocol_error', 'Pi returned an invalid get_messages payload.');
    }
    return response.data.messages;
  }

  async function waitForSettled(timeoutMs) {
    if (!activeTurn || activeTurn.settled === true) {
      return true;
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!activeTurn || activeTurn.settled === true) {
        return true;
      }
      if (piExited) {
        return false;
      }
      await waitForChange(Math.min(250, Math.max(1, deadline - Date.now())));
    }
    return activeTurn ? activeTurn.settled === true : true;
  }

  async function abortInternal({ generation: requestGeneration }) {
    if (requestGeneration !== generation) {
      fail('stale_writer', 'Writer generation is stale.');
    }
    if (!activeTurn || activeTurn.settled === true) {
      return {
        aborted: false,
        alreadySettled: true,
        settled: true,
        quiescent: true,
        uncertain: false,
      };
    }
    activeTurn.aborted = true;
    scheduleSave();
    let response;
    try {
      response = await requestPi(
        { id: nextRequestId('abort'), type: 'abort' },
        commandDeadlineMs
      );
    } catch (error) {
      if (error instanceof SupervisorError && error.code === 'guest_timeout') {
        return {
          aborted: false,
          settled: false,
          quiescent: false,
          uncertain: true,
          code: 'abort_uncertain',
        };
      }
      throw error;
    }
    if (!response.success) {
      return {
        aborted: false,
        settled: false,
        quiescent: false,
        uncertain: false,
        code: 'abort_rejected',
        guestMessage: typeof response.error === 'string' ? truncateText(response.error, 512) : null,
      };
    }
    const settled = await waitForSettled(quiesceDeadlineMs);
    let isStreaming = null;
    let verified = false;
    try {
      const stateData = await getStateInternal();
      isStreaming = stateData.isStreaming;
      verified = true;
    } catch {
      // Verification is unavailable; do not claim quiescence.
    }
    const quiescent = settled && verified && isStreaming === false;
    if (settled && activeTurn) {
      activeTurn.settled = true;
      activeTurn.settledAt = nowIso();
      if (pendingPrompt) {
        pendingPrompt.settled = true;
      }
    }
    if (!quiescent) {
      status = paused ? 'paused_pending' : 'running';
    } else if (paused) {
      status = 'paused';
    }
    // Quiescence is an ownership-relevant transition; report it only when the
    // resulting state was durably committed.
    writeStateCritical('abort');
    return {
      aborted: true,
      settled,
      quiescent,
      uncertain: false,
      verified,
      isStreaming,
      generation,
    };
  }

  async function handleSubmit(request) {
    const requestGeneration = assertInteger(request.generation, 1, 1_000_000_000, 'generation');
    const requestId = request.requestId;
    if (typeof requestId !== 'string' || !ID_PATTERN.test(requestId)) {
      fail('invalid_input', 'requestId is invalid.');
    }
    const operator = request.operator === true;
    const owner = request.owner === undefined ? null : assertOwner(request.owner);
    const message = joinChunks(request.chunks);
    if (requestGeneration !== generation) {
      fail('stale_writer', 'Writer generation is stale.', {
        expectedGeneration: generation,
        receivedGeneration: requestGeneration,
      });
    }
    if (paused) {
      if (!operator) {
        fail('paused', 'The conversation is paused for an operator handoff.');
      }
      if (owner === null || owner !== pauseOwner) {
        fail('owner_mismatch', 'Operator owner does not match the paused writer.');
      }
    } else if (operator) {
      fail('not_paused', 'Operator input requires a paused conversation.');
    }
    if (piExited) {
      fail('pi_exited', 'Pi is not running.');
    }
    if (storageFault) {
      fail('storage_unavailable', 'Guest supervisor storage is unavailable; refusing to dispatch.', {
        fault: storageFault,
      });
    }
    if (pendingPrompt && pendingPrompt.requestId === requestId) {
      return {
        ok: true,
        duplicate: true,
        accepted: false,
        uncertain: pendingPrompt.uncertain === true || pendingPrompt.settled !== true,
        settled: pendingPrompt.settled === true,
        disposition: pendingPrompt.disposition || null,
        requestId,
        generation,
      };
    }
    if (pendingPrompt && (pendingPrompt.settled !== true || pendingPrompt.uncertain === true)) {
      fail('prompt_pending', 'A previous prompt is still pending or uncertain.');
    }
    if (activeTurn && activeTurn.settled !== true) {
      fail('turn_active', 'A turn is already active.');
    }

    const submittedAt = nowIso();
    const nextPrompt = {
      requestId,
      generation,
      submittedAt,
      settled: false,
      uncertain: false,
      disposition: null,
      operator,
      owner,
    };
    const nextTurn = {
      requestId,
      generation,
      submittedAt,
      settled: false,
      uncertain: false,
      disposition: null,
      operator,
    };
    pendingPrompt = nextPrompt;
    activeTurn = nextTurn;
    status = 'running';
    const uncertainResult = (reason) => ({
      ok: true,
      duplicate: false,
      accepted: false,
      uncertain: true,
      settled: false,
      disposition: null,
      requestId,
      generation,
      code: 'prompt_uncertain',
      reason,
    });
    // Imperative boundary: persist the intent before writing to Pi. A host
    // crash or lost response after this point is `uncertain`, never a retry.
    try {
      writeStateCritical('submit-intent');
    } catch (error) {
      // Nothing was dispatched. The durable marker may or may not contain this
      // intent, so retain the ambiguous record and fence all further dispatch
      // until a restart reloads durable state.
      pendingPrompt.uncertain = true;
      activeTurn.uncertain = true;
      status = 'uncertain';
      throw error;
    }

    let response;
    try {
      response = await requestPi(
        { id: `prompt-${requestId}`, type: 'prompt', message },
        submitDeadlineMs
      );
    } catch (error) {
      if (error instanceof SupervisorError &&
        (error.code === 'guest_timeout' || error.code === 'pi_exited' ||
          error.code === 'pi_write_failed')) {
        pendingPrompt.uncertain = true;
        activeTurn.uncertain = true;
        status = piExited ? 'exited' : 'uncertain';
        try {
          writeStateCritical('submit-uncertain');
        } catch {
          // The side effect is already in flight; retain the ambiguity.
        }
        return {
          ok: true,
          duplicate: false,
          accepted: false,
          uncertain: true,
          settled: activeTurn.settled === true,
          disposition: null,
          requestId,
          generation,
          code: 'prompt_uncertain',
          reason: error.code,
        };
      }
      pendingPrompt = null;
      activeTurn = null;
      status = paused ? 'paused' : 'ready';
      try {
        writeStateCritical('submit-failed');
      } catch {
        // The durable intent cannot be cleared; keep the record ambiguous.
        pendingPrompt = nextPrompt;
        activeTurn = nextTurn;
        pendingPrompt.uncertain = true;
        activeTurn.uncertain = true;
        status = 'uncertain';
        return uncertainResult('state_write_failed');
      }
      throw error;
    }

    if (!response.success) {
      pendingPrompt = null;
      activeTurn = null;
      status = paused ? 'paused' : 'ready';
      try {
        writeStateCritical('submit-rejected');
      } catch {
        // Pi rejected the prompt, but the durable record cannot be cleared.
        pendingPrompt = nextPrompt;
        activeTurn = nextTurn;
        pendingPrompt.uncertain = true;
        activeTurn.uncertain = true;
        status = 'uncertain';
        return uncertainResult('state_write_failed');
      }
      fail('guest_error', typeof response.error === 'string'
        ? truncateText(response.error, 1024)
        : 'Pi rejected the prompt.');
    }
    const disposition = response.data && response.data.disposition;
    if (typeof disposition !== 'string' || disposition.length === 0) {
      pendingPrompt = null;
      activeTurn = null;
      status = paused ? 'paused' : 'ready';
      try {
        writeStateCritical('submit-protocol-error');
      } catch {
        // The durable record cannot be cleared; keep it ambiguous.
        pendingPrompt = nextPrompt;
        activeTurn = nextTurn;
        pendingPrompt.uncertain = true;
        activeTurn.uncertain = true;
        status = 'uncertain';
        return uncertainResult('state_write_failed');
      }
      fail('protocol_error', 'Pi prompt response had no disposition.');
    }
    pendingPrompt.disposition = disposition;
    activeTurn.disposition = disposition;
    if (disposition === 'handled') {
      pendingPrompt.settled = true;
      activeTurn.settled = true;
      activeTurn.settledAt = nowIso();
      status = paused ? 'paused' : 'settled';
    } else if (activeTurn.settled === true) {
      // A fast completion may have emitted agent_settled before the response.
      pendingPrompt.settled = true;
      status = activeTurn.uncertain ? 'uncertain' : paused ? 'paused' : 'settled';
    } else {
      status = paused ? 'paused' : 'running';
    }
    try {
      writeStateCritical('submit-result');
    } catch {
      // Pi accepted the prompt but the durable disposition is ambiguous.
      return {
        ok: true,
        duplicate: false,
        accepted: false,
        uncertain: true,
        settled: activeTurn.settled === true,
        disposition,
        requestId,
        generation,
        code: 'prompt_uncertain',
        reason: 'state_write_failed',
      };
    }
    return {
      ok: true,
      duplicate: false,
      accepted: true,
      uncertain: activeTurn.uncertain === true,
      settled: activeTurn.settled === true,
      disposition,
      requestId,
      generation,
    };
  }

  async function handlePause(request) {
    const requestGeneration = assertInteger(request.generation, 1, 1_000_000_000, 'generation');
    const owner = assertOwner(request.owner);
    const abortActive = request.abortActive === true;
    if (requestGeneration !== generation) {
      fail('stale_writer', 'Writer generation is stale.', {
        expectedGeneration: generation,
        receivedGeneration: requestGeneration,
      });
    }
    if (storageFault) {
      fail('storage_unavailable', 'Guest supervisor storage is unavailable; refusing to grant ownership.', {
        fault: storageFault,
      });
    }
    if (paused) {
      if (pauseOwner !== owner) {
        fail('owner_mismatch', 'A different operator owns the paused conversation.');
      }
    } else {
      const previous = { generation, paused, pauseOwner, status };
      generation += 1;
      paused = true;
      pauseOwner = owner;
      status = 'paused_pending';
      try {
        // Fence the previous writer before any abort or quiescence wait. The
        // new generation is not reported unless this write is durable.
        writeStateCritical('pause');
      } catch (error) {
        generation = previous.generation;
        paused = previous.paused;
        pauseOwner = previous.pauseOwner;
        status = previous.status;
        throw error;
      }
    }
    let settled = !activeTurn || activeTurn.settled === true;
    let abortResult = null;
    if (!settled && abortActive) {
      try {
        abortResult = await abortInternal({ generation });
      } catch (error) {
        if (!(error instanceof SupervisorError && error.code === 'stale_writer')) {
          throw error;
        }
      }
      settled = !activeTurn || activeTurn.settled === true;
    }
    let isStreaming = null;
    let verified = false;
    try {
      const stateData = await getStateInternal();
      isStreaming = stateData.isStreaming;
      verified = true;
    } catch {
      // Quiescence cannot be verified without Pi state.
    }
    const quiescent = settled && verified && isStreaming === false;
    status = quiescent ? 'paused' : 'paused_pending';
    writeStateCritical('pause-result');
    return {
      ok: true,
      paused: true,
      generation,
      owner: pauseOwner,
      settled,
      quiescent,
      isStreaming,
      verified,
      conflict: quiescent ? null : 'quiesce_unconfirmed',
      abort: abortResult ? {
        aborted: abortResult.aborted === true,
        uncertain: abortResult.uncertain === true,
      } : null,
    };
  }

  async function handleResume(request) {
    const requestGeneration = assertInteger(request.generation, 1, 1_000_000_000, 'generation');
    const owner = assertOwner(request.owner);
    if (!paused) {
      fail('not_paused', 'The conversation is not paused.');
    }
    if (requestGeneration !== generation) {
      fail('stale_writer', 'Writer generation is stale.', {
        expectedGeneration: generation,
        receivedGeneration: requestGeneration,
      });
    }
    if (owner !== pauseOwner) {
      fail('owner_mismatch', 'Only the paused operator can return control.');
    }
    if (storageFault) {
      fail('storage_unavailable', 'Guest supervisor storage is unavailable; refusing to grant ownership.', {
        fault: storageFault,
      });
    }
    let isStreaming = null;
    let verified = false;
    try {
      const stateData = await getStateInternal();
      isStreaming = stateData.isStreaming;
      verified = true;
    } catch {
      // Return control only when Pi state can be verified.
    }
    const settled = !activeTurn || activeTurn.settled === true;
    if (!settled || !verified || isStreaming !== false) {
      fail('quiesce_unconfirmed', 'Quiescence could not be confirmed; handoff remains pending.', {
        generation,
        paused: true,
        owner: pauseOwner,
        settled,
        verified,
        isStreaming,
      });
    }
    const previous = { generation, paused, pauseOwner, status };
    generation += 1;
    paused = false;
    pauseOwner = null;
    status = activeTurn && activeTurn.settled !== true ? 'running' : 'ready';
    try {
      writeStateCritical('resume');
    } catch (error) {
      generation = previous.generation;
      paused = previous.paused;
      pauseOwner = previous.pauseOwner;
      status = previous.status;
      throw error;
    }
    return {
      ok: true,
      resumed: true,
      generation,
      paused: false,
      owner: null,
      quiescent: true,
    };
  }

  async function handleEvents(request) {
    const after = assertInteger(request.after, 0, 1_000_000_000, 'after');
    const limit = request.limit === undefined
      ? Math.min(200, maxEvents)
      : Math.min(maxEvents, assertInteger(request.limit, 1, 4096, 'limit'));
    const waitMs = request.waitMs === undefined
      ? 0
      : assertInteger(request.waitMs, 0, 5000, 'waitMs');
    if (waitMs > 0 && !(activeTurn && activeTurn.settled === true) && !piExited) {
      await waitForChange(waitMs);
    }
    const gap = after + 1 < earliestSeq;
    const selected = events
      .filter((entry) => entry.seq > after)
      .slice(0, limit);
    const nextSeq = selected.length > 0 ? selected[selected.length - 1].seq : Math.max(after, seq);
    return {
      ok: true,
      events: selected,
      nextSeq,
      earliestSeq,
      gap,
      seq,
      settled: !activeTurn || activeTurn.settled === true,
      uncertain: (activeTurn && activeTurn.uncertain === true) ||
        (pendingPrompt && pendingPrompt.uncertain === true),
      status,
      generation,
      paused,
      activeTurn: summarizeTurn(activeTurn),
      pendingPrompt: pendingPrompt ? {
        requestId: pendingPrompt.requestId,
        generation: pendingPrompt.generation,
        settled: pendingPrompt.settled === true,
        uncertain: pendingPrompt.uncertain === true,
        disposition: pendingPrompt.disposition || null,
      } : null,
    };
  }

  async function handleMessages() {
    const messages = await getMessagesInternal();
    let serialized;
    try {
      serialized = JSON.stringify(messages);
    } catch {
      fail('protocol_error', 'Pi messages could not be serialized.');
    }
    if (Buffer.byteLength(serialized, 'utf8') > MAX_RESPONSE_BYTES) {
      fail('response_too_large', 'Pi messages exceed the bounded response size.');
    }
    return { ok: true, messages, count: messages.length, sessionId };
  }

  async function handleState() {
    const data = await getStateInternal();
    return { ok: true, state: data, generation, paused, status };
  }

  async function handleAbort(request) {
    const requestGeneration = assertInteger(request.generation, 1, 1_000_000_000, 'generation');
    const result = await abortInternal({ generation: requestGeneration });
    return { ok: true, ...result, generation };
  }

  async function handleResolve(request) {
    const requestId = request.requestId;
    if (typeof requestId !== 'string' || !ID_PATTERN.test(requestId)) {
      fail('invalid_input', 'requestId is invalid.');
    }
    const resolution = request.resolution;
    if (resolution !== 'settled' && resolution !== 'rejected') {
      fail('invalid_input', 'resolution must be settled or rejected.');
    }
    const matchesPrompt = pendingPrompt && pendingPrompt.requestId === requestId;
    const matchesTurn = activeTurn && activeTurn.requestId === requestId;
    if (!matchesPrompt && !matchesTurn) {
      fail('unknown_request', 'No prompt record matches that request id.');
    }
    if (storageFault) {
      fail('storage_unavailable', 'Guest supervisor storage is unavailable; resolution was not committed.', {
        fault: storageFault,
      });
    }
    // Operator resolution is an explicit acknowledgement after inspecting the
    // native conversation. It never re-dispatches the prompt. Snapshot deeply:
    // the rollback must undo in-place field mutations.
    const previousPrompt = pendingPrompt ? JSON.parse(JSON.stringify(pendingPrompt)) : null;
    const previousTurn = activeTurn ? JSON.parse(JSON.stringify(activeTurn)) : null;
    const previousStatus = status;
    if (matchesPrompt) {
      pendingPrompt.settled = true;
      pendingPrompt.uncertain = false;
      pendingPrompt.resolvedAt = nowIso();
      pendingPrompt.resolution = resolution;
    }
    if (matchesTurn) {
      activeTurn.settled = true;
      activeTurn.uncertain = false;
      activeTurn.resolvedAt = nowIso();
      activeTurn.resolution = resolution;
      if (resolution === 'rejected') {
        activeTurn.rejected = true;
      }
    }
    status = paused ? 'paused' : 'settled';
    try {
      writeStateCritical('resolve');
    } catch (error) {
      pendingPrompt = previousPrompt;
      activeTurn = previousTurn;
      status = previousStatus;
      throw error;
    }
    return {
      ok: true,
      resolved: true,
      requestId,
      resolution,
      settled: true,
      generation,
      paused,
    };
  }

  async function handleStop(request) {
    const deadline = request.deadlineMs === undefined
      ? stopDeadlineMs
      : assertInteger(request.deadlineMs, 100, MAX_DEADLINE_MS, 'deadlineMs');
    const result = await shutdown(deadline);
    return {
      ok: true,
      stopped: result.stopped,
      exitCode: result.exitCode,
      signal: result.signal,
      forced: result.forced,
      cleanupUnverified: result.cleanupUnverified,
      alreadyStopped: result.alreadyStopped,
    };
  }

  async function handleStatus() {
    return {
      ok: true,
      protocolVersion: PROTOCOL_VERSION,
      sessionId,
      cwd,
      socketPath,
      statePath,
      sessionDir,
      agentDir,
      provider,
      model,
      generation,
      paused,
      pauseOwner,
      status,
      activeTurn: summarizeTurn(activeTurn),
      pendingPrompt: pendingPrompt ? {
        requestId: pendingPrompt.requestId,
        generation: pendingPrompt.generation,
        settled: pendingPrompt.settled === true,
        uncertain: pendingPrompt.uncertain === true,
        disposition: pendingPrompt.disposition || null,
      } : null,
      seq,
      earliestSeq,
      piPid,
      piExitCode,
      piSignal,
      child: childState,
      ownershipPending: childState.state === 'running' || childState.state === 'spawning',
      storageFault,
      lastError,
      resumed,
      protocolErrors,
      stderrTail: truncateText(stderrTail, MAX_STDERR_TAIL),
    };
  }

  async function handleRequest(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      fail('invalid_input', 'Request must be an object.');
    }
    if (request.version !== PROTOCOL_VERSION) {
      fail('unsupported_protocol', 'Unsupported guest supervisor protocol version.');
    }
    if (typeof request.command !== 'string') {
      fail('invalid_input', 'Request command is required.');
    }
    if (typeof request.id !== 'string' || !ID_PATTERN.test(request.id)) {
      fail('invalid_input', 'Request id is invalid.');
    }
    switch (request.command) {
      case 'status':
        return handleStatus();
      case 'state':
        return handleState();
      case 'messages':
        return handleMessages();
      case 'submit':
        return handleSubmit(request);
      case 'abort':
        return handleAbort(request);
      case 'resolve':
        return handleResolve(request);
      case 'pause':
        return handlePause(request);
      case 'resume':
        return handleResume(request);
      case 'events':
        return handleEvents(request);
      case 'stop':
        return handleStop(request);
      case 'ping':
        return { ok: true, protocolVersion: PROTOCOL_VERSION, sessionId, status };
      default:
        fail('unknown_command', 'Unknown guest supervisor command.');
    }
  }

  function readLockRecord() {
    let raw;
    try {
      raw = fs.readFileSync(lockPath, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return null;
      }
      return { invalid: true };
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Fall through to the invalid marker below.
    }
    return { invalid: true };
  }

  function supervisorAlive(record) {
    if (!record || record.invalid === true) {
      return false;
    }
    if (!Number.isSafeInteger(record.pid) || record.pid <= 0) {
      return false;
    }
    try {
      process.kill(record.pid, 0);
      return true;
    } catch (error) {
      // ESRCH is the only answer that proves the supervisor is gone. EPERM
      // means the process exists but is not inspectable, so fail closed.
      return !(error && error.code === 'ESRCH');
    }
  }

  function tryCreateLock() {
    let fd;
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
    } catch (error) {
      throw error;
    }
    try {
      fs.writeFileSync(fd, JSON.stringify({
        version: 1,
        pid: process.pid,
        sessionId,
        startedAt: lockStartedAt,
      }), 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fsyncDirectory(path.dirname(lockPath));
      return;
    } catch (error) {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // The original failure is reported below.
        }
      }
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Keep the original failure.
      }
      throw error;
    }
  }

  /**
   * Acquire the supervisor lock. Stale locks are reclaimed only while holding
   * a separate reclaim lock, so two supervisors cannot both decide that the
   * same lock is stale and replace it. The liveness probe never signals a
   * live pid, and a lock owned by a live supervisor is never taken.
   */
  function acquireLock() {
    lockPath = `${statePath}.lock`;
    reclaimPath = `${statePath}.lock` + " + '.reclaim'";
    lockStartedAt = nowIso();
    try {
      tryCreateLock();
      return;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') {
        fail('lock_failed', 'Guest supervisor lock could not be acquired.');
      }
    }
    const existing = readLockRecord();
    if (supervisorAlive(existing)) {
      fail('already_running', 'A guest supervisor already owns this session.');
    }
    let reclaimFd;
    for (let attempt = 0; ; attempt += 1) {
      try {
        reclaimFd = fs.openSync(reclaimPath, 'wx', 0o600);
        fs.writeFileSync(reclaimFd, JSON.stringify({ pid: process.pid, at: nowIso() }), 'utf8');
        fs.fsyncSync(reclaimFd);
        fs.closeSync(reclaimFd);
        reclaimFd = undefined;
        break;
      } catch (error) {
        if (reclaimFd !== undefined) {
          try {
            fs.closeSync(reclaimFd);
          } catch {
            // The failure below is what matters.
          }
          reclaimFd = undefined;
        }
        if (error && error.code === 'EEXIST') {
          let stale = null;
          try {
            stale = JSON.parse(fs.readFileSync(reclaimPath, 'utf8'));
          } catch {
            stale = null;
          }
          if (attempt === 0 && stale && !supervisorAlive(stale)) {
            // A dead supervisor can leave the reclaim lock behind only if it
            // was killed inside this tiny window. Clean it up once.
            try {
              fs.unlinkSync(reclaimPath);
            } catch {
              // The retry reports the next failure.
            }
            continue;
          }
          fail('lock_busy', 'Guest supervisor ownership recovery is already in progress.');
        }
        fail('lock_failed', 'Guest supervisor ownership recovery could not be serialized.');
      }
    }
    try {
      const current = readLockRecord();
      if (supervisorAlive(current)) {
        fail('already_running', 'A guest supervisor already owns this session.');
      }
      if (existing && !existing.invalid && current && !current.invalid &&
        (current.pid !== existing.pid || current.startedAt !== existing.startedAt)) {
        fail('lock_busy', 'Guest supervisor lock changed during ownership recovery.');
      }
      if (current) {
        try {
          fs.unlinkSync(lockPath);
        } catch (unlinkError) {
          if (!unlinkError || unlinkError.code !== 'ENOENT') {
            fail('lock_failed', 'A stale guest supervisor lock could not be cleared.');
          }
        }
        fsyncDirectory(path.dirname(lockPath));
      }
      try {
        tryCreateLock();
      } catch (createError) {
        if (createError && createError.code === 'EEXIST') {
          fail('lock_busy', 'Guest supervisor lock was replaced during ownership recovery.');
        }
        fail('lock_failed', 'Guest supervisor lock could not be acquired.');
      }
    } finally {
      try {
        fs.unlinkSync(reclaimPath);
      } catch (error) {
        if (!error || error.code !== 'ENOENT') {
          // The reclaim lock is diagnostic once we hold the real lock.
        }
      }
    }
  }

  function releaseLock() {
    if (!lockPath) {
      return;
    }
    const current = readLockRecord();
    if (current && !current.invalid &&
      (current.pid !== process.pid || current.startedAt !== lockStartedAt)) {
      // Never remove a lock that a replacement supervisor now owns.
      lockPath = null;
      reclaimPath = null;
      return;
    }
    try {
      fs.unlinkSync(lockPath);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        // Best effort on the shutdown path; the ownership marker still guards
        // the session against an unverified replacement.
      }
    }
    try {
      fsyncDirectory(path.dirname(lockPath));
    } catch {
      // Best effort; the entry is gone or was already absent.
    }
    if (reclaimPath) {
      try {
        fs.unlinkSync(reclaimPath);
      } catch {
        // Best effort.
      }
    }
    lockPath = null;
    reclaimPath = null;
  }

  function loadOrCreateState(ownershipVerified) {
    const loaded = readStateFile(statePath);
    if (loaded) {
      if (loaded.sessionId !== sessionId || loaded.cwd !== cwd ||
        loaded.socketPath !== socketPath || loaded.statePath !== statePath) {
        fail('state_conflict', 'Guest supervisor state belongs to a different session.');
      }
      if (!Number.isSafeInteger(loaded.generation) || loaded.generation < 1) {
        fail('state_corrupt', 'Guest supervisor state has an invalid generation.');
      }
      if (typeof loaded.paused !== 'boolean' || typeof loaded.status !== 'string') {
        fail('state_corrupt', 'Guest supervisor state has an invalid lifecycle.');
      }
      if (!Array.isArray(loaded.events) || !Number.isSafeInteger(loaded.seq)) {
        fail('state_corrupt', 'Guest supervisor state has an invalid event journal.');
      }
      const loadedChild = normalizeChildRecord(loaded.child);
      if (loaded.child !== undefined && loadedChild === null) {
        fail('state_corrupt', 'Guest supervisor state has an invalid child record.');
      }
      if (!ownershipVerified) {
        // A durable ownership marker was absent. Older state (or state written
        // without a marker) must not be treated as proof that no Pi child
        // survives; only a verified-exit or no-child record may pass.
        if (loadedChild && loadedChild.state !== 'exited' && loadedChild.state !== 'none') {
          fail('cleanup_pending', 'Persisted state may reference a live Pi child.', {
            cleanupPending: true,
            child: loadedChild,
          });
        }
        if (!loadedChild && Number.isSafeInteger(loaded.piPid) && loaded.piPid > 0 &&
          loaded.status !== 'stopped' && loaded.status !== 'exited') {
          fail('cleanup_pending', 'Older persisted state may reference a live Pi child.', {
            cleanupPending: true,
            piPid: loaded.piPid,
          });
        }
      }
      state = loaded;
      resumed = true;
      // A new supervisor fences every prior writer.
      generation = loaded.generation + 1;
      paused = loaded.paused === true;
      pauseOwner = loaded.paused === true && typeof loaded.pauseOwner === 'string'
        ? loaded.pauseOwner
        : null;
      activeTurn = loaded.activeTurn && typeof loaded.activeTurn === 'object'
        ? loaded.activeTurn
        : null;
      pendingPrompt = loaded.pendingPrompt && typeof loaded.pendingPrompt === 'object'
        ? loaded.pendingPrompt
        : null;
      seq = loaded.seq;
      events = loaded.events
        .filter((entry) => entry && Number.isSafeInteger(entry.seq))
        .slice(-maxEvents);
      earliestSeq = events.length > 0 ? events[0].seq : seq + 1;
      if (!ownershipVerified) {
        // When a marker was cleared, start() already reset childState: the
        // cleared marker proved the previous child is gone.
        childState = loadedChild || {
          state: 'none',
          pid: null,
          startTime: null,
          at: nowIso(),
          exitCode: null,
          signal: null,
        };
      }
      lastError = loaded.lastError || null;
      if (activeTurn && activeTurn.settled !== true) {
        activeTurn.uncertain = true;
      }
      if (pendingPrompt && pendingPrompt.settled !== true) {
        pendingPrompt.uncertain = true;
      }
      status = paused ? 'paused_pending' : (activeTurn && activeTurn.settled !== true)
        ? 'uncertain'
        : 'ready';
    } else {
      state = null;
      generation = 1;
      paused = false;
      pauseOwner = null;
      activeTurn = null;
      pendingPrompt = null;
      seq = 0;
      events = [];
      earliestSeq = 1;
      status = 'starting';
      childState = {
        state: 'none',
        pid: null,
        startTime: null,
        at: nowIso(),
        exitCode: null,
        signal: null,
      };
    }
  }

  function bindServer() {
    return new Promise((resolve, reject) => {
      server = net.createServer((socket) => {
        let buffer = Buffer.alloc(0);
        let handled = false;
        socket.setEncoding('utf8');
        socket.on('data', (chunk) => {
          if (handled) {
            return;
          }
          buffer = Buffer.concat([buffer, Buffer.from(chunk, 'utf8')]);
          if (buffer.length > MAX_REQUEST_BYTES) {
            handled = true;
            socket.end(`${JSON.stringify({
              ok: false,
              code: 'request_too_large',
              message: 'Guest supervisor request is too large.',
            })}\n`);
            return;
          }
          const newline = buffer.indexOf(0x0a);
          if (newline === -1) {
            return;
          }
          handled = true;
          let line = buffer.subarray(0, newline);
          if (line.length > 0 && line[line.length - 1] === 0x0d) {
            line = line.subarray(0, line.length - 1);
          }
          let request;
          try {
            request = JSON.parse(line.toString('utf8'));
          } catch {
            socket.end(`${JSON.stringify({
              ok: false,
              code: 'invalid_json',
              message: 'Guest supervisor request is not valid JSON.',
            })}\n`);
            return;
          }
          handleRequest(request).then((result) => {
            let serialized;
            try {
              serialized = JSON.stringify(result);
            } catch {
              serialized = JSON.stringify({
                ok: false,
                code: 'response_serialization_failed',
                message: 'Guest supervisor response could not be serialized.',
              });
            }
            if (Buffer.byteLength(serialized, 'utf8') > MAX_RESPONSE_BYTES) {
              serialized = JSON.stringify({
                ok: false,
                code: 'response_too_large',
                message: 'Guest supervisor response exceeds the bounded size.',
              });
            }
            socket.end(`${serialized}\n`, () => {
              if (request.command === 'stop') {
                finalizeStop().then(() => process.exit(0)).catch(() => process.exit(1));
              }
            });
          }, (error) => {
            const code = error instanceof SupervisorError ? error.code : 'guest_error';
            const message = error instanceof SupervisorError
              ? error.message
              : 'Guest supervisor request failed.';
            const details = error instanceof SupervisorError && error.details
              ? error.details
              : undefined;
            const payload = {
              ok: false,
              code,
              message: truncateText(message, 1024),
              ...(details === undefined ? {} : { details }),
            };
            socket.end(`${JSON.stringify(payload)}\n`, () => {
              if (request.command === 'stop') {
                finalizeStop().then(() => process.exit(0)).catch(() => process.exit(1));
              }
            });
          });
        });
        socket.on('error', () => {
          // A CLI disconnect must not affect the resident supervisor.
        });
      });
      server.once('error', (error) => {
        reject(error);
      });
      try {
        fs.unlinkSync(socketPath);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          reject(error);
          return;
        }
      }
      server.listen(socketPath, () => {
        try {
          fs.chmodSync(socketPath, 0o600);
        } catch {
          // Binding already succeeded; the private directory still protects it.
        }
        resolve();
      });
    });
  }

  async function handshake() {
    const response = await requestPi(
      { id: nextRequestId('handshake'), type: 'get_state' },
      commandDeadlineMs
    );
    if (!response.success) {
      fail('session_identity_unverified', 'Pi did not report a verifiable session state.');
    }
    const data = sanitizeState(response.data);
    if (data.sessionId !== sessionId) {
      fail('session_identity_mismatch', 'Pi reported a different native session id.');
    }
    return data;
  }

  async function start() {
    acquireLock();
    let ownershipVerified = false;
    try {
      ownershipVerified = reconcileOwnership();
      if (ownershipVerified) {
        // The cleared marker is independent proof the previous child is gone.
        childState = {
          state: 'none',
          pid: null,
          startTime: null,
          at: nowIso(),
          exitCode: null,
          signal: null,
        };
      }
      loadOrCreateState(ownershipVerified);
      // The restarted supervisor fences every prior writer; that fence must be
      // durable before the socket accepts any request.
      writeStateCritical('startup');
    } catch (error) {
      releaseLock();
      throw error;
    }
    try {
      await bindServer();
    } catch (error) {
      releaseLock();
      if (error && error.code === 'EADDRINUSE') {
        fail('already_running', 'A guest supervisor already owns this socket.');
      }
      fail('socket_bind_failed', 'Guest supervisor socket could not be bound.');
    }
    spawnPi();
    try {
      await handshake();
    } catch (error) {
      lastError = {
        code: error instanceof SupervisorError ? error.code : 'session_identity_unverified',
        message: 'Guest supervisor handshake failed.',
      };
      status = 'exited';
      writeStateBestEffort();
      await shutdown(stopDeadlineMs);
      try {
        await finalizeStop();
      } catch {
        // The ownership marker and recorded fault still guard a replacement.
      }
      throw error;
    }
    status = paused
      ? 'paused'
      : activeTurn && activeTurn.settled !== true
        ? 'uncertain'
        : 'ready';
    writeStateBestEffort();
    logLine(logPath, `supervisor ready session=${sessionId} generation=${generation} pid=${process.pid}`);
  }

  async function shutdown(deadlineMs) {
    // A verified stop is final; an unverified one may be retried because the
    // child may have exited after the previous deadline expired.
    if (stoppingResult && stoppingResult.stopped === true) {
      return stoppingResult;
    }
    stopping = true;
    status = 'stopping';
    writeStateBestEffort();
    let forced = false;
    let cleanupUnverified = false;
    const child = piChild;
    if (!child || piExited) {
      const result = {
        stopped: true,
        exitCode: piExitCode,
        signal: piSignal,
        forced: false,
        cleanupUnverified: false,
        alreadyStopped: true,
      };
      stoppingResult = result;
      status = 'stopped';
      writeStateBestEffort();
      notifyWaiters();
      return result;
    }
    const exited = new Promise((resolve) => {
      if (piExited) {
        resolve(true);
        return;
      }
      child.once('close', () => resolve(true));
    });
    try {
      child.stdin.end();
    } catch {
      // Fall through to signals.
    }
    let timer;
    const waitFor = (ms) => Promise.race([
      exited,
      new Promise((resolve) => {
        timer = setTimeout(resolve, ms, false);
      }),
    ]);
    let done = await waitFor(deadlineMs);
    clearTimeout(timer);
    if (!done) {
      forced = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // Escalate below.
      }
      done = await waitFor(TERMINATION_GRACE_MS);
      clearTimeout(timer);
    }
    if (!done) {
      forced = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // Report the uncertainty below.
      }
      done = await waitFor(TERMINATION_GRACE_MS);
      clearTimeout(timer);
    }
    if (!done) {
      cleanupUnverified = true;
    }
    const result = {
      stopped: done,
      exitCode: piExitCode,
      signal: piSignal,
      forced,
      cleanupUnverified,
      alreadyStopped: false,
    };
    stoppingResult = result;
    status = done ? 'stopped' : 'stopping';
    writeStateBestEffort();
    notifyWaiters();
    logLine(logPath, `supervisor stopped session=${sessionId} forced=${forced} verified=${done}`);
    return result;
  }

  async function finalizeStop() {
    if (server) {
      await new Promise((resolve) => {
        try {
          server.close(() => resolve());
        } catch {
          resolve();
        }
      });
      server = null;
    }
    try {
      fs.unlinkSync(socketPath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // Best effort.
      }
    }
    releaseLock();
    writeStateCritical('stop-finalize');
  }

  function installSignalHandlers() {
    const handle = () => {
      shutdown(stopDeadlineMs)
        .then(() => finalizeStop())
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    };
    process.on('SIGTERM', handle);
    process.on('SIGINT', handle);
    process.on('SIGHUP', handle);
  }

  return {
    start,
    shutdown,
    finalizeStop,
    installSignalHandlers,
    get socketPath() {
      return socketPath;
    },
    get sessionId() {
      return sessionId;
    },
    get generation() {
      return generation;
    },
    get status() {
      return status;
    },
  };
}

function cliRequest(socketPath, request, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({
        ok: false,
        code: 'guest_timeout',
        message: 'Guest supervisor did not answer within the deadline.',
      });
    }, timeoutMs);
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk, 'utf8')]);
      if (buffer.length > MAX_RESPONSE_BYTES + 1) {
        clearTimeout(timer);
        finish({
          ok: false,
          code: 'response_too_large',
          message: 'Guest supervisor response is too large.',
        });
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) {
        return;
      }
      clearTimeout(timer);
      let line = buffer.subarray(0, newline);
      if (line.length > 0 && line[line.length - 1] === 0x0d) {
        line = line.subarray(0, line.length - 1);
      }
      let parsed;
      try {
        parsed = JSON.parse(line.toString('utf8'));
      } catch {
        finish({
          ok: false,
          code: 'invalid_response',
          message: 'Guest supervisor response is not valid JSON.',
        });
        return;
      }
      finish(parsed);
    });
    socket.on('error', () => {
      clearTimeout(timer);
      finish({
        ok: false,
        code: 'supervisor_unavailable',
        message: 'Guest supervisor socket is unavailable.',
      });
    });
    socket.on('close', () => {
      if (!settled) {
        clearTimeout(timer);
        finish({
          ok: false,
          code: 'supervisor_unavailable',
          message: 'Guest supervisor closed the connection without a response.',
        });
      }
    });
  });
}

function buildRequest(command, flags) {
  const id = `${command}-${crypto.randomUUID()}`;
  switch (command) {
    case 'status':
      return { version: PROTOCOL_VERSION, id, command };
    case 'state':
      return { version: PROTOCOL_VERSION, id, command };
    case 'messages':
      return { version: PROTOCOL_VERSION, id, command };
    case 'submit':
      return {
        version: PROTOCOL_VERSION,
        id,
        command,
        requestId: requireFlag(flags, 'request-id'),
        generation: Number(requireFlag(flags, 'generation')),
        operator: parseBooleanFlag(flags, 'operator'),
        owner: flags.owner,
        chunks: flags.chunk,
      };
    case 'abort':
      return {
        version: PROTOCOL_VERSION,
        id,
        command,
        generation: Number(requireFlag(flags, 'generation')),
      };
    case 'resolve':
      return {
        version: PROTOCOL_VERSION,
        id,
        command,
        requestId: requireFlag(flags, 'request-id'),
        resolution: requireFlag(flags, 'resolution'),
      };
    case 'pause':
      return {
        version: PROTOCOL_VERSION,
        id,
        command,
        generation: Number(requireFlag(flags, 'generation')),
        owner: requireFlag(flags, 'owner'),
        abortActive: parseBooleanFlag(flags, 'abort-active'),
      };
    case 'resume':
      return {
        version: PROTOCOL_VERSION,
        id,
        command,
        generation: Number(requireFlag(flags, 'generation')),
        owner: requireFlag(flags, 'owner'),
      };
    case 'events':
      return {
        version: PROTOCOL_VERSION,
        id,
        command,
        after: Number(requireFlag(flags, 'after')),
        limit: flags.limit === undefined ? undefined : Number(flags.limit),
        waitMs: flags['wait-ms'] === undefined ? undefined : Number(flags['wait-ms']),
      };
    case 'stop':
      return {
        version: PROTOCOL_VERSION,
        id,
        command,
        deadlineMs: flags['deadline-ms'] === undefined
          ? undefined
          : Number(flags['deadline-ms']),
      };
    default:
      fail('invalid_input', 'Unknown guest supervisor command.');
  }
}

async function runDetachedSupervisor(flags) {
  const socketPath = assertGuestPath(requireFlag(flags, 'socket'), 'Socket path');
  const sessionId = assertUuid(requireFlag(flags, 'session-id'));
  const startupTimeoutMs = flags['startup-timeout-ms'] === undefined
    ? DEFAULT_STARTUP_TIMEOUT_MS
    : parseDeadline(flags, 'startup-timeout-ms', DEFAULT_STARTUP_TIMEOUT_MS, 100, MAX_DEADLINE_MS);
  const existing = await cliRequest(socketPath, {
    version: PROTOCOL_VERSION,
    id: `status-${crypto.randomUUID()}`,
    command: 'status',
  }, 2000);
  if (existing.ok === true && existing.sessionId === sessionId) {
    return {
      ok: true,
      started: false,
      alreadyRunning: true,
      sessionId,
      socketPath,
      generation: existing.generation,
      status: existing.status,
    };
  }
  const forwarded = ['supervise', '--foreground'];
  for (const key of [
    'socket', 'state', 'session-id', 'cwd', 'session-dir', 'agent-dir', 'home',
    'provider', 'model', 'pi', 'path-env', 'log', 'max-events',
    'submit-deadline-ms', 'command-deadline-ms', 'quiesce-deadline-ms',
    'stop-deadline-ms', 'startup-timeout-ms',
  ]) {
    if (flags[key] !== undefined) {
      forwarded.push(`--${key}`, String(flags[key]));
    }
  }
  let child;
  try {
    child = childProcess.spawn(process.execPath, [__filename, ...forwarded], {
      detached: true,
      stdio: 'ignore',
      env: {
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
        HOME: flags.home || process.env.HOME || '/',
      },
    });
    child.unref();
  } catch {
    return {
      ok: false,
      code: 'supervisor_start_failed',
      message: 'Guest supervisor process could not be started.',
    };
  }
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    const status = await cliRequest(socketPath, {
      version: PROTOCOL_VERSION,
      id: `status-${crypto.randomUUID()}`,
      command: 'status',
    }, 2000);
    if (status.ok === true && status.sessionId === sessionId) {
      return {
        ok: true,
        started: true,
        alreadyRunning: false,
        sessionId,
        socketPath,
        generation: status.generation,
        status: status.status,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  let logTail = null;
  if (flags.log) {
    try {
      const stat = fs.lstatSync(flags.log);
      const start = Math.max(0, stat.size - 4096);
      const fd = fs.openSync(flags.log, 'r');
      try {
        const buffer = Buffer.alloc(stat.size - start);
        fs.readSync(fd, buffer, 0, buffer.length, start);
        logTail = truncateText(buffer.toString('utf8'), 2048);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      logTail = null;
    }
  }
  return {
    ok: false,
    code: 'supervisor_start_failed',
    message: 'Guest supervisor did not become ready within the startup deadline.',
    ...(logTail === null ? {} : { logTail }),
  };
}

function printAndExit(payload, code) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exitCode = code;
}

async function main(argv) {
  const { command, flags } = parseCli(argv);
  if (command === 'supervise') {
    if (flags.foreground === true) {
      allowedFlags(flags, [
        'foreground', 'socket', 'state', 'session-id', 'cwd', 'session-dir',
        'agent-dir', 'home', 'provider', 'model', 'pi', 'path-env', 'log',
        'max-events', 'submit-deadline-ms', 'command-deadline-ms',
        'quiesce-deadline-ms', 'stop-deadline-ms', 'startup-timeout-ms',
      ]);
      const supervisor = createSupervisor({
        socketPath: requireFlag(flags, 'socket'),
        statePath: requireFlag(flags, 'state'),
        sessionId: requireFlag(flags, 'session-id'),
        cwd: requireFlag(flags, 'cwd'),
        sessionDir: requireFlag(flags, 'session-dir'),
        agentDir: requireFlag(flags, 'agent-dir'),
        guestHome: requireFlag(flags, 'home'),
        provider: requireFlag(flags, 'provider'),
        model: requireFlag(flags, 'model'),
        piExecutable: requireFlag(flags, 'pi'),
        pathEnv: requireFlag(flags, 'path-env'),
        logPath: flags.log,
        maxEvents: flags['max-events'] === undefined ? undefined : Number(flags['max-events']),
        submitDeadlineMs: flags['submit-deadline-ms'] === undefined
          ? undefined
          : Number(flags['submit-deadline-ms']),
        commandDeadlineMs: flags['command-deadline-ms'] === undefined
          ? undefined
          : Number(flags['command-deadline-ms']),
        quiesceDeadlineMs: flags['quiesce-deadline-ms'] === undefined
          ? undefined
          : Number(flags['quiesce-deadline-ms']),
        stopDeadlineMs: flags['stop-deadline-ms'] === undefined
          ? undefined
          : Number(flags['stop-deadline-ms']),
      });
      supervisor.installSignalHandlers();
      await supervisor.start();
      // Keep the resident supervisor alive until an explicit stop or signal.
      return new Promise(() => {});
    }
    allowedFlags(flags, [
      'socket', 'state', 'session-id', 'cwd', 'session-dir', 'agent-dir',
      'home', 'provider', 'model', 'pi', 'path-env', 'log', 'max-events',
      'submit-deadline-ms', 'command-deadline-ms', 'quiesce-deadline-ms',
      'stop-deadline-ms', 'startup-timeout-ms',
    ]);
    const result = await runDetachedSupervisor(flags);
    printAndExit(result, result.ok === true ? 0 : 3);
    return;
  }

  if (command === 'probe') {
    allowedFlags(flags, ['pi']);
    const piExecutable = assertGuestPath(requireFlag(flags, 'pi'), 'Pi executable');
    const child = childProcess.spawn(piExecutable, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin' },
    });
    let output = '';
    let errorOutput = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8');
      if (output.length > 4096) {
        output = output.slice(0, 4096);
      }
    });
    child.stderr.on('data', (chunk) => {
      errorOutput += chunk.toString('utf8');
      if (errorOutput.length > 4096) {
        errorOutput = errorOutput.slice(0, 4096);
      }
    });
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Reported below.
      }
    }, 10_000);
    const exitCode = await new Promise((resolve) => {
      child.once('close', (code) => resolve(Number.isInteger(code) ? code : null));
      child.once('error', () => resolve(null));
    });
    clearTimeout(timer);
    const version = output.trim().split('\n')[0].trim();
    printAndExit({
      ok: exitCode === 0 && version.length > 0,
      version: version || null,
      exitCode,
      ...(exitCode === 0 ? {} : { stderr: truncateText(errorOutput, 1024) }),
    }, exitCode === 0 && version.length > 0 ? 0 : 4);
    return;
  }

  const socketPath = assertGuestPath(requireFlag(flags, 'socket'), 'Socket path');
  const allowedByCommand = {
    status: ['socket'],
    state: ['socket'],
    messages: ['socket'],
    submit: ['socket', 'request-id', 'generation', 'operator', 'owner', 'chunk'],
    abort: ['socket', 'generation'],
    resolve: ['socket', 'request-id', 'resolution'],
    pause: ['socket', 'generation', 'owner', 'abort-active'],
    resume: ['socket', 'generation', 'owner'],
    events: ['socket', 'after', 'limit', 'wait-ms'],
    stop: ['socket', 'deadline-ms'],
  };
  if (!allowedByCommand[command]) {
    fail('invalid_input', 'Unknown guest supervisor subcommand.');
  }
  allowedFlags(flags, allowedByCommand[command]);
  const request = buildRequest(command, flags);
  const waitMs = request.waitMs === undefined ? 0 : request.waitMs;
  const timeoutMs = command === 'stop'
    ? (request.deadlineMs === undefined ? DEFAULT_STOP_DEADLINE_MS : request.deadlineMs) + 5000
    : command === 'submit'
      ? 30_000
      : Math.min(MAX_DEADLINE_MS, 10_000 + waitMs);
  const result = await cliRequest(socketPath, request, timeoutMs);
  printAndExit(result, result.ok === true ? 0 : 2);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    const code = error instanceof SupervisorError ? error.code : 'guest_error';
    const message = error instanceof SupervisorError
      ? error.message
      : 'Guest supervisor failed.';
    const details = error instanceof SupervisorError && error.details
      ? error.details
      : undefined;
    printAndExit({
      ok: false,
      code,
      message: truncateText(message, 1024),
      ...(details === undefined ? {} : { details }),
    }, 2);
  });
}

module.exports = {
  SupervisorError,
  createSupervisor,
};
