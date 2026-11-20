'use strict';

// Nonprivileged host-side Iron lifecycle.
//
// This module deliberately does not require @grpc/*. The control package can
// start without the optional callback profile. The real stock gRPC callback is
// an optional private profile under profiles/iron-callback; its dependencies
// are installed only by installCallbackProfile(), never while serving.
//
// Canonical host modules are staged by value into the profile's vendor/
// directory at explicit install time. callback-runtime.cjs resolves those
// helpers relative to the installed profile, so it also works when the
// control package is not inside the source checkout.
//
// Namespace/relay enforcement is intentionally out of scope. Production wiring
// must inject `network` (the NETNS/RELAY adapter) and `relay`. Without those
// adapters this module uses host loopback and performs no namespace setup. It
// never claims that a namespace or route was enforced.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

const IRON_VERSION = '0.56.0';
// Official paradigmxyz/iron-proxy v0.56.0 linux-amd64 inner binary.
const IRON_SHA256 =
  'ffc438b55c104b896a918dca74fb8b016d0b5e84bf12349586d50e07ea5c9b1f';
const GRPC_JS_VERSION = '1.14.7';
const PROTO_LOADER_VERSION = '0.8.0';
const GRANT_PATH = '/v1/chat/completions';
const DEFAULT_GRANT_MS = 10 * 60 * 1000;
const MAX_GRANT_MS = 60 * 60 * 1000;
const DEFAULT_START_TIMEOUT_MS = 30_000;
const DEFAULT_CALLBACK_TIMEOUT_MS = 60_000;
const MAX_MODEL_LENGTH = 200;
const MAX_STATE_DIR_LENGTH = 4096;
const MAX_PATH_LENGTH = 4096;
const MAX_CALLBACK_PENDING = 16;

const CANONICAL_FILES = Object.freeze([
  Object.freeze({
    source: 'src/runtime/network-policy.cjs',
    destination: 'vendor/network-policy.cjs',
    mode: 0o600,
  }),
  Object.freeze({
    source: 'src/runtime/atomic-json.cjs',
    destination: 'vendor/atomic-json.cjs',
    mode: 0o600,
  }),
  Object.freeze({
    source: 'src/runtime/iron-ca.cjs',
    destination: 'vendor/iron-ca.cjs',
    mode: 0o600,
  }),
  Object.freeze({
    source: 'src/runtime/owned-process.cjs',
    destination: 'vendor/owned-process.cjs',
    mode: 0o600,
  }),
  Object.freeze({
    source: 'src/runtime/process-owner.cjs',
    destination: 'vendor/process-owner.cjs',
    mode: 0o600,
  }),
  Object.freeze({
    source: 'src/protocol/iron-transform.proto',
    destination: 'vendor/iron-transform.proto',
    mode: 0o644,
  }),
  Object.freeze({
    source: 'src/protocol/IRON-LICENSE',
    destination: 'vendor/IRON-LICENSE',
    mode: 0o644,
  }),
]);

class IronError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'IronError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new IronError(code, message);
}

function assertAbsolutePath(value, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_PATH_LENGTH ||
    value.includes('\u0000') ||
    !path.isAbsolute(value)
  ) {
    throw new TypeError(`${label} must be an absolute filesystem path.`);
  }
  return path.resolve(value);
}

function assertSafeId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) {
    fail('invalid_environment', 'The environment identifier is invalid.');
  }
  return value;
}

function assertModel(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_MODEL_LENGTH ||
    /[\x00-\x1f\x7f]/.test(value)
  ) {
    fail('invalid_model', 'The model identifier is invalid.');
  }
  return value;
}

function assertPort(value, label, { allowZero = false } = {}) {
  if (
    !Number.isInteger(value) ||
    value < (allowZero ? 0 : 1) ||
    value > 65535
  ) {
    fail('invalid_port', `${label} must be a valid TCP port.`);
  }
  return value;
}

function isUsableConnectorIPv4(value) {
  if (typeof value !== 'string' || !net.isIPv4(value)) return false;
  if (value === '0.0.0.0' || value === '255.255.255.255') return false;
  const first = Number(value.split('.')[0]);
  // Multicast is not a fixed unicast connector.
  return first < 224 || first > 239;
}

function validateConnector(connector) {
  if (!connector || typeof connector !== 'object' || Array.isArray(connector)) {
    fail('invalid_connector', 'A fixed connector is required.');
  }
  if (!isUsableConnectorIPv4(connector.address)) {
    fail('invalid_connector', 'The connector must be a fixed unicast IPv4 literal.');
  }
  return {
    address: connector.address,
    port: assertPort(connector.port, 'Connector port'),
  };
}

function validateGrant(grant) {
  if (!grant || typeof grant !== 'object' || Array.isArray(grant)) {
    fail('invalid_grant', 'A policy grant is required.');
  }
  const allowed = new Set([
    'environmentId',
    'scheme',
    'host',
    'port',
    'method',
    'pathname',
    'expiresAt',
    'model',
  ]);
  for (const key of Object.keys(grant)) {
    if (!allowed.has(key)) {
      fail('invalid_grant', 'The policy grant contains an unexpected field.');
    }
  }
  assertSafeId(grant.environmentId);
  if (grant.scheme !== 'http') {
    fail('invalid_grant', 'The policy grant must use plain HTTP inside the relay.');
  }
  if (!isUsableConnectorIPv4(grant.host)) {
    fail('invalid_grant', 'The policy grant host must be a fixed IPv4 literal.');
  }
  assertPort(grant.port, 'Grant port');
  if (grant.method !== 'POST') {
    fail('invalid_grant', 'The policy grant must be a POST request.');
  }
  if (grant.pathname !== GRANT_PATH) {
    fail('invalid_grant', 'The policy grant path is not the single model endpoint.');
  }
  if (!Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= 0) {
    fail('invalid_grant', 'The policy grant expiry is invalid.');
  }
  assertModel(grant.model);
  return {
    environmentId: grant.environmentId,
    scheme: grant.scheme,
    host: grant.host,
    port: grant.port,
    method: grant.method,
    pathname: grant.pathname,
    expiresAt: grant.expiresAt,
    model: grant.model,
  };
}

function validateLaunchOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Iron lifecycle options are required.');
  }
  const stateDir = assertAbsolutePath(options.stateDir, 'stateDir');
  if (stateDir.length > MAX_STATE_DIR_LENGTH) {
    throw new TypeError('stateDir is too long.');
  }
  const environmentId = assertSafeId(options.environmentId);
  const ironBinary = assertAbsolutePath(options.ironBinary, 'ironBinary');
  if (
    typeof options.ironSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(options.ironSha256)
  ) {
    fail('invalid_digest', 'A pinned Iron SHA-256 digest is required.');
  }
  const connector = validateConnector(options.connector);
  const model = assertModel(options.model);
  if (
    !options.relay ||
    typeof options.relay !== 'object' ||
    typeof options.relay.fence !== 'function'
  ) {
    fail('invalid_relay', 'A relay with a synchronous fence() is required.');
  }
  if (
    options.callbackFactory !== undefined &&
    typeof options.callbackFactory !== 'function'
  ) {
    throw new TypeError('callbackFactory must be a function.');
  }
  let callbackProfileDir = null;
  if (options.callbackProfileDir !== undefined && options.callbackProfileDir !== null) {
    callbackProfileDir = assertAbsolutePath(
      options.callbackProfileDir,
      'callbackProfileDir'
    );
  }
  if (!options.callbackFactory && !callbackProfileDir) {
    fail(
      'callback_profile_required',
      'A callback profile directory or an injected callbackFactory is required.'
    );
  }
  if (
    options.network !== undefined &&
    (!options.network ||
      typeof options.network !== 'object' ||
      Array.isArray(options.network))
  ) {
    throw new TypeError('network must be an adapter object.');
  }
  if (
    options.helpers !== undefined &&
    (!options.helpers ||
      typeof options.helpers !== 'object' ||
      Array.isArray(options.helpers))
  ) {
    throw new TypeError('helpers must be an object.');
  }
  if (
    options.signal !== undefined &&
    (typeof options.signal !== 'object' ||
      options.signal === null ||
      typeof options.signal.aborted !== 'boolean')
  ) {
    throw new TypeError('signal must be an AbortSignal.');
  }

  const grantMs = options.grantMs ?? DEFAULT_GRANT_MS;
  if (!Number.isInteger(grantMs) || grantMs < 1 || grantMs > MAX_GRANT_MS) {
    fail('invalid_grant_window', 'The grant window is outside the allowed bound.');
  }
  const startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  if (
    !Number.isInteger(startTimeoutMs) ||
    startTimeoutMs < 100 ||
    startTimeoutMs > 120_000
  ) {
    throw new TypeError('startTimeoutMs must be between 100 and 120000.');
  }
  const callbackTimeoutMs =
    options.callbackTimeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS;
  if (
    !Number.isInteger(callbackTimeoutMs) ||
    callbackTimeoutMs < 1 ||
    callbackTimeoutMs > 60_000
  ) {
    throw new TypeError('callbackTimeoutMs must be between 1 and 60000.');
  }
  const nodePath =
    options.nodePath === undefined
      ? process.execPath
      : assertAbsolutePath(options.nodePath, 'nodePath');
  if (options.now !== undefined && typeof options.now !== 'function') {
    throw new TypeError('now must be a function.');
  }

  return {
    stateDir,
    environmentId,
    ironBinary,
    ironSha256: options.ironSha256.toLowerCase(),
    connector,
    model,
    relay: options.relay,
    callbackFactory: options.callbackFactory,
    callbackProfileDir,
    network: options.network,
    helpers: options.helpers ?? {},
    grantMs,
    startTimeoutMs,
    callbackTimeoutMs,
    nodePath,
    now: options.now ?? Date.now,
    signal: options.signal,
  };
}

function parseLoopbackAddress(address) {
  if (typeof address !== 'string' || address.length > 64) {
    fail('invalid_callback_address', 'The callback address is invalid.');
  }
  const match = /^([0-9]{1,3}(?:\.[0-9]{1,3}){3}):([0-9]{1,5})$/.exec(address);
  if (!match || !net.isIPv4(match[1])) {
    fail('invalid_callback_address', 'The callback address is invalid.');
  }
  const host = match[1];
  const port = Number(match[2]);
  assertPort(port, 'Callback port');
  // The callback must stay on host loopback. It is never given to the guest.
  if (host !== '127.0.0.1') {
    fail('invalid_callback_address', 'The callback must bind host loopback only.');
  }
  return { host, port, address: `127.0.0.1:${port}` };
}

function buildIronConfig({ proxyPort, callbackAddress, caFile, keyFile }) {
  assertPort(proxyPort, 'Proxy port');
  parseLoopbackAddress(callbackAddress);
  assertAbsolutePath(caFile, 'caFile');
  assertAbsolutePath(keyFile, 'keyFile');
  return {
    dns: { enabled: false },
    proxy: {
      http_listen: '127.0.0.1:0',
      https_listen: '127.0.0.1:0',
      tunnel_listen: `127.0.0.1:${proxyPort}`,
      // Local models may take minutes before the first streamed token.
      upstream_response_header_timeout: '30m',
      // Deliberately no upstream_deny_cidrs override: stock Iron protections
      // remain in place and the relay adapter owns the fixed route.
    },
    tls: { mode: 'mitm', ca_cert: caFile, ca_key: keyFile },
    transforms: [
      {
        name: 'grpc',
        config: {
          name: 'isolated-host-policy',
          target: callbackAddress,
          send_request_body: false,
          send_response_body: false,
        },
      },
    ],
    metrics: { listen: '127.0.0.1:0' },
    log: { level: 'error' },
  };
}

async function verifyIronBinary(binary, expectedSha256) {
  const file = assertAbsolutePath(binary, 'ironBinary');
  if (
    typeof expectedSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(expectedSha256)
  ) {
    fail('invalid_digest', 'A pinned Iron SHA-256 digest is required.');
  }
  let stat;
  try {
    stat = await fsp.lstat(file);
  } catch {
    fail('iron_missing', 'The trusted Iron binary is missing.');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail('iron_invalid', 'The trusted Iron binary must be a regular file.');
  }
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  const actual = hash.digest('hex');
  if (actual !== expectedSha256.toLowerCase()) {
    fail('iron_digest_mismatch', 'Iron does not match the pinned digest.');
  }
  return { file, sha256: actual, bytes: stat.size };
}

function writePrivateJson(file, value) {
  const directory = path.dirname(file);
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${crypto.randomBytes(12).toString('hex')}.tmp`
  );
  let handle;
  try {
    handle = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
    try {
      fs.unlinkSync(temporary);
    } catch {}
  }
}

function ensureRealDirectory(directory, mode) {
  fs.mkdirSync(directory, { recursive: true, mode });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail('unsafe_directory', 'A private directory must not be a symlink.');
  }
  fs.chmodSync(directory, mode);
  return directory;
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function assertPortFree(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => {
      reject(
        new IronError(
          'port_busy',
          'The proxy port is already in use and will not be adopted.'
        )
      );
    });
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}

function probe(host, port, timeoutMs = 200) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('timeout')));
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.destroy();
      resolve();
    });
  });
}

async function waitUntil(check, timeoutMs, signal, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    signal?.throwIfAborted();
    if (await check()) return;
    if (Date.now() >= deadline) {
      fail('readiness_timeout', `${label} did not become ready before the timeout.`);
    }
    await delay(25, undefined, { signal });
  }
}

function loadHelpers(options) {
  const helpers = options.helpers;
  let ensureCA = helpers.ensureCA;
  let privateDirectory = helpers.privateDirectory;
  let startOwnedProcess = helpers.startOwnedProcess;
  if (!ensureCA || !privateDirectory || !startOwnedProcess) {
    if (!options.callbackProfileDir) {
      fail(
        'helpers_missing',
        'Canonical CA/process helpers are not available and no callback profile was supplied.'
      );
    }
    const vendor = path.join(options.callbackProfileDir, 'vendor');
    if (!ensureCA || !privateDirectory) {
      let ca;
      try {
        ca = require(path.join(vendor, 'iron-ca.cjs'));
      } catch {
        fail('helpers_missing', 'The staged canonical Iron CA helper is missing.');
      }
      ensureCA = ensureCA ?? ca.ensureCA;
      privateDirectory = privateDirectory ?? ca.privateDirectory;
    }
    if (!startOwnedProcess) {
      let owned;
      try {
        owned = require(path.join(vendor, 'owned-process.cjs'));
      } catch {
        fail('helpers_missing', 'The staged canonical owned-process helper is missing.');
      }
      startOwnedProcess = owned.startOwnedProcess;
    }
  }
  if (
    typeof ensureCA !== 'function' ||
    typeof privateDirectory !== 'function' ||
    typeof startOwnedProcess !== 'function'
  ) {
    fail('helpers_missing', 'The canonical host helpers are incomplete.');
  }
  return {
    ensureCA,
    privateDirectory,
    startOwnedProcess,
    probe: helpers.probe ?? probe,
    assertPortFree: helpers.assertPortFree ?? assertPortFree,
    findFreePort: helpers.findFreePort ?? findFreePort,
  };
}

function startCallbackProcess({
  runtimeFile,
  configFile,
  cwd,
  nodePath,
  timeoutMs,
  signal,
  onFault,
}) {
  signal?.throwIfAborted();
  const child = spawn(nodePath, [runtimeFile, '--config', configFile], {
    cwd,
    env: { PATH: '/usr/bin:/bin', HOME: path.dirname(configFile) },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    detached: false,
  });
  let alive = true;
  let closing = false;
  let closePromise;
  const exited = new Promise((resolve) => {
    child.once('exit', () => {
      alive = false;
      resolve();
      if (!closing) onFault('callback-exited');
    });
  });
  child.once('error', () => {
    alive = false;
    if (!closing) onFault('callback-error');
  });

  async function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      if (!alive) return;
      child.kill('SIGTERM');
      await Promise.race([exited, delay(3000)]);
      if (alive) child.kill('SIGKILL');
      await exited;
    })();
    return closePromise;
  }

  const ready = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, port) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      child.removeListener('message', message);
      child.removeListener('exit', failed);
      child.removeListener('error', failed);
      if (error) reject(error);
      else resolve(port);
    };
    const failed = () => finish(new IronError('callback_exited', 'The callback exited before readiness.'));
    const abort = () => {
      close().catch(() => {});
      finish(new IronError('aborted', 'The callback launch was aborted.'));
    };
    const message = (value) => {
      if (value?.type === 'ready' && Number.isInteger(value.port)) {
        try {
          assertPort(value.port, 'Callback port');
        } catch (error) {
          finish(error);
          return;
        }
        finish(null, value.port);
      } else if (value?.type === 'error') {
        finish(
          new IronError(
            typeof value.code === 'string' ? value.code : 'callback_error',
            'The callback failed to start.'
          )
        );
      }
    };
    const timer = setTimeout(
      () => finish(new IronError('callback_timeout', 'The callback did not become ready before the timeout.')),
      timeoutMs
    );
    timer.unref?.();
    child.on('message', message);
    child.once('exit', failed);
    child.once('error', failed);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });

  return ready.then(
    (port) => ({
      address: `127.0.0.1:${port}`,
      pid: child.pid,
      healthy: () => alive && !closing,
      close,
    }),
    async (error) => {
      await close();
      throw error;
    }
  );
}

async function startCallback(options, grant, directory, signal, onFault) {
  if (options.callbackFactory) {
    const handle = await options.callbackFactory({
      environmentId: options.environmentId,
      grant,
      directory,
      signal,
      onFault,
    });
    if (
      !handle ||
      typeof handle !== 'object' ||
      typeof handle.close !== 'function' ||
      typeof handle.healthy !== 'function' ||
      typeof handle.address !== 'string'
    ) {
      fail('callback_invalid', 'The injected callback handle is invalid.');
    }
    parseLoopbackAddress(handle.address);
    return handle;
  }

  const runtimeFile = path.join(options.callbackProfileDir, 'callback-runtime.cjs');
  let stat;
  try {
    stat = await fsp.lstat(runtimeFile);
  } catch {
    fail('callback_profile_missing', 'The installed callback runtime is missing.');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail('callback_profile_missing', 'The callback runtime must be a regular file.');
  }
  const configFile = path.join(directory, 'callback.json');
  writePrivateJson(configFile, {
    version: 1,
    environmentId: options.environmentId,
    grant,
    timeoutMs: options.callbackTimeoutMs,
    maxPending: MAX_CALLBACK_PENDING,
    host: '127.0.0.1',
    port: 0,
  });
  return startCallbackProcess({
    runtimeFile,
    configFile,
    cwd: options.callbackProfileDir,
    nodePath: options.nodePath,
    timeoutMs: options.startTimeoutMs,
    signal,
    onFault,
  });
}

async function stageCallbackProfile({ sourceRoot, profileDir, signal }) {
  const source = assertAbsolutePath(sourceRoot, 'sourceRoot');
  const profile = assertAbsolutePath(profileDir, 'profileDir');
  signal?.throwIfAborted();
  ensureRealDirectory(profile, 0o700);
  const vendor = ensureRealDirectory(path.join(profile, 'vendor'), 0o700);
  for (const entry of CANONICAL_FILES) {
    signal?.throwIfAborted();
    const sourceFile = path.join(source, entry.source);
    const destination = path.join(profile, entry.destination);
    let stat;
    try {
      stat = await fsp.lstat(sourceFile);
    } catch {
      fail('canonical_missing', `The canonical source ${entry.source} is missing.`);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail('canonical_invalid', `The canonical source ${entry.source} is not a regular file.`);
    }
    const temporary = path.join(
      vendor,
      `.${path.basename(destination)}.${crypto.randomBytes(12).toString('hex')}.tmp`
    );
    try {
      await fsp.copyFile(sourceFile, temporary, fs.constants.COPYFILE_EXCL);
      await fsp.chmod(temporary, entry.mode);
      await fsp.rename(temporary, destination);
      await fsp.chmod(destination, entry.mode);
    } finally {
      await fsp.rm(temporary, { force: true }).catch(() => {});
    }
  }
  return {
    profileDir: profile,
    vendorDir: vendor,
    files: CANONICAL_FILES.map((entry) => ({
      path: path.join(profile, entry.destination),
      mode: entry.mode,
    })),
  };
}

function readJsonFile(file, label) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    fail('profile_invalid', `${label} is missing.`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    fail('profile_invalid', `${label} is not valid JSON.`);
  }
}

function assertProfileManifests(profileDir) {
  const pkg = readJsonFile(path.join(profileDir, 'package.json'), 'callback package.json');
  const shrink = readJsonFile(
    path.join(profileDir, 'npm-shrinkwrap.json'),
    'callback npm-shrinkwrap.json'
  );
  if (
    !pkg ||
    typeof pkg !== 'object' ||
    Array.isArray(pkg) ||
    pkg.dependencies?.['@grpc/grpc-js'] !== GRPC_JS_VERSION ||
    pkg.dependencies?.['@grpc/proto-loader'] !== PROTO_LOADER_VERSION
  ) {
    fail('profile_invalid', 'The callback package does not pin the exact gRPC dependencies.');
  }
  if (
    !shrink ||
    typeof shrink !== 'object' ||
    Array.isArray(shrink) ||
    shrink.lockfileVersion !== 3 ||
    shrink.packages?.['']?.dependencies?.['@grpc/grpc-js'] !== GRPC_JS_VERSION ||
    shrink.packages?.['']?.dependencies?.['@grpc/proto-loader'] !== PROTO_LOADER_VERSION
  ) {
    fail('profile_invalid', 'The callback shrinkwrap does not pin the exact gRPC dependencies.');
  }
  return { packageJson: pkg, shrinkwrap: shrink };
}

function installedVersion(profileDir, name) {
  const pkg = readJsonFile(
    path.join(profileDir, 'node_modules', ...name.split('/'), 'package.json'),
    `installed ${name} package.json`
  );
  return pkg.version;
}

function assertCallbackProfileInstalled({ profileDir }) {
  const profile = assertAbsolutePath(profileDir, 'profileDir');
  assertProfileManifests(profile);
  const runtimeFile = path.join(profile, 'callback-runtime.cjs');
  const protoFile = path.join(profile, 'vendor', 'iron-transform.proto');
  const policyFile = path.join(profile, 'vendor', 'network-policy.cjs');
  for (const file of [runtimeFile, protoFile, policyFile]) {
    let stat;
    try {
      stat = fs.lstatSync(file);
    } catch {
      fail('profile_incomplete', 'The callback profile is incomplete.');
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail('profile_incomplete', 'The callback profile contains an unsafe file.');
    }
  }
  const grpcJs = installedVersion(profile, '@grpc/grpc-js');
  const protoLoader = installedVersion(profile, '@grpc/proto-loader');
  if (grpcJs !== GRPC_JS_VERSION || protoLoader !== PROTO_LOADER_VERSION) {
    fail('profile_version_mismatch', 'The installed callback dependencies are not the pinned versions.');
  }
  return {
    profileDir: profile,
    callbackRuntime: runtimeFile,
    protoFile,
    policyFile,
    grpcJs,
    protoLoader,
  };
}

async function installCallbackProfile({
  sourceRoot,
  profileDir,
  npmPath = 'npm',
  run,
  signal,
  env,
}) {
  const profile = assertAbsolutePath(profileDir, 'profileDir');
  await stageCallbackProfile({ sourceRoot, profileDir: profile, signal });
  assertProfileManifests(profile);
  const args = [
    'ci',
    '--ignore-scripts',
    '--omit=dev',
    '--no-audit',
    '--no-fund',
  ];
  const commandEnv = {
    PATH: env?.PATH ?? process.env.PATH ?? '/usr/bin:/bin',
    HOME: env?.HOME ?? profile,
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_IGNORE_SCRIPTS: 'true',
    NPM_CONFIG_CACHE: path.join(profile, '.npm-cache'),
  };
  if (run) {
    await run({
      command: npmPath,
      args,
      cwd: profile,
      env: commandEnv,
      signal,
    });
  } else {
    await new Promise((resolve, reject) => {
      const child = spawn(npmPath, args, {
        cwd: profile,
        env: commandEnv,
        stdio: 'ignore',
      });
      const abort = () => child.kill('SIGTERM');
      signal?.addEventListener('abort', abort, { once: true });
      child.once('error', (error) => {
        signal?.removeEventListener('abort', abort);
        reject(error);
      });
      child.once('exit', (code, signalName) => {
        signal?.removeEventListener('abort', abort);
        if (code === 0) resolve();
        else
          reject(
            new IronError(
              'npm_install_failed',
              `Callback dependency installation failed (${signalName ?? code}).`
            )
          );
      });
    });
  }
  return assertCallbackProfileInstalled({ profileDir: profile });
}

class IronLifecycle {
  constructor(options) {
    this.options = validateLaunchOptions(options);
    this.phase = 'idle';
    this.reason = 'not-started';
    this.updatedAt = new Date().toISOString();
    this.launchId = null;
    this.launchEpoch = 0;
    this.pid = null;
    this.dir = null;
    this.grantExpiresAt = null;
    this.startedAt = null;
    this.retryRequired = false;
    this.fenceCount = 0;
    this.resources = new Set();
    this.callback = null;
    this.iron = null;
    this.ingressHandle = null;
    this.closing = false;
    this.closePromise = null;
    this.teardownPromise = null;
  }

  status() {
    // Fixed codes only. No callback/metrics addresses, no process output, no
    // keys, no request bodies, no CA paths.
    return {
      phase: this.phase,
      reason: this.reason,
      updatedAt: this.updatedAt,
      launchId: this.launchId,
      pid: this.pid,
      retryRequired: this.retryRequired,
      fenceCount: this.fenceCount,
      resources: this.resources.size,
      grantExpiresAt: this.grantExpiresAt,
    };
  }

  ingress() {
    // Only the intended Iron proxy bridge is public. The callback and metrics
    // listeners are never returned to a caller or guest.
    return this.ingressHandle;
  }

  healthy() {
    return (
      !this.closing &&
      this.phase === 'ready' &&
      this.iron?.healthy() === true &&
      this.callback?.healthy() === true &&
      (this.ingressHandle?.healthy?.() ?? true) !== false
    );
  }

  async start() {
    if (this.closing) fail('closed', 'The Iron lifecycle is closing.');
    if (this.retryRequired) {
      fail('restart_required', 'A fault requires an explicit restart.');
    }
    if (this.phase !== 'idle') {
      fail('already_started', 'Use restart() for an explicit new launch.');
    }
    await this.#launch('initial-start');
    return this.status();
  }

  async restart() {
    if (this.closing) fail('closed', 'The Iron lifecycle is closing.');
    if (this.phase === 'idle') {
      fail('not_started', 'The Iron lifecycle has not started.');
    }
    this.retryRequired = false;
    this.phase = 'restarting';
    this.reason = 'explicit-restart';
    this.updatedAt = new Date().toISOString();
    this.fenceCount += 1;
    try {
      this.options.relay.fence();
    } catch {}
    await this.#teardown();
    this.phase = 'starting';
    this.reason = 'explicit-restart';
    this.updatedAt = new Date().toISOString();
    await this.#launch('explicit-restart');
    return this.status();
  }

  async stop() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.phase = 'stopping';
    this.reason = 'environment-stopped';
    this.updatedAt = new Date().toISOString();
    this.fenceCount += 1;
    try {
      this.options.relay.fence();
    } catch {}
    this.closePromise = (async () => {
      await this.#teardown();
      try {
        await this.options.relay.close?.();
      } catch {}
      this.phase = 'stopped';
      this.reason = 'environment-stopped';
      this.retryRequired = false;
      this.updatedAt = new Date().toISOString();
    })();
    return this.closePromise;
  }

  #fault(reason, detail, epoch) {
    if (
      this.closing ||
      epoch !== this.launchEpoch ||
      this.phase === 'offline' ||
      this.phase === 'stopping' ||
      this.phase === 'stopped'
    ) {
      return;
    }
    this.retryRequired = true;
    this.phase = 'offline';
    this.reason = reason;
    this.updatedAt = new Date().toISOString();
    this.fenceCount += 1;
    // Synchronous fence before any await: established streams must not survive
    // either an Iron exit or a callback fault/expiry.
    try {
      this.options.relay.fence();
    } catch {}
    const ingress = this.ingressHandle;
    this.ingressHandle = null;
    if (ingress) {
      try {
        Promise.resolve(ingress.close()).catch(() => {});
      } catch {}
    }
    this.#teardown().catch(() => {});
  }

  #teardown() {
    if (this.teardownPromise) return this.teardownPromise;
    this.teardownPromise = (async () => {
      const handles = [...this.resources].reverse();
      this.resources.clear();
      for (const handle of handles) {
        try {
          await handle.close?.();
        } catch {}
      }
      this.callback = null;
      this.iron = null;
      this.ingressHandle = null;
      this.pid = null;
      if (this.dir) {
        const directory = this.dir;
        this.dir = null;
        await fsp.rm(directory, { recursive: true, force: true }).catch(() => {});
      }
    })().finally(() => {
      this.teardownPromise = null;
    });
    return this.teardownPromise;
  }

  async #launch(reason) {
    const epoch = ++this.launchEpoch;
    const launchId = crypto.randomUUID();
    this.launchId = launchId;
    this.dir = path.join(
      this.options.stateDir,
      'iron',
      this.options.environmentId,
      launchId
    );
    this.phase = 'starting';
    this.reason = reason;
    this.updatedAt = new Date().toISOString();
    const helpers = loadHelpers(this.options);
    const signal = this.options.signal;
    const directory = this.dir;
    try {
      signal?.throwIfAborted();
      helpers.privateDirectory(directory);
      await verifyIronBinary(
        this.options.ironBinary,
        this.options.ironSha256
      );
      signal?.throwIfAborted();

      let proxyPort;
      if (this.options.network?.prepare) {
        const prepared = await this.options.network.prepare({
          directory,
          environmentId: this.options.environmentId,
          connector: this.options.connector,
          signal,
        });
        proxyPort = prepared?.proxyPort;
        assertPort(proxyPort, 'Proxy port');
      } else {
        proxyPort = await helpers.findFreePort();
      }
      await helpers.assertPortFree(proxyPort);
      signal?.throwIfAborted();

      const ca = await helpers.ensureCA(path.join(directory, 'ca'), { signal });
      if (
        !ca ||
        typeof ca.caFile !== 'string' ||
        typeof ca.keyFile !== 'string'
      ) {
        fail('ca_invalid', 'The host certificate authority is invalid.');
      }
      signal?.throwIfAborted();

      if (this.options.network?.configureRoute) {
        await this.options.network.configureRoute({
          address: this.options.connector.address,
          port: this.options.connector.port,
          proxyPort,
          environmentId: this.options.environmentId,
          directory,
          signal,
        });
      }
      signal?.throwIfAborted();

      const now = this.options.now();
      const grant = validateGrant({
        environmentId: this.options.environmentId,
        scheme: 'http',
        host: this.options.connector.address,
        port: this.options.connector.port,
        method: 'POST',
        pathname: GRANT_PATH,
        expiresAt: now + this.options.grantMs,
        model: this.options.model,
      });
      this.grantExpiresAt = grant.expiresAt;

      const callback = await startCallback(
        this.options,
        grant,
        directory,
        signal,
        (callbackReason) =>
          this.#fault(
            callbackReason === 'grant-expired'
              ? 'grant-expired'
              : 'callback-fault',
            callbackReason,
            epoch
          )
      );
      if (epoch !== this.launchEpoch) {
        await callback.close?.();
        fail('aborted', 'The Iron launch was superseded.');
      }
      this.callback = callback;
      this.resources.add(callback);
      signal?.throwIfAborted();
      if (callback.healthy() !== true) {
        fail('callback_unhealthy', 'The callback is not healthy.');
      }
      if (typeof callback.ready === 'function') {
        await callback.ready();
      } else {
        const { port: callbackPort } = parseLoopbackAddress(callback.address);
        await waitUntil(
          () =>
            helpers
              .probe('127.0.0.1', callbackPort, 200)
              .then(() => true, () => false),
          this.options.startTimeoutMs,
          signal,
          'The callback'
        );
      }
      signal?.throwIfAborted();

      const ironConfig = buildIronConfig({
        proxyPort,
        callbackAddress: callback.address,
        caFile: ca.caFile,
        keyFile: ca.keyFile,
      });
      const configFile = path.join(directory, 'iron.json');
      writePrivateJson(configFile, ironConfig);

      const iron = await helpers.startOwnedProcess({
        binary: this.options.ironBinary,
        args: ['-config', configFile],
        env: { PATH: '/usr/bin:/bin', HOME: directory },
        signal,
        onExit: () => {
          if (
            epoch === this.launchEpoch &&
            !this.closing &&
            this.phase !== 'restarting' &&
            this.phase !== 'stopping' &&
            this.phase !== 'stopped'
          ) {
            this.#fault('iron-fault', 'process-exited', epoch);
          }
        },
      });
      if (epoch !== this.launchEpoch) {
        await iron.close?.();
        fail('aborted', 'The Iron launch was superseded.');
      }
      this.iron = iron;
      this.pid = iron.pid ?? null;
      this.resources.add(iron);
      signal?.throwIfAborted();
      await waitUntil(
        async () => {
          if (iron.healthy() !== true) return false;
          return helpers
            .probe('127.0.0.1', proxyPort, 200)
            .then(() => true, () => false);
        },
        this.options.startTimeoutMs,
        signal,
        'Iron'
      );
      signal?.throwIfAborted();

      let ingress;
      if (this.options.network?.openIngress) {
        ingress = await this.options.network.openIngress({
          proxyPort,
          environmentId: this.options.environmentId,
          directory,
          signal,
        });
      } else {
        ingress = {
          port: proxyPort,
          target: 'iron-proxy',
          healthy: () => true,
          close: async () => {},
        };
      }
      if (!ingress || typeof ingress.close !== 'function') {
        fail('ingress_invalid', 'The private Iron ingress bridge is invalid.');
      }
      this.ingressHandle = ingress;
      this.resources.add(ingress);
      this.phase = 'ready';
      this.reason = reason;
      this.startedAt = new Date().toISOString();
      this.retryRequired = false;
      this.updatedAt = this.startedAt;
    } catch (error) {
      if (epoch === this.launchEpoch) {
        this.retryRequired = true;
        this.phase = 'offline';
        this.reason =
          error && typeof error.code === 'string'
            ? error.code
            : 'launch-failed';
        this.updatedAt = new Date().toISOString();
        this.fenceCount += 1;
        try {
          this.options.relay.fence();
        } catch {}
        await this.#teardown();
      }
      throw error;
    }
  }
}

function createIronLifecycle(options) {
  return new IronLifecycle(options);
}

module.exports = {
  IronError,
  IronLifecycle,
  createIronLifecycle,
  IRON_VERSION,
  IRON_SHA256,
  GRPC_JS_VERSION,
  PROTO_LOADER_VERSION,
  GRANT_PATH,
  DEFAULT_GRANT_MS,
  MAX_GRANT_MS,
  CANONICAL_FILES,
  validateLaunchOptions,
  validateGrant,
  buildIronConfig,
  verifyIronBinary,
  stageCallbackProfile,
  installCallbackProfile,
  assertCallbackProfileInstalled,
  startCallbackProcess,
};
