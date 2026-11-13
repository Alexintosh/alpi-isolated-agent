const { EventEmitter } = require("node:events");
const { randomUUID } = require("node:crypto");
const path = require("node:path");
const { readJson, writeJson } = require("./atomic-json.cjs");

const PHASES = new Set(["new", "preparing", "ready", "starting", "running", "stopping", "stopped", "error"]);
const STOPPED = new Set(["missing", "stopped", "created"]);

// The persisted journal is intent/recovery metadata, never proof of live ownership.
// Drivers must independently check host-side identity before every mutation and
// when opening a connection; an earlier inspect is not an ownership lease.
class Coordinator extends EventEmitter {
  constructor({ stateRoot, definitions, drivers, network }) {
    super();
    this.file = path.join(stateRoot, "environments.json");
    this.definitions = new Map(definitions.map(d => [d.id, d]));
    this.drivers = drivers;
    this.network = network;
    this.queues = new Map();
    this.controllers = new Map();
    this.guards = new Map();
    this.leases = new Map();
    this.closing = false;
    this.journal = readJson(this.file, { version: 1, environments: {} });
    this.validateJournal();
  }

  validateJournal() {
    const j = this.journal;
    if (!j || j.version !== 1 || !j.environments || Array.isArray(j.environments))
      throw new Error("The environment registry is invalid. Explicit recovery is required.");
    for (const [id, value] of Object.entries(j.environments)) {
      if (!this.definitions.has(id) || !value || !PHASES.has(value.phase) ||
          typeof value.ownershipToken !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.ownershipToken) ||
          typeof value.prepared !== "boolean" ||
          (value.resetPending !== undefined && typeof value.resetPending !== "boolean"))
        throw new Error("The environment registry is invalid. Automatic adoption is disabled.");
    }
  }

  definition(id) {
    const d = this.definitions.get(id);
    if (!d || !this.drivers.get(id)) throw new Error("Unknown managed environment.");
    return d;
  }

  snapshot() {
    return [...this.definitions.values()].map(d => {
      const record = this.journal.environments[d.id];
      return {
        id: d.id, name: d.name, kind: d.kind,
        phase: record?.phase ?? "new", prepared: record?.prepared ?? false,
        issue: record?.issue ?? null, resetPending: record?.resetPending === true,
        busy: this.queues.has(d.id), connected: this.leases.has(d.id),
        network: this.guards.get(d.id)?.healthy() ? "ready" : "offline",
        networkStatus: this.guards.get(d.id)?.status?.() ?? null,
      };
    });
  }

  save(id, patch) {
    const previous = this.journal.environments[id] ?? {
      ownershipToken: randomUUID(), phase: "new", prepared: false,
    };
    const next = { ...this.journal, environments: {
      ...this.journal.environments,
      [id]: { ...previous, ...patch, updatedAt: new Date().toISOString() },
    } };
    writeJson(this.file, next);
    this.journal = next;
    this.emit("change", this.snapshot());
  }

  // Errors persisted or sent to UI are fixed codes, never CLI output or launch URLs.
  async serialized(id, action, { signal, duringShutdown = false, recordFailure = true } = {}) {
    this.definition(id);
    if (this.closing && !duringShutdown) throw new Error("Application shutdown is in progress.");
    const previous = this.queues.get(id) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      if (this.closing && !duringShutdown) throw new Error("Application shutdown is in progress.");
      const controller = new AbortController();
      this.controllers.set(id, controller);
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      try {
        combined.throwIfAborted();
        return await action(combined);
      } catch (error) {
        // Disk-write failure must not replace the original error or release a guard.
        if (recordFailure) { try { this.save(id, { phase: "error", issue: combined.aborted ? "cancelled" : "operation-failed" }); } catch {} }
        throw error;
      } finally {
        if (this.controllers.get(id) === controller) this.controllers.delete(id);
      }
    });
    this.queues.set(id, operation);
    try { return await operation; }
    finally {
      if (this.queues.get(id) === operation) this.queues.delete(id);
      this.emit("change", this.snapshot());
    }
  }

  async observe(id, signal) {
    const record = this.journal.environments[id];
    const state = await this.drivers.get(id).inspect({ ownershipToken: record?.ownershipToken, signal });
    if (!state || (!STOPPED.has(state.state) && state.state !== "running"))
      throw new Error("The actual environment state could not be verified.");
    if (state.state !== "missing" && (!record || !state.owned))
      throw new Error("The resource is not owned by this app. Operation refused.");
    return state;
  }

  async closeLease(id) {
    const lease = this.leases.get(id);
    if (!lease) return;
    await lease.close();
    this.leases.delete(id);
  }

  async stopVerified(id, signal) {
    await this.closeLease(id);
    let observed = await this.observe(id, signal);
    if (observed.state === "running") {
      this.save(id, { phase: "stopping", issue: null });
      await this.drivers.get(id).stop({ ownershipToken: this.journal.environments[id].ownershipToken, signal });
      observed = await this.observe(id, signal);
    }
    if (!STOPPED.has(observed.state)) throw new Error("VM shutdown could not be confirmed. Network protection is retained.");
    // No guard/proxy release before confirmed guest stop, including failed starts.
    const guard = this.guards.get(id);
    if (guard) { await guard.close(); this.guards.delete(id); }
    if (this.journal.environments[id]) this.save(id, { phase: "stopped", issue: null });
  }

  async ensureGuard(id, signal) {
    let guard = this.guards.get(id);
    if (guard?.healthy()) return guard;
    if (guard) throw new Error("The network is invalid. Stop and recover the environment.");
    guard = await this.network.open(this.definition(id), { signal });
    this.guards.set(id, guard);
    if (!guard.healthy()) throw new Error("The network service is not ready.");
    return guard;
  }

  assertUsable(id) {
    if (this.journal.environments[id]?.resetPending)
      throw new Error("Recreation is incomplete. Confirm Recreate environment again to finish recovery.");
  }

  async prepareInside(id, signal) {
    this.assertUsable(id);
    const observed = await this.observe(id, signal);
    const record = this.journal.environments[id];
    if (record?.prepared && observed.state !== "missing") return;
    this.save(id, { phase: "preparing", prepared: false, issue: null });
    const guard = await this.ensureGuard(id, signal);
    await this.drivers.get(id).prepare({
      ownershipToken: this.journal.environments[id].ownershipToken,
      network: guard, signal,
    });
    const prepared = await this.observe(id, signal);
    if (prepared.state === "missing") throw new Error("Preparation did not complete.");
    this.save(id, { prepared: true, phase: prepared.state === "running" ? "running" : "ready", issue: null });
  }

  prepare(id, options) {
    return this.serialized(id, async signal => {
      // Recovery never attaches a new guard to a guest launched by an old process.
      const observed = await this.observe(id, signal);
      if (observed.state === "running" && (!observed.protected || !this.guards.get(id)?.healthy())) await this.stopVerified(id, signal);
      await this.prepareInside(id, signal);
      return this.snapshot();
    }, options);
  }

  async restoreNetworkInside(id, signal) {
    this.assertUsable(id);
    const guard = this.guards.get(id);
    const driver = this.drivers.get(id);
    if (!guard) throw new Error("No retained network to recover.");
    const options = { ownershipToken: this.journal.environments[id]?.ownershipToken, network: guard, signal };
    await driver.verifyRetainedLaunch(options);
    signal.throwIfAborted();
    await this.network.restore(id, { validate: async () => {
      signal.throwIfAborted();
      await driver.verifyRetainedLaunch(options);
      signal.throwIfAborted();
    } });
    signal.throwIfAborted();
    if (!guard.healthy()) throw new Error("Network recovery did not complete.");
  }

  restoreNetwork(id, options) {
    return this.serialized(id, signal => this.restoreNetworkInside(id, signal), options);
  }

  start(id, options) {
    return this.serialized(id, signal => this.startInside(id, signal), options);
  }

  async startInside(id, signal) {
      this.assertUsable(id);
      let observed = await this.observe(id, signal);
      // A user reconnect is also an explicit proxy retry. Preserve the owned
      // running launch even when its renderer was detached; repair failure
      // must reject here, never fall through to stopping that VM.
      if (observed.state === "running" && this.guards.has(id) && !this.guards.get(id).healthy()) {
        await this.restoreNetworkInside(id, signal);
        await this.prepareInside(id, signal);
        observed = await this.observe(id, signal);
        if (observed.state !== "running" || !observed.protected || !this.guards.get(id)?.healthy())
          throw new Error("The retained environment is unavailable. Retry without restarting it.");
        this.save(id, { phase: "running", issue: null });
        return this.snapshot();
      }
      if (observed.state === "running" && (!observed.protected || !this.guards.get(id)?.healthy())) await this.stopVerified(id, signal);
      else if (this.guards.has(id) && !this.guards.get(id).healthy()) await this.stopVerified(id, signal);
      await this.prepareInside(id, signal);
      const guard = await this.ensureGuard(id, signal);
      observed = await this.observe(id, signal);
      if (observed.state !== "running") {
        this.save(id, { phase: "starting", issue: null });
        await this.drivers.get(id).start({ ownershipToken: this.journal.environments[id].ownershipToken, network: guard, signal });
        observed = await this.observe(id, signal);
      }
      if (observed.state !== "running" || !observed.protected || !guard.healthy()) throw new Error("Protected startup could not be confirmed.");
      this.save(id, { phase: "running", issue: null });
      return this.snapshot();
  }

  connect(id, options) {
    return this.serialized(id, async signal => {
      this.assertUsable(id);
      const observed = await this.observe(id, signal);
      if (observed.state !== "running" || !observed.protected || !this.guards.get(id)?.healthy()) throw new Error("Start the protected environment first.");
      await this.closeLease(id);
      const lease = await this.drivers.get(id).connect({
        ownershipToken: this.journal.environments[id].ownershipToken, signal,
      });
      if (signal.aborted) { await lease.close(); signal.throwIfAborted(); }
      this.leases.set(id, lease);
      return lease; // Main-process-only. Never persisted or exposed through status IPC.
    }, options);
  }

  disconnect(id, options) { return this.serialized(id, () => this.closeLease(id), options); }
  stop(id, options) { return this.serialized(id, signal => this.stopVerified(id, signal), options); }

  restart(id, options) {
    return this.serialized(id, async signal => {
      this.assertUsable(id);
      if ((await this.observe(id, signal)).state === 'missing')
        throw new Error('Create the environment with Connect before restarting it.');
      await this.stopVerified(id, signal);
      signal.throwIfAborted();
      return this.startInside(id, signal);
    }, options);
  }

  recreate(id, options) {
    return this.serialized(id, async signal => {
      await this.observe(id, signal); // Never persist destructive intent for a foreign resource.
      await this.checkRecreate?.(id);
      signal.throwIfAborted();
      // Keep the original ownership token until verified absence. A crash or
      // cancellation never authorizes automatic deletion or adoption on restart.
      this.save(id, { resetPending: true, issue: null });
      await this.stopVerified(id, signal);
      signal.throwIfAborted();
      await this.beforeRecreate?.(id);
      signal.throwIfAborted();
      await this.drivers.get(id).remove({ ownershipToken: this.journal.environments[id].ownershipToken, signal });
      signal.throwIfAborted();
      if ((await this.observe(id, signal)).state !== 'missing') throw new Error('Environment removal was not confirmed.');
      this.save(id, { ownershipToken: randomUUID(), phase: 'new', prepared: false, resetPending: false, issue: null });
      return this.snapshot(); // Rebuild from the same pinned image on the next explicit Connect.
    }, options);
  }

  withStopped(id, operation, options = {}) {
    return this.serialized(id, async signal => {
      await this.stopVerified(id, signal);
      signal.throwIfAborted();
      return operation(this.drivers.get(id), { ownershipToken: this.journal.environments[id]?.ownershipToken, signal });
    }, options);
  }

  withRunning(id, operation, options = {}) {
    return this.serialized(id, async signal => {
      this.assertUsable(id);
      const observed = await this.observe(id, signal);
      if (observed.state !== "running" || !observed.protected || !this.guards.get(id)?.healthy())
        throw new Error("Start the protected environment first.");
      return operation(this.drivers.get(id), { ownershipToken: this.journal.environments[id].ownershipToken, signal });
    }, { ...options, recordFailure: false });
  }

  async reconcile() {
    const results = await Promise.allSettled([...this.definitions.keys()].map(id =>
      this.serialized(id, async signal => {
        const observed = await this.observe(id, signal);
        if (observed.state === "running" && (!observed.protected || !this.guards.get(id)?.healthy())) await this.stopVerified(id, signal);
        else if (this.journal.environments[id] && STOPPED.has(observed.state))
          this.save(id, { phase: observed.state === "missing" ? "new" : "stopped", prepared: observed.state === "missing" ? false : this.journal.environments[id].prepared, issue: null });
      })));
    if (results.some(r => r.status === "rejected")) throw new Error("Some environments require recovery. Automatic adoption is disabled.");
    return this.snapshot();
  }

  async shutdown() {
    this.closing = true;
    for (const controller of this.controllers.values()) controller.abort();
    const results = await Promise.allSettled([...this.definitions.keys()].map(id =>
      this.serialized(id, signal => this.stopVerified(id, signal), { duringShutdown: true })));
    if (results.some(r => r.status === "rejected"))
      throw new Error("Shutdown incomplete: the app keeps network services running. Retry Quit.");
  }
}

module.exports = { Coordinator };
