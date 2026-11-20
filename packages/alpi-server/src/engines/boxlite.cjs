'use strict';

/**
 * BoxLite engine adapter for Alpi.
 *
 * This module is deliberately not a runtime host. The host must supply a
 * verified SDK module path and a private, dedicated runtime home. BoxLite is
 * dynamically imported from that path and every box is created through
 * `getOrCreate` with a reserved Alpi name. The default profile is fully
 * disconnected: no inbound network, no outbound network, no host mounts, no
 * ports, no secrets and no caller-supplied environment.
 *
 * Networked profiles are unavailable unless the host supplies an explicit
 * launch-scoped boundary provider with `prepare` and `verify`; that contract is
 * expected to be implemented by the later Iron integration. This adapter does
 * not implement an unrestricted network mode.
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
  'pty',
]);
const STATE_VERSION = 1;
const STATE_FILE = 'alpi-engine-state.json';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
  for (const argument of argv) {
    if (typeof argument !== 'string' || argument.length === 0) {
      fail('invalid_input', 'Every argv entry must be a non-empty string.');
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

function assertBoxShape(box, expectedName) {
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
 *   networkBoundary?: { prepare: Function, verify: Function }
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

  async function loadSdk() {
    if (sdk) {
      return sdk;
    }
    if (!sdkModulePath) {
      fail('invalid_engine_config', 'No SDK module path is configured.');
    }
    assertTrustedModulePath(sdkModulePath);
    const url = pathToFileURL(sdkModulePath).href;
    const loaded = await import(url);
    sdk = loaded;
    return loaded;
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
    runtime = new loaded.JsBoxlite({ homeDir });
    assertRuntimeShape(runtime);
    return runtime;
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
    if (!parsed || parsed.version !== STATE_VERSION || !Array.isArray(parsed.allocations)) {
      fail('engine_state_corrupt', 'Engine state has an unsupported shape.');
    }
    const next = new Map();
    for (const entry of parsed.allocations) {
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
      if (next.has(allocationId)) {
        fail('engine_state_corrupt', 'Engine state contains a duplicate allocation.');
      }
      next.set(
        allocationId,
        Object.freeze({
          allocationId,
          launchGeneration,
          name,
          nativeId: entry.nativeId,
          createdAt: entry.createdAt,
        })
      );
    }
    records = next;
    stateLoaded = true;
  }

  function saveState() {
    ensurePrivateDirectory(homeDir, 'unsafe_home', 'Runtime home');
    const allocations = [...records.values()]
      .map((record) => ({
        allocationId: record.allocationId,
        launchGeneration: record.launchGeneration,
        name: record.name,
        nativeId: record.nativeId,
        createdAt: record.createdAt,
      }))
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

  function recordForRef(ref) {
    const normalized = normalizeRef(ref);
    loadState();
    const record = records.get(normalized.allocationId);
    if (!record) {
      fail('engine_unknown_allocation', 'Allocation is not owned by this adapter.', normalized);
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
        receivedNativeId: normalized.nativeId,
      });
    }
    return { normalized, record };
  }

  function assertInfoIdentity(info, record) {
    if (!info || typeof info !== 'object' || Array.isArray(info)) {
      fail('engine_invalid_result', 'BoxLite returned invalid box information.');
    }
    if (info.id !== record.nativeId || info.name !== record.name) {
      fail('engine_identity_mismatch', 'BoxLite information does not match the owned box.', {
        allocationId: record.allocationId,
        expectedNativeId: record.nativeId,
        receivedNativeId: info.id,
      });
    }
  }

  async function resolveBox(ref) {
    const { normalized, record } = recordForRef(ref);
    const activeRuntime = await getRuntime();
    const info = await activeRuntime.getInfo(record.nativeId);
    if (info === null) {
      fail('engine_box_missing', 'The owned box no longer exists.', {
        allocationId: record.allocationId,
        nativeId: record.nativeId,
      });
    }
    assertInfoIdentity(info, record);
    const box = await activeRuntime.get(record.nativeId);
    if (box === null) {
      fail('engine_box_missing', 'The owned box handle is unavailable.', {
        allocationId: record.allocationId,
        nativeId: record.nativeId,
      });
    }
    assertBoxShape(box, record.name);
    return { normalized, record, box, runtime: activeRuntime };
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

  function buildSdkOptions(profile, preparedNetwork) {
    return {
      image,
      cpus: limits.cpus,
      memoryMib: limits.memoryMib,
      diskSizeGb: limits.diskSizeGb,
      network:
        preparedNetwork === undefined
          ? { outbound: { mode: 'disabled' }, inbound: { mode: 'disabled' } }
          : preparedNetwork,
      volumes: [],
      ports: [],
      env: [],
      secrets: [],
      autoStop: 0,
      autoDelete: 0,
      autoResume: false,
    };
  }

  async function collectExecution(execution, { timeoutMs, maxOutputBytes, signal, terminationGraceMs }) {
    const startedAt = Date.now();
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

    function requestKill() {
      if (!killPromise) {
        killPromise = Promise.resolve()
          .then(() => execution.kill())
          .catch(() => {});
      }
      return killPromise;
    }

    const timeoutTimer = setTimeout(() => {
      if (!waitSettled) {
        timedOut = true;
        killed = true;
        void requestKill();
      }
    }, timeoutMs);

    let abortListener = null;
    if (signal) {
      abortListener = () => {
        if (!waitSettled) {
          cancelled = true;
          killed = true;
          void requestKill();
        }
      };
      signal.addEventListener('abort', abortListener, { once: true });
      if (signal.aborted && !waitSettled) {
        cancelled = true;
        killed = true;
        void requestKill();
      }
    }

    let stdoutReader = null;
    let stderrReader = null;
    try {
      stdoutReader = await execution.stdout();
    } catch {
      stdoutReader = null;
    }
    try {
      stderrReader = await execution.stderr();
    } catch {
      stderrReader = null;
    }

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

    async function read(reader, append) {
      if (!reader || typeof reader.next !== 'function') {
        return;
      }
      while (!stopped) {
        let chunk;
        try {
          chunk = await reader.next();
        } catch (error) {
          if (!killed && !stopped) {
            streamError = error;
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
            killed = true;
            void requestKill();
          }
          return;
        }
        totalBytes += buffer.length;
        append(chunk);
      }
    }

    let readDeadlineTimer = null;
    const readDeadline = new Promise((resolve) => {
      readDeadlineTimer = setTimeout(() => {
        if (!waitSettled) {
          killed = true;
          void requestKill();
        }
        resolve();
      }, timeoutMs + terminationGraceMs);
    });

    try {
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
      ]);
    } finally {
      stopped = true;
      clearTimeout(readDeadlineTimer);
    }

    if (streamError) {
      if (!killed) {
        killed = true;
        await requestKill();
      }
      clearTimeout(timeoutTimer);
      if (abortListener && signal) {
        signal.removeEventListener('abort', abortListener);
      }
      await Promise.race([
        waitPromise,
        new Promise((resolve) => setTimeout(resolve, terminationGraceMs)),
      ]);
      throw streamError instanceof BoxliteEngineError
        ? streamError
        : new BoxliteEngineError('engine_exec_stream_failed', 'Execution stream failed.');
    }

    const elapsed = Date.now() - startedAt;
    const waitBudgetMs = killed
      ? terminationGraceMs
      : Math.max(0, timeoutMs + terminationGraceMs - elapsed);
    let waitTimer = null;
    const waitDeadline = new Promise((resolve) => {
      waitTimer = setTimeout(() => resolve({ type: 'deadline' }), waitBudgetMs);
    });
    let outcome;
    try {
      outcome = await Promise.race([waitPromise, waitDeadline]);
    } finally {
      clearTimeout(waitTimer);
      clearTimeout(timeoutTimer);
      if (abortListener && signal) {
        signal.removeEventListener('abort', abortListener);
      }
    }

    if (outcome.type === 'deadline') {
      throw new BoxliteEngineError(
        'engine_termination_unverified',
        'Execution did not terminate within the allowed time.'
      );
    }

    let exitCode = -1;
    let errorMessage;
    if (outcome.type === 'result') {
      const value = outcome.value;
      if (!value || typeof value !== 'object' || !Number.isInteger(value.exitCode)) {
        throw new BoxliteEngineError(
          'engine_exec_invalid_result',
          'Execution returned an invalid result.'
        );
      }
      exitCode = value.exitCode;
      if (value.errorMessage !== undefined) {
        if (typeof value.errorMessage !== 'string') {
          throw new BoxliteEngineError(
            'engine_exec_invalid_result',
            'Execution returned an invalid error message.'
          );
        }
        errorMessage = value.errorMessage;
      }
    } else if (!killed) {
      throw new BoxliteEngineError('engine_exec_failed', 'Execution failed.');
    } else {
      errorMessage = 'Execution terminated after cancellation.';
    }

    let executionId;
    try {
      const id = await execution.id();
      if (typeof id === 'string' && id.length > 0) {
        executionId = id;
      }
    } catch {
      // The execution id is informative, not required.
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
          return Object.freeze({ available: false, version,
            capabilities: Object.freeze([]), reason: 'runtime_unavailable' });
        }
        const capabilities = [...BASE_CAPABILITIES];
        if (stagingDir !== undefined) {
          capabilities.push('import', 'export');
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

      loadState();
      const existing = records.get(allocationId);
      if (existing && existing.launchGeneration !== launchGeneration) {
        fail('engine_generation_mismatch', 'Launch generation does not match the current launch.', {
          allocationId,
          expectedGeneration: existing.launchGeneration,
          receivedGeneration: launchGeneration,
        });
      }

      let preparedNetwork;
      if (profile.network.mode === 'boundary') {
        const launch = {
          allocationId,
          launchGeneration,
          name,
          image,
          limits: { ...limits },
        };
        let prepared;
        try {
          prepared = await networkBoundary.prepare(launch);
        } catch {
          fail('network_boundary_prepare_failed', 'Network boundary preparation failed.', {
            allocationId,
            launchGeneration,
          });
        }
        preparedNetwork = validateBoundaryNetwork(prepared && prepared.network);
      }

      const activeRuntime = await getRuntime();
      const sdkOptions = buildSdkOptions(profile, preparedNetwork);
      let result;
      try {
        result = await activeRuntime.getOrCreate(sdkOptions, name);
      } catch (error) {
        throw new BoxliteEngineError('engine_create_failed', 'BoxLite allocation failed.', {
          allocationId,
          launchGeneration,
          name,
          cause: error,
        });
      }
      assertGetOrCreateResult(result);
      assertBoxShape(result.box, name);
      const nativeId = result.box.id;

      if (existing && existing.nativeId !== nativeId) {
        fail('engine_identity_mismatch', 'Allocated box does not match the persisted native id.', {
          allocationId,
          expectedNativeId: existing.nativeId,
          receivedNativeId: nativeId,
        });
      }

      const record = Object.freeze({
        allocationId,
        launchGeneration,
        name,
        nativeId,
        createdAt: existing ? existing.createdAt : new Date().toISOString(),
      });

      const info = await result.box.info();
      assertInfoIdentity(info, record);

      if (profile.network.mode === 'boundary') {
        let verified;
        try {
          verified = await networkBoundary.verify({
            allocationId,
            launchGeneration,
            name,
            nativeId,
            created: result.created === true,
          });
        } catch {
          if (result.created === true) {
            try {
              await activeRuntime.remove(nativeId, true);
            } catch {
              // Keep the failure visible; cleanup is best effort.
            }
          }
          fail('network_boundary_verify_failed', 'Network boundary verification failed.', {
            allocationId,
            launchGeneration,
            nativeId,
          });
        }
        if (verified !== true) {
          if (result.created === true) {
            try {
              await activeRuntime.remove(nativeId, true);
            } catch {
              // Keep the failure visible; cleanup is best effort.
            }
          }
          fail('network_boundary_unverified', 'Network boundary verification was refused.', {
            allocationId,
            launchGeneration,
            nativeId,
          });
        }
      }

      records.set(allocationId, record);
      saveState();
      return Object.freeze({
        allocationId,
        launchGeneration,
        name,
        nativeId,
        created: result.created === true,
      });
    },

    async inspect(ref) {
      requireOpen();
      const { record, box } = await resolveBox(ref);
      const info = await box.info();
      assertInfoIdentity(info, record);
      return sanitizeInfo(info, record);
    },

    async start(ref) {
      requireOpen();
      const { record, box } = await resolveBox(ref);
      await box.start();
      const info = await box.info();
      assertInfoIdentity(info, record);
      return sanitizeInfo(info, record);
    },

    async stop(ref) {
      requireOpen();
      const { record, box } = await resolveBox(ref);
      await box.stop();
      const info = await box.info();
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
      const activeRuntime = await getRuntime();
      const info = await activeRuntime.getInfo(record.nativeId);
      if (info === null) {
        records.delete(normalized.allocationId);
        saveState();
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
      const box = await activeRuntime.get(record.nativeId);
      if (box !== null) {
        assertBoxShape(box, record.name);
        if (info.state && info.state.running === true) {
          await box.stop();
        }
      }
      await activeRuntime.remove(record.nativeId, true);
      const remaining = await activeRuntime.getInfo(record.nativeId);
      if (remaining !== null) {
        fail('engine_destroy_unverified', 'BoxLite box still exists after removal.', {
          allocationId: record.allocationId,
          nativeId: record.nativeId,
        });
      }
      records.delete(normalized.allocationId);
      saveState();
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
      const activeRuntime = await getRuntime();
      const infos = await activeRuntime.listInfo();
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
      const probe = await ensureProbe();
      if (tty && !probe.capabilities.includes('pty')) {
        fail('unsupported_capability', 'BoxLite PTY execution is not available.');
      }
      const { box } = await resolveBox(ref);
      const execution = await box.exec(
        argv[0],
        argv.slice(1),
        null,
        tty,
        String(guestUid),
        Math.ceil(timeoutMs / 1000),
        workingDir
      );
      assertExecutionShape(execution);
      return collectExecution(execution, {
        timeoutMs,
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
      if (stagingDir === undefined) {
        fail('staging_unavailable', 'No trusted staging directory is configured.');
      }
      ensurePrivateDirectory(stagingDir, 'unsafe_staging', 'Staging directory');
      const archivePath = assertStagingChild(stagingDir, spec.archivePath, {
        mustExist: true,
        label: 'Import archive',
      });
      const allocationId = normalizeAllocationId(
        spec.allocationId === undefined ? crypto.randomUUID() : spec.allocationId
      );
      const launchGeneration = normalizeLaunchGeneration(
        spec.launchGeneration === undefined ? 1 : spec.launchGeneration
      );
      const name = allocationName(allocationId, launchGeneration);
      await ensureProbe();
      loadState();
      const existing = records.get(allocationId);
      if (existing) {
        if (existing.launchGeneration !== launchGeneration) {
          fail('engine_generation_mismatch', 'Launch generation does not match the current launch.', {
            allocationId,
            expectedGeneration: existing.launchGeneration,
            receivedGeneration: launchGeneration,
          });
        }
        fail('engine_already_allocated', 'Allocation is already recorded; destroy it before importing.');
      }
      const activeRuntime = await getRuntime();
      let box;
      try {
        box = await activeRuntime.importBox(archivePath, name);
      } catch (error) {
        throw new BoxliteEngineError('engine_import_failed', 'BoxLite import failed.', {
          allocationId,
          launchGeneration,
          name,
          cause: error,
        });
      }
      assertBoxShape(box, name);
      const record = Object.freeze({
        allocationId,
        launchGeneration,
        name,
        nativeId: box.id,
        createdAt: new Date().toISOString(),
      });
      const info = await box.info();
      assertInfoIdentity(info, record);
      records.set(allocationId, record);
      saveState();
      return Object.freeze({
        allocationId,
        launchGeneration,
        name,
        nativeId: record.nativeId,
        imported: true,
      });
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
      const { box } = await resolveBox(ref);
      await box.export(destinationPath);
      const stat = lstatOrNull(destinationPath);
      if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
        fail('engine_export_unverified', 'BoxLite export did not produce a regular file.');
      }
      return Object.freeze({ path: destinationPath, bytes: stat.size });
    },

    async close() {
      if (closed) {
        return;
      }
      closed = true;
      const activeRuntime = runtime;
      runtime = null;
      if (activeRuntime && typeof activeRuntime.close === 'function') {
        try {
          activeRuntime.close();
        } catch {
          // Closing is best effort and must not mask the caller's work.
        }
      }
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
