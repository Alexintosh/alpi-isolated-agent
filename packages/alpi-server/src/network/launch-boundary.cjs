'use strict';

/**
 * NETNS-WORKER-1 host launch boundary.
 *
 * This module owns the trusted, host-originated side of a worker launch:
 *
 *  1. Validate the operator-pinned image digest, fixed profile, verified SDK
 *     path, allocation UUID and launch generation.
 *  2. Create a private per-allocation home under the configured state root and
 *     atomically persist a 0600 worker configuration. Existing files owned by a
 *     different account are never overwritten.
 *  3. Pre-pull the pinned image into that private runtime home in the HOST
 *     process through the verified native SDK. No guest process is created
 *     during prefetch and no SDK fallback runs in the main server namespace.
 *  4. Start only `alpi-worker@<uuid>.service` through the strict systemctl
 *     client, then prove the observed worker namespace inode and loopback-only
 *     routes against the worker's report.
 *  5. Keep the forwarding gate fully fenced through create. It opens only after
 *     an explicit `arm()` that requires Iron, callback and a fresh owned-shim
 *     proof. A heartbeat plus a short watchdog rechecks the proof; any fault,
 *     owner disconnect, generation expiry or stop synchronously fences every
 *     established bridge.
 *  6. Expose a per-launch Iron `network` adapter whose `openIngress()` binds the
 *     worker's fixed 127.0.0.1 tunnel endpoint to one host-private Iron ingress
 *     Unix socket. IRON-1 owns the UDS-to-Iron endpoint and the relay owns
 *     credentials; this module only accepts a trusted socket path.
 *
 * The worker owns guest state under its private home. Host job state remains in
 * the server journal outside this module. Nothing here stores credentials.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const {
  createWorkerClient,
  createSystemctlClient,
} = require('./worker-client.cjs');

const WORKER_VERSION = 1;
const PROTOCOL_VERSION = 1;
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_UDS_PATH_BYTES = 100;
const DEFAULT_PROOF_MAX_AGE_MS = 5_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 2_000;
const DEFAULT_OWNER_HEARTBEAT_TIMEOUT_MS = 15_000;
const DEFAULT_START_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 15_000;
const TUNNEL_ALIAS = '192.168.127.254';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IMAGE_PATTERN = /^([^\s@]+)@sha256:([a-f0-9]{64})$/;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

const SETUP_MISSING_MESSAGE =
  'Alpi engine worker setup is missing; install the worker service and pinned SDK before creating a sandbox.';

class LaunchBoundaryError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'LaunchBoundaryError';
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

function fail(code, message, details) {
  throw new LaunchBoundaryError(code, message, details);
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

function imageDigestFromImage(image) {
  const match = IMAGE_PATTERN.exec(image);
  if (!match) {
    fail('invalid_image', 'The image must be pinned by a sha256 digest.');
  }
  return `sha256:${match[2]}`;
}

function normalizeProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid_profile', 'The worker profile is required.');
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
  if (uid !== null && stat.uid !== uid && stat.uid !== 0) {
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

function assertTrustedFileSync(target, uid, code, label) {
  const stat = lstatOrNull(target);
  if (!stat) {
    fail(code, `${label} is not installed.`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(code, `${label} is not a regular trusted file.`);
  }
  if (uid !== null && stat.uid !== uid && stat.uid !== 0) {
    fail(code, `${label} is not owned by the service account.`);
  }
  if ((stat.mode & 0o022) !== 0) {
    fail(code, `${label} must not be writable by group or others.`);
  }
}

function assertPrivateConfig(configPath, uid) {
  const stat = lstatOrNull(configPath);
  if (!stat) {
    return null;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail('unsafe_config', 'Worker configuration is not a regular file.');
  }
  if (uid !== null && stat.uid !== uid) {
    fail('unsafe_ownership', 'Worker configuration is owned by another account.');
  }
  if ((stat.mode & 0o777) !== 0o600) {
    fail('unsafe_config', 'Worker configuration must be private.');
  }
  if (stat.size <= 0 || stat.size > MAX_CONFIG_BYTES) {
    fail('unsafe_config', 'Worker configuration size is invalid.');
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    fail('unsafe_config', 'Worker configuration is not valid JSON.');
  }
  return parsed;
}

function writeConfigAtomic(configPath, config, uid) {
  const directory = path.dirname(configPath);
  ensurePrivateDirectorySync(directory, uid, 'unsafe_home', 'Worker configuration directory');
  const temp = path.join(
    directory,
    `.worker.json.${crypto.randomBytes(8).toString('hex')}.tmp`
  );
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, configPath);
    let directoryFd;
    try {
      directoryFd = fs.openSync(directory, 'r');
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
    fail('config_write_failed', 'Worker configuration could not be written.');
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
    try {
      fs.unlinkSync(temp);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // Keep the original failure.
      }
    }
  }
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

function parseLaunch(launch) {
  if (!launch || typeof launch !== 'object' || Array.isArray(launch)) {
    fail('invalid_launch', 'A trusted launch record is required.');
  }
  const allowed = new Set([
    'allocationId',
    'launchGeneration',
    'image',
    'imageDigest',
    'profile',
    'sdkModulePath',
    'expiresAt',
    'nativeId',
    'ref',
    'ironReady',
    'callbackReady',
  ]);
  for (const key of Object.keys(launch)) {
    if (!allowed.has(key)) {
      fail('invalid_launch', 'The launch record contains an unexpected field.');
    }
  }
  return launch;
}

/**
 * Create the host-side launch boundary. One boundary instance normally owns one
 * allocation/generation; `openIngress` uses the launch armed through `arm()`.
 */
function createLaunchBoundary(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    fail('invalid_boundary', 'Launch boundary options must be an object.');
  }
  const uid = options.uid === undefined ? currentUid() : options.uid;
  if (!Number.isSafeInteger(uid) || uid < 0) {
    fail('invalid_boundary', 'Launch boundary uid is invalid.');
  }
  const stateRoot = assertAbsolute(options.stateRoot, 'invalid_boundary', 'stateRoot');
  const tunnelPort = options.tunnelPort;
  if (!Number.isInteger(tunnelPort) || tunnelPort < 1 || tunnelPort > 65535) {
    fail('invalid_boundary', 'A fixed per-worker tunnel port is required.');
  }
  const ironIngressRoot = assertAbsolute(
    options.ironIngressRoot,
    'invalid_boundary',
    'ironIngressRoot'
  );
  const proofMaxAgeMs = options.proofMaxAgeMs ?? DEFAULT_PROOF_MAX_AGE_MS;
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const ownerHeartbeatTimeoutMs =
    options.ownerHeartbeatTimeoutMs ?? DEFAULT_OWNER_HEARTBEAT_TIMEOUT_MS;
  const startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  const proc = options.proc;
  const netEvidence = options.net;
  const connect = options.connect;
  const systemctl =
    options.systemctl !== undefined
      ? options.systemctl
      : createSystemctlClient({
          systemctlPath: options.systemctlPath,
          launcher: options.launcher,
          timeoutMs: options.systemctlTimeoutMs,
        });

  const launches = new Map();
  let activeLaunch = null;
  let closed = false;

  function requireOpen() {
    if (closed) {
      fail('boundary_closed', 'The launch boundary is closed.');
    }
  }

  function keyFor(allocationId, launchGeneration) {
    return `${allocationId}:${launchGeneration}`;
  }

  function stateFor(allocationId, launchGeneration) {
    const key = keyFor(allocationId, launchGeneration);
    return launches.get(key) || null;
  }

  async function provision(launch = {}) {
    requireOpen();
    parseLaunch(launch);
    const allocationId = normalizeAllocationId(
      launch.allocationId ?? options.allocationId
    );
    const launchGeneration = normalizeGeneration(
      launch.launchGeneration ?? options.launchGeneration
    );
    const image = launch.image ?? options.image;
    if (typeof image !== 'string' || !IMAGE_PATTERN.test(image)) {
      fail('invalid_image', 'A pinned operator image reference is required.');
    }
    const derivedDigest = imageDigestFromImage(image);
    const imageDigest = launch.imageDigest ?? options.imageDigest ?? derivedDigest;
    if (imageDigest !== derivedDigest) {
      fail('invalid_image', 'The image digest does not match the pinned reference.');
    }
    const profile = normalizeProfile(launch.profile ?? options.profile);
    const sdkModulePathValue = launch.sdkModulePath ?? options.sdkModulePath;
    if (typeof sdkModulePathValue !== 'string' || sdkModulePathValue.length === 0) {
      fail('worker_setup_missing', SETUP_MISSING_MESSAGE);
    }
    const sdkModulePath = assertAbsolute(
      sdkModulePathValue,
      'worker_setup_missing',
      'sdkModulePath'
    );
    if (options.sdk === undefined && options.runtime === undefined) {
      assertTrustedFileSync(sdkModulePath, uid, 'worker_setup_missing', 'SDK module');
    }
    const expiresAt = launch.expiresAt ?? options.expiresAt;
    if (expiresAt !== undefined) {
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
        fail('invalid_boundary', 'The launch generation expiry is invalid.');
      }
    }

    ensurePrivateDirectorySync(stateRoot, uid, 'unsafe_ownership', 'State root');
    const allocationRoot = path.join(stateRoot, 'workers', allocationId);
    ensurePrivateDirectorySync(allocationRoot, uid, 'unsafe_ownership', 'Allocation root');
    const homeDir = path.join(allocationRoot, 'home');
    ensurePrivateDirectorySync(homeDir, uid, 'unsafe_ownership', 'Allocation home');
    const controlSocketPath = path.join(allocationRoot, 'control.sock');
    if (Buffer.byteLength(controlSocketPath, 'utf8') > MAX_UDS_PATH_BYTES) {
      fail('invalid_boundary', 'The worker control socket path is too long.');
    }
    const configPath = path.join(allocationRoot, 'worker.json');
    const serviceUnit = `alpi-worker@${allocationId}.service`;

    const existing = assertPrivateConfig(configPath, uid);
    let token;
    let createdAt;
    if (existing) {
      if (
        existing.version !== WORKER_VERSION ||
        existing.protocolVersion !== PROTOCOL_VERSION
      ) {
        fail('config_conflict', 'The existing worker configuration version is not supported.');
      }
      if (existing.allocationId !== allocationId) {
        fail('config_conflict', 'The worker configuration belongs to another allocation.');
      }
      const sameIdentity =
        existing.launchGeneration === launchGeneration &&
        existing.image === image &&
        existing.imageDigest === imageDigest &&
        existing.sdkModulePath === sdkModulePath &&
        existing.homeDir === homeDir &&
        existing.controlSocketPath === controlSocketPath &&
        existing.tunnelPort === tunnelPort &&
        existing.ironIngressRoot === ironIngressRoot &&
        JSON.stringify(existing.profile) === JSON.stringify(profile);
      if (sameIdentity) {
        token = existing.token;
        createdAt = existing.createdAt;
      } else {
        if (
          existing.launchGeneration === launchGeneration ||
          (await systemctl.check(allocationId)).activeState === 'active'
        ) {
          fail('config_conflict', 'A different worker configuration already exists.');
        }
        token = crypto.randomBytes(32).toString('hex');
        createdAt = new Date().toISOString();
      }
    } else {
      token = crypto.randomBytes(32).toString('hex');
      createdAt = new Date().toISOString();
    }
    if (!TOKEN_PATTERN.test(token)) {
      fail('config_write_failed', 'The worker control token could not be generated.');
    }

    const config = Object.freeze({
      version: WORKER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      stateRoot,
      allocationId,
      launchGeneration,
      image,
      imageDigest,
      sdkModulePath,
      profile,
      homeDir,
      controlSocketPath,
      token,
      tunnelPort,
      ironIngressRoot,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      createdAt,
      serviceUnit,
    });
    if (
      !existing ||
      existing.token !== token ||
      existing.launchGeneration !== launchGeneration ||
      existing.expiresAt !== config.expiresAt
    ) {
      writeConfigAtomic(configPath, config, uid);
    }
    return Object.freeze({
      allocationId,
      launchGeneration,
      name: allocationName(allocationId, launchGeneration),
      image,
      imageDigest,
      profile,
      sdkModulePath,
      stateRoot,
      homeDir,
      controlSocketPath,
      configPath,
      token,
      tunnelPort,
      ironIngressRoot,
      serviceUnit,
      createdAt,
      ...(config.expiresAt === undefined ? {} : { expiresAt: config.expiresAt }),
    });
  }

  async function loadHostRuntime(record) {
    if (options.runtime) {
      return { runtime: options.runtime, owned: false };
    }
    if (options.sdk) {
      if (typeof options.sdk.JsBoxlite !== 'function') {
        fail('worker_setup_missing', SETUP_MISSING_MESSAGE);
      }
      return {
        runtime: new options.sdk.JsBoxlite({ homeDir: record.homeDir }),
        owned: true,
      };
    }
    assertTrustedFileSync(record.sdkModulePath, uid, 'worker_setup_missing', 'SDK module');
    let loaded;
    try {
      loaded = await import(pathToFileURL(record.sdkModulePath).href);
    } catch {
      fail('worker_setup_missing', SETUP_MISSING_MESSAGE);
    }
    if (!loaded || typeof loaded.JsBoxlite !== 'function') {
      fail('worker_setup_missing', SETUP_MISSING_MESSAGE);
    }
    return {
      runtime: new loaded.JsBoxlite({ homeDir: record.homeDir }),
      owned: true,
    };
  }

  async function prefetch(launch = {}) {
    requireOpen();
    const record = await provision(launch);
    const { runtime, owned } = await loadHostRuntime(record);
    try {
      if (
        !runtime.images ||
        typeof runtime.images.pull !== 'function'
      ) {
        fail('worker_setup_missing', SETUP_MISSING_MESSAGE);
      }
      try {
        const { cachePinnedImage } = require('../profile-image.cjs');
        await cachePinnedImage(runtime, record.image);
      } catch {
        fail('image_prefetch_unverified', 'The pinned image manifest could not be verified.');
      }
      // Deliberately no create/start/exec here: prefetch runs in the HOST
      // process and must not start a guest.
      return Object.freeze({
        pulled: true,
        image: record.image,
        imageDigest: record.imageDigest,
        homeDir: record.homeDir,
      });
    } finally {
      if (owned && typeof runtime.close === 'function') {
        try {
          await runtime.close();
        } catch {
          // Closing the prefetch runtime is best effort.
        }
      }
    }
  }

  async function start(launch = {}) {
    requireOpen();
    const record = await provision(launch);
    const key = keyFor(record.allocationId, record.launchGeneration);
    const existing = launches.get(key);
    if (existing && existing.client && existing.client.connected) {
      return Object.freeze({
        client: existing.client,
        hello: existing.client.hello,
        check: existing.lastCheck,
        record: existing.record,
      });
    }
    const client = createWorkerClient({
      allocationId: record.allocationId,
      launchGeneration: record.launchGeneration,
      controlSocketPath: record.controlSocketPath,
      token: record.token,
      serviceUid: uid,
      tunnelPort: record.tunnelPort,
      systemctl,
      proc,
      net: netEvidence,
      connect,
      proofMaxAgeMs,
      heartbeatIntervalMs,
      startTimeoutMs,
      stopTimeoutMs,
      requestTimeoutMs: options.requestTimeoutMs,
      connectRetryMs: options.connectRetryMs,
    });
    const state = existing || {
      record,
      client,
      gate: {
        open: false,
        expired: false,
        armedAt: 0,
        proof: null,
      },
      bridges: new Set(),
      lastCheck: null,
    };
    if (existing && existing.client && existing.client !== client) {
      try {
        existing.client.close();
      } catch {}
    }
    state.record = record;
    state.client = client;
    launches.set(key, state);
    activeLaunch = state;
    try {
      const ready = await client.start();
      state.lastCheck = ready.check;
      return Object.freeze({
        client,
        hello: ready.hello,
        check: ready.check,
        record,
      });
    } catch (error) {
      try {
        client.close();
      } catch {}
      throw error;
    }
  }

  function networkSpec() {
    return Object.freeze({
      outbound: Object.freeze({
        mode: 'enabled',
        allowNet: Object.freeze([TUNNEL_ALIAS]),
      }),
      inbound: Object.freeze({ mode: 'disabled' }),
    });
  }

  async function prepare(launch = {}) {
    requireOpen();
    const record = await provision(launch);
    const state = stateFor(record.allocationId, record.launchGeneration);
    if (state) {
      state.gate.open = false;
      state.gate.proof = null;
      for (const bridge of state.bridges) {
        try {
          void bridge.close();
        } catch {}
      }
      state.bridges.clear();
    }
    return Object.freeze({
      allocationId: record.allocationId,
      launchGeneration: record.launchGeneration,
      name: record.name,
      network: networkSpec(),
      fenced: true,
    });
  }

  async function verify(launch = {}) {
    requireOpen();
    const record = await provision(launch);
    const state = stateFor(record.allocationId, record.launchGeneration);
    if (state) {
      state.gate.open = false;
      for (const bridge of state.bridges) {
        try {
          void bridge.close();
        } catch {}
      }
      state.bridges.clear();
    }
    if (!state || !state.client || !state.client.connected) {
      // Creation may precede the first shim. Do not open forwarding here.
      return true;
    }
    const nativeId = launch.nativeId ?? launch.ref?.nativeId;
    if (typeof nativeId !== 'string' || nativeId.length === 0) {
      fail('worker_unverified', 'A native box id is required for verification.');
    }
    const ref = {
      allocationId: record.allocationId,
      launchGeneration: record.launchGeneration,
      name: record.name,
      nativeId,
    };
    const status = await state.client.engine.status(ref);
    if (status.running !== true) {
      return true;
    }
    if (!status.proof) {
      return false;
    }
    // The prepared boundary remains fenced through create even when the shim
    // is already running. Only arm() opens forwarding.
    return true;
  }

  async function arm(launch = {}) {
    requireOpen();
    if (!launch || launch.ironReady !== true || launch.callbackReady !== true) {
      fail('forward_denied', 'Iron and callback readiness are required before forwarding.');
    }
    const record = await provision(launch);
    if (record.profile.network !== 'boundary') fail('forward_denied', 'This profile disables networking.');
    const state = stateFor(record.allocationId, record.launchGeneration);
    if (!state || !state.client || !state.client.connected) {
      fail('forward_denied', 'The worker control connection is not ready.');
    }
    if (state.gate.expired) {
      fail('generation_expired', 'The launch generation has expired.');
    }
    const nativeId = launch.nativeId ?? launch.ref?.nativeId;
    if (typeof nativeId !== 'string' || nativeId.length === 0) {
      fail('forward_denied', 'A verified native box id is required.');
    }
    const ref = {
      allocationId: record.allocationId,
      launchGeneration: record.launchGeneration,
      name: record.name,
      nativeId,
    };
    try {
      const check = await state.client.check();
      state.lastCheck = check;
      if (check.activeState !== 'active') {
        fail('forward_denied', 'The worker unit is not active.');
      }
      await state.client.heartbeatNow();
      const status = await state.client.engine.status(ref);
      if (
        status.running !== true ||
        !status.proof ||
        status.bridge.open === true
      ) {
        fail('forward_denied', 'A running owned shim proof is required.');
      }
      if (Date.now() - state.client.lastHeartbeatAt > ownerHeartbeatTimeoutMs) {
        fail('forward_denied', 'The worker heartbeat is stale.');
      }
      state.gate.open = true;
      state.gate.expired = false;
      state.gate.armedAt = Date.now();
      state.gate.proof = status.proof;
      activeLaunch = state;
      return Object.freeze({
        armed: true,
        allocationId: record.allocationId,
        launchGeneration: record.launchGeneration,
        proof: status.proof,
      });
    } catch (error) {
      state.gate.open = false;
      state.gate.expired = true;
      try {
        await state.client.fence('arm-failed');
      } catch {}
      throw error;
    }
  }

  function resolveIronSocket(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      fail('invalid_ingress', 'Iron ingress options are required.');
    }
    let ironSocketPath;
    if (options.ironIngressPath !== undefined) {
      if (typeof options.ironIngressPath !== 'function') {
        fail('invalid_ingress', 'ironIngressPath must be a function.');
      }
      ironSocketPath = options.ironIngressPath(args);
    } else {
      if (typeof args.directory !== 'string' || !path.isAbsolute(args.directory)) {
        fail('invalid_ingress', 'The Iron state directory must be absolute.');
      }
      ironSocketPath = path.join(args.directory, 'iron-ingress.sock');
    }
    return assertIronSocket(ironSocketPath, ironIngressRoot, uid);
  }

  async function openIngress(args) {
    requireOpen();
    const state = activeLaunch;
    if (!state || !state.client) {
      fail('forward_denied', 'No armed worker launch is available.');
    }
    if (!state.gate.open || state.gate.expired) {
      fail('forward_denied', 'Forwarding is fenced; an explicit arm is required.');
    }
    if (!state.client.connected) {
      fail('forward_denied', 'The worker control connection is not available.');
    }
    const ironSocketPath = resolveIronSocket(args);
    try {
      const check = await state.client.check();
      state.lastCheck = check;
      if (check.activeState !== 'active') {
        fail('forward_denied', 'The worker unit is not active.');
      }
      await state.client.heartbeatNow();
      if (Date.now() - state.client.lastHeartbeatAt > ownerHeartbeatTimeoutMs) {
        fail('forward_denied', 'The worker heartbeat is stale.');
      }
      const bridge = await state.client.openBridge(ironSocketPath);
      state.bridges.add(bridge);
      return Object.freeze({
        port: bridge.port,
        target: bridge.target || 'iron-proxy',
        generation: bridge.generation,
        healthy: () => state.gate.open && !state.gate.expired && bridge.healthy(),
        close: async () => {
          state.bridges.delete(bridge);
          await bridge.close();
        },
      });
    } catch (error) {
      state.gate.open = false;
      state.gate.expired = true;
      try {
        await state.client.fence('ingress-failed');
      } catch {}
      throw error;
    }
  }

  async function fence(reason = 'fenced') {
    requireOpen();
    for (const state of launches.values()) {
      state.gate.open = false;
      state.gate.expired = true;
      for (const bridge of state.bridges) {
        try {
          void bridge.close();
        } catch {}
      }
      state.bridges.clear();
      if (state.client) {
        try {
          void state.client.fence(reason).catch(() => {});
        } catch {}
      }
    }
    return { fenced: true, reason };
  }

  async function recover(launch = {}) {
    requireOpen();
    const record = await provision(launch);
    const state = stateFor(record.allocationId, record.launchGeneration);
    if (!state || !state.client) {
      // No live worker process is assumed during recovery. Never auto-start.
      return Object.freeze({
        forwarding: false,
        reason: 'worker-not-attached',
      });
    }
    try {
      const check = await state.client.check();
      state.lastCheck = check;
      if (check.activeState !== 'active') {
        await fence('recovery-service-inactive');
        return Object.freeze({
          forwarding: false,
          reason: 'service-inactive',
        });
      }
      if (!state.client.connected) {
        // The unit is active; attach without opening forwarding.
        await state.client.start();
      }
      const nativeId = launch.nativeId ?? launch.ref?.nativeId;
      if (typeof nativeId !== 'string' || nativeId.length === 0) {
        await fence('recovery-no-proof');
        return Object.freeze({
          forwarding: false,
          reason: 'shim-unverified',
        });
      }
      const ref = {
        allocationId: record.allocationId,
        launchGeneration: record.launchGeneration,
        name: record.name,
        nativeId,
      };
      const status = await state.client.engine.status(ref);
      state.gate.open = false;
      if (status.running === true && status.proof) {
        state.gate.expired = false;
        return Object.freeze({
          forwarding: false,
          reason: 'requires-explicit-arm',
          proof: status.proof,
        });
      }
      state.gate.expired = true;
      return Object.freeze({
        forwarding: false,
        reason: 'shim-unverified',
      });
    } catch {
      await fence('recovery-failed');
      return Object.freeze({
        forwarding: false,
        reason: 'recovery-failed',
      });
    }
  }

  async function withEngine(launch, fn, runOptions = {}) {
    requireOpen();
    if (typeof fn !== 'function') {
      fail('invalid_boundary', 'withEngine requires a callback.');
    }
    const record = await provision(launch);
    if (runOptions.skipPrefetch !== true) {
      await prefetch(launch);
    }
    const ready = await start(launch);
    try {
      return await fn(ready.client.engine, {
        client: ready.client,
        hello: ready.hello,
        check: ready.check,
        record,
        boundary: boundaryApi,
      });
    } finally {
      try {
        await fence('withEngine-finally');
      } catch {}
      try {
        await ready.client.stop();
      } catch {}
      ready.client.close();
    }
  }

  function close() {
    if (closed) {
      return;
    }
    closed = true;
    for (const state of launches.values()) {
      for (const bridge of state.bridges) {
        try {
          void bridge.close();
        } catch {}
      }
      state.bridges.clear();
      if (state.client) {
        try {
          void state.client.fence('boundary-close').catch(() => {});
        } catch {}
        try {
          state.client.close();
        } catch {}
      }
    }
    launches.clear();
    activeLaunch = null;
  }

  const network = Object.freeze({
    async prepare(args) {
      if (!args || typeof args !== 'object') {
        fail('invalid_ingress', 'Iron network preparation requires options.');
      }
      const proxyPort = args.proxyPort;
      if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
        fail('invalid_ingress', 'The Iron proxy port is invalid.');
      }
      return Object.freeze({ proxyPort });
    },
    async assertPortFree() {},
    async configureRoute() {},
    async openIngress(args) {
      return boundaryApi.openIngress(args);
    },
  });

  const boundaryApi = Object.freeze({
    provision,
    prefetch,
    start,
    prepare,
    verify,
    arm,
    openIngress,
    recover,
    fence,
    withEngine,
    close,
    network,
    get state() {
      return activeLaunch
        ? Object.freeze({
            allocationId: activeLaunch.record.allocationId,
            launchGeneration: activeLaunch.record.launchGeneration,
            forwarding: activeLaunch.gate.open && !activeLaunch.gate.expired,
            proof: activeLaunch.gate.proof,
            lastCheck: activeLaunch.lastCheck,
          })
        : null;
    },
  });

  return boundaryApi;
}

module.exports = {
  WORKER_VERSION,
  PROTOCOL_VERSION,
  TUNNEL_ALIAS,
  SETUP_MISSING_MESSAGE,
  LaunchBoundaryError,
  createLaunchBoundary,
  imageDigestFromImage,
};
