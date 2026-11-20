'use strict';

/**
 * RELAY-1: one launch-specific local inference relay.
 *
 * The relay exposes exactly one HTTP endpoint on a private Unix domain socket:
 *   POST /v1/chat/completions
 *
 * It forwards to one operator-supplied, fixed upstream origin whose host is an
 * IP literal and whose path is exactly /v1/chat/completions. Requests cannot
 * choose an upstream, a redirect target or arbitrary headers. Credentials are
 * read from an explicitly configured systemd credential directory and are only
 * attached after the destination has been validated as the fixed trusted
 * origin. Upstream response data and errors pass through the shared incremental
 * SecretRedactor before reaching the guest. The relay never follows redirects.
 *
 * The relay is denied by default. A supervisor enables it with allow() only for
 * the current launch generation and only after Iron and the callback are ready.
 * fence() aborts every in-flight upstream socket and response stream immediately
 * and denies further requests. close() fences, stops the listener and removes
 * only the Unix socket this instance created.
 */

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');

const MODEL_RELAY_ENDPOINT = '/v1/chat/completions';
const DEFAULT_REDACTOR_PATH = path.join(
  __dirname,
  '..',
  'shared',
  'secret-redactor.cjs'
);
const MAX_SOCKET_PATH_BYTES = 100;
const MAX_CREDENTIAL_BYTES = 8192;
const MAX_ID_LENGTH = 128;
const MAX_MODEL_LENGTH = 256;
const MAX_REASON_LENGTH = 64;
const CREDENTIAL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
const SECRET_PATTERN = /^[\x21-\x7e]+$/;
const GENERATION_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

const DEFAULT_LIMITS = Object.freeze({
  maxBodyBytes: 4 * 1024 * 1024,
  maxResponseBytes: 64 * 1024 * 1024,
  maxHeaderBytes: 16 * 1024,
  maxHeadersCount: 64,
  maxUrlBytes: 2048,
  maxInboundRequests: 16,
  maxPendingBodies: 8,
  requestTimeoutMs: 300_000,
  bodyTimeoutMs: 30_000,
  upstreamIdleTimeoutMs: 60_000,
  upstreamConnectTimeoutMs: 10_000,
});

const ERROR_MESSAGES = Object.freeze({
  bad_request: 'Malformed request.',
  body_timeout: 'Request body deadline exceeded.',
  body_too_large: 'Request body is too large.',
  inference_busy: 'Inference capacity is exhausted.',
  invalid_json: 'Request body is not valid JSON.',
  invalid_model: 'Request model is not allowed.',
  method_not_allowed: 'Only POST is supported.',
  not_found: 'Endpoint not found.',
  relay_closed: 'Relay is closed.',
  relay_disabled: 'Relay is not enabled.',
  relay_fenced: 'Relay is fenced.',
  request_timeout: 'Request deadline exceeded.',
  response_too_large: 'Upstream response is too large.',
  too_many_pending: 'Too many incomplete request bodies.',
  too_many_requests: 'Too many concurrent requests.',
  unsupported_content_type: 'Only application/json is accepted.',
  upstream_content_type: 'Upstream response type is not supported.',
  upstream_error: 'Upstream inference request failed.',
  upstream_redirect: 'Upstream redirects are not allowed.',
  upstream_timeout: 'Upstream inference request timed out.',
});

class ModelRelayError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'ModelRelayError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ModelRelayError(code, message);
}

function isBoundedString(value, max) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function validateGeneration(value) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (isBoundedString(value, 64) && GENERATION_PATTERN.test(value)) return value;
  fail('invalid_generation', 'Launch generation must be a positive integer or token.');
}

function validateId(value, label) {
  if (!isBoundedString(value, MAX_ID_LENGTH)) {
    fail(`invalid_${label}`, `${label} is invalid.`);
  }
  return value;
}

function normalizeUpstreamHost(value) {
  if (!isBoundedString(value, 255)) return null;
  let host = value;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!host.length || host.includes('%') || net.isIP(host) === 0) return null;
  // An unspecified address is not a fixed destination.
  if (host === '0.0.0.0' || host === '::') return null;
  return host;
}

function validateUpstream(upstream) {
  if (
    !upstream ||
    typeof upstream !== 'object' ||
    Array.isArray(upstream)
  ) {
    fail('invalid_upstream', 'Upstream destination is required.');
  }
  const keys = Object.keys(upstream);
  for (const key of keys) {
    if (key !== 'scheme' && key !== 'host' && key !== 'port') {
      fail('invalid_upstream', 'Upstream destination has unsupported fields.');
    }
  }
  if (upstream.scheme !== 'http' && upstream.scheme !== 'https') {
    fail('invalid_upstream', 'Upstream scheme must be http or https.');
  }
  const host = normalizeUpstreamHost(upstream.host);
  if (!host) {
    fail('invalid_upstream', 'Upstream host must be an IP literal.');
  }
  const port = upstream.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail('invalid_upstream', 'Upstream port is invalid.');
  }
  return Object.freeze({
    scheme: upstream.scheme,
    host,
    port,
    path: MODEL_RELAY_ENDPOINT,
  });
}

function validateCredential(credential) {
  if (credential === null || credential === undefined) return null;
  if (
    typeof credential !== 'object' ||
    Array.isArray(credential)
  ) {
    fail('invalid_credential', 'Credential reference is invalid.');
  }
  for (const key of Object.keys(credential)) {
    if (key !== 'directory' && key !== 'name') {
      fail('invalid_credential', 'Credential reference has unsupported fields.');
    }
  }
  const directory = credential.directory;
  if (
    typeof directory !== 'string' ||
    directory.length === 0 ||
    directory.length > 4096 ||
    !path.isAbsolute(directory) ||
    /[\u0000-\u001f\u007f]/.test(directory)
  ) {
    fail('invalid_credential', 'Credential directory must be an absolute path.');
  }
  const name = credential.name;
  if (
    typeof name !== 'string' ||
    !CREDENTIAL_NAME_PATTERN.test(name) ||
    name === '.' ||
    name === '..'
  ) {
    fail('invalid_credential', 'Credential name is invalid.');
  }
  return Object.freeze({ directory, name });
}

function validateLimitInteger(limits, key, min, max) {
  const value = limits[key];
  if (!Number.isInteger(value) || value < min || value > max) {
    fail('invalid_limits', `Limit ${key} is invalid.`);
  }
}

function validateLimits(limits) {
  if (limits === undefined) limits = {};
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) {
    fail('invalid_limits', 'Limits must be an object.');
  }
  const merged = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(limits)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_LIMITS, key)) {
      fail('invalid_limits', 'Limits contain an unsupported field.');
    }
    merged[key] = limits[key];
  }
  validateLimitInteger(merged, 'maxBodyBytes', 1, 64 * 1024 * 1024);
  validateLimitInteger(merged, 'maxResponseBytes', 1, 256 * 1024 * 1024);
  validateLimitInteger(merged, 'maxHeaderBytes', 1024, 64 * 1024);
  validateLimitInteger(merged, 'maxHeadersCount', 1, 1024);
  validateLimitInteger(merged, 'maxUrlBytes', 1, 8192);
  validateLimitInteger(merged, 'maxInboundRequests', 1, 1024);
  validateLimitInteger(merged, 'maxPendingBodies', 1, 1024);
  validateLimitInteger(merged, 'requestTimeoutMs', 10, 3_600_000);
  validateLimitInteger(merged, 'bodyTimeoutMs', 10, 600_000);
  validateLimitInteger(merged, 'upstreamIdleTimeoutMs', 10, 600_000);
  validateLimitInteger(merged, 'upstreamConnectTimeoutMs', 10, 600_000);
  return Object.freeze(merged);
}

function createInferencePool({ maxConcurrent = 4 } = {}) {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 1024) {
    fail('invalid_pool', 'Inference pool capacity is invalid.');
  }
  let active = 0;
  return Object.freeze({
    maxConcurrent,
    tryAcquire() {
      if (active >= maxConcurrent) return false;
      active += 1;
      return true;
    },
    release() {
      if (active > 0) active -= 1;
    },
    get active() {
      return active;
    },
  });
}

const defaultInferencePool = createInferencePool({ maxConcurrent: 4 });

function validatePool(pool) {
  if (pool === undefined) return defaultInferencePool;
  if (
    !pool ||
    typeof pool !== 'object' ||
    typeof pool.tryAcquire !== 'function' ||
    typeof pool.release !== 'function' ||
    !Number.isInteger(pool.maxConcurrent) ||
    pool.maxConcurrent < 1
  ) {
    fail('invalid_pool', 'Inference pool is invalid.');
  }
  return pool;
}

function validateSocketPath(socketPath) {
  if (
    typeof socketPath !== 'string' ||
    !path.isAbsolute(socketPath) ||
    Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES ||
    /[\u0000-\u001f\u007f]/.test(socketPath)
  ) {
    fail('invalid_socket', 'Socket path is invalid.');
  }
  const parent = path.dirname(socketPath);
  let stat;
  try {
    stat = fs.lstatSync(parent);
  } catch {
    fail('invalid_socket', 'Socket parent directory does not exist.');
  }
  if (!stat.isDirectory()) {
    fail('invalid_socket', 'Socket parent is not a directory.');
  }
  if ((stat.mode & 0o077) !== 0) {
    fail('insecure_socket_parent', 'Socket parent directory must be private.');
  }
  try {
    fs.lstatSync(socketPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    fail('invalid_socket', 'Socket path could not be inspected.');
  }
  fail('socket_exists', 'Socket path already exists.');
}

function loadSecretRedactor(redactorPath) {
  const modulePath = redactorPath === undefined
    ? DEFAULT_REDACTOR_PATH
    : redactorPath;
  if (
    typeof modulePath !== 'string' ||
    !path.isAbsolute(modulePath) ||
    /[\u0000-\u001f\u007f]/.test(modulePath)
  ) {
    fail('invalid_redactor', 'Secret redactor path is invalid.');
  }
  let loaded;
  try {
    loaded = require(modulePath);
  } catch {
    fail('invalid_redactor', 'Secret redactor could not be loaded.');
  }
  if (!loaded || typeof loaded.SecretRedactor !== 'function') {
    fail('invalid_redactor', 'Secret redactor module is invalid.');
  }
  return loaded.SecretRedactor;
}

async function readCredential(credential) {
  if (!credential) return null;
  let directoryStat;
  try {
    directoryStat = await fs.promises.lstat(credential.directory);
  } catch {
    fail('credential_unavailable', 'Credential directory is unavailable.');
  }
  if (!directoryStat.isDirectory()) {
    fail('credential_unavailable', 'Credential directory is invalid.');
  }
  if ((directoryStat.mode & 0o077) !== 0) {
    fail('credential_unavailable', 'Credential directory must be private.');
  }
  const credentialPath = path.join(credential.directory, credential.name);
  let handle;
  try {
    handle = await fs.promises.open(
      credentialPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
  } catch {
    fail('credential_unavailable', 'Credential is unavailable.');
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      fail('credential_unavailable', 'Credential is not a regular file.');
    }
    if ((stat.mode & 0o077) !== 0) {
      fail('credential_unavailable', 'Credential file must be private.');
    }
    if (stat.size < 1 || stat.size > MAX_CREDENTIAL_BYTES) {
      fail('credential_unavailable', 'Credential size is invalid.');
    }
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        stat.size - offset,
        offset
      );
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) {
      fail('credential_unavailable', 'Credential could not be read completely.');
    }
    let secret = buffer.toString('utf8');
    if (secret.endsWith('\n')) secret = secret.slice(0, -1);
    if (secret.endsWith('\r')) secret = secret.slice(0, -1);
    if (!secret.length || !SECRET_PATTERN.test(secret)) {
      fail('credential_unavailable', 'Credential content is invalid.');
    }
    return secret;
  } finally {
    await handle.close();
  }
}

function sanitizeReason(reason) {
  if (
    typeof reason === 'string' &&
    reason.length > 0 &&
    reason.length <= MAX_REASON_LENGTH &&
    /^[a-z0-9_-]+$/.test(reason)
  ) {
    return reason;
  }
  return 'fenced';
}

function sendError(res, status, code) {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  const body = Buffer.from(
    JSON.stringify({
      error: {
        code,
        message: ERROR_MESSAGES[code] || 'Request failed.',
      },
    })
  );
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('content-length', body.length);
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(body);
}

function parseContentType(value) {
  if (typeof value !== 'string') return null;
  const type = value.split(';', 1)[0].trim().toLowerCase();
  if (type === 'text/event-stream' || type === 'application/json') return type;
  return null;
}

function isJsonContentType(value) {
  if (typeof value !== 'string') return false;
  return /^application\/json(?:\s*;|$)/i.test(value.trim());
}

function headerBytes(req) {
  let total = 0;
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    total += Buffer.byteLength(req.rawHeaders[index]);
    total += Buffer.byteLength(req.rawHeaders[index + 1] || '');
    total += 4;
  }
  return total;
}

// Rejected requests must not be allowed to stream an unbounded body. Drain at
// most one configured request body, then destroy the socket.
function drainRejected(req, maxBytes) {
  let bytes = 0;
  req.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > maxBytes) req.destroy();
  });
  req.on('error', () => {});
  req.resume();
}

const ALLOWED_OPTIONS = new Set([
  'socketPath',
  'projectId',
  'sandboxId',
  'generation',
  'model',
  'upstream',
  'credential',
  'limits',
  'pool',
  'redactorPath',
]);

async function createModelRelay(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    fail('invalid_options', 'Relay options are required.');
  }
  for (const key of Object.keys(options)) {
    if (!ALLOWED_OPTIONS.has(key)) {
      fail('invalid_options', 'Relay options contain unsupported fields.');
    }
  }

  const socketPath = options.socketPath;
  const projectId = validateId(options.projectId, 'project_id');
  const sandboxId = validateId(options.sandboxId, 'sandbox_id');
  const generation = validateGeneration(options.generation);
  if (!isBoundedString(options.model, MAX_MODEL_LENGTH)) {
    fail('invalid_model', 'Selected model is invalid.');
  }
  const model = options.model;
  const upstream = validateUpstream(options.upstream);
  const credential = validateCredential(options.credential);
  const limits = validateLimits(options.limits);
  const pool = validatePool(options.pool);
  const SecretRedactor = loadSecretRedactor(options.redactorPath);

  validateSocketPath(socketPath);

  const state = {
    enabled: false,
    closed: false,
    fencedReason: null,
    secret: null,
    contexts: new Set(),
    sockets: new Set(),
    inboundActive: 0,
    pendingBodies: 0,
    activeInference: 0,
    socketDev: null,
    socketIno: null,
    epoch: 0,
    closePromise: null,
  };

  function finishEntry(context, abort) {
    const entry = context.entry;
    if (!entry || entry.done) return;
    entry.done = true;
    if (entry.connectTimer) {
      clearTimeout(entry.connectTimer);
      entry.connectTimer = null;
    }
    if (abort) {
      try { entry.controller.abort(); } catch {}
      if (entry.upstreamReq) entry.upstreamReq.destroy();
      if (entry.upstreamRes) entry.upstreamRes.destroy();
      if (entry.redactor) entry.redactor.destroy();
    }
    pool.release();
    state.activeInference = Math.max(0, state.activeInference - 1);
  }

  function finalize(context, abort) {
    if (context.settled) return;
    context.settled = true;
    if (context.requestTimer) {
      clearTimeout(context.requestTimer);
      context.requestTimer = null;
    }
    if (context.bodyTimer) {
      clearTimeout(context.bodyTimer);
      context.bodyTimer = null;
    }
    if (!context.bodyDone) {
      context.bodyDone = true;
      if (context.countedBody) state.pendingBodies -= 1;
    }
    finishEntry(context, abort);
    if (context.countedInbound) {
      context.countedInbound = false;
      state.inboundActive -= 1;
    }
    state.contexts.delete(context);
  }

  function abortContext(context) {
    if (context.settled) return;
    finishEntry(context, true);
    if (!context.req.destroyed) {
      context.req.destroy();
    }
    if (!context.res.writableEnded && !context.res.destroyed) {
      context.res.destroy();
    }
    finalize(context, true);
  }

  function failUpstream(context, code, status = 502) {
    if (context.settled) return;
    if (!context.res.headersSent) {
      sendError(context.res, status, code);
    } else if (!context.res.writableEnded && !context.res.destroyed) {
      context.res.destroy();
    }
    finalize(context, true);
  }

  function startUpstream(context, body, wantsStream) {
    const headers = {
      'content-type': 'application/json',
      accept: wantsStream ? 'text/event-stream' : 'application/json',
      'content-length': body.length,
    };
    // Credentials are attached only for the frozen, validated IP-literal
    // destination. There is no request-controlled routing input here.
    if (
      state.secret &&
      (upstream.scheme === 'http' || upstream.scheme === 'https') &&
      net.isIP(upstream.host) !== 0 &&
      upstream.path === MODEL_RELAY_ENDPOINT
    ) {
      headers.authorization = `Bearer ${state.secret}`;
    }

    const controller = new AbortController();
    const entry = {
      controller,
      upstreamReq: null,
      upstreamRes: null,
      redactor: null,
      connectTimer: null,
      done: false,
    };
    context.entry = entry;

    const transport = upstream.scheme === 'https' ? https : http;
    let upstreamReq;
    try {
      upstreamReq = transport.request({
        hostname: upstream.host,
        port: upstream.port,
        path: upstream.path,
        method: 'POST',
        headers,
        agent: false,
        maxHeaderSize: limits.maxHeaderBytes,
        timeout: limits.upstreamIdleTimeoutMs,
        signal: controller.signal,
      });
    } catch {
      failUpstream(context, 'upstream_error');
      return;
    }
    entry.upstreamReq = upstreamReq;

    entry.connectTimer = setTimeout(() => {
      failUpstream(context, 'upstream_timeout', 504);
    }, limits.upstreamConnectTimeoutMs);

    upstreamReq.on('timeout', () => {
      failUpstream(context, 'upstream_timeout', 504);
    });
    upstreamReq.on('error', () => {
      failUpstream(context, 'upstream_error');
    });
    upstreamReq.on('response', (upstreamRes) => {
      if (context.settled) {
        upstreamRes.destroy();
        return;
      }
      if (entry.connectTimer) {
        clearTimeout(entry.connectTimer);
        entry.connectTimer = null;
      }
      entry.upstreamRes = upstreamRes;

      if (upstreamRes.rawHeaders.length / 2 > limits.maxHeadersCount) {
        upstreamRes.resume();
        failUpstream(context, 'upstream_error');
        return;
      }

      const status = upstreamRes.statusCode || 0;
      if (status >= 300 && status < 400) {
        upstreamRes.resume();
        failUpstream(context, 'upstream_redirect');
        return;
      }
      if (status < 200 || status >= 300) {
        upstreamRes.resume();
        failUpstream(context, 'upstream_error');
        return;
      }

      const contentType = parseContentType(upstreamRes.headers['content-type']);
      if (!contentType) {
        upstreamRes.resume();
        failUpstream(context, 'upstream_content_type');
        return;
      }
      const contentEncoding = upstreamRes.headers['content-encoding'];
      if (
        contentEncoding !== undefined &&
        String(contentEncoding).trim().toLowerCase() !== 'identity'
      ) {
        // Redaction cannot be guaranteed over compressed bytes, and the relay
        // never forwards arbitrary encoding headers.
        upstreamRes.resume();
        failUpstream(context, 'upstream_content_type');
        return;
      }

      const declared = Number(upstreamRes.headers['content-length']);
      if (Number.isFinite(declared) && declared > limits.maxResponseBytes) {
        upstreamRes.resume();
        failUpstream(context, 'response_too_large');
        return;
      }

      const secrets = state.secret ? [state.secret] : [];
      let redactor;
      try {
        redactor = new SecretRedactor(secrets, {
          maxBytes: limits.maxResponseBytes,
        });
      } catch {
        upstreamRes.destroy();
        failUpstream(context, 'response_too_large');
        return;
      }
      entry.redactor = redactor;

      redactor.on('error', () => {
        upstreamRes.destroy();
        if (!context.res.headersSent) {
          sendError(context.res, 502, 'response_too_large');
        } else if (!context.res.writableEnded && !context.res.destroyed) {
          context.res.destroy();
        }
        finalize(context, true);
      });

      upstreamRes.on('error', () => {
        redactor.destroy();
        failUpstream(context, 'upstream_error');
      });
      upstreamRes.on('aborted', () => {
        redactor.destroy();
        failUpstream(context, 'upstream_error');
      });

      if (contentType === 'text/event-stream') {
        if (!context.res.headersSent) {
          context.res.statusCode = 200;
          context.res.setHeader('content-type', 'text/event-stream');
          context.res.setHeader('cache-control', 'no-store');
          context.res.setHeader('x-content-type-options', 'nosniff');
        }
        redactor.pipe(context.res);
        upstreamRes.pipe(redactor);
        return;
      }

      const chunks = [];
      redactor.on('data', (chunk) => chunks.push(chunk));
      redactor.on('end', () => {
        if (context.settled) return;
        const output = Buffer.concat(chunks);
        if (!context.res.headersSent) {
          context.res.statusCode = 200;
          context.res.setHeader('content-type', 'application/json');
          context.res.setHeader('content-length', output.length);
          context.res.setHeader('cache-control', 'no-store');
          context.res.setHeader('x-content-type-options', 'nosniff');
        }
        context.res.end(output);
        finalize(context, false);
      });
      upstreamRes.pipe(redactor);
    });

    try {
      upstreamReq.end(body);
    } catch {
      failUpstream(context, 'upstream_error');
    }
  }

  const server = http.createServer((req, res) => {
    if (state.closed) {
      sendError(res, 503, 'relay_closed');
      req.resume();
      return;
    }
    if (!state.enabled) {
      sendError(res, 503, state.fencedReason ? 'relay_fenced' : 'relay_disabled');
      req.resume();
      return;
    }
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      sendError(res, 405, 'method_not_allowed');
      req.resume();
      return;
    }
    if (req.url !== MODEL_RELAY_ENDPOINT) {
      sendError(res, 404, 'not_found');
      req.resume();
      return;
    }
    if (typeof req.url !== 'string' || Buffer.byteLength(req.url) > limits.maxUrlBytes) {
      sendError(res, 414, 'not_found');
      req.resume();
      return;
    }
    if (!isJsonContentType(req.headers['content-type'])) {
      sendError(res, 415, 'unsupported_content_type');
      req.resume();
      return;
    }
    if (headerBytes(req) > limits.maxHeaderBytes) {
      sendError(res, 431, 'bad_request');
      req.resume();
      return;
    }
    const contentLength = req.headers['content-length'];
    if (contentLength !== undefined) {
      if (!/^\d+$/.test(String(contentLength))) {
        sendError(res, 400, 'bad_request');
        req.resume();
        return;
      }
      if (Number(contentLength) > limits.maxBodyBytes) {
        sendError(res, 413, 'body_too_large');
        req.resume();
        return;
      }
    }
    if (state.inboundActive >= limits.maxInboundRequests) {
      sendError(res, 429, 'too_many_requests');
      req.resume();
      return;
    }
    if (state.pendingBodies >= limits.maxPendingBodies) {
      sendError(res, 429, 'too_many_pending');
      req.resume();
      return;
    }

    const context = {
      req,
      res,
      settled: false,
      bodyDone: false,
      countedBody: true,
      countedInbound: true,
      entry: null,
      requestTimer: null,
      bodyTimer: null,
    };
    state.inboundActive += 1;
    state.pendingBodies += 1;
    state.contexts.add(context);

    context.requestTimer = setTimeout(() => {
      if (context.settled) return;
      if (!context.res.headersSent) {
        sendError(context.res, 504, 'request_timeout');
      } else if (!context.res.writableEnded && !context.res.destroyed) {
        context.res.destroy();
      }
      finalize(context, true);
    }, limits.requestTimeoutMs);

    context.bodyTimer = setTimeout(() => {
      if (context.settled || context.bodyDone) return;
      sendError(context.res, 408, 'body_timeout');
      req.destroy();
      finalize(context, true);
    }, limits.bodyTimeoutMs);

    res.on('finish', () => finalize(context, false));
    res.on('close', () => {
      if (!context.settled) finalize(context, true);
    });

    const chunks = [];
    let bytes = 0;

    req.on('data', (chunk) => {
      if (context.settled || context.bodyDone) return;
      bytes += chunk.length;
      if (bytes > limits.maxBodyBytes) {
        sendError(context.res, 413, 'body_too_large');
        req.destroy();
        finalize(context, true);
        return;
      }
      chunks.push(chunk);
    });

    req.on('aborted', () => {
      finalize(context, true);
    });
    req.on('error', () => {
      finalize(context, true);
    });

    req.on('end', () => {
      if (context.settled || context.bodyDone) return;
      context.bodyDone = true;
      state.pendingBodies -= 1;
      context.countedBody = false;
      if (context.bodyTimer) {
        clearTimeout(context.bodyTimer);
        context.bodyTimer = null;
      }

      const raw = Buffer.concat(chunks);
      let parsed;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        sendError(context.res, 400, 'invalid_json');
        finalize(context, true);
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        sendError(context.res, 400, 'bad_request');
        finalize(context, true);
        return;
      }
      if (typeof parsed.model !== 'string' || parsed.model !== model) {
        sendError(context.res, 400, 'invalid_model');
        finalize(context, true);
        return;
      }
      if (parsed.stream !== undefined && typeof parsed.stream !== 'boolean') {
        sendError(context.res, 400, 'bad_request');
        finalize(context, true);
        return;
      }

      if (!pool.tryAcquire()) {
        sendError(context.res, 429, 'inference_busy');
        finalize(context, false);
        return;
      }
      state.activeInference += 1;
      startUpstream(context, raw, parsed.stream === true);
    });
  });

  server.maxHeadersCount = limits.maxHeadersCount;
  server.headersTimeout = limits.bodyTimeoutMs;
  server.requestTimeout = limits.requestTimeoutMs;
  server.on('error', () => {
    if (!state.closed) fence('listener_fault');
  });

  server.on('connection', (socket) => {
    state.sockets.add(socket);
    socket.on('close', () => state.sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    const onError = () => {
      server.removeListener('listening', onListening);
      reject(new ModelRelayError('socket_unavailable', 'Relay socket is unavailable.'));
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(socketPath);
  });

  try {
    fs.chmodSync(socketPath, 0o600);
    const socketStat = fs.lstatSync(socketPath);
    if (!socketStat.isSocket()) {
      throw new Error('not a socket');
    }
    state.socketDev = socketStat.dev;
    state.socketIno = socketStat.ino;
  } catch {
    await new Promise((resolve) => server.close(resolve));
    try {
      fs.unlinkSync(socketPath);
    } catch {}
    fail('socket_unavailable', 'Relay socket could not be secured.');
  }

  function cleanupSocket() {
    try {
      const stat = fs.lstatSync(socketPath);
      if (
        stat.isSocket() &&
        stat.dev === state.socketDev &&
        stat.ino === state.socketIno
      ) {
        fs.unlinkSync(socketPath);
      }
    } catch {}
  }

  function fence(reason) {
    if (state.closed) return;
    state.epoch += 1;
    state.enabled = false;
    state.fencedReason = sanitizeReason(reason);
    state.secret = null;
    for (const context of [...state.contexts]) {
      abortContext(context);
    }
  }

  async function allow({ generation: requestedGeneration, ironReady, callbackReady } = {}) {
    if (state.closed) {
      fail('relay_closed', 'Relay is closed.');
    }
    if (requestedGeneration !== generation) {
      fail('generation_mismatch', 'Launch generation does not match this relay.');
    }
    if (ironReady !== true || callbackReady !== true) {
      fail('not_ready', 'Iron and callback readiness are required.');
    }
    if (state.enabled) return;
    const epoch = state.epoch;
    const secret = await readCredential(credential);
    if (state.closed) {
      fail('relay_closed', 'Relay is closed.');
    }
    if (state.epoch !== epoch) {
      fail('relay_fenced', 'Relay was fenced while enabling.');
    }
    state.secret = secret;
    state.enabled = true;
    state.fencedReason = null;
  }

  function close() {
    if (state.closePromise) return state.closePromise;
    state.closePromise = (async () => {
      if (state.closed) return;
      state.closed = true;
      state.epoch += 1;
      state.enabled = false;
      state.fencedReason = 'closed';
      state.secret = null;
      for (const context of [...state.contexts]) {
        abortContext(context);
      }
      await new Promise((resolve) => {
        server.close(() => resolve());
        for (const socket of state.sockets) socket.destroy();
      });
      cleanupSocket();
    })();
    return state.closePromise;
  }

  function status() {
    return {
      socketPath,
      projectId,
      sandboxId,
      generation,
      enabled: state.enabled,
      closed: state.closed,
      fenced: state.fencedReason,
      activeRequests: state.inboundActive,
      pendingBodies: state.pendingBodies,
      activeInference: state.activeInference,
    };
  }

  return Object.freeze({
    socketPath,
    projectId,
    sandboxId,
    generation,
    endpoint: MODEL_RELAY_ENDPOINT,
    allow,
    fence,
    close,
    status,
  });
}

module.exports = {
  DEFAULT_LIMITS,
  MODEL_RELAY_ENDPOINT,
  ModelRelayError,
  createInferencePool,
  createModelRelay,
  defaultInferencePool,
};
