'use strict';

// Disposable HTTPS job-workflow fixtures. Scenario assertions and restart /
// shutdown ordering stay with each suite; no VM or personal context is used.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const { startServer } = require('../../packages/alpi-server/src/daemon.cjs');
const { issuePairing } = require('../../packages/alpi-server/src/admin-client.cjs');
const { createEngineRegistry } = require('../../packages/alpi-server/src/engines/registry.cjs');
const { openHostResources } = require('../../packages/alpi-server/src/host-resources.cjs');
const { requestJson } = require('../../packages/alpi-client/src/transport.cjs');
const CLIENT_BIN = path.resolve(__dirname, '../../packages/alpi-client/bin/alpi.cjs');

function fixtureEngineAdapter({ trackDestroyed = false } = {}) {
  const boxes = new Map();
  const destroyed = [];
  let counter = 0;
  const info = (box) => ({
    allocationId: box.allocationId,
    launchGeneration: box.launchGeneration,
    name: box.name,
    nativeId: box.nativeId,
    state: box.running ? 'running' : 'stopped',
    running: box.running,
  });
  const adapter = {
    ...(trackDestroyed ? { destroyed } : {}),
    boxFor(ref) {
      const box = boxes.get(`${ref.allocationId}:${ref.launchGeneration}`);
      if (!box) throw { code: 'engine_box_missing', message: 'missing box' };
      return box;
    },
    async createBox(spec) {
      const key = `${spec.allocationId}:${spec.launchGeneration}`;
      let box = boxes.get(key);
      const created = !box;
      if (!box) {
        box = {
          allocationId: spec.allocationId,
          launchGeneration: spec.launchGeneration,
          name: `alpi-${spec.allocationId}-g${spec.launchGeneration}`,
          nativeId: `native-${++counter}`,
          running: false,
        };
        boxes.set(key, box);
      }
      return { allocationId: box.allocationId, launchGeneration: box.launchGeneration,
        name: box.name, nativeId: box.nativeId, created };
    },
    async inspect(ref) { return info(adapter.boxFor(ref)); },
    async start(ref) { adapter.boxFor(ref).running = true; return adapter.inspect(ref); },
    async stop(ref) { adapter.boxFor(ref).running = false; return adapter.inspect(ref); },
    async destroy(ref) {
      const box = adapter.boxFor(ref);
      if (trackDestroyed) destroyed.push({ nativeId: box.nativeId, allocationId: ref.allocationId });
      boxes.delete(`${ref.allocationId}:${ref.launchGeneration}`);
      return { destroyed: true, alreadyGone: false, allocationId: ref.allocationId,
        launchGeneration: ref.launchGeneration, name: ref.name, nativeId: box.nativeId };
    },
    async listOwned() { return [...boxes.values()].map(info); },
    async exec() {
      return { exitCode: 0, stdout: 'ok', stderr: '', truncated: false,
        timedOut: false, cancelled: false, executionId: 'exec-1' };
    },
    async probe() {
      return { available: true, version: '0.14.1',
        capabilities: ['create', 'inspect', 'start', 'stop', 'destroy',
          'list-owned', 'exec', 'pty'] };
    },
    async close() {},
  };
  return adapter;
}

function fixtureProfileResolver() {
  return async ({ engine, profile }) => ({
    engine,
    profile,
    qualified: true,
    available: true,
    engineVersion: '0.14.1',
    imageDigest: 'sha256:' + 'a'.repeat(64),
    limits: { vcpus: 2, memoryMiB: 2048, diskMiB: 10240 },
    networkMode: 'disabled',
    capabilities: ['create', 'inspect', 'start', 'stop', 'destroy',
      'list-owned', 'exec', 'pty'],
  });
}

function devTestRegistry(additionalEngines = []) {
  const registry = createEngineRegistry({ allowTestAdapters: true });
  registry.install({ id: 'fixture', testOnly: true, factory: async () => fixtureEngineAdapter() });
  for (const id of additionalEngines) {
    registry.install({ id, factory: async () => fixtureEngineAdapter() });
  }
  return registry;
}

function startFixtureServer({ stateDir, port = 0, engines = devTestRegistry(),
  withEngine = (_record, use) => use(fixtureEngineAdapter()) }) {
  return startServer({
    stateDir, port, handleSignals: false,
    openResources: (options) => openHostResources({
      ...options,
      engines,
      sandboxHost: { resolveProfile: fixtureProfileResolver(), withEngine },
    }),
  });
}

async function tempDirectory(t, label) {
  const parent = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), `${label}-`));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  return parent;
}

async function tempStateDir(t, label) {
  return path.join(await tempDirectory(t, label), 'state');
}

async function tempClientFixture(t, label, { configName = 'config' } = {}) {
  const root = await tempDirectory(t, label);
  // Keep the layout flat: macOS administration socket paths are bounded.
  const stateDir = path.join(root, 'state');
  const configDir = path.join(root, configName);
  const keyFile = path.join(root, 'context.key');
  // The key stays outside the config directory, as the packaged CLI requires.
  await fs.writeFile(keyFile, randomBytes(32), { mode: 0o600 });
  return { root, stateDir, configDir, keyFile, clientEnv: {
    ...process.env,
    ALPI_CONFIG_DIR: configDir,
    ALPI_CONTEXT_KEY_FILE: keyFile,
  } };
}

async function enrollContext(stateDir, server, project, role) {
  const invite = await issuePairing({ stateDir, project, role });
  const endpoint = { origin: server.origin, fingerprint: invite.fingerprint };
  const response = await requestJson({
    ...endpoint, method: 'POST', path: '/v1/pair/exchange',
    body: { invitation: invite.invitation, name: role },
  });
  return {
    ...endpoint, serverId: invite.serverId, project, role,
    credential: response.credential, credentialExpiresAt: response.expiresAt,
  };
}

function runNode(args, env, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = timeoutMs > 0 ? setTimeout(() => child.kill('SIGKILL'), timeoutMs) : null;
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function pairWithCli(fixture, invite, name, {
  invitationFile = `invite-${name}.json`, timeoutMs = 45000,
} = {}) {
  const invitePath = path.join(fixture.root, invitationFile);
  await fs.writeFile(invitePath, JSON.stringify(invite), { mode: 0o600 });
  return runNode([CLIENT_BIN, 'pair', '--name', name, '--invite-file', invitePath],
    fixture.clientEnv, timeoutMs);
}

module.exports = {
  fixtureEngineAdapter, fixtureProfileResolver, devTestRegistry, startFixtureServer,
  tempDirectory, tempStateDir, tempClientFixture, enrollContext, runNode, pairWithCli,
};
