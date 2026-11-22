'use strict';

// Stock-path Linux evidence for the pinned Iron proxy.
//
// Opt-in: requires a Linux host (procfs) and the official pinned Iron binary
// supplied through IRON_STOCK_PATH_TEST. Unlike the fake-adapter harness used
// elsewhere, this test launches the STOCK binary through the production
// launch path (createIronLifecycle) with the shipped gRPC callback profile,
// drives one ordinary absolute-form request through the real loopback tunnel
// listener, and asserts the fixed policy denial end to end.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const iron = require('../src/network/iron.cjs');
const { ownsLoopbackListener } = require('../src/network/listener-owner.cjs');

// Production denial body from profiles/iron-callback/callback-runtime.cjs
// (Buffer.from('Request denied by Alpi policy.\n')).
const DENIED_BODY = 'Request denied by Alpi policy.\n';
const REQUEST_TIMEOUT_MS = 20_000;

const skipReason =
  process.platform !== 'linux'
    ? 'stock-path evidence requires Linux procfs and the pinned linux-amd64 Iron binary'
    : process.env.IRON_STOCK_PATH_TEST
      ? false
      : 'set IRON_STOCK_PATH_TEST to the digest-verified Iron binary path';

function rawRequest(port, target, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let raw = Buffer.alloc(0);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(new Error('the request timed out')),
      timeoutMs
    );
    timer.unref?.();
    socket.once('error', (error) => finish(error));
    socket.once('connect', () => {
      socket.write(
        `GET ${target} HTTP/1.1\r\n` +
          'Host: example.invalid\r\n' +
          'Connection: close\r\n' +
          '\r\n'
      );
    });
    socket.on('data', (chunk) => {
      raw = Buffer.concat([raw, chunk]);
      const headerEnd = raw.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const headers = raw.subarray(0, headerEnd).toString('latin1');
      const length = /content-length:\s*(\d+)/i.exec(headers);
      if (length && raw.length >= headerEnd + 4 + Number(length[1])) {
        finish(null, raw);
      }
    });
    socket.once('close', () => {
      if (raw.length > 0) finish(null, raw);
      else finish(new Error('the connection closed without a response'));
    });
  });
}

function expectConnectionRefused(port, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('the listener is still accepting connections'));
    }, timeoutMs);
    timer.unref?.();
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error('the listener is still accepting connections'));
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      resolve(error);
    });
  });
}

test('stock Iron tunnel denies an ordinary request through the production callback', {
  skip: skipReason,
}, async (t) => {
  const binary = process.env.IRON_STOCK_PATH_TEST;

  // The test itself gates on the pinned official digest before anything runs.
  const verified = await iron.verifyIronBinary(binary, iron.IRON_SHA256);
  assert.equal(verified.sha256, iron.IRON_SHA256);
  assert.ok(verified.bytes > 0);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iron-stock-path-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  // Production callback wiring: stage the shipped callback profile by value
  // (canonical helpers + protocol), with the pinned gRPC dependencies that
  // the evidence image installed from the profile's npm-shrinkwrap.json.
  const sourceRoot = path.resolve(__dirname, '..', '..', '..');
  const profileSource = path.join(sourceRoot, 'packages', 'alpi-server', 'profiles', 'iron-callback');
  const profileDir = path.join(tempRoot, 'callback-profile');
  fs.mkdirSync(profileDir, { recursive: true });
  for (const name of ['package.json', 'npm-shrinkwrap.json', 'callback-runtime.cjs']) {
    fs.copyFileSync(path.join(profileSource, name), path.join(profileDir, name));
  }
  assert.equal(
    fs.existsSync(path.join(profileSource, 'node_modules', '@grpc', 'grpc-js')),
    true,
    'the callback profile dependencies must be pre-installed for this evidence run'
  );
  fs.cpSync(
    path.join(profileSource, 'node_modules'),
    path.join(profileDir, 'node_modules'),
    { recursive: true }
  );
  await iron.stageCallbackProfile({ sourceRoot, profileDir });
  const installed = iron.assertCallbackProfileInstalled({ profileDir });
  assert.equal(installed.grpcJs, iron.GRPC_JS_VERSION);
  assert.equal(installed.protoLoader, iron.PROTO_LOADER_VERSION);

  let fenceCalls = 0;
  const lifecycle = iron.createIronLifecycle({
    stateDir: path.join(tempRoot, 'state'),
    environmentId: 'stock-path-evidence',
    ironBinary: verified.file,
    ironSha256: iron.IRON_SHA256,
    // TEST-NET-1: the connector is never reachable; nothing may egress beyond
    // loopback, and the policy callback owns the only allowed request shape.
    connector: { address: '192.0.2.10', port: 8080 },
    model: 'stock-path-evidence',
    relay: {
      fence: () => {
        fenceCalls += 1;
      },
    },
    callbackProfileDir: profileDir,
    nodePath: process.execPath,
    startTimeoutMs: 120_000,
  });
  t.after(() => lifecycle.stop().catch(() => {}));

  const status = await lifecycle.start();

  // (1) The stock binary actually started and stayed healthy.
  assert.equal(status.phase, 'ready');
  assert.equal(status.pid, lifecycle.pid);
  assert.equal(lifecycle.healthy(), true);
  assert.ok(Number.isInteger(lifecycle.pid) && lifecycle.pid > 0);
  process.kill(lifecycle.pid, 0); // the Iron process is alive right now

  const port = lifecycle.ingress().port;
  assert.ok(Number.isInteger(port) && port > 0);

  // (2) The tunnel listener on the loopback port is owned by the Iron
  // process itself, confirmed through procfs.
  assert.equal(await ownsLoopbackListener(lifecycle.pid, port), true);

  // (3) An ordinary absolute-form GET through the stock tunnel listener is
  // denied by the production gRPC callback with the fixed body.
  const raw = await rawRequest(port, 'http://example.invalid/something');
  const text = raw.toString('latin1');
  const headerEnd = text.indexOf('\r\n\r\n');
  assert.ok(headerEnd !== -1, 'the response headers are complete');
  const statusLine = text.slice(0, text.indexOf('\r\n'));
  assert.match(statusLine, /^HTTP\/1\.[01] 403 /);
  const body = text.slice(headerEnd + 4);
  assert.equal(body, DENIED_BODY);
  assert.equal(body.replace(/\n$/, ''), 'Request denied by Alpi policy.');

  // (4) A graceful stop closes the tunnel listener for good.
  const stopped = await lifecycle.stop();
  assert.equal(stopped.phase, 'stopped');
  const closeError = await expectConnectionRefused(port);
  assert.equal(closeError.code, 'ECONNREFUSED');
  assert.equal(await ownsLoopbackListener(lifecycle.pid, port), false);
  assert.ok(fenceCalls >= 1, 'the synchronous relay fence ran at least once');
});
