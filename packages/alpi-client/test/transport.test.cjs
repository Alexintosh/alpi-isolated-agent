'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');
const { test, after } = require('node:test');

const { requestJson } = require('../src/transport.cjs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'alpi-client-transport-'));

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

function opensslTime(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
    'Z',
  ].join('');
}

function makeCertificateWithCa(name, daysBefore, daysAfter, keyPath, certPath) {
  const now = Date.now();
  const notBefore = new Date(now + daysBefore * 24 * 60 * 60 * 1000);
  const notAfter = new Date(now + daysAfter * 24 * 60 * 60 * 1000);
  const caDir = path.join(TMP, `${name}-ca`);

  fs.mkdirSync(path.join(caDir, 'newcerts'), { recursive: true });
  fs.writeFileSync(path.join(caDir, 'index.txt'), '');
  fs.writeFileSync(path.join(caDir, 'serial'), '1000\n');

  const caKeyPath = path.join(caDir, 'ca-key.pem');
  const caCertPath = path.join(caDir, 'ca-cert.pem');
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey', 'rsa:2048',
    '-nodes',
    '-keyout', caKeyPath,
    '-out', caCertPath,
    '-subj', '/CN=Alpi Test CA',
    '-days', '3650',
    '-addext', 'basicConstraints=critical,CA:TRUE',
  ], { stdio: 'ignore' });

  const csrPath = path.join(caDir, `${name}-csr.pem`);
  execFileSync('openssl', [
    'req',
    '-new',
    '-newkey', 'rsa:2048',
    '-nodes',
    '-keyout', keyPath,
    '-out', csrPath,
    '-subj', '/CN=localhost',
  ], { stdio: 'ignore' });

  const configPath = path.join(caDir, 'openssl.cnf');
  fs.writeFileSync(configPath, [
    '[ ca ]',
    'default_ca = CA_default',
    '',
    '[ CA_default ]',
    `dir = ${caDir}`,
    'database = $dir/index.txt',
    'new_certs_dir = $dir/newcerts',
    'certificate = $dir/ca-cert.pem',
    'private_key = $dir/ca-key.pem',
    'serial = $dir/serial',
    'default_days = 365',
    'default_md = sha256',
    'policy = policy_any',
    'unique_subject = no',
    '',
    '[ policy_any ]',
    'commonName = supplied',
    '',
    '[ v3_leaf ]',
    'basicConstraints = critical,CA:TRUE',
    'subjectAltName = DNS:localhost,IP:127.0.0.1',
    '',
  ].join('\n'));

  execFileSync('openssl', [
    'ca',
    '-batch',
    '-config', configPath,
    '-in', csrPath,
    '-out', certPath,
    '-startdate', opensslTime(notBefore),
    '-enddate', opensslTime(notAfter),
    '-extensions', 'v3_leaf',
    '-notext',
    '-md', 'sha256',
  ], { stdio: 'ignore' });
}

function makeCertificate(name, daysBefore, daysAfter) {
  const keyPath = path.join(TMP, `${name}-key.pem`);
  const certPath = path.join(TMP, `${name}-cert.pem`);

  if (daysBefore <= 0 && daysAfter > 0) {
    // Portable normal-valid fixture: -not_before/-not_after are unavailable
    // in the Debian OpenSSL 3.0 req command, but -days is supported.
    execFileSync('openssl', [
      'req',
      '-x509',
      '-newkey', 'rsa:2048',
      '-nodes',
      '-keyout', keyPath,
      '-out', certPath,
      '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-addext', 'basicConstraints=critical,CA:TRUE',
      '-days', String(Math.max(1, Math.ceil(daysAfter))),
    ], { stdio: 'ignore' });
  } else {
    // Expired and not-yet-valid fixtures need explicit dates. openssl ca
    // supports -startdate/-enddate on both OpenSSL 3.0 and newer releases.
    makeCertificateWithCa(name, daysBefore, daysAfter, keyPath, certPath);
  }

  const key = fs.readFileSync(keyPath);
  const cert = fs.readFileSync(certPath);
  const x509 = new crypto.X509Certificate(cert);
  const fingerprint = crypto.createHash('sha256').update(x509.raw).digest('hex');

  return {
    key,
    cert,
    fingerprint,
    keyPath,
    certPath,
  };
}

function colonFingerprint(hex) {
  return hex.toUpperCase().match(/../g).join(':');
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
  });
}

async function startHttpsServer(fixture, handler) {
  const server = https.createServer({ key: fixture.key, cert: fixture.cert }, handler);
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
  return {
    server,
    origin: `https://127.0.0.1:${server.address().port}`,
  };
}

async function startRawTlsServer(fixture, onRequest) {
  const sockets = new Set();
  const server = tls.createServer({ key: fixture.key, cert: fixture.cert }, (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.once('data', () => onRequest(socket));
  });
  server.on('tlsClientError', (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
  return {
    server,
    origin: `https://127.0.0.1:${server.address().port}`,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function waitForServerActivity() {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

test('pinned self-signed POST sends credential and returns parsed JSON', async () => {
  const fixture = makeCertificate('good', -1, 1);
  let seen = null;
  const { server, origin } = await startHttpsServer(fixture, async (request, response) => {
    try {
      const raw = await readRequestBody(request);
      seen = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: raw.toString('utf8'),
      };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        ok: true,
        method: request.method,
        received: JSON.parse(raw.toString('utf8')),
      }));
    } catch {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end('{"ok":false}');
    }
  });

  try {
    const result = await requestJson({
      origin,
      fingerprint: fixture.fingerprint,
      method: 'POST',
      path: '/v1/pair/exchange',
      body: { invite: 'inv_123', nested: { values: [1, 2, 3] } },
      credential: 'dGVzdA',
      timeoutMs: 3000,
    });

    assert.deepEqual(result, {
      ok: true,
      method: 'POST',
      received: { invite: 'inv_123', nested: { values: [1, 2, 3] } },
    });
    assert.equal(seen.method, 'POST');
    assert.equal(seen.url, '/v1/pair/exchange');
    assert.equal(seen.headers.authorization, 'Bearer dGVzdA');
    assert.equal(seen.headers['content-type'], 'application/json');
    assert.equal(seen.body, '{"invite":"inv_123","nested":{"values":[1,2,3]}}');
  } finally {
    await closeServer(server);
  }
});

test('accepts a colon-separated uppercase pin and a GET without a body', async () => {
  const fixture = makeCertificate('colon', -1, 1);
  let seen = null;
  const { server, origin } = await startHttpsServer(fixture, (request, response) => {
    seen = { headers: request.headers };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });

  try {
    const result = await requestJson({
      origin,
      fingerprint: colonFingerprint(fixture.fingerprint),
      method: 'GET',
      path: '/v1/capabilities',
      credential: 'YWJj',
      timeoutMs: 3000,
    });

    assert.deepEqual(result, { ok: true });
    assert.equal(seen.headers.authorization, 'Bearer YWJj');
    assert.equal(seen.headers['content-length'], undefined);
    assert.equal(seen.headers['content-type'], undefined);
  } finally {
    await closeServer(server);
  }
});

test('mismatched pin aborts before any HTTP request bytes', async () => {
  const serverFixture = makeCertificate('pinned', -1, 1);
  const wrongFixture = makeCertificate('wrong', -1, 1);
  let requests = 0;
  let applicationBytes = 0;

  const { server, origin } = await startHttpsServer(serverFixture, (_request, response) => {
    requests += 1;
    response.end('{"ok":true}');
  });
  server.on('secureConnection', (socket) => {
    socket.on('data', (chunk) => {
      applicationBytes += chunk.length;
    });
  });

  try {
    await assert.rejects(
      requestJson({
        origin,
        fingerprint: wrongFixture.fingerprint,
        method: 'GET',
        path: '/v1/capabilities',
        timeoutMs: 2000,
      }),
      (error) => {
        assert.equal(error.name, 'TransportError');
        assert.equal(error.code, 'TLS_PIN_MISMATCH');
        assert.equal(String(error).includes(wrongFixture.fingerprint), false);
        return true;
      },
    );

    await waitForServerActivity();
    assert.equal(requests, 0);
    assert.equal(applicationBytes, 0);
  } finally {
    await closeServer(server);
  }
});

test('does not fall back to default trust for a mismatched pin', async () => {
  const trusted = makeCertificate('trusted', -1, 1);
  const wrong = makeCertificate('trusted-wrong', -1, 1);
  const scriptPath = path.join(TMP, 'default-trust-child.cjs');
  const transportPath = path.resolve(__dirname, '../src/transport.cjs');

  fs.writeFileSync(scriptPath, [
    "'use strict';",
    "const https = require('node:https');",
    "const fs = require('node:fs');",
    "const { requestJson } = require(process.argv[2]);",
    "const key = fs.readFileSync(process.argv[3]);",
    "const cert = fs.readFileSync(process.argv[4]);",
    "const wrongPin = process.argv[5];",
    "const server = https.createServer({ key, cert }, (_request, response) => {",
    "  response.writeHead(200, { 'content-type': 'application/json' });",
    "  response.end('{\"defaultTrust\":true}');",
    "});",
    "server.on('clientError', (_error, socket) => socket.destroy());",
    "server.listen(0, '127.0.0.1', async () => {",
    "  const origin = `https://127.0.0.1:${server.address().port}`;",
    "  try {",
    "    await requestJson({",
    "      origin,",
    "      fingerprint: wrongPin,",
    "      method: 'GET',",
    "      path: '/v1/capabilities',",
    "      timeoutMs: 2000,",
    "    });",
    "    console.log('ACCEPTED');",
    "    process.exitCode = 1;",
    "  } catch (error) {",
    "    console.log(error.code);",
    "    process.exitCode = error.code === 'TLS_PIN_MISMATCH' ? 0 : 1;",
    "  } finally {",
    "    server.close();",
    "  }",
    "});",
  ].join('\n'));

  const child = spawnSync(process.execPath, [
    scriptPath,
    transportPath,
    trusted.keyPath,
    trusted.certPath,
    wrong.fingerprint,
  ], {
    encoding: 'utf8',
    timeout: 10000,
    env: {
      ...process.env,
      NODE_EXTRA_CA_CERTS: trusted.certPath,
    },
  });

  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.match(child.stdout, /TLS_PIN_MISMATCH/);
});

test('rejects expired and not-yet-valid certificates before request bytes', async () => {
  const fixtures = [
    ['expired', makeCertificate('expired', -2, -1)],
    ['not-yet-valid', makeCertificate('future', 1, 2)],
  ];

  for (const [name, fixture] of fixtures) {
    let requests = 0;
    let applicationBytes = 0;
    const { server, origin } = await startHttpsServer(fixture, (_request, response) => {
      requests += 1;
      response.end('{"ok":true}');
    });
    server.on('secureConnection', (socket) => {
      socket.on('data', (chunk) => {
        applicationBytes += chunk.length;
      });
    });

    try {
      await assert.rejects(
        requestJson({
          origin,
          fingerprint: fixture.fingerprint,
          method: 'GET',
          path: '/v1/capabilities',
          timeoutMs: 2000,
        }),
        (error) => {
          assert.equal(error.code, 'TLS_CERT_INVALID', name);
          return true;
        },
      );

      await waitForServerActivity();
      assert.equal(requests, 0, name);
      assert.equal(applicationBytes, 0, name);
    } finally {
      await closeServer(server);
    }
  }
});

test('rejects malformed HTTPS origins without making a connection', async () => {
  const pin = 'a'.repeat(64);
  const origins = [
    'http://127.0.0.1:1',
    'ftp://127.0.0.1:1',
    'not-a-url',
    'https://127.0.0.1:1/v1',
    'https://127.0.0.1:1//',
    'https://127.0.0.1:1/?q=1',
    'https://127.0.0.1:1/#x',
    'https://127.0.0.1:1/ ',
    'https://user:pass@127.0.0.1:1',
    'https://@127.0.0.1:1',
    'https://127.0.0.1:0',
    'https://127.0.0.1:65536',
    'https://127.0.0.1:abc',
    ' https://127.0.0.1:1',
    'https://127.0.0.1:1 ',
  ];

  for (const origin of origins) {
    await assert.rejects(
      requestJson({
        origin,
        fingerprint: pin,
        method: 'GET',
        path: '/v1/capabilities',
        timeoutMs: 1000,
      }),
      (error) => {
        assert.equal(error.code, 'INVALID_ORIGIN', origin);
        return true;
      },
    );
  }
});

test('rejects invalid pins', async () => {
  const origin = 'https://127.0.0.1:1';
  const pins = [
    '',
    'a'.repeat(63),
    'a'.repeat(65),
    'g'.repeat(64),
    `sha256:${'a'.repeat(64)}`,
    `${'aa:'.repeat(31)}aa:`,
    `${'aa:'.repeat(32)}`,
    'aa:'.repeat(32),
    null,
    123,
  ];

  for (const fingerprint of pins) {
    await assert.rejects(
      requestJson({
        origin,
        fingerprint,
        method: 'GET',
        path: '/v1/capabilities',
        timeoutMs: 1000,
      }),
      (error) => {
        assert.equal(error.code, 'INVALID_FINGERPRINT', String(fingerprint));
        return true;
      },
    );
  }
});

test('rejects paths outside the fixed /v1/ shape and traversal forms', async () => {
  const origin = 'https://127.0.0.1:1';
  const pin = 'a'.repeat(64);
  const paths = [
    '/v2/capabilities',
    '/v1',
    '/v1/',
    '/v1//capabilities',
    '/v1/../capabilities',
    '/v1/./capabilities',
    '/v1/%2e%2e/capabilities',
    '/v1/%2fcapabilities',
    '/v1/capabilities?x=1',
    '/v1/capabilities#x',
    '/v1/capabilities\\x',
    'https://evil.example/v1/capabilities',
    '//evil.example/v1/capabilities',
    '/v1/cap abilities',
  ];

  for (const path of paths) {
    await assert.rejects(
      requestJson({
        origin,
        fingerprint: pin,
        method: 'GET',
        path,
        timeoutMs: 1000,
      }),
      (error) => {
        assert.equal(error.code, 'INVALID_PATH', path);
        return true;
      },
    );
  }
});

test('rejects unsupported methods', async () => {
  const origin = 'https://127.0.0.1:1';
  const pin = 'a'.repeat(64);

  for (const method of ['PUT', 'DELETE', 'PATCH', 'get', 'post', '', undefined, 1]) {
    await assert.rejects(
      requestJson({
        origin,
        fingerprint: pin,
        method,
        path: '/v1/capabilities',
        timeoutMs: 1000,
      }),
      (error) => {
        assert.equal(error.code, 'INVALID_METHOD', String(method));
        return true;
      },
    );
  }
});

test('rejects invalid credentials without echoing them', async () => {
  const origin = 'https://127.0.0.1:1';
  const pin = 'a'.repeat(64);
  const credentials = [
    '',
    'a',
    'ab==',
    'abc$',
    'dGVzdA===',
    'dGVzd A',
    'x'.repeat(8193),
    123,
  ];

  for (const credential of credentials) {
    await assert.rejects(
      requestJson({
        origin,
        fingerprint: pin,
        method: 'GET',
        path: '/v1/capabilities',
        credential,
        timeoutMs: 1000,
      }),
      (error) => {
        assert.equal(error.code, 'INVALID_CREDENTIAL');
        assert.equal(error.message, 'Invalid credential');
        if (typeof credential === 'string' && credential.length >= 8) {
          assert.equal(String(error).includes(credential), false);
        }
        return true;
      },
    );
  }
});

test('accepts a padded base64url credential', async () => {
  const fixture = makeCertificate('padded', -1, 1);
  let authorization = null;
  const { server, origin } = await startHttpsServer(fixture, (request, response) => {
    authorization = request.headers.authorization;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });

  try {
    const result = await requestJson({
      origin,
      fingerprint: fixture.fingerprint,
      method: 'GET',
      path: '/v1/capabilities',
      credential: 'dGVzdA==',
      timeoutMs: 3000,
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(authorization, 'Bearer dGVzdA==');
  } finally {
    await closeServer(server);
  }
});

test('rejects unsafe JSON payloads', async () => {
  const origin = 'https://127.0.0.1:1';
  const pin = 'a'.repeat(64);
  const cyclic = {};
  cyclic.self = cyclic;
  const protoKey = JSON.parse('{"__proto__":1}');
  const bodies = [
    { value: Number.NaN },
    { value: Number.POSITIVE_INFINITY },
    { value: 1n },
    { value: () => 1 },
    { value: undefined },
    new Date(),
    cyclic,
    protoKey,
    [1, , 3],
  ];

  for (const body of bodies) {
    await assert.rejects(
      requestJson({
        origin,
        fingerprint: pin,
        method: 'POST',
        path: '/v1/pair/exchange',
        body,
        timeoutMs: 1000,
      }),
      (error) => {
        assert.equal(error.code, 'INVALID_BODY');
        return true;
      },
    );
  }

  await assert.rejects(
    requestJson({
      origin,
      fingerprint: pin,
      method: 'GET',
      path: '/v1/capabilities',
      body: { any: 'body' },
      timeoutMs: 1000,
    }),
    (error) => {
      assert.equal(error.code, 'INVALID_BODY');
      return true;
    },
  );
});

test('rejects request payloads over 64 KiB before connecting', async () => {
  await assert.rejects(
    requestJson({
      origin: 'https://127.0.0.1:1',
      fingerprint: 'a'.repeat(64),
      method: 'POST',
      path: '/v1/pair/exchange',
      body: { payload: 'x'.repeat(64 * 1024) },
      timeoutMs: 1000,
    }),
    (error) => {
      assert.equal(error.code, 'REQUEST_TOO_LARGE');
      return true;
    },
  );
});

test('accepts a request body of exactly 64 KiB', async () => {
  const fixture = makeCertificate('boundary-request', -1, 1);
  const target = 64 * 1024;
  const prefix = '{"data":"';
  const suffix = '"}';
  const payloadLength = target - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
  const body = { data: 'x'.repeat(payloadLength) };
  assert.equal(Buffer.byteLength(JSON.stringify(body)), target);

  let receivedBytes = 0;
  const { server, origin } = await startHttpsServer(fixture, async (request, response) => {
    const raw = await readRequestBody(request);
    receivedBytes = raw.length;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });

  try {
    const result = await requestJson({
      origin,
      fingerprint: fixture.fingerprint,
      method: 'POST',
      path: '/v1/pair/exchange',
      body,
      timeoutMs: 3000,
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(receivedBytes, target);
  } finally {
    await closeServer(server);
  }
});

test('accepts a response body of exactly 64 KiB', async () => {
  const fixture = makeCertificate('boundary-response', -1, 1);
  const target = 64 * 1024;
  const prefix = '{"data":"';
  const suffix = '"}';
  const payloadLength = target - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
  const body = `${prefix}${'x'.repeat(payloadLength)}${suffix}`;
  assert.equal(Buffer.byteLength(body), target);

  const { server, origin } = await startHttpsServer(fixture, (_request, response) => {
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-length': String(target),
    });
    response.end(body);
  });

  try {
    const result = await requestJson({
      origin,
      fingerprint: fixture.fingerprint,
      method: 'GET',
      path: '/v1/capabilities',
      timeoutMs: 3000,
    });
    assert.equal(result.data.length, payloadLength);
  } finally {
    await closeServer(server);
  }
});

test('accepts a small fragmented header with a coalesced body over 16 KiB', async () => {
  const fixture = makeCertificate('fragmented-header', -1, 1);
  const payloadLength = 20 * 1024;
  const body = JSON.stringify({ data: 'x'.repeat(payloadLength) });
  assert.ok(Buffer.byteLength(body) > 16 * 1024);
  assert.ok(Buffer.byteLength(body) <= 64 * 1024);

  const raw = await startRawTlsServer(fixture, (socket) => {
    socket.write('HTTP/1.1 200 OK\r\n');
    socket.write('Content-Type: application/json\r\n');
    socket.write(`Content-Length: ${Buffer.byteLength(body)}\r\n`);
    setTimeout(() => {
      socket.write(`\r\n${body}`);
    }, 20);
  });

  try {
    const result = await requestJson({
      origin: raw.origin,
      fingerprint: fixture.fingerprint,
      method: 'GET',
      path: '/v1/capabilities',
      timeoutMs: 3000,
    });
    assert.equal(result.data.length, payloadLength);
  } finally {
    await raw.close();
  }
});

test('still rejects a response header prefix over 16 KiB', async () => {
  const fixture = makeCertificate('oversized-header', -1, 1);
  const body = '{"ok":true}';
  const raw = await startRawTlsServer(fixture, (socket) => {
    socket.write('HTTP/1.1 200 OK\r\n');
    socket.write(`X-Fill: ${'a'.repeat(17 * 1024)}\r\n`);
    socket.write('Content-Type: application/json\r\n');
    socket.write(`Content-Length: ${Buffer.byteLength(body)}\r\n`);
    socket.write(`\r\n${body}`);
  });

  try {
    await assert.rejects(
      requestJson({
        origin: raw.origin,
        fingerprint: fixture.fingerprint,
        method: 'GET',
        path: '/v1/capabilities',
        timeoutMs: 3000,
      }),
      (error) => {
        assert.equal(error.code, 'RESPONSE_TOO_LARGE');
        return true;
      },
    );
  } finally {
    await raw.close();
  }
});

test('rejects a declared response payload over 64 KiB with a sanitized error', async () => {
  const fixture = makeCertificate('large', -1, 1);
  const secret = 'RESPONSE_BODY_SECRET';
  const body = `${secret}${'x'.repeat(70 * 1024)}`;
  const { server, origin } = await startHttpsServer(fixture, (_request, response) => {
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
    });
    response.end(body);
  });

  try {
    await assert.rejects(
      requestJson({
        origin,
        fingerprint: fixture.fingerprint,
        method: 'GET',
        path: '/v1/capabilities',
        timeoutMs: 3000,
      }),
      (error) => {
        assert.equal(error.code, 'RESPONSE_TOO_LARGE');
        assert.equal(String(error).includes(secret), false);
        assert.equal(String(error).includes('xxxxx'), false);
        return true;
      },
    );
  } finally {
    await closeServer(server);
  }
});

test('rejects a chunked response over 64 KiB with a sanitized error', async () => {
  const fixture = makeCertificate('chunked', -1, 1);
  const secret = 'CHUNKED_BODY_SECRET';
  const { server, origin } = await startHttpsServer(fixture, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write(secret);
    for (let i = 0; i < 70; i += 1) {
      response.write('x'.repeat(1024));
    }
    response.end();
  });
  server.on('clientError', (_error, socket) => socket.destroy());

  try {
    await assert.rejects(
      requestJson({
        origin,
        fingerprint: fixture.fingerprint,
        method: 'GET',
        path: '/v1/capabilities',
        timeoutMs: 3000,
      }),
      (error) => {
        assert.equal(error.code, 'RESPONSE_TOO_LARGE');
        assert.equal(String(error).includes(secret), false);
        return true;
      },
    );
  } finally {
    await closeServer(server);
  }
});

test('maps HTTP errors and redirects to typed sanitized errors', async () => {
  const fixture = makeCertificate('status', -1, 1);
  const secret = 'HTTP_BODY_SECRET';
  let mode = 'error';
  const { server, origin } = await startHttpsServer(fixture, (_request, response) => {
    if (mode === 'error') {
      response.writeHead(500, {
        'content-type': 'text/plain',
        'x-secret': secret,
      });
      response.end(secret);
      return;
    }
    response.writeHead(302, {
      location: 'https://example.com/',
      'x-secret': secret,
    });
    response.end(secret);
  });

  try {
    await assert.rejects(
      requestJson({
        origin,
        fingerprint: fixture.fingerprint,
        method: 'GET',
        path: '/v1/capabilities',
        timeoutMs: 3000,
      }),
      (error) => {
        assert.equal(error.code, 'HTTP_STATUS');
        assert.equal(error.statusCode, 500);
        assert.equal(String(error).includes(secret), false);
        return true;
      },
    );

    mode = 'redirect';
    await assert.rejects(
      requestJson({
        origin,
        fingerprint: fixture.fingerprint,
        method: 'GET',
        path: '/v1/capabilities',
        timeoutMs: 3000,
      }),
      (error) => {
        assert.equal(error.code, 'REDIRECT_NOT_ALLOWED');
        assert.equal(error.statusCode, 302);
        assert.equal(String(error).includes(secret), false);
        return true;
      },
    );
  } finally {
    await closeServer(server);
  }
});

test('invalid JSON responses produce a sanitized typed error', async () => {
  const fixture = makeCertificate('badjson', -1, 1);
  const secret = 'NOT_JSON_SECRET';
  const { server, origin } = await startHttpsServer(fixture, (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(secret);
  });

  try {
    await assert.rejects(
      requestJson({
        origin,
        fingerprint: fixture.fingerprint,
        method: 'GET',
        path: '/v1/capabilities',
        timeoutMs: 3000,
      }),
      (error) => {
        assert.equal(error.code, 'INVALID_RESPONSE');
        assert.equal(String(error).includes(secret), false);
        return true;
      },
    );
  } finally {
    await closeServer(server);
  }
});

test('absolute deadline covers a stalled TLS handshake', async () => {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const origin = `https://127.0.0.1:${server.address().port}`;
  const started = Date.now();

  try {
    await assert.rejects(
      requestJson({
        origin,
        fingerprint: 'a'.repeat(64),
        method: 'GET',
        path: '/v1/capabilities',
        timeoutMs: 150,
      }),
      (error) => {
        assert.equal(error.code, 'TIMEOUT');
        return true;
      },
    );
    assert.ok(Date.now() - started < 1500);
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    await closeServer(server);
  }
});

test('absolute deadline covers a stalled response', async () => {
  const fixture = makeCertificate('stalled', -1, 1);
  const { server, origin } = await startHttpsServer(fixture, () => {
    // Deliberately never respond.
  });

  try {
    await assert.rejects(
      requestJson({
        origin,
        fingerprint: fixture.fingerprint,
        method: 'GET',
        path: '/v1/capabilities',
        timeoutMs: 150,
      }),
      (error) => {
        assert.equal(error.code, 'TIMEOUT');
        return true;
      },
    );
  } finally {
    await closeServer(server);
  }
});

test('truncated responses produce a typed close error', async () => {
  const fixture = makeCertificate('truncated', -1, 1);
  const { server, origin } = await startHttpsServer(fixture, (_request, response) => {
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-length': '100',
    });
    response.write('{"a":');
    response.socket.end();
  });

  try {
    await assert.rejects(
      requestJson({
        origin,
        fingerprint: fixture.fingerprint,
        method: 'GET',
        path: '/v1/capabilities',
        timeoutMs: 3000,
      }),
      (error) => {
        assert.equal(error.name, 'TransportError');
        assert.ok(error.code === 'CONNECTION_CLOSED' || error.code === 'CONNECTION_ERROR');
        return true;
      },
    );
  } finally {
    await closeServer(server);
  }
});

test('a close-delimited JSON response is accepted', async () => {
  const fixture = makeCertificate('closedelim', -1, 1);
  const { server, origin } = await startHttpsServer(fixture, (_request, response) => {
    response.useChunkedEncodingByDefault = false;
    response.shouldKeepAlive = false;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"ok":');
    response.write('true}');
    response.end();
  });

  try {
    const result = await requestJson({
      origin,
      fingerprint: fixture.fingerprint,
      method: 'GET',
      path: '/v1/capabilities',
      timeoutMs: 3000,
    });
    assert.deepEqual(result, { ok: true });
  } finally {
    await closeServer(server);
  }
});
