const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { once } = require("node:events");
const { createRegistry } = require("../src/engines/index.cjs");
const { SmolvmEngine } = require("../src/engines/smolvm.cjs");
const { parseLaunch } = require("../src/engines/common.cjs");

test("rejects guest-provided external launch destinations and preserves credential privacy", () => {
  for (const value of [
    "https://evil.example/?token=x",
    "http://127.0.0.1:3080/other?token=x",
    "http://user:pass@127.0.0.1:3080/?token=x",
    "http://127.0.0.1:3080/",
    "not a URL",
  ])
    assert.throws(() => parseLaunch(value), /URL di avvio guest non valido/);
  assert.equal(
    parseLaunch("http://127.0.0.1:3080/?token=test").origin,
    "http://127.0.0.1:3080",
  );
});
test("environment identities have separate browser storage; invalid/cloud IDs cannot fall back", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "poc-eng-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const registry = createRegistry({ stateRoot: root });
  assert.notEqual(
    registry.get("lima-poc").partition,
    registry.get("wrapvm-poc").partition,
  );
  for (const id of ["cloud", "../lima-poc", null, { id: "lima-poc" }])
    assert.throws(() => registry.get(id), /Ambiente sconosciuto/);
  const unavailable = await registry.get("wrapvm-poc").inspect();
  assert.equal(unavailable.available, false);
  await assert.rejects(registry.get("wrapvm-poc").start(), /Runtime smolvm/);
});
test("socket transport carries binary streams, closes active sockets on cancellation and refuses occupied ports", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "poc-net-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const engine = new SmolvmEngine({ stateRoot: root });
  engine.port = 0;
  engine.exec = async () => "http://127.0.0.1:3080/?token=unit-test-only"; // Transport fixture, not a real VM test.
  const peers = new Set();
  const guest = net.createServer((s) => {
    peers.add(s);
    s.on("close", () => peers.delete(s));
    s.pipe(s);
  });
  guest.listen(engine.socket);
  await once(guest, "listening");
  t.after(() => {
    for (const s of peers) s.destroy();
    guest.close();
  });
  const controller = new AbortController();
  const lease = await engine.connect({ signal: controller.signal });
  t.after(() => lease.close());
  // Port 0 is only for this test; the returned origin must expose the allocated port.
  const port = Number(new URL(lease.origin).port);
  assert.ok(port > 0);
  const client = net.createConnection(port, "127.0.0.1");
  await once(client, "connect");
  const received = once(client, "data");
  const payload = Buffer.from([0, 1, 255, 128, 13, 10]);
  client.write(payload);
  assert.deepEqual((await received)[0], payload);
  const ended = once(client, "close");
  controller.abort();
  await ended;
  await lease.close();
  const blocker = net.createServer();
  blocker.listen(0, "127.0.0.1");
  await once(blocker, "listening");
  t.after(() => blocker.close());
  engine.port = blocker.address().port;
  await assert.rejects(engine.connect(), /occupata/);
  assert.equal(blocker.listening, true);
});
