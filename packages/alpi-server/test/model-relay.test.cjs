'use strict';

/**
 * RELAY-1 tests.
 *
 * These tests use a real unprivileged HTTP server on loopback as the fake
 * inference service, and a real Unix domain socket for the relay listener.
 * They exercise bounded input handling, streaming SSE, credential injection,
 * redaction across chunk boundaries, fencing of an active stream, launch
 * isolation, shared inference capacity and safe socket ownership. No VM,
 * external network or privileged operation is involved.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  ModelRelayError,
  createInferencePool,
  createModelRelay,
} = require('../src/network/model-relay.cjs');

const MODEL = 'local/test-model';
const SECRET = 'sk-test-RELAY-1-credential-abcdef';
const ENDPOINT = '/v1/chat/completions';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeTempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alpi-relay-'));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeCredential(directory, name, value, mode = 0o600) {
  const credentialPath = path.join(directory, name);
  fs.writeFileSync(credentialPath, value, { mode });
  fs.chmodSync(credentialPath, mode);
  return credentialPath;
}

function makeCredential(t, root, value = SECRET) {
  const directory = path.join(root, 'credentials');
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  writeCredential(directory, 'inference-token', `${value}\n`);
  return { directory, name: 'inference-token' };
}

function startHttpServer(t, handler, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      server.on('error', () => {});
      t.after(
        () =>
          new Promise((done) => {
            if (typeof server.closeAllConnections === 'function') {
              server.closeAllConnections();
            }
            server.close(() => done());
          })
      );
      resolve({ server, port: server.address().port, host });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, host);
  });
}

function chatBody(overrides = {}) {
  return JSON.stringify({
    model: MODEL,
    stream: true,
    messages: [{ role: 'user', content: 'hello' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      },
    ],
    tool_choice: 'auto',
    ...overrides,
  });
}

async function createRelay(t, options) {
  const relay = await createModelRelay(options);
  t.after(async () => {
    await relay.close();
  });
  return relay;
}

function relayOptions(root, upstream, overrides = {}) {
  return {
    socketPath: path.join(root, 'relay.sock'),
    projectId: 'project-a',
    sandboxId: 'sandbox-a',
    generation: 1,
    model: MODEL,
    upstream: {
      scheme: 'http',
      host: upstream.host,
      port: upstream.port,
    },
    credential: null,
    ...overrides,
  };
}

function request(relay, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: relay.socketPath,
        method: options.method || 'POST',
        path: options.path || ENDPOINT,
        headers: options.headers || {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

function openStream(relay, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: relay.socketPath,
        method: 'POST',
        path: ENDPOINT,
        headers: { 'content-type': 'application/json' },
      },
      (res) => {
        const state = {
          status: res.statusCode,
          headers: res.headers,
          chunks: [],
          ended: false,
          closed: false,
          error: null,
          res,
          req,
        };
        state.firstChunk = new Promise((resolveFirst) => {
          res.once('data', () => resolveFirst());
        });
        state.finished = new Promise((resolveFinished) => {
          res.once('end', () => {
            state.ended = true;
            resolveFinished();
          });
          res.once('close', () => {
            state.closed = true;
            resolveFinished();
          });
          res.once('error', (error) => {
            state.error = error;
            resolveFinished();
          });
        });
        res.on('data', (chunk) => state.chunks.push(chunk));
        resolve(state);
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

function json(response) {
  return JSON.parse(response.body);
}

async function assertRejectsCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ModelRelayError);
    assert.equal(error.code, code);
    return true;
  });
}

function captureConsole(t) {
  const output = [];
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info,
  };
  for (const name of Object.keys(original)) {
    console[name] = (...args) => {
      output.push(args.map(String).join(' '));
    };
  }
  t.after(() => {
    for (const name of Object.keys(original)) {
      console[name] = original[name];
    }
  });
  return output;
}

test('denies by default and rejects non-inference input', async (t) => {
  const root = makeTempDirectory(t);
  const upstream = await startHttpServer(t, (req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: [DONE]\n\n');
    });
  });
  const relay = await createRelay(t, relayOptions(root, upstream));

  const denied = await request(relay, {
    headers: { 'content-type': 'application/json' },
    body: chatBody(),
  });
  assert.equal(denied.status, 503);
  assert.equal(json(denied).error.code, 'relay_disabled');

  await relay.allow({ generation: 1, ironReady: true, callbackReady: true });

  const method = await request(relay, { method: 'GET', path: ENDPOINT });
  assert.equal(method.status, 405);
  assert.equal(method.headers.allow, 'POST');
  assert.equal(json(method).error.code, 'method_not_allowed');

  const wrongPath = await request(relay, {
    path: '/v1/models',
    headers: { 'content-type': 'application/json' },
    body: chatBody(),
  });
  assert.equal(wrongPath.status, 404);
  assert.equal(json(wrongPath).error.code, 'not_found');

  const queryPath = await request(relay, {
    path: `${ENDPOINT}?redirect=http://example.test`,
    headers: { 'content-type': 'application/json' },
    body: chatBody(),
  });
  assert.equal(queryPath.status, 404);

  const absolutePath = await request(relay, {
    path: 'http://example.test/v1/chat/completions',
    headers: { 'content-type': 'application/json' },
    body: chatBody(),
  });
  assert.equal(absolutePath.status, 404);

  const wrongType = await request(relay, {
    headers: { 'content-type': 'text/plain' },
    body: chatBody(),
  });
  assert.equal(wrongType.status, 415);
  assert.equal(json(wrongType).error.code, 'unsupported_content_type');

  const invalidJson = await request(relay, {
    headers: { 'content-type': 'application/json' },
    body: '{',
  });
  assert.equal(invalidJson.status, 400);
  assert.equal(json(invalidJson).error.code, 'invalid_json');

  const wrongModel = await request(relay, {
    headers: { 'content-type': 'application/json' },
    body: chatBody({ model: 'other/model' }),
  });
  assert.equal(wrongModel.status, 400);
  assert.equal(json(wrongModel).error.code, 'invalid_model');
});

test('streams stock Pi SSE to the fixed destination with the service credential', async (t) => {
  const root = makeTempDirectory(t);
  const credential = makeCredential(t, root);
  const seen = [];
  const upstream = await startHttpServer(t, (req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'x-upstream-private': 'must-not-forward',
      });
      res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":" world"}}]}\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  const relay = await createRelay(
    t,
    relayOptions(root, upstream, { credential })
  );
  const consoleOutput = captureConsole(t);
  await relay.allow({ generation: 1, ironReady: true, callbackReady: true });

  const body = chatBody();
  const response = await request(relay, {
    headers: {
      'content-type': 'application/json',
      'x-client-routing': 'must-not-forward',
      authorization: 'Bearer client-supplied-value',
    },
    body,
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers['content-type'], 'text/event-stream');
  assert.equal(response.headers['x-upstream-private'], undefined);
  assert.match(response.body, /hello/);
  assert.match(response.body, /\[DONE\]/);

  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].url, ENDPOINT);
  assert.equal(seen[0].body, body);
  assert.equal(seen[0].headers.authorization, `Bearer ${SECRET}`);
  assert.equal(seen[0].headers['x-client-routing'], undefined);
  assert.equal(seen[0].headers['content-type'], 'application/json');
  assert.equal(seen[0].headers.accept, 'text/event-stream');

  const diagnostics = JSON.stringify(relay.status());
  assert.equal(diagnostics.includes(SECRET), false);
  assert.equal(response.body.includes(SECRET), false);
  assert.equal(consoleOutput.join('\n').includes(SECRET), false);
});

test('redacts reflected credentials across streaming chunks and JSON responses', async (t) => {
  const root = makeTempDirectory(t);
  const credential = makeCredential(t, root);
  const upstream = await startHttpServer(t, (req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (parsed.stream === true) {
        const first = SECRET.slice(0, 8);
        const rest = SECRET.slice(8);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: {"choices":[{"delta":{"content":"prefix ${first}`);
        setTimeout(() => {
          if (!res.destroyed) {
            res.write(`${rest} suffix"}}]}\n\n`);
            res.end('data: [DONE]\n\n');
          }
        }, 10);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ echo: `prefix ${SECRET} suffix` }));
    });
  });
  const relay = await createRelay(
    t,
    relayOptions(root, upstream, { credential })
  );
  const consoleOutput = captureConsole(t);
  await relay.allow({ generation: 1, ironReady: true, callbackReady: true });

  const streamed = await request(relay, {
    headers: { 'content-type': 'application/json' },
    body: chatBody(),
  });
  assert.equal(streamed.status, 200);
  assert.equal(streamed.body.includes(SECRET), false);
  assert.match(streamed.body, /\[redacted\]/);
  assert.match(streamed.body, /\[DONE\]/);

  const buffered = await request(relay, {
    headers: { 'content-type': 'application/json' },
    body: chatBody({ stream: false }),
  });
  assert.equal(buffered.status, 200);
  assert.equal(buffered.headers['content-type'], 'application/json');
  assert.equal(buffered.body.includes(SECRET), false);
  assert.match(buffered.body, /\[redacted\]/);

  assert.equal(consoleOutput.join('\n').includes(SECRET), false);
  assert.equal(JSON.stringify(relay.status()).includes(SECRET), false);
});

test('supports an unauthenticated local inference service', async (t) => {
  const root = makeTempDirectory(t);
  const seen = [];
  const upstream = await startHttpServer(t, (req, res) => {
    seen.push({ headers: { ...req.headers } });
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: [DONE]\n\n');
    });
  });
  const relay = await createRelay(t, relayOptions(root, upstream));
  await relay.allow({ generation: 1, ironReady: true, callbackReady: true });

  const response = await request(relay, {
    headers: { 'content-type': 'application/json' },
    body: chatBody(),
  });
  assert.equal(response.status, 200);
  assert.equal(seen[0].headers.authorization, undefined);
});

test('enforces body, pending-body and shared inference concurrency bounds', async (t) => {
  const root = makeTempDirectory(t);
  const upstream = await startHttpServer(t, (req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: [DONE]\n\n');
    });
  });

  const bounded = await createRelay(
    t,
    relayOptions(root, upstream, {
      socketPath: path.join(root, 'bounded.sock'),
      limits: {
        maxBodyBytes: 128,
        maxPendingBodies: 1,
        maxInboundRequests: 4,
        bodyTimeoutMs: 2000,
      },
    })
  );
  await bounded.allow({ generation: 1, ironReady: true, callbackReady: true });

  const oversized = await request(bounded, {
    headers: { 'content-type': 'application/json' },
    body: chatBody(),
  });
  assert.equal(oversized.status, 413);
  assert.equal(json(oversized).error.code, 'body_too_large');

  const partial = new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: bounded.socketPath,
        method: 'POST',
        path: ENDPOINT,
        headers: {
          'content-type': 'application/json',
          'content-length': '100',
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }
    );
    req.on('error', reject);
    req.write('{');
  });
  await delay(50);
  const pending = await request(bounded, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, stream: true }),
  });
  assert.equal(pending.status, 429);
  assert.equal(json(pending).error.code, 'too_many_pending');
  // Destroying the incomplete request must release its pending slot.
  // The promise is intentionally not awaited: the socket is destroyed below.
  partial.catch(() => {});
  await delay(10);

  const pool = createInferencePool({ maxConcurrent: 1 });
  let releaseFirst;
  const sharedUpstream = await startHttpServer(t, (req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (!releaseFirst) {
        res.write('data: {"choices":[{"delta":{"content":"held"}}]}\n\n');
        releaseFirst = () => {
          if (!res.destroyed) res.end('data: [DONE]\n\n');
        };
      } else {
        res.end('data: [DONE]\n\n');
      }
    });
  });
  const first = await createRelay(
    t,
    relayOptions(root, sharedUpstream, {
      socketPath: path.join(root, 'first.sock'),
      projectId: 'project-a',
      sandboxId: 'sandbox-a',
      generation: 1,
      pool,
    })
  );
  const second = await createRelay(
    t,
    relayOptions(root, sharedUpstream, {
      socketPath: path.join(root, 'second.sock'),
      projectId: 'project-b',
      sandboxId: 'sandbox-b',
      generation: 1,
      pool,
    })
  );
  await first.allow({ generation: 1, ironReady: true, callbackReady: true });
  await second.allow({ generation: 1, ironReady: true, callbackReady: true });

  const active = await openStream(first, chatBody());
  await active.firstChunk;
  assert.equal(pool.active, 1);

  const busy = await request(second, {
    headers: { 'content-type': 'application/json' },
    body: chatBody(),
  });
  assert.equal(busy.status, 429);
  assert.equal(json(busy).error.code, 'inference_busy');

  releaseFirst();
  await active.finished;
  await delay(20);
  assert.equal(pool.active, 0);

  const after = await request(second, {
    headers: { 'content-type': 'application/json' },
    body: chatBody(),
  });
  assert.equal(after.status, 200);
});

test('caps concurrent inbound requests independently of the inference pool', async (t) => {
  const root = makeTempDirectory(t);
  let releaseHeld;
  const upstream = await startHttpServer(t, (req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (!releaseHeld) {
        res.write('data: {"choices":[{"delta":{"content":"held"}}]}\n\n');
        releaseHeld = () => {
          if (!res.destroyed) res.end('data: [DONE]\n\n');
        };
      } else {
        res.end('data: [DONE]\n\n');
      }
    });
  });
  const relay = await createRelay(
    t,
    relayOptions(root, upstream, {
      limits: {
        maxInboundRequests: 1,
        maxPendingBodies: 2,
        requestTimeoutMs: 5000,
      },
    })
  );
  await relay.allow({ generation: 1, ironReady: true, callbackReady: true });

  const active = await openStream(relay, chatBody());
  await active.firstChunk;
  const rejected = await request(relay, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, stream: true }),
  });
  assert.equal(rejected.status, 429);
  assert.equal(json(rejected).error.code, 'too_many_requests');

  releaseHeld();
  await active.finished;
  const accepted = await request(relay, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, stream: true }),
  });
  assert.equal(accepted.status, 200);
});

test('bounds upstream failures and sanitizes them', async (t) => {
  const root = makeTempDirectory(t);
  const credential = makeCredential(t, root);

  const redirect = await startHttpServer(t, (req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(302, {
        location: `http://example.test/${SECRET}`,
      });
      res.end(`redirect ${SECRET}`);
    });
  });
  const redirectRelay = await createRelay(
    t,
    relayOptions(root, redirect, {
      socketPath: path.join(root, 'redirect.sock'),
      credential,
    })
  );
  await redirectRelay.allow({
    generation: 1,
    ironReady: true,
    callbackReady: true,
  });
  const redirectResponse = await request(redirectRelay, {
    headers: { 'content-type': 'application/json' },
    body: chatBody(),
  });
  assert.equal(redirectResponse.status, 502);
  assert.equal(json(redirectResponse).error.code, 'upstream_redirect');
  assert.equal(redirectResponse.headers.location, undefined);
  assert.equal(redirectResponse.body.includes(SECRET), false);

  const failing = await startHttpServer(t, (req) => {
    req.socket.destroy();
  });
  const failingRelay = await createRelay(
    t,
    relayOptions(root, failing, {
      socketPath: path.join(root, 'failing.sock'),
      credential,
    })
  );
  await failingRelay.allow({
    generation: 1,
    ironReady: true,
    callbackReady: true,
  });
  const failingResponse = await request(failingRelay, {
    headers: { 'content-type': 'application/json' },
    body: chatBody(),
  });
  assert.equal(failingResponse.status, 502);
  assert.equal(json(failingResponse).error.code, 'upstream_error');
  assert.equal(failingResponse.body.includes(SECRET), false);

  const large = await startHttpServer(t, (req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write(JSON.stringify({ data: 'x'.repeat(200) }));
      res.end();
    });
  });
  const largeRelay = await createRelay(
    t,
    relayOptions(root, large, {
      socketPath: path.join(root, 'large.sock'),
      credential,
      limits: { maxResponseBytes: 64 },
    })
  );
  await largeRelay.allow({
    generation: 1,
    ironReady: true,
    callbackReady: true,
  });
  const largeResponse = await request(largeRelay, {
    headers: { 'content-type': 'application/json' },
    body: chatBody({ stream: false }),
  });
  assert.equal(largeResponse.status, 502);
  assert.equal(json(largeResponse).error.code, 'response_too_large');
  assert.equal(largeResponse.body.includes(SECRET), false);

  const hanging = await startHttpServer(t, (req) => {
    req.resume();
  });
  const timeoutRelay = await createRelay(
    t,
    relayOptions(root, hanging, {
      socketPath: path.join(root, 'timeout.sock'),
      credential,
      limits: {
        requestTimeoutMs: 150,
        bodyTimeoutMs: 1000,
        upstreamConnectTimeoutMs: 1000,
      },
    })
  );
  await timeoutRelay.allow({
    generation: 1,
    ironReady: true,
    callbackReady: true,
  });
  const timeoutResponse = await request(timeoutRelay, {
    headers: { 'content-type': 'application/json' },
    body: chatBody(),
  });
  assert.equal(timeoutResponse.status, 504);
  assert.equal(json(timeoutResponse).error.code, 'request_timeout');
});

test('fences one launch, aborts its active stream and isolates another launch', async (t) => {
  const root = makeTempDirectory(t);
  let releaseHeld;
  let heldRequests = 0;
  const upstreamA = await startHttpServer(t, (req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (!releaseHeld) {
        heldRequests += 1;
        res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
        releaseHeld = () => {
          if (!res.destroyed) res.end('data: [DONE]\n\n');
        };
      } else {
        res.end('data: [DONE]\n\n');
      }
    });
  });
  const upstreamB = await startHttpServer(t, (req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: [DONE]\n\n');
    });
  });

  const relayA = await createRelay(
    t,
    relayOptions(root, upstreamA, {
      socketPath: path.join(root, 'a.sock'),
      projectId: 'project-a',
      sandboxId: 'sandbox-a',
      generation: 1,
    })
  );
  const relayB = await createRelay(
    t,
    relayOptions(root, upstreamB, {
      socketPath: path.join(root, 'b.sock'),
      projectId: 'project-b',
      sandboxId: 'sandbox-b',
      generation: 1,
    })
  );
  await relayA.allow({ generation: 1, ironReady: true, callbackReady: true });
  await relayB.allow({ generation: 1, ironReady: true, callbackReady: true });

  const active = await openStream(relayA, chatBody());
  await active.firstChunk;
  assert.match(Buffer.concat(active.chunks).toString('utf8'), /first/);

  relayA.fence('iron_fault');
  await Promise.race([active.finished, delay(1000)]);
  assert.equal(active.closed, true);
  assert.equal(active.ended, false);
  const chunksAfterFence = active.chunks.length;
  await delay(50);
  assert.equal(active.chunks.length, chunksAfterFence);
  assert.equal(
    Buffer.concat(active.chunks).toString('utf8').includes('[DONE]'),
    false
  );
  assert.equal(heldRequests, 1);

  const fenced = await request(relayA, {
    headers: { 'content-type': 'application/json' },
    body: chatBody(),
  });
  assert.equal(fenced.status, 503);
  assert.equal(json(fenced).error.code, 'relay_fenced');

  const other = await request(relayB, {
    headers: { 'content-type': 'application/json' },
    body: chatBody(),
  });
  assert.equal(other.status, 200);
  assert.match(other.body, /\[DONE\]/);

  await assertRejectsCode(
    relayA.allow({ generation: 2, ironReady: true, callbackReady: true }),
    'generation_mismatch'
  );
  await assertRejectsCode(
    relayA.allow({ generation: 1, ironReady: false, callbackReady: true }),
    'not_ready'
  );
  await assertRejectsCode(
    relayA.allow({ generation: 1, ironReady: true, callbackReady: false }),
    'not_ready'
  );

  await relayA.allow({ generation: 1, ironReady: true, callbackReady: true });
  assert.equal(relayA.status().fenced, null);
  const restored = await request(relayA, {
    headers: { 'content-type': 'application/json' },
    body: chatBody(),
  });
  assert.equal(restored.status, 200);
  assert.match(restored.body, /\[DONE\]/);

  await relayA.close();
  await assertRejectsCode(
    relayA.allow({ generation: 1, ironReady: true, callbackReady: true }),
    'relay_closed'
  );
});

test('reads credentials only from a private systemd credential directory', async (t) => {
  const root = makeTempDirectory(t);
  const upstream = await startHttpServer(t, (req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: [DONE]\n\n');
    });
  });

  const missingDirectory = path.join(root, 'missing');
  const missingRelay = await createRelay(
    t,
    relayOptions(root, upstream, {
      socketPath: path.join(root, 'missing.sock'),
      credential: { directory: missingDirectory, name: 'token' },
    })
  );
  await assertRejectsCode(
    missingRelay.allow({ generation: 1, ironReady: true, callbackReady: true }),
    'credential_unavailable'
  );

  const publicDirectory = path.join(root, 'public');
  fs.mkdirSync(publicDirectory, { mode: 0o755 });
  fs.chmodSync(publicDirectory, 0o755);
  writeCredential(publicDirectory, 'token', SECRET);
  const publicRelay = await createRelay(
    t,
    relayOptions(root, upstream, {
      socketPath: path.join(root, 'public.sock'),
      credential: { directory: publicDirectory, name: 'token' },
    })
  );
  await assertRejectsCode(
    publicRelay.allow({ generation: 1, ironReady: true, callbackReady: true }),
    'credential_unavailable'
  );

  const looseDirectory = path.join(root, 'loose');
  fs.mkdirSync(looseDirectory, { mode: 0o700 });
  fs.chmodSync(looseDirectory, 0o700);
  writeCredential(looseDirectory, 'token', SECRET, 0o644);
  const looseRelay = await createRelay(
    t,
    relayOptions(root, upstream, {
      socketPath: path.join(root, 'loose.sock'),
      credential: { directory: looseDirectory, name: 'token' },
    })
  );
  await assertRejectsCode(
    looseRelay.allow({ generation: 1, ironReady: true, callbackReady: true }),
    'credential_unavailable'
  );

  const validDirectory = path.join(root, 'valid');
  fs.mkdirSync(validDirectory, { mode: 0o700 });
  fs.chmodSync(validDirectory, 0o700);
  writeCredential(validDirectory, 'token', `${SECRET}\n`);
  let authorization;
  const validUpstream = await startHttpServer(t, (req, res) => {
    authorization = req.headers.authorization;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: [DONE]\n\n');
    });
  });
  const validRelay = await createRelay(
    t,
    relayOptions(root, validUpstream, {
      socketPath: path.join(root, 'valid.sock'),
      credential: { directory: validDirectory, name: 'token' },
    })
  );
  await validRelay.allow({
    generation: 1,
    ironReady: true,
    callbackReady: true,
  });
  const response = await request(validRelay, {
    headers: { 'content-type': 'application/json' },
    body: chatBody(),
  });
  assert.equal(response.status, 200);
  assert.equal(authorization, `Bearer ${SECRET}`);
});

test('owns and cleans up only its private Unix socket', async (t) => {
  const root = makeTempDirectory(t);
  const upstream = await startHttpServer(t, (req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: [DONE]\n\n');
    });
  });
  const socketPath = path.join(root, 'owned.sock');
  const relay = await createModelRelay(
    relayOptions(root, upstream, { socketPath })
  );
  const socketStat = fs.lstatSync(socketPath);
  assert.equal(socketStat.isSocket(), true);
  assert.equal(socketStat.mode & 0o777, 0o600);

  const keep = path.join(root, 'keep.txt');
  fs.writeFileSync(keep, 'unrelated');
  await relay.close();
  await relay.close();
  assert.equal(fs.existsSync(socketPath), false);
  assert.equal(fs.existsSync(keep), true);

  const occupiedPath = path.join(root, 'occupied.sock');
  fs.writeFileSync(occupiedPath, 'not-a-socket');
  await assertRejectsCode(
    createModelRelay(relayOptions(root, upstream, { socketPath: occupiedPath })),
    'socket_exists'
  );
  assert.equal(fs.existsSync(occupiedPath), true);

  const insecureParent = path.join(root, 'insecure');
  fs.mkdirSync(insecureParent, { mode: 0o755 });
  fs.chmodSync(insecureParent, 0o755);
  await assertRejectsCode(
    createModelRelay(
      relayOptions(root, upstream, {
        socketPath: path.join(insecureParent, 'relay.sock'),
      })
    ),
    'insecure_socket_parent'
  );
});

test('rejects invalid operator configuration', async (t) => {
  const root = makeTempDirectory(t);
  const upstream = await startHttpServer(t, (req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: [DONE]\n\n');
    });
  });
  const base = relayOptions(root, upstream);

  await assertRejectsCode(
    createModelRelay({
      ...base,
      socketPath: path.join(root, 'hostname.sock'),
      upstream: { scheme: 'http', host: 'localhost', port: upstream.port },
    }),
    'invalid_upstream'
  );
  await assertRejectsCode(
    createModelRelay({
      ...base,
      socketPath: path.join(root, 'scheme.sock'),
      upstream: { scheme: 'ftp', host: upstream.host, port: upstream.port },
    }),
    'invalid_upstream'
  );
  await assertRejectsCode(
    createModelRelay({
      ...base,
      socketPath: path.join(root, 'port.sock'),
      upstream: { scheme: 'http', host: upstream.host, port: 0 },
    }),
    'invalid_upstream'
  );
  await assertRejectsCode(
    createModelRelay({
      ...base,
      socketPath: path.join(root, 'unspecified.sock'),
      upstream: { scheme: 'http', host: '0.0.0.0', port: upstream.port },
    }),
    'invalid_upstream'
  );
  await assertRejectsCode(
    createModelRelay({
      ...base,
      socketPath: path.join(root, 'unknown-option.sock'),
      credentialPath: path.join(root, 'not-allowed'),
    }),
    'invalid_options'
  );
  await assertRejectsCode(
    createModelRelay({
      ...base,
      socketPath: path.join(root, 'generation.sock'),
      generation: 0,
    }),
    'invalid_generation'
  );
  await assertRejectsCode(
    createModelRelay({
      ...base,
      socketPath: path.join(root, 'credential.sock'),
      credential: { directory: root, name: '../token' },
    }),
    'invalid_credential'
  );
  await assertRejectsCode(
    createModelRelay({ ...base, socketPath: 'relative.sock' }),
    'invalid_socket'
  );
  await assertRejectsCode(
    createModelRelay({
      ...base,
      socketPath: path.join(root, 'redactor.sock'),
      redactorPath: path.join(root, 'missing-redactor.cjs'),
    }),
    'invalid_redactor'
  );
  await assertRejectsCode(
    createModelRelay({
      ...base,
      socketPath: path.join(root, 'model.sock'),
      model: '',
    }),
    'invalid_model'
  );
  await assertRejectsCode(
    createModelRelay({
      ...base,
      socketPath: path.join(root, 'limits.sock'),
      limits: { maxBodyBytes: 1, unknownLimit: 1 },
    }),
    'invalid_limits'
  );
});

test('accepts an IPv6 IP-literal upstream when loopback IPv6 is available', async (t) => {
  const root = makeTempDirectory(t);
  let upstream;
  try {
    upstream = await startHttpServer(
      t,
      (req, res) => {
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end('data: [DONE]\n\n');
        });
      },
      '::1'
    );
  } catch {
    t.skip('IPv6 loopback is unavailable');
    return;
  }
  const relay = await createRelay(
    t,
    relayOptions(root, upstream, {
      socketPath: path.join(root, 'ipv6.sock'),
      upstream: { scheme: 'http', host: '[::1]', port: upstream.port },
    })
  );
  await relay.allow({ generation: 1, ironReady: true, callbackReady: true });
  const response = await request(relay, {
    headers: { 'content-type': 'application/json' },
    body: chatBody(),
  });
  assert.equal(response.status, 200);
  assert.match(response.body, /\[DONE\]/);
});

test('outstanding JSON delivery remains owned through finish, fence or deadline', { timeout: 8000 }, async t => {
  const { Writable, Readable } = require('node:stream');
  const { once } = require('node:events');
  const root = makeTempDirectory(t);
  const upstream = await startHttpServer(t, (req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  // Drive the real HTTP handler with a Writable whose delivery callback we control.
  const original = http.createServer;
  let handler;
  const mock = t.mock.method(http, 'createServer', function (listener) {
    handler = listener;
    return original.call(http, listener);
  });
  const relay = await createRelay(t, relayOptions(root, upstream, { limits: { requestTimeoutMs: 750 } }));
  mock.mock.restore();
  const ready = { generation: 1, ironReady: true, callbackReady: true };
  await relay.allow(ready);
  for (const action of ['fence', 'deadline', 'finish']) {
    const body = Buffer.from(chatBody({ stream: false }));
    const req = Object.assign(Readable.from([body]), {
      method: 'POST', url: ENDPOINT, rawHeaders: [], headers: { 'content-type': 'application/json' },
    });
    const pending = Promise.withResolvers();
    const res = new Writable({ write(_chunk, _encoding, callback) { pending.resolve(callback); } });
    res.setHeader = () => {};
    Object.defineProperty(res, 'headersSent', { get: () => res.writableEnded });
    const closed = once(res, 'close');
    handler(req, res);
    const flush = await pending.promise;
    assert.equal(res.writableEnded, true);
    assert.equal(res.writableFinished, false);
    assert.equal(relay.status().activeRequests, 1);
    if (action === 'fence') relay.fence('iron_fault');
    if (action === 'finish') flush();
    await closed;
    assert.equal(res.writableFinished, action === 'finish');
    assert.equal(relay.status().activeRequests, 0);
    assert.equal(relay.status().activeInference, 0);
    if (action === 'fence') await relay.allow(ready);
  }
});

test('early HTTP rejection flushes its error and closes the connection before upload completion', {
  timeout: 5000,
}, async t => {
  const { once } = require('node:events');
  const root = makeTempDirectory(t);
  const relay = await createRelay(t, relayOptions(root, { host: '127.0.0.1', port: 1 }));
  const agent = new http.Agent({ keepAlive: true });
  t.after(() => agent.destroy());
  const req = http.request({ agent, socketPath: relay.socketPath, method: 'POST', path: ENDPOINT,
    headers: { 'content-type': 'application/json', 'content-length': '128' } });
  t.after(() => req.destroy());
  const response = once(req, 'response');
  req.write('{');
  const [res] = await response;
  const socketClosed = once(req.socket, 'close');
  const parts = [];
  for await (const chunk of res) parts.push(chunk);
  assert.equal(res.statusCode, 503);
  assert.equal(JSON.parse(Buffer.concat(parts)).error.code, 'relay_disabled');
  assert.equal(res.headers.connection, 'close');
  await socketClosed;
  assert.equal(relay.status().pendingBodies, 0);
});
