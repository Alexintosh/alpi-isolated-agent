'use strict';

// diagnostics.cjs — builds a small, stable, allowlisted diagnostics document
// for the v1 personal harness ("Harness Isolated").
//
// The caller supplies version metadata (app/electron/node/platform/arch/os
// release/commit) plus the current main-process snapshot() result
// (src/v1-main.cjs). Every field below is validated against a fixed allowlist;
// input values are never spread or echoed. Host paths, URLs, credentials,
// transfer ownership markers and internal ids therefore cannot appear in the
// output document. Sections whose source is missing are omitted, and an
// incomplete or partial snapshot is accepted without throwing.

const ENVIRONMENT_IDS = new Set(["lima-v1", "wrapvm-v1", "wrapvm-arm64-v1"]);
const ENVIRONMENT_KINDS = new Set(["lima", "smolvm"]);
const COORDINATOR_PHASES = new Set(["new", "preparing", "ready", "starting", "running", "stopping", "stopped", "error"]);
const COORDINATOR_ISSUES = new Set(["cancelled", "operation-failed"]);
const NETWORK_STATES = new Set(["ready", "offline"]);
const NETWORK_PHASES = new Set(['starting', 'restarting', 'ready', 'offline', 'stopped']);
const NETWORK_REASONS = new Set(['initial-start', 'policy-changed', 'user-retry', 'proxy-exited', 'recovery-failed', 'environment-stopped']);
const TRANSFER_STATES = new Set(["idle", "preparing", "preview", "running", "complete", "cancelled", "error"]);
const INSTALLER_PHASES = new Set(["idle", "verifying", "copying", "extracting", "ready", "stopping", "active", "cancelled", "error"]);
const PLATFORMS = new Set(["darwin", "linux", "win32"]);
const ARCHES = new Set(["arm64", "x64"]);
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/;
const RELEASE = /^[0-9]+(?:\.[0-9]+)*(?:-[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*)?$/;
const COMMIT = /^[a-f0-9]{40}$/;
const HEX_COMMIT = /^[a-fA-F0-9]{40}$/;
const MAX_METADATA_LENGTH = 64;

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const isBoolean = value => typeof value === "boolean";
const isNonNegative = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
const isSafeIntegerAtLeast = (value, minimum) => Number.isSafeInteger(value) && value >= minimum;
const member = (value, set) => typeof value === "string" && set.has(value) ? value : undefined;
const compact = object => {
  const out = {};
  for (const [key, value] of Object.entries(object)) if (value !== undefined) out[key] = value;
  return out;
};

function versionString(value) {
  if (typeof value !== "string") return "unknown";
  const trimmed = value.trim();
  const normalized = trimmed.startsWith("v") || trimmed.startsWith("V") ? trimmed.slice(1) : trimmed;
  return normalized && normalized.length <= MAX_METADATA_LENGTH && VERSION.test(normalized) ? normalized : "unknown";
}
function releaseString(value) {
  if (typeof value !== "string") return "unknown";
  const trimmed = value.trim();
  return trimmed && trimmed.length <= MAX_METADATA_LENGTH && RELEASE.test(trimmed) ? trimmed : "unknown";
}
function commitString(value) {
  if (typeof value !== "string") return "unknown";
  const trimmed = value.trim();
  if (HEX_COMMIT.test(trimmed)) return trimmed.toLowerCase();
  return COMMIT.test(trimmed) ? trimmed : "unknown";
}
const platformString = value => member(value, PLATFORMS) ?? "unknown";
const archString = value => member(value, ARCHES) ?? "unknown";

function sanitizeEnvironment(item) {
  if (!isObject(item)) return null;
  const id = member(item.id, ENVIRONMENT_IDS);
  if (!id) return null;
  return compact({
    id,
    kind: member(item.kind, ENVIRONMENT_KINDS),
    phase: member(item.phase, COORDINATOR_PHASES),
    issue: item.issue === null ? null : member(item.issue, COORDINATOR_ISSUES),
    connected: isBoolean(item.connected) ? item.connected : undefined,
    busy: isBoolean(item.busy) ? item.busy : undefined,
    network: member(item.network, NETWORK_STATES),
    networkPhase: member(item.networkStatus?.phase, NETWORK_PHASES),
    networkReason: member(item.networkStatus?.reason, NETWORK_REASONS),
  });
}

function sanitizeResource(item) {
  if (!isObject(item)) return null;
  const id = member(item.id, ENVIRONMENT_IDS);
  if (!id) return null;
  return compact({
    id,
    cpus: isSafeIntegerAtLeast(item.cpus, 1) ? item.cpus : undefined,
    memoryMiB: isSafeIntegerAtLeast(item.memoryMiB, 1) ? item.memoryMiB : undefined,
    diskGiB: isNonNegative(item.diskGiB) ? item.diskGiB : undefined,
    overlayGiB: item.overlayGiB === null ? null : isNonNegative(item.overlayGiB) ? item.overlayGiB : undefined,
  });
}

function environmentsSection(snapshot) {
  if (!isObject(snapshot) || !Array.isArray(snapshot.environments)) return undefined;
  return snapshot.environments.map(sanitizeEnvironment).filter(item => item !== null);
}
function resourcesSection(snapshot) {
  if (!isObject(snapshot) || !isObject(snapshot.resources)) return undefined;
  const source = snapshot.resources;
  const environments = Array.isArray(source.environments)
    ? source.environments.map(sanitizeResource).filter(item => item !== null) : undefined;
  const result = compact({ fault: isBoolean(source.fault) ? source.fault : undefined, environments });
  return Object.keys(result).length ? result : undefined;
}
function transfersSection(snapshot) {
  if (!isObject(snapshot) || !isObject(snapshot.transfers)) return undefined;
  const source = snapshot.transfers;
  const interrupted = Array.isArray(source.interrupted) ? source.interrupted : undefined;
  const result = compact({
    state: member(source.state, TRANSFER_STATES),
    fault: isBoolean(source.fault) ? source.fault : undefined,
    interruptedCount: interrupted === undefined ? undefined : interrupted.length,
  });
  return Object.keys(result).length ? result : undefined;
}
function networkPolicySection(snapshot) {
  if (!isObject(snapshot) || !isObject(snapshot.networkPolicy)) return undefined;
  const source = snapshot.networkPolicy;
  const events = Array.isArray(source.events) ? source.events : undefined;
  const rules = Array.isArray(source.rules) ? source.rules : undefined;
  const pending = events === undefined ? undefined
    : events.filter(event => isObject(event) && event.status === "pending").length;
  const result = compact({
    fault: isBoolean(source.fault) ? source.fault : undefined,
    closed: isBoolean(source.closed) ? source.closed : undefined,
    pending,
    rules: rules === undefined ? undefined : rules.length,
    events: events === undefined ? undefined : events.length,
  });
  return Object.keys(result).length ? result : undefined;
}
function modelsSection(snapshot) {
  if (!isObject(snapshot) || !isObject(snapshot.models)) return undefined;
  const providers = Array.isArray(snapshot.models.providers) ? snapshot.models.providers : undefined;
  const result = compact({ providerCount: providers === undefined ? undefined : providers.length });
  return Object.keys(result).length ? result : undefined;
}
function gitSection(snapshot) {
  if (!isObject(snapshot) || !isObject(snapshot.git)) return undefined;
  const repositories = Array.isArray(snapshot.git.repositories) ? snapshot.git.repositories : undefined;
  const result = compact({ repositoryCount: repositories === undefined ? undefined : repositories.length });
  return Object.keys(result).length ? result : undefined;
}
function installationSection(snapshot) {
  if (!isObject(snapshot) || !isObject(snapshot.installation)) return undefined;
  const source = snapshot.installation;
  const result = compact({
    ready: isBoolean(source.ready) ? source.ready : undefined,
    fault: isBoolean(source.fault) ? source.fault : undefined,
    busy: isBoolean(source.busy) ? source.busy : undefined,
    phase: member(source.phase, INSTALLER_PHASES),
  });
  return Object.keys(result).length ? result : undefined;
}
function appSection(snapshot) {
  if (!isObject(snapshot)) return undefined;
  const result = compact({
    busy: isBoolean(snapshot.busy) ? snapshot.busy : undefined,
    quitting: isBoolean(snapshot.quitting) ? snapshot.quitting : undefined,
  });
  return Object.keys(result).length ? result : undefined;
}

function diagnosticSnapshot(input = {}) {
  const source = isObject(input) ? input : {};
  const snapshot = isObject(source.snapshot) ? source.snapshot : {};
  const document = {
    version: 1,
    createdAt: new Date().toISOString(),
    metadata: {
      appVersion: versionString(source.appVersion),
      electronVersion: versionString(source.electronVersion),
      nodeVersion: versionString(source.nodeVersion),
      osRelease: releaseString(source.osRelease),
      platform: platformString(source.platform),
      arch: archString(source.arch),
      commit: commitString(source.commit),
    },
  };
  for (const [name, section] of Object.entries({
    app: appSection(snapshot),
    environments: environmentsSection(snapshot),
    resources: resourcesSection(snapshot),
    transfers: transfersSection(snapshot),
    networkPolicy: networkPolicySection(snapshot),
    models: modelsSection(snapshot),
    git: gitSection(snapshot),
    installation: installationSection(snapshot),
  })) if (section !== undefined) document[name] = section;
  return document;
}

module.exports = { diagnosticSnapshot };
