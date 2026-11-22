'use strict';

/**
 * NETNS-WORKER-1 host-side client.
 *
 * This module is the only host-side path to a per-allocation engine worker. It
 * can start, stop and check exactly one systemd template instance:
 *
 *     alpi-worker@<lowercase-uuid>.service
 *
 * The systemctl argv is fixed and never goes through a shell, sudo, pkexec or a
 * generic command runner. `start` and `stop` are the only unit actions. `check`
 * uses `systemctl show` for the unit's load/active state, main pid and cgroup.
 *
 * The control channel is a private filesystem Unix socket created by the
 * worker. Requests are bounded JSON lines. The client validates every box
 * reference against its own allocation and generation before sending it; it
 * never forwards caller-supplied images, profiles, SDK paths, home paths or raw
 * SDK calls. It never loads the SDK in the host namespace and never falls back
 * to a host-local engine if the worker service is absent.
 */

const { parseInterfaces, parseIPv4Routes, parseIPv6Routes, assertLoopbackOnly } = require('./loopback-routes.cjs');

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const PROTOCOL_VERSION = 1;
const WORKER_UNIT_PREFIX = 'alpi-worker@';
const WORKER_UNIT_SUFFIX = '.service';
const WORKER_UNIT_PATTERN =
  /^alpi-worker@[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.service$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME_PATTERN =
  /^alpi-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-g([1-9][0-9]*)$/;
const MAX_FRAME_BYTES = 256 * 1024;
const MAX_SYSTEMCTL_OUTPUT_BYTES = 64 * 1024;
const MAX_UDS_PATH_BYTES = 100;
const MAX_NATIVE_ID_LENGTH = 256;
const DEFAULT_SYSTEMCTL_PATH = '/usr/bin/systemctl';
const DEFAULT_SYSTEMCTL_TIMEOUT_MS = 15_000;
const DEFAULT_START_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
const EXEC_CLEANUP_GRACE_MS = 10_000;
const MAX_EXEC_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const MAX_EXEC_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_EXEC_CHUNK_BYTES = 32 * 1024;
const MAX_CHUNKED_FRAMES_PER_REQUEST = 4096;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 2_000;
const DEFAULT_PROOF_MAX_AGE_MS = 5_000;
const DEFAULT_CONNECT_RETRY_MS = 100;

const SETUP_MISSING_MESSAGE =
  'Alpi engine worker setup is missing; install the worker service and pinned SDK before creating a sandbox.';

class WorkerClientError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'WorkerClientError';
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

function fail(code, message, details) {
  throw new WorkerClientError(code, message, details);
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

function assertAbsolute(value, code, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 4096 ||
    value.includes('\u0000') ||
    !path.isAbsolute(value)
  ) {
    fail(code, `${label} must be an absolute path.`);
  }
  return path.resolve(value);
}

function assertBoundedString(value, code, label, max) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail(code, `${label} is invalid.`);
  }
  return value;
}

function normalizeAllocationId(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    fail('invalid_allocation', 'Allocation id must be a lowercase UUID.');
  }
  return value;
}

function normalizeGeneration(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000_000) {
    fail('invalid_generation', 'Launch generation must be a positive integer.');
  }
  return value;
}

function unitFor(allocationId) {
  const id = normalizeAllocationId(allocationId);
  const unit = `${WORKER_UNIT_PREFIX}${id}${WORKER_UNIT_SUFFIX}`;
  if (!WORKER_UNIT_PATTERN.test(unit)) {
    fail('invalid_unit', 'The worker unit is invalid.');
  }
  return unit;
}

function allocationName(allocationId, launchGeneration) {
  return `alpi-${allocationId}-g${launchGeneration}`;
}

function createDefaultProcEvidence() {
  return Object.freeze({
    async readFile(target) {
      return fsp.readFile(target, 'utf8');
    },
    async readlink(target) {
      return fsp.readlink(target);
    },
  });
}

function netnsInodeFromLink(link) {
  const match = /^net:\[(\d+)\]$/.exec(link);
  if (!match) {
    fail('worker_namespace_unverified', 'The worker network namespace identity is not readable.');
  }
  return Number(match[1]);
}

function parseCgroup(contents) {
  for (const line of contents.split('\n')) {
    const match = /^0::(.+)$/.exec(line.trim());
    if (match) {
      return match[1];
    }
  }
  return null;
}

function parseUid(contents) {
  const match = /^Uid:\s+(\d+)\s+(\d+)/m.exec(contents);
  if (!match) {
    return null;
  }
  return { real: Number(match[1]), effective: Number(match[2]) };
}

function assertPrivateSocket(socketPath, uid) {
  const resolved = assertAbsolute(socketPath, 'unsafe_socket', 'Control socket');
  if (Buffer.byteLength(resolved, 'utf8') > MAX_UDS_PATH_BYTES) {
    fail('unsafe_socket', 'The control socket path is too long.');
  }
  const stat = lstatOrNull(resolved);
  if (!stat) {
    fail('worker_unavailable', 'The worker control socket is not available.');
  }
  if (!stat.isSocket() || stat.isSymbolicLink()) {
    fail('unsafe_socket', 'The worker control path is not a Unix socket.');
  }
  if (uid !== null && stat.uid !== uid && stat.uid !== 0) {
    fail('unsafe_socket', 'The worker control socket is owned by another account.');
  }
  if ((stat.mode & 0o077) !== 0) {
    fail('unsafe_socket', 'The worker control socket must be private.');
  }
  return resolved;
}

function defaultLauncher(systemctlPath, timeoutMs) {
  return async (argv) => {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const child = spawn(systemctlPath, argv, {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
      });
      const finish = (result) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(result);
      };
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
        finish({ code: null, stdout, stderr, timedOut: true });
      }, timeoutMs);
      timer.unref?.();
      child.stdout.on('data', (chunk) => {
        if (stdout.length < MAX_SYSTEMCTL_OUTPUT_BYTES) {
          stdout += chunk.toString('utf8');
        }
      });
      child.stderr.on('data', (chunk) => {
        if (stderr.length < MAX_SYSTEMCTL_OUTPUT_BYTES) {
          stderr += chunk.toString('utf8');
        }
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        finish({ code: null, stdout, stderr, error });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        finish({ code, stdout, stderr, timedOut: false });
      });
    });
  };
}

/**
 * Strict systemctl client. Only `start`, `stop` and `show` for the exact worker
 * template instance are reachable. No shell, no sudo, no pkexec, no generic
 * argv.
 */
function createSystemctlClient(options = {}) {
  const systemctlPath = assertAbsolute(
    options.systemctlPath ?? DEFAULT_SYSTEMCTL_PATH,
    'invalid_systemctl',
    'systemctlPath'
  );
  const timeoutMs = options.timeoutMs ?? DEFAULT_SYSTEMCTL_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
    fail('invalid_systemctl', 'systemctl timeout is invalid.');
  }
  const launcher =
    options.launcher !== undefined
      ? options.launcher
      : defaultLauncher(systemctlPath, timeoutMs);
  if (typeof launcher !== 'function') {
    fail('invalid_systemctl', 'systemctl launcher must be a function.');
  }

  async function run(argv) {
    let result;
    try {
      result = await launcher(argv);
    } catch {
      fail('systemctl_failed', 'The systemctl invocation failed.');
    }
    if (
      !result ||
      typeof result !== 'object' ||
      typeof result.stdout !== 'string' ||
      typeof result.stderr !== 'string'
    ) {
      fail('systemctl_failed', 'The systemctl invocation returned an invalid result.');
    }
    return result;
  }

  return Object.freeze({
    async start(allocationId) {
      const unit = unitFor(allocationId);
      const result = await run(['start', unit]);
      if (result.timedOut === true) {
        fail('systemctl_timeout', 'Starting the worker unit timed out.');
      }
      if (result.code !== 0) {
        const code = /not found|does not exist|No such file/i.test(result.stderr)
          ? 'worker_setup_missing'
          : 'systemctl_failed';
        fail(code, code === 'worker_setup_missing' ? SETUP_MISSING_MESSAGE : 'Starting the worker unit failed.');
      }
      return { unit, started: true };
    },

    async stop(allocationId) {
      const unit = unitFor(allocationId);
      const result = await run(['stop', unit]);
      if (result.timedOut === true) {
        fail('systemctl_timeout', 'Stopping the worker unit timed out.');
      }
      if (result.code !== 0) {
        const code = /not found|does not exist|No such file/i.test(result.stderr)
          ? 'worker_setup_missing'
          : 'systemctl_failed';
        fail(code, code === 'worker_setup_missing' ? SETUP_MISSING_MESSAGE : 'Stopping the worker unit failed.');
      }
      return { unit, stopped: true };
    },

    async check(allocationId) {
      const unit = unitFor(allocationId);
      const result = await run([
        'show',
        '--no-pager',
        '--property=LoadState,ActiveState,SubState,MainPID,ControlGroup',
        unit,
      ]);
      if (result.timedOut === true) {
        fail('systemctl_timeout', 'Checking the worker unit timed out.');
      }
      if (result.code !== 0) {
        fail('systemctl_failed', 'Checking the worker unit failed.');
      }
      const properties = Object.create(null);
      for (const line of result.stdout.split('\n')) {
        const separator = line.indexOf('=');
        if (separator <= 0) {
          continue;
        }
        properties[line.slice(0, separator)] = line.slice(separator + 1);
      }
      if (properties.LoadState === 'not-found') {
        fail('worker_setup_missing', SETUP_MISSING_MESSAGE);
      }
      const mainPid = properties.MainPID === undefined ? 0 : Number(properties.MainPID);
      if (!Number.isSafeInteger(mainPid) || mainPid < 0) {
        fail('systemctl_failed', 'The worker unit returned an invalid main pid.');
      }
      return Object.freeze({
        unit,
        loadState: properties.LoadState ?? 'unknown',
        activeState: properties.ActiveState ?? 'unknown',
        subState: properties.SubState ?? 'unknown',
        mainPid,
        controlGroup: properties.ControlGroup ?? '',
      });
    },
  });
}

function validateRef(options, ref, { requireNativeId = true } = {}) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) {
    fail('invalid_ref', 'A bounded box reference is required.');
  }
  const allowed = new Set(['allocationId', 'launchGeneration', 'name', 'nativeId']);
  for (const key of Object.keys(ref)) {
    if (!allowed.has(key)) {
      fail('invalid_ref', 'The box reference contains an unexpected field.');
    }
  }
  if (ref.allocationId !== options.allocationId) {
    fail('mixed_sandbox', 'The box reference belongs to another allocation.');
  }
  if (ref.launchGeneration !== options.launchGeneration) {
    fail('generation_mismatch', 'The box reference generation does not match this client.');
  }
  const expectedName = allocationName(options.allocationId, options.launchGeneration);
  if (ref.name !== expectedName) {
    fail('mixed_sandbox', 'The box reference name does not match this allocation.');
  }
  if (requireNativeId) {
    assertBoundedString(ref.nativeId, 'invalid_ref', 'nativeId', MAX_NATIVE_ID_LENGTH);
  } else if (ref.nativeId !== undefined) {
    assertBoundedString(ref.nativeId, 'invalid_ref', 'nativeId', MAX_NATIVE_ID_LENGTH);
  }
  return Object.freeze({
    allocationId: options.allocationId,
    launchGeneration: options.launchGeneration,
    name: expectedName,
    ...(ref.nativeId === undefined ? {} : { nativeId: ref.nativeId }),
  });
}

function normalizeExecSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    fail('invalid_exec', 'Guest execution requires an object.');
  }
  const allowed = new Set(['argv', 'timeoutMs', 'maxOutputBytes', 'tty', 'workingDir']);
  for (const key of Object.keys(spec)) {
    if (!allowed.has(key)) {
      fail('invalid_exec', 'Guest execution contains an unexpected field.');
    }
  }
  return Object.freeze({ ...spec });
}

/**
 * Create a per-launch host client.
 *
 * `launch` is the trusted host-produced record (see launch-boundary.cjs):
 * allocation id, generation, config path, control socket path, token and home.
 */
function createWorkerClient(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    fail('invalid_client', 'Worker client options must be an object.');
  }
  const allocationId = normalizeAllocationId(options.allocationId);
  const launchGeneration = normalizeGeneration(options.launchGeneration);
  const controlSocketPath = assertAbsolute(
    options.controlSocketPath,
    'invalid_client',
    'controlSocketPath'
  );
  if (Buffer.byteLength(controlSocketPath, 'utf8') > MAX_UDS_PATH_BYTES) {
    fail('invalid_client', 'The control socket path is too long.');
  }
  const token = assertBoundedString(options.token, 'invalid_client', 'token', 128);
  if (!/^[a-f0-9]{64}$/.test(token)) {
    fail('invalid_client', 'The worker control token is invalid.');
  }
  let expectedTunnelPort;
  if (options.tunnelPort !== undefined) {
    if (
      !Number.isInteger(options.tunnelPort) ||
      options.tunnelPort < 1 ||
      options.tunnelPort > 65535
    ) {
      fail('invalid_client', 'The expected worker tunnel port is invalid.');
    }
    expectedTunnelPort = options.tunnelPort;
  }
  const uid = options.serviceUid === undefined ? currentUid() : options.serviceUid;
  if (!Number.isSafeInteger(uid) || uid < 0) {
    fail('invalid_client', 'The service uid is invalid.');
  }
  if (currentUid() !== null && currentUid() !== 0 && currentUid() !== uid) {
    fail(
      'worker_uid_mismatch',
      'The host control service is not running as the configured worker service account.'
    );
  }
  const systemctl =
    options.systemctl !== undefined
      ? options.systemctl
      : createSystemctlClient({
          systemctlPath: options.systemctlPath,
          launcher: options.launcher,
          timeoutMs: options.systemctlTimeoutMs,
        });
  if (
    !systemctl ||
    typeof systemctl.start !== 'function' ||
    typeof systemctl.stop !== 'function' ||
    typeof systemctl.check !== 'function'
  ) {
    fail('invalid_client', 'A strict systemctl client is required.');
  }
  const proc = options.proc || createDefaultProcEvidence();
  const netEvidence = options.net || proc;
  const connect =
    options.connect !== undefined
      ? options.connect
      : (socketPath) => net.connect({ path: socketPath });
  if (typeof connect !== 'function') {
    fail('invalid_client', 'The control socket connector must be a function.');
  }
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  const execCleanupGraceMs = options.execCleanupGraceMs ?? EXEC_CLEANUP_GRACE_MS;
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const proofMaxAgeMs = options.proofMaxAgeMs ?? DEFAULT_PROOF_MAX_AGE_MS;
  const connectRetryMs = options.connectRetryMs ?? DEFAULT_CONNECT_RETRY_MS;

  let socket = null;
  let hello = null;
  let connected = false;
  let closed = false;
  let connectionEpoch = 0;
  let activeHandshake = null;
  const pendingRequests = new Map();
  let requestCounter = 0;
  let heartbeatTimer = null;
  let bridgeOpen = false;
  let lastHeartbeatAt = 0;
  let lastCheck = null;
  let generationExpired = false;

  function requireOpen() {
    if (closed) {
      fail('worker_closed', 'The worker client is closed.');
    }
  }

  function requireConnected() {
    requireOpen();
    if (!connected || !socket || socket.destroyed) {
      fail('worker_unavailable', 'The worker control connection is not available.');
    }
  }

  function markUnavailable(error) {
    connected = false;
    bridgeOpen = false;
    const pendingHandshake = activeHandshake;
    activeHandshake = null;
    if (pendingHandshake) {
      pendingHandshake.settle(
        error instanceof WorkerClientError
          ? error
          : new WorkerClientError(
              'worker_unavailable',
              error && error.message ? error.message : 'The worker control connection was lost.'
            )
      );
    }
    if (socket) {
      try {
        socket.destroy();
      } catch {}
      socket = null;
    }
    for (const current of pendingRequests.values()) {
      clearTimeout(current.timer);
      current.reject(
        new WorkerClientError(
          'worker_unavailable',
          error && error.message ? error.message : 'The worker control connection was lost.'
        )
      );
    }
    pendingRequests.clear();
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function send(payload) {
    if (!socket || socket.destroyed) {
      fail('worker_unavailable', 'The worker control connection is not available.');
    }
    socket.write(`${JSON.stringify(payload)}\n`);
  }

  function request(op, payload = {}, transport = {}) {
    requireConnected();
    const id = ++requestCounter;
    const message = { id, op, ...payload };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const current = pendingRequests.get(id);
        if (!current) {
          return;
        }
        pendingRequests.delete(id);
        markUnavailable(new Error('Worker request timed out.'));
        reject(new WorkerClientError('worker_timeout', 'The worker request timed out.'));
          }, transport.timeoutMs ?? requestTimeoutMs);
      timer.unref?.();
      const streams = transport.streams
        ? {
            limitBytes: transport.streams.limitBytes,
            seq: 0,
            totals: { stdout: 0, stderr: 0 },
            buffers: { stdout: [], stderr: [] },
            chunkCount: 0,
            exceeded: false,
          }
        : null;
      pendingRequests.set(id, { id, resolve, reject, timer, streams });
      try {
        send(message);
      } catch (error) {
        clearTimeout(timer);
        pendingRequests.delete(id);
        reject(error);
      }
    });
  }

  function rejectStreamBounded(current) {
    clearTimeout(current.timer);
    pendingRequests.delete(current.id);
    current.reject(
      new WorkerClientError(
        'output_limit_exceeded',
        'The guest execution output exceeded the encoded result budget.'
      )
    );
  }

  function handleStreamFrame(current, message) {
    const streams = current.streams;
    const part = message.part;
    if (
      !streams ||
      (part !== 'stdout' && part !== 'stderr') ||
      message.seq !== streams.seq ||
      typeof message.data !== 'string'
    ) {
      markUnavailable(new Error('The worker stream frame was invalid.'));
      return;
    }
    let decoded;
    try {
      decoded = Buffer.from(message.data, 'base64');
    } catch {
      markUnavailable(new Error('The worker stream frame was invalid.'));
      return;
    }
    if (
      decoded.length === 0 ||
      decoded.length > MAX_EXEC_CHUNK_BYTES ||
      decoded.toString('base64') !== message.data
    ) {
      markUnavailable(new Error('The worker stream frame was invalid.'));
      return;
    }
    streams.seq += 1;
    streams.chunkCount += 1;
    if (streams.chunkCount > MAX_CHUNKED_FRAMES_PER_REQUEST) {
      rejectStreamBounded(current);
      return;
    }
    const total = streams.totals[part] + decoded.length;
    if (total > streams.limitBytes) {
      // Stop buffering but keep consuming frames so the final chunked result
      // keeps the protocol consistent; the connection stays usable.
      streams.exceeded = true;
      return;
    }
    streams.totals[part] = total;
    streams.buffers[part].push(decoded);
  }

  function finalizeChunkedResult(current, result) {
    const streams = current.streams;
    if (!streams || !result || typeof result !== 'object' || Array.isArray(result)) {
      markUnavailable(new Error('The worker chunked result was invalid.'));
      return;
    }
    clearTimeout(current.timer);
    pendingRequests.delete(current.id);
    if (streams.exceeded) {
      current.reject(
        new WorkerClientError(
          'output_limit_exceeded',
          'The guest execution output exceeded the encoded result budget.'
        )
      );
      return;
    }
    current.resolve({
      ...result,
      stdout: Buffer.concat(streams.buffers.stdout).toString('utf8'),
      stderr: Buffer.concat(streams.buffers.stderr).toString('utf8'),
    });
  }

  async function verifyWorkerIdentity(check, handshake) {
    if (!check || !Number.isSafeInteger(check.mainPid) || check.mainPid <= 1) {
      fail('worker_identity_mismatch', 'The worker unit has no usable main pid.');
    }
    if (handshake.pid !== check.mainPid) {
      fail('worker_identity_mismatch', 'The worker handshake pid does not match the unit main pid.');
    }
    if (
      expectedTunnelPort !== undefined &&
      handshake.tunnelPort !== expectedTunnelPort
    ) {
      fail('worker_identity_mismatch', 'The worker tunnel port does not match the configured port.');
    }
    let nsLink;
    let hostNs;
    let cgroupContents;
    let status;
    let dev;
    let route;
    let ipv6Route = '';
    try {
      hostNs = await proc.readlink('/proc/self/ns/net');
      nsLink = await proc.readlink(`/proc/${check.mainPid}/ns/net`);
      cgroupContents = await proc.readFile(`/proc/${check.mainPid}/cgroup`);
      status = await proc.readFile(`/proc/${check.mainPid}/status`);
      dev = await netEvidence.readFile(`/proc/${check.mainPid}/net/dev`);
      route = await netEvidence.readFile(`/proc/${check.mainPid}/net/route`);
      try {
        ipv6Route = await netEvidence.readFile(`/proc/${check.mainPid}/net/ipv6_route`);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        ipv6Route = '';
      }
    } catch {
      fail('worker_identity_mismatch', 'The worker process evidence is not readable.');
    }
    const netnsInode = netnsInodeFromLink(nsLink);
    if (netnsInode === netnsInodeFromLink(hostNs) || netnsInode !== handshake.netnsInode) {
      fail('worker_namespace_mismatch', 'The observed worker namespace differs from the worker report.');
    }
    const cgroup = parseCgroup(cgroupContents);
    if (!cgroup || cgroup !== check.controlGroup) {
      fail('worker_identity_mismatch', 'The worker process is not in the expected unit cgroup.');
    }
    const observedUid = parseUid(status);
    if (!observedUid || observedUid.real !== uid || observedUid.effective !== uid) {
      fail('worker_identity_mismatch', 'The worker process is not running as the service account.');
    }
    const interfaces = parseInterfaces(dev);
    const ipv4Routes = parseIPv4Routes(route);
    const ipv6Routes = parseIPv6Routes(ipv6Route);
    assertLoopbackOnly(interfaces, ipv4Routes, ipv6Routes, fail);
    return Object.freeze({
      pid: check.mainPid,
      netnsInode,
      cgroup,
      uid: observedUid.real,
    });
  }

  async function connectControl() {
    requireOpen();
    // Every connection owns its handshake state and identity epoch. A
    // reconnect must never inherit a settled handshake from a previous socket,
    // and callbacks from a superseded socket must not clear its replacement.
    const epoch = ++connectionEpoch;
    const resolved = assertPrivateSocket(controlSocketPath, uid);
    const raw = connect(resolved);
    if (!raw || typeof raw.on !== 'function') {
      fail('worker_unavailable', 'The worker control connector returned an invalid socket.');
    }
    socket = raw;
    socket.setEncoding('utf8');
    socket.setNoDelay(true);
    const isCurrent = () => !closed && epoch === connectionEpoch && socket === raw;
    const abandonAttempt = () => {
      if (socket === raw) {
        socket = null;
      }
      try {
        raw.destroy();
      } catch {}
    };
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new WorkerClientError('worker_timeout', 'Connecting to the worker control socket timed out.'));
        }, requestTimeoutMs);
        timer.unref?.();
        const onConnect = () => {
          clearTimeout(timer);
          raw.off('error', onError);
          resolve();
        };
        const onError = () => {
          clearTimeout(timer);
          raw.off('connect', onConnect);
          reject(new WorkerClientError('worker_unavailable', 'The worker control socket is unavailable.'));
        };
        raw.once('connect', onConnect);
        raw.once('error', onError);
      });
    } catch (error) {
      abandonAttempt();
      throw error;
    }
    let buffer = '';
    let handshakeDone = false;
    let handshakeResolve;
    let handshakeReject;
    const handshakePromise = new Promise((resolve, reject) => {
      handshakeResolve = resolve;
      handshakeReject = reject;
    });
    const handshakeState = {
      settle(error, result) {
        if (handshakeDone) {
          return;
        }
        handshakeDone = true;
        clearTimeout(handshakeTimer);
        if (activeHandshake === handshakeState) {
          activeHandshake = null;
        }
        if (error) {
          handshakeReject(error);
        } else {
          handshakeResolve(result);
        }
      },
    };
    const handshakeTimer = setTimeout(() => {
      handshakeState.settle(
        new WorkerClientError(
          'worker_timeout',
          'The worker control handshake did not complete in time.'
        )
      );
      if (isCurrent()) {
        markUnavailable(new Error('The worker control handshake did not complete in time.'));
      }
      abandonAttempt();
    }, startTimeoutMs);
    handshakeTimer.unref?.();
    activeHandshake = handshakeState;
    const onData = (chunk) => {
      if (!isCurrent()) {
        return;
      }
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_FRAME_BYTES) {
        markUnavailable(new Error('The worker response exceeded the frame bound.'));
        abandonAttempt();
        return;
      }
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (!line) {
          continue;
        }
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          markUnavailable(new Error('The worker response was not valid JSON.'));
          abandonAttempt();
          return;
        }
        if (!handshakeDone) {
          if (message.id === null && message.ok === true && message.result) {
            handshakeState.settle(null, message.result);
          } else {
            handshakeState.settle(
              new WorkerClientError(
                message.error && message.error.code ? message.error.code : 'handshake_rejected',
                message.error && message.error.message
                  ? message.error.message
                  : 'The worker rejected the control handshake.'
              )
            );
          }
          continue;
        }
        const current = pendingRequests.get(message.id);
        if (!current) {
          continue;
        }
        if (typeof message.part === 'string') {
          handleStreamFrame(current, message);
          continue;
        }
        clearTimeout(current.timer);
        pendingRequests.delete(message.id);
        if (message.ok === true) {
          if (message.chunked === true) {
            finalizeChunkedResult(current, message.result);
          } else {
            current.resolve(message.result);
          }
        } else {
          current.reject(
            new WorkerClientError(
              message.error && message.error.code ? message.error.code : 'worker_error',
              message.error && message.error.message
                ? message.error.message
                : 'The worker operation failed.'
            )
          );
        }
      }
    };
    const onError = () => {
      if (!isCurrent()) {
        return;
      }
      handshakeState.settle(new WorkerClientError('worker_unavailable', 'The worker control connection failed.'));
      markUnavailable(new Error('The worker control connection failed.'));
      abandonAttempt();
    };
    const onClose = () => {
      if (!isCurrent()) {
        return;
      }
      handshakeState.settle(new WorkerClientError('worker_unavailable', 'The worker control connection closed.'));
      markUnavailable(new Error('The worker control connection closed.'));
      abandonAttempt();
    };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
    try {
      send({
        id: null,
        op: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        allocationId,
        launchGeneration,
        token,
      });
    } catch (error) {
      handshakeState.settle(
        error instanceof WorkerClientError
          ? error
          : new WorkerClientError('worker_unavailable', error && error.message ? error.message : 'The worker handshake could not be sent.')
      );
      if (isCurrent()) {
        markUnavailable(error);
      }
      abandonAttempt();
      throw error;
    }
    let handshake;
    try {
      handshake = await handshakePromise;
    } catch (error) {
      abandonAttempt();
      throw error;
    }
    if (
      !handshake ||
      handshake.protocolVersion !== PROTOCOL_VERSION ||
      handshake.allocationId !== allocationId ||
      handshake.launchGeneration !== launchGeneration
    ) {
      markUnavailable(new Error('The worker handshake did not match this allocation.'));
      fail('handshake_rejected', 'The worker handshake did not match this allocation.');
    }
    hello = handshake;
    lastHeartbeatAt = Date.now();
    return handshake;
  }

  async function waitForActive() {
    const deadline = Date.now() + startTimeoutMs;
    let last;
    while (Date.now() <= deadline) {
      last = await systemctl.check(allocationId);
      if (last.activeState === 'active' && last.mainPid > 1) {
        return last;
      }
      await new Promise((resolve) => setTimeout(resolve, connectRetryMs));
    }
    fail(
      'worker_start_timeout',
      last && last.activeState === 'failed'
        ? 'The worker unit failed to start.'
        : 'The worker unit did not become active in time.'
    );
  }

  async function connectWithRetry() {
    const deadline = Date.now() + startTimeoutMs;
    let lastError;
    while (Date.now() <= deadline) {
      try {
        return await connectControl();
      } catch (error) {
        lastError = error;
        if (error instanceof WorkerClientError && error.code === 'worker_setup_missing') {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, connectRetryMs));
      }
    }
    throw (
      lastError ||
      new WorkerClientError('worker_unavailable', 'The worker control socket did not become available.')
    );
  }

  function startHeartbeat() {
    if (heartbeatTimer) {
      return;
    }
    heartbeatTimer = setInterval(() => {
      if (!connected || closed) {
        return;
      }
      const ref = {
        allocationId,
        launchGeneration,
        name: allocationName(allocationId, launchGeneration),
        nativeId: lastNativeId || 'unverified',
      };
      if (!lastNativeId) {
        return;
      }
      request('heartbeat', { ref, generation: launchGeneration })
        .then(() => {
          lastHeartbeatAt = Date.now();
        })
        .catch(() => {
          bridgeOpen = false;
          generationExpired = true;
          markUnavailable(new Error('The worker heartbeat failed.'));
        });
    }, heartbeatIntervalMs);
    heartbeatTimer.unref?.();
  }

  let lastNativeId = null;

  const engine = {
    id: 'boxlite',

    async probe() {
      const unavailable = { available: false, version: null, capabilities: [] };
      if (!connected) return { ...unavailable, reason: 'worker_unavailable' };
      try {
        const check = await systemctl.check(allocationId);
        if (check.activeState !== 'active' || check.mainPid !== hello.pid) {
          return { ...unavailable, reason: 'worker_inactive' };
        }
        return await request('probe', { generation: launchGeneration });
      } catch {
        return { ...unavailable, reason: 'probe_failed' };
      }
    },

    async createBox(spec = {}) {
      requireConnected();
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        fail('invalid_input', 'createBox requires an object.');
      }
      const allowed = new Set(['allocationId', 'launchGeneration', 'profile']);
      for (const key of Object.keys(spec)) {
        if (!allowed.has(key)) {
          fail('invalid_input', 'createBox contains a host-controlled field.');
        }
      }
      if (spec.allocationId !== undefined && spec.allocationId !== allocationId) {
        fail('mixed_sandbox', 'The create request belongs to another allocation.');
      }
      if (
        spec.launchGeneration !== undefined &&
        spec.launchGeneration !== launchGeneration
      ) {
        fail('generation_mismatch', 'The create request generation does not match this client.');
      }
      if (spec.profile !== undefined) {
        const network = spec.profile?.network;
        const mode = typeof network === 'string' ? network :
          network && Object.keys(network).length === 1 && network.mode;
        if (
          !spec.profile ||
          typeof spec.profile !== 'object' ||
          Array.isArray(spec.profile) ||
          !['disabled', 'boundary'].includes(mode) || mode !== hello.networkMode ||
          Object.keys(spec.profile).some((key) => key !== 'network')
        ) {
          fail('invalid_input', 'The worker profile is fixed by the host boundary.');
        }
      }
      const ref = validateRef(
        { allocationId, launchGeneration },
        {
          allocationId,
          launchGeneration,
          name: allocationName(allocationId, launchGeneration),
        },
        { requireNativeId: false }
      );
      const result = await request('create', { ref, generation: launchGeneration });
      if (!result || typeof result.nativeId !== 'string') {
        fail('worker_invalid_result', 'The worker returned an invalid create result.');
      }
      lastNativeId = result.nativeId;
      return result;
    },

    async inspect(ref) {
      requireConnected();
      const bounded = validateRef({ allocationId, launchGeneration }, ref);
      return request('inspect', { ref: bounded, generation: launchGeneration });
    },

    async start(ref) {
      requireConnected();
      const bounded = validateRef({ allocationId, launchGeneration }, ref);
      const result = await request('start', { ref: bounded, generation: launchGeneration });
      lastNativeId = bounded.nativeId;
      return result.info;
    },

    async stop(ref) {
      requireConnected();
      const bounded = validateRef({ allocationId, launchGeneration }, ref);
      const result = await request('stop', { ref: bounded, generation: launchGeneration });
      return result.info;
    },

    async destroy(ref) {
      requireConnected();
      const bounded = validateRef({ allocationId, launchGeneration }, ref);
      return request('destroy', { ref: bounded, generation: launchGeneration });
    },

    async listOwned() {
      requireConnected();
      const result = await request('listOwned', { generation: launchGeneration });
      if (!Array.isArray(result)) {
        fail('worker_invalid_result', 'The worker returned an invalid inventory.');
      }
      return result;
    },

    async exec(ref, spec = {}) {
      requireConnected();
      const bounded = validateRef({ allocationId, launchGeneration }, ref);
      const { signal, ...args } = spec;
      const boundedSpec = normalizeExecSpec(args);
      signal?.throwIfAborted();
      const abort = () => markUnavailable(new Error('Guest execution interrupted.'));
      signal?.addEventListener('abort', abort, { once: true });
      try {
        // The exec transport deadline must cover the validated execution and
        // cleanup budget of the command itself; every other control request
        // keeps the default request bound. The stream state carries the
        // encoded result budget used by the chunked large-result transport.
        const requestedTimeout = boundedSpec.timeoutMs;
        const executionTimeoutMs =
          Number.isSafeInteger(requestedTimeout) &&
          requestedTimeout >= 1 &&
          requestedTimeout <= MAX_EXEC_TIMEOUT_MS
            ? requestedTimeout
            : DEFAULT_EXEC_TIMEOUT_MS;
        const requestedOutput = boundedSpec.maxOutputBytes;
        const outputLimitBytes =
          Number.isSafeInteger(requestedOutput) &&
          requestedOutput >= 1 &&
          requestedOutput <= MAX_EXEC_OUTPUT_BYTES
            ? requestedOutput
            : DEFAULT_MAX_OUTPUT_BYTES;
        return await request(
          'exec',
          { ref: bounded, spec: boundedSpec, generation: launchGeneration },
          {
            timeoutMs: executionTimeoutMs + execCleanupGraceMs,
            streams: { limitBytes: outputLimitBytes },
          }
        );
      } catch (error) {
        // Loss of the control stream alone cannot confirm termination in the guest.
        if (signal?.aborted || ['worker_timeout', 'worker_unavailable', 'worker_internal_error', 'worker_error'].includes(error.code)) {
          fail('engine_termination_unverified', 'Guest execution termination is unconfirmed.');
        }
        throw error;
      } finally {
        signal?.removeEventListener('abort', abort);
      }
    },

    async status(ref) {
      requireConnected();
      const bounded = validateRef({ allocationId, launchGeneration }, ref);
      const status = await request('status', { ref: bounded, generation: launchGeneration });
      if (status.running && status.proof) lastNativeId = bounded.nativeId;
      return status;
    },

    async close() {
      await client.fence();
      client.close();
    },
  };

  const client = {
    allocationId,
    launchGeneration,
    controlSocketPath,
    unit: unitFor(allocationId),

    async check() {
      requireOpen();
      const result = await systemctl.check(allocationId);
      lastCheck = result;
      return result;
    },

    async start() {
      requireOpen();
      const unit = unitFor(allocationId);
      await systemctl.start(allocationId);
      const check = await waitForActive();
      lastCheck = check;
      const handshake = await connectWithRetry();
      try {
        await verifyWorkerIdentity(check, handshake);
        if (!socket || socket.destroyed || hello !== handshake) fail('worker_unavailable', 'Worker disconnected.');
      } catch (error) {
        markUnavailable(error);
        throw error;
      }
      connected = true;
      startHeartbeat();
      return Object.freeze({ hello: handshake, check });
    },

    async stop() {
      if (!closed) {
        await client.fence();
        client.close();
      }
      const previousGroup = lastCheck?.controlGroup;
      await systemctl.stop(allocationId);
      const deadline = Date.now() + stopTimeoutMs;
      while (Date.now() <= deadline) {
        const check = await systemctl.check(allocationId);
        lastCheck = check;
        if (['inactive', 'failed'].includes(check.activeState) && check.mainPid === 0) {
          const group = check.controlGroup || previousGroup;
          if (!group) return check;
          if (!group.startsWith('/') || group === '/' || path.normalize(group) !== group) {
            fail('worker_stop_unverified', 'Worker control group could not be verified.');
          }
          try {
            const events = await proc.readFile(path.join('/sys/fs/cgroup', group, 'cgroup.events'));
            if (/^populated 0$/m.test(events)) return check;
          } catch (error) {
            if (error.code === 'ENOENT') return check;
            fail('worker_stop_unverified', 'Worker control group could not be verified.');
          }
        }
        await new Promise((resolve) => setTimeout(resolve, connectRetryMs));
      }
      fail('worker_stop_timeout', 'The worker unit did not stop in time.');
    },

    async fence(reason = 'fenced') {
      generationExpired = true;
      bridgeOpen = false;
      if (connected && socket && !socket.destroyed) {
        try {
          await request('fenceBridge', { generation: launchGeneration });
        } catch {
          // The worker also fences on owner disconnect.
        }
      }
      return { fenced: true, reason };
    },

    async openBridge(ironSocketPath) {
      requireConnected();
      if (!bridgeOpen && generationExpired) {
        fail('generation_expired', 'The launch generation has expired.');
      }
      if (!lastNativeId) {
        fail('forward_denied', 'No verified owned box is available.');
      }
      const ref = {
        allocationId,
        launchGeneration,
        name: allocationName(allocationId, launchGeneration),
        nativeId: lastNativeId,
      };
      const result = await request('openBridge', {
        ref,
        generation: launchGeneration,
        ironSocketPath,
      });
      bridgeOpen = true;
      return Object.freeze({
        port: result.port,
        target: result.target || 'iron-proxy',
        generation: launchGeneration,
        healthy: () => bridgeOpen && !generationExpired && connected,
        close: async () => {
          bridgeOpen = false;
          if (connected) {
            try {
              await request('closeBridge', { generation: launchGeneration });
            } catch {
              // Owner disconnect fencing is the backstop.
            }
          }
        },
      });
    },

    async heartbeatNow() {
      requireConnected();
      if (!lastNativeId) {
        fail('forward_denied', 'No verified owned box is available.');
      }
      const ref = {
        allocationId,
        launchGeneration,
        name: allocationName(allocationId, launchGeneration),
        nativeId: lastNativeId,
      };
      const result = await request('heartbeat', { ref, generation: launchGeneration });
      lastHeartbeatAt = Date.now();
      return result;
    },

    get hello() {
      return hello;
    },

    get engine() {
      return engine;
    },

    get lastHeartbeatAt() {
      return lastHeartbeatAt;
    },

    get proofMaxAgeMs() {
      return proofMaxAgeMs;
    },

    get connected() {
      return connected;
    },

    get socket() {
      return socket;
    },

    close() {
      if (closed) {
        return;
      }
      closed = true;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      bridgeOpen = false;
      connected = false;
      // Connection callbacks are guarded against stale sockets, so in-flight
      // requests are rejected here rather than through the close handler.
      markUnavailable(new Error('The worker client is closed.'));
      if (socket) {
        try {
          socket.destroy();
        } catch {}
        socket = null;
      }
    },
  };

  return Object.freeze(client);
}

/**
 * Convenience hook for the coordinator. Starts the exact worker unit, connects,
 * runs `fn(engine, context)` and always fences plus stops the unit afterwards.
 */
async function withEngine(options, fn) {
  if (typeof fn !== 'function') {
    fail('invalid_client', 'withEngine requires a callback.');
  }
  const client = createWorkerClient(options);
  try {
    const ready = await client.start();
    return await fn(client.engine, {
      client,
      hello: ready.hello,
      check: ready.check,
    });
  } finally {
    try {
      await client.fence('withEngine-finally');
    } catch {}
    try {
      await client.stop();
    } finally {
      client.close();
    }
  }
}

module.exports = {
  PROTOCOL_VERSION,
  WORKER_UNIT_PREFIX,
  WORKER_UNIT_PATTERN,
  SETUP_MISSING_MESSAGE,
  WorkerClientError,
  createSystemctlClient,
  createWorkerClient,
  withEngine,
  unitFor,
  allocationName,
};
