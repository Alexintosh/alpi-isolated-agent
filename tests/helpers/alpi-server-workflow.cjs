// End-to-end bootstrap through the real CLI and stdio entry points. All identities are disposable.
'use strict';

const assert = require('node:assert/strict');
const { spawn, execFile } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs/promises');
const { once } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const { createInterface } = require('node:readline');
const { promisify } = require('node:util');
const { createRequire } = require('node:module');

const run = promisify(execFile);


// Only the proxy receives the request. Its policy callback denies GET before forwarding.
async function checkProxyDenial(port) {
  const authority = '192.0.2.1:8080';
  const response = await new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, agent: false,
      path: 'http://' + authority + '/v1/chat/completions', headers: { host: authority },
      signal: AbortSignal.timeout(5000) }, resolve);
    req.once('error', reject);
  });
  assert.equal(response.statusCode, 403);
  response.setEncoding('utf8');
  let body = '';
  for await (const chunk of response) {
    body += chunk;
    assert.ok(body.length <= 128);
  }
  assert.equal(body, 'Request denied by Alpi policy.\n');
}

// Use the installed proto and callback dependencies to verify Iron's wire contract.
async function checkCallback(profileDir, ironConfig) {
  const fromProfile = createRequire(path.join(profileDir, 'package.json'));
  const grpc = fromProfile('@grpc/grpc-js');
  const loader = fromProfile('@grpc/proto-loader');
  const proto = loader.loadSync(path.join(profileDir, 'vendor/iron-transform.proto'), { keepCase: true });
  const { TransformService } = grpc.loadPackageDefinition(proto).transform.v1;
  const endpoint = ironConfig.transforms.find(transform => transform.name === 'grpc').config.target;
  const client = new TransformService(endpoint, grpc.credentials.createInsecure());
  const call = promisify(client.transformRequest.bind(client));
  const target = { host: '192.0.2.1:8080', url: 'http://192.0.2.1:8080/v1/chat/completions' };
  try {
    const options = { deadline: Date.now() + 5000 };
    const allowed = await call({ context: {}, request: { ...target, method: 'POST' } }, options);
    assert.equal(allowed.action, 1);
    const rejected = await call({ context: {}, request: { ...target, method: 'GET' } }, options);
    assert.equal(rejected.action, 2);
    assert.equal(rejected.response.status_code, 403);
  } finally {
    client.close();
  }
}

async function issueInvitation(server, serverProcess, state, env) {
  const args = [server, 'pair', 'issue', '--state-dir', state, '--project', 'demo',
    '--role', 'runner', '--expires', '5m'];
  const deadline = Date.now() + 6000;
  while (serverProcess.exitCode === null) {
    try {
      const { stdout } = await run(process.execPath, args, { env, timeout: 2000 });
      return JSON.parse(stdout);
    } catch {
      if (Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  throw new Error('Admin socket did not issue a test invitation within six seconds.');
}

async function start(t, executable, args, env) {
  const child = spawn(process.execPath, [executable, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  await once(child, 'spawn');
  const stopped = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await stopped;
  });
  return child;
}

async function runPairingWorkflow(t, server, client, { installRuntime = false } = {}) {
  const temp = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'alpi-pilot-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const state = path.join(temp, 's');
  const env = {
    ...process.env,
    ALPI_CONFIG_DIR: path.join(temp, 'contexts'),
    ALPI_CONTEXT_KEY_FILE: path.join(temp, 'key'),
  };
  await fs.writeFile(env.ALPI_CONTEXT_KEY_FILE, randomBytes(32), { mode: 0o600 });
  const daemon = await start(t, server, ['serve', '--state-dir', state, '--listen', '127.0.0.1', '--port', '0'], env);
  const invite = await issueInvitation(server, daemon, state, env);
  const invitePath = path.join(temp, 'invite.json');
  await fs.writeFile(invitePath, JSON.stringify(invite), { mode: 0o600 });
  const pair = await run(process.execPath, [client, 'pair', '--name', 'gaming-pc', '--invite-file', invitePath], { env });
  assert.equal((pair.stdout + pair.stderr).includes(invite.invitation), false);

  const mcp = await start(t, client, ['mcp', '--context', 'gaming-pc'], env);
  const lines = createInterface({ input: mcp.stdout, crlfDelay: Infinity });
  const output = lines[Symbol.asyncIterator]();
  const send = frame => mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
  async function call(id, method, params) {
    send({ id, method, params });
    const line = await output.next();
    assert.equal(line.done, false, 'MCP closed before responding');
    const response = JSON.parse(line.value);
    assert.equal(response.id, id);
    assert.equal(response.jsonrpc, '2.0');
    return response;
  }
  const init = await call(1, 'initialize', {
    protocolVersion: '2025-06-18', clientInfo: { name: 'alpi-pilot-test', version: '1' }, capabilities: {},
  });
  assert.ok(init.result.capabilities.tools);
  send({ method: 'notifications/initialized' });
  const listing = await call(2, 'tools/list', {});
  const tool = listing.result.tools.find(item => item.name === 'alpi_capabilities');
  assert.ok(tool, 'capabilities tool advertised');
  const toolArgs = { name: tool.name, arguments: {} };
  const ok = await call(3, 'tools/call', toolArgs);
  assert.ok(!ok.result.isError);
  const caps = ok.result.structuredContent ?? JSON.parse(ok.result.content[0].text);
  assert.equal(caps.serverId, invite.serverId);
  assert.equal(caps.project, 'demo');
  assert.deepEqual(caps.runtimes, []);

  if (installRuntime) {
    const installation = await run(process.execPath, [
      server, 'runtime', 'install', '--state-dir', state, '--engine', 'boxlite',
    ], { env, timeout: 180000 });
    const installed = JSON.parse(installation.stdout);
    assert.match(installed.ironCallback.digest, /^[0-9a-f]{64}$/);
    const packageRoot = path.resolve(path.dirname(await fs.realpath(server)), '..');
    const { createIronLifecycle, IRON_SHA256 } = require(path.join(packageRoot, 'src/network/iron.cjs'));
    let fenceCount = 0;
    const callbackProfileDir = path.join(state, 'runtimes/callbacks', installed.ironCallback.digest);
    const policy = createIronLifecycle({ stateDir: state, environmentId: 'package-smoke',
      ironBinary: installed.paths.ironProxy, ironSha256: IRON_SHA256,
      callbackProfileDir,
      connector: { address: '192.0.2.1', port: 8080 }, model: 'fixture', relay: { fence() { fenceCount++; } } });
    try {
      await policy.start();
      assert.equal(policy.healthy(), true);
      assert.ok(policy.status().pid > 0);
      await checkProxyDenial(policy.ingress().port);
      const configPath = path.join(state, 'iron/package-smoke', policy.status().launchId, 'iron.json');
      await checkCallback(callbackProfileDir, JSON.parse(await fs.readFile(configPath, 'utf8')));
    } finally {
      await policy.stop();
    }
    assert.equal(policy.healthy(), false);
    assert.ok(fenceCount > 0);
    const doctor = await run(process.execPath, [server, 'doctor', '--runtime', '--state-dir', state], { env });
    const diagnosis = JSON.parse(doctor.stdout);
    assert.equal(diagnosis.active.id, installed.set);
    assert.equal(diagnosis.verification, 'files-verified');
    const refreshed = await call(5, 'tools/call', toolArgs);
    assert.ok(!refreshed.result.isError);
    const inventory = refreshed.result.structuredContent.runtimes;
    const active = inventory.find(item => item.active);
    assert.ok(active, 'the same MCP process observes runtime activation');
    assert.equal(active.id, installed.set);
    assert.equal(active.engine, 'boxlite');
    assert.deepEqual(active.components.map(item => item.component).sort(), installed.components.map(item => item.component).sort());
    assert.ok(!JSON.stringify(inventory).includes(state), 'public inventory conceals host paths');
  }

  const listed = await run(process.execPath, [server, 'clients', 'list', '--state-dir', state], { env });
  const entries = JSON.parse(listed.stdout);
  const records = Array.isArray(entries) ? entries : entries.clients;
  assert.equal(records.length, 1);
  await run(process.execPath, [server, 'clients', 'revoke', records[0].clientId, '--state-dir', state], { env });
  const revoked = await call(4, 'tools/call', toolArgs);
  assert.ok(revoked.result?.isError || revoked.error, 'already-running MCP must reauthenticate after revocation');
  mcp.stdin.end();
}

module.exports = { runPairingWorkflow };
