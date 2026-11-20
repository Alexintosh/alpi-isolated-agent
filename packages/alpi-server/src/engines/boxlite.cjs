'use strict';

/**
 * BoxLite engine adapter for Alpi.
 *
 * This module is deliberately not a runtime host. The host must supply a
 * verified SDK module path and a private, dedicated runtime home. BoxLite is
 * dynamically imported from that path. Ownership is established from durable
 * intent before any native side effect; recovery only attaches to the recorded
 * native identity and never creates a replacement when that identity is gone.
 *
 * The default profile is fully disconnected: no inbound network, no outbound
 * network, no host mounts, no ports, no secrets and no caller-supplied
 * environment.
 *
 * Networked profiles are unavailable unless the host supplies an explicit
 * launch-scoped boundary provider with `prepare` and `verify`. The prepared
 * grant and operator configuration hash are persisted with the allocation and
 * are rechecked before every start or implicit guest execution, including
 * after an adapter restart. `prepare` fences egress before native allocation;
 * traffic is only considered usable after `verify` observes a running shim.
 *
 * `pty` in the advertised capability set means a one-shot command executed
 * with `tty=true`. It is not an attachable interactive PTY session; interactive
 * attach remains unqualified and is not advertised by this adapter.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ENGINE_ID = 'boxlite';
const BOXLITE_VERSION = '0.14.1';
const BASE_CAPABILITIES = Object.freeze([
  'create',
  'inspect',
  'start',
  'stop',
  'destroy',
  'list-owned',
  'exec',
  // One-shot tty-flagged command execution, not an attachable PTY session.
  'pty',
]);
const STATE_VERSION = 2;
const LEGACY_STATE_VERSION = 1;
const STATE_FILE = 'alpi-engine-state.json';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;
const ALLOCATION_NAME_PATTERN =
  /^alpi-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-g([1-9][0-9]*)$/i;

const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
const MAX_EXEC_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const MAX_OUTPUT_BYTES = 8 * 1_048_576;
const DEFAULT_TERMINATION_GRACE_MS = 5_000;
const MAX_TERMINATION_GRACE_MS = 30_000;
const MAX_ARG_BYTES = 4_096;
const MAX_ARGV_BYTES = 65_536;
const MAX_NATIVE_ID_LENGTH = 256;
const MAX_ALLOCATION_NAME_LENGTH = 128;
const MAX_ERROR_MESSAGE_LENGTH = 4_096;
const ID_READ_TIMEOUT_MS = 250;

const SDK_FAILURE_MESSAGES = Object.freeze({
  engine_unavailable: 'BoxLite engine is unavailable.',
  engine_runtime_invalid: 'BoxLite runtime is invalid.',
  engine_inspect_failed: 'BoxLite inspection failed.',
  engine_list_failed: 'BoxLite inventory failed.',
  engine_create_failed: 'BoxLite allocation failed.',
  engine_start_failed: 'BoxLite box could not be started.',
  engine_stop_failed: 'BoxLite box could not be stopped.',
  engine_destroy_failed: 'BoxLite box could not be destroyed.',
  engine_exec_dispatch_failed: 'BoxLite execution dispatch failed.',
  engine_export_failed: 'BoxLite export failed.',
  engine_network_unverified: 'Network boundary verification failed.',
});

/**
 * In-process single-writer lease for runtime homes. The adapter owns the home
 * until close(); a second adapter instance in the same process is refused
 * rather than silently sharing mutable engine state.
 */
const ACTIVE_HOMES = new Set();

class BoxliteEngineError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'BoxliteEngineError';
    this.code = code;
    this.engineId = ENGINE_ID;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

function fail(code, message, details) {
  throw new BoxliteEngineError(code, message, details);
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

function assertAbsolutePath(value, code, label) {
  if (typeof value !== 'string' || value.length === 0 || !path.isAbsolute(value)) {
    fail(code, `${label} must be an absolute path.`);
  }
  return path.resolve(value);
}

function assertPrivateDirectory(directory, code, label) {
  let stat;
  try {
    stat = fs.lstatSync(directory);
  } catch {
    fail(code, `${label} is not a private directory.`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(code, `${label} is not a private directory.`);
  }
  const uid = currentUid();
  if (uid !== null && stat.uid !== uid && stat.uid !== 0) {
    fail(code, `${label} is not owned by the service account.`);
  }
  if ((stat.mode & 0o077) !== 0) {
    fail(code, `${label} must not be accessible by group or others.`);
  }
  try {
    fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
  } catch {
    fail(code, `${label} is not accessible to the service account.`);
  }
}

function ensurePrivateDirectory(directory, code, label) {
  const stat = lstatOrNull(directory);
  if (!stat) {
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.chmodSync(directory, 0o700);
    } catch {
      fail(code, `${label} could not be created.`);
    }
  }
  assertPrivateDirectory(directory, code, label);
}

function assertTrustedModulePath(modulePath) {
  if (typeof modulePath !== 'string' || modulePath.length === 0 || !path.isAbsolute(modulePath)) {
    fail('untrusted_module_path', 'SDK module path must be an absolute path.');
  }
  let stat;
  try {
    stat = fs.lstatSync(modulePath);
  } catch {
    fail('untrusted_module_path', 'SDK module path is not readable.');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail('untrusted_module_path', 'SDK module path must be a regular file, not a symlink.');
  }
  const uid = currentUid();
  if (uid !== null && stat.uid !== uid && stat.uid !== 0) {
    fail('untrusted_module_path', 'SDK module path is not owned by the service account.');
  }
  if ((stat.mode & 0o022) !== 0) {
    fail('untrusted_module_path', 'SDK module path must not be group or world writable.');
  }
  try {
    fs.accessSync(modulePath, fs.constants.R_OK);
  } catch {
    fail('untrusted_module_path', 'SDK module path is not readable.');
  }
}

function assertStagingChild(stagingDir, target, { mustExist, label }) {
  const base = path.resolve(stagingDir);
  const resolved = assertAbsolutePath(target, 'staging_path_forbidden', label);
  const relative = path.relative(base, resolved);
  if (
    relative.length === 0 ||
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    path.dirname(resolved) !== base
  ) {
    fail('staging_path_forbidden', `${label} must be directly inside the trusted staging directory.`);
  }
  const stat = lstatOrNull(resolved);
  if (mustExist) {
    if (!stat) {
      fail('staging_path_missing', `${label} does not exist.`);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail('staging_path_forbidden', `${label} must be a regular file, not a symlink.`);
    }
    try {
      fs.accessSync(resolved, fs.constants.R_OK);
    } catch {
      fail('staging_path_forbidden', `${label} is not readable.`);
    }
  } else if (stat) {
    fail('staging_path_conflict', `${label} already exists.`);
  }
  return resolved;
}

function normalizeImage(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    fail('invalid_engine_config', 'A pinned image reference is required.');
  }
  if (!/@sha256:[a-f0-9]{64}$/i.test(value)) {
    fail('invalid_engine_config', 'The image must be pinned by a sha256 digest.');
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    fail('invalid_engine_config', 'The image reference contains control characters.');
  }
  return value;
}

function normalizeLimits(limits) {
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) {
    fail('invalid_engine_config', 'Resource limits are required.');
  }
  const { cpus, memoryMib, diskSizeGb } = limits;
  if (typeof cpus !== 'number' || !Number.isFinite(cpus) || cpus <= 0 || cpus > 64) {
    fail('invalid_engine_config', 'cpus must be a positive number no greater than 64.');
  }
  if (!Number.isSafeInteger(memoryMib) || memoryMib < 128 || memoryMib > 262_144) {
    fail('invalid_engine_config', 'memoryMib must be an integer between 128 and 262144.');
  }
  if (!Number.isSafeInteger(diskSizeGb) || diskSizeGb < 1 || diskSizeGb > 4_096) {
    fail('invalid_engine_config', 'diskSizeGb must be an integer between 1 and 4096.');
  }
  return Object.freeze({ cpus, memoryMib, diskSizeGb });
}

function normalizeExecLimits(limits) {
  if (limits !== undefined && (!limits || typeof limits !== 'object' || Array.isArray(limits))) {
    fail('invalid_engine_config', 'execLimits must be an object.');
  }
  const source = limits === undefined ? {} : limits;
  const timeoutMs = source.timeoutMs === undefined ? DEFAULT_EXEC_TIMEOUT_MS : source.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_EXEC_TIMEOUT_MS) {
    fail('invalid_engine_config', 'exec timeoutMs is outside the supported range.');
  }
  const maxOutputBytes =
    source.maxOutputBytes === undefined ? DEFAULT_MAX_OUTPUT_BYTES : source.maxOutputBytes;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > MAX_OUTPUT_BYTES) {
    fail('invalid_engine_config', 'exec maxOutputBytes is outside the supported range.');
  }
  const terminationGraceMs =
    source.terminationGraceMs === undefined
      ? DEFAULT_TERMINATION_GRACE_MS
      : source.terminationGraceMs;
  if (
    !Number.isSafeInteger(terminationGraceMs) ||
    terminationGraceMs < 1 ||
    terminationGraceMs > MAX_TERMINATION_GRACE_MS
  ) {
    fail('invalid_engine_config', 'exec terminationGraceMs is outside the supported range.');
  }
  return Object.freeze({ timeoutMs, maxOutputBytes, terminationGraceMs });
}

function normalizeAllocationId(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    fail('invalid_input', 'Allocation id must be a UUID.');
  }
  return value.toLowerCase();
}

function normalizeLaunchGeneration(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000_000) {
    fail('invalid_input', 'Launch generation must be a positive integer.');
  }
  return value;
}

function allocationName(allocationId, launchGeneration) {
  const name = `alpi-${allocationId}-g${launchGeneration}`;
  if (name.length > MAX_ALLOCATION_NAME_LENGTH) {
    fail('invalid_input', 'Allocation name is too long.');
  }
  return name;
}

function normalizeRef(ref) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) {
    fail('invalid_input', 'An engine box reference is required.');
  }
  const allocationId = normalizeAllocationId(ref.allocationId);
  const launchGeneration = normalizeLaunchGeneration(ref.launchGeneration);
  const name = allocationName(allocationId, launchGeneration);
  if (ref.name !== name) {
    fail('engine_identity_mismatch', 'Box name does not match the allocation and launch.');
  }
  if (
    typeof ref.nativeId !== 'string' ||
    ref.nativeId.length === 0 ||
    ref.nativeId.length > MAX_NATIVE_ID_LENGTH
  ) {
    fail('invalid_input', 'Native box id is required.');
  }
  return Object.freeze({ allocationId, launchGeneration, name, nativeId: ref.nativeId });
}

function normalizeNetwork(network) {
  if (network === undefined || network === 'disabled') {
    return Object.freeze({ mode: 'disabled' });
  }
  if (network === 'boundary') {
    return Object.freeze({ mode: 'boundary' });
  }
  if (network === 'enabled') {
    fail('network_unavailable', 'Unrestricted network mode is not implemented.');
  }
  if (!network || typeof network !== 'object' || Array.isArray(network)) {
    fail('invalid_input', 'Invalid network profile.');
  }
  if ('allowNet' in network) {
    fail('network_unavailable', 'Caller-supplied network allowlists are not supported.');
  }
  if (network.mode === 'disabled') {
    return Object.freeze({ mode: 'disabled' });
  }
  if (network.mode === 'boundary') {
    return Object.freeze({ mode: 'boundary' });
  }
  if (network.mode === 'enabled') {
    fail('network_unavailable', 'Unrestricted network mode is not implemented.');
  }
  fail('invalid_input', 'Invalid network profile.');
}

function normalizeProfile(profile) {
  if (profile === undefined) {
    profile = {};
  }
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    fail('invalid_input', 'Profile must be an object.');
  }
  if (profile.image !== undefined) {
    fail('unsupported_profile', 'The image is fixed by the operator, not by a profile.');
  }
  if (profile.limits !== undefined) {
    fail('unsupported_profile', 'Resource limits are fixed by the operator, not by a profile.');
  }
  for (const key of ['volumes', 'ports', 'secrets', 'hostMounts']) {
    if (profile[key] !== undefined) {
      if (!Array.isArray(profile[key]) || profile[key].length > 0) {
        fail('unsupported_profile', `${key} are not allowed in the default profile.`);
      }
    }
  }
  if (profile.env !== undefined) {
    if (!Array.isArray(profile.env) || profile.env.length > 0) {
      fail('unsupported_profile', 'Caller-supplied environment is not allowed.');
    }
  }
  return Object.freeze({ network: normalizeNetwork(profile.network) });
}

function normalizeArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    fail('invalid_input', 'argv must be a non-empty array.');
  }
  let total = 0;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (typeof argument !== 'string') {
      fail('invalid_input', 'Every argv entry must be a string.');
    }
    if (index === 0 && argument.length === 0) {
      fail('invalid_input', 'The argv command must not be empty.');
    }
    if (argument.length > MAX_ARG_BYTES) {
      fail('invalid_input', 'An argv entry is too long.');
    }
    if (argument.includes('\u0000')) {
      fail('invalid_input', 'argv entries must not contain NUL.');
    }
    total += Buffer.byteLength(argument, 'utf8');
  }
  if (total > MAX_ARGV_BYTES) {
    fail('invalid_input', 'argv is too large.');
  }
  return Object.freeze([...argv]);
}

function normalizeExecTimeout(value, fallback) {
  const timeoutMs = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_EXEC_TIMEOUT_MS) {
    fail('invalid_input', 'timeoutMs is outside the supported range.');
  }
  return timeoutMs;
}

function normalizeMaxOutputBytes(value, fallback) {
  const maxOutputBytes = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > MAX_OUTPUT_BYTES) {
    fail('invalid_input', 'maxOutputBytes is outside the supported range.');
  }
  return maxOutputBytes;
}

function normalizeWorkingDir(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096) {
    fail('invalid_input', 'workingDir must be a guest path.');
  }
  if (!value.startsWith('/') || value.includes('\u0000')) {
    fail('invalid_input', 'workingDir must be an absolute guest path.');
  }
  return value;
}

function validateBoundaryNetwork(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('network_boundary_invalid', 'The boundary provider returned no network specification.');
  }
  const outbound = value.outbound;
  if (!outbound || typeof outbound !== 'object' || outbound.mode !== 'enabled') {
    fail('network_boundary_invalid', 'The boundary provider must enable a restricted outbound network.');
  }
  if (!Array.isArray(outbound.allowNet) || outbound.allowNet.length === 0) {
    fail('network_boundary_invalid', 'The boundary provider must supply a non-empty outbound allowlist.');
  }
  const allowNet = outbound.allowNet.map((host) => {
    if (
      typeof host !== 'string' ||
      host.length === 0 ||
      host.length > 255 ||
      /[\u0000-\u0020\u007f]/.test(host)
    ) {
      fail('network_boundary_invalid', 'The boundary provider returned an invalid outbound allowlist entry.');
    }
    return host;
  });
  const inbound = value.inbound;
  if (!inbound || typeof inbound !== 'object' || inbound.mode !== 'disabled') {
    fail('network_boundary_invalid', 'Inbound networking must remain disabled.');
  }
  if (inbound.allowNet !== undefined) {
    fail('network_boundary_invalid', 'Inbound allowlists are not supported.');
  }
  return Object.freeze({
    outbound: Object.freeze({ mode: 'enabled', allowNet: Object.freeze(allowNet) }),
    inbound: Object.freeze({ mode: 'disabled' }),
  });
}

function assertRuntimeShape(runtime) {
  if (!runtime || typeof runtime !== 'object') {
    fail('engine_runtime_invalid', 'BoxLite runtime is invalid.');
  }
  for (const method of ['getOrCreate', 'listInfo', 'getInfo', 'get', 'remove', 'importBox']) {
    if (typeof runtime[method] !== 'function') {
      fail('engine_runtime_invalid', `BoxLite runtime is missing ${method}().`);
    }
  }
}

function assertBoxShape(box, expectedName, expectedId) {
  if (!box || typeof box !== 'object') {
    fail('engine_identity_mismatch', 'BoxLite returned no box handle.');
  }
  if (
    typeof box.id !== 'string' ||
    box.id.length === 0 ||
    box.id.length > MAX_NATIVE_ID_LENGTH
  ) {
    fail('engine_identity_mismatch', 'BoxLite returned an invalid native box id.');
  }
  if (expectedId !== undefined && box.id !== expectedId) {
    fail('engine_identity_mismatch', 'BoxLite returned a handle with a different native box id.', {
      expectedNativeId: expectedId,
    });
  }
  if (box.name !== expectedName) {
    fail('engine_identity_mismatch', 'BoxLite returned a box with a different reserved name.');
  }
  for (const method of ['info', 'exec', 'start', 'stop', 'export']) {
    if (typeof box[method] !== 'function') {
      fail('engine_runtime_invalid', `BoxLite box is missing ${method}().`);
    }
  }
}

function assertGetOrCreateResult(result) {
  if (!result || typeof result !== 'object' || typeof result.created !== 'boolean') {
    fail('engine_runtime_invalid', 'BoxLite getOrCreate returned an invalid result.');
  }
  if (!result.box) {
    fail('engine_runtime_invalid', 'BoxLite getOrCreate returned no box.');
  }
}

function assertExecutionShape(execution) {
  if (!execution || typeof execution !== 'object') {
    fail('engine_runtime_invalid', 'BoxLite returned no execution handle.');
  }
  for (const method of ['id', 'stdout', 'stderr', 'wait', 'kill']) {
    if (typeof execution[method] !== 'function') {
      fail('engine_runtime_invalid', `BoxLite execution is missing ${method}().`);
    }
  }
}

function readPackageVersion(modulePath) {
  if (typeof modulePath !== 'string') {
    return null;
  }
  const candidates = [
    path.join(path.dirname(modulePath), 'package.json'),
    path.join(path.dirname(modulePath), '..', 'package.json'),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (
        parsed &&
        parsed.name === '@boxlite-ai/boxlite' &&
        typeof parsed.version === 'string'
      ) {
        return parsed.version;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashOf(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function sameStringSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false;
  }
  const leftSet = new Set(left);
  if (leftSet.size !== left.length) {
    return false;
  }
  for (const entry of right) {
    if (!leftSet.has(entry)) {
      return false;
    }
  }
  return true;
}

function sanitizeInfo(info, record) {
  if (!info || typeof info !== 'object' || Array.isArray(info)) {
    fail('engine_invalid_result', 'BoxLite returned invalid box information.');
  }
  if (info.id !== record.nativeId || info.name !== record.name) {
    fail('engine_identity_mismatch', 'BoxLite information does not match the owned box.');
  }
  const state = info.state;
  if (
    !state ||
    typeof state !== 'object' ||
    typeof state.status !== 'string' ||
    typeof state.running !== 'boolean'
  ) {
    fail('engine_invalid_result', 'BoxLite returned invalid box state.');
  }
  let network = null;
  if (info.network && typeof info.network === 'object') {
    const outbound = info.network.outbound;
    const inbound = info.network.inbound;
    if (outbound && inbound) {
      network = {
        outbound: {
          mode: outbound.mode,
          allowNet: Array.isArray(outbound.allowNet) ? [...outbound.allowNet] : [],
        },
        inbound: {
          mode: inbound.mode,
          allowNet: Array.isArray(inbound.allowNet) ? [...inbound.allowNet] : [],
        },
      };
    }
  }
  return Object.freeze({
    allocationId: record.allocationId,
    launchGeneration: record.launchGeneration,
    name: record.name,
    nativeId: record.nativeId,
    status: record.status,
    configVerified: Boolean(record.config && record.configHash),
    state: state.status,
    running: state.running,
    ...(state.exitCode === undefined ? {} : { exitCode: state.exitCode }),
    image: info.image,
    cpus: info.cpus,
    memoryMib: info.memoryMib,
    createdAt: info.createdAt,
    ...(info.startedAt === undefined ? {} : { startedAt: info.startedAt }),
    network,
    autoStop: info.autoStop,
    autoDelete: info.autoDelete,
  });
}

function deadlineError(phase, uncertain) {
  const dispatched = phase === 'dispatch' || phase === 'collect';
  return new BoxliteEngineError('engine_exec_deadline_exceeded', 'Execution deadline exceeded.', {
    phase,
    dispatched,
    uncertain,
  });
}

/**
 * Resolve a promise or report a timeout. The underlying promise is observed so
 * a late rejection never becomes an unhandled rejection.
 *
 * @returns {Promise<{status:'ok', value:unknown}|{status:'error', error:unknown}|{status:'timeout'}>}
 */
function boundedPromise(promise, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => finish({ status: 'timeout' }), Math.max(0, timeoutMs));
    Promise.resolve(promise).then(
      (value) => finish({ status: 'ok', value }),
      (error) => finish({ status: 'error', error })
    );
  });
}

/**
 * Create a BoxLite adapter.
 *
 * @param {{
 *   homeDir: string,
 *   image: string,
 *   limits: { cpus: number, memoryMib: number, diskSizeGb: number },
 *   sdkModulePath?: string,
 *   sdk?: object,
 *   runtime?: object,
 *   expectedSdkVersion?: string|null,
 *   execLimits?: { timeoutMs?: number, maxOutputBytes?: number, terminationGraceMs?: number },
 *   stagingDir?: string,
 *   networkBoundary?: { prepare: Function, verify: Function },
 *   guestUid?: number
 * }} options
 */
function createBoxliteAdapter(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    fail('invalid_engine_config', 'BoxLite adapter options must be an object.');
  }

  const homeDir = assertAbsolutePath(options.homeDir, 'invalid_engine_config', 'homeDir');
  const image = normalizeImage(options.image);
  const limits = normalizeLimits(options.limits);
  const execLimits = normalizeExecLimits(options.execLimits);
  const guestUid = options.guestUid ?? 1000;
  if (!Number.isSafeInteger(guestUid) || guestUid < 1 || guestUid > 2147483647) {
    fail('invalid_engine_config', 'The configured guest UID must be unprivileged.');
  }

  let sdkModulePath;
  if (options.sdkModulePath !== undefined) {
    sdkModulePath = assertAbsolutePath(
      options.sdkModulePath,
      'invalid_engine_config',
      'sdkModulePath'
    );
  }
  let stagingDir;
  if (options.stagingDir !== undefined) {
    stagingDir = assertAbsolutePath(options.stagingDir, 'invalid_engine_config', 'stagingDir');
  }

  if (options.sdk !== undefined && (!options.sdk || typeof options.sdk !== 'object')) {
    fail('invalid_engine_config', 'sdk must be a module namespace.');
  }
  if (options.runtime !== undefined && (!options.runtime || typeof options.runtime !== 'object')) {
    fail('invalid_engine_config', 'runtime must be a runtime instance.');
  }
  if (options.sdk === undefined && options.runtime === undefined && sdkModulePath === undefined) {
    fail('invalid_engine_config', 'Either sdkModulePath, sdk or runtime is required.');
  }

  let expectedSdkVersion;
  if (options.expectedSdkVersion === undefined) {
    expectedSdkVersion = BOXLITE_VERSION;
  } else if (options.expectedSdkVersion === null || typeof options.expectedSdkVersion === 'string') {
    expectedSdkVersion = options.expectedSdkVersion;
  } else {
    fail('invalid_engine_config', 'expectedSdkVersion must be a string or null.');
  }

  let networkBoundary;
  if (options.networkBoundary !== undefined) {
    const provider = options.networkBoundary;
    if (
      !provider ||
      typeof provider !== 'object' ||
      typeof provider.prepare !== 'function' ||
      typeof provider.verify !== 'function'
    ) {
      fail('invalid_engine_config', 'networkBoundary requires prepare() and verify().');
    }
    networkBoundary = provider;
  }

  if (ACTIVE_HOMES.has(homeDir)) {
    fail('engine_home_in_use', 'Another adapter instance owns this runtime home.', { homeDir });
  }
  ACTIVE_HOMES.add(homeDir);

  const statePath = path.join(homeDir, STATE_FILE);
  let sdk = options.sdk;
  let runtime = options.runtime;
  let records = null;
  let stateLoaded = false;
  let probeResult = null;
  let closed = false;

  function requireOpen() {
    if (closed) {
      fail('engine_closed', 'BoxLite adapter is closed.');
    }
  }

  function releaseHome() {
    ACTIVE_HOMES.delete(homeDir);
  }

  async function loadSdk() {
    if (sdk) {
      return sdk;
    }
    if (!sdkModulePath) {
      fail('invalid_engine_config', 'No SDK module path is configured.');
    }
    assertTrustedModulePath(sdkModulePath);
    const url = pathToFileURL(sdkModulePath).href;
    try {
      const loaded = await import(url);
      sdk = loaded;
      return loaded;
    } catch {
      fail('engine_unavailable', 'BoxLite SDK could not be loaded.');
    }
  }

  function sdkVersion() {
    if (sdk) {
      if (typeof sdk.version === 'string') {
        return sdk.version;
      }
      if (typeof sdk.packageVersion === 'string') {
        return sdk.packageVersion;
      }
    }
    return readPackageVersion(sdkModulePath);
  }

  async function getRuntime() {
    if (runtime) {
      assertRuntimeShape(runtime);
      return runtime;
    }
    const loaded = await loadSdk();
    if (!loaded || typeof loaded.JsBoxlite !== 'function') {
      fail('engine_unavailable', 'The SDK does not export JsBoxlite.');
    }
    let opened;
    try {
      opened = new loaded.JsBoxlite({ homeDir });
    } catch {
      fail('engine_unavailable', 'BoxLite runtime could not be opened.');
    }
    assertRuntimeShape(opened);
    runtime = opened;
    return runtime;
  }

  function buildConfig(profile) {
    return Object.freeze({
      image,
      cpus: limits.cpus,
      memoryMib: limits.memoryMib,
      diskSizeGb: limits.diskSizeGb,
      guestUid,
      networkMode: profile.network.mode,
      runtimeHome: homeDir,
      sdkVersion: expectedSdkVersion,
      lifecycle: Object.freeze({ autoStop: 0, autoDelete: 0, autoResume: false }),
    });
  }

  function makeRecord(fields) {
    return Object.freeze({
      allocationId: fields.allocationId,
      launchGeneration: fields.launchGeneration,
      name: fields.name,
      nativeId: fields.nativeId ?? null,
      createdAt: fields.createdAt,
      status: fields.status,
      created: fields.created ?? null,
      operationId: fields.operationId ?? null,
      fingerprint: fields.fingerprint ?? null,
      config: fields.config ?? null,
      configHash: fields.configHash ?? null,
      network: fields.network ?? null,
      lastError: fields.lastError ?? null,
    });
  }

  function parseConfig(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      fail('engine_state_corrupt', 'Engine state contains an invalid configuration.');
    }
    let normalizedImage;
    let normalizedLimits;
    try {
      normalizedImage = normalizeImage(value.image);
      normalizedLimits = normalizeLimits(value);
    } catch {
      fail('engine_state_corrupt', 'Engine state contains an invalid configuration.');
    }
    if (
      !Number.isSafeInteger(value.guestUid) ||
      value.guestUid < 1 ||
      value.guestUid > 2147483647 ||
      (value.networkMode !== 'disabled' && value.networkMode !== 'boundary') ||
      typeof value.runtimeHome !== 'string' ||
      !path.isAbsolute(value.runtimeHome) ||
      (value.sdkVersion !== null && typeof value.sdkVersion !== 'string')
    ) {
      fail('engine_state_corrupt', 'Engine state contains an invalid configuration.');
    }
    const lifecycle = value.lifecycle;
    if (
      !lifecycle ||
      typeof lifecycle !== 'object' ||
      lifecycle.autoStop !== 0 ||
      lifecycle.autoDelete !== 0 ||
      lifecycle.autoResume !== false
    ) {
      fail('engine_state_corrupt', 'Engine state contains an invalid lifecycle configuration.');
    }
    return Object.freeze({
      image: normalizedImage,
      cpus: normalizedLimits.cpus,
      memoryMib: normalizedLimits.memoryMib,
      diskSizeGb: normalizedLimits.diskSizeGb,
      guestUid: value.guestUid,
      networkMode: value.networkMode,
      runtimeHome: value.runtimeHome,
      sdkVersion: value.sdkVersion,
      lifecycle: Object.freeze({ autoStop: 0, autoDelete: 0, autoResume: false }),
    });
  }

  function parseNetwork(value, status, networkMode) {
    if (value === null || value === undefined) {
      if (status === 'pending') {
        return null;
      }
      fail('engine_state_corrupt', 'Engine state contains no network grant.');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.mode !== networkMode) {
      fail('engine_state_corrupt', 'Engine state contains an invalid network grant.');
    }
    if (networkMode === 'disabled') {
      return Object.freeze({ mode: 'disabled' });
    }
    if (
      !Array.isArray(value.allowNet) ||
      value.allowNet.length === 0 ||
      typeof value.grantHash !== 'string' ||
      !HASH_PATTERN.test(value.grantHash)
    ) {
      fail('engine_state_corrupt', 'Engine state contains an invalid boundary grant.');
    }
    const allowNet = value.allowNet.map((host) => {
      if (
        typeof host !== 'string' ||
        host.length === 0 ||
        host.length > 255 ||
        /[\u0000-\u0020\u007f]/.test(host)
      ) {
        fail('engine_state_corrupt', 'Engine state contains an invalid boundary grant.');
      }
      return host;
    });
    return Object.freeze({
      mode: 'boundary',
      allowNet: Object.freeze(allowNet),
      grantHash: value.grantHash,
    });
  }

  function parseLegacyAllocation(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail('engine_state_corrupt', 'Engine state contains an invalid allocation.');
    }
    let allocationId;
    let launchGeneration;
    try {
      allocationId = normalizeAllocationId(entry.allocationId);
      launchGeneration = normalizeLaunchGeneration(entry.launchGeneration);
    } catch {
      fail('engine_state_corrupt', 'Engine state contains an invalid allocation.');
    }
    const name = allocationName(allocationId, launchGeneration);
    if (
      entry.name !== name ||
      typeof entry.nativeId !== 'string' ||
      entry.nativeId.length === 0 ||
      entry.nativeId.length > MAX_NATIVE_ID_LENGTH ||
      typeof entry.createdAt !== 'string'
    ) {
      fail('engine_state_corrupt', 'Engine state contains an invalid allocation.');
    }
    return makeRecord({
      allocationId,
      launchGeneration,
      name,
      nativeId: entry.nativeId,
      createdAt: entry.createdAt,
      status: 'legacy',
      created: null,
      operationId: null,
      fingerprint: null,
      config: null,
      configHash: null,
      network: null,
      lastError: null,
    });
  }

  function parseCurrentAllocation(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail('engine_state_corrupt', 'Engine state contains an invalid allocation.');
    }
    let allocationId;
    let launchGeneration;
    try {
      allocationId = normalizeAllocationId(entry.allocationId);
      launchGeneration = normalizeLaunchGeneration(entry.launchGeneration);
    } catch {
      fail('engine_state_corrupt', 'Engine state contains an invalid allocation.');
    }
    const name = allocationName(allocationId, launchGeneration);
    if (entry.name !== name || typeof entry.createdAt !== 'string') {
      fail('engine_state_corrupt', 'Engine state contains an invalid allocation.');
    }
    const status = entry.status;
    if (!['pending', 'allocated', 'owned', 'cleanup-pending'].includes(status)) {
      fail('engine_state_corrupt', 'Engine state contains an invalid allocation status.');
    }
    const nativeId = entry.nativeId;
    if (status === 'pending') {
      if (nativeId !== null && nativeId !== undefined) {
        fail('engine_state_corrupt', 'A pending allocation must not record a native id.');
      }
    } else if (
      typeof nativeId !== 'string' ||
      nativeId.length === 0 ||
      nativeId.length > MAX_NATIVE_ID_LENGTH
    ) {
      fail('engine_state_corrupt', 'Engine state contains an invalid native id.');
    }
    const config = parseConfig(entry.config);
    if (
      typeof entry.configHash !== 'string' ||
      !HASH_PATTERN.test(entry.configHash) ||
      typeof entry.fingerprint !== 'string' ||
      !HASH_PATTERN.test(entry.fingerprint) ||
      typeof entry.operationId !== 'string' ||
      entry.operationId.length === 0 ||
      entry.operationId.length > 128 ||
      (entry.created !== null && typeof entry.created !== 'boolean') ||
      (entry.lastError !== null &&
        entry.lastError !== undefined &&
        (typeof entry.lastError !== 'string' || !ERROR_CODE_PATTERN.test(entry.lastError)))
    ) {
      fail('engine_state_corrupt', 'Engine state contains an invalid allocation receipt.');
    }
    const network = parseNetwork(entry.network, status, config.networkMode);
    return makeRecord({
      allocationId,
      launchGeneration,
      name,
      nativeId: status === 'pending' ? null : nativeId,
      createdAt: entry.createdAt,
      status,
      created: entry.created ?? null,
      operationId: entry.operationId,
      fingerprint: entry.fingerprint,
      config,
      configHash: entry.configHash,
      network,
      lastError: entry.lastError ?? null,
    });
  }

  function loadState() {
    if (stateLoaded) {
      return;
    }
    ensurePrivateDirectory(homeDir, 'unsafe_home', 'Runtime home');
    const stat = lstatOrNull(statePath);
    if (!stat) {
      records = new Map();
      stateLoaded = true;
      return;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail('engine_state_corrupt', 'Engine state is not a regular file.');
    }
    const uid = currentUid();
    if (uid !== null && stat.uid !== uid && stat.uid !== 0) {
      fail('engine_state_corrupt', 'Engine state is not owned by the service account.');
    }
    if ((stat.mode & 0o777) !== 0o600) {
      fail('engine_state_corrupt', 'Engine state must be private.');
    }
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    } catch {
      fail('engine_state_corrupt', 'Engine state is not valid JSON.');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      fail('engine_state_corrupt', 'Engine state has an unsupported shape.');
    }
    if (!Array.isArray(parsed.allocations)) {
      fail('engine_state_corrupt', 'Engine state has an unsupported shape.');
    }
    if (parsed.version !== LEGACY_STATE_VERSION && parsed.version !== STATE_VERSION) {
      fail('engine_state_corrupt', 'Engine state has an unsupported version.');
    }
    const next = new Map();
    for (const entry of parsed.allocations) {
      const record =
        parsed.version === LEGACY_STATE_VERSION
          ? parseLegacyAllocation(entry)
          : parseCurrentAllocation(entry);
      if (next.has(record.allocationId)) {
        fail('engine_state_corrupt', 'Engine state contains a duplicate allocation.');
      }
      next.set(record.allocationId, record);
    }
    records = next;
    stateLoaded = true;
  }

  function serializeRecord(record) {
    return {
      allocationId: record.allocationId,
      launchGeneration: record.launchGeneration,
      name: record.name,
      nativeId: record.nativeId,
      createdAt: record.createdAt,
      status: record.status,
      created: record.created,
      operationId: record.operationId,
      fingerprint: record.fingerprint,
      config: record.config,
      configHash: record.configHash,
      network: record.network,
      lastError: record.lastError,
    };
  }

  function writeState(next) {
    ensurePrivateDirectory(homeDir, 'unsafe_home', 'Runtime home');
    const allocations = [...next.values()]
      .map(serializeRecord)
      .sort((left, right) => left.allocationId.localeCompare(right.allocationId));
    const data = JSON.stringify({ version: STATE_VERSION, allocations }, null, 2);
    const temp = path.join(
      homeDir,
      `.${STATE_FILE}.${crypto.randomBytes(8).toString('hex')}.tmp`
    );
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, data, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temp, statePath);
      let directoryFd;
      try {
        directoryFd = fs.openSync(homeDir, 'r');
        fs.fsyncSync(directoryFd);
      } catch (error) {
        if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) {
          throw error;
        }
      } finally {
        if (directoryFd !== undefined) {
          fs.closeSync(directoryFd);
        }
      }
    } catch {
      fail('engine_state_write_failed', 'Engine state could not be written.');
    } finally {
      if (fd !== undefined) {
        fs.closeSync(fd);
      }
      try {
        fs.unlinkSync(temp);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          // The original failure is more useful than a cleanup failure.
        }
      }
    }
  }

  function saveRecords(next) {
    writeState(next);
    records = next;
    stateLoaded = true;
  }

  function commitRecord(record) {
    const next = new Map(records);
    next.set(record.allocationId, record);
    saveRecords(next);
  }

  function tryCommitRecord(record) {
    try {
      commitRecord(record);
      return true;
    } catch {
      return false;
    }
  }

  function deleteRecord(allocationId) {
    const next = new Map(records);
    next.delete(allocationId);
    saveRecords(next);
  }

  function recordForRef(ref) {
    const normalized = normalizeRef(ref);
    loadState();
    const record = records.get(normalized.allocationId);
    if (!record) {
      fail('engine_unknown_allocation', 'Allocation is not owned by this adapter.', normalized);
    }
    if (record.status === 'pending' || !record.nativeId) {
      fail('engine_allocation_pending', 'Allocation has no observed native identity.', {
        allocationId: record.allocationId,
        launchGeneration: record.launchGeneration,
      });
    }
    if (record.launchGeneration !== normalized.launchGeneration) {
      fail('engine_generation_mismatch', 'Launch generation does not match the current launch.', {
        allocationId: normalized.allocationId,
        expectedGeneration: record.launchGeneration,
        receivedGeneration: normalized.launchGeneration,
      });
    }
    if (record.nativeId !== normalized.nativeId || record.name !== normalized.name) {
      fail('engine_identity_mismatch', 'Box identity does not match the owned allocation.', {
        allocationId: normalized.allocationId,
        expectedNativeId: record.nativeId,
      });
    }
    return { normalized, record };
  }

  function assertRecordConfig(record) {
    if (
      record.status === 'legacy' ||
      !record.config ||
      !record.configHash ||
      record.config.runtimeHome !== homeDir ||
      !record.network ||
      record.network.mode !== record.config.networkMode
    ) {
      fail('engine_config_unverified', 'The allocation configuration cannot be verified.', {
        allocationId: record.allocationId,
        nativeId: record.nativeId,
        status: record.status,
      });
    }
  }

  function assertInfoIdentity(info, record) {
    if (!info || typeof info !== 'object' || Array.isArray(info)) {
      fail('engine_invalid_result', 'BoxLite returned invalid box information.');
    }
    if (
      typeof info.id !== 'string' ||
      info.id.length === 0 ||
      info.id.length > MAX_NATIVE_ID_LENGTH ||
      typeof info.name !== 'string'
    ) {
      fail('engine_invalid_result', 'BoxLite returned invalid box identity.');
    }
    if (info.id !== record.nativeId || info.name !== record.name) {
      fail('engine_identity_mismatch', 'BoxLite information does not match the owned box.', {
        allocationId: record.allocationId,
        expectedNativeId: record.nativeId,
      });
    }
  }

  function assertInfoState(info) {
    if (
      !info ||
      typeof info !== 'object' ||
      !info.state ||
      typeof info.state !== 'object' ||
      typeof info.state.running !== 'boolean'
    ) {
      fail('engine_invalid_result', 'BoxLite returned invalid box state.');
    }
  }

  function assertEffectiveConfig(record, info) {
    assertRecordConfig(record);
    assertInfoState(info);
    const config = record.config;
    if (info.image !== config.image) {
      fail('engine_config_mismatch', 'Box image does not match the recorded operator configuration.', {
        allocationId: record.allocationId,
        nativeId: record.nativeId,
      });
    }
    if (info.cpus !== config.cpus || info.memoryMib !== config.memoryMib) {
      fail('engine_config_mismatch', 'Box resources do not match the recorded operator configuration.', {
        allocationId: record.allocationId,
        nativeId: record.nativeId,
      });
    }
    if (
      info.privileged === true ||
      info.autoStop !== config.lifecycle.autoStop ||
      info.autoDelete !== config.lifecycle.autoDelete ||
      info.autoResume !== config.lifecycle.autoResume
    ) {
      fail('engine_config_mismatch', 'Box lifecycle settings do not match the recorded operator configuration.', {
        allocationId: record.allocationId,
        nativeId: record.nativeId,
      });
    }
    const network = info.network;
    if (!network || typeof network !== 'object') {
      fail('engine_network_unverified', 'Box network state cannot be verified.', {
        allocationId: record.allocationId,
        nativeId: record.nativeId,
      });
    }
    if (config.networkMode === 'disabled') {
      if (
        !network.outbound ||
        network.outbound.mode !== 'disabled' ||
        !network.inbound ||
        network.inbound.mode !== 'disabled'
      ) {
        fail('engine_network_unverified', 'Box network is not disconnected as recorded.', {
          allocationId: record.allocationId,
          nativeId: record.nativeId,
        });
      }
      return;
    }
    if (
      !network.outbound ||
      network.outbound.mode !== 'enabled' ||
      !network.inbound ||
      network.inbound.mode !== 'disabled'
    ) {
      fail('engine_network_unverified', 'Box network does not match the recorded boundary grant.', {
        allocationId: record.allocationId,
        nativeId: record.nativeId,
      });
    }
    const allowNet = Array.isArray(network.outbound.allowNet)
      ? network.outbound.allowNet
      : [];
    if (!sameStringSet(allowNet, record.network.allowNet)) {
      fail('engine_network_unverified', 'Box network allowlist does not match the recorded grant.', {
        allocationId: record.allocationId,
        nativeId: record.nativeId,
      });
    }
  }

  async function runBounded(factory, ctx, { phase, code, details, uncertain = false }) {
    if (ctx) {
      const remaining = ctx.deadlineAt - Date.now();
      if (remaining <= 0) {
        throw deadlineError(phase, uncertain);
      }
      const outcome = await boundedPromise(Promise.resolve().then(factory), remaining);
      if (outcome.status === 'timeout') {
        throw deadlineError(phase, uncertain);
      }
      if (outcome.status === 'error') {
        if (outcome.error instanceof BoxliteEngineError) {
          throw outcome.error;
        }
        fail(code, SDK_FAILURE_MESSAGES[code] ?? 'Engine operation failed.', details);
      }
      return outcome.value;
    }
    try {
      return await factory();
    } catch (error) {
      if (error instanceof BoxliteEngineError) {
        throw error;
      }
      fail(code, SDK_FAILURE_MESSAGES[code] ?? 'Engine operation failed.', details);
    }
  }

  async function fenceBox(box) {
    if (!box || typeof box.stop !== 'function') {
      return false;
    }
    const outcome = await boundedPromise(
      Promise.resolve().then(() => box.stop()),
      execLimits.terminationGraceMs
    );
    return outcome.status === 'ok';
  }

  async function verifyActivation(record, info, box, { ctx, running, created }) {
    if (record.config.networkMode !== 'boundary') {
      return;
    }
    if (!networkBoundary) {
      fail('engine_network_boundary_unavailable', 'A verified host network boundary is not available.', {
        allocationId: record.allocationId,
        nativeId: record.nativeId,
        networkMode: 'boundary',
      });
    }
    let verified = false;
    try {
      const result = await runBounded(
        () =>
          networkBoundary.verify({
            allocationId: record.allocationId,
            launchGeneration: record.launchGeneration,
            name: record.name,
            nativeId: record.nativeId,
            network: record.network,
            grantHash: record.network.grantHash,
            configHash: record.configHash,
            running,
            pid: info.state.pid ?? null,
            created,
          }),
        ctx,
        {
          phase: 'activation',
          code: 'engine_network_unverified',
          details: {
            allocationId: record.allocationId,
            nativeId: record.nativeId,
            running,
          },
          uncertain: true,
        }
      );
      verified = result === true;
    } catch (error) {
      if (error instanceof BoxliteEngineError && error.code === 'engine_exec_deadline_exceeded') {
        if (box) {
          await fenceBox(box);
        }
        throw error;
      }
      verified = false;
    }
    if (!verified) {
      const fenced = box ? await fenceBox(box) : false;
      fail('engine_network_unverified', 'Network boundary verification was refused.', {
        allocationId: record.allocationId,
        nativeId: record.nativeId,
        running,
        fenced,
        uncertain: true,
      });
    }
    if (running && info.state.running !== true) {
      const fenced = box ? await fenceBox(box) : false;
      fail('engine_start_unverified', 'BoxLite box is not running after activation.', {
        allocationId: record.allocationId,
        nativeId: record.nativeId,
        fenced,
      });
    }
  }

  async function resolveBox(ref, { ctx, requireConfig = false } = {}) {
    const { normalized, record } = recordForRef(ref);
    if (requireConfig) {
      assertRecordConfig(record);
    }
    const activeRuntime = await runBounded(() => getRuntime(), ctx, {
      phase: 'identity',
      code: 'engine_unavailable',
      details: {},
    });
    const info = await runBounded(() => activeRuntime.getInfo(record.nativeId), ctx, {
      phase: 'identity',
      code: 'engine_inspect_failed',
      details: { allocationId: record.allocationId, nativeId: record.nativeId },
    });
    if (info === null) {
      const nameInfo = await runBounded(() => activeRuntime.getInfo(record.name), ctx, {
        phase: 'identity',
        code: 'engine_inspect_failed',
        details: { allocationId: record.allocationId, name: record.name },
      });
      if (nameInfo !== null) {
        fail('engine_identity_conflict', 'A different native box occupies the reserved name.', {
          allocationId: record.allocationId,
          nativeId: record.nativeId,
          reason: 'name_occupied',
        });
      }
      fail('engine_box_missing', 'The owned box no longer exists.', {
        allocationId: record.allocationId,
        nativeId: record.nativeId,
      });
    }
    assertInfoIdentity(info, record);
    const box = await runBounded(() => activeRuntime.get(record.nativeId), ctx, {
      phase: 'identity',
      code: 'engine_inspect_failed',
      details: { allocationId: record.allocationId, nativeId: record.nativeId },
    });
    if (box === null) {
      fail('engine_box_missing', 'The owned box handle is unavailable.', {
        allocationId: record.allocationId,
        nativeId: record.nativeId,
      });
    }
    assertBoxShape(box, record.name, record.nativeId);
    return { normalized, record, box, runtime: activeRuntime, info };
  }

  async function ensureProbe() {
    if (probeResult) {
      return probeResult;
    }
    const result = await adapter.probe();
    if (!result.available) {
      fail(
        'engine_unavailable',
        `BoxLite engine is unavailable${result.reason === undefined ? '.' : `: ${result.reason}.`}`
      );
    }
    return result;
  }

  function buildSdkOptions(network) {
    return {
      image,
      cpus: limits.cpus,
      memoryMib: limits.memoryMib,
      diskSizeGb: limits.diskSizeGb,
      network:
        network.mode === 'disabled'
          ? { outbound: { mode: 'disabled' }, inbound: { mode: 'disabled' } }
          : {
              outbound: { mode: 'enabled', allowNet: [...network.allowNet] },
              inbound: { mode: 'disabled' },
            },
      volumes: [],
      ports: [],
      env: [],
      secrets: [],
      autoStop: 0,
      autoDelete: 0,
      autoResume: false,
    };
  }

  function operationIdFor(kind, allocationId, launchGeneration, configHash) {
    return `${kind}-${hashOf({ kind, allocationId, launchGeneration, configHash }).slice(0, 32)}`;
  }

  async function prepareBoundary(record) {
    if (!networkBoundary) {
      fail('engine_network_boundary_unavailable', 'A verified host network boundary is not available.', {
        allocationId: record.allocationId,
        nativeId: record.nativeId,
        networkMode: 'boundary',
      });
    }
    const launch = {
      allocationId: record.allocationId,
      launchGeneration: record.launchGeneration,
      name: record.name,
      image,
      limits: { ...limits },
      configHash: record.configHash,
    };
    let prepared;
    try {
      prepared = await networkBoundary.prepare(launch);
    } catch {
      fail('engine_network_boundary_prepare_failed', 'Network boundary preparation failed.', {
        allocationId: record.allocationId,
        launchGeneration: record.launchGeneration,
        uncertain: true,
      });
    }
    const network = validateBoundaryNetwork(prepared && prepared.network);
    return Object.freeze({
      mode: 'boundary',
      allowNet: Object.freeze([...network.outbound.allowNet]),
      grantHash: hashOf({
        allocationId: record.allocationId,
        launchGeneration: record.launchGeneration,
        name: record.name,
        network,
      }),
    });
  }

  async function cleanupNative(activeRuntime, record) {
    if (!record.nativeId) {
      return false;
    }
    await boundedPromise(
      Promise.resolve().then(() => activeRuntime.remove(record.nativeId, true)),
      execLimits.terminationGraceMs
    );
    const outcome = await boundedPromise(
      Promise.resolve().then(() => activeRuntime.getInfo(record.nativeId)),
      execLimits.terminationGraceMs
    );
    return outcome.status === 'ok' && outcome.value === null;
  }

  async function cleanupLateExecution(execution, graceMs) {
    if (!execution || typeof execution !== 'object' || typeof execution.kill !== 'function') {
      return;
    }
    try {
      const killed = await boundedPromise(
        Promise.resolve().then(() => execution.kill()),
        graceMs
      );
      if (killed.status === 'ok' && typeof execution.wait === 'function') {
        await boundedPromise(Promise.resolve().then(() => execution.wait()), graceMs);
      }
    } catch {
      // Late cleanup is best effort; the dispatch is already reported uncertain.
    }
  }

  async function collectExecution(execution, { deadlineAt, maxOutputBytes, signal, terminationGraceMs }) {
    let stdout = '';
    let stderr = '';
    let totalBytes = 0;
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let killed = false;
    let waitSettled = false;
    let stopped = false;
    let streamError = null;
    let killPromise = null;
    let killTimedOut = false;
    let abortListener = null;
    let timeoutTimer = null;
    let readDeadlineTimer = null;
    let stopReadResolve;

    const stopRead = new Promise((resolve) => {
      stopReadResolve = resolve;
    });

    const waitPromise = Promise.resolve()
      .then(() => execution.wait())
      .then(
        (value) => {
          waitSettled = true;
          return { type: 'result', value };
        },
        (error) => {
          waitSettled = true;
          return { type: 'error', error };
        }
      );

    function requestKill() {
      if (!killPromise) {
        killPromise = boundedPromise(
          Promise.resolve().then(() => execution.kill()),
          terminationGraceMs
        ).then((outcome) => {
          if (outcome.status !== 'ok') {
            killTimedOut = true;
          }
        });
      }
      return killPromise;
    }

    function markKilled() {
      killed = true;
      stopped = true;
      stopReadResolve();
      void requestKill();
    }

    function cleanup() {
      stopped = true;
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      if (readDeadlineTimer) {
        clearTimeout(readDeadlineTimer);
      }
      if (abortListener && signal) {
        signal.removeEventListener('abort', abortListener);
      }
    }

    async function observationFailure(message, stream) {
      markKilled();
      await boundedPromise(waitPromise, terminationGraceMs);
      throw new BoxliteEngineError('engine_exec_observation_failed', message, {
        uncertain: true,
        stream,
        killed: true,
        killTimedOut,
      });
    }

    try {
      if (signal) {
        abortListener = () => {
          if (!waitSettled) {
            cancelled = true;
            markKilled();
          }
        };
        signal.addEventListener('abort', abortListener, { once: true });
        if (signal.aborted && !waitSettled) {
          cancelled = true;
          markKilled();
        }
      }

      timeoutTimer = setTimeout(() => {
        if (!waitSettled) {
          timedOut = true;
          markKilled();
        }
      }, Math.max(0, deadlineAt - Date.now()));

      const stdoutOutcome = await boundedPromise(
        Promise.resolve().then(() => execution.stdout()),
        Math.max(0, deadlineAt - Date.now())
      );
      if (stdoutOutcome.status !== 'ok') {
        await observationFailure('Execution output could not be observed.', 'stdout');
      }
      const stdoutReader = stdoutOutcome.value;
      if (!stdoutReader || typeof stdoutReader.next !== 'function') {
        await observationFailure('Execution output stream is invalid.', 'stdout');
      }

      const stderrOutcome = await boundedPromise(
        Promise.resolve().then(() => execution.stderr()),
        Math.max(0, deadlineAt - Date.now())
      );
      if (stderrOutcome.status !== 'ok') {
        await observationFailure('Execution error output could not be observed.', 'stderr');
      }
      const stderrReader = stderrOutcome.value;
      if (!stderrReader || typeof stderrReader.next !== 'function') {
        await observationFailure('Execution error stream is invalid.', 'stderr');
      }

      async function read(reader, append) {
        while (!stopped) {
          let chunk;
          try {
            chunk = await reader.next();
          } catch {
            if (!killed && !stopped) {
              streamError = new BoxliteEngineError(
                'engine_exec_stream_failed',
                'Execution stream failed.'
              );
            }
            return;
          }
          if (stopped) {
            return;
          }
          if (chunk === null) {
            return;
          }
          if (typeof chunk !== 'string') {
            streamError = new BoxliteEngineError(
              'engine_exec_stream_failed',
              'Execution stream returned a non-string chunk.'
            );
            return;
          }
          const buffer = Buffer.from(chunk, 'utf8');
          if (totalBytes + buffer.length > maxOutputBytes) {
            const remaining = maxOutputBytes - totalBytes;
            if (remaining > 0) {
              append(buffer.subarray(0, remaining).toString('utf8'));
            }
            totalBytes = maxOutputBytes;
            truncated = true;
            if (!waitSettled) {
              markKilled();
            }
            return;
          }
          totalBytes += buffer.length;
          append(chunk);
        }
      }

      const readDeadline = new Promise((resolve) => {
        readDeadlineTimer = setTimeout(() => {
          if (!waitSettled) {
            timedOut = true;
            markKilled();
          }
          resolve();
        }, Math.max(0, deadlineAt + terminationGraceMs - Date.now()));
      });

      await Promise.race([
        Promise.all([
          read(stdoutReader, (chunk) => {
            stdout += chunk;
          }),
          read(stderrReader, (chunk) => {
            stderr += chunk;
          }),
        ]),
        readDeadline,
        stopRead,
      ]);

      if (streamError) {
        await observationFailure('Execution stream failed.', 'output');
      }

      const waitBudget = killed
        ? terminationGraceMs
        : Math.max(0, deadlineAt + terminationGraceMs - Date.now());
      const waitOutcome = await boundedPromise(waitPromise, waitBudget);
      if (waitOutcome.status === 'timeout') {
        markKilled();
        throw new BoxliteEngineError(
          'engine_termination_unverified',
          'Execution did not terminate within the allowed time.',
          { uncertain: true, timedOut, cancelled, killed, killTimedOut }
        );
      }

      const outcome = waitOutcome.value;
      if (outcome.type === 'error') {
        if (!killed) {
          markKilled();
        }
        throw new BoxliteEngineError(
          'engine_termination_unverified',
          'Execution termination could not be observed.',
          { uncertain: true, reason: 'wait_failed', timedOut, cancelled, killed, killTimedOut }
        );
      }

      const value = outcome.value;
      if (!value || typeof value !== 'object' || !Number.isInteger(value.exitCode)) {
        throw new BoxliteEngineError('engine_exec_invalid_result', 'Execution returned an invalid result.', {
          uncertain: true,
        });
      }
      const exitCode = value.exitCode;
      let errorMessage;
      if (value.errorMessage !== undefined) {
        if (typeof value.errorMessage !== 'string') {
          throw new BoxliteEngineError(
            'engine_exec_invalid_result',
            'Execution returned an invalid error message.',
            { uncertain: true }
          );
        }
        errorMessage =
          value.errorMessage.length > MAX_ERROR_MESSAGE_LENGTH
            ? value.errorMessage.slice(0, MAX_ERROR_MESSAGE_LENGTH)
            : value.errorMessage;
      }

      let executionId;
      const idBudget = Math.min(
        ID_READ_TIMEOUT_MS,
        Math.max(0, deadlineAt - Date.now())
      );
      if (idBudget > 0) {
        const idOutcome = await boundedPromise(
          Promise.resolve().then(() => execution.id()),
          idBudget
        );
        if (
          idOutcome.status === 'ok' &&
          typeof idOutcome.value === 'string' &&
          idOutcome.value.length > 0 &&
          idOutcome.value.length <= MAX_NATIVE_ID_LENGTH
        ) {
          executionId = idOutcome.value;
        }
      }

      return Object.freeze({
        exitCode,
        stdout,
        stderr,
        truncated,
        timedOut,
        cancelled,
        ...(errorMessage === undefined ? {} : { errorMessage }),
        ...(executionId === undefined ? {} : { executionId }),
      });
    } finally {
      cleanup();
    }
  }

  const adapter = {
    id: ENGINE_ID,

    async probe() {
      requireOpen();
      if (probeResult) {
        return probeResult;
      }
      try {
        ensurePrivateDirectory(homeDir, 'unsafe_home', 'Runtime home');
        if (stagingDir !== undefined) {
          ensurePrivateDirectory(stagingDir, 'unsafe_staging', 'Staging directory');
        }
        if (runtime) {
          assertRuntimeShape(runtime);
        } else {
          const loaded = await loadSdk();
          if (!loaded || typeof loaded.JsBoxlite !== 'function') {
            return Object.freeze({
              available: false,
              version: null,
              capabilities: Object.freeze([]),
              reason: 'sdk_invalid',
            });
          }
        }
        const version = sdkVersion();
        if (expectedSdkVersion !== null && version !== expectedSdkVersion) {
          return Object.freeze({
            available: false,
            version,
            capabilities: Object.freeze([]),
            reason: 'version_mismatch',
          });
        }
        // Importing the native addon can succeed on a Linux host without KVM.
        // Open the private runtime and exercise its inventory before selecting it.
        try {
          const activeRuntime = await getRuntime();
          await activeRuntime.listInfo();
        } catch {
          return Object.freeze({
            available: false,
            version,
            capabilities: Object.freeze([]),
            reason: 'runtime_unavailable',
          });
        }
        const capabilities = [...BASE_CAPABILITIES];
        if (stagingDir !== undefined) {
          // Export remains available; archive import is withheld because the
          // stock SDK cannot prove safe effective settings for an imported box.
          capabilities.push('export');
        }
        if (networkBoundary) {
          capabilities.push('network-boundary');
        }
        probeResult = Object.freeze({
          available: true,
          version,
          capabilities: Object.freeze(capabilities),
        });
        return probeResult;
      } catch (error) {
        return Object.freeze({
          available: false,
          version: null,
          capabilities: Object.freeze([]),
          reason: error instanceof BoxliteEngineError ? error.code : 'probe_failed',
        });
      }
    },

    async createBox(spec = {}) {
      requireOpen();
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        fail('invalid_input', 'createBox requires an object.');
      }
      const allocationId = normalizeAllocationId(
        spec.allocationId === undefined ? crypto.randomUUID() : spec.allocationId
      );
      const launchGeneration = normalizeLaunchGeneration(
        spec.launchGeneration === undefined ? 1 : spec.launchGeneration
      );
      const name = allocationName(allocationId, launchGeneration);
      const profile = normalizeProfile(spec.profile);
      const probe = await ensureProbe();

      if (profile.network.mode === 'boundary') {
        if (!networkBoundary || !probe.capabilities.includes('network-boundary')) {
          fail('network_unavailable', 'A verified host network boundary is not available.');
        }
      }

      const config = buildConfig(profile);
      const configHash = hashOf(config);
      const operationId = operationIdFor(
        'create',
        allocationId,
        launchGeneration,
        configHash
      );
      const fingerprint = hashOf({
        kind: 'create',
        allocationId,
        launchGeneration,
        configHash,
      });

      loadState();
      const existing = records.get(allocationId);
      if (existing && existing.launchGeneration !== launchGeneration) {
        fail('engine_generation_mismatch', 'Launch generation does not match the current launch.', {
          allocationId,
          expectedGeneration: existing.launchGeneration,
          receivedGeneration: launchGeneration,
        });
      }
      if (existing) {
        if (existing.status === 'legacy' || !existing.config || !existing.configHash) {
          fail('engine_config_unverified', 'The allocation configuration cannot be verified.', {
            allocationId,
            nativeId: existing.nativeId,
            status: existing.status,
          });
        }
        if (existing.configHash !== configHash) {
          fail('engine_config_mismatch', 'Allocation configuration differs from the recorded launch.', {
            allocationId,
            launchGeneration,
            expectedConfigHash: existing.configHash,
            receivedConfigHash: configHash,
          });
        }
        if (existing.status === 'cleanup-pending') {
          fail('engine_allocation_cleanup_pending', 'Allocation cleanup is still pending.', {
            allocationId,
            nativeId: existing.nativeId,
            status: existing.status,
            retryable: false,
          });
        }
      }

      const activeRuntime = await getRuntime();

      if (!existing) {
        const collision = await runBounded(() => activeRuntime.getInfo(name), undefined, {
          phase: 'create',
          code: 'engine_inspect_failed',
          details: { allocationId, name },
        });
        if (collision !== null) {
          fail('engine_intent_conflict', 'The reserved name is occupied without a durable allocation intent.', {
            allocationId,
            launchGeneration,
            name,
            retryable: false,
          });
        }
        const pending = makeRecord({
          allocationId,
          launchGeneration,
          name,
          nativeId: null,
          createdAt: new Date().toISOString(),
          status: 'pending',
          created: null,
          operationId,
          fingerprint,
          config,
          configHash,
          network: profile.network.mode === 'disabled' ? { mode: 'disabled' } : null,
          lastError: null,
        });
        commitRecord(pending);
      }

      let record = records.get(allocationId);
      let createdNow = false;
      let box = null;
      let info = null;

      if (record.status === 'pending' && !record.nativeId) {
        const found = await runBounded(() => activeRuntime.getInfo(name), undefined, {
          phase: 'create',
          code: 'engine_inspect_failed',
          details: { allocationId, name },
        });
        if (found !== null) {
          if (!record.network) {
            fail('engine_config_unverified', 'The allocation grant cannot be verified.', {
              allocationId,
              name,
              uncertain: true,
            });
          }
          if (found.name !== name || typeof found.id !== 'string' || found.id.length === 0) {
            fail('engine_identity_conflict', 'The reserved name maps to an unexpected native object.', {
              allocationId,
              name,
            });
          }
          const handle = await runBounded(() => activeRuntime.get(found.id), undefined, {
            phase: 'create',
            code: 'engine_inspect_failed',
            details: { allocationId, name },
          });
          if (handle === null) {
            fail('engine_box_missing', 'The recorded native allocation is unavailable.', {
              allocationId,
              name,
            });
          }
          assertBoxShape(handle, name, found.id);
          const adopted = makeRecord({
            ...record,
            nativeId: found.id,
            status: 'allocated',
            created: true,
          });
          commitRecord(adopted);
          record = records.get(allocationId);
          box = handle;
          info = found;
        }
      }

      if (!box && record.nativeId) {
        const found = await runBounded(() => activeRuntime.getInfo(record.nativeId), undefined, {
          phase: 'create',
          code: 'engine_inspect_failed',
          details: { allocationId, nativeId: record.nativeId },
        });
        if (found === null) {
          const nameInfo = await runBounded(() => activeRuntime.getInfo(name), undefined, {
            phase: 'create',
            code: 'engine_inspect_failed',
            details: { allocationId, name },
          });
          if (nameInfo !== null) {
            fail('engine_identity_conflict', 'The reserved name is occupied by a different native box.', {
              allocationId,
              nativeId: record.nativeId,
              reason: 'name_occupied',
            });
          }
          fail('engine_box_missing', 'The recorded native box no longer exists; no replacement was created.', {
            allocationId,
            nativeId: record.nativeId,
            retryable: false,
          });
        }
        assertInfoIdentity(found, record);
        const handle = await runBounded(() => activeRuntime.get(record.nativeId), undefined, {
          phase: 'create',
          code: 'engine_inspect_failed',
          details: { allocationId, nativeId: record.nativeId },
        });
        if (handle === null) {
          fail('engine_box_missing', 'The recorded native box handle is unavailable.', {
            allocationId,
            nativeId: record.nativeId,
            retryable: false,
          });
        }
        assertBoxShape(handle, record.name, record.nativeId);
        box = handle;
        info = found;
      }

      if (!box) {
        if (!record.network) {
          const prepared = await prepareBoundary(record);
          const withGrant = makeRecord({ ...record, network: prepared });
          try {
            commitRecord(withGrant);
          } catch (error) {
            fail('engine_state_write_failed', 'Engine state could not be written before allocation.', {
              allocationId,
              launchGeneration,
              phase: 'grant',
            });
          }
          record = records.get(allocationId);
        }

        let result;
        try {
          result = await activeRuntime.getOrCreate(buildSdkOptions(record.network), name);
        } catch {
          const uncertain = makeRecord({
            ...record,
            status: 'pending',
            lastError: 'engine_create_failed',
          });
          tryCommitRecord(uncertain);
          fail('engine_create_failed', 'BoxLite allocation failed.', {
            allocationId,
            launchGeneration,
            name,
            operationId,
            uncertain: true,
            retryable: true,
            state: 'pending',
          });
        }
        assertGetOrCreateResult(result);
        assertBoxShape(result.box, name);
        createdNow = result.created === true;
        const allocated = makeRecord({
          ...record,
          nativeId: result.box.id,
          status: 'allocated',
          created: result.created === true,
          lastError: null,
        });
        try {
          commitRecord(allocated);
        } catch (error) {
          fail('engine_state_write_failed', 'Engine state could not be written after allocation.', {
            allocationId,
            launchGeneration,
            name,
            nativeId: result.box.id,
            uncertain: true,
            retryable: true,
            state: 'pending',
          });
        }
        record = records.get(allocationId);
        box = result.box;
        info = null;
      }

      if (!info) {
        try {
          info = await box.info();
        } catch {
          const unverified = makeRecord({
            ...record,
            status: 'allocated',
            lastError: 'engine_create_unverified',
          });
          tryCommitRecord(unverified);
          fail('engine_create_unverified', 'Allocated box could not be verified.', {
            allocationId,
            launchGeneration,
            name,
            nativeId: record.nativeId,
            uncertain: true,
            retryable: true,
          });
        }
      }
      assertInfoIdentity(info, record);
      assertEffectiveConfig(record, info);

      if (record.config.networkMode === 'boundary') {
        const wasOwned = record.status === 'owned';
        const running = info.state.running === true;
        let verified = false;
        try {
          verified =
            (await networkBoundary.verify({
              allocationId: record.allocationId,
              launchGeneration: record.launchGeneration,
              name: record.name,
              nativeId: record.nativeId,
              network: record.network,
              grantHash: record.network.grantHash,
              configHash: record.configHash,
              running,
              pid: info.state.pid ?? null,
              created: record.created === true,
            })) === true;
        } catch {
          verified = false;
        }
        if (!verified) {
          if (wasOwned) {
            const fenced = await fenceBox(box);
            tryCommitRecord(
              makeRecord({
                ...record,
                lastError: 'engine_network_unverified',
              })
            );
            fail('engine_network_unverified', 'Network boundary verification was refused.', {
              allocationId,
              launchGeneration,
              name,
              nativeId: record.nativeId,
              uncertain: true,
              fenced,
              cleanup: 'fenced',
              retryable: false,
            });
          }
          const pendingCleanup = makeRecord({
            ...record,
            status: 'cleanup-pending',
            lastError: 'engine_network_unverified',
          });
          tryCommitRecord(pendingCleanup);
          record = records.get(record.allocationId) ?? pendingCleanup;
          const gone = await cleanupNative(activeRuntime, record);
          if (gone) {
            try {
              deleteRecord(record.allocationId);
            } catch {
              // The primary verification diagnostic is more useful.
            }
          }
          fail('engine_network_unverified', 'Network boundary verification was refused.', {
            allocationId,
            launchGeneration,
            name,
            nativeId: record.nativeId,
            uncertain: true,
            cleanup: gone ? 'observed_absent' : 'pending',
            retryable: false,
          });
        }
      }

      const owned = makeRecord({
        ...record,
        status: 'owned',
        lastError: null,
      });
      try {
        commitRecord(owned);
      } catch (error) {
        fail('engine_state_write_failed', 'Engine state could not be written after verification.', {
          allocationId,
          launchGeneration,
          name,
          nativeId: owned.nativeId,
          uncertain: true,
          retryable: true,
          state: 'allocated',
        });
      }
      record = records.get(allocationId);
      return Object.freeze({
        allocationId,
        launchGeneration,
        name,
        nativeId: record.nativeId,
        created: createdNow,
        operationId: record.operationId,
        status: record.status,
      });
    },

    async inspect(ref) {
      requireOpen();
      const { record, info } = await resolveBox(ref, { requireConfig: true });
      assertEffectiveConfig(record, info);
      return sanitizeInfo(info, record);
    },

    async start(ref) {
      requireOpen();
      const { record, box, info } = await resolveBox(ref, { requireConfig: true });
      assertEffectiveConfig(record, info);
      let current = info;
      if (current.state.running !== true) {
        await verifyActivation(record, current, null, { ctx: undefined, running: false, created: false });
        await runBounded(() => box.start(), undefined, {
          phase: 'start',
          code: 'engine_start_failed',
          details: { allocationId: record.allocationId, nativeId: record.nativeId },
        });
        current = await runBounded(() => box.info(), undefined, {
          phase: 'start',
          code: 'engine_inspect_failed',
          details: { allocationId: record.allocationId, nativeId: record.nativeId },
        });
        assertInfoIdentity(current, record);
        assertEffectiveConfig(record, current);
        if (current.state.running !== true) {
          fail('engine_start_unverified', 'BoxLite box is not running after start.', {
            allocationId: record.allocationId,
            nativeId: record.nativeId,
          });
        }
      }
      await verifyActivation(record, current, box, { running: true, created: false });
      return sanitizeInfo(current, record);
    },

    async stop(ref) {
      requireOpen();
      const { record, box } = await resolveBox(ref);
      await runBounded(() => box.stop(), undefined, {
        phase: 'stop',
        code: 'engine_stop_failed',
        details: { allocationId: record.allocationId, nativeId: record.nativeId },
      });
      const info = await runBounded(() => box.info(), undefined, {
        phase: 'stop',
        code: 'engine_inspect_failed',
        details: { allocationId: record.allocationId, nativeId: record.nativeId },
      });
      assertInfoIdentity(info, record);
      if (info.state && info.state.running === true) {
        fail('engine_stop_unverified', 'BoxLite box is still running after stop.', {
          allocationId: record.allocationId,
          nativeId: record.nativeId,
        });
      }
      return sanitizeInfo(info, record);
    },

    async destroy(ref) {
      requireOpen();
      const { normalized, record } = recordForRef(ref);
      const activeRuntime = await runBounded(() => getRuntime(), undefined, {
        phase: 'destroy',
        code: 'engine_unavailable',
        details: {},
      });
      const info = await runBounded(() => activeRuntime.getInfo(record.nativeId), undefined, {
        phase: 'destroy',
        code: 'engine_inspect_failed',
        details: { allocationId: record.allocationId, nativeId: record.nativeId },
      });
      if (info === null) {
        deleteRecord(normalized.allocationId);
        return Object.freeze({
          destroyed: true,
          alreadyGone: true,
          allocationId: record.allocationId,
          launchGeneration: record.launchGeneration,
          name: record.name,
          nativeId: record.nativeId,
        });
      }
      assertInfoIdentity(info, record);
      if (info.state && info.state.running === true) {
        const box = await runBounded(() => activeRuntime.get(record.nativeId), undefined, {
          phase: 'destroy',
          code: 'engine_inspect_failed',
          details: { allocationId: record.allocationId, nativeId: record.nativeId },
        });
        if (box !== null) {
          assertBoxShape(box, record.name, record.nativeId);
          await runBounded(() => box.stop(), undefined, {
            phase: 'destroy',
            code: 'engine_stop_failed',
            details: { allocationId: record.allocationId, nativeId: record.nativeId },
          });
        }
      }
      try {
        await runBounded(() => activeRuntime.remove(record.nativeId, true), undefined, {
          phase: 'destroy',
          code: 'engine_destroy_failed',
          details: { allocationId: record.allocationId, nativeId: record.nativeId },
        });
      } catch (error) {
        tryCommitRecord(
          makeRecord({
            ...record,
            status: 'cleanup-pending',
            lastError: error.code,
          })
        );
        throw error;
      }
      let remaining;
      try {
        remaining = await runBounded(
          () => activeRuntime.getInfo(record.nativeId),
          undefined,
          {
            phase: 'destroy',
            code: 'engine_inspect_failed',
            details: { allocationId: record.allocationId, nativeId: record.nativeId },
          }
        );
      } catch {
        tryCommitRecord(
          makeRecord({
            ...record,
            status: 'cleanup-pending',
            lastError: 'engine_destroy_unverified',
          })
        );
        fail('engine_destroy_unverified', 'Removal could not be observed.', {
          allocationId: record.allocationId,
          nativeId: record.nativeId,
          uncertain: true,
        });
      }
      if (remaining !== null) {
        tryCommitRecord(
          makeRecord({
            ...record,
            status: 'cleanup-pending',
            lastError: 'engine_destroy_unverified',
          })
        );
        fail('engine_destroy_unverified', 'BoxLite box still exists after removal.', {
          allocationId: record.allocationId,
          nativeId: record.nativeId,
          uncertain: true,
        });
      }
      deleteRecord(normalized.allocationId);
      return Object.freeze({
        destroyed: true,
        alreadyGone: false,
        allocationId: record.allocationId,
        launchGeneration: record.launchGeneration,
        name: record.name,
        nativeId: record.nativeId,
      });
    },

    async listOwned() {
      requireOpen();
      loadState();
      const activeRuntime = await runBounded(() => getRuntime(), undefined, {
        phase: 'list',
        code: 'engine_unavailable',
        details: {},
      });
      const infos = await runBounded(() => activeRuntime.listInfo(), undefined, {
        phase: 'list',
        code: 'engine_list_failed',
        details: {},
      });
      if (!Array.isArray(infos)) {
        fail('engine_runtime_invalid', 'BoxLite listInfo returned an invalid result.');
      }
      const byId = new Map();
      for (const info of infos) {
        if (info && typeof info.id === 'string') {
          byId.set(info.id, info);
        }
      }
      const owned = [];
      for (const record of records.values()) {
        if (!record.nativeId) {
          continue;
        }
        const info = byId.get(record.nativeId);
        if (!info || info.name !== record.name || info.id !== record.nativeId) {
          continue;
        }
        owned.push(sanitizeInfo(info, record));
      }
      owned.sort((left, right) => left.name.localeCompare(right.name));
      return Object.freeze(owned);
    },

    async exec(ref, spec = {}) {
      requireOpen();
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        fail('invalid_input', 'exec requires an object.');
      }
      const argv = normalizeArgv(spec.argv);
      const timeoutMs = normalizeExecTimeout(spec.timeoutMs, execLimits.timeoutMs);
      const maxOutputBytes = normalizeMaxOutputBytes(
        spec.maxOutputBytes,
        execLimits.maxOutputBytes
      );
      if (spec.tty !== undefined && typeof spec.tty !== 'boolean') {
        fail('invalid_input', 'tty must be a boolean.');
      }
      if (spec.env !== undefined) {
        fail('invalid_input', 'Caller-supplied environment is not supported.');
      }
      if (spec.user !== undefined) {
        fail('invalid_input', 'Caller-supplied guest users are not supported.');
      }
      const tty = spec.tty === true;
      const workingDir = normalizeWorkingDir(spec.workingDir);
      const signal = spec.signal;
      if (
        signal !== undefined &&
        (!signal || typeof signal !== 'object' || typeof signal.addEventListener !== 'function')
      ) {
        fail('invalid_input', 'signal must be an AbortSignal.');
      }
      if (signal && signal.aborted) {
        fail('engine_cancelled', 'Execution was cancelled before it started.');
      }

      const deadlineAt = Date.now() + timeoutMs;
      const ctx = { deadlineAt };

      function ensureActive() {
        if (signal && signal.aborted) {
          fail('engine_cancelled', 'Execution was cancelled before it started.');
        }
        if (Date.now() >= deadlineAt) {
          throw deadlineError('preflight', false);
        }
      }

      ensureActive();
      const probe = await runBounded(() => ensureProbe(), ctx, {
        phase: 'preflight',
        code: 'engine_unavailable',
        details: {},
      });
      if (tty && !probe.capabilities.includes('pty')) {
        fail('unsupported_capability', 'BoxLite tty command execution is not available.');
      }

      ensureActive();
      const resolved = await resolveBox(ref, { ctx, requireConfig: true });
      ensureActive();
      let current = resolved.info;
      assertEffectiveConfig(resolved.record, current);

      if (current.state.running !== true) {
        await verifyActivation(resolved.record, current, null, { ctx: ctx, running: false, created: false });
        ensureActive();
        await runBounded(() => resolved.box.start(), ctx, {
          phase: 'activation',
          code: 'engine_start_failed',
          details: {
            allocationId: resolved.record.allocationId,
            nativeId: resolved.record.nativeId,
          },
          uncertain: true,
        });
        current = await runBounded(() => resolved.box.info(), ctx, {
          phase: 'activation',
          code: 'engine_inspect_failed',
          details: {
            allocationId: resolved.record.allocationId,
            nativeId: resolved.record.nativeId,
          },
          uncertain: true,
        });
        assertInfoIdentity(current, resolved.record);
        assertEffectiveConfig(resolved.record, current);
        if (current.state.running !== true) {
          fail('engine_start_unverified', 'BoxLite box is not running after implicit start.', {
            allocationId: resolved.record.allocationId,
            nativeId: resolved.record.nativeId,
          });
        }
      }

      await verifyActivation(resolved.record, current, resolved.box, {
        ctx,
        running: true,
        created: false,
      });
      ensureActive();

      let abandoned = false;
      const dispatchPromise = Promise.resolve().then(() =>
        resolved.box.exec(
          argv[0],
          argv.slice(1),
          null,
          tty,
          String(guestUid),
          Math.ceil(timeoutMs / 1000),
          workingDir
        )
      );
      const dispatchOutcome = await boundedPromise(
        dispatchPromise,
        Math.max(0, deadlineAt - Date.now())
      );
      if (dispatchOutcome.status === 'timeout') {
        abandoned = true;
        dispatchPromise.then(
          (handle) => {
            if (abandoned) {
              void cleanupLateExecution(handle, execLimits.terminationGraceMs);
            }
          },
          () => {}
        );
        throw deadlineError('dispatch', true);
      }
      if (dispatchOutcome.status === 'error') {
        fail('engine_exec_dispatch_failed', 'BoxLite execution dispatch failed.', {
          allocationId: resolved.record.allocationId,
          nativeId: resolved.record.nativeId,
          uncertain: true,
          dispatched: true,
        });
      }
      const execution = dispatchOutcome.value;
      try {
        assertExecutionShape(execution);
      } catch (error) {
        await cleanupLateExecution(execution, execLimits.terminationGraceMs);
        throw error;
      }
      return collectExecution(execution, {
        deadlineAt,
        maxOutputBytes,
        signal,
        terminationGraceMs: execLimits.terminationGraceMs,
      });
    },

    async importBox(spec = {}) {
      requireOpen();
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        fail('invalid_input', 'importBox requires an object.');
      }
      // The stock SDK import signature accepts only an archive and a name and
      // exposes no sanitized create options. Effective network, lifecycle and
      // resource settings therefore cannot be proved, so archive import is
      // deliberately withheld. Workspace byte transfer is a separate service.
      fail(
        'engine_import_unsupported',
        'Archive import is unavailable because safe effective settings cannot be proved.',
        { retryable: false }
      );
    },

    async exportBox(ref, spec = {}) {
      requireOpen();
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        fail('invalid_input', 'exportBox requires an object.');
      }
      if (stagingDir === undefined) {
        fail('staging_unavailable', 'No trusted staging directory is configured.');
      }
      ensurePrivateDirectory(stagingDir, 'unsafe_staging', 'Staging directory');
      const destinationPath = assertStagingChild(stagingDir, spec.destinationPath, {
        mustExist: false,
        label: 'Export destination',
      });
      const { record, box } = await resolveBox(ref);
      await runBounded(() => box.export(destinationPath), undefined, {
        phase: 'export',
        code: 'engine_export_failed',
        details: { allocationId: record.allocationId, nativeId: record.nativeId },
      });
      const stat = lstatOrNull(destinationPath);
      if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
        fail('engine_export_unverified', 'BoxLite export did not produce a regular file.');
      }
      return Object.freeze({ path: destinationPath, bytes: stat.size });
    },

    async close() {
      if (closed) {
        return Object.freeze({ closed: true, cleanup: 'ok' });
      }
      closed = true;
      releaseHome();
      const activeRuntime = runtime;
      runtime = null;
      let cleanup = 'ok';
      if (activeRuntime && typeof activeRuntime.close === 'function') {
        try {
          activeRuntime.close();
        } catch {
          cleanup = 'failed';
        }
      }
      return Object.freeze({ closed: true, cleanup });
    },
  };

  return Object.freeze(adapter);
}

module.exports = {
  BOXLITE_VERSION,
  BOXLITE_CAPABILITIES: BASE_CAPABILITIES,
  BoxliteEngineError,
  createBoxliteAdapter,
};
