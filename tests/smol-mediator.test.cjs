const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { once } = require("node:events");
const { createMediator } = require("../src/runtime/smol-mediator.cjs");
const identity = "a".repeat(32);

async function fixture(t, extra = {}) {
  const sockets = new Set(), received = [];
  const proxy = net.createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.on("data", bytes => { received.push(bytes); socket.write(bytes); });
  });
  proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
  const mediator = await createMediator({ proxyPort: proxy.address().port, virtualPort: 8080, ...extra });
  t.after(async () => { await mediator.close(); for (const s of sockets) s.destroy(); await new Promise(r => proxy.close(r)); });
  function prelude(payload, overrides = {}) {
    const b = Buffer.alloc(81); b.write("SMOLMEG2");
    Buffer.from(overrides.token ?? mediator.token, "hex").copy(b, 8);
    Buffer.from(overrides.identity ?? identity, "hex").copy(b, 40);
    b[72] = 4; b.writeUInt16BE(overrides.port ?? 8080, 73);
    Buffer.from(overrides.ip ?? "c0000201", "hex").copy(b, 75);
    b.writeUInt16BE(payload.length, 79); return Buffer.concat([b, payload]);
  }
  async function connect() {
    const client = net.connect(Number(mediator.address.split(":")[1]), "127.0.0.1");
    client.on("error", () => {}); await once(client, "connect");
    t.after(() => client.destroy()); return client;
  }
  return { mediator, received, prelude, connect };
}

test("requires an activated launch identity, valid host token and exact virtual destination", async t => {
  const f = await fixture(t);
  for (const variant of [{}, { identity: "b".repeat(32) }, { token: "0".repeat(64) }, { port: 80 }, { ip: "7f000001" }]) {
    const c = await f.connect(), chunks = [];
    c.on("data", b => chunks.push(b)); const closed = once(c, "close");
    c.end(f.prelude(Buffer.from("rejected"), variant)); await closed;
    assert(!Buffer.concat(chunks).includes(2));
    f.mediator.activate(identity);
  }
  assert.equal(f.received.length, 0);
});

test("redirects prelude and following bytes exactly once to the fixed host proxy", async t => {
  const f = await fixture(t); f.mediator.activate(identity);
  const c = await f.connect(), chunks = [];
  const payload = Buffer.from([0, 1, 255, 42]), tail = Buffer.from("tail");
  const expected = Buffer.concat([Buffer.from([2]), payload, tail]);
  const done = new Promise((resolve, reject) => {
    c.setTimeout(2000, () => reject(new Error("relay timeout")));
    c.on("data", b => { chunks.push(b); if (Buffer.concat(chunks).length >= expected.length) resolve(); });
  });
  const frame = f.prelude(payload);
  c.write(frame.subarray(0, 25));
  await new Promise(r => setImmediate(r));
  c.write(Buffer.concat([frame.subarray(25), tail])); await done;
  assert.deepEqual(Buffer.concat(chunks), expected);
  assert.deepEqual(Buffer.concat(f.received), Buffer.concat([payload, tail]));
  const closed = once(c, "close"); f.mediator.revoke(); await closed;
  assert.equal(f.mediator.healthy(), true); // Listener remains available, new flows are denied.
});

test("proxy failure cannot grant direct egress and closing the mediator is idempotent", async t => {
  const unused = net.createServer(); unused.listen(0, "127.0.0.1"); await once(unused, "listening");
  const port = unused.address().port; await new Promise(r => unused.close(r));
  const m = await createMediator({ proxyPort: port, virtualPort: 8080 }); t.after(() => m.close());
  m.activate(identity);
  const c = net.connect(Number(m.address.split(":")[1]), "127.0.0.1"); c.on("error", () => {});
  await once(c, "connect"); const chunks = []; c.on("data", b => chunks.push(b));
  const b = Buffer.alloc(81); b.write("SMOLMEG2"); Buffer.from(m.token, "hex").copy(b, 8); Buffer.from(identity, "hex").copy(b, 40); b[72] = 4; b.writeUInt16BE(8080, 73); Buffer.from("c0000201", "hex").copy(b, 75);
  const closed = once(c, "close"); c.write(b); await closed;
  assert.equal(Buffer.concat(chunks).length, 0);
  await Promise.all([m.close(), m.close()]); assert.equal(m.healthy(), false);
});

test("credential route is limited to its exact host-owned listener and revoked with the launch", async t => {
  let credentialBytes = "";
  const sockets = new Set();
  const bridge = net.createServer(socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {}); socket.on("data", data => { credentialBytes += data; socket.write(data); }); });
  bridge.listen(0, "127.0.0.1"); await once(bridge, "listening");
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => bridge.close(resolve)); });
  const f = await fixture(t, { credentialPort: bridge.address().port }); f.mediator.activate(identity);
  const client = await f.connect(); const data = once(client, "data");
  client.write(f.prelude(Buffer.from("credential-request"), { port: bridge.address().port }));
  // Redirect response can arrive separately from echoed application bytes.
  const first = (await data)[0]; assert.equal(first[0], 2);
  if (!credentialBytes) await once(client, "data");
  assert.equal(credentialBytes, "credential-request"); assert.equal(f.received.length, 0);
  const closed = once(client, "close"); f.mediator.revoke(); await closed;
});
