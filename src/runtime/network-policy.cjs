const { EventEmitter } = require("node:events");
const { randomUUID } = require("node:crypto");
const path = require("node:path");
const { readJson, writeJson } = require("./atomic-json.cjs");

const METHODS = /^[A-Z]{1,20}$/;
const UUID = /^[a-f0-9-]{36}$/;
const MODES = ["ask", "allow-all", "block-all"];
const clone = value => JSON.parse(JSON.stringify(value));

function authority(host, scheme) {
  if (typeof host !== "string" || host.length > 300 || /[\s/@?#\\]/.test(host)) throw new Error("Invalid authority");
  const parsed = new URL(`${scheme}://${host}`);
  if (!parsed.hostname || parsed.username || parsed.password || parsed.pathname !== "/") throw new Error("Invalid authority");
  return parsed;
}

// Iron v0.56 forwards to request.Host and chooses TLS from the actual incoming
// connection (context.sni), NOT from an absolute request URL's scheme/authority.
// Never expose the URL path/query, request headers/body or client address to UI.
function normalizeRequest(request, context = {}) {
  if (!request || typeof request !== "object" || Array.isArray(request) ||
      typeof request.method !== "string" || !METHODS.test(request.method)) throw new Error("Invalid method");
  const connect = request.method === "CONNECT";
  const scheme = connect ? "https" : context.sni ? "https" : "http";
  const target = authority(request.host, scheme);
  const port = Number(target.port || (scheme === "https" ? 443 : 80));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");
  let pathname = "";
  if (!connect) {
    if (typeof request.url !== "string" || request.url.length > 16384 || /[\r\n\\]/.test(request.url)) throw new Error("Invalid URL");
    // Do not resolve paths with WHATWG URL: it removes dot segments and
    // interprets a leading // as an authority. Iron forwards the original path.
    let raw = request.url;
    if (!raw.startsWith("/")) {
      const absolute = /^(https?):\/\/([^/?#]+)(.*)$/.exec(raw);
      if (!absolute || absolute[1] !== scheme || authority(absolute[2], scheme).origin !== target.origin)
        throw new Error("Ambiguous URL");
      raw = absolute[3] || "/";
      if (raw.startsWith("?")) raw = "/" + raw;
    }
    if (raw.includes("#")) throw new Error("Ambiguous URL");
    // Go's r.URL.Path is percent-decoded once, without path normalization.
    pathname = decodeURIComponent(raw.split("?")[0]);
    if (!pathname.startsWith("/") || /[\x00-\x20\x7f\\]/.test(pathname) ||
        pathname.split("/").some(segment => segment === "." || segment === ".."))
      throw new Error("Invalid path");
  }
  return { scheme: connect ? "connect" : scheme, host: target.hostname, port, method: request.method, pathname };
}
function matches(rule, destination) {
  const transport = destination.scheme === "connect";
  return rule.host === destination.host && rule.port === destination.port &&
    (rule.scheme === destination.scheme || (transport && ["http", "https"].includes(rule.scheme))) &&
    // Restricted allows can open TLS for inspection. Restricted denies must
    // wait for the inner request, whose method and path are actually known.
    (transport ? (rule.action !== "deny" || (!rule.method && !rule.pathname)) :
      ((!rule.method || rule.method === destination.method) && (!rule.pathname || rule.pathname === destination.pathname)));
}
function ruleValid(rule, environments) {
  if (!rule || !UUID.test(rule.id) || !environments.has(rule.environmentId) || !["http", "https", "connect"].includes(rule.scheme)) return false;
  // Legacy rules predate actions: absence migrates to "allow". Any explicit action must be allow or deny.
  if (Object.hasOwn(rule, "action") && rule.action !== "allow" && rule.action !== "deny") return false;
  if (!Number.isInteger(rule.port) || rule.port < 1 || rule.port > 65535 ||
      (rule.method !== null && (!METHODS.test(rule.method) || rule.method === "CONNECT")) ||
      (rule.pathname !== null && (typeof rule.pathname !== "string" || !rule.pathname.startsWith("/") || rule.pathname.length > 2048 || /[?#\r\n]/.test(rule.pathname)))) return false;
  try { return authority(`${rule.host}:${rule.port}`, "http").hostname === rule.host &&
    (rule.expiresAt === null || (Number.isSafeInteger(rule.expiresAt) && rule.expiresAt > 0)) &&
    (rule.scheme !== "connect" || (!rule.method && !rule.pathname)); } catch { return false; }
}

class NetworkPolicy extends EventEmitter {
  constructor({ stateRoot, environmentIds, timeoutMs = 55000, maxPending = 128, historyLimit = 500, now = Date.now }) {
    super();
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 55000 ||
      !Number.isInteger(maxPending) || maxPending < 1 || !Number.isInteger(historyLimit) || historyLimit < maxPending) throw new Error("Invalid policy limits");
    this.file = path.join(stateRoot, "network-policy.json"); this.environments = new Set(environmentIds);
    this.timeoutMs = timeoutMs; this.maxPending = maxPending; this.historyLimit = historyLimit; this.now = now;
    this.pending = new Map(); this.closed = false; this.fault = false;
    const state = readJson(this.file, { version: 1, rules: [], events: [] });
    if (!state || state.version !== 1 || !Array.isArray(state.rules) || state.rules.length > 500 ||
      !state.rules.every(rule => ruleValid(rule, this.environments)) || !Array.isArray(state.events) ||
      (Object.hasOwn(state, "modes") && (!state.modes || typeof state.modes !== "object" || Array.isArray(state.modes) ||
        !Object.entries(state.modes).every(([id, mode]) => this.environments.has(id) && MODES.includes(mode)))) ||
      !state.events.every(event => event && UUID.test(event.id) && this.environments.has(event.environmentId) &&
        ["pending", "allowed-once", "allowed-rule", "denied", "denied-rule", "expired", "cancelled", "interrupted"].includes(event.status) &&
        ["http", "https", "connect"].includes(event.scheme) && typeof event.host === "string" && event.host.length <= 300 &&
        Number.isInteger(event.port) && METHODS.test(event.method) && Number.isSafeInteger(event.createdAt) && Number.isSafeInteger(event.expiresAt)))
      throw new Error("Invalid saved network policy");
    // Reconstruct whitelisted fields. Never resurrect callbacks or pending sends.
    this.rules = state.rules.filter(rule => rule.expiresAt === null || rule.expiresAt > now()).map(rule => ({
      id: rule.id, environmentId: rule.environmentId, scheme: rule.scheme, host: rule.host, port: rule.port,
      method: rule.method, pathname: rule.pathname, expiresAt: rule.expiresAt, action: rule.action ?? "allow",
    }));
    this.modes = Object.fromEntries([...this.environments].map(id => [id,
      state.modes && Object.hasOwn(state.modes, id) ? state.modes[id] : "ask"]));
    this.events = state.events.slice(-historyLimit).map(event => ({
      id: event.id, environmentId: event.environmentId, scheme: event.scheme, host: event.host, port: event.port,
      method: event.method, createdAt: event.createdAt, expiresAt: event.expiresAt,
      status: event.status === "pending" ? "interrupted" : event.status,
    }));
    this.persist(); this.scheduleExpiry();
  }
  scheduleExpiry() {
    clearTimeout(this.expiryTimer);
    if (this.closed || this.fault) return;
    const expires = this.rules.filter(rule => rule.expiresAt !== null).map(rule => rule.expiresAt);
    if (!expires.length) return;
    this.expiryTimer = setTimeout(() => {
      const expired = this.rules.filter(rule => rule.expiresAt !== null && rule.expiresAt <= this.now());
      this.rules = this.rules.filter(rule => !expired.includes(rule));
      try { this.persist(); } catch {}
      for (const id of new Set(expired.map(rule => rule.environmentId))) this.emit("revoke-environment", id);
      this.emit("change"); this.scheduleExpiry();
    }, Math.max(1, Math.min(2147483647, Math.min(...expires) - this.now())));
    this.expiryTimer.unref?.();
  }
  persist() {
    try { writeJson(this.file, { version: 1, rules: this.rules, events: this.events, modes: this.modes }); }
    catch (error) {
      this.fault = true;
      for (const item of [...this.pending.values()]) item.finish(false, "interrupted", false);
      for (const id of this.environments) this.emit("revoke-environment", id);
      this.emit("change"); throw error;
    }
  }
  snapshot() {
    return clone({ fault: this.fault, closed: this.closed, timeoutMs: this.timeoutMs,
      rules: this.rules.filter(rule => rule.expiresAt === null || rule.expiresAt > this.now()), events: this.events, modes: this.modes });
  }
  effectiveDecision(environmentId, destination) {
    if (this.closed || this.fault || !this.environments.has(environmentId)) return { allowed: false, status: "interrupted" };
    if (this.modes[environmentId] === "allow-all") return { allowed: true, status: "allowed-rule" };
    if (this.modes[environmentId] === "block-all") return { allowed: false, status: "denied" };
    const rules = this.rules.filter(rule => rule.environmentId === environmentId &&
      (rule.expiresAt === null || rule.expiresAt > this.now()) && matches(rule, destination));
    if (rules.some(rule => rule.action === "deny")) return { allowed: false, status: "denied-rule" };
    if (rules.length) return { allowed: true, status: "allowed-rule" };
    return null;
  }
  resolvePending(environmentId) {
    // Release each original request once; never replay it or prompt again.
    for (const pending of [...this.pending.values()]) {
      if (pending.event.environmentId !== environmentId) continue;
      if (pending.event.expiresAt <= this.now()) pending.finish(false, "expired");
      else {
        const decision = this.effectiveDecision(environmentId, pending.destination);
        if (decision) pending.finish(decision.allowed, decision.status);
      }
    }
  }
  setMode(environmentId, mode) {
    if (this.closed || this.fault) throw new Error("Network policy offline");
    if (!this.environments.has(environmentId) || !MODES.includes(mode)) throw new Error("Invalid network mode");
    if (this.modes[environmentId] === mode) return false;
    this.modes[environmentId] = mode;
    this.persist();
    this.resolvePending(environmentId);
    this.emit("revoke-environment", environmentId);
    this.emit("change"); return true;
  }
  decide = ({ environmentId, request, context, signal }) => {
    if (this.closed || this.fault || signal?.aborted || !this.environments.has(environmentId)) return Promise.resolve(false);
    let destination;
    try { destination = normalizeRequest(request, context); } catch { return Promise.resolve(false); }
    const decision = this.effectiveDecision(environmentId, destination);
    if (decision) return Promise.resolve(decision.allowed);
    if (this.pending.size >= this.maxPending) return Promise.resolve(false);
    const event = { id: randomUUID(), environmentId, scheme: destination.scheme, host: destination.host, port: destination.port,
      method: destination.method, createdAt: this.now(), expiresAt: this.now() + this.timeoutMs, status: "pending" };
    // Pending entries are never evicted while they still have a live request.
    while (this.events.length >= this.historyLimit) {
      const index = this.events.findIndex(item => item.status !== "pending");
      if (index === -1) return Promise.resolve(false);
      this.events.splice(index, 1);
    }
    this.events.push(event);
    try { this.persist(); } catch { event.status = "interrupted"; return Promise.resolve(false); }
    const promise = new Promise(resolve => {
      let settled = false, timer;
      const abort = () => finish(false, "cancelled");
      const finish = (allowed, status, persist = true) => {
        if (settled) return;
        if (allowed && (this.closed || this.fault || signal?.aborted)) { allowed = false; status = signal?.aborted ? "cancelled" : "interrupted"; }
        settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
        this.pending.delete(event.id); event.status = status;
        if (persist) { try { this.persist(); } catch { allowed = false; event.status = "interrupted"; } }
        resolve(allowed); this.emit("change");
      };
      this.pending.set(event.id, { event, destination, finish });
      timer = setTimeout(() => finish(false, "expired"), this.timeoutMs); timer.unref?.();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
    this.emit("change"); return promise;
  };
  respond(id, decision) {
    if (this.closed || this.fault) throw new Error("Network policy offline");
    const pending = this.pending.get(id);
    if (!pending) return false;
    if (pending.event.expiresAt <= this.now()) { pending.finish(false, "expired"); return false; }
    if (!["deny", "deny-save", "once", "temporary", "save"].includes(decision)) throw new Error("Invalid decision");
    if (decision === "deny" || decision === "once") {
      const effective = this.effectiveDecision(pending.event.environmentId, pending.destination);
      if (decision === "once" && effective?.allowed === false) pending.finish(false, effective.status);
      else pending.finish(decision === "once", decision === "once" ? "allowed-once" : "denied");
      return true;
    }
    const { destination, event } = pending;
    this.addRule({ environmentId: event.environmentId, scheme: destination.scheme, host: destination.host, port: destination.port,
      method: null, pathname: null, expiresAt: decision === "temporary" ? this.now() + 10 * 60000 : null,
      action: decision === "deny-save" ? "deny" : "allow" });
    return true;
  }
  addRule(input) {
    if (this.closed || this.fault) throw new Error("Network policy offline");
    if (this.rules.length >= 500) throw new Error("Network rule limit reached");
    const rule = { id: randomUUID(), environmentId: input.environmentId, scheme: input.scheme, host: input.host, port: input.port,
      method: input.method ?? null, pathname: input.pathname ?? null, expiresAt: input.expiresAt ?? null,
      action: Object.hasOwn(input, "action") ? input.action : "allow" };
    if (!ruleValid(rule, this.environments) || (rule.expiresAt !== null && rule.expiresAt <= this.now())) throw new Error("Invalid network rule");
    this.rules.push(rule); this.persist(); this.scheduleExpiry();
    this.resolvePending(rule.environmentId);
    if (rule.action === "deny") this.emit("revoke-environment", rule.environmentId);
    this.emit("change"); return rule.id;
  }
  revoke(id) {
    const rule = this.rules.find(item => item.id === id); if (!rule) return undefined;
    this.rules = this.rules.filter(item => item.id !== id);
    try { this.persist(); } finally { this.emit("revoke-environment", rule.environmentId); }
    this.scheduleExpiry(); this.emit("change"); return rule.environmentId;
  }
  clearHistory() { this.events = this.events.filter(event => event.status === "pending"); this.persist(); this.emit("change"); }
  close() {
    this.closed = true; clearTimeout(this.expiryTimer);
    for (const pending of [...this.pending.values()]) pending.finish(false, "interrupted");
    this.emit("change");
  }
}
module.exports = { NetworkPolicy, normalizeRequest, matches };
