'use strict';

const crypto = require('node:crypto');
const net = require('node:net');
const tls = require('node:tls');

const MAX_BODY_BYTES = 64 * 1024;
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_CREDENTIAL_LENGTH = 8 * 1024;
const MAX_PATH_LENGTH = 1024;
const MAX_ORIGIN_LENGTH = 2048;
const MAX_FINGERPRINT_LENGTH = 128;
const MAX_TIMEOUT_MS = 120 * 1000;
const DEFAULT_TIMEOUT_MS = 30 * 1000;
const MAX_JSON_DEPTH = 32;

class TransportError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'TransportError';
    this.code = code;
    if (details && Number.isInteger(details.statusCode)) {
      this.statusCode = details.statusCode;
    }
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, TransportError);
    }
  }
}

function invalid(code, message) {
  return new TransportError(code, message);
}

function normalizeFingerprint(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_FINGERPRINT_LENGTH) {
    throw invalid('INVALID_FINGERPRINT', 'Invalid certificate fingerprint');
  }

  let hex;
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    hex = value;
  } else if (/^[0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){31}$/.test(value)) {
    hex = value.replace(/:/g, '');
  } else {
    throw invalid('INVALID_FINGERPRINT', 'Invalid certificate fingerprint');
  }

  return hex.toLowerCase();
}

function parseOrigin(origin) {
  if (typeof origin !== 'string' || origin.length === 0 || origin.length > MAX_ORIGIN_LENGTH) {
    throw invalid('INVALID_ORIGIN', 'Invalid HTTPS origin');
  }
  if (origin !== origin.trim() || !/^https:\/\//i.test(origin)) {
    throw invalid('INVALID_ORIGIN', 'Invalid HTTPS origin');
  }

  let url;
  try {
    url = new URL(origin);
  } catch {
    throw invalid('INVALID_ORIGIN', 'Invalid HTTPS origin');
  }

  if (url.protocol !== 'https:') {
    throw invalid('INVALID_ORIGIN', 'Invalid HTTPS origin');
  }
  if (url.username !== '' || url.password !== '') {
    throw invalid('INVALID_ORIGIN', 'Invalid HTTPS origin');
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw invalid('INVALID_ORIGIN', 'Invalid HTTPS origin');
  }
  if (!url.hostname) {
    throw invalid('INVALID_ORIGIN', 'Invalid HTTPS origin');
  }
  if (url.port !== '') {
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw invalid('INVALID_ORIGIN', 'Invalid HTTPS origin');
    }
  }

  // URL normalisation can hide an empty userinfo component or a raw path
  // separator. Check the original authority as well.
  const afterScheme = origin.slice(origin.indexOf('//') + 2);
  const authorityEnd = afterScheme.search(/[/?#\\]/);
  const authority = authorityEnd === -1 ? afterScheme : afterScheme.slice(0, authorityEnd);
  if (authority.includes('@') || authority.includes('\\')) {
    throw invalid('INVALID_ORIGIN', 'Invalid HTTPS origin');
  }
  if (authorityEnd !== -1) {
    const rest = afterScheme.slice(authorityEnd);
    if (rest !== '/') {
      throw invalid('INVALID_ORIGIN', 'Invalid HTTPS origin');
    }
  }
  if (/[\u0000-\u0020\u007f]/.test(url.hostname)) {
    throw invalid('INVALID_ORIGIN', 'Invalid HTTPS origin');
  }

  return url;
}

function validatePath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_LENGTH) {
    throw invalid('INVALID_PATH', 'Invalid request path');
  }
  if (!path.startsWith('/v1/')) {
    throw invalid('INVALID_PATH', 'Invalid request path');
  }
  if (/[^\x21-\x7e]/.test(path) || /[?#\\]/.test(path)) {
    throw invalid('INVALID_PATH', 'Invalid request path');
  }

  const segments = path.slice(1).split('/');
  if (segments.length < 2 || segments[0] !== 'v1') {
    throw invalid('INVALID_PATH', 'Invalid request path');
  }
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw invalid('INVALID_PATH', 'Invalid request path');
    }
    if (!/^[A-Za-z0-9._~-]+$/.test(segment)) {
      throw invalid('INVALID_PATH', 'Invalid request path');
    }
  }

  return path;
}

function validateMethod(method) {
  if (method !== 'GET' && method !== 'POST') {
    throw invalid('INVALID_METHOD', 'Invalid request method');
  }
  return method;
}

function validateCredential(credential) {
  if (credential === undefined || credential === null) {
    return null;
  }
  if (typeof credential !== 'string' || credential.length === 0 ||
      credential.length > MAX_CREDENTIAL_LENGTH) {
    throw invalid('INVALID_CREDENTIAL', 'Invalid credential');
  }
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(credential)) {
    throw invalid('INVALID_CREDENTIAL', 'Invalid credential');
  }

  const unpadded = credential.replace(/=+$/, '');
  if (unpadded.length % 4 === 1) {
    throw invalid('INVALID_CREDENTIAL', 'Invalid credential');
  }
  if (credential.includes('=') && credential.length % 4 !== 0) {
    throw invalid('INVALID_CREDENTIAL', 'Invalid credential');
  }

  let decoded;
  try {
    decoded = Buffer.from(unpadded, 'base64url');
  } catch {
    throw invalid('INVALID_CREDENTIAL', 'Invalid credential');
  }
  if (decoded.toString('base64url') !== unpadded) {
    throw invalid('INVALID_CREDENTIAL', 'Invalid credential');
  }

  return credential;
}

function validateJsonValue(value, depth, seen) {
  if (value === null) {
    return;
  }

  const type = typeof value;
  if (type === 'boolean' || type === 'string') {
    return;
  }
  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw invalid('INVALID_BODY', 'Invalid JSON payload');
    }
    return;
  }
  if (type !== 'object' || depth > MAX_JSON_DEPTH) {
    throw invalid('INVALID_BODY', 'Invalid JSON payload');
  }
  if (seen.has(value)) {
    throw invalid('INVALID_BODY', 'Invalid JSON payload');
  }

  seen.add(value);
  if (Array.isArray(value)) {
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      throw invalid('INVALID_BODY', 'Invalid JSON payload');
    }
    for (let i = 0; i < value.length; i += 1) {
      if (!(i in value)) {
        throw invalid('INVALID_BODY', 'Invalid JSON payload');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      if (!descriptor || descriptor.get || descriptor.set) {
        throw invalid('INVALID_BODY', 'Invalid JSON payload');
      }
      validateJsonValue(value[i], depth + 1, seen);
    }
  } else {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw invalid('INVALID_BODY', 'Invalid JSON payload');
    }
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      throw invalid('INVALID_BODY', 'Invalid JSON payload');
    }
    for (const key of Object.keys(value)) {
      if (key === '__proto__') {
        throw invalid('INVALID_BODY', 'Invalid JSON payload');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.get || descriptor.set) {
        throw invalid('INVALID_BODY', 'Invalid JSON payload');
      }
      validateJsonValue(value[key], depth + 1, seen);
    }
  }
  seen.delete(value);
}

function serializeBody(body, method) {
  if (method === 'GET') {
    if (body !== undefined) {
      throw invalid('INVALID_BODY', 'Invalid JSON payload');
    }
    return null;
  }

  if (body === undefined) {
    return null;
  }

  validateJsonValue(body, 0, new WeakSet());

  let json;
  try {
    json = JSON.stringify(body);
  } catch {
    throw invalid('INVALID_BODY', 'Invalid JSON payload');
  }
  if (typeof json !== 'string') {
    throw invalid('INVALID_BODY', 'Invalid JSON payload');
  }

  const buffer = Buffer.from(json, 'utf8');
  if (buffer.length > MAX_BODY_BYTES) {
    throw invalid('REQUEST_TOO_LARGE', 'Request payload exceeds the 64 KiB limit');
  }
  return buffer;
}

function validateTimeout(timeoutMs) {
  if (timeoutMs === undefined) {
    return DEFAULT_TIMEOUT_MS;
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw invalid('INVALID_ARGUMENT', 'Invalid timeout');
  }
  return timeoutMs;
}

function buildRequestHead({ method, path, host, credential, bodyBuffer }) {
  const lines = [
    `${method} ${path} HTTP/1.1`,
    `Host: ${host}`,
    'Accept: application/json',
    'Connection: close',
  ];
  if (credential) {
    lines.push(`Authorization: Bearer ${credential}`);
  }
  if (method === 'POST') {
    if (bodyBuffer) {
      lines.push('Content-Type: application/json');
      lines.push(`Content-Length: ${bodyBuffer.length}`);
    } else {
      lines.push('Content-Length: 0');
    }
  }
  return Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1');
}

function parseResponseHeaders(headerBuffer) {
  const text = headerBuffer.toString('latin1');
  const lines = text.split('\r\n');
  const statusLine = lines.shift();
  const statusMatch = /^HTTP\/1\.[01] ([0-9]{3})(?: [^\r\n]*)?$/.exec(statusLine || '');
  if (!statusMatch) {
    return null;
  }

  const headers = Object.create(null);
  for (const line of lines) {
    if (line === '' || /^[ \t]/.test(line)) {
      return null;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) {
      return null;
    }
    const name = line.slice(0, colon).toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!/^[!#$%&'*+\-.^_`|~0-9a-z]+$/.test(name)) {
      return null;
    }
    if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(value)) {
      return null;
    }
    if (headers[name] !== undefined) {
      if (name === 'content-length') {
        if (headers[name] !== value) {
          return null;
        }
      } else {
        headers[name] = `${headers[name]}, ${value}`;
      }
    } else {
      headers[name] = value;
    }
  }

  return { statusCode: Number(statusMatch[1]), headers };
}

async function requestJson(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw invalid('INVALID_ARGUMENT', 'Invalid request options');
  }

  let url;
  let fingerprint;
  let method;
  let path;
  let credential;
  let bodyBuffer;
  let timeoutMs;

  try {
    url = parseOrigin(options.origin);
    fingerprint = normalizeFingerprint(options.fingerprint);
    method = validateMethod(options.method);
    path = validatePath(options.path);
    credential = validateCredential(options.credential);
    bodyBuffer = serializeBody(options.body, method);
    timeoutMs = validateTimeout(options.timeoutMs);
  } catch (error) {
    if (error instanceof TransportError) {
      throw error;
    }
    throw invalid('INVALID_ARGUMENT', 'Invalid request options');
  }

  const hostname = url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname;
  const port = url.port === '' ? 443 : Number(url.port);

  return new Promise((resolve, reject) => {
    let settled = false;
    let socket = null;
    let timer = null;
    let headerBuffer = Buffer.alloc(0);
    let headersParsed = false;
    let responseDone = false;
    let closeDelimited = false;
    let contentLength = null;
    let bodyChunks = [];
    let bodyLength = 0;
    let chunkState = null;
    let chunkRemaining = 0;
    let chunkBuffer = Buffer.alloc(0);
    let trailerBytes = 0;

    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimer();
      if (socket && !socket.destroyed) {
        socket.destroy();
      }
      reject(error);
    };

    const succeed = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimer();
      if (socket && !socket.destroyed) {
        socket.destroy();
      }
      resolve(value);
    };

    const appendBody = (piece) => {
      if (bodyLength + piece.length > MAX_BODY_BYTES) {
        fail(invalid('RESPONSE_TOO_LARGE', 'Response payload exceeds the 64 KiB limit'));
        return false;
      }
      bodyChunks.push(Buffer.from(piece));
      bodyLength += piece.length;
      return true;
    };

    const finishResponse = () => {
      if (responseDone || settled) {
        return;
      }
      responseDone = true;
      const body = Buffer.concat(bodyChunks, bodyLength).toString('utf8');
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        fail(invalid('INVALID_RESPONSE', 'Response is not valid JSON'));
        return;
      }
      succeed(parsed);
    };

    const processChunked = (chunk) => {
      chunkBuffer = Buffer.concat([chunkBuffer, chunk]);

      while (!settled && !responseDone) {
        if (chunkState === 'size') {
          const index = chunkBuffer.indexOf('\r\n');
          if (index === -1) {
            if (chunkBuffer.length > 1024) {
              fail(invalid('INVALID_RESPONSE', 'Malformed chunked response'));
            }
            return;
          }
          const line = chunkBuffer.subarray(0, index).toString('latin1');
          chunkBuffer = chunkBuffer.subarray(index + 2);
          if (!/^[0-9a-fA-F]+(?:;[^\r\n]*)?$/.test(line)) {
            fail(invalid('INVALID_RESPONSE', 'Malformed chunked response'));
            return;
          }
          const sizeText = line.split(';', 1)[0];
          const size = Number.parseInt(sizeText, 16);
          if (!Number.isSafeInteger(size) || size < 0) {
            fail(invalid('INVALID_RESPONSE', 'Malformed chunked response'));
            return;
          }
          if (size === 0) {
            chunkState = 'trailer';
            trailerBytes = 0;
            continue;
          }
          if (bodyLength + size > MAX_BODY_BYTES) {
            fail(invalid('RESPONSE_TOO_LARGE', 'Response payload exceeds the 64 KiB limit'));
            return;
          }
          chunkRemaining = size;
          chunkState = 'data';
          continue;
        }

        if (chunkState === 'data') {
          if (chunkBuffer.length === 0) {
            return;
          }
          const take = Math.min(chunkBuffer.length, chunkRemaining);
          const piece = chunkBuffer.subarray(0, take);
          chunkBuffer = chunkBuffer.subarray(take);
          if (!appendBody(piece)) {
            return;
          }
          chunkRemaining -= take;
          if (chunkRemaining === 0) {
            chunkState = 'crlf';
          }
          continue;
        }

        if (chunkState === 'crlf') {
          if (chunkBuffer.length < 2) {
            return;
          }
          if (chunkBuffer[0] !== 13 || chunkBuffer[1] !== 10) {
            fail(invalid('INVALID_RESPONSE', 'Malformed chunked response'));
            return;
          }
          chunkBuffer = chunkBuffer.subarray(2);
          chunkState = 'size';
          continue;
        }

        if (chunkState === 'trailer') {
          const index = chunkBuffer.indexOf('\r\n');
          if (index === -1) {
            if (chunkBuffer.length + trailerBytes > MAX_HEADER_BYTES) {
              fail(invalid('INVALID_RESPONSE', 'Response trailers are too large'));
            }
            return;
          }
          const line = chunkBuffer.subarray(0, index).toString('latin1');
          chunkBuffer = chunkBuffer.subarray(index + 2);
          trailerBytes += index + 2;
          if (trailerBytes > MAX_HEADER_BYTES) {
            fail(invalid('INVALID_RESPONSE', 'Response trailers are too large'));
            return;
          }
          if (line === '') {
            finishResponse();
            return;
          }
          if (/^[ \t]/.test(line) || line.indexOf(':') <= 0) {
            fail(invalid('INVALID_RESPONSE', 'Malformed chunked response'));
            return;
          }
          continue;
        }

        return;
      }
    };

    const processBody = (chunk) => {
      if (settled || responseDone) {
        return;
      }

      if (chunkState !== null) {
        processChunked(chunk);
        return;
      }

      if (contentLength !== null) {
        const remaining = contentLength - bodyLength;
        if (chunk.length > remaining) {
          if (!appendBody(chunk.subarray(0, remaining))) {
            return;
          }
          finishResponse();
          return;
        }
        if (!appendBody(chunk)) {
          return;
        }
        if (bodyLength === contentLength) {
          finishResponse();
        }
        return;
      }

      if (closeDelimited) {
        appendBody(chunk);
      }
    };

    const onData = (chunk) => {
      if (settled || responseDone) {
        return;
      }

      if (!headersParsed) {
        headerBuffer = Buffer.concat([headerBuffer, chunk]);
        const headerEnd = headerBuffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) {
          // No delimiter yet: only the accumulated header prefix is bounded.
          if (headerBuffer.length > MAX_HEADER_BYTES) {
            fail(invalid('RESPONSE_TOO_LARGE', 'Response headers exceed the 16 KiB limit'));
          }
          return;
        }
        // The delimiter is part of the header prefix; body bytes that share
        // this read must not be charged against the header limit.
        if (headerEnd + 4 > MAX_HEADER_BYTES) {
          fail(invalid('RESPONSE_TOO_LARGE', 'Response headers exceed the 16 KiB limit'));
          return;
        }

        const headerPart = headerBuffer.subarray(0, headerEnd);
        const rest = headerBuffer.subarray(headerEnd + 4);
        headerBuffer = Buffer.alloc(0);
        const parsed = parseResponseHeaders(headerPart);
        if (!parsed) {
          fail(invalid('INVALID_RESPONSE', 'Malformed HTTP response'));
          return;
        }
        headersParsed = true;

        if (parsed.statusCode >= 300 && parsed.statusCode <= 399) {
          fail(new TransportError('REDIRECT_NOT_ALLOWED', 'HTTP redirects are not allowed', {
            statusCode: parsed.statusCode,
          }));
          return;
        }
        if (parsed.statusCode < 200 || parsed.statusCode > 299) {
          fail(new TransportError('HTTP_STATUS', `HTTP response status ${parsed.statusCode}`, {
            statusCode: parsed.statusCode,
          }));
          return;
        }

        const transferEncoding = parsed.headers['transfer-encoding'];
        const declaredLength = parsed.headers['content-length'];
        if (transferEncoding !== undefined && declaredLength !== undefined) {
          fail(invalid('INVALID_RESPONSE', 'Ambiguous response framing'));
          return;
        }

        if (transferEncoding !== undefined) {
          const encodings = transferEncoding.toLowerCase().split(',').map((value) => value.trim());
          if (encodings.length !== 1 || encodings[0] !== 'chunked') {
            fail(invalid('INVALID_RESPONSE', 'Unsupported response transfer encoding'));
            return;
          }
          chunkState = 'size';
          chunkRemaining = 0;
          chunkBuffer = Buffer.alloc(0);
          trailerBytes = 0;
        } else if (declaredLength !== undefined) {
          if (!/^[0-9]+$/.test(declaredLength)) {
            fail(invalid('INVALID_RESPONSE', 'Malformed response content length'));
            return;
          }
          const length = Number(declaredLength);
          if (!Number.isSafeInteger(length) || length < 0) {
            fail(invalid('INVALID_RESPONSE', 'Malformed response content length'));
            return;
          }
          if (length > MAX_BODY_BYTES) {
            fail(invalid('RESPONSE_TOO_LARGE', 'Response payload exceeds the 64 KiB limit'));
            return;
          }
          contentLength = length;
        } else {
          closeDelimited = true;
        }

        if (parsed.statusCode === 204 || parsed.statusCode === 304) {
          finishResponse();
          return;
        }
        if (contentLength === 0) {
          finishResponse();
          return;
        }
        if (rest.length > 0) {
          processBody(rest);
        }
        return;
      }

      processBody(chunk);
    };

    const onSecureConnect = () => {
      if (settled) {
        return;
      }

      let peer;
      try {
        peer = socket.getPeerCertificate();
      } catch {
        fail(invalid('TLS_CERT_INVALID', 'Invalid TLS certificate'));
        return;
      }
      if (!peer || !Buffer.isBuffer(peer.raw) || peer.raw.length === 0) {
        fail(invalid('TLS_CERT_INVALID', 'Invalid TLS certificate'));
        return;
      }

      const actual = crypto.createHash('sha256').update(peer.raw).digest('hex');
      if (actual !== fingerprint) {
        fail(invalid('TLS_PIN_MISMATCH', 'TLS certificate fingerprint does not match'));
        return;
      }

      let certificate;
      try {
        certificate = new crypto.X509Certificate(peer.raw);
      } catch {
        fail(invalid('TLS_CERT_INVALID', 'Invalid TLS certificate'));
        return;
      }
      const notBefore = Date.parse(certificate.validFrom);
      const notAfter = Date.parse(certificate.validTo);
      const now = Date.now();
      if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter) ||
          now < notBefore || now > notAfter) {
        fail(invalid('TLS_CERT_INVALID', 'TLS certificate is not currently valid'));
        return;
      }

      let requestHead;
      try {
        requestHead = buildRequestHead({
          method,
          path,
          host: url.host,
          credential,
          bodyBuffer,
        });
      } catch {
        fail(invalid('CONNECTION_ERROR', 'Unable to prepare request'));
        return;
      }

      socket.on('data', onData);
      socket.write(requestHead);
      if (bodyBuffer) {
        socket.write(bodyBuffer);
      }
    };

    const onSocketError = () => {
      if (settled) {
        return;
      }
      fail(invalid('CONNECTION_ERROR', 'TLS connection failed'));
    };

    const onSocketEnd = () => {
      if (settled) {
        return;
      }
      if (headersParsed && closeDelimited && !responseDone) {
        finishResponse();
        return;
      }
      fail(invalid('CONNECTION_CLOSED', 'Connection closed before a complete response'));
    };

    const onSocketClose = () => {
      if (settled) {
        return;
      }
      if (headersParsed && closeDelimited && !responseDone) {
        finishResponse();
        return;
      }
      fail(invalid('CONNECTION_CLOSED', 'Connection closed before a complete response'));
    };

    timer = setTimeout(() => {
      fail(invalid('TIMEOUT', 'Request timed out'));
    }, timeoutMs);

    try {
      socket = tls.connect({
        host: hostname,
        port,
        servername: net.isIP(hostname) ? undefined : hostname,
        rejectUnauthorized: false,
        checkServerIdentity: () => undefined,
        minVersion: 'TLSv1.2',
      });
    } catch {
      fail(invalid('CONNECTION_ERROR', 'Unable to establish TLS connection'));
      return;
    }

    socket.once('secureConnect', onSecureConnect);
    socket.on('error', onSocketError);
    socket.on('end', onSocketEnd);
    socket.on('close', onSocketClose);
  });
}

module.exports = {
  requestJson,
  TransportError,
};
