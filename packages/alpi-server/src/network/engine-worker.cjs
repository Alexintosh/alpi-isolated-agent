'use strict';

/**
 * NETNS-WORKER-1: per-allocation Linux engine worker.
 *
 * This file is the process started by `alpi-worker@<uuid>.service`. It runs as
 * the unprivileged `alpi-server` account inside a systemd `PrivateNetwork=yes`
 * service with `KillMode=control-group`, no ambient capabilities and
 * `NoNewPrivileges=yes`.
 *
 * The worker owns exactly one allocation:
 *
 *  - it reads one host-written, atomically renamed, 0600 configuration file
 *    under the configured state root;
 *  - it proves, before importing or constructing the native SDK, that its own
 *    network namespace contains only the loopback interface and loopback
 *    routes;
 *  - it opens one private filesystem Unix-domain control socket (mode 0600)
 *    inside its own allocation home. It never opens a management TCP socket;
 *  - it exposes a small bounded operation set: create, inspect, start, stop,
 *    destroy, listOwned, status, heartbeat, guest argv exec and the per-launch
 *    Iron bridge open/close/fence. There is no arbitrary SDK escape hatch;
 *  - before any byte is forwarded it verifies the actual boxlite-shim process
 *    with kernel `/proc` evidence and the trusted SDK `getInfo(ref).state.pid`:
 *    executable name, process start time (pid-reuse guard), service cgroup,
 *    network namespace inode and service UID must all match;
 *  - it opens the fixed per-worker 127.0.0.1 tunnel endpoint only when the host
 *    explicitly asks after its own proof, and destroys every active bridge
 *    synchronously on fault, owner disconnect, generation expiry or stop.
 *
 * gvproxy runs inside the verified boxlite-shim process, as confirmed by the
 * pinned BoxLite 0.14.1 `src/shim/src/main.rs` source. The worker never treats
 * guest-originated data as evidence and never accepts host filesystem paths as
 * guest-controlled arguments.
 *
 * The host must pre-pull the pinned image into the same private runtime home
 * (see launch-boundary.cjs) before starting this worker. This worker has no
 * image-pull operation.
 */

const { parseInterfaces, parseIPv4Routes, parseIPv6Routes, assertLoopbackOnly } = require('./loopback-routes.cjs');

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const PROTOCOL_VERSION = 1;
const WORKER_VERSION = 1;
const MAX_FRAME_BYTES = 256 * 1024;
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_TOKEN_BYTES = 128;
const MAX_UDS_PATH_BYTES = 100;
const MAX_NATIVE_ID_LENGTH = 256;
const MAX_ARG_BYTES = 4096;
const MAX_ARGV_BYTES = 65536;
const MAX_ARGV_ENTRIES = 64;
const MAX_EXEC_TIMEOUT_MS = 300_000;
const MAX_EXEC_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_BRIDGE_STREAMS = 32;
const MAX_BRIDGE_IDLE_MS = 10 * 60 * 1000;
const DEFAULT_PROOF_MAX_AGE_MS = 5_000;
const DEFAULT_OWNER_HEARTBEAT_TIMEOUT_MS = 15_000;
const DEFAULT_WATCHDOG_MS = 2_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
const EXEC_CHUNK_BYTES = 32 * 1024;
const TUNNEL_HOST = '127.0.0.1';
const TUNNEL_ALIAS = '192.168.127.254';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IMAGE_PATTERN = /^[^\s@]+@sha256:([a-f0-9]{64})$/;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const NAME_PATTERN =
  /^alpi-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-g([1-9][0-9]*)$/;

const SETUP_MISSING_MESSAGE =
  'Alpi engine worker setup is missing; install the worker service and pinned SDK before creating a sandbox.';

const OPS = new Set([
  'hello',
  'probe',
  'create',
  'inspect',
  'start',
  'stop',
  'destroy',
  'listOwned',
  'status',
  'heartbeat',
  'exec',
  'openBridge',
  'closeBridge',
  'fenceBridge',
]);

// Control operations that must never wait behind a long-running queued
// operation such as adapter.exec. They are authenticated exactly like every
// other post-hello operation, but the connection processes each one as soon as
// its frame is received; a fence is applied on receipt.
const CONTROL_FAST_OPS = new Set(['heartbeat', 'fenceBridge', 'closeBridge']);

class EngineWorkerError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'EngineWorkerError';
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

function fail(code, message, details) {
  throw new EngineWorkerError(code, message, details);
}

/**
 * Bound one evidence read (trusted SDK getInfo or /proc reads) by a deadline.
 * The underlying read cannot be cancelled, so a late result is discarded by
 * the caller's epoch check instead of resurrecting stale proof state.
 */
function boundedVerification(promise, deadlineMs, code, message) {
  let timer = null;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new EngineWorkerError(code, message)), deadlineMs);
  });
  deadline.catch(() => {});
  promise.catch(() => {});
  return Promise.race([promise, deadline]).finally(() => {
    if (timer !== null) {
      clearTimeout(timer);
    }
  });
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

function allocationName(allocationId, launchGeneration) {
  return `alpi-${allocationId}-g${launchGeneration}`;
}

function assertPrivateDirectorySync(directory, uid, code, label) {
  let stat;
  try {
    stat = fs.lstatSync(directory);
  } catch {
    fail(code, `${label} is not a private directory.`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(code, `${label} is not a private directory.`);
  }
  if (uid !== null && stat.uid !== uid) {
    fail(code, `${label} is not owned by the service account.`);
  }
  if ((stat.mode & 0o077) !== 0) {
    fail(code, `${label} must not be accessible by group or others.`);
  }
}

function ensurePrivateDirectorySync(directory, uid, code, label) {
  const stat = lstatOrNull(directory);
  if (!stat) {
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.chmodSync(directory, 0o700);
    } catch {
      fail(code, `${label} could not be created.`);
    }
  }
  assertPrivateDirectorySync(directory, uid, code, label);
}

function validateProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid_profile', 'The worker profile is invalid.');
  }
  const allowed = new Set(['network', 'cpus', 'memoryMib', 'diskSizeGb']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail('invalid_profile', 'The worker profile contains an unexpected field.');
    }
  }
  if (!['disabled', 'boundary'].includes(value.network)) {
    fail('invalid_profile', 'The worker profile must use the verified network boundary.');
  }
  if (
    typeof value.cpus !== 'number' ||
    !Number.isFinite(value.cpus) ||
    value.cpus <= 0 ||
    value.cpus > 64
  ) {
    fail('invalid_profile', 'Profile cpus is invalid.');
  }
  if (
    !Number.isInteger(value.memoryMib) ||
    value.memoryMib < 128 ||
    value.memoryMib > 1_048_576
  ) {
    fail('invalid_profile', 'Profile memoryMib is invalid.');
  }
  if (
    !Number.isInteger(value.diskSizeGb) ||
    value.diskSizeGb < 1 ||
    value.diskSizeGb > 4096
  ) {
    fail('invalid_profile', 'Profile diskSizeGb is invalid.');
  }
  return Object.freeze({
    network: value.network,
    cpus: value.cpus,
    memoryMib: value.memoryMib,
    diskSizeGb: value.diskSizeGb,
  });
}

/**
 * Validate the trusted worker configuration. The host writes this file
 * atomically; the worker only reads it once at startup.
 */
function validateWorkerConfig(config, options = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    fail('invalid_config', 'Worker configuration is invalid.');
  }
  const allowed = new Set([
    'version',
    'protocolVersion',
    'stateRoot',
    'allocationId',
    'launchGeneration',
    'image',
    'imageDigest',
    'sdkModulePath',
    'profile',
    'homeDir',
    'controlSocketPath',
    'token',
    'tunnelPort',
    'ironIngressRoot',
    'expiresAt',
    'createdAt',
    'serviceUnit',
  ]);
  for (const key of Object.keys(config)) {
    if (!allowed.has(key)) {
      fail('invalid_config', 'Worker configuration contains an unexpected field.');
    }
  }
  if (config.version !== WORKER_VERSION) {
    fail('invalid_config', 'Worker configuration version is not supported.');
  }
  if (config.protocolVersion !== PROTOCOL_VERSION) {
    fail('invalid_config', 'Worker protocol version is not supported.');
  }
  const allocationId = normalizeAllocationId(config.allocationId);
  const launchGeneration = normalizeGeneration(config.launchGeneration);
  const stateRoot = assertAbsolute(config.stateRoot, 'invalid_config', 'stateRoot');
  const homeDir = assertAbsolute(config.homeDir, 'invalid_config', 'homeDir');
  const controlSocketPath = assertAbsolute(
    config.controlSocketPath,
    'invalid_config',
    'controlSocketPath'
  );
  const sdkModulePath = assertAbsolute(
    config.sdkModulePath,
    'invalid_config',
    'sdkModulePath'
  );
  const ironIngressRoot = assertAbsolute(
    config.ironIngressRoot,
    'invalid_config',
    'ironIngressRoot'
  );

  if (!IMAGE_PATTERN.test(config.image)) {
    fail('invalid_config', 'The worker image must be pinned by a sha256 digest.');
  }
  const digest = IMAGE_PATTERN.exec(config.image)[1];
  if (config.imageDigest !== `sha256:${digest}`) {
    fail('invalid_config', 'The worker image digest does not match the image reference.');
  }
  if (typeof config.token !== 'string' || !TOKEN_PATTERN.test(config.token)) {
    fail('invalid_config', 'The worker control token is invalid.');
  }
  if (
    !Number.isInteger(config.tunnelPort) ||
    config.tunnelPort < 1 ||
    config.tunnelPort > 65535
  ) {
    fail('invalid_config', 'The worker tunnel port is invalid.');
  }
  if (config.expiresAt !== undefined) {
    if (!Number.isSafeInteger(config.expiresAt) || config.expiresAt <= 0) {
      fail('invalid_config', 'The worker generation expiry is invalid.');
    }
  }
  if (typeof config.createdAt !== 'string' || config.createdAt.length === 0) {
    fail('invalid_config', 'The worker creation timestamp is invalid.');
  }
  if (config.serviceUnit !== undefined) {
    const expectedUnit = `alpi-worker@${allocationId}.service`;
    if (config.serviceUnit !== expectedUnit) {
      fail('invalid_config', 'The worker service unit does not match the allocation.');
    }
  }

  const allocationRoot = path.join(stateRoot, 'workers', allocationId);
  if (homeDir !== path.join(allocationRoot, 'home')) {
    fail('invalid_config', 'The worker home is not the allocation private home.');
  }
  if (controlSocketPath !== path.join(allocationRoot, 'control.sock')) {
    fail('invalid_config', 'The worker control socket is not in the allocation home.');
  }
  if (Buffer.byteLength(controlSocketPath, 'utf8') > MAX_UDS_PATH_BYTES) {
    fail('invalid_config', 'The worker control socket path is too long.');
  }
  if (!path.isAbsolute(ironIngressRoot)) {
    fail('invalid_config', 'The Iron ingress root must be absolute.');
  }
  if (options.configPath !== undefined) {
    const configPath = assertAbsolute(options.configPath, 'invalid_config', 'configPath');
    const expectedConfig = path.join(allocationRoot, 'worker.json');
    if (configPath !== expectedConfig) {
      fail('invalid_config', 'Worker configuration path is not the allocation configuration.');
    }
  }
  if (options.allocationEnv !== undefined) {
    if (options.allocationEnv !== allocationId) {
      fail('invalid_config', 'Worker systemd instance does not match the configuration.');
    }
  }

  return Object.freeze({
    version: WORKER_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    stateRoot,
    allocationId,
    launchGeneration,
    image: config.image,
    imageDigest: config.imageDigest,
    sdkModulePath,
    profile: validateProfile(config.profile),
    homeDir,
    controlSocketPath,
    token: config.token,
    tunnelPort: config.tunnelPort,
    ironIngressRoot,
    ...(config.expiresAt === undefined ? {} : { expiresAt: config.expiresAt }),
    createdAt: config.createdAt,
    ...(config.serviceUnit === undefined ? {} : { serviceUnit: config.serviceUnit }),
  });
}

function assertTrustedSdkPath(modulePath, uid) {
  const stat = lstatOrNull(modulePath);
  if (!stat) {
    fail('worker_setup_missing', SETUP_MISSING_MESSAGE);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail('worker_setup_missing', SETUP_MISSING_MESSAGE);
  }
  if (uid !== null && stat.uid !== uid && stat.uid !== 0) {
    fail('worker_setup_missing', SETUP_MISSING_MESSAGE);
  }
  if ((stat.mode & 0o022) !== 0) {
    fail('worker_setup_missing', SETUP_MISSING_MESSAGE);
  }
}

function readConfigFile(configPath, uid) {
  const resolved = assertAbsolute(configPath, 'invalid_config', 'configPath');
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    fail('worker_setup_missing', SETUP_MISSING_MESSAGE);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail('unsafe_config', 'Worker configuration is not a regular file.');
  }
  if (uid !== null && stat.uid !== uid) {
    fail('unsafe_config', 'Worker configuration is not owned by the service account.');
  }
  if ((stat.mode & 0o777) !== 0o600) {
    fail('unsafe_config', 'Worker configuration must be private.');
  }
  if (stat.size <= 0 || stat.size > MAX_CONFIG_BYTES) {
    fail('unsafe_config', 'Worker configuration size is invalid.');
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch {
    fail('unsafe_config', 'Worker configuration is not valid JSON.');
  }
  return parsed;
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
    fail('worker_namespace_unverified', 'The network namespace identity is not readable.');
  }
  return Number(match[1]);
}

/**
 * Prove the worker is in a loopback-only namespace. This runs before the
 * native SDK is imported or constructed.
 */
async function observeLoopbackOnly(netEvidence) {
  const evidence = netEvidence || createDefaultProcEvidence();
  let nsLink;
  try {
    nsLink = await evidence.readlink('/proc/self/ns/net');
  } catch {
    fail('worker_namespace_unverified', 'The worker network namespace is not observable.');
  }
  const netnsInode = netnsInodeFromLink(nsLink);

  let dev;
  let route;
  let ipv6Route = '';
  try {
    dev = await evidence.readFile('/proc/self/net/dev');
    route = await evidence.readFile('/proc/self/net/route');
    try {
      ipv6Route = await evidence.readFile('/proc/self/net/ipv6_route');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      ipv6Route = '';
    }
  } catch {
    fail('worker_namespace_unverified', 'The worker network namespace is not observable.');
  }

  const interfaces = parseInterfaces(dev);
  const ipv4Routes = parseIPv4Routes(route);
  const ipv6Routes = parseIPv6Routes(ipv6Route);
  assertLoopbackOnly(interfaces, ipv4Routes, ipv6Routes, fail);
  return Object.freeze({
    netnsInode,
    interfaces: Object.freeze([...interfaces]),
    ipv4Routes: Object.freeze(ipv4Routes),
    ipv6Routes: Object.freeze(ipv6Routes),
  });
}

function parseProcStatStartTime(statContents) {
  const closing = statContents.lastIndexOf(')');
  if (closing < 0) {
    fail('worker_shim_unverified', 'The shim process identity is not readable.');
  }
  const rest = statContents.slice(closing + 1).trim().split(/\s+/);
  if (rest.length < 20) {
    fail('worker_shim_unverified', 'The shim process identity is not readable.');
  }
  const startTime = Number(rest[19]);
  if (!Number.isSafeInteger(startTime) || startTime <= 0) {
    fail('worker_shim_unverified', 'The shim process start time is not readable.');
  }
  return startTime;
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

/**
 * Verify the actual boxlite-shim process. `info` is the trusted SDK result for
 * the owned box; `proc` is kernel evidence. The caller supplies the worker's
 * own namespace inode and cgroup, which were established before the SDK was
 * loaded.
 */
async function verifyShimProof(options) {
  if (!options || typeof options !== 'object') {
    fail('worker_shim_unverified', 'Shim verification requires evidence.');
  }
  const {
    info,
    nativeId,
    name,
    proc,
    workerNetnsInode,
    workerCgroup,
    expectedUid,
    previousStartTime,
  } = options;
  if (!info || typeof info !== 'object' || Array.isArray(info)) {
    fail('worker_shim_unverified', 'The SDK returned invalid shim information.');
  }
  if (info.id !== nativeId || info.name !== name) {
    fail('worker_shim_unverified', 'The SDK shim information does not match the owned box.');
  }
  const state = info.state;
  if (!state || typeof state !== 'object' || state.running !== true) {
    fail('worker_shim_unverified', 'The owned box is not running.');
  }
  const pid = state.pid;
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    fail('worker_shim_unverified', 'The SDK did not report a usable shim pid.');
  }

  const evidence = proc || createDefaultProcEvidence();
  let exe;
  let stat;
  let status;
  let cgroupContents;
  let nsLink;
  try {
    exe = await evidence.readlink(`/proc/${pid}/exe`);
    stat = await evidence.readFile(`/proc/${pid}/stat`);
    status = await evidence.readFile(`/proc/${pid}/status`);
    cgroupContents = await evidence.readFile(`/proc/${pid}/cgroup`);
    nsLink = await evidence.readlink(`/proc/${pid}/ns/net`);
  } catch {
    fail('worker_shim_unverified', 'The shim process evidence is not readable.');
  }

  if (
    typeof exe !== 'string' ||
    !path.isAbsolute(exe) ||
    exe.endsWith(' (deleted)') ||
    path.basename(exe) !== 'boxlite-shim'
  ) {
    fail('worker_shim_unverified', 'The shim executable is not the verified boxlite-shim.');
  }
  const startTime = parseProcStatStartTime(stat);
  if (previousStartTime !== undefined && startTime !== previousStartTime) {
    fail('worker_shim_unverified', 'The shim pid was reused by a different process.');
  }
  const uid = parseUid(status);
  if (expectedUid !== null && expectedUid !== undefined) {
    if (!uid || uid.real !== expectedUid || uid.effective !== expectedUid) {
      fail('worker_shim_unverified', 'The shim is not running as the service account.');
    }
  }
  const cgroup = parseCgroup(cgroupContents);
  if (!cgroup || cgroup !== workerCgroup) {
    fail('worker_shim_unverified', 'The shim is not in the worker control-group.');
  }
  const shimNetns = netnsInodeFromLink(nsLink);
  if (shimNetns !== workerNetnsInode) {
    fail('worker_shim_unverified', 'The shim is not in the worker network namespace.');
  }

  return Object.freeze({
    pid,
    startTime,
    exe,
    cgroup,
    netnsInode: shimNetns,
    uid: uid ? uid.real : null,
    status: state.status,
  });
}

function assertGeneration(config, value) {
  if (value !== config.launchGeneration) {
    fail('generation_mismatch', 'The request generation does not match this worker launch.');
  }
}

function assertOwnedRef(config, ref, { requireNativeId = true } = {}) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) {
    fail('invalid_ref', 'A bounded box reference is required.');
  }
  const allowed = new Set(['allocationId', 'launchGeneration', 'name', 'nativeId']);
  for (const key of Object.keys(ref)) {
    if (!allowed.has(key)) {
      fail('invalid_ref', 'The box reference contains an unexpected field.');
    }
  }
  if (ref.allocationId !== config.allocationId) {
    fail('mixed_sandbox', 'The box reference belongs to another allocation.');
  }
  assertGeneration(config, ref.launchGeneration);
  const expectedName = allocationName(config.allocationId, config.launchGeneration);
  if (ref.name !== expectedName) {
    fail('mixed_sandbox', 'The box reference name does not match this allocation.');
  }
  if (requireNativeId) {
    assertBoundedString(ref.nativeId, 'invalid_ref', 'nativeId', MAX_NATIVE_ID_LENGTH);
  } else if (ref.nativeId !== undefined) {
    assertBoundedString(ref.nativeId, 'invalid_ref', 'nativeId', MAX_NATIVE_ID_LENGTH);
  }
  return Object.freeze({
    allocationId: config.allocationId,
    launchGeneration: config.launchGeneration,
    name: expectedName,
    ...(ref.nativeId === undefined ? {} : { nativeId: ref.nativeId }),
  });
}

function normalizeArgv(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ARGV_ENTRIES) {
    fail('invalid_exec', 'Guest argv must be a bounded non-empty array.');
  }
  let total = 0;
  const argv = value.map((entry) => {
    if (
      typeof entry !== 'string' ||
      entry.length === 0 ||
      Buffer.byteLength(entry, 'utf8') > MAX_ARG_BYTES ||
      entry.includes('\u0000')
    ) {
      fail('invalid_exec', 'Guest argv contains an invalid argument.');
    }
    total += Buffer.byteLength(entry, 'utf8');
    return entry;
  });
  if (total > MAX_ARGV_BYTES) {
    fail('invalid_exec', 'Guest argv is too large.');
  }
  return Object.freeze(argv);
}

function normalizeExecSpec(config, spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    fail('invalid_exec', 'Guest execution requires an object.');
  }
  const allowed = new Set(['argv', 'timeoutMs', 'maxOutputBytes', 'tty', 'workingDir']);
  for (const key of Object.keys(spec)) {
    if (!allowed.has(key)) {
      fail('invalid_exec', 'Guest execution contains an unexpected field.');
    }
  }
  const argv = normalizeArgv(spec.argv);
  const timeoutMs = spec.timeoutMs === undefined ? DEFAULT_EXEC_TIMEOUT_MS : spec.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_EXEC_TIMEOUT_MS) {
    fail('invalid_exec', 'Guest execution timeout is invalid.');
  }
  const maxOutputBytes =
    spec.maxOutputBytes === undefined ? DEFAULT_MAX_OUTPUT_BYTES : spec.maxOutputBytes;
  if (
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    maxOutputBytes > MAX_EXEC_OUTPUT_BYTES
  ) {
    fail('invalid_exec', 'Guest execution output limit is invalid.');
  }
  if (spec.tty !== undefined && typeof spec.tty !== 'boolean') {
    fail('invalid_exec', 'Guest execution tty must be a boolean.');
  }
  let workingDir;
  if (spec.workingDir !== undefined) {
    if (
      typeof spec.workingDir !== 'string' ||
      spec.workingDir.length === 0 ||
      spec.workingDir.length > 4096 ||
      !spec.workingDir.startsWith('/') ||
      spec.workingDir.includes('\u0000')
    ) {
      fail('invalid_exec', 'Guest working directory must be an absolute guest path.');
    }
    workingDir = spec.workingDir;
  }
  return Object.freeze({
    argv,
    timeoutMs,
    maxOutputBytes,
    tty: spec.tty === true,
    ...(workingDir === undefined ? {} : { workingDir }),
  });
}

function createWorkerBoundary(config) {
  const expectedName = allocationName(config.allocationId, config.launchGeneration);
  return Object.freeze({
    async prepare(launch) {
      if (
        !launch ||
        launch.allocationId !== config.allocationId ||
        launch.launchGeneration !== config.launchGeneration ||
        launch.name !== expectedName
      ) {
        fail('mixed_sandbox', 'The boundary launch belongs to another allocation.');
      }
      return {
        network: {
          outbound: { mode: 'enabled', allowNet: [TUNNEL_ALIAS] },
          inbound: { mode: 'disabled' },
        },
      };
    },
    async verify(launch) {
      if (
        !launch ||
        launch.allocationId !== config.allocationId ||
        launch.launchGeneration !== config.launchGeneration ||
        launch.name !== expectedName
      ) {
        fail('mixed_sandbox', 'The boundary launch belongs to another allocation.');
      }
      // Creation can precede the shim. The prepared boundary stays fully
      // fenced here; the host gate opens only after an explicit start proof.
      return true;
    },
  });
}

function timingSafeTokenMatch(expected, received) {
  if (typeof received !== 'string' || typeof expected !== 'string') {
    return false;
  }
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(received, 'utf8');
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function assertIronSocket(ironSocketPath, ironIngressRoot, uid) {
  const resolved = assertAbsolute(ironSocketPath, 'invalid_iron_socket', 'Iron ingress socket');
  if (Buffer.byteLength(resolved, 'utf8') > MAX_UDS_PATH_BYTES) {
    fail('invalid_iron_socket', 'The Iron ingress socket path is too long.');
  }
  let rootReal;
  try {
    rootReal = fs.realpathSync(ironIngressRoot);
  } catch {
    fail('invalid_iron_socket', 'The trusted Iron ingress root is not available.');
  }
  let real;
  let stat;
  try {
    real = fs.realpathSync(resolved);
    stat = fs.lstatSync(real);
  } catch {
    fail('invalid_iron_socket', 'The Iron ingress socket is not available.');
  }
  const relative = path.relative(rootReal, real);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('invalid_iron_socket', 'The Iron ingress socket is outside the trusted root.');
  }
  if (!stat.isSocket() || stat.isSymbolicLink()) {
    fail('invalid_iron_socket', 'The Iron ingress endpoint is not a Unix socket.');
  }
  if (uid !== null && stat.uid !== uid && stat.uid !== 0) {
    fail('invalid_iron_socket', 'The Iron ingress socket is not owned by the service account.');
  }
  if ((stat.mode & 0o077) !== 0) {
    fail('invalid_iron_socket', 'The Iron ingress socket must be private.');
  }
  return real;
}

/**
 * Create one per-allocation worker. Options are intentionally explicit so tests
 * can inject a fake adapter, trusted runtime, getInfo, proc and net evidence.
 */
function createEngineWorker(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    fail('invalid_config', 'Worker options must be an object.');
  }
  const uid = options.uid === undefined ? currentUid() : options.uid;
  if (!Number.isSafeInteger(uid) || uid < 0) {
    fail('invalid_config', 'Worker uid is invalid.');
  }
  const configPath = options.configPath;
  let rawConfig = options.config;
  if (rawConfig === undefined) {
    if (configPath === undefined) {
      fail('invalid_config', 'Worker configuration or configuration path is required.');
    }
    rawConfig = readConfigFile(configPath, uid);
  }
  const config = validateWorkerConfig(rawConfig, {
    configPath,
    allocationEnv: options.allocationEnv ?? process.env.ALPI_ALLOCATION_ID,
  });

  const proc = options.proc || createDefaultProcEvidence();
  const netEvidence = options.net || proc;
  const proofMaxAgeMs = options.proofMaxAgeMs ?? DEFAULT_PROOF_MAX_AGE_MS;
  const proofVerifyDeadlineMs = options.proofVerifyDeadlineMs ?? proofMaxAgeMs;
  const ownerHeartbeatTimeoutMs =
    options.ownerHeartbeatTimeoutMs ?? DEFAULT_OWNER_HEARTBEAT_TIMEOUT_MS;
  const watchdogMs = options.watchdogMs ?? DEFAULT_WATCHDOG_MS;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const bridgeIdleMs = options.bridgeIdleMs ?? MAX_BRIDGE_IDLE_MS;
  const maxBridgeStreams = options.maxBridgeStreams ?? MAX_BRIDGE_STREAMS;

  let adapter = options.adapter || null;
  let runtime = options.runtime || null;
  let getInfo = options.getInfo || null;
  let server = null;
  let owner = null;
  let helloDone = false;
  let closed = false;
  let started = false;
  let netInfo = null;
  let lastProof = null;
  let lastProofAt = 0;
  let lastHeartbeatAt = 0;
  let generationExpired = false;
  let watchdogTimer = null;
  let expiryTimer = null;
  let handshakeTimer = null;
  let watchdogBusy = false;
  let activeRef = null;
  const bridge = {
    open: false,
    server: null,
    streams: new Set(),
    generation: null,
    ironSocketPath: null,
    openedAt: 0,
    reason: null,
  };

  function requireOpen() {
    if (closed) {
      fail('worker_closed', 'The worker is closed.');
    }
  }

  let fenceEpoch = 0;
  function fenceBridges(reason) {
    fenceEpoch++;
    const count = bridge.streams.size;
    for (const stream of bridge.streams) {
      try {
        stream.destroy();
      } catch {
        // Destruction is synchronous and best effort per socket.
      }
    }
    bridge.streams.clear();
    if (bridge.server) {
      try {
        bridge.server.close();
      } catch {
        // The listener is closed; active sockets were destroyed above.
      }
    }
    bridge.server = null;
    bridge.open = false;
    bridge.generation = null;
    bridge.ironSocketPath = null;
    bridge.reason = reason;
    return count;
  }

  async function verifyOwnedShim(ref, { previous } = {}) {
    const activeGetInfo = getInfo || (runtime && runtime.getInfo.bind(runtime));
    if (typeof activeGetInfo !== 'function') {
      fail('worker_shim_unverified', 'A trusted SDK getInfo function is required.');
    }
    const info = await activeGetInfo(ref.nativeId);
    if (info === null || info === undefined) {
      fail('worker_shim_unverified', 'The owned box is missing from the trusted SDK.');
    }
    const cgroupContents = await proc.readFile('/proc/self/cgroup');
    const workerCgroup = parseCgroup(cgroupContents);
    if (!workerCgroup) {
      fail('worker_shim_unverified', 'The worker control-group is not observable.');
    }
    const proof = await verifyShimProof({
      info,
      nativeId: ref.nativeId,
      name: ref.name,
      proc,
      workerNetnsInode: netInfo.netnsInode,
      workerCgroup,
      expectedUid: uid,
      previousStartTime: previous ? previous.startTime : undefined,
    });
    return { info, proof };
  }

  async function ensureRuntime() {
    if (adapter) {
      return;
    }
    assertTrustedSdkPath(config.sdkModulePath, uid);
    let loaded;
    try {
      loaded = await import(pathToFileURL(config.sdkModulePath).href);
    } catch {
      fail('worker_setup_missing', SETUP_MISSING_MESSAGE);
    }
    if (!loaded || typeof loaded.JsBoxlite !== 'function') {
      fail('worker_setup_missing', SETUP_MISSING_MESSAGE);
    }
    runtime = new loaded.JsBoxlite({ homeDir: config.homeDir });
    const { createBoxliteAdapter } = require('../engines/boxlite.cjs');
    adapter = createBoxliteAdapter({
      homeDir: config.homeDir,
      image: config.image,
      limits: {
        cpus: config.profile.cpus,
        memoryMib: config.profile.memoryMib,
        diskSizeGb: config.profile.diskSizeGb,
      },
      sdkModulePath: config.sdkModulePath,
      sdk: loaded,
      runtime,
      expectedSdkVersion: options.expectedSdkVersion,
      ...(config.profile.network === 'boundary' ? { networkBoundary: createWorkerBoundary(config) } : {}),
    });
  }

  function send(socket, payload) {
    if (!socket || socket.destroyed) {
      return;
    }
    try {
      socket.write(`${JSON.stringify(payload)}\n`);
    } catch {
      socket.destroy();
    }
  }

  // Large exec results must not be serialized into one JSON line: the owner
  // frame bound would destroy the control connection for ordinary output.
  // This chunked path is used only for exec results that exceed one chunk or
  // whose fully encoded single frame would exceed the owner frame bound;
  // ordinary small results keep the single-frame response. Writes honor
  // socket backpressure and never reissue a chunk once sent. The transport
  // bound here is per stream (MAX_EXEC_OUTPUT_BYTES on the wire); the
  // per-command output budget itself is aggregate across stdout and stderr
  // and is enforced by the adapter's shared output collector, not here.
  function writeFrame(socket, frame) {
    return new Promise((resolve) => {
      if (!socket || socket.destroyed) {
        resolve(false);
        return;
      }
      let settled = false;
      const finish = (value) => {
        if (settled) {
          return;
        }
        settled = true;
        socket.off('drain', onDrain);
        socket.off('error', onFailure);
        socket.off('close', onFailure);
        resolve(value);
      };
      const onDrain = () => finish(true);
      const onFailure = () => finish(false);
      socket.on('drain', onDrain);
      socket.on('error', onFailure);
      socket.on('close', onFailure);
      let writable = true;
      try {
        writable = socket.write(frame);
      } catch {
        finish(false);
        return;
      }
      if (writable) {
        finish(true);
      }
    });
  }

  function execResultNeedsChunks(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return false;
    }
    const stdout = typeof payload.stdout === 'string' ? payload.stdout : '';
    const stderr = typeof payload.stderr === 'string' ? payload.stderr : '';
    if (
      Buffer.byteLength(stdout, 'utf8') > EXEC_CHUNK_BYTES ||
      Buffer.byteLength(stderr, 'utf8') > EXEC_CHUNK_BYTES
    ) {
      return true;
    }
    // Raw byte length alone is not enough: JSON escape expansion can push a
    // result whose raw output is within the chunk budget past the owner frame
    // bound, which would destroy the control connection. Measure the complete
    // encoded success frame before taking the single-frame path.
    const encodedFrame = `${JSON.stringify({ id: 0, ok: true, result: payload })}\n`;
    return Buffer.byteLength(encodedFrame, 'utf8') > MAX_FRAME_BYTES;
  }

  async function sendChunkedExecResult(socket, id, payload) {
    const stdout = Buffer.from(typeof payload.stdout === 'string' ? payload.stdout : '', 'utf8');
    const stderr = Buffer.from(typeof payload.stderr === 'string' ? payload.stderr : '', 'utf8');
    if (stdout.length > MAX_EXEC_OUTPUT_BYTES || stderr.length > MAX_EXEC_OUTPUT_BYTES) {
      send(socket, {
        id,
        ok: false,
        error: {
          code: 'output_limit_exceeded',
          message: 'The guest execution output exceeded the encoded result budget.',
        },
      });
      return true;
    }
    let seq = 0;
    const emit = async (part, buffer) => {
      for (let offset = 0; offset < buffer.length; offset += EXEC_CHUNK_BYTES) {
        const slice = buffer.subarray(offset, Math.min(offset + EXEC_CHUNK_BYTES, buffer.length));
        const frame = `${JSON.stringify({
          id,
          part,
          seq,
          data: slice.toString('base64'),
        })}\n`;
        seq += 1;
        const delivered = await writeFrame(socket, frame);
        if (!delivered) {
          return false;
        }
      }
      return true;
    };
    if (!(await emit('stdout', stdout))) {
      return false;
    }
    if (!(await emit('stderr', stderr))) {
      return false;
    }
    return writeFrame(
      socket,
      `${JSON.stringify({
        id,
        ok: true,
        result: { ...payload, stdout: '', stderr: '' },
        chunked: true,
      })}\n`
    );
  }

  function errorPayload(error) {
    const code = error instanceof EngineWorkerError ? error.code : 'worker_internal_error';
    const message =
      error instanceof EngineWorkerError
        ? error.message
        : 'The engine worker operation failed.';
    return { ok: false, error: { code, message } };
  }

  async function handleOperation(message, signal, receivedEpoch) {
    requireOpen();
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      fail('invalid_request', 'A bounded worker request is required.');
    }
    const op = message.op;
    if (!OPS.has(op)) {
      fail('unknown_operation', 'The worker operation is not supported.');
    }
    if (op === 'hello') {
      fail('invalid_request', 'The control connection is already established.');
    }
    if (message.generation !== undefined) {
      assertGeneration(config, message.generation);
    }
    switch (op) {
      case 'probe':
        return adapter.probe();
      case 'create': {
        const ref = assertOwnedRef(config, message.ref, { requireNativeId: false });
        if (Object.keys(message).some((key) => !['id', 'op', 'ref', 'generation'].includes(key))) {
          fail('invalid_request', 'Create contains an unexpected field.');
        }
        const result = await adapter.createBox({
          allocationId: config.allocationId,
          launchGeneration: config.launchGeneration,
          profile: { network: config.profile.network },
        });
        if (
          !result ||
          result.allocationId !== config.allocationId ||
          result.launchGeneration !== config.launchGeneration ||
          result.name !== ref.name ||
          typeof result.nativeId !== 'string'
        ) {
          fail('mixed_sandbox', 'The engine returned another allocation.');
        }
        return Object.freeze({
          allocationId: result.allocationId,
          launchGeneration: result.launchGeneration,
          name: result.name,
          nativeId: result.nativeId,
          created: result.created === true,
        });
      }
      case 'inspect': {
        const ref = assertOwnedRef(config, message.ref);
        return adapter.inspect(ref);
      }
      case 'start': {
        const ref = assertOwnedRef(config, message.ref);
        fenceBridges('start');
        const info = await adapter.start(ref);
        try {
          const verified = await verifyOwnedShim(ref);
          activeRef = ref;
          lastProof = verified.proof;
          lastProofAt = Date.now();
          return { info, proof: verified.proof };
        } catch (error) {
          fenceBridges('proof-failed');
          try {
            await adapter.stop(ref);
          } catch {
            // Fail closed; the caller receives the proof failure.
          }
          throw error;
        }
      }
      case 'stop': {
        const ref = assertOwnedRef(config, message.ref);
        fenceBridges('stop');
        activeRef = null;
        const info = await adapter.stop(ref);
        lastProof = null;
        lastProofAt = 0;
        return { info, fenced: true };
      }
      case 'destroy': {
        const ref = assertOwnedRef(config, message.ref);
        fenceBridges('destroy');
        const result = await adapter.destroy(ref);
        lastProof = null;
        lastProofAt = 0;
        activeRef = null;
        return { ...result, fenced: true };
      }
      case 'listOwned': {
        if (Object.keys(message).some((key) => !['id', 'op', 'generation'].includes(key))) {
          fail('invalid_request', 'listOwned contains an unexpected field.');
        }
        const infos = await adapter.listOwned();
        if (!Array.isArray(infos)) {
          fail('worker_internal_error', 'The engine returned an invalid inventory.');
        }
        return infos.filter((entry) => entry && entry.allocationId === config.allocationId);
      }
      case 'status': {
        const ref = assertOwnedRef(config, message.ref);
        const activeGetInfo = getInfo || (runtime && runtime.getInfo.bind(runtime));
        if (typeof activeGetInfo !== 'function') {
          fail('worker_shim_unverified', 'A trusted SDK getInfo function is required.');
        }
        const info = await activeGetInfo(ref.nativeId);
        if (info === null || info === undefined) {
          fail('worker_shim_unverified', 'The owned box is missing from the trusted SDK.');
        }
        if (!info.state || info.state.running !== true) {
          return {
            running: false,
            proof: null,
            bridge: { open: bridge.open, streams: bridge.streams.size },
            generationExpired,
          };
        }
        // The adapter checks the retained mapping before recovery can adopt the runtime PID.
        await adapter.inspect(ref);
        const verified = await verifyOwnedShim(ref, { previous: lastProof });
        activeRef = ref;
        lastProof = verified.proof;
        lastProofAt = Date.now();
        return {
          running: true,
          proof: verified.proof,
          proofAgeMs: 0,
          bridge: { open: bridge.open, streams: bridge.streams.size },
          generationExpired,
        };
      }
      case 'heartbeat': {
        const ref = assertOwnedRef(config, message.ref);
        lastHeartbeatAt = Date.now();
        if (bridge.open) {
          if (generationExpired) {
            fenceBridges('generation-expired');
            fail('generation_expired', 'The worker launch generation has expired.');
          }
          const epoch = fenceEpoch;
          try {
            const verified = await boundedVerification(
              verifyOwnedShim(ref, { previous: lastProof }),
              proofVerifyDeadlineMs,
              'worker_shim_unverified',
              'The owned-shim evidence provider did not verify in time.'
            );
            if (epoch === fenceEpoch && !closed) {
              lastProof = verified.proof;
              lastProofAt = Date.now();
            }
            // A fence advanced the epoch while this verifier ran; discard the
            // late result instead of resurrecting stale evidence.
          } catch (error) {
            if (epoch === fenceEpoch && !closed) {
              fenceBridges('proof-failed');
            }
            throw error;
          }
        }
        return {
          alive: true,
          proofAgeMs: lastProofAt === 0 ? null : Date.now() - lastProofAt,
          bridge: { open: bridge.open, streams: bridge.streams.size },
          generationExpired,
        };
      }
      case 'exec': {
        const ref = assertOwnedRef(config, message.ref);
        const spec = normalizeExecSpec(config, message.spec);
        return adapter.exec(ref, { ...spec, signal });
      }
      case 'openBridge': {
        if (config.profile.network !== 'boundary') fail('forward_denied', 'This profile disables networking.');
        if (generationExpired) {
          fail('generation_expired', 'The worker launch generation has expired.');
        }
        const ref = assertOwnedRef(config, message.ref);
        assertGeneration(config, message.generation);
        if (bridge.open) {
          fail('bridge_already_open', 'The worker tunnel bridge is already open.');
        }
        if (
          lastProof === null ||
          Date.now() - lastProofAt > proofMaxAgeMs
        ) {
          fail('forward_denied', 'No fresh owned-shim proof is available.');
        }
        // Admission is bound to the epoch captured when this frame was
        // received, not when the queued operation dispatches: a fence or
        // close arriving while this open waits in the lifecycle queue
        // invalidates the queued admission. Opens received after the fence
        // capture the new epoch, so later explicitly authorized fresh
        // openings are not affected.
        const epoch = Number.isSafeInteger(receivedEpoch) ? receivedEpoch : fenceEpoch;
        const admitted = () => epoch === fenceEpoch && !closed && !generationExpired && !signal.aborted;
        let verified;
        try {
          verified = await boundedVerification(
            verifyOwnedShim(ref, { previous: lastProof }),
            proofVerifyDeadlineMs,
            'worker_shim_unverified',
            'The owned-shim evidence provider did not verify in time.'
          );
        } catch (error) {
          fenceBridges('proof-failed');
          throw error;
        }
        if (!admitted()) fail('forward_denied', 'Worker forwarding is fenced.');
        lastProof = verified.proof;
        lastProofAt = Date.now();
        const ironSocketPath = assertIronSocket(
          message.ironSocketPath,
          config.ironIngressRoot,
          uid
        );
        const streams = new Set();
        const tunnelServer = net.createServer((clientSocket) => {
          if (!admitted() || bridge.server !== tunnelServer || !bridge.open) {
            clientSocket.destroy();
            return;
          }
          if (streams.size >= maxBridgeStreams) {
            clientSocket.destroy();
            return;
          }
          const upstream = net.connect({ path: ironSocketPath });
          streams.add(clientSocket);
          streams.add(upstream);
          bridge.streams.add(clientSocket);
          bridge.streams.add(upstream);
          const destroyBoth = () => {
            streams.delete(clientSocket);
            streams.delete(upstream);
            bridge.streams.delete(clientSocket);
            bridge.streams.delete(upstream);
            try {
              clientSocket.destroy();
            } catch {}
            try {
              upstream.destroy();
            } catch {}
          };
          clientSocket.setTimeout(bridgeIdleMs, destroyBoth);
          upstream.setTimeout(bridgeIdleMs, destroyBoth);
          clientSocket.on('error', destroyBoth);
          upstream.on('error', destroyBoth);
          clientSocket.on('close', destroyBoth);
          upstream.on('close', destroyBoth);
          upstream.on('connect', () => {
            if (!admitted() || bridge.server !== tunnelServer || !bridge.open) {
              destroyBoth();
              return;
            }
            clientSocket.pipe(upstream);
            upstream.pipe(clientSocket);
          });
        });
        tunnelServer.on('error', () => {
          fenceBridges('tunnel-error');
        });
        try {
          await new Promise((resolve, reject) => {
            tunnelServer.once('error', reject);
            tunnelServer.listen(config.tunnelPort, TUNNEL_HOST, () => {
              tunnelServer.removeListener('error', reject);
              resolve();
            });
          });
        } catch {
          try {
            tunnelServer.close();
          } catch {}
          fenceBridges('tunnel-unavailable');
          fail('tunnel_unavailable', 'The fixed worker tunnel endpoint is unavailable.');
        }
        if (!admitted()) {
          tunnelServer.close();
          fail('forward_denied', 'Worker forwarding is fenced.');
        }
        bridge.open = true;
        bridge.server = tunnelServer;
        bridge.generation = config.launchGeneration;
        bridge.ironSocketPath = ironSocketPath;
        bridge.openedAt = Date.now();
        bridge.reason = null;
        lastHeartbeatAt = Date.now();
        return {
          port: config.tunnelPort,
          generation: config.launchGeneration,
          fenced: false,
          target: TUNNEL_ALIAS,
        };
      }
      case 'closeBridge':
      case 'fenceBridge': {
        const closedStreams = fenceBridges(op === 'closeBridge' ? 'closed' : 'fenced');
        return { fenced: true, closedStreams };
      }
      default:
        fail('unknown_operation', 'The worker operation is not supported.');
    }
  }

  async function handleMessage(message, socket, signal, receivedEpoch) {
    if (owner !== socket || socket.destroyed || signal.aborted) fail('worker_unavailable', 'Control owner disconnected.');
    if (message && message.op === 'hello') {
      if (helloDone) {
        fail('invalid_request', 'The control connection is already established.');
      }
      if (
        message.protocolVersion !== PROTOCOL_VERSION ||
        message.allocationId !== config.allocationId ||
        message.launchGeneration !== config.launchGeneration
      ) {
        fail('handshake_rejected', 'The control handshake does not match this worker.');
      }
      if (!timingSafeTokenMatch(config.token, message.token)) {
        fail('handshake_rejected', 'The control handshake token is invalid.');
      }
      helloDone = true;
      if (handshakeTimer) {
        clearTimeout(handshakeTimer);
        handshakeTimer = null;
      }
      return {
        protocolVersion: PROTOCOL_VERSION,
        workerVersion: WORKER_VERSION,
        networkMode: config.profile.network,
        allocationId: config.allocationId,
        launchGeneration: config.launchGeneration,
        pid: process.pid,
        uid,
        netnsInode: netInfo.netnsInode,
        interfaces: netInfo.interfaces,
        tunnelPort: config.tunnelPort,
        fenced: true,
        generationExpired,
      };
    }
    if (!helloDone) {
      fail('handshake_required', 'The control handshake must complete first.');
    }
    return handleOperation(message, signal, receivedEpoch);
  }

  function onConnection(socket) {
    if (closed) {
      socket.destroy();
      return;
    }
    if (owner) {
      if (!owner.destroyed && owner.writable) {
        socket.destroy();
        return;
      }
      // The previous owner is gone or no longer writable; its close event may
      // not have run yet. Fence before accepting the next managed owner.
      fenceBridges('owner-disconnect');
      owner = null;
      helloDone = false;
    }
    owner = socket;
    helloDone = false;
    let buffer = '';
    const controller = new AbortController();
    let queued = 0;
    let queue = Promise.resolve();
    socket.setEncoding('utf8');
    socket.setNoDelay(true);
    socket.setTimeout(requestTimeoutMs, () => {
      socket.destroy();
    });
    handshakeTimer = setTimeout(() => {
      socket.destroy();
    }, handshakeTimeoutMs);
    handshakeTimer.unref?.();

    socket.on('data', (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_FRAME_BYTES) {
        socket.destroy();
        return;
      }
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (line.length === 0) {
          continue;
        }
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          send(socket, { id: null, ok: false, error: { code: 'invalid_json', message: 'Malformed worker request.' } });
          socket.destroy();
          return;
        }
        if (++queued > 64) { socket.destroy(); return; }
        // Bind admission identity at receipt: an operation queued behind a
        // long-running request must observe the fence epoch as of the moment
        // its frame arrived, not when it finally dispatches.
        const receivedEpoch = fenceEpoch;
        const respond = async () => {
          let payload;
          try {
            payload = await handleMessage(message, socket, controller.signal, receivedEpoch);
          } catch (error) {
            payload = errorPayload(error);
          }
          if (payload && payload.ok === false) {
            send(socket, { id: message.id ?? null, ...payload });
          } else if (message.op === 'exec' && execResultNeedsChunks(payload)) {
            const delivered = await sendChunkedExecResult(socket, message.id ?? null, payload);
            if (!delivered) {
              socket.destroy();
            }
          } else {
            send(socket, { id: message.id ?? null, ok: true, result: payload });
          }
        };
        const isFastControl =
          message !== null &&
          typeof message === 'object' &&
          !Array.isArray(message) &&
          CONTROL_FAST_OPS.has(message.op);
        if (isFastControl) {
          // Authenticated heartbeat, fence and close control is processed
          // promptly on receipt and never queued behind a long adapter.exec;
          // a fence applies immediately. Lifecycle mutations keep their
          // bounded serialization below.
          void respond()
            .catch(() => { socket.destroy(); })
            .finally(() => { queued--; });
        } else {
          queue = queue
            .then(respond)
            .catch(() => { socket.destroy(); })
            .finally(() => { queued--; });
        }
      }
    });

    const releaseOwner = () => {
      controller.abort();
      if (owner === socket) {
        owner = null;
        helloDone = false;
        if (handshakeTimer) {
          clearTimeout(handshakeTimer);
          handshakeTimer = null;
        }
        fenceBridges('owner-disconnect');
      }
    };
    socket.on('error', releaseOwner);
    socket.on('close', releaseOwner);
  }

  async function runWatchdog() {
    if (closed || !bridge.open) {
      return;
    }
    // Proof freshness and owner-heartbeat expiry are enforced on every tick
    // before any evidence read. An in-progress (possibly stalled) verifier
    // must never be able to suppress these checks or keep a stale bridge open.
    if (generationExpired) {
      fenceBridges('generation-expired');
      return;
    }
    if (Date.now() - lastHeartbeatAt > ownerHeartbeatTimeoutMs) {
      fenceBridges('owner-heartbeat-expired');
      return;
    }
    if (lastProof === null || Date.now() - lastProofAt > proofMaxAgeMs) {
      fenceBridges('proof-expired');
      return;
    }
    if (watchdogBusy) {
      // At most one verification runs at a time; the expiry checks above
      // already ran on this tick and are never gated on the verifier.
      return;
    }
    const ref = activeRef;
    if (!ref) {
      fenceBridges('proof-unavailable');
      return;
    }
    watchdogBusy = true;
    const epoch = fenceEpoch;
    try {
      const verified = await boundedVerification(
        verifyOwnedShim(ref, { previous: lastProof }),
        proofVerifyDeadlineMs,
        'watchdog-proof-failed',
        'The owned-shim evidence provider did not verify in time.'
      );
      if (closed || epoch !== fenceEpoch) {
        // A fence advanced the epoch while this verifier ran; discard the late
        // result instead of resurrecting stale evidence.
        return;
      }
      lastProof = verified.proof;
      lastProofAt = Date.now();
    } catch {
      if (!closed && epoch === fenceEpoch) {
        fenceBridges('watchdog-proof-failed');
      }
    } finally {
      watchdogBusy = false;
    }
  }

  const worker = {
    protocolVersion: PROTOCOL_VERSION,

    async start() {
      requireOpen();
      if (started) {
        return this.address();
      }
      // 1. Prove loopback-only namespace before importing or constructing the SDK.
      netInfo = await observeLoopbackOnly(netEvidence);

      // 2. Validate the private allocation home and control socket path.
      ensurePrivateDirectorySync(config.homeDir, uid, 'unsafe_home', 'Worker home');
      const socketDirectory = path.dirname(config.controlSocketPath);
      assertPrivateDirectorySync(socketDirectory, uid, 'unsafe_home', 'Control socket directory');
      if (Buffer.byteLength(config.controlSocketPath, 'utf8') > MAX_UDS_PATH_BYTES) {
        fail('unsafe_home', 'The control socket path is too long.');
      }

      // 3. Only now import/construct the native SDK and adapter.
      await ensureRuntime();
      if (!adapter || typeof adapter.createBox !== 'function') {
        fail('worker_setup_missing', SETUP_MISSING_MESSAGE);
      }

      // 4. Create the private UDS listener without overwriting another owner.
      const existing = lstatOrNull(config.controlSocketPath);
      if (existing) {
        if (!existing.isSocket() || existing.isSymbolicLink()) {
          fail('unsafe_socket', 'The control socket path is not a Unix socket.');
        }
        if (uid !== null && existing.uid !== uid) {
          fail('unsafe_socket', 'The control socket is owned by another account.');
        }
        try {
          fs.unlinkSync(config.controlSocketPath);
        } catch {
          fail('unsafe_socket', 'The stale control socket could not be removed.');
        }
      }
      server = net.createServer({ allowHalfOpen: false }, onConnection);
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.controlSocketPath, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      fs.chmodSync(config.controlSocketPath, 0o600);

      if (config.expiresAt !== undefined) {
        const delay = Math.max(0, config.expiresAt - Date.now());
        expiryTimer = setTimeout(() => {
          generationExpired = true;
          fenceBridges('generation-expired');
        }, delay);
        expiryTimer.unref?.();
      }
      watchdogTimer = setInterval(() => {
        void runWatchdog();
      }, watchdogMs);
      watchdogTimer.unref?.();

      started = true;
      return this.address();
    },

    address() {
      return Object.freeze({
        socketPath: config.controlSocketPath,
        netnsInode: netInfo ? netInfo.netnsInode : null,
        pid: process.pid,
        allocationId: config.allocationId,
        launchGeneration: config.launchGeneration,
      });
    },

    fence(reason = 'fenced') {
      generationExpired = true;
      return fenceBridges(reason);
    },

    snapshot() {
      return Object.freeze({
        allocationId: config.allocationId,
        launchGeneration: config.launchGeneration,
        netnsInode: netInfo ? netInfo.netnsInode : null,
        bridge: {
          open: bridge.open,
          streams: bridge.streams.size,
          generation: bridge.generation,
          reason: bridge.reason,
        },
        lastProofAt,
        generationExpired,
      });
    },

    async close() {
      if (closed) {
        return;
      }
      closed = true;
      if (watchdogTimer) {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
      }
      if (expiryTimer) {
        clearTimeout(expiryTimer);
        expiryTimer = null;
      }
      if (handshakeTimer) {
        clearTimeout(handshakeTimer);
        handshakeTimer = null;
      }
      fenceBridges('closed');
      if (owner) {
        try {
          owner.destroy();
        } catch {}
        owner = null;
      }
      if (server) {
        await new Promise((resolve) => {
          server.close(() => resolve());
        });
        server = null;
      }
      if (adapter && typeof adapter.close === 'function') {
        try {
          await adapter.close();
        } catch {
          // Closing is best effort.
        }
      }
      const socket = lstatOrNull(config.controlSocketPath);
      if (socket && socket.isSocket() && (uid === null || socket.uid === uid)) {
        try {
          fs.unlinkSync(config.controlSocketPath);
        } catch {}
      }
    },
  };

  return Object.freeze(worker);
}

function parseCliArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== '--config') {
    fail('invalid_config', 'engine-worker requires exactly --config <path>.');
  }
  return argv[1];
}

async function main(argv = process.argv.slice(2)) {
  const configPath = parseCliArgs(argv);
  const worker = createEngineWorker({
    configPath,
    allocationEnv: process.env.ALPI_ALLOCATION_ID,
  });
  const address = await worker.start();
  const shutdown = async () => {
    try {
      await worker.close();
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  process.stdout.write(
    `${JSON.stringify({
      ready: true,
      allocationId: address.allocationId,
      launchGeneration: address.launchGeneration,
      pid: address.pid,
      netnsInode: address.netnsInode,
    })}\n`
  );
}

if (require.main === module) {
  main().catch((error) => {
    const code = error instanceof EngineWorkerError ? error.code : 'worker_start_failed';
    const message =
      error instanceof EngineWorkerError
        ? error.message
        : 'The engine worker failed to start.';
    process.stderr.write(`${code}: ${message}\n`);
    process.exit(1);
  });
}

module.exports = {
  PROTOCOL_VERSION,
  WORKER_VERSION,
  TUNNEL_ALIAS,
  TUNNEL_HOST,
  SETUP_MISSING_MESSAGE,
  EngineWorkerError,
  createEngineWorker,
  validateWorkerConfig,
  observeLoopbackOnly,
  verifyShimProof,
  allocationName,
};
