'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');

const {
  openPairingStore,
  PairingStoreError,
} = require('./pairing-store.cjs');
const { ensureIdentity, IdentityError } = require('./identity.cjs');
const {
  ProcessLockError,
  acquireProcessGuard,
  lstatOrNull,
  processIsAlive,
  readLegacyOwner,
  unlinkLegacyOwner,
  unlinkOwnLegacyOwner,
  writeLegacyOwner,
} = require('./process-lock.cjs');

const { canCall, matchResource } = require('./resource-routes.cjs');

const DEFAULT_LISTEN_HOST = '127.0.0.1';
const DEFAULT_PORT = 7443;
const API_VERSION = 1;
const MAX_STATE_DIR_LENGTH = 4096;
const MAX_HOST_LENGTH = 255;
const MAX_ORIGIN_LENGTH = 512;
const MAX_URL_LENGTH = 2048;
const MAX_BODY_BYTES = 8192;
const ADMIN_MAX_BODY_BYTES = 4096;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_HEADER_BYTES = 16 * 1024;
const ADMIN_SOCKET_NAME = 'admin.sock';
const ADMIN_LOCK_NAME = 'admin.sock.lock';
const ADMIN_LOCK_MAGIC = 'alpi-admin-v1';
const ADMIN_LOCK_STALE_MS = 10_000;

const DEFAULT_LIMITS = Object.freeze({
  windowMs: 60_000,
  perRemote: 10,
  global: 100,
  maxRemotes: 1024,
});

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BEARER_PATTERN = /^Bearer ([A-Za-z0-9_-]{43})$/;

class DaemonError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DaemonError';
    this.code = code;
  }
}

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

function fail(code, message) {
  throw new DaemonError(code, message);
}

function invalidOptions() {
  fail('invalid_options', 'Invalid server options.');
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

function normalizeStateDir(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_STATE_DIR_LENGTH ||
    value.includes('\u0000')
  ) {
    invalidOptions();
  }
  return path.resolve(value);
}

function normalizeListenHost(value) {
  if (value === undefined) {
    return DEFAULT_LISTEN_HOST;
  }
  if (typeof value !== 'string') {
    invalidOptions();
  }
  let host = value.trim();
  if (host.length === 0 || host.length > MAX_HOST_LENGTH) {
    invalidOptions();
  }
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(host)) {
    invalidOptions();
  }
  return host;
}

function normalizePort(value) {
  if (value === undefined) {
    return DEFAULT_PORT;
  }
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    invalidOptions();
  }
  return value;
}

function normalizeOrigin(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    invalidOptions();
  }
  if (value.length === 0 || value.length > MAX_ORIGIN_LENGTH) {
    invalidOptions();
  }
  if (value !== value.trim()) {
    invalidOptions();
  }
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)) {
    invalidOptions();
  }
  if (value.includes('\\')) {
    invalidOptions();
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    invalidOptions();
  }
  if (url.protocol !== 'https:') {
    invalidOptions();
  }
  if (url.username !== '' || url.password !== '') {
    invalidOptions();
  }
  if (url.search !== '' || url.hash !== '') {
    invalidOptions();
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    invalidOptions();
  }
  if (url.hostname === '') {
    invalidOptions();
  }
  if (/[\u0000-\u0020\u007f]/.test(url.hostname)) {
    invalidOptions();
  }
  if (url.port !== '') {
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      invalidOptions();
    }
  }
  const afterScheme = value.slice(value.indexOf('//') + 2);
  const authorityEnd = afterScheme.search(/[/?#\\]/);
  const authority =
    authorityEnd === -1 ? afterScheme : afterScheme.slice(0, authorityEnd);
  if (authority.includes('@') || authority.includes('\\')) {
    invalidOptions();
  }
  return url.origin;
}

function buildOrigin(host, port) {
  const renderedHost = host.includes(':') ? `[${host}]` : host;
  return `https://${renderedHost}:${port}`;
}

function normalizeLimits(value) {
  if (value === undefined) {
    return { ...DEFAULT_LIMITS };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalidOptions();
  }
  const limits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    if (value[key] === undefined) {
      continue;
    }
    if (!Number.isInteger(value[key]) || value[key] <= 0) {
      invalidOptions();
    }
    limits[key] = value[key];
  }
  return limits;
}

function normalizeOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    invalidOptions();
  }
  return {
    stateDir: normalizeStateDir(options.stateDir),
    listenHost: normalizeListenHost(options.listenHost),
    port: normalizePort(options.port),
    origin: normalizeOrigin(options.origin),
    limits: normalizeLimits(options.limits),
    handleSignals: options.handleSignals !== false,
  };
}

function remoteKey(address) {
  if (typeof address !== 'string' || address.length === 0) {
    return 'unknown';
  }
  if (address.startsWith('::ffff:') && address.includes('.')) {
    return address.slice(7);
  }
  return address;
}

class FailureRateLimiter {
  constructor(limits) {
    this._windowMs = limits.windowMs;
    this._perRemote = limits.perRemote;
    this._globalLimit = limits.global;
    this._maxRemotes = limits.maxRemotes;
    this._remotes = new Map();
    this._global = { count: 0, resetAt: 0 };
  }

  _now() {
    return Date.now();
  }

  _advanceGlobal(now) {
    if (this._global.resetAt <= now) {
      this._global.count = 0;
      this._global.resetAt = now + this._windowMs;
    }
  }

  _prune(now) {
    for (const [key, entry] of this._remotes) {
      if (entry.resetAt <= now) {
        this._remotes.delete(key);
      }
    }
  }

  check(key) {
    const now = this._now();
    this._advanceGlobal(now);
    this._prune(now);

    if (this._global.count >= this._globalLimit) {
      return {
        limited: true,
        retryAfterMs: Math.max(1, this._global.resetAt - now),
      };
    }

    const entry = this._remotes.get(key);
    if (
      entry &&
      entry.resetAt > now &&
      entry.count >= this._perRemote
    ) {
      return {
        limited: true,
        retryAfterMs: Math.max(1, entry.resetAt - now),
      };
    }

    return { limited: false, retryAfterMs: 0 };
  }

  recordFailure(key) {
    const now = this._now();
    this._advanceGlobal(now);
    this._global.count += 1;

    let entry = this._remotes.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + this._windowMs };
      this._remotes.set(key, entry);
    }
    entry.count += 1;

    while (this._remotes.size > this._maxRemotes) {
      const oldest = this._remotes.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this._remotes.delete(oldest);
    }
  }
}

function sendJson(res, status, payload, extraHeaders = {}) {
  if (res.headersSent || res.writableEnded || res.destroyed) {
    return;
  }
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    Connection: 'close',
    ...extraHeaders,
  };
  try {
    res.writeHead(status, headers);
    res.end(body);
  } catch {
    try {
      res.destroy();
    } catch {
      // Ignore socket teardown failures.
    }
  }
}

function isJsonContentType(value) {
  if (typeof value !== 'string') {
    return false;
  }
  return /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(
    value.trim()
  );
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'];
    if (!isJsonContentType(contentType)) {
      reject(new HttpError(415, 'unsupported_media_type'));
      return;
    }
    if (
      req.headers['content-encoding'] !== undefined &&
      req.headers['content-encoding'] !== 'identity'
    ) {
      reject(new HttpError(415, 'unsupported_media_type'));
      return;
    }

    const lengthHeader = req.headers['content-length'];
    if (lengthHeader !== undefined) {
      if (!/^\d+$/.test(lengthHeader)) {
        reject(new HttpError(400, 'bad_request'));
        return;
      }
      const declaredLength = Number(lengthHeader);
      if (!Number.isSafeInteger(declaredLength)) {
        reject(new HttpError(400, 'bad_request'));
        return;
      }
      if (declaredLength > maxBytes) {
        reject(new HttpError(413, 'payload_too_large'));
        return;
      }
    }

    const chunks = [];
    let total = 0;
    let settled = false;
    let timer = null;

    const finish = (handler, value) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
      handler(value);
    };

    timer = setTimeout(() => {
      try {
        req.pause();
      } catch {
        // Ignore pause failures while reporting a timeout.
      }
      finish(reject, new HttpError(408, 'request_timeout'));
    }, REQUEST_TIMEOUT_MS);

    req.on('data', (chunk) => {
      if (settled) {
        return;
      }
      total += chunk.length;
      if (total > maxBytes) {
        try {
          req.pause();
        } catch {
          // Ignore pause failures while reporting an oversized body.
        }
        finish(reject, new HttpError(413, 'payload_too_large'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) {
        return;
      }
      if (total === 0) {
        finish(reject, new HttpError(400, 'bad_request'));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        finish(reject, new HttpError(400, 'bad_request'));
        return;
      }
      finish(resolve, parsed);
    });

    req.on('error', () => {
      finish(reject, new HttpError(400, 'bad_request'));
    });

    req.on('aborted', () => {
      finish(reject, new HttpError(400, 'bad_request'));
    });
  });
}

function requireObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'bad_request');
  }
  return value;
}

function requireExactKeys(object, keys) {
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length) {
    return false;
  }
  return actual.every((key, index) => key === expected[index]);
}

function storeErrorStatus(error) {
  if (!(error instanceof PairingStoreError)) {
    return 500;
  }
  switch (error.code) {
    case 'invalid_invitation':
    case 'invalid_credential':
      return 401;
    case 'invalid_input':
      return 400;
    case 'unknown_client':
      return 404;
    case 'store_busy':
    case 'store_closed':
      return 503;
    default:
      return 500;
  }
}

function storeErrorCode(error) {
  if (error instanceof PairingStoreError) {
    switch (error.code) {
      case 'invalid_invitation':
      case 'invalid_credential':
        return 'unauthorized';
      case 'invalid_input':
        return 'bad_request';
      case 'unknown_client':
        return 'not_found';
      case 'store_busy':
      case 'store_closed':
        return 'unavailable';
      default:
        return 'internal_error';
    }
  }
  return 'internal_error';
}

function respondEnrollFailure(res, limiter, remote, status, code) {
  // The failure that reaches the configured threshold is still reported with
  // its real status. The next attempt is rejected by the pre-request check.
  limiter.recordFailure(remote);
  sendJson(res, status, { error: code });
}

function respondHttpError(req, res, error) {
  if (res.headersSent || res.writableEnded || res.destroyed) {
    return;
  }

  let status = 500;
  let code = 'internal_error';

  if (error instanceof HttpError) {
    status = error.status;
    code = error.code;
  } else if (error instanceof PairingStoreError) {
    status = storeErrorStatus(error);
    code = storeErrorCode(error);
  }

  if (status === 413 || status === 408) {
    res.once('finish', () => {
      try {
        req.destroy();
      } catch {
        // Ignore socket teardown failures.
      }
    });
  }

  sendJson(res, status, { error: code });
}

const resourceStatus = Object.freeze({
  invalid_input: 400, forbidden: 403, not_found: 404,
  lease_held: 409, lease_missing: 409, lease_stale: 409, lease_expired: 409,
  generation_conflict: 409, invalid_transition: 409, idempotency_conflict: 409,
  payload_too_large: 413, quota_exceeded: 429,
  invalid_size: 400, invalid_digest: 400, invalid_chunk: 400, invalid_offset: 400,
  offset_mismatch: 409, conflict: 409, not_ready: 409, incomplete: 409,
  digest_mismatch: 422, artifact_failed: 409, upload_expired: 410, chunk_limit: 413,
  profile_unavailable: 503, model_unavailable: 503, unavailable_engine: 503,
  runtime_unavailable: 503, service_unavailable: 503, store_busy: 503, store_unavailable: 503,
});

function createHttpsHandler(context) {
  return async (req, res) => {
    try {
      await routeHttps(req, res, context);
    } catch (error) {
      respondHttpError(req, res, error);
    }
  };
}

async function routeHttps(req, res, context) {
  const { store, serverId, limiter } = context;

  if (typeof req.url !== 'string' || req.url.length > MAX_URL_LENGTH) {
    throw new HttpError(414, 'uri_too_long');
  }

  let url;
  try {
    url = new URL(req.url, 'https://localhost');
  } catch {
    throw new HttpError(400, 'bad_request');
  }

  const pathname = url.pathname;

  if (pathname === '/v1/identity') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
      return;
    }
    sendJson(res, 200, { serverId });
    return;
  }

  if (pathname === '/v1/pair/exchange') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST' });
      return;
    }

    const remote = remoteKey(req.socket && req.socket.remoteAddress);
    const preLimit = limiter.check(remote);
    if (preLimit.limited) {
      sendJson(
        res,
        429,
        { error: 'rate_limited' },
        {
          'Retry-After': String(
            Math.ceil(preLimit.retryAfterMs / 1000) || 1
          ),
        }
      );
      return;
    }

    let body;
    try {
      body = requireObject(await readJsonBody(req, MAX_BODY_BYTES));
      if (
        !requireExactKeys(body, ['invitation', 'name']) ||
        typeof body.invitation !== 'string' ||
        typeof body.name !== 'string'
      ) {
        throw new HttpError(400, 'bad_request');
      }
      const result = store.exchange({
        invitation: body.invitation,
        name: body.name,
      });
      sendJson(res, 200, {
        credential: result.credential,
        clientId: result.clientId,
        project: result.project,
        role: result.role,
        expiresAt: result.expiresAt,
      });
      return;
    } catch (error) {
      if (error instanceof HttpError) {
        respondEnrollFailure(res, limiter, remote, error.status, error.code);
        return;
      }
      if (error instanceof PairingStoreError) {
        const status = storeErrorStatus(error);
        if (status === 500 || status === 503) {
          respondHttpError(req, res, error);
          return;
        }
        respondEnrollFailure(res, limiter, remote, status, storeErrorCode(error));
        return;
      }
      respondHttpError(req, res, error);
      return;
    }
  }

  const capabilities = req.url === '/v1/capabilities';
  const route = capabilities ? { role: 'observer' } : matchResource(req.method, req.url);
  if (!route) return sendJson(res, 404, { error: 'not_found' });
  const allow = capabilities && req.method !== 'GET' ? ['GET'] : route.allow;
  if (allow) return sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: allow.join(', ') });

  const remote = remoteKey(req.socket?.remoteAddress);
  const limit = limiter.check(remote);
  if (limit.limited) {
    return sendJson(res, 429, { error: 'rate_limited' }, { 'Retry-After': String(Math.ceil(limit.retryAfterMs / 1000) || 1) });
  }
  const match = typeof req.headers.authorization === 'string' && BEARER_PATTERN.exec(req.headers.authorization);
  if (!match || !TOKEN_PATTERN.test(match[1])) return respondEnrollFailure(res, limiter, remote, 401, 'unauthorized');
  const authenticate = () => store.authenticate(match[1]);
  try {
    let principal = authenticate();
    if (capabilities) {
      const runtimes = await context.runtimeInventory(principal);
      authenticate();
      return sendJson(res, 200, { serverId, apiVersion: API_VERSION, project: principal.project, role: principal.role, runtimes });
    }
    if (!canCall(principal.role, route.role)) throw new HttpError(403, 'forbidden');
    if (!context.resources) throw new HttpError(503, 'service_unavailable');
    const body = req.method === 'POST' ? requireObject(await readJsonBody(req, 64 * 1024)) : {};
    // Recheck after an asynchronous body read. The callback also fences long-lived writers.
    principal = authenticate();
    let result;
    try {
      result = await context.resources.execute({ name: route.name, params: route.params, body, principal, authenticate });
    } catch (error) {
      if (Object.hasOwn(resourceStatus, error?.code)) throw new HttpError(resourceStatus[error.code], error.code);
      throw error;
    }
    authenticate();
    return sendJson(res, 200, result);
  } catch (error) {
    if (error instanceof PairingStoreError && storeErrorStatus(error) === 401) {
      return respondEnrollFailure(res, limiter, remote, 401, 'unauthorized');
    }
    throw error;
  }
}

function createAdminHandler(context) {
  return async (req, res) => {
    try {
      await routeAdmin(req, res, context);
    } catch (error) {
      respondHttpError(req, res, error);
    }
  };
}

async function routeAdmin(req, res, context) {
  const { store, serverId, fingerprint, defaultOrigin } = context;

  if (typeof req.url !== 'string' || req.url.length > MAX_URL_LENGTH) {
    throw new HttpError(414, 'uri_too_long');
  }

  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    throw new HttpError(400, 'bad_request');
  }

  const pathname = url.pathname;

  if (pathname === '/v1/admin/pair/issue') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST' });
      return;
    }

    if (context.ready !== true) {
      sendJson(res, 503, { error: 'unavailable' });
      return;
    }

    const body = requireObject(
      await readJsonBody(req, ADMIN_MAX_BODY_BYTES)
    );
    if (
      !requireExactKeys(body, ['project', 'role', 'ttlMs', 'origin']) &&
      !requireExactKeys(body, ['project', 'role', 'ttlMs']) &&
      !requireExactKeys(body, ['project', 'role', 'origin']) &&
      !requireExactKeys(body, ['project', 'role'])
    ) {
      throw new HttpError(400, 'bad_request');
    }
    if (typeof body.project !== 'string' || typeof body.role !== 'string') {
      throw new HttpError(400, 'bad_request');
    }
    if (body.ttlMs !== undefined && !Number.isInteger(body.ttlMs)) {
      throw new HttpError(400, 'bad_request');
    }

    let origin = defaultOrigin;
    if (body.origin !== undefined) {
      try {
        origin = normalizeOrigin(body.origin);
      } catch {
        throw new HttpError(400, 'bad_request');
      }
    }

    const invite = store.issueInvite({
      project: body.project,
      role: body.role,
      ttlMs: body.ttlMs,
    });

    sendJson(res, 200, {
      origin,
      serverId,
      fingerprint,
      invitation: invite.invitation,
      expiresAt: invite.expiresAt,
    });
    return;
  }

  if (pathname === '/v1/admin/clients') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
      return;
    }
    sendJson(res, 200, { clients: store.listClients() });
    return;
  }

  if (pathname === '/v1/admin/clients/revoke') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST' });
      return;
    }

    const body = requireObject(
      await readJsonBody(req, ADMIN_MAX_BODY_BYTES)
    );
    if (
      !requireExactKeys(body, ['clientId']) ||
      typeof body.clientId !== 'string'
    ) {
      throw new HttpError(400, 'bad_request');
    }

    const result = store.revoke(body.clientId);
    sendJson(res, 200, {
      clientId: result.clientId,
      revokedAt: result.revokedAt,
    });
    return;
  }

  sendJson(res, 404, { error: 'not_found' });
}

function attachSocketGuards(server) {
  server.on('clientError', (error, socket) => {
    if (!socket || !socket.writable) {
      return;
    }
    try {
      socket.end(
        'HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n'
      );
    } catch {
      try {
        socket.destroy();
      } catch {
        // Ignore teardown failures.
      }
    }
  });
  server.on('tlsClientError', (error, socket) => {
    if (socket) {
      try {
        socket.destroy();
      } catch {
        // Ignore teardown failures.
      }
    }
  });
}

function listenHttpServer(server, options) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    try {
      server.listen(options);
    } catch (error) {
      server.removeListener('error', onError);
      server.removeListener('listening', onListening);
      reject(error);
    }
  });
}

function probeUnixSocket(socketPath, timeoutMs = 500) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection({ path: socketPath });
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        socket.destroy();
      } catch {
        // Ignore teardown failures during probing.
      }
      resolve(result);
    };
    socket.once('connect', () => finish('connected'));
    socket.once('error', (error) => {
      if (
        error &&
        (error.code === 'ECONNREFUSED' || error.code === 'ENOENT')
      ) {
        finish('stale');
        return;
      }
      finish('unknown');
    });
    socket.setTimeout(timeoutMs, () => finish('unknown'));
  });
}

/**
 * Confirm that an existing administration socket is dead, then remove exactly
 * the socket instance that was probed. The SQLite guard is held by the caller,
 * so a competing startup cannot bind a replacement between the probe and the
 * unlink.
 */
async function reclaimStaleAdminSocket(socketPath) {
  const before = lstatOrNull(socketPath);
  if (!before) {
    return;
  }
  if (!before.isSocket()) {
    fail(
      'admin_socket_unavailable',
      'Admin socket path is occupied by another file.'
    );
  }
  const probe = await probeUnixSocket(socketPath);
  if (probe !== 'stale') {
    fail('admin_socket_busy', 'Admin socket is busy.');
  }
  const after = lstatOrNull(socketPath);
  if (!after) {
    return;
  }
  if (!after.isSocket()) {
    fail(
      'admin_socket_unavailable',
      'Admin socket path is occupied by another file.'
    );
  }
  if (after.dev !== before.dev || after.ino !== before.ino) {
    fail('admin_socket_busy', 'Admin socket is busy.');
  }
  try {
    fs.unlinkSync(socketPath);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      fail('admin_socket_unavailable', 'Admin socket is unavailable.');
    }
  }
}

/**
 * Acquire the lifetime administration guard. The SQLite guard is held until
 * the server has closed both listeners, so stale metadata/socket cleanup and
 * normal acquisition cannot interleave. Live legacy owners are observed and
 * refused; their socket and metadata are never removed.
 */
async function acquireAdminOwnership(socketPath, lockPath) {
  let guard;
  try {
    guard = acquireProcessGuard(lockPath, { failFast: true, timeoutMs: 0 });
  } catch (error) {
    if (error instanceof ProcessLockError && error.code === 'lock_busy') {
      fail('admin_socket_busy', 'Admin socket is busy.');
    }
    fail('admin_socket_unavailable', 'Admin socket is unavailable.');
  }

  try {
    const owner = readLegacyOwner(lockPath, ADMIN_LOCK_MAGIC);
    if (!owner.missing) {
      if (owner.malformed) {
        if (owner.ageMs <= ADMIN_LOCK_STALE_MS) {
          // A legacy owner may still be writing its metadata. Never remove it
          // while it could be live.
          fail('admin_socket_busy', 'Admin socket is busy.');
        }
      } else if (processIsAlive(owner.pid)) {
        fail('admin_socket_busy', 'Admin socket is busy.');
      }
      // The recorded owner is gone (or its metadata is old and unreadable).
      // Under the guard, confirm the socket is dead before removing either
      // resource.
      await reclaimStaleAdminSocket(socketPath);
      unlinkLegacyOwner(lockPath);
    }

    // A socket can outlive its metadata, for example when a legacy process was
    // killed between binding and recording ownership.
    await reclaimStaleAdminSocket(socketPath);

    if (!writeLegacyOwner(lockPath, ADMIN_LOCK_MAGIC)) {
      fail('admin_socket_busy', 'Admin socket is busy.');
    }
    return guard;
  } catch (error) {
    guard.release();
    throw error;
  }
}

function releaseAdminOwnership(lockRecord) {
  if (!lockRecord) {
    return;
  }
  try {
    unlinkOwnLegacyOwner(lockRecord.lockPath, ADMIN_LOCK_MAGIC);
  } catch {
    // Best-effort metadata cleanup; the guard still protects the socket.
  } finally {
    lockRecord.release();
  }
}

function recordAdminSocket(socketPath) {
  const stat = fs.lstatSync(socketPath);
  if (!stat.isSocket()) {
    fail('admin_socket_unavailable', 'Admin socket is unavailable.');
  }
  const uid = currentUid();
  if (uid !== null && stat.uid !== uid) {
    fail('admin_socket_unavailable', 'Admin socket is unavailable.');
  }
  fs.chmodSync(socketPath, 0o600);
  return {
    socketPath,
    dev: stat.dev,
    ino: stat.ino,
  };
}

function unlinkOwnedAdminSocket(record) {
  if (!record) {
    return;
  }
  try {
    const stat = fs.lstatSync(record.socketPath);
    if (
      stat.isSocket() &&
      stat.dev === record.dev &&
      stat.ino === record.ino
    ) {
      fs.unlinkSync(record.socketPath);
    }
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      // Best-effort cleanup; never remove a socket we do not own.
    }
  }
}

function waitForSocketClosed(socket, timeoutMs = 2000) {
  if (!socket || socket.destroyed) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      // destroy() makes the transport unusable; the close event may still be
      // pending on a platform-specific path.
      try {
        socket.destroy();
      } catch {
        // Ignore teardown failures while completing shutdown.
      }
      finish();
    }, timeoutMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    socket.once('close', finish);
  });
}

/**
 * Own every accepted transport socket, including connections that have not
 * completed TLS negotiation and therefore never reached the HTTP parser.
 * closeAllConnections() alone does not see those pre-HTTP sockets.
 */
function createSocketTracker() {
  const sockets = new Set();
  const track = (socket) => {
    if (!socket) {
      return;
    }
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };
  return {
    attach(server) {
      server.on('connection', track);
      server.on('secureConnection', track);
      server.on('request', (req) => track(req.socket));
      server.on('clientError', (error, socket) => track(socket));
      server.on('tlsClientError', (error, socket) => track(socket));
      return server;
    },
    snapshot() {
      return [...sockets];
    },
  };
}

function closeHttpServer(server, tracker) {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    const sockets = tracker ? tracker.snapshot() : [];
    let finished = false;
    let timer = null;

    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
      resolve();
    };

    const destroySockets = () => {
      for (const socket of sockets) {
        try {
          socket.destroy();
        } catch {
          // Ignore teardown failures; the socket is unusable either way.
        }
      }
      if (typeof server.closeAllConnections === 'function') {
        try {
          server.closeAllConnections();
        } catch {
          // Ignore teardown failures.
        }
      }
    };

    const socketsClosed = Promise.all(
      sockets.map((socket) => waitForSocketClosed(socket))
    );
    const complete = () => {
      socketsClosed.then(finish, finish);
    };

    if (!server.listening) {
      destroySockets();
      complete();
      return;
    }

    server.once('close', () => {
      destroySockets();
      complete();
    });
    try {
      server.close(() => {
        // The close callback fires once the listener is shut and all tracked
        // connections have ended.
      });
    } catch {
      destroySockets();
      complete();
      return;
    }

    destroySockets();
    // Safety net: destroy() has already made every transport unusable, so if
    // the listener's close event is delayed, report completion only after all
    // tracked sockets are confirmed closed.
    timer = setTimeout(() => {
      destroySockets();
      complete();
    }, 5000);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  });
}

/**
 * Start the Alpi server.
 *
 * Public HTTPS routes:
 *   GET  /v1/identity
 *   POST /v1/pair/exchange
 *   GET  /v1/capabilities
 *
 * Private unix-socket administration routes:
 *   POST /v1/admin/pair/issue
 *   GET  /v1/admin/clients
 *   POST /v1/admin/clients/revoke
 */
async function startServer(options) {
  const normalized = normalizeOptions(options);
  const {
    stateDir,
    listenHost,
    port,
    origin: explicitOrigin,
    limits,
    handleSignals,
  } = normalized;

  const adminSocketPath = path.join(stateDir, ADMIN_SOCKET_NAME);
  const adminLockPath = path.join(stateDir, ADMIN_LOCK_NAME);

  // Portable Unix-domain socket paths are limited to roughly 100 bytes on
  // macOS and 108 bytes on Linux. Fail clearly rather than binding a path
  // that the kernel will reject.
  if (Buffer.byteLength(adminSocketPath, 'utf8') > 100) {
    fail('admin_socket_unavailable', 'Admin socket path is too long.');
  }

  let store = null;
  let identity = null;
  let resources = null;
  let httpsServer = null;
  let adminServer = null;
  let socketRecord = null;
  let lockRecord = null;
  let shuttingDown = false;
  let closeChain = Promise.resolve();
  let signalTimer = null;
  const socketTracker = createSocketTracker();

  const signalHandler = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    signalTimer = setTimeout(() => {
      process.exit(1);
    }, 5000);
    if (typeof signalTimer.unref === 'function') {
      signalTimer.unref();
    }
    close().catch(() => {
      process.exitCode = 1;
    });
  };

  const removeSignalHandlers = () => {
    process.removeListener('SIGINT', signalHandler);
    process.removeListener('SIGTERM', signalHandler);
    if (signalTimer !== null) {
      clearTimeout(signalTimer);
      signalTimer = null;
    }
  };

  const close = () => {
    closeChain = closeChain.then(async () => {
      try {
        const httpsToClose = httpsServer;
        const adminToClose = adminServer;
        httpsServer = null;
        adminServer = null;

        // Close both listeners together, destroying every tracked transport
        // (including pre-HTTP TLS sockets) before the administration lock and
        // the store are relinquished.
        await Promise.all([
          closeHttpServer(httpsToClose, socketTracker),
          closeHttpServer(adminToClose, socketTracker),
        ]);

        try {
          await resources?.close();
        } finally {
          resources = null;
          unlinkOwnedAdminSocket(socketRecord);
          socketRecord = null;
          releaseAdminOwnership(lockRecord);
          lockRecord = null;
          if (store) {
            try {
              store.close();
            } catch {
              // Ignore store close failures during shutdown.
            }
            store = null;
          }
        }
      } finally {
        // Keep a signal-triggered force-exit deadline until both listeners and
        // every owned socket are actually closed.
        removeSignalHandlers();
      }
    });
    return closeChain;
  };

  if (handleSignals) {
    process.once('SIGINT', signalHandler);
    process.once('SIGTERM', signalHandler);
  }

  try {
    store = openPairingStore(stateDir);
    identity = ensureIdentity(stateDir);

    if (shuttingDown) {
      throw new DaemonError('shutting_down', 'Server is shutting down.');
    }

    lockRecord = await acquireAdminOwnership(adminSocketPath, adminLockPath);

    if (shuttingDown) {
      throw new DaemonError('shutting_down', 'Server is shutting down.');
    }

    if (options.openResources) resources = await options.openResources({ stateDir, serverId: store.serverId });
    const serverId = store.serverId;
    const fingerprint = identity.fingerprint;
    const limiter = new FailureRateLimiter(limits);
    const adminContext = {
      store,
      serverId,
      fingerprint,
      ready: false,
      defaultOrigin:
        explicitOrigin || buildOrigin(listenHost, port || DEFAULT_PORT),
    };

    adminServer = http.createServer(
      { maxHeaderSize: MAX_HEADER_BYTES },
      createAdminHandler(adminContext)
    );
    adminServer.requestTimeout = REQUEST_TIMEOUT_MS;
    adminServer.headersTimeout = REQUEST_TIMEOUT_MS;
    attachSocketGuards(adminServer);
    socketTracker.attach(adminServer);

    try {
      await listenHttpServer(adminServer, { path: adminSocketPath });
    } catch {
      fail('admin_socket_unavailable', 'Admin socket is unavailable.');
    }

    socketRecord = recordAdminSocket(adminSocketPath);

    if (shuttingDown) {
      throw new DaemonError('shutting_down', 'Server is shutting down.');
    }

    httpsServer = https.createServer(
      {
        key: identity.keyPem,
        cert: identity.certPem,
        minVersion: 'TLSv1.2',
        maxHeaderSize: MAX_HEADER_BYTES,
      },
      createHttpsHandler({
        resources,
        runtimeInventory: options.runtimeInventory ?? (async () => []),
        store,
        serverId,
        limiter,
      })
    );
    httpsServer.requestTimeout = REQUEST_TIMEOUT_MS;
    httpsServer.headersTimeout = REQUEST_TIMEOUT_MS;
    httpsServer.keepAliveTimeout = 5000;
    attachSocketGuards(httpsServer);
    socketTracker.attach(httpsServer);

    try {
      await listenHttpServer(httpsServer, {
        host: listenHost,
        port,
        exclusive: true,
      });
    } catch {
      fail('listen_failed', 'HTTPS listener could not be started.');
    }

    const address = httpsServer.address();
    const actualPort =
      address && typeof address === 'object' ? address.port : port;
    const origin = explicitOrigin || buildOrigin(listenHost, actualPort);

    // Publish the actual origin, including the port selected when the caller
    // requested an ephemeral port. Pairing issuance stays unavailable until
    // the HTTPS listener and its advertised origin are ready.
    adminContext.defaultOrigin = origin;
    adminContext.ready = true;

    if (shuttingDown) {
      throw new DaemonError('shutting_down', 'Server is shutting down.');
    }

    return {
      stateDir,
      listenHost,
      port: actualPort,
      origin,
      serverId,
      fingerprint,
      certPath: identity.certPath,
      keyPath: identity.keyPath,
      adminSocketPath,
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch {
      // Preserve the original startup error.
    }
    if (
      error instanceof DaemonError ||
      error instanceof PairingStoreError ||
      error instanceof IdentityError
    ) {
      throw error;
    }
    throw new DaemonError('startup_failed', 'Server could not be started.');
  }
}

module.exports = {
  startServer,
  FailureRateLimiter,
  DaemonError,
  DEFAULT_PORT,
  DEFAULT_LISTEN_HOST,
  API_VERSION,
  ADMIN_LOCK_MAGIC,
};
