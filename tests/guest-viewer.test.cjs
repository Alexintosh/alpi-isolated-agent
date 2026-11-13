const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const http = require('node:http');
const fs = require('node:fs');
const { once } = require('node:events');
const { PassThrough } = require('node:stream');
const { randomUUID } = require('node:crypto');
const { openGuestViewer } = require('../src/runtime/guest-viewer.cjs');
const common = require('../src/runtime/driver-common.cjs');
// Substitute only the CLI transport. No test executes smolvm or a real guest.
const originalStream = common.streamCommand;
let streamImplementation = () => { throw new Error('Unexpected CLI call'); };
common.streamCommand = (...args) => streamImplementation(...args);
const { SmolDriver, WRAP_IMAGE } = require('../src/runtime/smol-driver.cjs');
common.streamCommand = originalStream;
const { environment } = require('../src/runtime/environments.cjs');
const PASSWORD = 'ab'.repeat(16);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check) {
  const end = Date.now() + 2000;
  while (!check()) { if (Date.now() > end) throw new Error('Synthetic test timed out'); await new Promise(r => setTimeout(r, 5)); }
}
function channel() {
  const input = new PassThrough(), output = new PassThrough(), completion = deferred();
  const result = { input, output, done: completion.promise, stops: 0,
    stop() { result.stops++; input.destroy(); output.end(); completion.resolve(); },
    fail(error = new Error('private channel detail')) { output.destroy(); completion.reject(error); },
    finish(bytes) { output.end(bytes, () => completion.resolve()); } };
  result.done.catch(() => {});
  return result;
}
function passwordChannel(value = PASSWORD + '\n') {
  const result = channel();
  setImmediate(() => result.finish(value));
  return result;
}
async function socketFor(origin) {
  const url = new URL(origin), socket = net.connect(Number(url.port), url.hostname);
  socket.on('error', () => {});
  await once(socket, 'connect');
  return socket;
}
function closed(socket) { return socket.closed ? Promise.resolve() : new Promise(resolve => socket.once('close', resolve)); }
async function exchange(origin, bytes) {
  const socket = await socketFor(origin), chunks = [];
  socket.on('data', chunk => chunks.push(chunk));
  socket.end(bytes);
  await closed(socket);
  return Buffer.concat(chunks);
}
async function fixture(t, overrides = {}) {
  const channels = [];
  const lease = await openGuestViewer({ assertCurrent: async () => {}, passwordChannel: () => passwordChannel(),
    openChannel: () => { const c = channel(); channels.push(c); return c; },
    focus: async () => {}, ...overrides });
  t.after(() => lease.close());
  return { lease, channels };
}

test('raw HTTP and upgrade duplex bytes use separate channels on a random loopback port', async t => {
  const requests = [], peers = new Set();
  const guest = http.createServer((req, res) => { requests.push(req.url); res.end('stock desktop'); });
  guest.on('upgrade', (req, socket, head) => {
    requests.push(req.url);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    socket.on('data', bytes => socket.write(bytes));
    if (head.length) socket.write(head);
  });
  guest.on('connection', socket => { peers.add(socket); socket.on('close', () => peers.delete(socket)); });
  guest.listen(0, '127.0.0.1'); await once(guest, 'listening');
  t.after(async () => { for (const peer of peers) peer.destroy(); await new Promise(r => guest.close(r)); });
  let opened = 0;
  const { lease } = await fixture(t, { openChannel: () => {
    opened++;
    const socket = net.connect(guest.address().port, '127.0.0.1');
    const done = new Promise((resolve, reject) => { socket.once('error', reject); socket.once('close', resolve); });
    return { input: socket, output: socket, done, stop: () => socket.destroy() };
  } });
  assert.match(lease.origin, /^http:\/\/127\.0\.0\.1:[1-9]\d*$/);
  assert.equal(new URL(lease.origin).search, ''); assert(!lease.origin.includes(PASSWORD));
  assert.equal(lease.password, PASSWORD);
  const response = await exchange(lease.origin, 'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
  assert.match(response.toString(), /200 OK/); assert.match(response.toString(), /stock desktop/);
  const ws = await socketFor(lease.origin); t.after(() => ws.destroy());
  let received = Buffer.alloc(0); ws.on('data', b => { received = Buffer.concat([received, b]); });
  ws.write('GET /ws HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  await until(() => received.includes(Buffer.from('\r\n\r\n')));
  const payload = Buffer.from([0, 255, 128, 10, 13, 1, 254]); ws.write(payload);
  await until(() => received.subarray(-payload.length).equals(payload));
  assert.match(received.toString(), /101 Switching Protocols/);
  assert.deepEqual(requests, ['/', '/ws']); assert.equal(opened, 2);
});

test('failed per-client validation forwards no bytes and revokes existing channels', async t => {
  let valid = true, validations = 0;
  const { lease, channels } = await fixture(t, { assertCurrent: async () => { validations++; if (!valid) throw new Error('replacement'); } });
  const first = await socketFor(lease.origin); await until(() => channels.length === 1);
  await until(() => validations >= 5); first.write('allowed');
  await until(() => channels[0].input.readableLength === 7);
  valid = false;
  assert.equal((await exchange(lease.origin, 'must not forward')).length, 0);
  await closed(first); await lease.close();
  assert.equal(channels.length, 1); assert(channels[0].stops > 0);
  assert.equal(channels[0].input.read()?.toString(), 'allowed');
});

test('periodic validation revokes idle existing channels without another connection', async t => {
  let valid = true;
  const { lease, channels } = await fixture(t, { monitorInterval: 10,
    assertCurrent: async () => { if (!valid) throw new Error('changed'); } });
  const socket = await socketFor(lease.origin); await until(() => channels.length === 1);
  valid = false; await closed(socket); await lease.close(); assert(channels[0].stops > 0);
});

test('post-channel validation blocks bytes if launch changes while channel creation is pending', async t => {
  const pending = deferred(); let valid = true, entered = false;
  const { lease } = await fixture(t, { assertCurrent: async () => { if (!valid) throw new Error('changed'); },
    openChannel: () => { entered = true; return pending.promise; } });
  const socket = await socketFor(lease.origin); socket.write('never forwarded');
  await until(() => entered); valid = false;
  const late = channel(); pending.resolve(late);
  await closed(socket); await lease.close();
  assert.equal(late.input.readableLength, 0); assert(late.stops > 0);
});

for (const action of ['close', 'abort']) {
  test(`${action} during pending channel creation drains the late channel`, async t => {
    const pending = deferred(), controller = new AbortController(); let entered = false, channelSignal;
    const { lease } = await fixture(t, { signal: controller.signal,
      openChannel: signal => { entered = true; channelSignal = signal; return pending.promise; } });
    const socket = await socketFor(lease.origin); socket.write('blocked'); await until(() => entered);
    if (action === 'abort') controller.abort();
    const closing = lease.close(); await closed(socket); assert(channelSignal.aborted);
    const late = channel(); pending.resolve(late); await closing;
    assert(late.stops > 0); assert.equal(late.input.readableLength, 0);
    await assert.rejects(socketFor(lease.origin), /ECONNREFUSED/);
  });
  test(`${action} during pending validation cannot create a channel`, async t => {
    const pending = deferred(), controller = new AbortController(); let block = false, entered = false, opened = 0;
    const { lease } = await fixture(t, { signal: controller.signal,
      assertCurrent: async () => { if (block) { entered = true; await pending.promise; } },
      openChannel: () => { opened++; return channel(); } });
    block = true; const socket = await socketFor(lease.origin); socket.write('blocked'); await until(() => entered);
    if (action === 'abort') controller.abort();
    const closing = lease.close(); await closed(socket); pending.resolve(); await closing;
    assert.equal(opened, 0);
  });
  test(`${action} during post-open validation drains the channel before forwarding`, async t => {
    const pending = deferred(), controller = new AbortController(), opened = channel();
    let created = false, entered = false;
    const { lease } = await fixture(t, { signal: controller.signal,
      assertCurrent: async () => { if (created) { entered = true; await pending.promise; } },
      openChannel: () => { created = true; return opened; } });
    const socket = await socketFor(lease.origin); socket.write('blocked'); await until(() => entered);
    if (action === 'abort') controller.abort();
    const closing = lease.close(); await closed(socket); assert(opened.stops > 0);
    pending.resolve(); await closing; assert.equal(opened.input.readableLength, 0);
  });
}

test('channel errors clean up pipes and allow a fresh independently validated connection', async t => {
  const { lease, channels } = await fixture(t);
  const socket = await socketFor(lease.origin); await until(() => channels.length === 1);
  channels[0].fail(); await closed(socket); await until(() => channels[0].stops > 0);
  const next = await socketFor(lease.origin); await until(() => channels.length === 2);
  await lease.close(); await closed(next); assert(channels[1].stops > 0);
});

test('channel creation failure closes the lease without forwarding or exposing private errors', async t => {
  const { lease } = await fixture(t, { openChannel: () => { throw new Error(PASSWORD); } });
  assert.equal((await exchange(lease.origin, 'blocked')).length, 0);
  await lease.close(); await assert.rejects(socketFor(lease.origin), /ECONNREFUSED/);
});

test('listener explicitly requests an ephemeral IPv4 loopback binding', async t => {
  const listen = net.Server.prototype.listen, bindings = [];
  net.Server.prototype.listen = function (...args) { bindings.push(args.slice(0, 2)); return listen.apply(this, args); };
  try {
    const { lease } = await fixture(t);
    assert.deepEqual(bindings, [[0, '127.0.0.1']]);
    await lease.close();
  } finally { net.Server.prototype.listen = listen; }
});

test('connection cap includes pending channels and rejects surplus clients', async t => {
  const pending = [];
  const { lease } = await fixture(t, { openChannel: () => { const p = deferred(); pending.push(p); return p.promise; } });
  const sockets = [];
  for (let i = 0; i < 16; i++) sockets.push(await socketFor(lease.origin));
  await until(() => pending.length === 16);
  const extra = await socketFor(lease.origin); await closed(extra); assert.equal(pending.length, 16);
  for (const socket of sockets) socket.destroy(); await tick();
  const more = await socketFor(lease.origin); await closed(more); assert.equal(pending.length, 16);
  const closing = lease.close(), late = pending.map(() => channel());
  pending.forEach((p, i) => p.resolve(late[i])); await closing;
  assert(late.every(c => c.stops > 0));
});

for (const value of ['short', 'a'.repeat(129), 'g'.repeat(32), PASSWORD + '\nnoise', PASSWORD + '\n\n', PASSWORD + '\r', 'a'.repeat(1024), Buffer.alloc(32, 0xe1)]) {
  test(`password rejects malformed or oversized private output (${typeof value === 'string' ? value.length : 'non-ascii'})`, async () => {
    await assert.rejects(openGuestViewer({ assertCurrent: async () => {},
      passwordChannel: () => passwordChannel(value), openChannel: () => { throw new Error('not reached'); } }),
    error => error.message === 'The guest desktop viewer is unavailable.' && !error.message.includes(PASSWORD));
  });
}

test('password accepts only a single 32..128 hex token; pre-abort performs no guest operations', async t => {
  const { lease } = await fixture(t, { passwordChannel: () => passwordChannel('CD'.repeat(64) + '\r\n') });
  assert.equal(lease.password, 'CD'.repeat(64));
  const controller = new AbortController(); controller.abort(new Error(PASSWORD));
  await assert.rejects(openGuestViewer({ signal: controller.signal,
    assertCurrent: () => assert.fail('pre-abort validated'), passwordChannel: () => assert.fail('pre-abort executed') }),
  error => !error.message.includes(PASSWORD));
});

test('abort during pending password creation drains late output and never opens a listener', async () => {
  const controller = new AbortController(), pending = deferred(); let entered = false, forwarded = false;
  const opening = openGuestViewer({ signal: controller.signal, assertCurrent: async () => {},
    passwordChannel: () => { entered = true; return pending.promise; },
    openChannel: () => { forwarded = true; return channel(); } });
  const rejection = assert.rejects(opening, /unavailable/);
  await until(() => entered); controller.abort();
  const late = channel(); pending.resolve(late); await rejection;
  assert(late.stops > 0); assert(!forwarded);
});

test('private password channel failure is sanitized and produces no console logging', async () => {
  const logged = [], methods = ['log', 'error', 'warn', 'info', 'debug'];
  const originals = methods.map(method => console[method]);
  for (const method of methods) console[method] = (...args) => logged.push(args);
  try {
    const privateChannel = channel();
    const opening = openGuestViewer({ assertCurrent: async () => {}, passwordChannel: () => privateChannel });
    const rejection = assert.rejects(opening, error => error.message === 'The guest desktop viewer is unavailable.' && !String(error.stack).includes(PASSWORD));
    await tick(); privateChannel.output.write(PASSWORD); privateChannel.output.end();
    // Transport errors can contain guest data; only the fixed public error escapes.
    privateChannel.fail(new Error(PASSWORD)); await rejection;
    assert.deepEqual(logged, []); assert(privateChannel.stops > 0);
  } finally { methods.forEach((method, i) => { console[method] = originals[i]; }); }
});

function driverFixture(t) {
  const runtimeRoot = fs.mkdtempSync('/tmp/viewer-driver-');
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const definition = environment('wrapvm-v1'), ownershipToken = randomUUID();
  const driver = new SmolDriver({ definition, runtimeRoot, binary: '/fixture/smolvm' });
  driver.verifyRuntime = () => {};
  const network = { healthy: () => false };
  driver.launch = { network, pid: 123 };
  const record = { name: definition.machine, labels: { owner: definition.owner, identity: ownershipToken },
    state: 'running', pid: 123, network: true, mounts: 0, ports: 0, image: WRAP_IMAGE,
    restart_policy: 'never', allowed_hosts: ['=host.smolvm.internal'], allowed_cidrs: ['192.0.2.1/32'] };
  const calls = [], channels = [];
  driver.command = async (args, options) => { calls.push({ args, options }); return { stdout: args[1] === 'ls' ? JSON.stringify([record]) : '' }; };
  streamImplementation = (binary, args, options) => {
    calls.push({ binary, args, options });
    if (args.at(-1) === 'password') return passwordChannel();
    const c = channel(); channels.push(c); return c;
  };
  return { driver, options: { network, ownershipToken }, calls, channels, record };
}

test('local ARM64 viewer focuses Chromium without accepting a guest-selected command', async t => {
  const {driver,options,calls}=driverFixture(t);
  driver.definition={...driver.definition,imageId:'local-arm64'};
  const lease=await driver.openViewer(options);
  try {
    await lease.focusBrowser();
    const focus=calls.find(c=>c.args.at(-1).includes('xdotool'));
    assert.equal(focus.args.at(-1), "DISPLAY=:1 exec xdotool search --onlyvisible --limit 1 --class '^[Cc]hromium$' windowactivate --sync");
  } finally { await lease.close(); }
});

test('SmolDriver uses fixed private password, relay and focus commands with egress offline', async t => {
  const { driver, options, calls, channels, record } = driverFixture(t);
  const lease = await driver.openViewer({ ...options, port: 9999, command: 'untrusted' }); t.after(() => lease.close());
  assert.equal(lease.password, PASSWORD);
  const socket = await socketFor(lease.origin); await until(() => channels.length === 1);
  await lease.focusBrowser();
  const password = calls.find(c => c.args.at(-1) === 'password');
  assert.deepEqual(password.args, ['machine', 'exec', '--name', driver.definition.machine, '--user', 'user', '--', '/opt/wrap/bin/wrap-desktop', 'password']);
  assert.equal(password.options.timeout, 5000);
  const relay = calls.find(c => c.args.includes('--stream'));
  assert.deepEqual(relay.args.slice(0, -1), ['machine', 'exec', '--name', driver.definition.machine, '--user', 'user', '--interactive', '--stream', '--', '/bin/sh', '-c']);
  assert.equal(relay.options.timeout, 0);
  assert.match(relay.args.at(-1), /\$HOME\/\.harness-isolated\/node\/bin\/node/);
  assert.match(relay.args.at(-1), /net\.connect\(6080, "127\.0\.0\.1"\)/);
  const focus = calls.find(c => c.args.at(-1).includes('xdotool'));
  assert.equal(focus.args.at(-1), "DISPLAY=:1 exec xdotool search --onlyvisible --limit 1 --class '^Google-chrome$' windowactivate --sync");
  assert.equal(focus.options.timeout, 10000); assert(!focus.args.includes('--interactive'));
  assert(!JSON.stringify(calls.map(c => c.args)).includes(PASSWORD));
  assert(!JSON.stringify(calls.map(c => c.args)).includes('untrusted'));
  assert.equal(record.ports, 0); assert(calls.every(c => ['ls', 'exec'].includes(c.args[1])));
  driver.launch = { ...driver.launch }; // Identical PID still cannot replace the retained object.
  await assert.rejects(lease.focusBrowser(), /unavailable/); await closed(socket); await lease.close();
  assert(channels[0].stops > 0);
});

for (const change of ['network', 'owner', 'configuration', 'pid', 'invalid', 'missing']) {
  test(`SmolDriver rejects ${change} mismatch before reading the password`, async t => {
    const { driver, options, record, calls } = driverFixture(t);
    if (change === 'network') options.network = undefined;
    if (change === 'owner') record.labels.identity = 'foreign';
    if (change === 'configuration') record.ports = 1;
    if (change === 'pid') record.pid++;
    if (change === 'invalid') driver.launch.invalid = true;
    if (change === 'missing') driver.launch = undefined;
    await assert.rejects(driver.openViewer(options), /unavailable/);
    assert(!calls.some(c => c.args[1] === 'exec'));
  });
}

test('focus validates after the fixed command and revokes on a replacement during execution', async t => {
  const { driver, options } = driverFixture(t);
  const lease = await driver.openViewer(options); t.after(() => lease.close());
  const command = driver.command;
  driver.command = async (args, options) => {
    const result = await command(args, options);
    if (args[1] === 'exec') driver.launch = { ...driver.launch };
    return result;
  };
  await assert.rejects(lease.focusBrowser(), /unavailable/); await lease.close();
});
