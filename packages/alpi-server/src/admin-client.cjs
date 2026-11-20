'use strict';

const http = require('node:http');
const path = require('node:path');

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_STATE_DIR_LENGTH = 4096;
const ADMIN_SOCKET_NAME = 'admin.sock';

class AdminClientError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'AdminClientError';
    this.code = code;
    this.status = status;
  }
}

function fail(code, message) {
  throw new AdminClientError(code, message);
}

function resolveStateDir(stateDir) {
  if (
    typeof stateDir !== 'string' ||
    stateDir.length === 0 ||
    stateDir.length > MAX_STATE_DIR_LENGTH ||
    stateDir.includes('\u0000')
  ) {
    fail('invalid_options', 'Invalid administration options.');
  }
  return path.resolve(stateDir);
}

function adminSocketPath(stateDir) {
  return path.join(resolveStateDir(stateDir), ADMIN_SOCKET_NAME);
}

/**
 * Send one request to the private administration socket.
 *
 * The socket is created inside the private state directory by the daemon.
 * Requests and responses are bounded and never redirected.
 */
function adminRequest(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    fail('invalid_options', 'Invalid administration options.');
  }

  const stateDir = resolveStateDir(options.stateDir);
  const socketPath = path.join(stateDir, ADMIN_SOCKET_NAME);
  const method = options.method === undefined ? 'GET' : options.method;
  const requestPath = options.path === undefined ? '/' : options.path;
  const timeoutMs =
    options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs;
  const maxResponseBytes =
    options.maxResponseBytes === undefined
      ? MAX_RESPONSE_BYTES
      : options.maxResponseBytes;

  if (typeof method !== 'string' || !/^[A-Z]+$/.test(method)) {
    fail('invalid_options', 'Invalid administration options.');
  }
  if (
    typeof requestPath !== 'string' ||
    requestPath.length === 0 ||
    requestPath.length > 2048 ||
    requestPath.includes('\u0000')
  ) {
    fail('invalid_options', 'Invalid administration options.');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    fail('invalid_options', 'Invalid administration options.');
  }
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    fail('invalid_options', 'Invalid administration options.');
  }

  let payload = null;
  const headers = {
    Connection: 'close',
    Accept: 'application/json',
  };
  if (options.body !== undefined) {
    try {
      payload = Buffer.from(JSON.stringify(options.body), 'utf8');
    } catch {
      fail('invalid_options', 'Invalid administration options.');
    }
    headers['Content-Type'] = 'application/json; charset=utf-8';
    headers['Content-Length'] = String(payload.length);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let request = null;
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

    request = http.request(
      {
        socketPath,
        path: requestPath,
        method,
        headers,
      },
      (response) => {
        const chunks = [];
        let total = 0;

        response.on('data', (chunk) => {
          if (settled) {
            return;
          }
          total += chunk.length;
          if (total > maxResponseBytes) {
            response.destroy();
            finish(
              reject,
              new AdminClientError(
                'admin_response_too_large',
                'Administration response is too large.'
              )
            );
            return;
          }
          chunks.push(chunk);
        });

        response.on('end', () => {
          if (settled) {
            return;
          }
          const status = response.statusCode || 0;
          if (status < 200 || status >= 300) {
            finish(
              reject,
              new AdminClientError(
                'admin_request_failed',
                'Administration request failed.',
                status
              )
            );
            return;
          }

          let parsed;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            finish(
              reject,
              new AdminClientError(
                'admin_invalid_response',
                'Administration response is invalid.',
                status
              )
            );
            return;
          }
          finish(resolve, parsed);
        });

        response.on('error', () => {
          finish(
            reject,
            new AdminClientError(
              'admin_unavailable',
              'Administration socket is unavailable.'
            )
          );
        });

        response.on('aborted', () => {
          finish(
            reject,
            new AdminClientError(
              'admin_unavailable',
              'Administration socket is unavailable.'
            )
          );
        });
      }
    );

    request.on('error', (error) => {
      finish(
        reject,
        new AdminClientError(
          'admin_unavailable',
          'Administration socket is unavailable.'
        )
      );
    });

    timer = setTimeout(() => {
      if (request !== null) {
        request.destroy();
      }
      finish(
        reject,
        new AdminClientError(
          'admin_timeout',
          'Administration request timed out.'
        )
      );
    }, timeoutMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    if (payload !== null) {
      request.write(payload);
    }
    request.end();
  });
}

function issuePairing(options) {
  const body = {
    project: options.project,
    role: options.role,
  };
  if (options.expiresMs !== undefined) {
    body.ttlMs = options.expiresMs;
  }
  if (options.origin !== undefined) {
    body.origin = options.origin;
  }
  return adminRequest({
    stateDir: options.stateDir,
    method: 'POST',
    path: '/v1/admin/pair/issue',
    body,
    timeoutMs: options.timeoutMs,
  });
}

function listClients(options) {
  return adminRequest({
    stateDir: options.stateDir,
    method: 'GET',
    path: '/v1/admin/clients',
    timeoutMs: options.timeoutMs,
  });
}

function revokeClient(options) {
  return adminRequest({
    stateDir: options.stateDir,
    method: 'POST',
    path: '/v1/admin/clients/revoke',
    body: { clientId: options.clientId },
    timeoutMs: options.timeoutMs,
  });
}

module.exports = {
  adminRequest,
  issuePairing,
  listClients,
  revokeClient,
  adminSocketPath,
  AdminClientError,
  ADMIN_SOCKET_NAME,
};
