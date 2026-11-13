// Fixed personal-v1 identities. Never fall back to or adopt the legacy PoC VMs.
const ENVIRONMENTS = Object.freeze([
  Object.freeze({
    id: "lima-v1", kind: "lima", name: "Lima · Ubuntu",
    machine: "harness-isolated-lima-v1", partition: "persist:isolated-lima-v1",
    owner: "harness-isolated-v1", controlPort: 43980, proxyPort: 43982, sshPort: 43984, credentialPort: 43986,
    browser: false, desktop: false,
  }),
  Object.freeze({
    id: "wrapvm-v1", kind: "smolvm", name: "WrapVM · Browser and desktop",
    machine: "harness-isolated-wrapvm-v1", partition: "persist:isolated-wrapvm-v1",
    owner: "harness-isolated-v1", controlPort: 43981, proxyPort: 43983, credentialPort: 43987,
    browser: true, desktop: true,
  }),
]);

// Explicit personal-app choices keep the official environment's existing data
// identity. The local image gets its own machine, storage and network scope.
const PERSONAL_ENVIRONMENTS = Object.freeze([
  ENVIRONMENTS[0],
  Object.freeze({ ...ENVIRONMENTS[1], name: 'Official AMD64 Chrome', imageId: 'stock-amd64' }),
  Object.freeze({
    id: 'wrapvm-arm64-v1', kind: 'smolvm', name: 'Local ARM64 Chromium',
    machine: 'harness-isolated-wrapvm-arm64-v1', partition: 'persist:isolated-wrapvm-arm64-v1',
    owner: 'harness-isolated-v1', controlPort: 43988, proxyPort: 43989, credentialPort: 43990,
    browser: true, desktop: true, imageId: 'local-arm64',
  }),
]);

function environment(id) {
  const found = ENVIRONMENTS.find(item => item.id === id) ?? PERSONAL_ENVIRONMENTS.find(item => item.id === id);
  if (!found) throw new Error("Unknown v1 environment.");
  return found;
}

module.exports = { ENVIRONMENTS, PERSONAL_ENVIRONMENTS, environment };
