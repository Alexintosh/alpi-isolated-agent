const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { createHash } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { writeJson } = require("./atomic-json.cjs");
const { ensureCA, privateDirectory } = require("./iron-ca.cjs");
const { createIronCallback } = require("./iron-callback.cjs");
const { startOwnedProcess } = require("./owned-process.cjs");
const { createMediator } = require("./smol-mediator.cjs");

// Stock v0.56.0 darwin-arm64, verified release artifact (docs/m0/manifest.json).
const IRON_SHA256 = "5d46445310b13b1c86bdb51aac5db1c70b3f9a47365d704337f7e16e8acd7ba6";

async function assertPortFree(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", () => reject(new Error("The network port is already in use. It will not be adopted.")));
    server.listen(port, "127.0.0.1", () => server.close(resolve));
  });
}

function probe(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.setTimeout(200, () => socket.destroy(new Error("timeout")));
    socket.once("error", reject);
    socket.once("connect", () => { socket.destroy(); resolve(); });
  });
}

class Network {
  constructor({ stateRoot, ironBinary, decide, credentialBridge, onFault = () => {} }) {
    this.stateRoot = stateRoot; this.ironBinary = ironBinary;
    this.decide = decide; this.onFault = onFault; this.active = new Set(); this.closers = new Map(); this.restorers = new Map();
    this.credentialBridge = credentialBridge;
  }

  async quarantine(id) {
    const restore = this.restorers.get(id);
    // During initial construction there is no safe stable endpoint to recover.
    return restore ? restore('policy-changed') : this.closers.get(id)?.();
  }

  async restore(id, options) {
    const restore = this.restorers.get(id);
    if (!restore) throw new Error('No managed network to restore.');
    return restore('user-retry', options);
  }

  async open(definition, { signal } = {}) {
    const lifetime = new AbortController();
    signal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    const { id, kind, proxyPort } = definition;
    if (!/^[a-z0-9-]+$/.test(id) || !["lima", "smolvm"].includes(kind) ||
        !Number.isInteger(proxyPort) || proxyPort < 1024 || proxyPort > 65535)
      throw new Error("Invalid environment network configuration.");
    if (this.active.has(id)) throw new Error("The environment network is already managed.");
    this.active.add(id);
    let callback, mediator, bridge, process, closing = false, closePromise, resetPromise, processEpoch = 0, retryRequired = false, resetValidations = [];
    let status = { phase: 'starting', reason: 'initial-start', updatedAt: new Date().toISOString() };
    const transitions = [];
    const directory = path.join(this.stateRoot, 'network', id);
    const publish = (phase, reason) => {
      status = { phase, reason, updatedAt: new Date().toISOString() };
      transitions.push(status); if (transitions.length > 32) transitions.shift();
      // Fixed codes only: no URLs, raw process output, tokens or credentials.
      try { writeJson(path.join(directory, 'status.json'), { ...status, transitions }); } catch {}
      this.onFault(id, reason, phase);
    };
    const suspend = () => { mediator?.pause(); callback?.pause(); bridge?.pause(); };
    const faulted = () => {
      if (closing) return;
      // Keep the control channel and stable mediated endpoint. Guest egress
      // stays closed; an explicit retry can restore only the owned proxy.
      retryRequired = true; suspend(); publish('offline', 'proxy-exited');
    };
    const close = () => {
      if (closePromise) return closePromise;
      closing = true;
      suspend(); publish('stopped', 'environment-stopped');
      lifetime.abort();
      closePromise = (async () => {
        await resetPromise?.catch(() => {});
        mediator?.revoke();
        await callback?.close();
        await bridge?.close();
        await process?.close();
        await mediator?.close();
        this.active.delete(id);
        this.closers.delete(id);
        this.restorers.delete(id);
      })();
      return closePromise;
    };
    this.closers.set(id, close);
    try {
      privateDirectory(directory);
      signal?.throwIfAborted();
      const binaryHash = createHash("sha256").update(fs.readFileSync(this.ironBinary)).digest("hex");
      if (binaryHash !== IRON_SHA256) throw new Error("Iron does not match the verified version.");
      await assertPortFree(proxyPort);
      const { caFile, keyFile } = await ensureCA(path.join(directory, "ca"), { signal });
      bridge = await this.credentialBridge?.({ definition, proxyPort, caFile, signal, decide: this.decide });
      signal.throwIfAborted();
      callback = await createIronCallback({ environmentId: id, decide: this.decide, transform: bridge?.transform });
      signal.throwIfAborted();
      if (kind === "smolvm") mediator = await createMediator({ proxyPort, credentialPort: bridge?.port });
      signal.throwIfAborted();
      const configFile = path.join(directory, "iron.json");
      writeJson(configFile, {
        dns: { enabled: false },
        proxy: {
          http_listen: "127.0.0.1:0", https_listen: "127.0.0.1:0",
          tunnel_listen: `127.0.0.1:${proxyPort}`,
          // Local models may take minutes before the first streamed token.
          upstream_response_header_timeout: "30m",
          // Keep stock connect-time IMDS/loopback protection. No empty CIDR override.
        },
        tls: { mode: "mitm", ca_cert: caFile, ca_key: keyFile },
        transforms: [{ name: "grpc", config: {
          name: "isolated-host-policy", target: callback.address,
          send_request_body: false, send_response_body: false,
        } }],
        metrics: { listen: "127.0.0.1:0" }, log: { level: "error" },
      });
      async function startProxy(startSignal = lifetime.signal) {
        startSignal.throwIfAborted();
        const epoch = ++processEpoch;
        const started = await startOwnedProcess({ binary: this.ironBinary,
          args: ['-config', configFile], env: { PATH: '/usr/bin:/bin', HOME: directory }, signal: startSignal,
          onExit: () => { if (epoch === processEpoch && status.phase !== 'restarting') faulted(); } });
        process = started;
        if (closing || startSignal.aborted) { await started.close(); startSignal.throwIfAborted(); throw new Error('Network closed.'); }
        for (let attempt = 0; attempt < 100; attempt++) {
          startSignal.throwIfAborted();
          if (!started.healthy()) throw new Error('Iron is unavailable.');
          try { await probe(proxyPort); return; } catch {}
          await delay(50, undefined, { signal: startSignal });
        }
        throw new Error('Iron did not become ready before the timeout.');
      }
      const start = startProxy.bind(this);
      const restore = (reason, { validate } = {}) => {
        if (closing) return Promise.reject(new Error('Network is closing.'));
        // Synchronous pause prevents any request racing a persisted revocation.
        suspend();
        // Expiry/revocation may cancel traffic, but cannot revive a failed proxy.
        if (retryRequired && reason !== 'user-retry') return resetPromise ?? Promise.resolve();
        if (resetPromise && status.phase === 'restarting') {
          if (validate) resetValidations.push(validate);
          return resetPromise;
        }
        retryRequired = false;
        resetValidations = validate ? [validate] : [];
        publish('restarting', reason);
        const operation = (async () => {
          ++processEpoch; // the intentional old-process exit is not a fault
          await process?.close();
          lifetime.signal.throwIfAborted();
          await assertPortFree(proxyPort);
          await start();
          // Validate all callers while traffic is still paused. A reconnect
          // joining a policy reset contributes its own launch/cancellation check.
          while (resetValidations.length) await resetValidations.shift()();
          lifetime.signal.throwIfAborted();
          callback.resume(); bridge?.resume(); mediator?.resume();
          if (!process.healthy() || !callback.healthy() || (bridge && !bridge.healthy()) || (mediator && !mediator.healthy()))
            throw new Error('Network recovery did not complete.');
          publish('ready', reason);
        })().catch(async error => {
          retryRequired = true; suspend();
          ++processEpoch;
          await process?.close();
          if (!closing) publish('offline', 'recovery-failed');
          throw error;
        }).finally(() => { if (resetPromise === operation) resetPromise = undefined; });
        resetPromise = operation;
        return operation;
      };
      await start(signal);
      publish('ready', 'initial-start');
      this.restorers.set(id, restore);
      return {
        // Main-process-only guard; the CA key is deliberately not exported.
        proxyPort, caFile, mediator, bridge,
        healthy: () => !closing && status.phase === 'ready' && process.healthy() && callback.healthy() && (!mediator || mediator.healthy()) && (!bridge || bridge.healthy()),
        status: () => ({ ...status }),
        close,
      };
    } catch (error) {
      await close();
      // An async creation may have returned after quarantine's first cleanup.
      // Dispose those late resources too before the open operation rejects.
      await callback?.close(); await bridge?.close(); await process?.close(); await mediator?.close();
      throw error;
    }
  }
}

module.exports = { Network, IRON_SHA256 };
