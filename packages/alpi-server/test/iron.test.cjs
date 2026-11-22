'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const iron = require('../src/network/iron.cjs');
const callbackRuntime = require('../profiles/iron-callback/callback-runtime.cjs');

const PROFILE_DIR = path.join(__dirname, '..', 'profiles', 'iron-callback');

function tempDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alpi-iron-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function waitFor(check, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error('test wait timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Ordinary deferred fake adapter: openIngress() is pending until the test
// resolves it, which lets stop/fault interleavings be exercised deterministically.
function deferredIngress(baseNetwork, events) {
  const gate = deferred();
  const handle = {
    port: 43123,
    target: 'iron-proxy',
    closed: false,
    healthy: () => true,
    close: async () => {
      handle.closed = true;
    },
  };
  let opened = false;
  const network = {
    ...baseNetwork,
    async openIngress() {
      opened = true;
      events.push('ingress-open');
      return gate.promise;
    },
  };
  return { network, gate, handle, isOpened: () => opened };
}

function makePolicyHelpers() {
  // Prefer the canonical module when the reference checkout is available.
  const root = process.env.IRON_CANONICAL_ROOT;
  if (root) {
    try {
      return require(path.join(root, 'src/runtime/network-policy.cjs'));
    } catch {}
  }
  return {
    normalizeRequest(request, context = {}) {
      if (!request || typeof request.method !== 'string') throw new Error('invalid');
      const connect = request.method === 'CONNECT';
      const scheme = connect ? 'connect' : context.sni ? 'https' : 'http';
      const [host, portText] = String(request.host).split(':');
      const port = Number(portText || (scheme === 'https' ? 443 : 80));
      if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid');
      if (connect) return { scheme, host, port, method: request.method, pathname: '' };
      let raw = String(request.url ?? '/');
      if (/^https?:\/\//.test(raw)) raw = new URL(raw).pathname;
      const pathname = decodeURIComponent(raw.split('?')[0]);
      return { scheme, host, port, method: request.method, pathname };
    },
    matches(rule, destination) {
      const transport = destination.scheme === 'connect';
      return (
        rule.host === destination.host &&
        rule.port === destination.port &&
        (rule.scheme === destination.scheme ||
          (transport && ['http', 'https'].includes(rule.scheme))) &&
        (transport
          ? rule.action !== 'deny' || (!rule.method && !rule.pathname)
          : (!rule.method || rule.method === destination.method) &&
            (!rule.pathname || rule.pathname === destination.pathname))
      );
    },
  };
}

function makeHarness(t, overrides = {}) {
  const stateDir = tempDir(t);
  const binary = path.join(stateDir, 'iron-proxy');
  const binaryBytes = Buffer.from(`fake-iron-${crypto.randomUUID()}`);
  fs.writeFileSync(binary, binaryBytes, { mode: 0o755 });

  const events = [];
  const processes = [];
  const callbacks = [];
  const relay = {
    fenceCount: 0,
    closeCount: 0,
    streams: new Set(),
    fence() {
      relay.fenceCount += 1;
      events.push('fence');
      for (const stream of relay.streams) stream.closed = true;
      relay.streams.clear();
    },
    close() {
      relay.closeCount += 1;
      events.push('relay-close');
    },
  };
  const network = {
    prepared: null,
    route: null,
    ingress: null,
    ingressClosed: false,
    async prepare(options) {
      network.prepared = options;
      return { proxyPort: 43123 };
    },
    async assertPortFree() {},
    async configureRoute(options) {
      network.route = options;
    },
    async openIngress(options) {
      network.ingress = {
        port: options.proxyPort,
        target: 'iron-proxy',
        healthy: () => true,
        close: async () => {
          network.ingressClosed = true;
        },
      };
      return network.ingress;
    },
  };
  const helpers = {
    privateDirectory(directory) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.chmodSync(directory, 0o700);
    },
    async ensureCA(directory) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const caFile = path.join(directory, 'ca.crt');
      const keyFile = path.join(directory, 'ca.key');
      fs.writeFileSync(caFile, 'test-cert', { mode: 0o600 });
      fs.writeFileSync(keyFile, 'test-key', { mode: 0o600 });
      return { caFile, keyFile };
    },
    async startOwnedProcess(options) {
      const handle = {
        pid: 1000 + processes.length,
        alive: true,
        healthy() {
          return handle.alive;
        },
        close: async () => {
          handle.alive = false;
          events.push('iron-close');
        },
        exit() {
          handle.alive = false;
          options.onExit?.();
        },
      };
      processes.push(handle);
      events.push('iron-start');
      return handle;
    },
    async ownsListener() { return true; },
    async probe() {
      return true;
    },
    now: () => Date.now(),
  };
  const callbackFactory = async ({ grant, onFault }) => {
    const handle = {
      address: '127.0.0.1:50051',
      alive: true,
      healthy() {
        return handle.alive;
      },
      ready: async () => true,
      close: async () => {
        handle.alive = false;
        clearTimeout(timer);
        events.push('callback-close');
      },
      fail() {
        handle.alive = false;
        onFault?.('callback-exited');
      },
      expire() {
        handle.alive = false;
        onFault?.('grant-expired');
      },
    };
    const timer = setTimeout(
      () => {
        if (handle.alive) handle.expire();
      },
      Math.max(1, grant.expiresAt - Date.now())
    );
    timer.unref?.();
    callbacks.push(handle);
    events.push('callback-start');
    return handle;
  };

  const options = iron.validateLaunchOptions({
    stateDir,
    environmentId: 'env-test',
    ironBinary: binary,
    ironSha256: sha256(binaryBytes),
    connector: { address: '192.0.2.10', port: 8080 },
    model: 'test-model',
    relay,
    network,
    helpers,
    callbackFactory,
    grantMs: 60_000,
    startTimeoutMs: 1000,
    ...overrides,
  });

  return {
    stateDir,
    binary,
    binaryBytes,
    options,
    relay,
    network,
    helpers,
    processes,
    callbacks,
    events,
  };
}

test('launch option and grant validation is strict', () => {
  const base = {
    stateDir: '/tmp/private-state',
    environmentId: 'env-test',
    ironBinary: '/tmp/private-state/iron-proxy',
    ironSha256: iron.IRON_SHA256,
    connector: { address: '192.0.2.10', port: 8080 },
    model: 'test-model',
    relay: { fence() {} },
    callbackFactory: async () => ({}),
  };

  assert.throws(
    () => iron.validateLaunchOptions({ ...base, stateDir: 'relative' }),
    /absolute/
  );
  assert.throws(
    () =>
      iron.validateLaunchOptions({
        ...base,
        connector: { address: 'connector.example', port: 8080 },
      }),
    /IPv4/
  );
  assert.throws(
    () =>
      iron.validateLaunchOptions({
        ...base,
        connector: { address: '192.0.2.10', port: 0 },
      }),
    /port/i
  );
  assert.throws(
    () => iron.validateLaunchOptions({ ...base, ironSha256: 'not-a-digest' }),
    /SHA-256/
  );
  assert.throws(
    () => iron.validateLaunchOptions({ ...base, relay: {} }),
    /fence/
  );
  assert.throws(
    () => iron.validateLaunchOptions({ ...base, grantMs: 0 }),
    /grant window/
  );
  assert.throws(
    () => iron.validateLaunchOptions({ ...base, grantMs: iron.MAX_GRANT_MS + 1 }),
    /grant window/
  );
  assert.throws(
    () => iron.validateLaunchOptions({ ...base, model: 'bad\nmodel' }),
    /model/
  );

  const validGrant = {
    environmentId: 'env-test',
    scheme: 'http',
    host: '192.0.2.10',
    port: 8080,
    method: 'POST',
    pathname: '/v1/chat/completions',
    expiresAt: Date.now() + 60_000,
    model: 'test-model',
  };
  assert.equal(iron.validateGrant(validGrant).pathname, '/v1/chat/completions');
  assert.throws(
    () => iron.validateGrant({ ...validGrant, pathname: '/v1/other' }),
    /single model endpoint/
  );
  assert.throws(
    () => iron.validateGrant({ ...validGrant, method: 'GET' }),
    /POST/
  );
  assert.throws(
    () => iron.validateGrant({ ...validGrant, host: 'example.com' }),
    /IPv4/
  );
  assert.throws(
    () => iron.validateGrant({ ...validGrant, extra: true }),
    /unexpected field/
  );
});

test('Iron config keeps DNS off, loopback listeners and no CIDR override', () => {
  const config = iron.buildIronConfig({
    proxyPort: 43123,
    callbackAddress: '127.0.0.1:50051',
    caFile: '/private/ca/ca.crt',
    keyFile: '/private/ca/ca.key',
  });
  assert.deepEqual(config.dns, { enabled: false });
  assert.equal(config.proxy.tunnel_listen, '127.0.0.1:43123');
  assert.equal(config.proxy.upstream_deny_cidrs, undefined);
  assert.equal(config.tls.mode, 'mitm');
  assert.equal(config.transforms[0].config.target, '127.0.0.1:50051');
  assert.equal(config.transforms[0].config.send_request_body, false);
  assert.equal(config.transforms[0].config.send_response_body, false);
  assert.equal(config.metrics.listen, '127.0.0.1:0');
  assert.equal(config.log.level, 'error');

  assert.throws(
    () =>
      iron.buildIronConfig({
        proxyPort: 43123,
        callbackAddress: '10.0.0.1:50051',
        caFile: '/private/ca/ca.crt',
        keyFile: '/private/ca/ca.key',
      }),
    /loopback/
  );
});

test('an answering port with unconfirmed ownership keeps ingress closed', async t => {
  const harness = makeHarness(t, { startTimeoutMs: 100 });
  const lifecycle = iron.createIronLifecycle({
    ...harness.options,
    helpers: { ...harness.options.helpers, ownsListener: async () => false },
  });
  t.after(() => lifecycle.stop());
  await assert.rejects(lifecycle.start(), { code: 'readiness_timeout' });
  assert.equal(lifecycle.healthy(), false);
  assert.equal(lifecycle.ingress(), null);
  assert.equal(harness.network.ingress, null);
});

test('normal lifecycle starts, exposes only the Iron proxy bridge, and cleans up', async (t) => {
  const harness = makeHarness(t);
  const lifecycle = iron.createIronLifecycle(harness.options);
  await lifecycle.start();

  const status = lifecycle.status();
  assert.equal(status.phase, 'ready');
  assert.match(status.launchId, /^[a-f0-9-]{36}$/);
  assert.equal(status.retryRequired, false);
  assert.equal(status.resources, 3);
  assert.equal(status.fenceCount, 0);
  assert.equal(lifecycle.healthy(), true);
  assert.equal(harness.relay.fenceCount, 0);
  assert.equal(harness.network.route.address, '192.0.2.10');
  assert.equal(harness.network.route.port, 8080);

  const ingress = lifecycle.ingress();
  assert.equal(ingress.port, 43123);
  assert.equal(ingress.target, 'iron-proxy');
  assert.equal(ingress.healthy(), true);

  const publicText = JSON.stringify(status);
  assert.equal(publicText.includes('50051'), false);
  assert.equal(publicText.includes('43123'), false);
  assert.equal(publicText.includes('192.0.2.10'), false);

  await lifecycle.stop();
  assert.equal(lifecycle.status().phase, 'stopped');
  assert.equal(lifecycle.status().resources, 0);
  assert.equal(harness.relay.fenceCount, 1);
  assert.equal(harness.relay.closeCount, 1);
  assert.equal(harness.processes[0].healthy(), false);
  assert.equal(harness.callbacks[0].healthy(), false);
  assert.equal(harness.network.ingressClosed, true);
  assert.deepEqual(
    fs.readdirSync(path.join(harness.stateDir, 'iron', 'env-test')),
    []
  );
  await lifecycle.stop();
  assert.equal(harness.relay.fenceCount, 1);
});

test('Iron exit fences synchronously, requires explicit restart, and gets a fresh identity', async (t) => {
  const harness = makeHarness(t);
  const lifecycle = iron.createIronLifecycle(harness.options);
  await lifecycle.start();
  const oldLaunchId = lifecycle.status().launchId;
  const stream = { closed: false };
  harness.relay.streams.add(stream);

  harness.processes[0].exit();
  assert.equal(lifecycle.status().phase, 'offline');
  assert.equal(lifecycle.status().retryRequired, true);
  assert.equal(harness.relay.fenceCount, 1);
  assert.equal(stream.closed, true);

  await waitFor(() => lifecycle.status().resources === 0);
  assert.equal(harness.callbacks[0].healthy(), false);
  assert.equal(harness.network.ingressClosed, true);

  await assert.rejects(lifecycle.start(), /explicit restart|restart_required/);
  await lifecycle.restart();

  const status = lifecycle.status();
  assert.equal(status.phase, 'ready');
  assert.notEqual(status.launchId, oldLaunchId);
  assert.equal(harness.processes.length, 2);
  assert.equal(harness.callbacks.length, 2);
  assert.equal(harness.relay.fenceCount, 2);

  const directories = fs.readdirSync(
    path.join(harness.stateDir, 'iron', 'env-test')
  );
  assert.equal(directories.length, 1);
  assert.notEqual(directories[0], oldLaunchId);
  await lifecycle.stop();
});

test('callback outage fences an established stream and never auto-restarts', async (t) => {
  const harness = makeHarness(t);
  const lifecycle = iron.createIronLifecycle(harness.options);
  await lifecycle.start();
  const stream = { closed: false };
  harness.relay.streams.add(stream);

  harness.callbacks[0].fail();
  assert.equal(lifecycle.status().phase, 'offline');
  assert.equal(lifecycle.status().retryRequired, true);
  assert.equal(harness.relay.fenceCount, 1);
  assert.equal(stream.closed, true);

  await waitFor(() => lifecycle.status().resources === 0);
  assert.equal(harness.processes[0].healthy(), false);
  assert.equal(harness.network.ingressClosed, true);
  assert.equal(harness.processes.length, 1);

  await lifecycle.restart();
  assert.equal(lifecycle.status().phase, 'ready');
  assert.equal(harness.processes.length, 2);
  await lifecycle.stop();
});

test('grant expiry fences an established stream and needs explicit restart', async (t) => {
  const harness = makeHarness(t, { grantMs: 250 });
  const lifecycle = iron.createIronLifecycle(harness.options);
  await lifecycle.start();
  const stream = { closed: false };
  harness.relay.streams.add(stream);

  await waitFor(() => lifecycle.status().phase === 'offline', 3000);
  assert.equal(stream.closed, true);
  assert.equal(harness.relay.fenceCount, 1);
  assert.equal(lifecycle.status().reason, 'grant-expired');
  assert.equal(lifecycle.status().retryRequired, true);
  await waitFor(() => lifecycle.status().resources === 0);

  await lifecycle.restart();
  assert.equal(lifecycle.status().phase, 'ready');
  assert.equal(harness.callbacks.length, 2);
  assert.ok(lifecycle.status().grantExpiresAt > Date.now());
  await lifecycle.stop();
});

test('stop during pending ingress fences, joins the launch and closes the late handle', async (t) => {
  const harness = makeHarness(t);
  const pending = deferredIngress(harness.network, harness.events);
  const lifecycle = iron.createIronLifecycle({
    ...harness.options,
    network: pending.network,
  });
  const startOutcome = lifecycle.start().then(
    () => null,
    (error) => error
  );

  await waitFor(() => pending.isOpened());
  const stopPromise = lifecycle.stop();
  assert.equal(lifecycle.status().phase, 'stopping');

  pending.gate.resolve(pending.handle);
  const status = await stopPromise;
  const startError = await startOutcome;

  assert.ok(startError, 'the superseded start must reject');
  assert.match(startError.message, /closing|closed|aborted|superseded/);
  assert.equal(status.phase, 'stopped');
  assert.equal(status.resources, 0);
  assert.equal(status.retryRequired, false);
  assert.equal(lifecycle.ingress(), null);
  assert.equal(lifecycle.healthy(), false);
  assert.equal(pending.handle.closed, true);
  assert.equal(harness.network.ingressClosed, false);
  assert.equal(harness.processes.length, 1);
  assert.equal(harness.callbacks.length, 1);
});

test('callback fault during pending ingress never publishes or clears retryRequired', async (t) => {
  const harness = makeHarness(t);
  const pending = deferredIngress(harness.network, harness.events);
  const lifecycle = iron.createIronLifecycle({
    ...harness.options,
    network: pending.network,
  });
  const startOutcome = lifecycle.start().then(
    () => null,
    (error) => error
  );

  await waitFor(() => pending.isOpened() && harness.callbacks.length === 1);
  harness.callbacks[0].fail();
  assert.equal(lifecycle.status().phase, 'offline');
  assert.equal(lifecycle.status().retryRequired, true);
  assert.equal(harness.relay.fenceCount, 1);

  pending.gate.resolve(pending.handle);
  const startError = await startOutcome;
  assert.ok(startError, 'the fenced start must reject');
  await waitFor(() => lifecycle.status().resources === 0);

  assert.equal(lifecycle.status().phase, 'offline');
  assert.equal(lifecycle.status().retryRequired, true);
  assert.equal(lifecycle.ingress(), null);
  assert.equal(lifecycle.healthy(), false);
  assert.equal(pending.handle.closed, true);
  assert.equal(harness.network.ingressClosed, false);

  // Only an explicit restart may recover.
  await lifecycle.restart();
  assert.equal(lifecycle.status().phase, 'ready');
  assert.equal(lifecycle.status().retryRequired, false);
  assert.equal(harness.processes.length, 2);
  await lifecycle.stop();
});

test('a duplicate restart joins the in-flight restart and does not overlap launches', async (t) => {
  const harness = makeHarness(t);
  const lifecycle = iron.createIronLifecycle(harness.options);
  await lifecycle.start();

  const first = lifecycle.restart();
  const second = lifecycle.restart();
  const [firstStatus, secondStatus] = await Promise.all([first, second]);

  assert.equal(firstStatus.phase, 'ready');
  assert.equal(secondStatus.phase, 'ready');
  assert.equal(harness.processes.length, 2);
  assert.equal(harness.callbacks.length, 2);
  assert.equal(lifecycle.status().resources, 3);
  await lifecycle.stop();
});

test('concurrent restart and stop do not start an overlapping launch', async (t) => {
  const harness = makeHarness(t);
  const lifecycle = iron.createIronLifecycle(harness.options);
  await lifecycle.start();

  const restartOutcome = lifecycle.restart().then(
    () => null,
    (error) => error
  );
  const status = await lifecycle.stop();
  const restartError = await restartOutcome;

  assert.ok(restartError, 'restart must refuse once the lifecycle is closing');
  assert.match(restartError.message, /closing|closed/);
  assert.equal(status.phase, 'stopped');
  assert.equal(status.resources, 0);
  assert.equal(harness.processes.length, 1);
  assert.equal(harness.callbacks.length, 1);
  assert.equal(lifecycle.status().retryRequired, false);
});

test('a failing resource close retains ownership, blocks restart, and succeeds on retry', async (t) => {
  const harness = makeHarness(t);
  let closeAttempts = 0;
  const baseStart = harness.options.helpers.startOwnedProcess;
  const helpers = {
    ...harness.options.helpers,
    async startOwnedProcess(options) {
      const handle = await baseStart(options);
      const realClose = handle.close;
      handle.close = async () => {
        closeAttempts += 1;
        if (closeAttempts === 1) throw new Error('injected close failure');
        return realClose();
      };
      return handle;
    },
  };
  const lifecycle = iron.createIronLifecycle({ ...harness.options, helpers });
  await lifecycle.start();
  const launchId = lifecycle.status().launchId;
  const launchDir = path.join(harness.stateDir, 'iron', 'env-test', launchId);

  const status = await lifecycle.stop();
  assert.equal(status.phase, 'offline');
  assert.equal(status.reason, 'resource-close-failed');
  assert.equal(status.retryRequired, true);
  assert.equal(status.resources, 1);
  assert.equal(lifecycle.healthy(), false);
  // The suspect process is still healthy and its identity/directory is kept.
  assert.equal(harness.processes[0].healthy(), true);
  assert.ok(fs.existsSync(launchDir));
  await assert.rejects(lifecycle.restart(), /cleanup_required|closing|closed/);

  // A repeated stop retries the close and only then reports stopped.
  const retry = await lifecycle.stop();
  assert.equal(retry.phase, 'stopped');
  assert.equal(retry.resources, 0);
  assert.equal(retry.retryRequired, false);
  assert.equal(harness.processes[0].healthy(), false);
  assert.equal(fs.existsSync(launchDir), false);
});

test('a fence failure is recorded and cannot yield a completed stop', async (t) => {
  const harness = makeHarness(t);
  let fenceAttempts = 0;
  harness.relay.fence = () => {
    fenceAttempts += 1;
    harness.events.push('fence');
    if (fenceAttempts <= 2) throw new Error('injected fence failure');
    for (const stream of harness.relay.streams) stream.closed = true;
    harness.relay.streams.clear();
  };
  const lifecycle = iron.createIronLifecycle(harness.options);
  await lifecycle.start();

  const status = await lifecycle.stop();
  assert.equal(status.phase, 'offline');
  assert.equal(status.reason, 'fence-failed');
  assert.equal(status.retryRequired, true);
  assert.equal(status.resources, 0);
  assert.equal(lifecycle.healthy(), false);

  const retry = await lifecycle.stop();
  assert.equal(retry.phase, 'stopped');
  assert.equal(retry.reason, 'environment-stopped');
  assert.equal(retry.retryRequired, false);
  assert.ok(fenceAttempts >= 2);
});

test('a pending thenable fence is unconfirmed: stop cannot complete and replacement is refused', async (t) => {
  const harness = makeHarness(t);
  const gate = deferred();
  let fenceEffects = 0;
  assert.throws(
    () =>
      iron.validateLaunchOptions({
        ...harness.options,
        relay: { ...harness.relay, fence: async () => {} },
      }),
    /must not be async/
  );
  // A plain (non-async-declared) function returning a thenable: exactly the
  // accepted surface the invocation-time contract must reject.
  harness.relay.fence = () => {
    const pendingEffect = (async () => {
      await gate.promise;
      fenceEffects += 1;
    })();
    return pendingEffect;
  };
  const lifecycle = iron.createIronLifecycle(harness.options);
  await lifecycle.start();

  // A pending fence cannot permit a replacement launch.
  await assert.rejects(lifecycle.restart(), { code: 'cleanup_required' });
  assert.equal(harness.processes.length, 1);
  assert.equal(lifecycle.fenceFailure, 'fence-failed');

  const status = await lifecycle.stop();
  assert.equal(status.phase, 'offline');
  assert.equal(status.reason, 'fence-failed');
  assert.equal(status.retryRequired, true);
  assert.equal(lifecycle.healthy(), false);
  // The stop resolved without a completed stop: the pending thenable was
  // never treated as a confirmed fence.
  assert.equal(fenceEffects, 0);
  assert.equal(lifecycle.stopFenceConfirmed, false);
  assert.equal(lifecycle.fenceFailure, 'fence-failed');

  // Even once the async effect lands, it stays unconfirmed under the
  // synchronous fence contract: only a synchronous fence may complete a stop.
  gate.resolve();
  await gate.promise;
  assert.ok(fenceEffects >= 1);
  const stillPending = await lifecycle.stop();
  assert.equal(stillPending.phase, 'offline');
  assert.equal(stillPending.reason, 'fence-failed');

  harness.relay.fence = () => {};
  const recovered = await lifecycle.stop();
  assert.equal(recovered.phase, 'stopped');
  assert.equal(recovered.retryRequired, false);
});

test('a rejecting promise fence is absorbed, refuses replacement, and cannot complete stop', async (t) => {
  const harness = makeHarness(t);
  harness.relay.fence = () =>
    // Deliberately uncaught here: the lifecycle must absorb the eventual
    // rejection, otherwise this test run fails with an unhandled rejection.
    Promise.reject(new Error('injected asynchronous fence rejection'));
  const lifecycle = iron.createIronLifecycle(harness.options);
  await lifecycle.start();

  await assert.rejects(lifecycle.restart(), { code: 'cleanup_required' });
  assert.equal(lifecycle.status().phase, 'offline');
  assert.equal(lifecycle.status().retryRequired, true);
  assert.equal(lifecycle.fenceFailure, 'fence-failed');
  assert.equal(harness.processes.length, 1);
  assert.equal(harness.callbacks.length, 1);

  const status = await lifecycle.stop();
  assert.equal(status.phase, 'offline');
  assert.equal(status.reason, 'fence-failed');
  assert.equal(status.retryRequired, true);

  harness.relay.fence = () => {};
  const recovered = await lifecycle.stop();
  assert.equal(recovered.phase, 'stopped');
  assert.equal(recovered.retryRequired, false);
});

test('a relay close failure is real and retryable', async (t) => {
  const harness = makeHarness(t);
  let closeAttempts = 0;
  harness.relay.close = () => {
    closeAttempts += 1;
    harness.events.push('relay-close');
    if (closeAttempts === 1) throw new Error('injected relay close failure');
  };
  const lifecycle = iron.createIronLifecycle(harness.options);
  await lifecycle.start();

  const status = await lifecycle.stop();
  assert.equal(status.phase, 'offline');
  assert.equal(status.reason, 'relay-close-failed');
  assert.equal(status.retryRequired, true);
  assert.equal(status.resources, 0);
  assert.equal(lifecycle.healthy(), false);

  const retry = await lifecycle.stop();
  assert.equal(retry.phase, 'stopped');
  assert.equal(retry.retryRequired, false);
  assert.equal(closeAttempts, 2);
});

test('current callback health is rechecked before publishing a late ingress', async (t) => {
  const harness = makeHarness(t);
  const pending = deferredIngress(harness.network, harness.events);
  const lifecycle = iron.createIronLifecycle({
    ...harness.options,
    network: pending.network,
  });
  const startOutcome = lifecycle.start().then(
    () => null,
    (error) => error
  );

  await waitFor(() => pending.isOpened() && harness.callbacks.length === 1);
  // Simulate a health transition that did not emit onFault.
  harness.callbacks[0].alive = false;
  pending.gate.resolve(pending.handle);

  const startError = await startOutcome;
  assert.ok(startError);
  assert.match(startError.message, /callback is not healthy/);
  assert.equal(lifecycle.status().phase, 'offline');
  assert.equal(lifecycle.status().reason, 'callback_unhealthy');
  assert.equal(lifecycle.status().retryRequired, true);
  assert.equal(lifecycle.ingress(), null);
  assert.equal(lifecycle.healthy(), false);
  assert.equal(pending.handle.closed, true);
  assert.equal(harness.network.ingressClosed, false);
});

test('listener attribution is rechecked after ingress acquisition before ready', async (t) => {
  const harness = makeHarness(t);
  const pending = deferredIngress(harness.network, harness.events);
  let ingressOpened = false;
  const helpers = {
    ...harness.options.helpers,
    async ownsListener() {
      return !ingressOpened;
    },
  };
  const network = {
    ...pending.network,
    async openIngress(options) {
      ingressOpened = true;
      return pending.network.openIngress(options);
    },
  };
  const lifecycle = iron.createIronLifecycle({
    ...harness.options,
    helpers,
    network,
  });
  const startOutcome = lifecycle.start().then(
    () => null,
    (error) => error
  );

  await waitFor(() => pending.isOpened());
  pending.gate.resolve(pending.handle);

  const startError = await startOutcome;
  assert.ok(startError);
  assert.match(startError.message, /does not belong/);
  assert.equal(lifecycle.status().phase, 'offline');
  assert.equal(lifecycle.status().reason, 'listener_unowned');
  assert.equal(lifecycle.status().retryRequired, true);
  assert.equal(lifecycle.ingress(), null);
  assert.equal(pending.handle.closed, true);
});

test('health is rechecked after the final attribution await before publishing', async (t) => {
  const harness = makeHarness(t);
  let attributionCalls = 0;
  const gate = deferred();
  const helpers = {
    ...harness.options.helpers,
    ownsListener() {
      attributionCalls += 1;
      // The readiness-loop attribution succeeds; the final pre-publication
      // lookup is held pending across a health transition.
      return attributionCalls === 1 ? true : gate.promise;
    },
  };
  const lifecycle = iron.createIronLifecycle({ ...harness.options, helpers });
  const startOutcome = lifecycle.start().then(
    () => null,
    (error) => error
  );

  await waitFor(() => attributionCalls === 2);
  // Health-only transition without onFault, mirroring the R2 diagnostic.
  harness.callbacks[0].alive = false;
  gate.resolve(true);

  const startError = await startOutcome;
  assert.ok(startError, 'a health transition during attribution must fail the start');
  assert.match(startError.message, /callback is not healthy/);
  assert.equal(lifecycle.status().phase, 'offline');
  assert.equal(lifecycle.status().reason, 'callback_unhealthy');
  assert.equal(lifecycle.status().retryRequired, true);
  assert.equal(lifecycle.ingress(), null);
  assert.equal(lifecycle.healthy(), false);
  // The acquired handles are closed by the failure path.
  assert.equal(harness.network.ingressClosed, true);
  assert.equal(harness.processes[0].healthy(), false);
  assert.equal(harness.callbacks[0].healthy(), false);
});

test('ingress health is rechecked in the same continuation that publishes readiness', async (t) => {
  const harness = makeHarness(t);
  const pending = deferredIngress(harness.network, harness.events);
  const lifecycle = iron.createIronLifecycle({
    ...harness.options,
    network: pending.network,
  });
  const startOutcome = lifecycle.start().then(
    () => null,
    (error) => error
  );

  await waitFor(() => pending.isOpened());
  pending.handle.healthy = () => false;
  pending.gate.resolve(pending.handle);

  const startError = await startOutcome;
  assert.ok(startError);
  assert.match(startError.message, /ingress is not healthy/);
  assert.equal(lifecycle.status().phase, 'offline');
  assert.equal(lifecycle.status().reason, 'ingress_invalid');
  assert.equal(lifecycle.ingress(), null);
  assert.equal(pending.handle.closed, true);
});

test('an invalid callback address closes the acquired handle through tracked cleanup', async (t) => {
  const harness = makeHarness(t);
  const baseFactory = harness.options.callbackFactory;
  let trackedCloseCalls = 0;
  const lifecycle = iron.createIronLifecycle({
    ...harness.options,
    callbackFactory: async (options) => {
      const handle = await baseFactory(options);
      const realClose = handle.close;
      handle.close = async () => {
        trackedCloseCalls += 1;
        await realClose();
      };
      handle.address = '10.0.0.1:50051';
      return handle;
    },
  });

  await assert.rejects(lifecycle.start(), { code: 'invalid_callback_address' });
  // The handle the factory already acquired is closed by the lifecycle's
  // tracked cleanup path, not left running and forgotten.
  assert.equal(trackedCloseCalls, 1);
  assert.equal(harness.events.includes('callback-close'), true);
  assert.equal(harness.callbacks[0].healthy(), false);
  assert.equal(lifecycle.status().phase, 'offline');
  assert.equal(lifecycle.status().reason, 'invalid_callback_address');
  assert.equal(lifecycle.status().retryRequired, true);
  assert.equal(lifecycle.status().resources, 0);
  assert.deepEqual(
    fs.readdirSync(path.join(harness.stateDir, 'iron', 'env-test')),
    []
  );

  const status = await lifecycle.stop();
  assert.equal(status.phase, 'stopped');
  assert.equal(status.resources, 0);
  assert.equal(status.retryRequired, false);
});

test('an invalid callback address with a failing close retains ownership and blocks replacement', async (t) => {
  const harness = makeHarness(t);
  const baseFactory = harness.options.callbackFactory;
  let realClose;
  const lifecycle = iron.createIronLifecycle({
    ...harness.options,
    callbackFactory: async (options) => {
      const handle = await baseFactory(options);
      realClose = handle.close;
      handle.close = async () => {
        throw new Error('injected callback close failure');
      };
      handle.address = '10.0.0.1:50051';
      return handle;
    },
  });

  await assert.rejects(lifecycle.start(), { code: 'invalid_callback_address' });
  const launchDir = path.join(
    harness.stateDir,
    'iron',
    'env-test',
    lifecycle.status().launchId
  );
  // Ownership is retained: the unclosed handle and its launch evidence stay.
  assert.equal(lifecycle.status().resources, 1);
  assert.equal(lifecycle.status().phase, 'offline');
  assert.equal(lifecycle.status().reason, 'resource-close-failed');
  assert.equal(lifecycle.status().retryRequired, true);
  assert.equal(harness.callbacks[0].healthy(), true);
  assert.ok(fs.existsSync(launchDir));
  await assert.rejects(lifecycle.restart(), { code: 'cleanup_required' });
  // The launch never reached the Iron process, and no replacement starts.
  assert.equal(harness.processes.length, 0);

  // Stop cannot complete while the close contract fails.
  const failed = await lifecycle.stop();
  assert.equal(failed.phase, 'offline');
  assert.equal(failed.reason, 'resource-close-failed');
  assert.equal(failed.retryRequired, true);
  assert.equal(failed.resources, 1);

  // Restoring the close lets the tracked cleanup path release the handle.
  harness.callbacks[0].close = realClose;
  const retry = await lifecycle.stop();
  assert.equal(retry.phase, 'stopped');
  assert.equal(retry.resources, 0);
  assert.equal(retry.retryRequired, false);
  assert.equal(harness.callbacks[0].healthy(), false);
  assert.equal(fs.existsSync(launchDir), false);
});

test('callback config and policy allow only the exact fixed POST', () => {
  const now = Date.now();
  const input = {
    version: 1,
    environmentId: 'env-test',
    grant: {
      environmentId: 'env-test',
      scheme: 'http',
      host: '192.0.2.10',
      port: 8080,
      method: 'POST',
      pathname: '/v1/chat/completions',
      expiresAt: now + 10_000,
      model: 'test-model',
    },
    timeoutMs: 1000,
    maxPending: 4,
    host: '127.0.0.1',
    port: 0,
  };
  const config = callbackRuntime.validateCallbackConfig(input, now);
  const policy = makePolicyHelpers();
  const request = {
    method: 'POST',
    url: 'http://192.0.2.10:8080/v1/chat/completions',
    host: '192.0.2.10:8080',
  };

  assert.equal(
    callbackRuntime.evaluateRequest(config, request, {}, now, policy),
    true
  );
  assert.equal(
    callbackRuntime.evaluateRequest(
      config,
      { ...request, method: 'GET' },
      {},
      now,
      policy
    ),
    false
  );
  assert.equal(
    callbackRuntime.evaluateRequest(
      config,
      { ...request, url: 'http://192.0.2.10:8080/v1/other' },
      {},
      now,
      policy
    ),
    false
  );
  assert.equal(
    callbackRuntime.evaluateRequest(
      config,
      { ...request, host: '192.0.2.11:8080' },
      {},
      now,
      policy
    ),
    false
  );
  assert.equal(
    callbackRuntime.evaluateRequest(
      config,
      { method: 'CONNECT', host: '192.0.2.10:8080' },
      {},
      now,
      policy
    ),
    false
  );
  assert.equal(
    callbackRuntime.evaluateRequest(config, request, {}, now + 10_001, policy),
    false
  );

  assert.throws(
    () =>
      callbackRuntime.validateCallbackConfig(
        { ...input, grant: { ...input.grant, pathname: '/v1/other' } },
        now
      ),
    /single model endpoint/
  );
  assert.throws(
    () =>
      callbackRuntime.validateCallbackConfig(
        { ...input, grant: { ...input.grant, method: 'GET' } },
        now
      ),
    /POST/
  );
  assert.throws(
    () =>
      callbackRuntime.validateCallbackConfig(
        { ...input, grant: { ...input.grant, host: 'example.com' } },
        now
      ),
    /IPv4/
  );
  assert.throws(
    () =>
      callbackRuntime.validateCallbackConfig(
        { ...input, grant: { ...input.grant, expiresAt: now - 1 } },
        now
      ),
    /expired/
  );
  assert.throws(
    () =>
      callbackRuntime.validateCallbackConfig(
        {
          ...input,
          grant: {
            ...input.grant,
            expiresAt: now + callbackRuntime.MAX_GRANT_MS + 1,
          },
        },
        now
      ),
    /bound/
  );
  assert.throws(
    () => callbackRuntime.validateCallbackConfig({ ...input, extra: true }, now),
    /unexpected field/
  );
  assert.throws(
    () =>
      callbackRuntime.validateCallbackConfig(
        { ...input, grant: { ...input.grant, extra: true } },
        now
      ),
    /unexpected field/
  );
  assert.throws(
    () => callbackRuntime.validateCallbackConfig({ ...input, host: '0.0.0.0' }, now),
    /loopback/
  );
});

test('callback runtime resolves canonical helpers from the installed profile only', () => {
  const source = fs.readFileSync(
    path.join(PROFILE_DIR, 'callback-runtime.cjs'),
    'utf8'
  );
  assert.ok(source.includes("require('./vendor/network-policy.cjs')"));
  assert.equal(source.includes('harness-native-vm-poc'), false);
  assert.equal(source.includes('src/runtime'), false);
  assert.equal(source.includes('src/protocol'), false);
});

test('explicit profile install stages canonical files and runs pinned npm ci only when called', async (t) => {
  const root = tempDir(t);
  const sourceRoot = path.join(root, 'canonical');
  const profileDir = path.join(root, 'profile');
  for (const entry of iron.CANONICAL_FILES) {
    const file = path.join(sourceRoot, entry.source);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `module.exports = {}; // ${entry.source}\n`);
  }
  fs.mkdirSync(profileDir, { recursive: true });
  fs.copyFileSync(
    path.join(PROFILE_DIR, 'package.json'),
    path.join(profileDir, 'package.json')
  );
  fs.copyFileSync(
    path.join(PROFILE_DIR, 'npm-shrinkwrap.json'),
    path.join(profileDir, 'npm-shrinkwrap.json')
  );
  fs.copyFileSync(
    path.join(PROFILE_DIR, 'callback-runtime.cjs'),
    path.join(profileDir, 'callback-runtime.cjs')
  );

  const staged = await iron.stageCallbackProfile({ sourceRoot, profileDir });
  assert.equal(staged.files.length, iron.CANONICAL_FILES.length);
  for (const entry of iron.CANONICAL_FILES) {
    const file = path.join(profileDir, entry.destination);
    assert.equal(fs.lstatSync(file).isFile(), true);
    assert.equal(fs.lstatSync(file).mode & 0o777, entry.mode);
  }

  let invocation;
  const result = await iron.installCallbackProfile({
    sourceRoot,
    profileDir,
    run: async ({ command, args, cwd }) => {
      invocation = { command, args, cwd };
      for (const [name, version] of [
        ['@grpc/grpc-js', iron.GRPC_JS_VERSION],
        ['@grpc/proto-loader', iron.PROTO_LOADER_VERSION],
      ]) {
        const packageFile = path.join(
          profileDir,
          'node_modules',
          ...name.split('/'),
          'package.json'
        );
        fs.mkdirSync(path.dirname(packageFile), { recursive: true });
        fs.writeFileSync(packageFile, JSON.stringify({ name, version }));
      }
    },
  });

  assert.equal(invocation.command, 'npm');
  assert.equal(invocation.args[0], 'ci');
  assert.ok(invocation.args.includes('--ignore-scripts'));
  assert.ok(invocation.args.includes('--omit=dev'));
  assert.equal(invocation.args.includes('install'), false);
  assert.equal(invocation.cwd, profileDir);
  assert.equal(result.grpcJs, '1.14.7');
  assert.equal(result.protoLoader, '0.8.0');

  const checked = iron.assertCallbackProfileInstalled({ profileDir });
  assert.equal(checked.callbackRuntime, path.join(profileDir, 'callback-runtime.cjs'));
  assert.equal(checked.protoFile, path.join(profileDir, 'vendor', 'iron-transform.proto'));

  const grpcPackage = path.join(
    profileDir,
    'node_modules',
    '@grpc',
    'grpc-js',
    'package.json'
  );
  fs.writeFileSync(grpcPackage, JSON.stringify({ version: '9.9.9' }));
  assert.throws(
    () => iron.assertCallbackProfileInstalled({ profileDir }),
    /pinned versions/
  );
});

test('profile staging rejects a missing canonical source', async (t) => {
  const root = tempDir(t);
  const profileDir = path.join(root, 'profile');
  await assert.rejects(
    iron.stageCallbackProfile({
      sourceRoot: path.join(root, 'missing'),
      profileDir,
    }),
    /canonical_missing|missing/
  );
});

// A stock request-path smoke through the actual proxy listener requires the
// pinned linux-amd64 Iron binary and a Linux host, so it is deferred to the
// Linux evidence gate; this suite only verifies the binary digest locally.
test('optional official Iron binary digest check', {
  skip: !process.env.IRON_TEST_BINARY,
}, async () => {
  const binary = process.env.IRON_TEST_BINARY;
  const expected = process.env.IRON_TEST_SHA256 || iron.IRON_SHA256;
  const verified = await iron.verifyIronBinary(binary, expected);
  assert.equal(verified.sha256, expected.toLowerCase());
  assert.ok(verified.bytes > 0);
});
