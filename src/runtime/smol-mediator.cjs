const net = require("node:net");
const { randomBytes, timingSafeEqual } = require("node:crypto");

// SMOLMEG2 from stock smolvm 1.34.1. No allow-direct decision exists here.
// One listener belongs to one environment/launch; the token stays on the host.
async function createMediator({ proxyPort, virtualPort = proxyPort, credentialPort, maxConnections = 256 }) {
  for (const port of [proxyPort, virtualPort, ...(credentialPort === undefined ? [] : [credentialPort])])
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid proxy port.");
  if (credentialPort === virtualPort || credentialPort === proxyPort) throw new Error("Internal destinations must be distinct.");
  if (!Number.isInteger(maxConnections) || maxConnections < 1) throw new Error("Invalid connection limit.");
  const token = randomBytes(32);
  const clients = new Set(), sockets = new Set();
  let identity, stopped = false, paused = false, closePromise;
  const dropConnections = () => { for (const socket of sockets) socket.destroy(); };
  function revoke() {
    identity = undefined;
    dropConnections();
  }
  const server = net.createServer(client => {
    if (stopped || paused || clients.size >= maxConnections) { client.destroy(); return; }
    clients.add(client); sockets.add(client);
    client.on("error", () => {});
    client.on("close", () => { clients.delete(client); sockets.delete(client); });
    client.setTimeout(2000, () => client.destroy());
    let pending = Buffer.alloc(0);
    const deny = () => { client.end(Buffer.from([1])); };
    function receive(chunk) {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length < 81) return;
      if (pending.subarray(0, 8).toString("ascii") !== "SMOLMEG2" ||
          !timingSafeEqual(pending.subarray(8, 40), token)) { client.destroy(); return; }
      if (!identity || pending.subarray(40, 56).toString("hex") !== identity ||
          !pending.subarray(56, 72).equals(Buffer.alloc(16)) ||
          pending[72] !== 4 || ![virtualPort, credentialPort].includes(pending.readUInt16BE(73)) ||
          pending.subarray(75, 79).toString("hex") !== "c0000201") { deny(); return; }
      const length = pending.readUInt16BE(79);
      if (length > 8192) { deny(); return; }
      if (pending.length < 81 + length) return;
      client.pause(); client.removeListener("data", receive);
      const acceptedIdentity = identity;
      const upstream = net.connect({ host: "127.0.0.1", port: pending.readUInt16BE(73) === virtualPort ? proxyPort : credentialPort });
      sockets.add(upstream);
      const dispose = () => { client.destroy(); upstream.destroy(); sockets.delete(upstream); };
      upstream.on("error", dispose); upstream.on("close", dispose); client.on("close", dispose);
      upstream.setTimeout(2000, dispose);
      upstream.once("connect", () => {
        if (stopped || paused || identity !== acceptedIdentity) { dispose(); return; }
        // Preserve all coalesced bytes after the prelude exactly once.
        client.write(Buffer.from([2])); upstream.write(pending.subarray(81)); pending = undefined;
        client.setTimeout(30 * 60 * 1000); upstream.setTimeout(30 * 60 * 1000);
        client.pipe(upstream); upstream.pipe(client); client.resume();
      });
    }
    client.on("data", receive);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  // Retain an error handler after binding; an unavailable listener stays closed.
  server.on("error", () => { stopped = true; revoke(); });
  return {
    address: `127.0.0.1:${server.address().port}`,
    // This object is main-process-only and must never be serialized as UI status.
    token: token.toString("hex"),
    healthy: () => !stopped && !paused && server.listening,
    pause() { paused = true; dropConnections(); },
    resume() { if (stopped) throw new Error('Mediated listener is closed.'); paused = false; },
    activate(machineId) {
      if (stopped || !/^[a-f0-9]{32}$/.test(machineId)) throw new Error("Invalid smolvm launch identity.");
      revoke(); identity = machineId;
    },
    revoke,
    close() {
      if (closePromise) return closePromise;
      stopped = true; revoke(); token.fill(0);
      closePromise = new Promise(resolve => server.close(resolve));
      return closePromise;
    },
  };
}

module.exports = { createMediator };
