'use strict';

const {
  ContextError,
  normalizeClientId,
  normalizeFingerprint,
  normalizeServerId,
  parseInviteEnvelope,
  validateClientName,
  validateCredentialExpiresAt,
  validateInviteEnvelope,
  validateOrigin,
  validateProject,
  validateRole,
  validateToken,
} = require('./context.cjs');
const { requestJson: defaultRequestJson } = require('./transport.cjs');

const { resourceRequest } = require('./shared/resource-routes.cjs');

const MAX_RUNTIME_COUNT = 64;
const MAX_RUNTIME_KEYS = 32;
const MAX_RUNTIME_STRING = 1024;
const MAX_RUNTIME_DEPTH = 8;
const PRE_SEND_EXCHANGE_FAILURES = new Set([
  'INVALID_ORIGIN',
  'INVALID_FINGERPRINT',
  'INVALID_PATH',
  'INVALID_METHOD',
  'INVALID_BODY',
  'INVALID_ARGUMENT',
  'REQUEST_TOO_LARGE',
  'TLS_CERT_INVALID',
  'TLS_PIN_MISMATCH',
]);

const TRANSPORT_MESSAGES = Object.freeze({
  INVALID_ORIGIN: 'Invalid HTTPS origin.',
  INVALID_FINGERPRINT: 'Invalid certificate fingerprint.',
  INVALID_PATH: 'Invalid request path.',
  INVALID_METHOD: 'Invalid request method.',
  INVALID_CREDENTIAL: 'Invalid credential.',
  INVALID_BODY: 'Invalid request payload.',
  INVALID_ARGUMENT: 'Invalid request argument.',
  REQUEST_TOO_LARGE: 'Request payload is too large.',
  RESPONSE_TOO_LARGE: 'Response payload is too large.',
  INVALID_RESPONSE: 'Invalid server response.',
  REDIRECT_NOT_ALLOWED: 'Server redirects are not allowed.',
  HTTP_STATUS: 'Server rejected the request.',
  CONNECTION_ERROR: 'Connection failed.',
  CONNECTION_CLOSED: 'Connection closed before a complete response.',
  TLS_CERT_INVALID: 'Invalid TLS certificate.',
  TLS_PIN_MISMATCH: 'TLS certificate fingerprint does not match.',
  TIMEOUT: 'Request timed out.',
});

class ClientError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ClientError';
    this.code = code;
    if (details && typeof details === 'object') {
      for (const key of Object.keys(details)) {
        if (key !== 'message' && key !== 'stack') {
          this[key] = details[key];
        }
      }
    }
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ClientError);
    }
  }
}

function fail(code, message, details) {
  throw new ClientError(code, message, details);
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function hasExactKeys(value, keys) {
  if (!isPlainObject(value)) {
    return false;
  }
  const own = Object.keys(value);
  if (own.length !== keys.length) {
    return false;
  }
  return keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function validateBoundedJson(value, depth, seen) {
  if (value === null) {
    return;
  }
  const type = typeof value;
  if (type === 'boolean') {
    return;
  }
  if (type === 'string') {
    if (value.length > MAX_RUNTIME_STRING ||
        /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)) {
      fail('INVALID_RESPONSE', 'Invalid server response.');
    }
    return;
  }
  if (type === 'number') {
    if (!Number.isFinite(value)) {
      fail('INVALID_RESPONSE', 'Invalid server response.');
    }
    return;
  }
  if (type !== 'object' || depth > MAX_RUNTIME_DEPTH || seen.has(value)) {
    fail('INVALID_RESPONSE', 'Invalid server response.');
  }

  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > MAX_RUNTIME_COUNT) {
      fail('INVALID_RESPONSE', 'Invalid server response.');
    }
    for (let i = 0; i < value.length; i += 1) {
      if (!(i in value)) {
        fail('INVALID_RESPONSE', 'Invalid server response.');
      }
      validateBoundedJson(value[i], depth + 1, seen);
    }
  } else {
    if (!isPlainObject(value) || Object.keys(value).length > MAX_RUNTIME_KEYS) {
      fail('INVALID_RESPONSE', 'Invalid server response.');
    }
    for (const key of Object.keys(value)) {
      if (key === '__proto__' || key.length > MAX_RUNTIME_STRING) {
        fail('INVALID_RESPONSE', 'Invalid server response.');
      }
      validateBoundedJson(value[key], depth + 1, seen);
    }
  }
  seen.delete(value);
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  for (const key of Object.keys(value)) {
    deepFreeze(value[key]);
  }
  return Object.freeze(value);
}

function transportError(error) {
  if (error instanceof ClientError) {
    return error;
  }
  const code = error && typeof error.code === 'string'
    ? error.code
    : 'REQUEST_FAILED';
  const message = TRANSPORT_MESSAGES[code] || 'Request failed.';
  const details = {};
  if (error && Number.isInteger(error.statusCode) &&
      error.statusCode >= 100 && error.statusCode <= 599) {
    details.statusCode = error.statusCode;
  }
  return new ClientError(code, message, details);
}

async function callTransport(transport, options) {
  try {
    return await transport(options);
  } catch (error) {
    throw transportError(error);
  }
}

function validateIdentityResponse(response) {
  if (!hasExactKeys(response, ['serverId'])) {
    fail('INVALID_RESPONSE', 'Invalid server response.');
  }
  return normalizeServerId(response.serverId);
}

function validateExchangeResponse(response, now) {
  if (!hasExactKeys(response, [
    'credential',
    'clientId',
    'project',
    'role',
    'expiresAt',
  ])) {
    fail('INVALID_RESPONSE', 'Invalid server response.');
  }

  const credential = validateToken(response.credential, 'credential');
  const clientId = normalizeClientId(response.clientId);
  const project = validateProject(response.project);
  const role = validateRole(response.role);
  const expiresAt = validateCredentialExpiresAt(response.expiresAt);
  if (expiresAt <= now) {
    fail('INVALID_RESPONSE', 'Invalid server response.');
  }

  return { credential, clientId, project, role, expiresAt };
}

function validateCapabilitiesResponse(response, client) {
  if (!hasExactKeys(response, [
    'serverId',
    'apiVersion',
    'project',
    'role',
    'runtimes',
  ])) {
    fail('INVALID_RESPONSE', 'Invalid server response.');
  }

  const serverId = normalizeServerId(response.serverId);
  if (serverId !== client.serverId) {
    fail('SERVER_ID_MISMATCH', 'Server identity does not match the stored context.');
  }
  if (response.apiVersion !== 1) {
    fail('INVALID_RESPONSE', 'Invalid server response.');
  }
  const project = validateProject(response.project);
  const role = validateRole(response.role);
  if (project !== client.project || role !== client.role) {
    fail('SERVER_RESPONSE_MISMATCH', 'Server response does not match the stored context.');
  }
  if (!Array.isArray(response.runtimes) ||
      response.runtimes.length > MAX_RUNTIME_COUNT) {
    fail('INVALID_RESPONSE', 'Invalid server response.');
  }
  validateBoundedJson(response.runtimes, 0, new WeakSet());

  return deepFreeze({
    serverId,
    apiVersion: 1,
    project,
    role,
    runtimes: response.runtimes,
  });
}

function createClient(options) {
  if (!isPlainObject(options)) {
    fail('INVALID_ARGUMENT', 'Invalid client options.');
  }

  const origin = validateOrigin(options.origin);
  const fingerprint = normalizeFingerprint(options.fingerprint);
  const serverId = normalizeServerId(options.serverId);
  const credential = validateToken(options.credential, 'credential');
  const project = validateProject(options.project);
  const role = validateRole(options.role);
  const credentialExpiresAt = validateCredentialExpiresAt(
    options.credentialExpiresAt,
  );
  const transport = options.requestJson === undefined
    ? defaultRequestJson
    : options.requestJson;
  if (typeof transport !== 'function') {
    fail('INVALID_ARGUMENT', 'Invalid client options.');
  }
  const now = options.now === undefined ? () => Date.now() : options.now;
  if (typeof now !== 'function') {
    fail('INVALID_ARGUMENT', 'Invalid client options.');
  }

  function request(method, path, body) {
    const current = now();
    if (!Number.isSafeInteger(current) || current < 0) fail('INVALID_ARGUMENT', 'Invalid clock.');
    if (current >= credentialExpiresAt) fail('CREDENTIAL_EXPIRED', 'Client credential has expired.');
    return callTransport(transport, { origin, fingerprint, path, method, credential,
      ...(body === undefined ? {} : { body }), timeoutMs: options.timeoutMs });
  }

  const client = {
    serverId,
    project,
    role,
    credentialExpiresAt,
    async requestResource(name, params, body) {
      const route = resourceRequest(name, params);
      // Select the peer, API version and project again before a remote mutation.
      if (route.method !== 'GET') await client.getCapabilities();
      return request(route.method, route.path, route.method === 'POST' ? body ?? {} : undefined);
    },
    async getCapabilities() {
      const response = await request('GET', '/v1/capabilities');
      return validateCapabilitiesResponse(response, client);
    },
  };
  return Object.freeze(client);
}

function isOrdinaryExchangeFailure(error) {
  if (!(error instanceof ClientError)) {
    return false;
  }
  if (error.code === 'HTTP_STATUS') {
    return Number.isInteger(error.statusCode) &&
      error.statusCode >= 400 &&
      error.statusCode < 500;
  }
  // These failures happen before the request body can leave the client.
  return PRE_SEND_EXCHANGE_FAILURES.has(error.code);
}

function ambiguousMessage(reservationPath) {
  return (
    'Pairing outcome is unknown. Do not retry this invitation. ' +
    'Check the server client list, revoke any newly created client, ' +
    `remove the local reservation at ${reservationPath} only if no alpi ` +
    'process is pairing, then issue a fresh invitation.'
  );
}

async function pairClient(options) {
  if (!isPlainObject(options)) {
    fail('INVALID_ARGUMENT', 'Invalid pairing options.');
  }

  const store = options.store;
  if (!store || typeof store.reserve !== 'function' ||
      typeof store.publish !== 'function' ||
      typeof store.releaseReservation !== 'function') {
    fail('INVALID_ARGUMENT', 'Invalid pairing options.');
  }
  const transport = options.requestJson === undefined
    ? defaultRequestJson
    : options.requestJson;
  if (typeof transport !== 'function') {
    fail('INVALID_ARGUMENT', 'Invalid pairing options.');
  }
  const now = options.now === undefined ? () => Date.now() : options.now;
  if (typeof now !== 'function') {
    fail('INVALID_ARGUMENT', 'Invalid pairing options.');
  }

  const name = validateClientName(options.name);
  const envelope = validateInviteEnvelope(options.envelope, { now: now() });

  const reservation = store.reserve(name);
  let phase = 'identity';
  let reservationHeld = true;

  const release = () => {
    if (!reservationHeld) {
      return true;
    }
    reservationHeld = false;
    try {
      return store.releaseReservation(name, reservation.id);
    } catch (error) {
      if (error instanceof ContextError) {
        fail(
          error.code,
          error.message,
          { reservationPath: reservation.path },
        );
      }
      fail('STORE_ERROR', 'Unable to release the pairing reservation.');
    }
  };

  try {
    const identity = await callTransport(transport, {
      origin: envelope.origin,
      fingerprint: envelope.fingerprint,
      path: '/v1/identity',
      method: 'GET',
      timeoutMs: options.timeoutMs,
    });
    const advertisedServerId = validateIdentityResponse(identity);
    if (advertisedServerId !== envelope.serverId) {
      fail(
        'SERVER_ID_MISMATCH',
        'Server identity does not match the invitation.',
      );
    }

    const beforeExchange = now();
    if (!Number.isSafeInteger(beforeExchange) || beforeExchange < 0) {
      fail('INVALID_ARGUMENT', 'Invalid clock.');
    }
    if (envelope.expiresAt <= beforeExchange) {
      fail('INVITE_EXPIRED', 'Invitation has expired.');
    }

    phase = 'exchange';
    const exchange = await callTransport(transport, {
      origin: envelope.origin,
      fingerprint: envelope.fingerprint,
      path: '/v1/pair/exchange',
      method: 'POST',
      body: {
        invitation: envelope.invitation,
        name,
      },
      timeoutMs: options.timeoutMs,
    });

    phase = 'exchange-response';
    const issued = validateExchangeResponse(exchange, beforeExchange);

    phase = 'publish';
    const record = {
      version: 1,
      name,
      origin: envelope.origin,
      serverId: envelope.serverId,
      fingerprint: envelope.fingerprint,
      credential: issued.credential,
      clientId: issued.clientId,
      project: issued.project,
      role: issued.role,
      credentialExpiresAt: issued.expiresAt,
      createdAt: beforeExchange,
    };
    store.publish(name, record, reservation.id);
    phase = 'published';

    let released = false;
    try {
      released = store.releaseReservation(name, reservation.id);
    } catch {
      released = false;
    }
    reservationHeld = false;
    return Object.freeze({
      name,
      serverId: envelope.serverId,
      clientId: issued.clientId,
      project: issued.project,
      role: issued.role,
      expiresAt: issued.expiresAt,
      reservationRemoved: released,
      reservationPath: reservation.path,
    });
  } catch (error) {
    const ambiguous =
      phase === 'exchange' ||
      phase === 'exchange-response' ||
      phase === 'publish';

    if (!ambiguous || (phase === 'exchange' && isOrdinaryExchangeFailure(error))) {
      try {
        release();
      } catch (releaseError) {
        if (releaseError instanceof ClientError) {
          releaseError.reservationPath = reservation.path;
        }
        throw releaseError;
      }
      throw error;
    }

    throw new ClientError('PAIR_AMBIGUOUS', ambiguousMessage(reservation.path), {
      reservationPath: reservation.path,
      causeCode: error instanceof ClientError ? error.code : undefined,
    });
  }
}

module.exports = {
  ClientError,
  createClient,
  pairClient,
  validateCapabilitiesResponse,
  validateExchangeResponse,
  validateIdentityResponse,
  parseInviteEnvelope,
};
