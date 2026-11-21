'use strict';

// Standalone stock Iron v0.56.0 gRPC policy callback.
//
// This file is the optional private profile. It is intentionally separate from
// the control package so the control package never loads @grpc/*. Production
// wiring:
//
//   node profiles/iron-callback/callback-runtime.cjs --config <private-json>
//
// The control lifecycle writes that private JSON (mode 0600) and reads a single
// IPC readiness message. The profile must have been installed explicitly with
// iron.installCallbackProfile(), which runs npm ci --ignore-scripts and stages
// the canonical policy helpers and protocol next to this file under vendor/.
//
// The callback binds host loopback only. It is never exposed to the guest. It
// allows exactly one fixed request shape and rejects everything else.

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

const GRANT_PATH = '/v1/chat/completions';
const MAX_GRANT_MS = 60 * 60 * 1000;
const MAX_CONFIG_BYTES = 64 * 1024;
const CONFIG_KEYS = new Set([
  'version',
  'environmentId',
  'grant',
  'timeoutMs',
  'maxPending',
  'host',
  'port',
]);
const GRANT_KEYS = new Set([
  'environmentId',
  'scheme',
  'host',
  'port',
  'method',
  'pathname',
  'expiresAt',
  'model',
]);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function assertKeys(object, allowed, label) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) {
    fail('config_invalid', `${label} must be an object.`);
  }
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      fail('config_invalid', `${label} contains an unexpected field.`);
    }
  }
}

function assertSafeId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) {
    fail('config_invalid', 'The environment identifier is invalid.');
  }
  return value;
}

function assertPort(value, label, allowZero) {
  if (
    !Number.isInteger(value) ||
    value < (allowZero ? 0 : 1) ||
    value > 65535
  ) {
    fail('config_invalid', `${label} is not a valid TCP port.`);
  }
  return value;
}

function assertIPv4(value, label) {
  if (typeof value !== 'string' || !net.isIPv4(value)) {
    fail('config_invalid', `${label} must be an IPv4 literal.`);
  }
  if (value === '0.0.0.0' || value === '255.255.255.255') {
    fail('config_invalid', `${label} is not a usable unicast address.`);
  }
  const first = Number(value.split('.')[0]);
  if (first >= 224 && first <= 239) {
    fail('config_invalid', `${label} is not a usable unicast address.`);
  }
  return value;
}

function assertModel(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 200 ||
    /[\x00-\x1f\x7f]/.test(value)
  ) {
    fail('config_invalid', 'The model identifier is invalid.');
  }
  return value;
}

function validateGrant(grant, now) {
  assertKeys(grant, GRANT_KEYS, 'The policy grant');
  assertSafeId(grant.environmentId);
  if (grant.scheme !== 'http') {
    fail('config_invalid', 'The policy grant must use plain HTTP inside the relay.');
  }
  assertIPv4(grant.host, 'The policy grant host');
  assertPort(grant.port, 'The policy grant port', false);
  if (grant.method !== 'POST') {
    fail('config_invalid', 'The policy grant must be a POST request.');
  }
  if (grant.pathname !== GRANT_PATH) {
    fail('config_invalid', 'The policy grant path is not the single model endpoint.');
  }
  if (!Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= now) {
    fail('config_invalid', 'The policy grant is already expired.');
  }
  if (grant.expiresAt - now > MAX_GRANT_MS) {
    fail('config_invalid', 'The policy grant expiry exceeds the allowed bound.');
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

function validateCallbackConfig(input, now = Date.now()) {
  assertKeys(input, CONFIG_KEYS, 'The callback configuration');
  if (input.version !== 1) {
    fail('config_invalid', 'The callback configuration version is unsupported.');
  }
  const environmentId = assertSafeId(input.environmentId);
  const grant = validateGrant(input.grant, now);
  if (grant.environmentId !== environmentId) {
    fail('config_invalid', 'The policy grant environment does not match the callback.');
  }
  if (
    !Number.isInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    input.timeoutMs > 60_000
  ) {
    fail('config_invalid', 'The callback timeout is invalid.');
  }
  if (
    !Number.isInteger(input.maxPending) ||
    input.maxPending < 1 ||
    input.maxPending > 256
  ) {
    fail('config_invalid', 'The callback pending bound is invalid.');
  }
  if (input.host !== '127.0.0.1') {
    fail('config_invalid', 'The callback must bind host loopback only.');
  }
  assertPort(input.port, 'The callback port', true);
  return {
    version: 1,
    environmentId,
    grant,
    timeoutMs: input.timeoutMs,
    maxPending: input.maxPending,
    host: input.host,
    port: input.port,
  };
}

function loadPolicyHelpers() {
  try {
    // Relative to the installed optional private package, never to a source
    // checkout. The coordinator stages this file by value at install time.
    return require('./vendor/network-policy.cjs');
  } catch {
    const error = new Error(
      'Canonical policy helpers are not staged in the callback profile.'
    );
    error.code = 'policy_helpers_missing';
    throw error;
  }
}

function ruleFor(grant) {
  return {
    id: '00000000-0000-4000-8000-000000000000',
    environmentId: grant.environmentId,
    scheme: 'http',
    host: grant.host,
    port: grant.port,
    method: grant.method,
    pathname: grant.pathname,
    expiresAt: grant.expiresAt,
    action: 'allow',
  };
}

function evaluateRequest(config, request, context = {}, now = Date.now(), helpers) {
  if (!Number.isSafeInteger(now) || now >= config.grant.expiresAt) return false;
  const policy = helpers ?? loadPolicyHelpers();
  let destination;
  try {
    destination = policy.normalizeRequest(request, context);
  } catch {
    return false;
  }
  if (destination.scheme !== 'http') return false;
  return policy.matches(ruleFor(config.grant), destination) === true;
}

function send(message) {
  if (process.connected) {
    try {
      process.send(message);
    } catch {}
  }
}

function readConfig(configPath) {
  if (typeof configPath !== 'string' || configPath.length === 0) {
    fail('config_invalid', 'A callback configuration path is required.');
  }
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch {
    fail('config_invalid', 'The callback configuration is missing.');
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_CONFIG_BYTES) {
    fail('config_invalid', 'The callback configuration is too large.');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail('config_invalid', 'The callback configuration is not valid JSON.');
  }
  return validateCallbackConfig(parsed);
}

function main() {
  const args = process.argv.slice(2);
  let configPath;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--config') {
      configPath = args[index + 1];
      index += 1;
    } else if (configPath === undefined) {
      configPath = args[index];
    }
  }
  let config;
  try {
    config = readConfig(configPath);
  } catch (error) {
    send({ type: 'error', code: error.code ?? 'config_invalid' });
    process.exitCode = 2;
    return;
  }

  let grpc;
  let loader;
  try {
    grpc = require('@grpc/grpc-js');
    loader = require('@grpc/proto-loader');
  } catch {
    send({ type: 'error', code: 'grpc_dependencies_missing' });
    process.exitCode = 2;
    return;
  }

  let proto;
  try {
    proto = grpc.loadPackageDefinition(
      loader.loadSync(path.join(__dirname, 'vendor', 'iron-transform.proto'), {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
      })
    ).transform.v1;
  } catch {
    send({ type: 'error', code: 'proto_missing' });
    process.exitCode = 2;
    return;
  }

  let closed = false;
  const server = new grpc.Server({
    'grpc.max_receive_message_length': 256 * 1024,
  });
  const reject = (statusCode) => ({ action: 2, response: { status_code: statusCode } });

  const shutdown = () => {
    if (closed) return;
    closed = true;
    try {
      server.forceShutdown();
    } catch {}
  };

  server.addService(proto.TransformService.service, {
    transformRequest(call, done) {
      if (closed || Date.now() >= config.grant.expiresAt) {
        return done(null, reject(403));
      }
      const allowed = evaluateRequest(
        config,
        call.request.request,
        call.request.context,
        Date.now()
      );
      return done(null, allowed ? { action: 1 } : reject(403));
    },
    transformResponse(_call, done) {
      done(null, { action: 1 });
    },
  });

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  process.once('disconnect', shutdown);

  server.bindAsync(
    `${config.host}:${config.port}`,
    grpc.ServerCredentials.createInsecure(),
    (error, port) => {
      if (error) {
        send({ type: 'error', code: 'callback_bind_failed' });
        process.exitCode = 2;
        return;
      }
      if (closed) {
        try {
          server.forceShutdown();
        } catch {}
        return;
      }
      send({ type: 'ready', port });
      const remaining = Math.max(1, config.grant.expiresAt - Date.now());
      const timer = setTimeout(() => {
        shutdown();
        process.exit(0);
      }, Math.min(remaining, 2_147_483_647));
      timer.unref?.();
    }
  );
}

if (require.main === module) main();

module.exports = {
  GRANT_PATH,
  MAX_GRANT_MS,
  validateCallbackConfig,
  validateGrant,
  evaluateRequest,
  ruleFor,
  loadPolicyHelpers,
};
