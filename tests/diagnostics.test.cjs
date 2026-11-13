'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { diagnosticSnapshot } = require('../src/runtime/diagnostics.cjs');

const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UNKNOWN_METADATA = {
  appVersion: 'unknown', electronVersion: 'unknown', nodeVersion: 'unknown',
  osRelease: 'unknown', platform: 'unknown', arch: 'unknown', commit: 'unknown',
};

test('the fixed local ARM64 environment is allowlisted without exposing image or host details', () => {
  const result = diagnosticSnapshot({ snapshot: {
    environments: [{ id: 'wrapvm-arm64-v1', kind: 'smolvm', phase: 'ready', imageId: 'local-arm64', archive: '/private/image.tar' },
      { id: 'wrapvm-other-v1', kind: 'smolvm', phase: 'ready' }],
    resources: { environments: [{ id: 'wrapvm-arm64-v1', cpus: 2, memoryMiB: 4096, diskGiB: 20, overlayGiB: 10 }] },
  } });
  assert.deepEqual(result.environments, [{ id: 'wrapvm-arm64-v1', kind: 'smolvm', phase: 'ready' }]);
  assert.deepEqual(result.resources.environments, [{ id: 'wrapvm-arm64-v1', cpus: 2, memoryMiB: 4096, diskGiB: 20, overlayGiB: 10 }]);
  assert.equal(JSON.stringify(result).includes('/private'), false);
  assert.equal(JSON.stringify(result).includes('local-arm64'), false);
});

// A realistic full snapshot() result with extra junk in every non-allowlisted
// field. Values in allowed fields are valid; everything else is a canary that
// must never survive the sanitizer.
function sampleInput() {
  return {
    appVersion: '0.1.0',
    electronVersion: '45.3.1',
    nodeVersion: '24.13.0',
    osRelease: '24.3.0',
    platform: 'darwin',
    arch: 'arm64',
    commit: 'a'.repeat(40),
    extraTopLevel: 'CANARY-extras',
    snapshot: {
      selectedId: 'CANARY-selected',
      activeId: 'CANARY-active',
      busy: true,
      quitting: false,
      panel: 'CANARY-panel',
      modelBusy: true,
      filesBusy: true,
      label: 'CANARY-label',
      detail: 'CANARY-detail',
      error: 'CANARY-error',
      networkError: 'CANARY-network-error',
      diagnostic: { step: 'CANARY-step', bootstrapStatus: 200, cookieCount: 3, selectionRecovery: true },
      installation: {
        ready: true, fault: false, busy: false, phase: 'active',
        active: 'CANARY-release-id', previous: 'CANARY-previous', release: 'CANARY-release', recoverable: true,
        received: 12345, total: 67890, file: '/private/CANARY/artifact',
      },
      resources: {
        fault: false,
        limits: { cpus: 16, memoryMiB: 65536, hostMemoryMiB: 131072 },
        environments: [
          { id: 'lima-v1', cpus: 2, memoryMiB: 4096, diskGiB: 20, overlayGiB: null, diskResizable: false },
          { id: 'wrapvm-v1', cpus: 4, memoryMiB: 8192, diskGiB: 20, overlayGiB: 10, diskResizable: false },
          { id: 'CANARY-evil-vm', cpus: 99, memoryMiB: 99999, diskGiB: 999, overlayGiB: 999 },
        ],
      },
      transfers: {
        state: 'running', fault: false,
        interrupted: [
          { id: 'CANARY-tx-id-1', environmentId: 'lima-v1', direction: 'export', destination: '/Users/me/CANARY/private', phase: 'receiving', createdAt: 1, transaction: 'CANARY-transaction', ownershipToken: 'CANARY-ownership' },
          { id: 'CANARY-tx-id-2', environmentId: 'wrapvm-v1', direction: 'import', destination: '/private/CANARY', phase: 'committing', createdAt: 2, transaction: 'CANARY-transaction-2', ownershipToken: 'CANARY-ownership-2' },
        ],
      },
      models: {
        selected: { provider: 'CANARY-provider', model: 'CANARY-model' },
        providers: [
          { id: 'CANARY-provider', displayName: 'CANARY-display', api: 'CANARY-api', baseURL: 'https://CANARY.example.com', models: [{ id: 'CANARY-model-id' }], credentialAvailable: true, availability: 'available', checkedAt: '2026-01-01T00:00:00.000Z' },
          { id: 'CANARY-provider-2', displayName: 'CANARY-display-2', api: 'CANARY-api-2', baseURL: 'https://CANARY-2.example.com', models: [{ id: 'CANARY-model-id-2' }], credentialAvailable: false, availability: 'unreachable', checkedAt: '2026-01-02T00:00:00.000Z' },
        ],
      },
      git: {
        repositories: [
          { id: 'CANARY-git-id', repository: 'CANARY/repository', baseURL: 'https://github.com/CANARY/repository.git', credentialAvailable: true },
          { id: 'CANARY-git-id-2', repository: 'CANARY/two', baseURL: 'https://github.com/CANARY/two.git', credentialAvailable: false },
          { id: 'CANARY-git-id-3', repository: 'CANARY/three', baseURL: 'https://github.com/CANARY/three.git', credentialAvailable: true },
        ],
      },
      networkPolicy: {
        fault: false, closed: false, timeoutMs: 60000,
        rules: [
          { id: 'CANARY-rule-id', environmentId: 'lima-v1', scheme: 'https', host: 'CANARY-host', port: 443, method: 'GET', pathname: '/CANARY/path', expiresAt: null },
        ],
        events: [
          { id: 'CANARY-event-id', environmentId: 'lima-v1', scheme: 'https', host: 'CANARY-host', port: 443, method: 'POST', createdAt: 1, expiresAt: 2, status: 'pending' },
          { id: 'CANARY-event-id-2', environmentId: 'wrapvm-v1', scheme: 'http', host: 'CANARY-host-2', port: 80, method: 'GET', createdAt: 3, expiresAt: 4, status: 'allowed-once' },
          { id: 'CANARY-event-id-3', environmentId: 'lima-v1', scheme: 'https', host: 'CANARY-host-3', port: 443, method: 'GET', createdAt: 5, expiresAt: 6, status: 'pending' },
        ],
      },
      environments: [
        { id: 'lima-v1', name: 'Lima · Ubuntu', kind: 'lima', phase: 'running', prepared: true, issue: null, busy: false, connected: true, network: 'ready' },
        { id: 'wrapvm-v1', name: 'WrapVM · Browser e desktop', kind: 'smolvm', phase: 'stopped', prepared: false, issue: 'cancelled', busy: true, connected: false, network: 'offline' },
        { id: 'CANARY-evil-env', name: 'Evil VM', kind: 'lima', phase: 'running', prepared: true, issue: null, busy: false, connected: true, network: 'ready' },
      ],
    },
  };
}

test('full snapshot exports a stable allowlisted document with correct counts', () => {
  const result = diagnosticSnapshot(sampleInput());
  const { createdAt, ...rest } = result;
  assert.match(createdAt, UTC_ISO);
  assert.equal(createdAt.endsWith('Z'), true);
  assert.deepEqual(rest, {
    version: 1,
    metadata: {
      appVersion: '0.1.0', electronVersion: '45.3.1', nodeVersion: '24.13.0',
      osRelease: '24.3.0', platform: 'darwin', arch: 'arm64', commit: 'a'.repeat(40),
    },
    app: { busy: true, quitting: false },
    environments: [
      { id: 'lima-v1', kind: 'lima', phase: 'running', issue: null, connected: true, busy: false, network: 'ready' },
      { id: 'wrapvm-v1', kind: 'smolvm', phase: 'stopped', issue: 'cancelled', connected: false, busy: true, network: 'offline' },
    ],
    resources: {
      fault: false,
      environments: [
        { id: 'lima-v1', cpus: 2, memoryMiB: 4096, diskGiB: 20, overlayGiB: null },
        { id: 'wrapvm-v1', cpus: 4, memoryMiB: 8192, diskGiB: 20, overlayGiB: 10 },
      ],
    },
    transfers: { state: 'running', fault: false, interruptedCount: 2 },
    networkPolicy: { fault: false, closed: false, pending: 2, rules: 1, events: 3 },
    models: { providerCount: 2 },
    git: { repositoryCount: 3 },
    installation: { ready: true, fault: false, busy: false, phase: 'active' },
  });
});

test('canary values in every non-allowlisted field never appear in the JSON document', () => {
  const result = diagnosticSnapshot(sampleInput());
  const serialized = JSON.stringify(result);
  const canaries = [
    // top-level extras / internal app state
    'CANARY-extras', 'CANARY-selected', 'CANARY-active', 'CANARY-panel', 'CANARY-label', 'CANARY-detail',
    'CANARY-error', 'CANARY-network-error', 'CANARY-step',
    // environment junk
    'Lima · Ubuntu', 'WrapVM · Browser e desktop', 'CANARY-evil-env', 'Evil VM',
    // installation junk (release ids, progress counters, host file paths)
    'CANARY-release-id', 'CANARY-previous', 'CANARY-release', 'CANARY-recoverable',
    '12345', '67890', '/private/CANARY/artifact',
    // resource junk (limits, host memory, resizable flag)
    '65536', '131072', 'CANARY-evil-vm', '99999',
    // transfer junk (ids, destinations, transactions, ownership markers)
    'CANARY-tx-id-1', 'CANARY-tx-id-2', '/Users/me/CANARY/private', '/private/CANARY',
    'CANARY-transaction', 'CANARY-transaction-2', 'CANARY-ownership', 'CANARY-ownership-2',
    // model junk (names, endpoints, model ids, availability, credentials)
    'CANARY-provider', 'CANARY-model', 'CANARY-display', 'CANARY-api',
    'https://CANARY.example.com', 'https://CANARY-2.example.com', 'CANARY-model-id', 'CANARY-model-id-2',
    'available', 'unreachable', '2026-01-01T00:00:00.000Z',
    // git junk (ids, repository names, endpoints)
    'CANARY-git-id', 'CANARY-git-id-2', 'CANARY-git-id-3', 'CANARY/repository',
    'https://github.com/CANARY/repository.git', 'CANARY/two', 'CANARY/three',
    // network junk (rule/event ids, hosts, methods, paths, timestamps)
    'CANARY-rule-id', 'CANARY-event-id', 'CANARY-event-id-2', 'CANARY-event-id-3',
    'CANARY-host', 'CANARY-host-2', 'CANARY-host-3', '/CANARY/path',
  ];
  for (const canary of canaries) assert.equal(serialized.includes(canary), false, `leaked ${canary}`);
});

test('malformed enums and metadata are normalized without echoing input', () => {
  const result = diagnosticSnapshot({
    appVersion: 'v1.2.3',
    electronVersion: '45.3.1-beta.2',
    nodeVersion: '1.2.3.4.5',
    osRelease: '6.8.0-44-generic',
    platform: 'mips64',
    arch: 'amd64',
    commit: 'A'.repeat(40),
    snapshot: {
      busy: 'yes',
      quitting: 1,
      environments: [
        { id: 'lima-v1', kind: 'kvm', phase: 'running!', issue: 'custom-issue', connected: 'yes', busy: 1, network: 'maybe' },
        { id: 'evil-vm', kind: 'lima', phase: 'running' },
        { id: 'wrapvm-v1', kind: 'smolvm', phase: 'ready', issue: null, connected: true, busy: false, network: 'ready' },
      ],
      resources: { fault: 'no', environments: [{ id: 'lima-v1', cpus: 'many', memoryMiB: NaN, diskGiB: -1, overlayGiB: -5 }] },
      transfers: { state: 'INVALID', fault: 0, interrupted: 'not-an-array' },
      networkPolicy: { fault: 'x', closed: 'y', rules: 'many', events: 'many' },
      models: { providers: 'not-an-array' },
      git: {},
      installation: { phase: 'broken', ready: 'y' },
    },
  });
  assert.deepEqual(result.metadata, {
    appVersion: '1.2.3', electronVersion: '45.3.1-beta.2', nodeVersion: 'unknown',
    osRelease: '6.8.0-44-generic', platform: 'unknown', arch: 'unknown', commit: 'a'.repeat(40),
  });
  // Unknown environment ids are dropped; malformed enum fields are omitted.
  assert.deepEqual(result.environments, [
    { id: 'lima-v1' },
    { id: 'wrapvm-v1', kind: 'smolvm', phase: 'ready', issue: null, connected: true, busy: false, network: 'ready' },
  ]);
  assert.deepEqual(result.resources, { environments: [{ id: 'lima-v1' }] });
  // Sections left empty after normalization are omitted entirely.
  assert.equal('transfers' in result, false);
  assert.equal('networkPolicy' in result, false);
  assert.equal('models' in result, false);
  assert.equal('git' in result, false);
  assert.equal('installation' in result, false);
  assert.equal('app' in result, false);
  const serialized = JSON.stringify(result);
  for (const leaked of ['running!', 'kvm', 'custom-issue', 'maybe', 'INVALID', 'broken',
    '1.2.3.4.5', 'mips64', 'amd64', 'evil-vm', 'not-an-array', 'many', 'yes'])
    assert.equal(serialized.includes(leaked), false, `leaked ${leaked}`);
  assert.equal(serialized.includes('6.8.0-44-generic'), true);
});

test('incomplete or missing snapshots are accepted without throwing', () => {
  assert.doesNotThrow(() => diagnosticSnapshot({}));
  assert.doesNotThrow(() => diagnosticSnapshot(null));
  assert.doesNotThrow(() => diagnosticSnapshot({ snapshot: null }));
  assert.doesNotThrow(() => diagnosticSnapshot({ snapshot: 42 }));

  const minimal = diagnosticSnapshot({});
  const { createdAt, ...rest } = minimal;
  assert.match(createdAt, UTC_ISO);
  assert.deepEqual(rest, { version: 1, metadata: UNKNOWN_METADATA });

  const partial = diagnosticSnapshot({ appVersion: '0.2.0', snapshot: { environments: [], resources: { environments: [] } } });
  assert.equal(partial.metadata.appVersion, '0.2.0');
  assert.deepEqual(partial.environments, []);
  assert.deepEqual(partial.resources, { environments: [] });
  assert.equal('app' in partial, false);
  assert.equal('installation' in partial, false);
  assert.equal('networkPolicy' in partial, false);
  assert.equal('transfers' in partial, false);

  // A section with only unknown environments keeps an empty array, no throw.
  const onlyJunk = diagnosticSnapshot({ snapshot: { environments: [{ id: 'not-a-vm' }] } });
  assert.deepEqual(onlyJunk.environments, []);
});
