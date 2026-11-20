'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { startServer, ADMIN_LOCK_MAGIC } = require('../src/daemon.cjs');
const { ensureIdentity } = require('../src/identity.cjs');
const {
  issuePairing,
  listClients,
  revokeClient,
} = require('../src/admin-client.cjs');

const SOURCE_IDENTITY = path.resolve(__dirname, '../src/identity.cjs');
const SOURCE_DAEMON = path.resolve(__dirname, '../src/daemon.cjs');
const BIN = path.resolve(__dirname, '../bin/alpi-server.cjs');
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INVITE_TTL_MS = 5 * 60 * 1000;

function tempDirectory(t) {
  // Linux /tmp is shared. Give the state directory a trusted private parent.
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'alpi-d-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const state = path.join(parent, 's');
  fs.mkdirSync(state, { mode: 0o700 });
  return state;
}

function startTestServer(t, options) {
  const promise = startServer({
    listenHost: '127.0.0.1',
    port: 0,
    handleSignals: false,
    ...options,
  });
  t.after(async () => {
    const server = await promise.catch(() => null);
    if (server) {
      await server.close();
    }
  });
  return promise;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function requestHttps(origin, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(options.path || '/', origin);
    const headers = { ...(options.headers || {}) };
    const method = options.method || 'GET';
    const request = https.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method,
        headers,
        rejectUnauthorized: false,
        agent: false,
      },
      (response) => {
        const chunks = [];
        let total = 0;
        response.on('data', (chunk) => {
          total += chunk.length;
          if (total > 1024 * 1024) {
            response.destroy();
            reject(new Error('response too large'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const peer =
            response.socket &&
            typeof response.socket.getPeerCertificate === 'function'
              ? response.socket.getPeerCertificate()
              : null;
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body,
            json: parseJson(body),
            peerFingerprint: peer ? peer.fingerprint256 : undefined,
          });
        });
        response.on('error', reject);
        response.on('aborted', () => reject(new Error('response aborted')));
      }
    );

    request.on('error', reject);
    request.setTimeout(options.timeoutMs || 5000, () => {
      request.destroy(new Error('request timeout'));
    });

    if (options.body !== undefined) {
      request.write(options.body);
    }
    request.end();
  });
}

function jsonRequest(origin, requestPath, options = {}) {
  const body =
    options.body === undefined ? undefined : JSON.stringify(options.body);
  const headers = { ...(options.headers || {}) };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json; charset=utf-8';
    headers['Content-Length'] = String(Buffer.byteLength(body, 'utf8'));
  }
  return requestHttps(origin, {
    path: requestPath,
    method: options.method || 'POST',
    headers,
    body,
    timeoutMs: options.timeoutMs,
  });
}

function spawnCli(args, options = {}) {
  const child = spawn(process.execPath, [BIN, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_NO_WARNINGS: '1', ...(options.env || {}) },
  });
  const state = {
    child,
    stdout: '',
    stderr: '',
  };
  child.stdout.on('data', (chunk) => {
    state.stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk) => {
    state.stderr += chunk.toString('utf8');
  });
  return state;
}

function waitForListening(state, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const check = () => {
      const match = /alpi-server listening on (https:\/\/\S+)/.exec(
        state.stderr
      );
      if (match) {
        finish(resolve, match[1]);
      }
    };
    const onData = () => check();
    const timer = setTimeout(() => {
      finish(
        reject,
        new Error(`timed out waiting for listener; stderr=${state.stderr}`)
      );
    }, timeoutMs);
    const finish = (handler, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      state.child.stderr.removeListener('data', onData);
      state.child.stdout.removeListener('data', onData);
      handler(value);
    };
    state.child.stderr.on('data', onData);
    state.child.stdout.on('data', onData);
    check();
  });
}

function waitForExit(child, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('timed out waiting for process exit'));
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function runCli(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1', ...(options.env || {}) },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, 20000);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function runNode(workerCode, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', workerCode, ...args], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', () => resolve({ code: -1, stdout }));
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

function spawnWorker(workerCode, args) {
  const child = spawn(process.execPath, ['-e', workerCode, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  const state = {
    child,
    stdout: '',
    stderr: '',
  };
  child.stdout.on('data', (chunk) => {
    state.stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk) => {
    state.stderr += chunk.toString('utf8');
  });
  return state;
}

function waitForWorkerOutput(state, predicate, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (handler, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      state.child.stdout.removeListener('data', onData);
      handler(value);
    };
    const check = () => {
      const line = state.stdout
        .split('\n')
        .find((entry) => predicate(entry));
      if (line !== undefined) {
        finish(resolve, line);
      }
    };
    const onData = () => check();
    const timer = setTimeout(() => {
      finish(
        reject,
        new Error(
          `timed out waiting for worker output; stdout=${state.stdout} stderr=${state.stderr}`
        )
      );
    }, timeoutMs);
    state.child.stdout.on('data', onData);
    check();
  });
}

function connectTcp(port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ port, host });
    const onError = (error) => {
      socket.removeListener('connect', onConnect);
      reject(error);
    };
    const onConnect = () => {
      socket.removeListener('error', onError);
      socket.on('error', () => {
        // A peer reset is expected during shutdown; the close event follows.
      });
      resolve(socket);
    };
    socket.once('error', onError);
    socket.once('connect', onConnect);
  });
}

function waitForClientClose(socket, timeoutMs = 5000) {
  if (socket.destroyed) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('client socket did not close'));
    }, timeoutMs);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function assertToken(value) {
  assert.equal(typeof value, 'string');
  assert.match(value, TOKEN_PATTERN);
  assert.equal(Buffer.from(value, 'base64url').length, 32);
}

test('--help is executable and documents every command', async () => {
  const result = await runCli(['--help']);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /^Usage:/);
  for (const text of [
    'alpi-server serve',
    'alpi-server pair issue',
    'alpi-server clients list',
    'alpi-server clients revoke',
    '--state-dir',
    '--listen',
    '--port',
    '--origin',
    '--expires',
    'admin.sock',
  ]) {
    assert.ok(result.stdout.includes(text), `help should mention ${text}`);
  }

  const nestedHelp = await runCli(['clients', 'revoke', '--help']);
  assert.equal(nestedHelp.code, 0);
  assert.equal(nestedHelp.stderr, '');
  assert.match(nestedHelp.stdout, /^Usage:/);
});

test('TLS identity, server ID and unrelated files persist across restart', async (t) => {
  const directory = tempDirectory(t, 'identity');
  const notesPath = path.join(directory, 'notes.txt');
  fs.writeFileSync(notesPath, 'unrelated operator data', { mode: 0o600 });

  const first = await startTestServer(t, { stateDir: directory });
  const identityResponse = await requestHttps(first.origin, {
    path: '/v1/identity',
  });
  assert.equal(identityResponse.status, 200);
  assert.deepEqual(identityResponse.json, { serverId: first.serverId });
  assert.match(first.serverId, UUID_PATTERN);

  const certPath = path.join(directory, 'tls', 'cert.pem');
  const keyPath = path.join(directory, 'tls', 'key.pem');
  const certPem = fs.readFileSync(certPath, 'utf8');
  const keyPem = fs.readFileSync(keyPath, 'utf8');
  assert.match(certPem, /BEGIN CERTIFICATE/);
  assert.match(keyPem, /BEGIN PRIVATE KEY/);

  const certificate = new crypto.X509Certificate(certPem);
  assert.equal(certificate.fingerprint256, first.fingerprint);
  assert.equal(certificate.verify(certificate.publicKey), true);
  assert.equal(
    crypto
      .createPublicKey(crypto.createPrivateKey(keyPem))
      .export({ type: 'spki', format: 'der' })
      .equals(
        certificate.publicKey.export({ type: 'spki', format: 'der' })
      ),
    true
  );

  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(directory, 'tls')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(certPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(directory, 'admin.sock')).mode & 0o777, 0o600);
  assert.equal(
    fs.statSync(path.join(directory, 'admin.sock.lock')).mode & 0o777,
    0o600
  );
  assert.equal(
    fs.statSync(path.join(directory, 'pairing.sqlite')).mode & 0o777,
    0o600
  );

  await first.close();
  assert.equal(fs.existsSync(path.join(directory, 'admin.sock')), false);
  assert.equal(fs.existsSync(path.join(directory, 'identity.lock')), false);

  const second = await startTestServer(t, { stateDir: directory });
  assert.equal(second.serverId, first.serverId);
  assert.equal(second.fingerprint, first.fingerprint);
  assert.equal(fs.readFileSync(certPath, 'utf8'), certPem);
  assert.equal(fs.readFileSync(keyPath, 'utf8'), keyPem);
  assert.equal(fs.readFileSync(notesPath, 'utf8'), 'unrelated operator data');

  const identityAgain = await requestHttps(second.origin, {
    path: '/v1/identity',
  });
  assert.deepEqual(identityAgain.json, { serverId: first.serverId });
});

test('corrupt or incomplete identity is rejected without silent rotation', async (t) => {
  const corruptDirectory = tempDirectory(t, 'corrupt');
  const generated = await ensureIdentity(corruptDirectory);
  const certPath = path.join(corruptDirectory, 'tls', 'cert.pem');
  const keyPath = path.join(corruptDirectory, 'tls', 'key.pem');
  const originalKey = fs.readFileSync(keyPath, 'utf8');

  fs.writeFileSync(certPath, 'this is not a certificate\n', { mode: 0o600 });

  await assert.rejects(
    startServer({
      stateDir: corruptDirectory,
      port: 0,
      handleSignals: false,
    }),
    (error) => error.code === 'identity_corrupt'
  );
  assert.equal(
    fs.readFileSync(certPath, 'utf8'),
    'this is not a certificate\n'
  );
  assert.equal(fs.readFileSync(keyPath, 'utf8'), originalKey);
  assert.equal(fs.existsSync(path.join(corruptDirectory, 'admin.sock')), false);
  assert.equal(
    fs.existsSync(path.join(corruptDirectory, 'admin.sock.lock')),
    false
  );
  assert.notEqual(generated.fingerprint, '');

  const incompleteDirectory = tempDirectory(t, 'incomplete');
  await ensureIdentity(incompleteDirectory);
  const incompleteCert = path.join(incompleteDirectory, 'tls', 'cert.pem');
  const incompleteKey = path.join(incompleteDirectory, 'tls', 'key.pem');
  const certBefore = fs.readFileSync(incompleteCert, 'utf8');
  fs.unlinkSync(incompleteKey);

  await assert.rejects(
    startServer({
      stateDir: incompleteDirectory,
      port: 0,
      handleSignals: false,
    }),
    (error) => error.code === 'identity_corrupt'
  );
  assert.equal(fs.readFileSync(incompleteCert, 'utf8'), certBefore);
  assert.equal(fs.existsSync(incompleteKey), false);
});

test('concurrent identity generation is serialized across processes', async (t) => {
  const directory = tempDirectory(t, 'concurrent-identity');
  const worker = `
const { ensureIdentity } = require(${JSON.stringify(SOURCE_IDENTITY)});
try {
  const identity = ensureIdentity(process.argv[1]);
  process.stdout.write(identity.fingerprint);
} catch (error) {
  process.stdout.write('ERROR:' + (error && error.code));
  process.exitCode = 1;
}
`;

  const results = await Promise.all(
    Array.from({ length: 4 }, () => runNode(worker, [directory]))
  );
  const fingerprints = results.map((result) => {
    assert.equal(result.code, 0);
    assert.ok(!result.stdout.startsWith('ERROR:'));
    return result.stdout;
  });
  assert.equal(new Set(fingerprints).size, 1);
  assert.match(fingerprints[0], /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/);

  const identity = await ensureIdentity(directory);
  assert.equal(identity.fingerprint, fingerprints[0]);

  const staleDirectory = tempDirectory(t, 'stale-identity-lock');
  const staleLock = path.join(staleDirectory, 'identity.lock');
  fs.writeFileSync(staleLock, '', { mode: 0o600 });
  const old = new Date(Date.now() - 20_000);
  fs.utimesSync(staleLock, old, old);
  const recovered = await ensureIdentity(staleDirectory);
  assert.match(recovered.fingerprint, /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/);
  assert.equal(fs.existsSync(staleLock), false);
});

test('private administration socket is separate from the network surface', async (t) => {
  const directory = tempDirectory(t, 'admin');
  const server = await startTestServer(t, { stateDir: directory });

  for (const attempt of [
    { path: '/v1/admin/clients', method: 'GET' },
    { path: '/v1/admin/pair/issue', method: 'POST', body: {} },
    { path: '/v1/admin/clients/revoke', method: 'POST', body: {} },
  ]) {
    const response = await jsonRequest(server.origin, attempt.path, {
      method: attempt.method,
      body: attempt.body,
    });
    assert.equal(response.status, 404);
    assert.deepEqual(response.json, { error: 'not_found' });
  }

  const envelope = await issuePairing({
    stateDir: directory,
    project: 'demo-project',
    role: 'runner',
  });
  assert.deepEqual(Object.keys(envelope), [
    'origin',
    'serverId',
    'fingerprint',
    'invitation',
    'expiresAt',
  ]);
  assert.equal(envelope.origin, server.origin);
  assert.equal(envelope.serverId, server.serverId);
  assert.equal(envelope.fingerprint, server.fingerprint);
  assertToken(envelope.invitation);
  assert.ok(envelope.expiresAt > Date.now());
  assert.ok(envelope.expiresAt <= Date.now() + INVITE_TTL_MS);

  const exchange = await jsonRequest(server.origin, '/v1/pair/exchange', {
    body: { invitation: envelope.invitation, name: 'worker-one' },
  });
  assert.equal(exchange.status, 200);
  assert.deepEqual(Object.keys(exchange.json).sort(), [
    'clientId',
    'credential',
    'expiresAt',
    'project',
    'role',
  ]);
  assertToken(exchange.json.credential);
  assert.match(exchange.json.clientId, UUID_PATTERN);
  assert.equal(exchange.json.project, 'demo-project');
  assert.equal(exchange.json.role, 'runner');

  const capabilities = await requestHttps(server.origin, {
    path: '/v1/capabilities',
    headers: { Authorization: `Bearer ${exchange.json.credential}` },
  });
  assert.equal(capabilities.status, 200);
  assert.deepEqual(capabilities.json, {
    serverId: server.serverId,
    apiVersion: 1,
    project: 'demo-project',
    role: 'runner',
    runtimes: [],
  });

  const listed = await listClients({ stateDir: directory });
  assert.equal(listed.clients.length, 1);
  assert.equal(listed.clients[0].clientId, exchange.json.clientId);
  assert.equal(listed.clients[0].name, 'worker-one');
  assert.equal(listed.clients[0].revoked, false);
  for (const forbidden of [
    'credential',
    'credentialDigest',
    'digest',
    'invitation',
  ]) {
    assert.equal(forbidden in listed.clients[0], false);
  }

  const revoked = await revokeClient({
    stateDir: directory,
    clientId: exchange.json.clientId,
  });
  assert.deepEqual(revoked, {
    clientId: exchange.json.clientId,
    revokedAt: revoked.revokedAt,
  });
  assert.equal(typeof revoked.revokedAt, 'number');

  const revokedCapabilities = await requestHttps(server.origin, {
    path: '/v1/capabilities',
    headers: { Authorization: `Bearer ${exchange.json.credential}` },
  });
  assert.equal(revokedCapabilities.status, 401);
  assert.deepEqual(revokedCapabilities.json, { error: 'unauthorized' });

  const revokedAgain = await revokeClient({
    stateDir: directory,
    clientId: exchange.json.clientId,
  });
  assert.equal(revokedAgain.revokedAt, revoked.revokedAt);

  const unknownRevoke = await jsonRequest(
    server.origin,
    '/v1/admin/clients/revoke',
    { body: { clientId: '00000000-0000-4000-8000-000000000000' } }
  );
  assert.equal(unknownRevoke.status, 404);

  const spentInvite = await jsonRequest(server.origin, '/v1/pair/exchange', {
    body: { invitation: envelope.invitation, name: 'reuse' },
  });
  assert.equal(spentInvite.status, 401);
  assert.deepEqual(spentInvite.json, { error: 'unauthorized' });
  assert.equal(spentInvite.body.includes(envelope.invitation), false);

  const invalidBearer = await requestHttps(server.origin, {
    path: '/v1/capabilities',
    headers: { Authorization: `Bearer ${'A'.repeat(43)}` },
  });
  assert.equal(invalidBearer.status, 401);
  assert.equal(invalidBearer.body.includes('A'.repeat(43)), false);
});

test('strict JSON, methods, body caps and no redirects', async (t) => {
  const directory = tempDirectory(t, 'strict');
  const server = await startTestServer(t, { stateDir: directory });

  const invitation = 'A'.repeat(43);

  const extraKey = await jsonRequest(server.origin, '/v1/pair/exchange', {
    body: { invitation, name: 'x', extra: true },
  });
  assert.equal(extraKey.status, 400);
  assert.deepEqual(extraKey.json, { error: 'bad_request' });

  const wrongContentType = await requestHttps(server.origin, {
    path: '/v1/pair/exchange',
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
      'Content-Length': '2',
    },
    body: '{}',
  });
  assert.equal(wrongContentType.status, 415);

  const invalidJson = await requestHttps(server.origin, {
    path: '/v1/pair/exchange',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': '5',
    },
    body: '{oops',
  });
  assert.equal(invalidJson.status, 400);

  const emptyBody = await requestHttps(server.origin, {
    path: '/v1/pair/exchange',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': '0',
    },
  });
  assert.equal(emptyBody.status, 400);

  const oversized = await requestHttps(server.origin, {
    path: '/v1/pair/exchange',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': '9000',
    },
  });
  assert.equal(oversized.status, 413);
  assert.deepEqual(oversized.json, { error: 'payload_too_large' });

  const chunkedOversized = await requestHttps(server.origin, {
    path: '/v1/pair/exchange',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: `{"invitation":"${'A'.repeat(9000)}","name":"x"}`,
  });
  assert.equal(chunkedOversized.status, 413);
  assert.deepEqual(chunkedOversized.json, { error: 'payload_too_large' });

  const identityPost = await requestHttps(server.origin, {
    path: '/v1/identity',
    method: 'POST',
  });
  assert.equal(identityPost.status, 405);
  assert.equal(identityPost.headers.allow, 'GET');

  const exchangeGet = await requestHttps(server.origin, {
    path: '/v1/pair/exchange',
  });
  assert.equal(exchangeGet.status, 405);
  assert.equal(exchangeGet.headers.allow, 'POST');

  const capabilitiesPost = await requestHttps(server.origin, {
    path: '/v1/capabilities',
    method: 'POST',
  });
  assert.equal(capabilitiesPost.status, 405);

  const unknown = await requestHttps(server.origin, {
    path: '/v1/does-not-exist',
  });
  assert.equal(unknown.status, 404);
  assert.ok(unknown.status < 300 || unknown.status >= 400);

  const longUrl = await requestHttps(server.origin, {
    path: `/v1/${'a'.repeat(3000)}`,
  });
  assert.equal(longUrl.status, 414);
  assert.deepEqual(longUrl.json, { error: 'uri_too_long' });

  const missingBearer = await requestHttps(server.origin, {
    path: '/v1/capabilities',
  });
  assert.equal(missingBearer.status, 401);

  const malformedBearer = await requestHttps(server.origin, {
    path: '/v1/capabilities',
    headers: { Authorization: 'Bearer short' },
  });
  assert.equal(malformedBearer.status, 401);

  for (const response of [
    extraKey,
    wrongContentType,
    invalidJson,
    emptyBody,
    oversized,
    identityPost,
    unknown,
    longUrl,
  ]) {
    assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers.connection, 'close');
    assert.equal(response.body.includes(invitation), false);
  }
});

test('per-remote and process-wide auth/enroll failures are rate limited', async (t) => {
  const perRemoteDirectory = tempDirectory(t, 'limit-remote');
  const perRemote = await startTestServer(t, {
    stateDir: perRemoteDirectory,
    limits: { windowMs: 60_000, perRemote: 2, global: 100, maxRemotes: 16 },
  });

  const statuses = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await jsonRequest(perRemote.origin, '/v1/pair/exchange', {
      body: { invitation: 'A'.repeat(43), name: 'rate-test' },
    });
    statuses.push(response.status);
  }
  assert.deepEqual(statuses.slice(0, 2), [401, 401]);
  assert.equal(statuses[2], 429);

  const limited = await jsonRequest(perRemote.origin, '/v1/pair/exchange', {
    body: { invitation: 'A'.repeat(43), name: 'rate-test' },
  });
  assert.equal(limited.status, 429);
  assert.deepEqual(limited.json, { error: 'rate_limited' });
  assert.ok(Number(limited.headers['retry-after']) >= 1);

  const globalDirectory = tempDirectory(t, 'limit-global');
  const globalServer = await startTestServer(t, {
    stateDir: globalDirectory,
    limits: { windowMs: 60_000, perRemote: 100, global: 2, maxRemotes: 16 },
  });

  const authStatuses = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await requestHttps(globalServer.origin, {
      path: '/v1/capabilities',
      headers: { Authorization: `Bearer ${'B'.repeat(43)}` },
    });
    authStatuses.push(response.status);
  }
  assert.deepEqual(authStatuses.slice(0, 2), [401, 401]);
  assert.equal(authStatuses[2], 429);
});

test('concurrent servers never unlink an active admin socket and partial startup is clean', async (t) => {
  const firstDirectory = tempDirectory(t, 'concurrent-servers');
  const first = await startTestServer(t, { stateDir: firstDirectory });
  const firstSocket = path.join(firstDirectory, 'admin.sock');

  await assert.rejects(
    startServer({
      stateDir: firstDirectory,
      port: 0,
      handleSignals: false,
    }),
    (error) => error.code === 'admin_socket_busy'
  );
  assert.equal(fs.existsSync(firstSocket), true);

  const stillServing = await requestHttps(first.origin, {
    path: '/v1/identity',
  });
  assert.equal(stillServing.status, 200);
  assert.equal(stillServing.json.serverId, first.serverId);

  const stillAdmin = await issuePairing({
    stateDir: firstDirectory,
    project: 'still-here',
    role: 'observer',
  });
  assertToken(stillAdmin.invitation);

  // Even without the lock file, a start attempt must probe the socket and
  // refuse to unlink an active administration endpoint.
  fs.unlinkSync(path.join(firstDirectory, 'admin.sock.lock'));
  await assert.rejects(
    startServer({
      stateDir: firstDirectory,
      port: 0,
      handleSignals: false,
    }),
    (error) => error.code === 'admin_socket_busy'
  );
  assert.equal(fs.existsSync(firstSocket), true);
  const stillServingWithoutLock = await requestHttps(first.origin, {
    path: '/v1/identity',
  });
  assert.equal(stillServingWithoutLock.status, 200);

  const deadChild = spawn(process.execPath, ['-e', ''], {
    stdio: 'ignore',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  const deadExit = await waitForExit(deadChild);
  assert.equal(deadExit.code, 0);
  const staleDirectory = tempDirectory(t, 'stale-lock');
  fs.writeFileSync(
    path.join(staleDirectory, 'admin.sock.lock'),
    `${ADMIN_LOCK_MAGIC}\n${deadChild.pid}\n${Date.now()}\n`,
    { mode: 0o600 }
  );
  const recovered = await startTestServer(t, { stateDir: staleDirectory });
  const recoveredIdentity = await requestHttps(recovered.origin, {
    path: '/v1/identity',
  });
  assert.equal(recoveredIdentity.status, 200);
  await recovered.close();
  assert.equal(fs.existsSync(path.join(staleDirectory, 'admin.sock')), false);

  const staleSocketDirectory = tempDirectory(t, 'stale-socket');
  const staleSocketPath = path.join(staleSocketDirectory, 'admin.sock');
  const socketWorker = `
const net = require('node:net');
const server = net.createServer();
server.listen(process.argv[1], () => {
  process.stdout.write('ready', () => {
    process.kill(process.pid, 'SIGKILL');
  });
});
`;
  const socketResult = await runNode(socketWorker, [staleSocketPath]);
  assert.notEqual(socketResult.code, 0);
  assert.equal(socketResult.stdout, 'ready');
  assert.equal(fs.existsSync(staleSocketPath), true);
  const recoveredSocket = await startTestServer(t, {
    stateDir: staleSocketDirectory,
  });
  const recoveredSocketIdentity = await requestHttps(
    recoveredSocket.origin,
    { path: '/v1/identity' }
  );
  assert.equal(recoveredSocketIdentity.status, 200);
  await recoveredSocket.close();

  const failedDirectory = tempDirectory(t, 'listen-failure');
  await assert.rejects(
    startServer({
      stateDir: failedDirectory,
      port: first.port,
      handleSignals: false,
    }),
    (error) => error.code === 'listen_failed'
  );
  assert.equal(fs.existsSync(path.join(failedDirectory, 'admin.sock')), false);
  assert.equal(
    fs.existsSync(path.join(failedDirectory, 'admin.sock.lock')),
    false
  );
  assert.equal(
    fs.existsSync(path.join(failedDirectory, 'pairing.sqlite')),
    true
  );
  assert.equal(fs.existsSync(path.join(failedDirectory, 'tls', 'cert.pem')), true);

  const occupiedDirectory = tempDirectory(t, 'occupied');
  const occupiedPath = path.join(occupiedDirectory, 'admin.sock');
  fs.writeFileSync(occupiedPath, 'operator data', { mode: 0o600 });
  await assert.rejects(
    startServer({
      stateDir: occupiedDirectory,
      port: 0,
      handleSignals: false,
    }),
    (error) =>
      error.code === 'admin_socket_unavailable' ||
      error.code === 'admin_socket_busy'
  );
  assert.equal(fs.readFileSync(occupiedPath, 'utf8'), 'operator data');

  const lockedDirectory = tempDirectory(t, 'locked');
  const lockPath = path.join(lockedDirectory, 'admin.sock.lock');
  fs.writeFileSync(lockPath, `${ADMIN_LOCK_MAGIC}\n${process.pid}\n${Date.now()}\n`, {
    mode: 0o600,
  });
  await assert.rejects(
    startServer({
      stateDir: lockedDirectory,
      port: 0,
      handleSignals: false,
    }),
    (error) => error.code === 'admin_socket_busy'
  );
  assert.equal(fs.existsSync(lockPath), true);

  await first.close();
  assert.equal(fs.existsSync(firstSocket), false);
});

test('simultaneous server starts serialize on the admin socket', async (t) => {
  const directory = tempDirectory(t, 'simultaneous');
  const results = await Promise.allSettled([
    startServer({
      stateDir: directory,
      port: 0,
      handleSignals: false,
    }),
    startServer({
      stateDir: directory,
      port: 0,
      handleSignals: false,
    }),
  ]);

  const fulfilled = results.filter((result) => result.status === 'fulfilled');
  const rejected = results.filter((result) => result.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'admin_socket_busy');

  const server = fulfilled[0].value;
  t.after(() => server.close());
  const identity = await requestHttps(server.origin, {
    path: '/v1/identity',
  });
  assert.equal(identity.status, 200);
  assert.equal(identity.json.serverId, server.serverId);
  assert.equal(fs.existsSync(path.join(directory, 'admin.sock')), true);

  const envelope = await issuePairing({
    stateDir: directory,
    project: 'simultaneous',
    role: 'observer',
  });
  assertToken(envelope.invitation);

  await server.close();
  assert.equal(fs.existsSync(path.join(directory, 'admin.sock')), false);
});

test('explicit origin is validated and advertised in the envelope', async (t) => {
  const directory = tempDirectory(t, 'origin');
  const server = await startTestServer(t, {
    stateDir: directory,
    origin: 'https://alpi.example.test',
  });
  const envelope = await issuePairing({
    stateDir: directory,
    project: 'origin-project',
    role: 'observer',
  });
  assert.equal(envelope.origin, 'https://alpi.example.test');

  const override = await issuePairing({
    stateDir: directory,
    project: 'origin-project',
    role: 'observer',
    origin: 'https://override.example.test',
  });
  assert.equal(override.origin, 'https://override.example.test');

  await assert.rejects(
    startServer({
      stateDir: tempDirectory(t, 'bad-origin'),
      port: 0,
      handleSignals: false,
      origin: 'http://insecure.example.test',
    }),
    (error) => error.code === 'invalid_options'
  );

  assert.equal(server.origin, 'https://alpi.example.test');
});

test('daemon operations never write to console', async (t) => {
  const directory = tempDirectory(t, 'logs');
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };
  const calls = [];
  for (const method of Object.keys(original)) {
    console[method] = (...args) => calls.push([method, args]);
  }

  try {
    const server = await startServer({
      stateDir: directory,
      port: 0,
      handleSignals: false,
    });
    await requestHttps(server.origin, { path: '/v1/identity' });
    const envelope = await issuePairing({
      stateDir: directory,
      project: 'logs',
      role: 'operator',
    });
    const exchange = await jsonRequest(server.origin, '/v1/pair/exchange', {
      body: { invitation: envelope.invitation, name: 'logs-client' },
    });
    await requestHttps(server.origin, {
      path: '/v1/capabilities',
      headers: { Authorization: `Bearer ${exchange.json.credential}` },
    });
    await listClients({ stateDir: directory });
    await revokeClient({
      stateDir: directory,
      clientId: exchange.json.clientId,
    });
    await server.close();
  } finally {
    for (const [method, fn] of Object.entries(original)) {
      console[method] = fn;
    }
  }

  assert.deepEqual(calls, []);
});

test('executable pair/serve/list/revoke flow and clean signal shutdown', async (t) => {
  const directory = tempDirectory(t, 'cli');
  const serve = spawnCli(['serve', '--state-dir', directory, '--port', '0']);
  t.after(() => {
    if (serve.child.exitCode === null) {
      serve.child.kill('SIGKILL');
    }
  });

  const origin = await waitForListening(serve);
  assert.match(origin, /^https:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(serve.stdout, '');
  assert.equal(serve.stderr.includes('invitation'), false);

  const issued = await runCli([
    'pair',
    'issue',
    '--state-dir',
    directory,
    '--project',
    'cli-project',
    '--role',
    'runner',
    '--expires',
    '5m',
  ]);
  assert.equal(issued.code, 0);
  assert.equal(issued.stderr, '');
  const envelopeLines = issued.stdout.trim().split('\n');
  assert.equal(envelopeLines.length, 1);
  const envelope = JSON.parse(envelopeLines[0]);
  assert.deepEqual(Object.keys(envelope), [
    'origin',
    'serverId',
    'fingerprint',
    'invitation',
    'expiresAt',
  ]);
  assert.equal(envelope.origin, origin);
  assert.match(envelope.serverId, UUID_PATTERN);
  assert.match(envelope.fingerprint, /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/);
  assertToken(envelope.invitation);
  assert.ok(envelope.expiresAt > Date.now());
  assert.ok(envelope.expiresAt <= Date.now() + INVITE_TTL_MS);

  const identity = await requestHttps(origin, { path: '/v1/identity' });
  assert.equal(identity.status, 200);
  assert.equal(identity.json.serverId, envelope.serverId);

  const exchange = await jsonRequest(origin, '/v1/pair/exchange', {
    body: { invitation: envelope.invitation, name: 'cli-client' },
  });
  assert.equal(exchange.status, 200);
  assertToken(exchange.json.credential);

  const capabilities = await requestHttps(origin, {
    path: '/v1/capabilities',
    headers: { Authorization: `Bearer ${exchange.json.credential}` },
  });
  assert.equal(capabilities.status, 200);
  assert.deepEqual(capabilities.json, {
    serverId: envelope.serverId,
    apiVersion: 1,
    project: 'cli-project',
    role: 'runner',
    runtimes: [],
  });

  const listed = await runCli([
    'clients',
    'list',
    '--state-dir',
    directory,
  ]);
  assert.equal(listed.code, 0);
  assert.equal(listed.stderr, '');
  const listedJson = JSON.parse(listed.stdout);
  assert.equal(listedJson.clients.length, 1);
  assert.equal(listedJson.clients[0].clientId, exchange.json.clientId);
  assert.equal(listedJson.clients[0].name, 'cli-client');

  const revoked = await runCli([
    'clients',
    'revoke',
    exchange.json.clientId,
    '--state-dir',
    directory,
  ]);
  assert.equal(revoked.code, 0);
  assert.equal(revoked.stderr, '');
  const revokedJson = JSON.parse(revoked.stdout);
  assert.equal(revokedJson.clientId, exchange.json.clientId);

  const revokedCapabilities = await requestHttps(origin, {
    path: '/v1/capabilities',
    headers: { Authorization: `Bearer ${exchange.json.credential}` },
  });
  assert.equal(revokedCapabilities.status, 401);

  const tooLong = await runCli([
    'pair',
    'issue',
    '--state-dir',
    directory,
    '--project',
    'cli-project',
    '--role',
    'runner',
    '--expires',
    '6m',
  ]);
  assert.equal(tooLong.code, 2);
  assert.equal(tooLong.stdout, '');
  assert.match(tooLong.stderr, /at most 5m/);

  const badRole = await runCli([
    'pair',
    'issue',
    '--state-dir',
    directory,
    '--project',
    'cli-project',
    '--role',
    'admin',
  ]);
  assert.equal(badRole.code, 2);
  assert.equal(badRole.stdout, '');
  assert.match(badRole.stderr, /--role/);

  serve.child.kill('SIGTERM');
  const exit = await waitForExit(serve.child);
  assert.equal(exit.code, 0);
  assert.equal(fs.existsSync(path.join(directory, 'admin.sock')), false);
  assert.equal(fs.existsSync(path.join(directory, 'admin.sock.lock')), false);
  assert.equal(fs.existsSync(path.join(directory, 'identity.lock')), false);
  assert.equal(fs.existsSync(path.join(directory, 'pairing.sqlite')), true);

  const certBefore = fs.readFileSync(
    path.join(directory, 'tls', 'cert.pem'),
    'utf8'
  );

  const restarted = spawnCli([
    'serve',
    '--state-dir',
    directory,
    '--port',
    '0',
  ]);
  t.after(() => {
    if (restarted.child.exitCode === null) {
      restarted.child.kill('SIGKILL');
    }
  });
  const restartedOrigin = await waitForListening(restarted);
  const restartedIdentity = await requestHttps(restartedOrigin, {
    path: '/v1/identity',
  });
  assert.equal(restartedIdentity.json.serverId, envelope.serverId);
  assert.equal(
    fs.readFileSync(path.join(directory, 'tls', 'cert.pem'), 'utf8'),
    certBefore
  );
  restarted.child.kill('SIGTERM');
  const restartedExit = await waitForExit(restarted.child);
  assert.equal(restartedExit.code, 0);
});

test('pair issue fails safely when the administration socket is absent', async (t) => {
  const directory = tempDirectory(t, 'absent');
  const result = await runCli([
    'pair',
    'issue',
    '--state-dir',
    directory,
    '--project',
    'absent',
    '--role',
    'runner',
  ]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Administration socket is unavailable/);
  assert.equal(/invitation/i.test(result.stderr), false);
});

test('simultaneous stale administration recovery leaves one live owner and endpoint', async (t) => {
  const directory = tempDirectory(t, 'stale-recovery');
  const socketPath = path.join(directory, 'admin.sock');

  // Leave a socket bound by a process that died without unlinking it, plus a
  // legacy metadata file naming that same dead owner.
  const socketWorker = `
const net = require('node:net');
const server = net.createServer();
server.listen(process.argv[1], () => {
  process.stdout.write('ready', () => {
    process.kill(process.pid, 'SIGKILL');
  });
});
`;
  const socketResult = await runNode(socketWorker, [socketPath]);
  assert.equal(socketResult.stdout, 'ready');
  assert.equal(fs.existsSync(socketPath), true);

  const deadChild = spawn(process.execPath, ['-e', ''], {
    stdio: 'ignore',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  const deadExit = await waitForExit(deadChild);
  assert.equal(deadExit.code, 0);
  fs.writeFileSync(
    path.join(directory, 'admin.sock.lock'),
    `${ADMIN_LOCK_MAGIC}\n${deadChild.pid}\n${Date.now()}\n`,
    { mode: 0o600 }
  );

  const worker = `
const { startServer } = require(${JSON.stringify(SOURCE_DAEMON)});
startServer({ stateDir: process.argv[1], port: 0 })
  .then((server) => {
    process.stdout.write('READY ' + JSON.stringify({
      origin: server.origin,
      serverId: server.serverId,
      fingerprint: server.fingerprint,
    }) + '\\n');
  })
  .catch((error) => {
    process.stdout.write('ERROR ' + (error && error.code) + '\\n');
  });
`;
  const first = spawnWorker(worker, [directory]);
  const second = spawnWorker(worker, [directory]);
  t.after(() => {
    for (const state of [first, second]) {
      if (state.child.exitCode === null) {
        state.child.kill('SIGKILL');
      }
    }
  });

  const isResult = (line) =>
    line.startsWith('READY ') || line.startsWith('ERROR ');
  const lines = await Promise.all([
    waitForWorkerOutput(first, isResult),
    waitForWorkerOutput(second, isResult),
  ]);
  const ready = lines.filter((line) => line.startsWith('READY '));
  const errors = lines.filter((line) => line.startsWith('ERROR '));
  assert.equal(ready.length, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0], 'ERROR admin_socket_busy');

  const info = JSON.parse(ready[0].slice('READY '.length));
  const certPem = fs.readFileSync(
    path.join(directory, 'tls', 'cert.pem'),
    'utf8'
  );
  const persisted = new crypto.X509Certificate(certPem);
  assert.equal(info.fingerprint, persisted.fingerprint256);

  const identity = await requestHttps(info.origin, { path: '/v1/identity' });
  assert.equal(identity.status, 200);
  assert.equal(identity.json.serverId, info.serverId);
  assert.equal(identity.peerFingerprint, persisted.fingerprint256);

  const envelope = await issuePairing({
    stateDir: directory,
    project: 'recovered',
    role: 'observer',
  });
  assertToken(envelope.invitation);
  assert.equal(envelope.serverId, info.serverId);
  assert.equal(fs.existsSync(socketPath), true);

  const winner = first.stdout.includes('READY ') ? first : second;
  winner.child.kill('SIGTERM');
  const exit = await waitForExit(winner.child);
  assert.equal(exit.code, 0);
  assert.equal(fs.existsSync(socketPath), false);
  assert.equal(fs.existsSync(path.join(directory, 'admin.sock.lock')), false);
  // The OS-released guard database is persistent and never deleted.
  assert.equal(
    fs.existsSync(path.join(directory, 'admin.sock.lock.sqlite')),
    true
  );
});

test('simultaneous stale identity recovery publishes one certificate', async (t) => {
  const directory = tempDirectory(t, 'stale-identity-recovery');
  const deadChild = spawn(process.execPath, ['-e', ''], {
    stdio: 'ignore',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  const deadExit = await waitForExit(deadChild);
  assert.equal(deadExit.code, 0);
  fs.writeFileSync(
    path.join(directory, 'identity.lock'),
    `alpi-identity-v1\n${deadChild.pid}\n${Date.now()}\n`,
    { mode: 0o600 }
  );

  const worker = `
const { ensureIdentity } = require(${JSON.stringify(SOURCE_IDENTITY)});
try {
  const identity = ensureIdentity(process.argv[1]);
  process.stdout.write(identity.fingerprint);
} catch (error) {
  process.stdout.write('ERROR:' + (error && error.code));
  process.exitCode = 1;
}
`;
  const results = await Promise.all(
    Array.from({ length: 4 }, () => runNode(worker, [directory]))
  );
  const fingerprints = results.map((result) => {
    assert.equal(result.code, 0);
    assert.ok(!result.stdout.startsWith('ERROR:'));
    return result.stdout;
  });
  assert.equal(new Set(fingerprints).size, 1);

  const certPem = fs.readFileSync(
    path.join(directory, 'tls', 'cert.pem'),
    'utf8'
  );
  assert.equal(
    new crypto.X509Certificate(certPem).fingerprint256,
    fingerprints[0]
  );
  assert.equal(fs.existsSync(path.join(directory, 'identity.lock')), false);
  assert.equal(
    fs.existsSync(path.join(directory, 'identity.lock.sqlite')),
    true
  );
});

test('close destroys a pre-handshake TLS connection and both listeners', async (t) => {
  const directory = tempDirectory(t, 'pre-tls-shutdown');
  const server = await startServer({
    stateDir: directory,
    port: 0,
    handleSignals: false,
  });
  t.after(async () => {
    await server.close().catch(() => {});
  });

  const sockets = await Promise.all([
    connectTcp(server.port),
    connectTcp(server.port),
  ]);
  const started = Date.now();
  await server.close();
  const elapsed = Date.now() - started;

  await Promise.all(sockets.map((socket) => waitForClientClose(socket)));
  for (const socket of sockets) {
    assert.equal(socket.destroyed, true);
  }
  assert.ok(elapsed < 3000, `close took ${elapsed}ms`);
  assert.equal(fs.existsSync(path.join(directory, 'admin.sock')), false);
  assert.equal(fs.existsSync(path.join(directory, 'admin.sock.lock')), false);

  await assert.rejects(connectTcp(server.port), (error) => {
    return error.code === 'ECONNREFUSED';
  });
  await assert.rejects(
    issuePairing({ stateDir: directory, project: 'gone', role: 'observer' })
  );
});

test('SIGTERM shutdown with a pre-handshake TLS connection stays bounded', async (t) => {
  const directory = tempDirectory(t, 'signal-pre-tls');
  const serve = spawnCli(['serve', '--state-dir', directory, '--port', '0']);
  t.after(() => {
    if (serve.child.exitCode === null) {
      serve.child.kill('SIGKILL');
    }
  });

  const origin = await waitForListening(serve);
  const port = Number(new URL(origin).port);
  const socket = await connectTcp(port);

  const started = Date.now();
  serve.child.kill('SIGTERM');
  const exit = await waitForExit(serve.child, 15000);
  const elapsed = Date.now() - started;

  assert.equal(exit.code, 0);
  assert.ok(elapsed < 8000, `signal shutdown took ${elapsed}ms`);
  await waitForClientClose(socket);
  assert.equal(socket.destroyed, true);
  assert.equal(fs.existsSync(path.join(directory, 'admin.sock')), false);
  assert.equal(fs.existsSync(path.join(directory, 'admin.sock.lock')), false);
  assert.equal(fs.existsSync(path.join(directory, 'identity.lock')), false);
});
