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
    try {
      const directoryFd = fs.openSync(directory, 'r');
      try {
        fs.fsyncSync(directoryFd);
      } finally {
        fs.closeSync(directoryFd);
      }
    } catch (error) {
      if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) {
        // Directory fsync is best effort; the rename already happened.
      }
    }
  } catch {
    fail('state_write_failed', 'Guest supervisor state could not be written.');
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
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
      createdAt: state && state.createdAt ? state.createdAt : nowIso(),
      updatedAt: nowIso(),
    };
  }

  function writeStateNow() {
    saveDirty = false;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const data = JSON.stringify(serializeState(), null, 2);
    try {
      writeAtomic(statePath, data);
    } catch (error) {
      lastError = { code: error.code || 'state_write_failed', message: 'State write failed.' };
    }
  }

  function scheduleSave() {
    saveDirty = true;
    if (saveTimer) {
      return;
    }
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (saveDirty) {
        writeStateNow();
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
      writeStateNow();
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
    failPending(new SupervisorError('pi_exited', 'Pi exited before completing the request.', {
      exitCode: piExitCode,
      signal: piSignal,
    }));
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
      writeStateNow();
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
    let child;
    try {
      child = childProcess.spawn(piExecutable, argv, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false,
      });
    } catch {
      fail('pi_unavailable', 'Pi could not be started inside the guest.');
    }
    piChild = child;
    piPid = child.pid || null;
    piExited = false;
    child.on('error', () => {
      lastError = { code: 'pi_unavailable', message: 'Pi process failed to start.' };
      if (!piExited) {
        piExited = true;
        failPending(new SupervisorError('pi_unavailable', 'Pi process failed to start.'));
        if (!stopping) {
          status = 'exited';
        }
        writeStateNow();
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
    writeStateNow();
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
    pendingPrompt = {
      requestId,
      generation,
      submittedAt,
      settled: false,
      uncertain: false,
      disposition: null,
      operator,
      owner,
    };
    activeTurn = {
      requestId,
      generation,
      submittedAt,
      settled: false,
      uncertain: false,
      disposition: null,
      operator,
    };
    status = 'running';
    // Imperative boundary: persist the intent before writing to Pi. A host
    // crash or lost response after this point is `uncertain`, never a retry.
    writeStateNow();

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
        writeStateNow();
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
      writeStateNow();
      throw error;
    }

    if (!response.success) {
      pendingPrompt = null;
      activeTurn = null;
      status = paused ? 'paused' : 'ready';
      writeStateNow();
      fail('guest_error', typeof response.error === 'string'
        ? truncateText(response.error, 1024)
        : 'Pi rejected the prompt.');
    }
    const disposition = response.data && response.data.disposition;
    if (typeof disposition !== 'string' || disposition.length === 0) {
      pendingPrompt = null;
      activeTurn = null;
      status = paused ? 'paused' : 'ready';
      writeStateNow();
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
    writeStateNow();
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
    if (paused) {
      if (pauseOwner !== owner) {
        fail('owner_mismatch', 'A different operator owns the paused conversation.');
      }
    } else {
      generation += 1;
      paused = true;
      pauseOwner = owner;
      status = 'paused_pending';
      // Fence the previous writer before any abort or quiescence wait.
      writeStateNow();
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
    writeStateNow();
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
    generation += 1;
    paused = false;
    pauseOwner = null;
    status = activeTurn && activeTurn.settled !== true ? 'running' : 'ready';
    writeStateNow();
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
    // Operator resolution is an explicit acknowledgement after inspecting the
    // native conversation. It never re-dispatches the prompt.
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
    writeStateNow();
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

  function acquireLock() {
    lockPath = `${statePath}.lock`;
    const payload = JSON.stringify({
      pid: process.pid,
      sessionId,
      startedAt: nowIso(),
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const fd = fs.openSync(lockPath, 'wx', 0o600);
        fs.writeFileSync(fd, payload, 'utf8');
        fs.closeSync(fd);
        return;
      } catch (error) {
        if (!error || error.code !== 'EEXIST') {
          fail('lock_failed', 'Guest supervisor lock could not be acquired.');
        }
        let existing = null;
        try {
          existing = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        } catch {
          existing = null;
        }
        if (existing && Number.isSafeInteger(existing.pid) && existing.pid !== process.pid) {
          try {
            process.kill(existing.pid, 0);
            fail('already_running', 'A guest supervisor already owns this session.');
          } catch (probeError) {
            if (probeError && probeError.code !== 'ESRCH') {
              fail('already_running', 'A guest supervisor already owns this session.');
            }
          }
        }
        try {
          fs.unlinkSync(lockPath);
        } catch (unlinkError) {
          if (unlinkError.code !== 'ENOENT') {
            fail('lock_failed', 'A stale guest supervisor lock could not be cleared.');
          }
        }
      }
    }
    fail('lock_failed', 'Guest supervisor lock could not be acquired.');
  }

  function releaseLock() {
    if (!lockPath) {
      return;
    }
    try {
      fs.unlinkSync(lockPath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // Best effort.
      }
    }
    lockPath = null;
  }

  function loadOrCreateState() {
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
    loadOrCreateState();
    writeStateNow();
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
      writeStateNow();
      await shutdown(stopDeadlineMs);
      await finalizeStop();
      throw error;
    }
    status = paused
      ? 'paused'
      : activeTurn && activeTurn.settled !== true
        ? 'uncertain'
        : 'ready';
    writeStateNow();
    logLine(logPath, `supervisor ready session=${sessionId} generation=${generation} pid=${process.pid}`);
  }

  async function shutdown(deadlineMs) {
    if (stoppingResult) {
      return stoppingResult;
    }
    stopping = true;
    status = 'stopping';
    writeStateNow();
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
      writeStateNow();
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
    writeStateNow();
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
    writeStateNow();
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
