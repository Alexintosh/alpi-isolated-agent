'use strict';

/**
 * Pi 1.6 harness adapter for Alpi.
 *
 * Boundary rules (imperative for integration):
 * 1. This module never executes guest code on the host. It requires an injected
 *    `exec` function that declares `guestOnly === true`; every guest operation
 *    is a checked argv array passed to that function. There is no shell, no
 *    local spawn, no host path access and no remote package execution here.
 * 2. The caller must persist submission intent before calling `submit()`.
 *    A prompt whose acknowledgement is lost is returned as `uncertain`; this
 *    adapter never retries a prompt. `resolveUncertain()` is an explicit
 *    operator acknowledgement after inspecting the native conversation.
 * 3. Harness and model are separate choices. The adapter is constructed with an
 *    operator-selected provider and guest paths; `createSession()` takes the
 *    model id separately. Neither an agent nor a remote request supplies host
 *    paths, credentials or a model server URL.
 * 4. All guest responses, events, messages and error strings are untrusted.
 *    Orchestration must label them as guest-produced input.
 * 5. Pause/resume is a fencing boundary. The guest supervisor increments its
 *    writer generation on pause and again on resume. A stale writer generation
 *    is refused; a handoff that cannot prove quiescence is reported as
 *    `quiesce_unconfirmed` and remains pending.
 * 6. Every guest call has a bounded deadline. Cleanup can be reported as
 *    unverified; callers must not claim termination without observing it.
 */

const crypto = require('node:crypto');
const path = require('node:path');

const PI_HARNESS_ID = 'pi';
const PI_VERSION = '1.6.0';
const PROTOCOL_VERSION = 1;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const NAME_PATTERN = /^[A-Za-z0-9._:/+-]{1,128}$/;
const OWNER_PATTERN = /^[A-Za-z0-9._:@/-]{1,64}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

const MAX_SOCKET_PATH_BYTES = 100;
const MAX_MESSAGE_BYTES = 60_000;
const MAX_CHUNK_BYTES = 3_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
const DEFAULT_SUBMIT_DEADLINE_MS = 15_000;
const DEFAULT_QUIESCE_DEADLINE_MS = 10_000;
const DEFAULT_STOP_DEADLINE_MS = 8_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_SETTLE_TIMEOUT_MS = 120_000;
const MAX_DEADLINE_MS = 600_000;
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_EVENTS = 512;
const MAX_ACCUMULATED_EVENTS = 2_000;

const HOST_PATH_PREFIXES = Object.freeze([
  '/Users/',
  '/private/',
  '/Volumes/',
  '/System/',
  '/Applications/',
]);

const PI_CAPABILITIES = Object.freeze([
  'session-create',
  'session-resume',
  'submit',
  'observe',
  'cancel',
  'conversation-join',
  'pause-quiesce',
  'operator-send',
  'durable-reconnect',
  'model-selection',
  'guest-tools',
  'uncertainty-resolution',
]);

class PiHarnessError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'PiHarnessError';
    this.code = code;
    this.harnessId = PI_HARNESS_ID;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

function fail(code, message, details) {
  throw new PiHarnessError(code, message, details);
}

function truncateText(value, maxBytes) {
  if (typeof value !== 'string') {
    return value;
  }
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) {
    return value;
  }
  return Buffer.from(value, 'utf8').subarray(0, maxBytes).toString('utf8');
}

function assertGuestPath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    fail('invalid_config', `${label} must be a non-empty guest path.`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    fail('invalid_config', `${label} contains control characters.`);
  }
  if (!value.startsWith('/') || value.includes('\\') || /^[A-Za-z]:/.test(value)) {
    fail('invalid_config', `${label} must be an absolute POSIX guest path.`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value && normalized !== value.replace(/\/+$/, '')) {
    fail('invalid_config', `${label} must be a normalized guest path.`);
  }
  if (normalized.split('/').includes('..')) {
    fail('invalid_config', `${label} must not contain '..'.`);
  }
  if (HOST_PATH_PREFIXES.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix))) {
    fail('host_path_forbidden', `${label} looks like a host path; operator guest config is required.`);
  }
  return normalized;
}

function assertUuid(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    fail('invalid_input', 'Session id must be a Pi native UUID.');
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

function assertRequestId(value) {
  if (typeof value !== 'string' || !REQUEST_ID_PATTERN.test(value)) {
    fail('invalid_input', 'requestId is invalid.');
  }
  return value;
}

function normalizeModel(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string' || !NAME_PATTERN.test(value)) {
    fail('invalid_input', 'model must be a valid model id.');
  }
  return value;
}

function splitMessage(message) {
  if (typeof message !== 'string' || message.length === 0) {
    fail('invalid_input', 'message must be a non-empty string.');
  }
  if (message.includes('\u0000')) {
    fail('invalid_input', 'message must not contain NUL.');
  }
  const total = Buffer.byteLength(message, 'utf8');
  if (total > MAX_MESSAGE_BYTES) {
    fail('message_too_large', 'message exceeds the bounded guest argv limit.', {
      maxBytes: MAX_MESSAGE_BYTES,
    });
  }
  const chunks = [];
  let current = '';
  let currentBytes = 0;
  for (const character of message) {
    const bytes = Buffer.byteLength(character, 'utf8');
    if (currentBytes + bytes > MAX_CHUNK_BYTES && current.length > 0) {
      chunks.push(current);
      current = '';
      currentBytes = 0;
    }
    current += character;
    currentBytes += bytes;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

function assertExec(exec) {
  if (typeof exec !== 'function') {
    fail('host_exec_forbidden', 'An injected guest-only exec function is required.');
  }
  if (exec.guestOnly !== true) {
    fail(
      'host_exec_forbidden',
      'The injected exec must declare guestOnly === true; guest code must not run on the host.'
    );
  }
}

function validateExecResult(result, maxOutputBytes) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    fail('protocol_error', 'Guest exec returned an invalid result.');
  }
  if (!Number.isInteger(result.exitCode)) {
    fail('protocol_error', 'Guest exec returned an invalid exit code.');
  }
  if (typeof result.stdout !== 'string' || typeof result.stderr !== 'string') {
    fail('protocol_error', 'Guest exec returned invalid streams.');
  }
  if (Buffer.byteLength(result.stdout, 'utf8') > maxOutputBytes) {
    fail('guest_output_truncated', 'Guest stdout exceeded the bounded size.');
  }
  if (result.cancelled === true) {
    fail('guest_cancelled', 'Guest command was cancelled.');
  }
  if (result.timedOut === true) {
    fail('guest_timeout', 'Guest command exceeded its deadline.');
  }
  if (result.truncated === true) {
    fail('guest_output_truncated', 'Guest command output was truncated.');
  }
  return result;
}

function guestError(payload) {
  const guestCode = typeof payload.code === 'string' ? payload.code : null;
  const code = guestCode && /^[a-z][a-z0-9_]{1,63}$/.test(guestCode)
    ? guestCode
    : 'guest_error';
  const guestMessage = typeof payload.message === 'string'
    ? truncateText(payload.message, 1024)
    : 'Guest supervisor rejected the request.';
  const details = {
    guestCode,
    guestMessage,
    // Guest-supplied details are untrusted data, never control input.
    guestDetails: payload.details === undefined ? null : payload.details,
  };
  throw new PiHarnessError(code, 'Guest supervisor rejected the request.', details);
}

function parseGuestResponse(result, maxOutputBytes) {
  validateExecResult(result, maxOutputBytes);
  if (result.exitCode !== 0 && result.stdout.trim().length === 0) {
    fail('guest_error', 'Guest command failed without a protocol response.', {
      guestMessage: truncateText(result.stderr, 1024),
    });
  }
  const lines = result.stdout
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
    .filter((line) => line.trim().length > 0);
  if (lines.length !== 1) {
    fail('protocol_error', 'Guest command must emit exactly one JSON response line.', {
      lineCount: lines.length,
    });
  }
  let payload;
  try {
    payload = JSON.parse(lines[0]);
  } catch {
    fail('protocol_error', 'Guest command response is not valid JSON.');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('protocol_error', 'Guest command response has an invalid shape.');
  }
  if (payload.ok === false) {
    guestError(payload);
  }
  if (payload.ok !== true) {
    fail('protocol_error', 'Guest command response did not report ok.');
  }
  if (result.exitCode !== 0) {
    fail('protocol_error', 'Guest command reported ok with a non-zero exit code.');
  }
  return payload;
}

/**
 * Create a Pi harness adapter.
 *
 * @param {{
 *   exec: Function & { guestOnly: true },
 *   supervisorScript: string,
 *   nodeExecutable: string,
 *   workspaceDir: string,
 *   sessionDir: string,
 *   agentDir: string,
 *   socketDir: string,
 *   guestHome: string,
 *   piExecutable?: string,
 *   provider: string,
 *   model?: string,
 *   expectedPiVersion?: string|null,
 *   pathEnv?: string,
 *   commandTimeoutMs?: number,
 *   submitDeadlineMs?: number,
 *   quiesceDeadlineMs?: number,
 *   stopDeadlineMs?: number,
 *   startupTimeoutMs?: number,
 *   maxEvents?: number,
 *   maxOutputBytes?: number
 * }} options
 */
function createPiHarness(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    fail('invalid_config', 'Pi harness options must be an object.');
  }
  const exec = options.exec;
  assertExec(exec);

  const supervisorScript = assertGuestPath(options.supervisorScript, 'supervisorScript');
  const nodeExecutable = assertGuestPath(options.nodeExecutable, 'nodeExecutable');
  const workspaceDir = assertGuestPath(options.workspaceDir, 'workspaceDir');
  const sessionDir = assertGuestPath(options.sessionDir, 'sessionDir');
  const agentDir = assertGuestPath(options.agentDir, 'agentDir');
  const socketDir = assertGuestPath(options.socketDir, 'socketDir');
  const guestHome = assertGuestPath(options.guestHome, 'guestHome');
  const provider = assertName(options.provider, 'provider');
  const defaultModel = normalizeModel(options.model);

  const piExecutable = assertGuestPath(
    options.piExecutable === undefined
      ? process.env.ALPI_PI_BIN
      : options.piExecutable,
    'piExecutable'
  );
  if (!piExecutable) {
    fail('invalid_config', 'piExecutable is required (or set ALPI_PI_BIN).');
  }

  let expectedPiVersion;
  if (options.expectedPiVersion === undefined) {
    expectedPiVersion = PI_VERSION;
  } else if (options.expectedPiVersion === null || typeof options.expectedPiVersion === 'string') {
    expectedPiVersion = options.expectedPiVersion;
  } else {
    fail('invalid_config', 'expectedPiVersion must be a string or null.');
  }

  const pathEnv = options.pathEnv === undefined
    ? '/usr/local/bin:/usr/bin:/bin'
    : options.pathEnv;
  if (
    typeof pathEnv !== 'string' ||
    pathEnv.length === 0 ||
    pathEnv.length > 4096 ||
    /[\u0000-\u001f\u007f]/.test(pathEnv)
  ) {
    fail('invalid_config', 'pathEnv is invalid.');
  }

  const commandTimeoutMs = options.commandTimeoutMs === undefined
    ? DEFAULT_COMMAND_TIMEOUT_MS
    : assertInteger(options.commandTimeoutMs, 100, MAX_DEADLINE_MS, 'commandTimeoutMs');
  const submitDeadlineMs = options.submitDeadlineMs === undefined
    ? DEFAULT_SUBMIT_DEADLINE_MS
    : assertInteger(options.submitDeadlineMs, 100, MAX_DEADLINE_MS, 'submitDeadlineMs');
  const quiesceDeadlineMs = options.quiesceDeadlineMs === undefined
    ? DEFAULT_QUIESCE_DEADLINE_MS
    : assertInteger(options.quiesceDeadlineMs, 100, MAX_DEADLINE_MS, 'quiesceDeadlineMs');
  const stopDeadlineMs = options.stopDeadlineMs === undefined
    ? DEFAULT_STOP_DEADLINE_MS
    : assertInteger(options.stopDeadlineMs, 100, MAX_DEADLINE_MS, 'stopDeadlineMs');
  const startupTimeoutMs = options.startupTimeoutMs === undefined
    ? DEFAULT_STARTUP_TIMEOUT_MS
    : assertInteger(options.startupTimeoutMs, 100, MAX_DEADLINE_MS, 'startupTimeoutMs');
  const maxEvents = options.maxEvents === undefined
    ? DEFAULT_MAX_EVENTS
    : assertInteger(options.maxEvents, 16, 4096, 'maxEvents');
  const maxOutputBytes = options.maxOutputBytes === undefined
    ? DEFAULT_MAX_OUTPUT_BYTES
    : assertInteger(options.maxOutputBytes, 4096, 8 * 1024 * 1024, 'maxOutputBytes');

  const sessions = new Map();
  let probeResult = null;
  let closed = false;

  function requireOpen() {
    if (closed) {
      fail('harness_closed', 'Pi harness adapter is closed.');
    }
  }

  function sessionPaths(sessionId) {
    const socketPath = `${socketDir}/pi-${sessionId}.sock`;
    if (Buffer.byteLength(socketPath, 'utf8') > MAX_SOCKET_PATH_BYTES) {
      fail('socket_path_too_long', 'Guest socket path is too long for a Unix socket.', {
        socketPath,
      });
    }
    return {
      socketPath,
      statePath: `${socketDir}/pi-${sessionId}.state.json`,
      logPath: `${socketDir}/pi-${sessionId}.log`,
    };
  }

  async function execGuest(argv, { timeoutMs, maxOutputBytes: outputLimit, label }) {
    let result;
    try {
      result = await exec({
        argv,
        cwd: workspaceDir,
        timeoutMs,
        maxOutputBytes: outputLimit === undefined ? maxOutputBytes : outputLimit,
      });
    } catch (error) {
      fail('guest_exec_failed', `${label || 'Guest command'} could not be executed.`, {
        cause: error instanceof Error ? truncateText(error.message, 512) : null,
      });
    }
    return result;
  }

  function flagArguments(fields) {
    const args = [];
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) {
        continue;
      }
      if (value === true) {
        args.push(`--${key}`);
      } else {
        args.push(`--${key}`, String(value));
      }
    }
    return args;
  }

  async function callSupervisor(command, fields, timeoutMs) {
    requireOpen();
    const argv = [
      nodeExecutable,
      supervisorScript,
      command,
      '--socket',
      fields.socketPath || '',
      ...flagArguments(
        Object.fromEntries(
          Object.entries(fields).filter(([key]) => key !== 'socketPath' && key !== 'chunk')
        )
      ),
    ];
    if (Array.isArray(fields.chunk)) {
      for (const chunk of fields.chunk) {
        argv.push('--chunk', chunk);
      }
    }
    const result = await execGuest(argv, {
      timeoutMs,
      label: `guest supervisor ${command}`,
    });
    return parseGuestResponse(result, maxOutputBytes);
  }

  async function readStatus(paths) {
    try {
      return await callSupervisor(
        'status',
        { socketPath: paths.socketPath },
        Math.min(commandTimeoutMs, 5_000)
      );
    } catch (error) {
      if (error instanceof PiHarnessError && error.code === 'supervisor_unavailable') {
        return null;
      }
      throw error;
    }
  }

  function verifyStatus(status, expected) {
    if (status.protocolVersion !== PROTOCOL_VERSION) {
      fail('protocol_error', 'Guest supervisor protocol version does not match.');
    }
    if (status.sessionId !== expected.sessionId) {
      fail('session_identity_mismatch', 'Guest supervisor session id does not match.', {
        expectedSessionId: expected.sessionId,
        receivedSessionId: typeof status.sessionId === 'string' ? status.sessionId : null,
      });
    }
    if (status.cwd !== workspaceDir) {
      fail('session_identity_mismatch', 'Guest supervisor working directory does not match.', {
        expectedWorkspace: workspaceDir,
        receivedWorkspace: typeof status.cwd === 'string' ? status.cwd : null,
      });
    }
    if (status.socketPath !== expected.paths.socketPath ||
      status.statePath !== expected.paths.statePath) {
      fail('session_identity_mismatch', 'Guest supervisor paths do not match the requested session.');
    }
    if (status.provider !== provider) {
      fail('provider_mismatch', 'Guest supervisor provider does not match the operator configuration.', {
        expectedProvider: provider,
        receivedProvider: typeof status.provider === 'string' ? status.provider : null,
      });
    }
    if (status.model !== expected.model) {
      fail('model_mismatch', 'Guest supervisor model does not match the requested model.', {
        expectedModel: expected.model,
        receivedModel: typeof status.model === 'string' ? status.model : null,
      });
    }
    assertInteger(status.generation, 1, 1_000_000_000, 'generation');
    if (typeof status.status !== 'string') {
      fail('protocol_error', 'Guest supervisor did not report a lifecycle status.');
    }
    return status;
  }

  function supervisorStartArgv(paths, sessionId, model) {
    return [
      nodeExecutable,
      supervisorScript,
      'supervise',
      '--socket', paths.socketPath,
      '--state', paths.statePath,
      '--session-id', sessionId,
      '--cwd', workspaceDir,
      '--session-dir', sessionDir,
      '--agent-dir', agentDir,
      '--home', guestHome,
      '--provider', provider,
      '--model', model,
      '--pi', piExecutable,
      '--path-env', pathEnv,
      '--log', paths.logPath,
      '--max-events', String(maxEvents),
      '--submit-deadline-ms', String(submitDeadlineMs),
      '--command-deadline-ms', String(commandTimeoutMs),
      '--quiesce-deadline-ms', String(quiesceDeadlineMs),
      '--stop-deadline-ms', String(stopDeadlineMs),
      '--startup-timeout-ms', String(startupTimeoutMs),
    ];
  }

  async function startSupervisor(paths, sessionId, model) {
    const argv = supervisorStartArgv(paths, sessionId, model);
    const result = await execGuest(argv, {
      timeoutMs: startupTimeoutMs + 5_000,
      label: 'guest supervisor start',
    });
    let payload;
    try {
      payload = parseGuestResponse(result, maxOutputBytes);
    } catch (error) {
      if (error instanceof PiHarnessError && error.code === 'supervisor_start_failed') {
        throw error;
      }
      throw error;
    }
    if (payload.ok !== true) {
      fail('supervisor_start_failed', 'Guest supervisor did not start.');
    }
    if (payload.sessionId !== sessionId) {
      fail('session_identity_mismatch', 'Guest supervisor reported a different session id.');
    }
    return payload;
  }

  async function ensureSupervisor(paths, sessionId, model, { allowStart }) {
    let status = await readStatus(paths);
    let resumed = false;
    if (status) {
      resumed = true;
    } else if (allowStart) {
      await startSupervisor(paths, sessionId, model);
      status = await readStatus(paths);
      if (!status) {
        fail('supervisor_unavailable', 'Guest supervisor did not become reachable.');
      }
    } else {
      fail('supervisor_unavailable', 'Guest supervisor is not running for this session.');
    }
    verifyStatus(status, { sessionId, paths, model });
    return { status, resumed: resumed || status.resumed === true };
  }

  async function verifyPiState(sessionId) {
    const payload = await callSupervisor(
      'state',
      { socketPath: sessionPaths(sessionId).socketPath },
      commandTimeoutMs + 5_000
    );
    if (!payload.state || typeof payload.state !== 'object') {
      fail('protocol_error', 'Guest supervisor returned no Pi state.');
    }
    if (payload.state.sessionId !== sessionId) {
      fail('session_identity_mismatch', 'Pi native session id does not match.', {
        expectedSessionId: sessionId,
        receivedSessionId: typeof payload.state.sessionId === 'string'
          ? payload.state.sessionId
          : null,
      });
    }
    return payload;
  }

  function identity(sessionId, session, status) {
    const activeTurn = status.activeTurn && typeof status.activeTurn === 'object'
      ? status.activeTurn
      : null;
    const pendingPrompt = status.pendingPrompt && typeof status.pendingPrompt === 'object'
      ? status.pendingPrompt
      : null;
    return {
      harnessId: PI_HARNESS_ID,
      nativeSessionId: sessionId,
      workspaceDir,
      sessionDir,
      agentDir,
      socketPath: session.socketPath,
      statePath: session.statePath,
      provider,
      model: session.model,
      generation: session.generation,
      paused: session.paused === true,
      pauseOwner: session.pauseOwner === null ? null : session.pauseOwner,
      status: typeof status.status === 'string' ? status.status : session.status,
      activeTurn,
      pendingPrompt,
      uncertain: (activeTurn && activeTurn.uncertain === true) ||
        (pendingPrompt && pendingPrompt.uncertain === true),
      resumed: session.resumed === true,
      // Guest-produced state is untrusted and must be labelled downstream.
      guestData: true,
    };
  }

  function requireSession(sessionId) {
    const normalized = assertUuid(sessionId);
    const session = sessions.get(normalized);
    if (!session) {
      fail('session_not_attached', 'Call createSession() or resumeSession() before this operation.', {
        nativeSessionId: normalized,
      });
    }
    return session;
  }

  const adapter = {
    id: PI_HARNESS_ID,

    async probe() {
      requireOpen();
      if (probeResult) {
        return probeResult;
      }
      let result;
      try {
        result = await exec({
          argv: [piExecutable, '--version'],
          cwd: workspaceDir,
          timeoutMs: Math.min(commandTimeoutMs, 10_000),
          maxOutputBytes: 4096,
        });
      } catch {
        probeResult = Object.freeze({
          available: false,
          version: null,
          capabilities: Object.freeze([]),
          reason: 'pi_unavailable',
        });
        return probeResult;
      }
      if (!result || typeof result !== 'object' || !Number.isInteger(result.exitCode) ||
        typeof result.stdout !== 'string') {
        probeResult = Object.freeze({
          available: false,
          version: null,
          capabilities: Object.freeze([]),
          reason: 'pi_invalid_result',
        });
        return probeResult;
      }
      if (result.exitCode !== 0 || result.timedOut === true || result.truncated === true) {
        probeResult = Object.freeze({
          available: false,
          version: null,
          capabilities: Object.freeze([]),
          reason: 'pi_unavailable',
        });
        return probeResult;
      }
      const version = result.stdout.trim().split('\n')[0].trim();
      if (!VERSION_PATTERN.test(version)) {
        probeResult = Object.freeze({
          available: false,
          version: null,
          capabilities: Object.freeze([]),
          reason: 'pi_version_invalid',
        });
        return probeResult;
      }
      if (expectedPiVersion !== null && version !== expectedPiVersion) {
        probeResult = Object.freeze({
          available: false,
          version,
          capabilities: Object.freeze([]),
          reason: 'version_mismatch',
        });
        return probeResult;
      }
      probeResult = Object.freeze({
        available: true,
        version,
        capabilities: PI_CAPABILITIES,
      });
      return probeResult;
    },

    async createSession(spec = {}) {
      requireOpen();
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        fail('invalid_input', 'createSession requires an object.');
      }
      const sessionId = spec.sessionId === undefined
        ? crypto.randomUUID()
        : assertUuid(spec.sessionId);
      const model = normalizeModel(spec.model === undefined ? defaultModel : spec.model);
      if (!model) {
        fail('invalid_input', 'A model id is required and is separate from the harness choice.');
      }
      if (sessions.has(sessionId)) {
        const existing = sessions.get(sessionId);
        if (existing.model !== model) {
          fail('model_mismatch', 'The attached session uses a different model.', {
            expectedModel: existing.model,
            receivedModel: model,
          });
        }
        return identity(sessionId, existing, existing.lastStatus || {
          status: existing.status,
          activeTurn: null,
          pendingPrompt: null,
        });
      }
      const paths = sessionPaths(sessionId);
      const { status, resumed } = await ensureSupervisor(paths, sessionId, model, { allowStart: true });
      const statePayload = await verifyPiState(sessionId);
      const session = {
        socketPath: paths.socketPath,
        statePath: paths.statePath,
        model,
        generation: status.generation,
        paused: status.paused === true,
        pauseOwner: typeof status.pauseOwner === 'string' ? status.pauseOwner : null,
        status: status.status,
        resumed,
        lastStatus: status,
        lastState: statePayload.state,
      };
      sessions.set(sessionId, session);
      return identity(sessionId, session, status);
    },

    async resumeSession(spec = {}) {
      requireOpen();
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        fail('invalid_input', 'resumeSession requires an object.');
      }
      const sessionId = assertUuid(spec.nativeSessionId);
      const model = normalizeModel(spec.model === undefined ? defaultModel : spec.model);
      if (!model) {
        fail('invalid_input', 'A model id is required to resume a Pi session.');
      }
      const paths = sessionPaths(sessionId);
      const { status } = await ensureSupervisor(paths, sessionId, model, { allowStart: true });
      if (spec.generation !== undefined) {
        const generation = assertInteger(spec.generation, 1, 1_000_000_000, 'generation');
        if (generation !== status.generation) {
          fail('generation_mismatch', 'Supervisor writer generation does not match.', {
            expectedGeneration: generation,
            receivedGeneration: status.generation,
          });
        }
      }
      const statePayload = await verifyPiState(sessionId);
      const session = {
        socketPath: paths.socketPath,
        statePath: paths.statePath,
        model,
        generation: status.generation,
        paused: status.paused === true,
        pauseOwner: typeof status.pauseOwner === 'string' ? status.pauseOwner : null,
        status: status.status,
        resumed: true,
        lastStatus: status,
        lastState: statePayload.state,
      };
      sessions.set(sessionId, session);
      return identity(sessionId, session, status);
    },

    async submit(spec = {}) {
      requireOpen();
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        fail('invalid_input', 'submit requires an object.');
      }
      const sessionId = assertUuid(spec.nativeSessionId);
      const session = requireSession(sessionId);
      const requestId = assertRequestId(spec.requestId);
      const generation = assertInteger(spec.generation, 1, 1_000_000_000, 'generation');
      const operator = spec.operator === true;
      const owner = spec.owner === undefined ? null : assertOwner(spec.owner);
      if (generation !== session.generation) {
        fail('stale_writer', 'Writer generation is stale.', {
          expectedGeneration: session.generation,
          receivedGeneration: generation,
        });
      }
      if (session.paused && !operator) {
        fail('paused', 'The conversation is paused for an operator handoff.');
      }
      if (operator && !session.paused) {
        fail('not_paused', 'Operator input requires a paused conversation.');
      }
      const chunks = splitMessage(spec.message);
      let payload;
      try {
        payload = await callSupervisor(
          'submit',
          {
            socketPath: session.socketPath,
            'request-id': requestId,
            generation,
            operator: operator ? true : undefined,
            owner: owner === null ? undefined : owner,
            chunk: chunks,
          },
          submitDeadlineMs + 5_000
        );
      } catch (error) {
        if (error instanceof PiHarnessError &&
          ['guest_timeout', 'guest_exec_failed', 'protocol_error',
            'guest_output_truncated', 'guest_cancelled', 'pi_exited'].includes(error.code)) {
          // The command crossed the guest boundary but no trustworthy
          // acknowledgement came back. Never retry the prompt.
          session.status = 'uncertain';
          return {
            harnessId: PI_HARNESS_ID,
            nativeSessionId: sessionId,
            requestId,
            generation,
            accepted: false,
            duplicate: false,
            uncertain: true,
            settled: false,
            disposition: null,
            code: 'prompt_uncertain',
            reason: error.code,
            guestData: true,
          };
        }
        throw error;
      }
      if (payload.generation !== undefined && payload.generation !== generation) {
        fail('generation_mismatch', 'Guest supervisor changed generation during submit.', {
          expectedGeneration: generation,
          receivedGeneration: payload.generation,
        });
      }
      if (payload.accepted === true) {
        session.status = payload.settled === true ? 'settled' : 'running';
      }
      if (payload.uncertain === true) {
        session.status = 'uncertain';
      }
      return {
        harnessId: PI_HARNESS_ID,
        nativeSessionId: sessionId,
        requestId,
        generation,
        accepted: payload.accepted === true,
        duplicate: payload.duplicate === true,
        uncertain: payload.uncertain === true,
        settled: payload.settled === true,
        disposition: typeof payload.disposition === 'string' ? payload.disposition : null,
        code: typeof payload.code === 'string' ? payload.code : null,
        guestData: true,
      };
    },

    async resolveUncertain(spec = {}) {
      requireOpen();
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        fail('invalid_input', 'resolveUncertain requires an object.');
      }
      const sessionId = assertUuid(spec.nativeSessionId);
      const session = requireSession(sessionId);
      const requestId = assertRequestId(spec.requestId);
      if (spec.resolution !== 'settled' && spec.resolution !== 'rejected') {
        fail('invalid_input', 'resolution must be settled or rejected.');
      }
      const payload = await callSupervisor(
        'resolve',
        {
          socketPath: session.socketPath,
          'request-id': requestId,
          resolution: spec.resolution,
        },
        commandTimeoutMs + 5_000
      );
      session.status = payload.paused === true ? 'paused' : 'settled';
      return {
        harnessId: PI_HARNESS_ID,
        nativeSessionId: sessionId,
        requestId,
        resolution: spec.resolution,
        resolved: payload.resolved === true,
        settled: payload.settled === true,
        generation: session.generation,
        guestData: true,
      };
    },

    async waitSettled(spec = {}) {
      requireOpen();
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        fail('invalid_input', 'waitSettled requires an object.');
      }
      const sessionId = assertUuid(spec.nativeSessionId);
      const session = requireSession(sessionId);
      let after = spec.after === undefined
        ? 0
        : assertInteger(spec.after, 0, 1_000_000_000, 'after');
      const deadlineMs = spec.deadlineMs === undefined
        ? DEFAULT_SETTLE_TIMEOUT_MS
        : assertInteger(spec.deadlineMs, 1, MAX_DEADLINE_MS, 'deadlineMs');
      const limit = spec.limit === undefined
        ? Math.min(200, maxEvents)
        : assertInteger(spec.limit, 1, maxEvents, 'limit');
      const startedAt = Date.now();
      const deadline = startedAt + deadlineMs;
      const collected = [];
      let gap = false;
      let earliestSeq = null;
      let last = null;
      let truncated = false;
      while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          return {
            harnessId: PI_HARNESS_ID,
            nativeSessionId: sessionId,
            settled: false,
            uncertain: last ? last.uncertain === true : false,
            status: last ? last.status : session.status,
            events: collected,
            nextSeq: after,
            earliestSeq,
            gap,
            deadlineExceeded: true,
            exited: last ? last.status === 'exited' || last.status === 'stopped' : false,
            activeTurn: last ? last.activeTurn : null,
            generation: last ? last.generation : session.generation,
            guestData: true,
          };
        }
        const waitMs = Math.min(1_000, Math.max(1, remaining));
        last = await callSupervisor(
          'events',
          {
            socketPath: session.socketPath,
            after,
            limit,
            'wait-ms': waitMs,
          },
          waitMs + commandTimeoutMs + 5_000
        );
        if (last.gap === true) {
          gap = true;
        }
        if (Number.isSafeInteger(last.earliestSeq)) {
          earliestSeq = last.earliestSeq;
        }
        if (Array.isArray(last.events)) {
          for (const event of last.events) {
            if (event && typeof event === 'object' && !Array.isArray(event)) {
              collected.push(event);
            }
          }
        }
        if (Number.isSafeInteger(last.nextSeq)) {
          after = last.nextSeq;
        }
        if (collected.length >= MAX_ACCUMULATED_EVENTS) {
          truncated = true;
        }
        const exited = last.status === 'exited' || last.status === 'stopped';
        if (last.settled === true && !exited) {
          return {
            harnessId: PI_HARNESS_ID,
            nativeSessionId: sessionId,
            settled: true,
            uncertain: last.uncertain === true,
            status: last.status,
            events: collected,
            nextSeq: after,
            earliestSeq,
            gap,
            deadlineExceeded: false,
            exited: false,
            truncated,
            activeTurn: last.activeTurn || null,
            generation: last.generation,
            guestData: true,
          };
        }
        if (exited) {
          return {
            harnessId: PI_HARNESS_ID,
            nativeSessionId: sessionId,
            settled: false,
            uncertain: last.uncertain === true,
            status: last.status,
            events: collected,
            nextSeq: after,
            earliestSeq,
            gap,
            deadlineExceeded: false,
            exited: true,
            truncated,
            activeTurn: last.activeTurn || null,
            generation: last.generation,
            guestData: true,
          };
        }
        if (truncated) {
          return {
            harnessId: PI_HARNESS_ID,
            nativeSessionId: sessionId,
            settled: false,
            uncertain: last.uncertain === true,
            status: last.status,
            events: collected,
            nextSeq: after,
            earliestSeq,
            gap,
            deadlineExceeded: false,
            exited: false,
            truncated: true,
            activeTurn: last.activeTurn || null,
            generation: last.generation,
            guestData: true,
          };
        }
      }
    },

    async getState(spec = {}) {
      requireOpen();
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        fail('invalid_input', 'getState requires an object.');
      }
      const sessionId = assertUuid(spec.nativeSessionId);
      const session = requireSession(sessionId);
      const payload = await callSupervisor(
        'state',
        { socketPath: session.socketPath },
        commandTimeoutMs + 5_000
      );
      if (!payload.state || typeof payload.state !== 'object') {
        fail('protocol_error', 'Guest supervisor returned no Pi state.');
      }
      if (payload.state.sessionId !== sessionId) {
        fail('session_identity_mismatch', 'Pi native session id does not match.', {
          expectedSessionId: sessionId,
          receivedSessionId: typeof payload.state.sessionId === 'string'
            ? payload.state.sessionId
            : null,
        });
      }
      session.lastState = payload.state;
      session.status = typeof payload.status === 'string' ? payload.status : session.status;
      return {
        harnessId: PI_HARNESS_ID,
        nativeSessionId: sessionId,
        ...payload.state,
        generation: session.generation,
        paused: session.paused,
        status: session.status,
        guestData: true,
      };
    },

    async getMessages(spec = {}) {
      requireOpen();
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        fail('invalid_input', 'getMessages requires an object.');
      }
      const sessionId = assertUuid(spec.nativeSessionId);
      const session = requireSession(sessionId);
      const payload = await callSupervisor(
        'messages',
        { socketPath: session.socketPath },
        commandTimeoutMs + 5_000
      );
      if (payload.sessionId !== sessionId) {
        fail('session_identity_mismatch', 'Pi native session id does not match.');
      }
      if (!Array.isArray(payload.messages)) {
        fail('protocol_error', 'Guest supervisor returned invalid messages.');
      }
      return {
        harnessId: PI_HARNESS_ID,
        nativeSessionId: sessionId,
        messages: payload.messages,
        count: payload.count,
        // Guest conversation content is untrusted input to orchestration.
        guestData: true,
      };
    },

    async abort(spec = {}) {
      requireOpen();
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        fail('invalid_input', 'abort requires an object.');
      }
      const sessionId = assertUuid(spec.nativeSessionId);
      const session = requireSession(sessionId);
      const generation = assertInteger(spec.generation, 1, 1_000_000_000, 'generation');
      if (generation !== session.generation) {
        fail('stale_writer', 'Writer generation is stale.', {
          expectedGeneration: session.generation,
          receivedGeneration: generation,
        });
      }
      const payload = await callSupervisor(
        'abort',
        { socketPath: session.socketPath, generation },
        quiesceDeadlineMs + commandTimeoutMs + 5_000
      );
      if (payload.settled === true && payload.quiescent === true) {
        session.status = 'settled';
      }
      return {
        harnessId: PI_HARNESS_ID,
        nativeSessionId: sessionId,
        generation: session.generation,
        aborted: payload.aborted === true,
        alreadySettled: payload.alreadySettled === true,
        settled: payload.settled === true,
        quiescent: payload.quiescent === true,
        uncertain: payload.uncertain === true,
        verified: payload.verified === true,
        isStreaming: payload.isStreaming === undefined ? null : payload.isStreaming,
        code: typeof payload.code === 'string' ? payload.code : null,
        guestData: true,
      };
    },

    async pause(spec = {}) {
      requireOpen();
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        fail('invalid_input', 'pause requires an object.');
      }
      const sessionId = assertUuid(spec.nativeSessionId);
      const session = requireSession(sessionId);
      const generation = assertInteger(spec.generation, 1, 1_000_000_000, 'generation');
      const owner = assertOwner(spec.owner);
      if (generation !== session.generation) {
        fail('stale_writer', 'Writer generation is stale.', {
          expectedGeneration: session.generation,
          receivedGeneration: generation,
        });
      }
      let payload;
      try {
        payload = await callSupervisor(
          'pause',
          {
            socketPath: session.socketPath,
            generation,
            owner,
            'abort-active': spec.abortActive === true ? true : undefined,
          },
          quiesceDeadlineMs + commandTimeoutMs + 5_000
        );
      } catch (error) {
        if (error instanceof PiHarnessError &&
          ['guest_timeout', 'guest_exec_failed', 'protocol_error'].includes(error.code)) {
          // The supervisor may have already incremented the generation and
          // paused. Adopt its state so the old writer cannot keep using the
          // stale generation, then report the unconfirmed handoff.
          let status = null;
          try {
            status = await readStatus(sessionPaths(sessionId));
          } catch {
            status = null;
          }
          if (status) {
            session.generation = status.generation;
            session.paused = status.paused === true;
            session.pauseOwner = typeof status.pauseOwner === 'string'
              ? status.pauseOwner
              : owner;
            session.status = status.status;
          }
          fail(
            'quiesce_unconfirmed',
            'Pause outcome could not be verified; the handoff remains pending.',
            {
              generation: session.generation,
              paused: session.paused,
              owner: session.pauseOwner,
              reason: error.code,
              guestData: true,
            }
          );
        }
        throw error;
      }
      if (Number.isSafeInteger(payload.generation)) {
        session.generation = payload.generation;
      }
      session.paused = true;
      session.pauseOwner = typeof payload.owner === 'string' ? payload.owner : owner;
      session.status = payload.quiescent === true ? 'paused' : 'paused_pending';
      if (payload.conflict === 'quiesce_unconfirmed' || payload.quiescent !== true) {
        fail(
          'quiesce_unconfirmed',
          'Quiescence could not be confirmed; the handoff remains pending.',
          {
            generation: session.generation,
            paused: true,
            owner: session.pauseOwner,
            settled: payload.settled === true,
            verified: payload.verified === true,
            isStreaming: payload.isStreaming === undefined ? null : payload.isStreaming,
            guestData: true,
          }
        );
      }
      return {
        harnessId: PI_HARNESS_ID,
        nativeSessionId: sessionId,
        generation: session.generation,
        paused: true,
        owner: session.pauseOwner,
        settled: payload.settled === true,
        quiescent: true,
        verified: payload.verified === true,
        isStreaming: payload.isStreaming === undefined ? null : payload.isStreaming,
        guestData: true,
      };
    },

    async resume(spec = {}) {
      requireOpen();
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        fail('invalid_input', 'resume requires an object.');
      }
      const sessionId = assertUuid(spec.nativeSessionId);
      const session = requireSession(sessionId);
      const generation = assertInteger(spec.generation, 1, 1_000_000_000, 'generation');
      const owner = assertOwner(spec.owner);
      if (!session.paused) {
        fail('not_paused', 'The conversation is not paused.');
      }
      if (generation !== session.generation) {
        fail('stale_writer', 'Writer generation is stale.', {
          expectedGeneration: session.generation,
          receivedGeneration: generation,
        });
      }
      let payload;
      try {
        payload = await callSupervisor(
          'resume',
          { socketPath: session.socketPath, generation, owner },
          quiesceDeadlineMs + commandTimeoutMs + 5_000
        );
      } catch (error) {
        if (error instanceof PiHarnessError &&
          ['guest_timeout', 'guest_exec_failed', 'protocol_error'].includes(error.code)) {
          let status = null;
          try {
            status = await readStatus(sessionPaths(sessionId));
          } catch {
            status = null;
          }
          if (status) {
            session.generation = status.generation;
            session.paused = status.paused === true;
            session.pauseOwner = typeof status.pauseOwner === 'string'
              ? status.pauseOwner
              : null;
            session.status = status.status;
          }
          fail(
            'quiesce_unconfirmed',
            'Resume outcome could not be verified; the handoff remains pending.',
            {
              generation: session.generation,
              paused: session.paused,
              owner: session.pauseOwner,
              reason: error.code,
              guestData: true,
            }
          );
        }
        throw error;
      }
      if (Number.isSafeInteger(payload.generation)) {
        session.generation = payload.generation;
      }
      session.paused = false;
      session.pauseOwner = null;
      session.status = 'ready';
      return {
        harnessId: PI_HARNESS_ID,
        nativeSessionId: sessionId,
        generation: session.generation,
        paused: false,
        owner: null,
        resumed: payload.resumed === true,
        quiescent: payload.quiescent === true,
        guestData: true,
      };
    },

    async operatorSend(spec = {}) {
      requireOpen();
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        fail('invalid_input', 'operatorSend requires an object.');
      }
      return adapter.submit({
        nativeSessionId: spec.nativeSessionId,
        requestId: spec.requestId,
        message: spec.message,
        generation: spec.generation,
        operator: true,
        owner: spec.owner,
      });
    },

    async close(spec = {}) {
      requireOpen();
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        fail('invalid_input', 'close requires an object.');
      }
      const sessionId = assertUuid(spec.nativeSessionId);
      const session = sessions.get(sessionId);
      const paths = session || sessionPaths(sessionId);
      try {
        const payload = await callSupervisor(
          'stop',
          {
            socketPath: paths.socketPath,
            'deadline-ms': stopDeadlineMs,
          },
          stopDeadlineMs + 5_000
        );
        // The attachment is kept until cleanup is verified so a retry can
        // address the same session record instead of a reconstructed path.
        if (payload.stopped !== true) {
          fail('cleanup_unverified', 'Guest supervisor could not verify Pi termination.', {
            forced: payload.forced === true,
            exitCode: payload.exitCode === undefined ? null : payload.exitCode,
            cleanupUnverified: payload.cleanupUnverified === true,
          });
        }
        sessions.delete(sessionId);
        return {
          harnessId: PI_HARNESS_ID,
          nativeSessionId: sessionId,
          stopped: true,
          forced: payload.forced === true,
          exitCode: payload.exitCode === undefined ? null : payload.exitCode,
          signal: payload.signal === undefined ? null : payload.signal,
          cleanupUnverified: false,
          alreadyStopped: payload.alreadyStopped === true,
          guestData: true,
        };
      } catch (error) {
        if (error instanceof PiHarnessError && error.code === 'supervisor_unavailable') {
          sessions.delete(sessionId);
          // The supervisor is gone, but Pi termination cannot be observed from
          // here. Report that uncertainty instead of claiming success.
          return {
            harnessId: PI_HARNESS_ID,
            nativeSessionId: sessionId,
            stopped: false,
            supervisorGone: true,
            cleanupUnverified: true,
            guestData: true,
          };
        }
        throw error;
      }
    },

    async closeAll() {
      requireOpen();
      const ids = [...sessions.keys()];
      const results = await Promise.allSettled(
        ids.map((sessionId) => adapter.close({ nativeSessionId: sessionId }))
      );
      const closed = [];
      const failed = [];
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          closed.push(result.value);
        } else {
          failed.push({
            nativeSessionId: ids[index],
            code: result.reason && result.reason.code ? result.reason.code : 'close_failed',
          });
        }
      });
      return { closed, failed };
    },

    closeSync() {
      closed = true;
      sessions.clear();
    },
  };

  return adapter;
}

module.exports = {
  PiHarnessError,
  PI_HARNESS_ID,
  PI_VERSION,
  PI_CAPABILITIES,
  createPiHarness,
};
