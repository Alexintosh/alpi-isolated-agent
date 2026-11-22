
async function createSupervisorSpec(t, options = {}) {
  const root = tempDirectory(options.label || 'guest');
  const workspace = path.join(root, 'workspace');
  const sessions = path.join(workspace, 'sessions');
  const agent = path.join(root, 'agent');
  const home = path.join(root, 'home');
  const run = path.join(root, 'run');
  for (const directory of [workspace, sessions, agent, home, run]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
  }
  writeScenario(workspace, options.scenario || {});
  const fakePi = writeFakePi(root);
  const sessionId = options.sessionId || UUID_A;
  const socketPath = path.join(run, 'pi-' + sessionId + '.sock');
  const statePath = path.join(run, 'pi-' + sessionId + '.state.json');
  const logPath = path.join(run, 'supervisor.log');
  const spec = {
    root, workspace, sessions, agent, home, run,
    socketPath, statePath, logPath, fakePi, sessionId,
    children: [],
  };
  t.after(async () => {
    for (const child of spec.children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
        break;
      } catch (error) {
        if (error.code !== 'ENOTEMPTY') {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  });
  spec.attachChild = (child) => {
    spec.children.push(child);
    child.stderr.on('data', (chunk) => {
      spec.lastStderr = String(chunk);
    });
  };
  return spec;
}
'use strict';

/**
 * PI-1 contract tests.
 *
 * The guest supervisor is exercised as a real Node process with a fake stock-Pi
 * executable. The fake executable speaks only the Pi 1.6 JSONL RPC shapes used
 * by the supervisor; no model provider is contacted and no VM is started.
 *
 * The host adapter is exercised through an injected test-only `exec` double
 * that maps operator guest paths to a disposable local test directory. This
 * double declares `guestOnly: true` and exists only in this test file; the
 * production adapter refuses any exec that does not make that declaration.
 */

const assert = require('node:assert/strict');
const { execFile, spawn } = require('node:child_process');
const net = require('node:net');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { test } = require('node:test');

const {
  PiHarnessError,
  PI_CAPABILITIES,
  createPiHarness,
} = require('../src/harnesses/pi.cjs');
const {
  HarnessRegistryError,
  createHarnessRegistry,
} = require('../src/harnesses/registry.cjs');

const execFileAsync = promisify(execFile);
const NODE = process.execPath;
const SUPERVISOR = path.resolve(__dirname, '../profiles/pi-dev/guest-session.cjs');

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

function tempDirectory(label) {
  const directory = fs.mkdtempSync(path.join('/tmp', `pi-${label}-`));
  fs.chmodSync(directory, 0o700);

  return directory;
}

function parseJson(stdout) {
  const lines = String(stdout || '')
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return null;
  }
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

async function runCli(args, timeout = 15_000) {
  try {
    const { stdout, stderr } = await execFileAsync(NODE, [SUPERVISOR, ...args], {
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
    return { code: 0, stdout, stderr, json: parseJson(stdout) };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : null,
      stdout: error.stdout || '',
      stderr: error.stderr || '',
      json: parseJson(error.stdout || ''),
      timedOut: error.killed === true,
    };
  }
}

const FAKE_PI_SOURCE = `'use strict';
const fs = require('node:fs');
const path = require('node:path');

function arg(name) {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 ? process.argv[index + 1] : null;
}
function scenario() {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'fake-pi-scenario.json'), 'utf8'));
  } catch {
    return {};
  }
}
function historyFile() {
  return path.join(arg('session-dir'), arg('session-id') + '.json');
}
function readHistory() {
  try {
    return JSON.parse(fs.readFileSync(historyFile(), 'utf8'));
  } catch {
    return [];
  }
}
function writeHistory(history) {
  fs.writeFileSync(historyFile(), JSON.stringify(history));
}
function appendHistory(entry) {
  const history = readHistory();
  history.push(entry);
  writeHistory(history);
}
function emit(record) {
  process.stdout.write(JSON.stringify(record) + '\\n');
}
function respond(command, success, data, error) {
  const record = { type: 'response', command: command.type, success };
  if (typeof command.id === 'string') record.id = command.id;
  if (data !== undefined) record.data = data;
  if (error !== undefined) record.error = error;
  emit(record);
}
if (process.argv.includes("--mode")) {\n  try {
    fs.appendFileSync(path.join(process.cwd(), "fake-pi-pids.log"), process.pid + "\\n");
  } catch {}\n}
function bumpPromptCount() {
  fs.appendFileSync(path.join(process.cwd(), 'fake-pi-prompts.log'), '1\\n');
}
if (process.argv.includes('--version')) {
  process.stdout.write('1.6.0\\n');
  process.exit(0);
}
const initialScenario = scenario();
if (initialScenario.keepAlive) {
  setInterval(() => {}, 1000);
}
process.on('SIGTERM', () => {
  if (scenario().ignoreSignals) return;
  process.exit(0);
});
process.on('SIGINT', () => {
  if (scenario().ignoreSignals) return;
  process.exit(0);
});
let buffer = '';
let stateCount = 0;
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let newline;
  while ((newline = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    let command;
    try { command = JSON.parse(line); } catch { continue; }
    handle(command);
  }
});
process.stdin.on('end', () => {
  if (!scenario().keepAlive) process.exit(0);
});
function handle(command) {
  const current = scenario();
  if (command.type === 'get_state') {
    stateCount += 1;
    const reply = () => {
      const sessionId = current.wrongSessionIdAfterHandshake && stateCount > 1
        ? '00000000-0000-4000-8000-000000000000'
        : arg('session-id');
      respond(command, true, {
        sessionId,
        sessionFile: historyFile(),
        isStreaming: false,
        isCompacting: false,
        messageCount: readHistory().length,
        pendingMessageCount: 0,
        thinkingLevel: 'off',
        steeringMode: 'all',
        followUpMode: 'all',
        autoCompactionEnabled: false,
        model: { provider: 'alpi', id: 'fixture' },
      });
    };
    if (current.slowState) setTimeout(reply, 120); else reply();
    return;
  }
  if (command.type === 'get_messages') {
    const reply = () => respond(command, true, { messages: readHistory() });
    if (current.slowMessages) setTimeout(reply, 120); else reply();
    return;
  }
  if (command.type === 'prompt') {
    bumpPromptCount();
    appendHistory({ role: 'user', content: command.message });
    if (current.exitOnPrompt) {
      process.exit(1);
      return;
    }
    if (current.handled) {
      respond(command, true, { disposition: 'handled' });
      return;
    }
    appendHistory({ role: 'assistant', content: 'alpi-fixture-result' });
    if (current.losePromptResponse && readHistory().filter(m => m.role === 'user').length === 1) {
      setTimeout(() => emit({ type: 'agent_settled' }), 30);
      return;
    }
    respond(command, true, { disposition: 'started' });
    emit({ type: 'agent_start' });
    if (current.manyEvents) {
      for (let index = 0; index < 30; index += 1) {
        emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x' } });
      }
    }
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'alpi-fixture-result' } });
    emit({ type: 'message_end' });
    emit({ type: 'agent_end' });
    setTimeout(() => emit({ type: 'agent_settled' }), current.settleDelayMs || 10);
    return;
  }
  if (command.type === 'abort') {
    if (current.ignoreAbort) return;
    respond(command, true);
    setTimeout(() => emit({ type: 'agent_settled' }), 10);
    return;
  }
  if (command.type === 'steer') {
    respond(command, true, { disposition: 'steered' });
    return;
  }
  respond(command, false, undefined, 'unsupported fake command');
}
`;

function writeFakePi(root) {
  const file = path.join(root, 'fake-pi.cjs');
  fs.writeFileSync(file, `#!${NODE}\n${FAKE_PI_SOURCE}`, { mode: 0o755 });
  return file;
}

function promptCount(workspace) {
  try {
    return fs.readFileSync(path.join(workspace, 'fake-pi-prompts.log'), 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0).length;
  } catch {
    return 0;
  }
}

function writeScenario(workspace, scenario) {
  fs.writeFileSync(path.join(workspace, "fake-pi-scenario.json"), JSON.stringify(scenario));
}

// Scheduling patch: loaded into the real supervisor process via NODE_OPTIONS
// --require, injecting gates and faults configured per child through
// PI_TEST_GATES.
const WRAPPER_SOURCE = [
  "'use strict';",
  "const childProcess = require('node:child_process');",
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const gates = JSON.parse(process.env.PI_TEST_GATES || '{}');",
  "function sleepSync(ms) {",
  "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);",
  "}",
  "function gateWait(name, file) {",
  "  if (!file) return;",
  "  try { fs.writeFileSync(file + '.reached', String(process.pid)); } catch {}",
  "  while (fs.existsSync(file)) sleepSync(10);",
  "  try { fs.unlinkSync(file + '.reached'); } catch {}",
  "}",
  "const openSync = fs.openSync;",
  "fs.openSync = function (p, flags, mode) {",
  "  const fd = openSync.call(fs, p, flags, mode);",
  "  if (gates.lockGate && p === gates.lockGate.lockPath) gateWait('lockCreate', gates.lockGate.file);",
  "  return fd;",
  "};",
  "let markerRetireFsyncArmed = false;",
  "const linkSync = fs.linkSync;",
  "fs.linkSync = function (from, to) {",
  "  if (gates.restoreLinkGate && to === gates.restoreLinkGate.target &&",
  "      String(from).endsWith('.captured')) gateWait('restoreLink', gates.restoreLinkGate.file);",
  "  if (gates.captureGate && from === gates.captureGate.path) gateWait('capture', gates.captureGate.file);",
  "  if (gates.publishLinkGate && to === gates.publishLinkGate.path) gateWait('publishLink', gates.publishLinkGate.file);",
  "  if (gates.lockGate && to === gates.lockGate.lockPath) gateWait('lockPublish', gates.lockGate.file);",
  "  return linkSync.call(fs, from, to);",
  "};",
  "const renameSync = fs.renameSync;",
  "fs.renameSync = function (from, to) {",
"  if (gates.captureGate && from === gates.captureGate.path) gateWait('capture', gates.captureGate.file);",
  "  if (gates.rename && to === gates.rename.target) gateWait('rename', gates.rename.file);",
  "  if (gates.restoreRenameGate && to === gates.restoreRenameGate.target &&",
  "      String(from).endsWith('.restore')) gateWait('restoreRename', gates.restoreRenameGate.file);",
  "  if (gates.restoreRenameFault && String(from).endsWith('.restore') &&",
  "      fs.existsSync(gates.restoreRenameFault.trigger)) {",
  "    const error = new Error('injected restore rename failure');",
  "    error.code = gates.restoreRenameFault.code || 'EIO';",
  "    throw error;",
  "  }",
  "  if (gates.renameFrom && from === gates.renameFrom.path) gateWait('renameFrom', gates.renameFrom.file);",
  "  return renameSync.call(fs, from, to);",
  "};",
  "const unlinkSync = fs.unlinkSync;",
  "fs.unlinkSync = function (target) {",
  "  if (gates.unlinkGate && target === gates.unlinkGate.target) gateWait('unlink', gates.unlinkGate.file);",
  "  const result = unlinkSync.call(fs, target);",
  "  if ((gates.markerRetireFsyncFault || gates.markerRetireFsyncGate) &&",
  "      target === (gates.markerRetireFsyncFault || gates.markerRetireFsyncGate).markerPath &&",
  "      (!gates.markerRetireFsyncFault ||",
  "        fs.existsSync(gates.markerRetireFsyncFault.trigger)) &&",
  "      (!gates.markerRetireFsyncGate ||",
  "        fs.existsSync(gates.markerRetireFsyncGate.trigger))) {",
  "    markerRetireFsyncArmed = true;",
  "  }",
  "  return result;",
  "};",
  "const fsyncSync = fs.fsyncSync;",
  "fs.fsyncSync = function (fd) {",
  "  let isDir = false;",
  "  try { isDir = fs.fstatSync(fd).isDirectory(); } catch {}",
  "  if (gates.lockReleaseFsync && isDir &&",
  "      !fs.existsSync(gates.lockReleaseFsync.lockPath)) {",
  "    gateWait('lockReleaseFsync', gates.lockReleaseFsync.file);",
  "  }",
  "  if (gates.dirFsyncFault && fs.existsSync(gates.dirFsyncFault.trigger) && isDir) {",
  "    const error = new Error('injected directory fsync failure');",
  "    error.code = gates.dirFsyncFault.code;",
  "    error.errno = gates.dirFsyncFault.errno;",
  "    throw error;",
  "  }",
  "  if (markerRetireFsyncArmed && isDir) {",
  "    markerRetireFsyncArmed = false;",
  "    if (gates.markerRetireFsyncGate) {",
  "      gateWait('markerRetireFsync', gates.markerRetireFsyncGate.file);",
  "    }",
  "    if (gates.markerRetireFsyncFault) {",
  "      const error = new Error('injected marker retirement fsync failure');",
  "      error.code = gates.markerRetireFsyncFault.code || 'EIO';",
  "      error.errno = gates.markerRetireFsyncFault.errno || -5;",
  "      throw error;",
  "    }",
  "  }",
  "  return fsyncSync.call(fs, fd);",
  "};",
  "if (gates.killFault) {",
  "  const originalKill = childProcess.ChildProcess.prototype.kill;",
  "  childProcess.ChildProcess.prototype.kill = function (signal) {",
  "    if (fs.existsSync(gates.killFault.trigger) && this._handle &&",
  "        !this._handle.__injectedKillFault) {",
  "      this._handle.__injectedKillFault = true;",
  "      this._handle.kill = () => gates.killFault.errno;",
  "    }",
  "    return originalKill.call(this, signal);",
  "  };",
  "}",
].join('\n');

function supervisorTestEnv(gates, wrapperPath) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    PI_TEST_GATES: JSON.stringify(gates || {}),
    NODE_OPTIONS: '--require ' + JSON.stringify(wrapperPath),
  };
}

function spawnWrappedSupervisor(supervisor, gates, options = {}) {
  const wrapperPath = path.join(supervisor.root, 'supervisor-patch.cjs');
  fs.writeFileSync(wrapperPath, WRAPPER_SOURCE);
  return spawn(NODE, [SUPERVISOR, ...supervisorLaunchArgs(supervisor, options)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: supervisorTestEnv(gates, wrapperPath),
  });
}

async function pollUntil(fn, timeoutMs = 10_000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function waitForFile(filePath, timeoutMs = 10_000) {
  return pollUntil(() => fs.existsSync(filePath), timeoutMs);
}

async function supervisorExitCode(child, timeoutMs = 15_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return child.exitCode;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return child.exitCode;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function fakePiPids(workspace) {
  try {
    return fs.readFileSync(path.join(workspace, 'fake-pi-pids.log'), 'utf8')
      .split("\\n").filter((line) => line.trim().length > 0).map(Number);
  } catch {
    return [];
  }
}

function stopDirect(socketPath, deadlineMs, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    let buffer = '';
    let settled = false;
    const finish = (json) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(json);
    };
    const timer = setTimeout(() => finish({ ok: false, code: 'test_timeout' }), timeoutMs);
    socket.on('connect', () => {
      socket.write(JSON.stringify({
        version: 1, id: 'stop-direct-1', command: 'stop', deadlineMs,
      }) + String.fromCharCode(10));
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf(String.fromCharCode(10));
      if (newline === -1) return;
      try {
        finish(JSON.parse(buffer.slice(0, newline)));
      } catch {
        finish({ ok: false, code: 'invalid_response' });
      }
    });
    socket.on('error', () => finish({ ok: false, code: 'supervisor_unavailable' }));
  });
}

async function waitForStatus(socketPath, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await runCli(['status', '--socket', socketPath], 2_000);
    if (result.json && result.json.ok === true) {
      return result.json;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

function supervisorLaunchArgs(supervisor, options = {}) {
  return [
    'supervise',
    '--foreground',
    '--socket', supervisor.socketPath,
    '--state', supervisor.statePath,
    '--session-id', supervisor.sessionId,
    '--cwd', supervisor.workspace,
    '--session-dir', supervisor.sessions,
    '--agent-dir', supervisor.agent,
    '--home', supervisor.home,
    '--provider', 'alpi',
    '--model', 'fixture',
    '--pi', supervisor.fakePi,
    '--path-env', process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    '--log', supervisor.logPath,
    '--max-events', String(options.maxEvents || 32),
    '--submit-deadline-ms', String(options.submitDeadlineMs || 500),
    '--command-deadline-ms', String(options.commandDeadlineMs || 2_000),
    '--quiesce-deadline-ms', String(options.quiesceDeadlineMs || 800),
    '--stop-deadline-ms', String(options.stopDeadlineMs || 2_000),
  ];
}

function spawnSupervisorProcess(supervisor, options = {}) {
  return spawn(NODE, [SUPERVISOR, ...supervisorLaunchArgs(supervisor, options)], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code !== 'ESRCH');
  }
}

function waitForExit(child, timeoutMs = 8_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitForPidGone(pid, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function deadPid() {
  const probe = spawn(NODE, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  await waitForExit(probe, 5_000);
  return probe.pid;
}

async function waitForSupervisorGone(socketPath, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await runCli(['status', '--socket', socketPath], 2_000);
    if (result.json && result.json.code === 'supervisor_unavailable') {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function waitSettledCli(supervisor, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs;
  let after = 0;
  while (Date.now() < deadline) {
    const events = await eventsCli(supervisor, after, 400);
    if (events.json && events.json.settled === true) {
      return events.json;
    }
    if (events.json) {
      after = events.json.nextSeq;
    }
  }
  return null;
}

async function startSupervisor(t, options = {}) {
  const root = tempDirectory(options.label || 'guest');
  const workspace = path.join(root, 'workspace');
  const sessions = path.join(workspace, 'sessions');
  const agent = path.join(root, 'agent');
  const home = path.join(root, 'home');
  const run = path.join(root, 'run');
  for (const directory of [workspace, sessions, agent, home, run]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
  }
  writeScenario(workspace, options.scenario || {});
  const fakePi = writeFakePi(root);
  const sessionId = options.sessionId || UUID_A;
  const socketPath = path.join(run, `pi-${sessionId}.sock`);
  const statePath = path.join(run, `pi-${sessionId}.state.json`);
  const logPath = path.join(run, 'supervisor.log');
  const spec = {
    root,
    workspace,
    sessions,
    agent,
    home,
    run,
    socketPath,
    statePath,
    logPath,
    fakePi,
    sessionId,
  };
  const child = spawnSupervisorProcess(spec, options);
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
    if (stderr.length > 8192) stderr = stderr.slice(-8192);
  });
  t.after(async () => {
    for (const entry of fs.readdirSync(run, { withFileTypes: true })) {
      if (entry.isSocket()) await runCli(['stop', '--socket', path.join(run, entry.name)], 6_000);
    }
    if (child.exitCode === null) {
      child.kill('SIGKILL');
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
        break;
      } catch (error) {
        if (error.code !== 'ENOTEMPTY') {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  });
  const status = await waitForStatus(socketPath);
  if (!status) {
    throw new Error(`Supervisor did not start: ${stderr}`);
  }
  return { ...spec, child, status };
}

function submitArgs(supervisor, spec) {
  const args = [
    'submit',
    '--socket', supervisor.socketPath,
    '--request-id', spec.requestId,
    '--generation', String(spec.generation),
    '--chunk', spec.message,
  ];
  if (spec.operator === true) args.push('--operator');
  if (spec.owner !== undefined) args.push('--owner', spec.owner);
  return args;
}

async function submitCli(supervisor, spec) {
  return runCli(submitArgs(supervisor, spec), 15_000);
}

async function eventsCli(supervisor, after, waitMs = 500, limit = 200) {
  return runCli([
    'events',
    '--socket', supervisor.socketPath,
    '--after', String(after),
    '--wait-ms', String(waitMs),
    '--limit', String(limit),
  ], 15_000);
}

function makeGuestExec(supervisor) {
  const mappings = [
    ['/home/node/workspace/sessions', supervisor.sessions],
    ['/home/node/workspace', supervisor.workspace],
    ['/home/node/.pi/agent', supervisor.agent],
    ['/home/node', supervisor.home],
    ['/run/alpi', supervisor.run],
    ['/opt/alpi/pi/guest-session.cjs', SUPERVISOR],
    ['/opt/alpi/pi/node_modules/.bin/pi', supervisor.fakePi],
    ['/usr/local/bin/node', NODE],
  ].sort((left, right) => right[0].length - left[0].length);

  function mapPath(value) {
    for (const [guest, host] of mappings) {
      if (value === guest) return host;
      if (value.startsWith(`${guest}/`)) {
        return path.join(host, value.slice(guest.length + 1));
      }
    }
    return value;
  }

  function unmapText(value) {
    let result = value;
    for (const [guest, host] of mappings) {
      result = result.split(host).join(guest);
    }
    return result;
  }

  const exec = async ({ argv, cwd, timeoutMs }) => {
    const mappedArgv = argv.map(mapPath);
    const mappedCwd = mapPath(cwd);
    return new Promise((resolve) => {
      const child = spawn(mappedArgv[0], mappedArgv.slice(1), {
        cwd: mappedCwd,
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let truncated = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
        if (stdout.length > 4 * 1024 * 1024) {
          truncated = true;
          child.kill('SIGKILL');
        }
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', () => {
        clearTimeout(timer);
        resolve({
          exitCode: -1,
          stdout: unmapText(stdout),
          stderr: unmapText(stderr),
          timedOut,
          truncated,
        });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          exitCode: Number.isInteger(code) ? code : -1,
          stdout: unmapText(stdout),
          stderr: unmapText(stderr),
          timedOut,
          truncated,
        });
      });
    });
  };
  exec.guestOnly = true;
  return exec;
}

function makeAdapter(supervisor, overrides = {}) {
  return createPiHarness({
    exec: makeGuestExec(supervisor),
    supervisorScript: '/opt/alpi/pi/guest-session.cjs',
    nodeExecutable: '/usr/local/bin/node',
    workspaceDir: '/home/node/workspace',
    sessionDir: '/home/node/workspace/sessions',
    agentDir: '/home/node/.pi/agent',
    socketDir: '/run/alpi',
    guestHome: '/home/node',
    piExecutable: '/opt/alpi/pi/node_modules/.bin/pi',
    provider: 'alpi',
    model: 'fixture',
    pathEnv: '/usr/local/bin:/usr/bin:/bin',
    commandTimeoutMs: 2_000,
    submitDeadlineMs: 500,
    quiesceDeadlineMs: 800,
    stopDeadlineMs: 500,
    startupTimeoutMs: 6_000,
    maxEvents: 32,
    ...overrides,
  });
}

test('harness registry keeps harness and model separate and gates test adapters', async () => {
  const registry = createHarnessRegistry({ allowTestHarnesses: true });
  const factoryCalls = [];
  registry.install({
    id: 'pi',
    testOnly: true,
    factory: async (options) => {
      factoryCalls.push(options);
      return {
        id: 'pi',
        async probe() {
          return { available: true, version: '1.6.0', capabilities: PI_CAPABILITIES };
        },
        async createSession() { return {}; },
        async resumeSession() { return {}; },
      };
    },
  });
  assert.deepEqual(registry.list(), [{ id: 'pi', testOnly: true }]);
  const selected = await registry.select({
    harnessId: 'pi',
    capabilities: ['submit', 'conversation-join'],
    model: 'alpi/fixture',
    options: { operator: true },
  });
  assert.equal(selected.harnessId, 'pi');
  assert.equal(selected.model, 'alpi/fixture');
  assert.equal(factoryCalls[0].operator, true);
  assert.equal(factoryCalls[0].model, undefined);
  assert.ok(selected.capabilities.includes('submit'));

  registry.install({ id: 'other', testOnly: true, factory: async () => ({}) });
  assert.equal(registry.has('other'), true);
  await assert.rejects(
    registry.select({ harnessId: 'pi', capabilities: ['not-a-capability'] }),
    (error) => error instanceof HarnessRegistryError && error.code === 'unsupported_capability'
  );
  assert.throws(
    () => registry.install({ id: 'pi', factory: async () => ({}) }),
    (error) => error instanceof HarnessRegistryError && error.code === 'harness_already_installed'
  );
  registry.close();
  assert.throws(
    () => registry.list(),
    (error) => error instanceof HarnessRegistryError && error.code === 'registry_closed'
  );

  const production = createHarnessRegistry();
  assert.throws(
    () => production.install({ id: 'pi', testOnly: true, factory: async () => ({}) }),
    (error) => error instanceof HarnessRegistryError && error.code === 'test_harness_forbidden'
  );
});

test('guest supervisor routes responses by id and settles a prompt', async (t) => {
  const supervisor = await startSupervisor(t, { scenario: { settleDelayMs: 10 } });
  const status = await runCli(['status', '--socket', supervisor.socketPath]);
  assert.equal(status.json.ok, true);
  assert.equal(status.json.sessionId, supervisor.sessionId);
  assert.equal(status.json.cwd, supervisor.workspace);
  assert.equal(status.json.model, 'fixture');

  const state = await runCli(['state', '--socket', supervisor.socketPath]);
  assert.equal(state.json.ok, true);
  assert.equal(state.json.state.sessionId, supervisor.sessionId);
  assert.equal(state.json.state.model.id, 'fixture');

  const submitted = await submitCli(supervisor, {
    requestId: 'turn-1',
    generation: 1,
    message: 'Return the fixture response.',
  });
  assert.equal(submitted.json.ok, true);
  assert.equal(submitted.json.accepted, true);
  assert.equal(submitted.json.disposition, 'started');

  const settled = await eventsCli(supervisor, 0, 2_000);
  assert.equal(settled.json.ok, true);
  assert.equal(settled.json.settled, true);
  assert.ok(settled.json.events.some((entry) => entry.record.type === 'agent_settled'));
  assert.ok(settled.json.nextSeq >= 1);

  const messages = await runCli(['messages', '--socket', supervisor.socketPath]);
  assert.equal(messages.json.ok, true);
  assert.match(JSON.stringify(messages.json.messages), /alpi-fixture-result/);
  assert.equal(promptCount(supervisor.workspace), 1);
});

test('guest supervisor handles a handled disposition without waiting for settle', async (t) => {
  const supervisor = await startSupervisor(t, { scenario: { handled: true } });
  const submitted = await submitCli(supervisor, {
    requestId: 'handled-1',
    generation: 1,
    message: '/status',
  });
  assert.equal(submitted.json.ok, true);
  assert.equal(submitted.json.accepted, true);
  assert.equal(submitted.json.disposition, 'handled');
  assert.equal(submitted.json.settled, true);
  const events = await eventsCli(supervisor, 0, 100);
  assert.equal(events.json.settled, true);
  assert.equal(promptCount(supervisor.workspace), 1);
});

test('guest supervisor correlates concurrent state and messages responses by id', async (t) => {
  const supervisor = await startSupervisor(t, {
    scenario: { slowMessages: true, settleDelayMs: 10 },
  });
  await submitCli(supervisor, {
    requestId: 'routing-1',
    generation: 1,
    message: 'route me',
  });
  await eventsCli(supervisor, 0, 2_000);
  const [state, messages] = await Promise.all([
    runCli(['state', '--socket', supervisor.socketPath]),
    runCli(['messages', '--socket', supervisor.socketPath]),
  ]);
  assert.equal(state.json.ok, true);
  assert.equal(state.json.state.sessionId, supervisor.sessionId);
  assert.equal(messages.json.ok, true);
  assert.ok(Array.isArray(messages.json.messages));
  assert.match(JSON.stringify(messages.json.messages), /alpi-fixture-result/);
});

test('guest supervisor fences old writers across pause and operator handoff', async (t) => {
  const supervisor = await startSupervisor(t, {
    scenario: { settleDelayMs: 5_000 },
  });
  const first = await submitCli(supervisor, {
    requestId: 'coordinator-1',
    generation: 1,
    message: 'coordinator work',
  });
  assert.equal(first.json.accepted, true);

  const paused = await runCli([
    'pause',
    '--socket', supervisor.socketPath,
    '--generation', '1',
    '--owner', 'operator-1',
    '--abort-active',
  ]);
  assert.equal(paused.json.ok, true);
  assert.equal(paused.json.paused, true);
  assert.equal(paused.json.quiescent, true);
  assert.equal(paused.json.generation, 2);

  const staleCoordinator = await submitCli(supervisor, {
    requestId: 'coordinator-2',
    generation: 1,
    message: 'stale coordinator input',
  });
  assert.equal(staleCoordinator.json.ok, false);
  assert.equal(staleCoordinator.json.code, 'stale_writer');

  writeScenario(supervisor.workspace, { settleDelayMs: 5 });
  const operator = await submitCli(supervisor, {
    requestId: 'operator-1',
    generation: 2,
    message: 'operator message',
    operator: true,
    owner: 'operator-1',
  });
  assert.equal(operator.json.ok, true);
  assert.equal(operator.json.accepted, true);

  for (let i = 0; i < 10; i++) {
    if ((await eventsCli(supervisor, 0, 500)).json.settled) break;
  }
  const returned = await runCli([
    'resume',
    '--socket', supervisor.socketPath,
    '--generation', '2',
    '--owner', 'operator-1',
  ]);
  assert.equal(returned.json.ok, true);
  assert.equal(returned.json.generation, 3);
  assert.equal(returned.json.paused, false);

  const staleOperator = await submitCli(supervisor, {
    requestId: 'operator-2',
    generation: 2,
    message: 'stale operator input',
  });
  assert.equal(staleOperator.json.ok, false);
  assert.equal(staleOperator.json.code, 'stale_writer');

  const coordinator = await submitCli(supervisor, {
    requestId: 'coordinator-3',
    generation: 3,
    message: 'coordinator resumes',
  });
  assert.equal(coordinator.json.ok, true);
  assert.equal(coordinator.json.accepted, true);
  assert.equal(promptCount(supervisor.workspace), 3);
});

test('guest supervisor reports a lost prompt acknowledgement as uncertain and never retries', async (t) => {
  const supervisor = await startSupervisor(t, {
    scenario: { losePromptResponse: true },
    submitDeadlineMs: 200,
  });
  const first = await submitCli(supervisor, {
    requestId: 'ambiguous-1',
    generation: 1,
    message: 'ambiguous work',
  });
  assert.equal(first.json.ok, true);
  assert.equal(first.json.accepted, false);
  assert.equal(first.json.uncertain, true);
  assert.equal(first.json.code, 'prompt_uncertain');
  assert.equal(promptCount(supervisor.workspace), 1);

  const duplicate = await submitCli(supervisor, {
    requestId: 'ambiguous-1',
    generation: 1,
    message: 'ambiguous work',
  });
  assert.equal(duplicate.json.ok, true);
  assert.equal(duplicate.json.duplicate, true);
  assert.equal(duplicate.json.uncertain, true);
  assert.equal(promptCount(supervisor.workspace), 1);

  const blocked = await submitCli(supervisor, {
    requestId: 'ambiguous-2',
    generation: 1,
    message: 'must wait for resolution',
  });
  assert.equal(blocked.json.ok, false);
  assert.equal(blocked.json.code, 'prompt_pending');
  assert.equal(promptCount(supervisor.workspace), 1);

  const resolved = await runCli([
    'resolve',
    '--socket', supervisor.socketPath,
    '--request-id', 'ambiguous-1',
    '--resolution', 'settled',
  ]);
  assert.equal(resolved.json.ok, true);
  assert.equal(resolved.json.resolved, true);

  const next = await submitCli(supervisor, {
    requestId: 'ambiguous-3',
    generation: 1,
    message: 'after resolution',
  });
  assert.equal(next.json.ok, true);
  assert.equal(next.json.accepted, true);
  assert.equal(promptCount(supervisor.workspace), 2);
});

test('guest supervisor reports unexpected Pi exit and bounds the event journal', async (t) => {
  const supervisor = await startSupervisor(t, {
    scenario: { exitOnPrompt: true },
    submitDeadlineMs: 300,
  });
  const submitted = await submitCli(supervisor, {
    requestId: 'exit-1',
    generation: 1,
    message: 'exit now',
  });
  assert.equal(submitted.json.ok, true);
  assert.equal(submitted.json.uncertain, true);
  assert.equal(submitted.json.code, 'prompt_uncertain');
  const status = await runCli(['status', '--socket', supervisor.socketPath]);
  assert.equal(status.json.status, 'exited');
  assert.equal(status.json.piExitCode, 1);
});

test('guest supervisor reports an event journal gap after bounded history', async (t) => {
  const supervisor = await startSupervisor(t, {
    scenario: { manyEvents: true, settleDelayMs: 10 },
    maxEvents: 16,
  });
  const submitted = await submitCli(supervisor, {
    requestId: 'many-1',
    generation: 1,
    message: 'many events',
  });
  assert.equal(submitted.json.ok, true);
  const settled = await eventsCli(supervisor, 0, 2_000, 8);
  assert.equal(settled.json.ok, true);
  assert.equal(settled.json.settled, true);
  assert.equal(settled.json.gap, true);
  assert.ok(settled.json.earliestSeq > 1);
  assert.ok(settled.json.events.length <= 8);
});

test('guest supervisor forced cleanup is reported honestly', async (t) => {
  const supervisor = await startSupervisor(t, {
    scenario: { keepAlive: true, ignoreSignals: true },
    stopDeadlineMs: 300,
  });
  const stopped = await runCli([
    'stop',
    '--socket', supervisor.socketPath,
    '--deadline-ms', '300',
  ], 10_000);
  assert.equal(stopped.json.ok, true);
  assert.equal(stopped.json.stopped, true);
  assert.equal(stopped.json.forced, true);
  const status = await runCli(['status', '--socket', supervisor.socketPath]);
  assert.equal(status.json.ok, false);
  assert.equal(status.json.code, 'supervisor_unavailable');
  assert.equal(fs.existsSync(supervisor.socketPath), false);
});

test('host adapter refuses non-guest exec and host paths', () => {
  const base = {
    supervisorScript: '/opt/alpi/pi/guest-session.cjs',
    nodeExecutable: '/usr/local/bin/node',
    workspaceDir: '/home/node/workspace',
    sessionDir: '/home/node/workspace/sessions',
    agentDir: '/home/node/.pi/agent',
    socketDir: '/run/alpi',
    guestHome: '/home/node',
    piExecutable: '/opt/alpi/pi/node_modules/.bin/pi',
    provider: 'alpi',
    model: 'fixture',
  };
  const plainExec = async () => ({ exitCode: 0, stdout: '', stderr: '' });
  assert.throws(
    () => createPiHarness({ ...base, exec: plainExec }),
    (error) => error instanceof PiHarnessError && error.code === 'host_exec_forbidden'
  );
  plainExec.guestOnly = true;
  assert.throws(
    () => createPiHarness({ ...base, exec: plainExec, workspaceDir: '/Users/alex/workspace' }),
    (error) => error instanceof PiHarnessError && error.code === 'host_path_forbidden'
  );
  assert.throws(
    () => createPiHarness({ ...base, exec: plainExec, workspaceDir: 'relative/path' }),
    (error) => error instanceof PiHarnessError && error.code === 'invalid_config'
  );
});

test('host adapter starts the supervisor and keeps the same native session across calls', async (t) => {
  const supervisor = await startSupervisor(t, { sessionId: UUID_B, scenario: { settleDelayMs: 10 } });
  const adapter = makeAdapter(supervisor);
  const probe = await adapter.probe();
  assert.equal(probe.available, true);
  assert.equal(probe.version, '1.6.0');
  assert.ok(probe.capabilities.includes('conversation-join'));

  const session = await adapter.createSession({ sessionId: UUID_B, model: 'fixture' });
  assert.equal(session.nativeSessionId, UUID_B);
  assert.equal(session.workspaceDir, '/home/node/workspace');
  assert.equal(session.generation, 1);
  assert.equal(session.resumed, true);

  const submitted = await adapter.submit({
    nativeSessionId: UUID_B,
    requestId: 'adapter-1',
    generation: 1,
    message: 'adapter prompt',
  });
  assert.equal(submitted.accepted, true);
  assert.equal(submitted.disposition, 'started');
  assert.equal(submitted.uncertain, false);

  const settled = await adapter.waitSettled({
    nativeSessionId: UUID_B,
    after: 0,
    deadlineMs: 5_000,
  });
  assert.equal(settled.settled, true);
  assert.ok(settled.events.some((entry) => entry.record.type === 'agent_settled'));

  const state = await adapter.getState({ nativeSessionId: UUID_B });
  assert.equal(state.sessionId, UUID_B);
  assert.equal(state.isStreaming, false);
  const messages = await adapter.getMessages({ nativeSessionId: UUID_B });
  assert.match(JSON.stringify(messages.messages), /alpi-fixture-result/);
  assert.equal(promptCount(supervisor.workspace), 1);

  const closed = await adapter.close({ nativeSessionId: UUID_B });
  assert.equal(closed.stopped, true);
  assert.equal(closed.cleanupUnverified, false);
  const gone = await adapter.close({ nativeSessionId: UUID_B });
  assert.equal(gone.stopped, false);
  assert.equal(gone.cleanupUnverified, true);
});

test('host adapter can start a fresh supervisor through injected guest exec', async (t) => {
  const supervisor = await startSupervisor(t, { scenario: { settleDelayMs: 10 } });
  // Stop the fixture supervisor first so createSession exercises the
  // `supervise` path through the injected guest exec double.
  await runCli(['stop', '--socket', supervisor.socketPath], 6_000);
  const adapter = makeAdapter(supervisor);
  const session = await adapter.createSession({ sessionId: UUID_B, model: 'fixture' });
  assert.equal(session.nativeSessionId, UUID_B);
  assert.equal(session.resumed, false);
  const submitted = await adapter.submit({
    nativeSessionId: UUID_B,
    requestId: 'fresh-1',
    generation: 1,
    message: 'fresh prompt',
  });
  assert.equal(submitted.accepted, true);
  await adapter.waitSettled({ nativeSessionId: UUID_B, after: 0, deadlineMs: 5_000 });
  const closed = await adapter.close({ nativeSessionId: UUID_B });
  assert.equal(closed.stopped, true);
});

test('host adapter supports durable reconnect by native session id', async (t) => {
  const supervisor = await startSupervisor(t, { scenario: { settleDelayMs: 10 } });
  const first = makeAdapter(supervisor);
  await first.createSession({ sessionId: UUID_B, model: 'fixture' });
  await first.submit({
    nativeSessionId: UUID_B,
    requestId: 'reconnect-1',
    generation: 1,
    message: 'durable work',
  });
  await first.waitSettled({ nativeSessionId: UUID_B, after: 0, deadlineMs: 5_000 });

  const second = makeAdapter(supervisor);
  const resumed = await second.resumeSession({
    nativeSessionId: UUID_B,
    model: 'fixture',
    generation: 1,
  });
  assert.equal(resumed.nativeSessionId, UUID_B);
  assert.equal(resumed.resumed, true);
  const messages = await second.getMessages({ nativeSessionId: UUID_B });
  assert.match(JSON.stringify(messages.messages), /alpi-fixture-result/);
  assert.equal(promptCount(supervisor.workspace), 1);

  const closed = await second.close({ nativeSessionId: UUID_B });
  assert.equal(closed.stopped, true);
  const stale = await first.close({ nativeSessionId: UUID_B });
  assert.equal(stale.stopped, false);
  assert.equal(stale.supervisorGone, true);
  assert.equal(stale.cleanupUnverified, true);
});

test('host adapter pause/operatorSend/resume fences generations', async (t) => {
  const supervisor = await startSupervisor(t, { scenario: { settleDelayMs: 5_000 } });
  const adapter = makeAdapter(supervisor);
  await adapter.createSession({ sessionId: UUID_B, model: 'fixture' });
  await adapter.submit({
    nativeSessionId: UUID_B,
    requestId: 'coord-1',
    generation: 1,
    message: 'coordinator work',
  });

  const paused = await adapter.pause({
    nativeSessionId: UUID_B,
    generation: 1,
    owner: 'operator-1',
    abortActive: true,
  });
  assert.equal(paused.generation, 2);
  assert.equal(paused.quiescent, true);

  await assert.rejects(
    adapter.submit({
      nativeSessionId: UUID_B,
      requestId: 'coord-stale',
      generation: 1,
      message: 'stale',
    }),
    (error) => error instanceof PiHarnessError && error.code === 'stale_writer'
  );

  writeScenario(supervisor.workspace, { settleDelayMs: 5 });
  const operator = await adapter.operatorSend({
    nativeSessionId: UUID_B,
    requestId: 'operator-1',
    generation: 2,
    owner: 'operator-1',
    message: 'operator message',
  });
  assert.equal(operator.accepted, true);

  assert.equal((await adapter.waitSettled({ nativeSessionId: UUID_B, deadlineMs: 3000 })).settled, true);
  const resumed = await adapter.resume({
    nativeSessionId: UUID_B,
    generation: 2,
    owner: 'operator-1',
  });
  assert.equal(resumed.generation, 3);
  assert.equal(resumed.paused, false);

  await assert.rejects(
    adapter.submit({
      nativeSessionId: UUID_B,
      requestId: 'operator-stale',
      generation: 2,
      message: 'stale operator',
    }),
    (error) => error instanceof PiHarnessError && error.code === 'stale_writer'
  );

  const coordinator = await adapter.submit({
    nativeSessionId: UUID_B,
    requestId: 'coord-2',
    generation: 3,
    message: 'coordinator resumes',
  });
  assert.equal(coordinator.accepted, true);
  await adapter.close({ nativeSessionId: UUID_B });
});

test('host adapter reports uncertain submission without retrying', async (t) => {
  const supervisor = await startSupervisor(t, {
    scenario: { losePromptResponse: true },
    submitDeadlineMs: 200,
  });
  const adapter = makeAdapter(supervisor);
  await adapter.createSession({ sessionId: UUID_B, model: 'fixture' });

  const first = await adapter.submit({
    nativeSessionId: UUID_B,
    requestId: 'uncertain-1',
    generation: 1,
    message: 'uncertain work',
  });
  assert.equal(first.accepted, false);
  assert.equal(first.uncertain, true);
  assert.equal(first.code, 'prompt_uncertain');
  assert.equal(promptCount(supervisor.workspace), 1);

  const duplicate = await adapter.submit({
    nativeSessionId: UUID_B,
    requestId: 'uncertain-1',
    generation: 1,
    message: 'uncertain work',
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.uncertain, true);
  assert.equal(promptCount(supervisor.workspace), 1);

  await assert.rejects(
    adapter.submit({
      nativeSessionId: UUID_B,
      requestId: 'uncertain-2',
      generation: 1,
      message: 'blocked',
    }),
    (error) => error instanceof PiHarnessError && error.code === 'prompt_pending'
  );

  const resolved = await adapter.resolveUncertain({
    nativeSessionId: UUID_B,
    requestId: 'uncertain-1',
    resolution: 'settled',
  });
  assert.equal(resolved.resolved, true);

  const next = await adapter.submit({
    nativeSessionId: UUID_B,
    requestId: 'uncertain-3',
    generation: 1,
    message: 'after resolution',
  });
  assert.equal(next.accepted, true);
  assert.equal(promptCount(supervisor.workspace), 2);
  await adapter.close({ nativeSessionId: UUID_B });
});

test('host adapter rejects a supervisor whose Pi session identity differs', async (t) => {
  const supervisor = await startSupervisor(t, {
    scenario: { wrongSessionIdAfterHandshake: true },
  });
  const adapter = makeAdapter(supervisor);
  await assert.rejects(
    adapter.createSession({ sessionId: UUID_B, model: 'fixture' }),
    (error) => error instanceof PiHarnessError && error.code === 'session_identity_mismatch'
  );
});

test('host adapter reports forced cleanup honestly', async (t) => {
  const supervisor = await startSupervisor(t, {
    scenario: { keepAlive: true, ignoreSignals: true },
    stopDeadlineMs: 300,
  });
  const adapter = makeAdapter(supervisor, { stopDeadlineMs: 300 });
  await adapter.createSession({ sessionId: UUID_B, model: 'fixture' });
  const closed = await adapter.close({ nativeSessionId: UUID_B });
  assert.equal(closed.stopped, true);
  assert.equal(closed.forced, true);
});

test('failed critical state write fences prompt dispatch and reports the fault', async (t) => {
  const supervisor = await startSupervisor(t, { scenario: { settleDelayMs: 10 } });
  fs.chmodSync(supervisor.run, 0o500);
  let first;
  try {
    first = await submitCli(supervisor, {
      requestId: 'fault-1',
      generation: 1,
      message: 'must not dispatch',
    });
  } finally {
    fs.chmodSync(supervisor.run, 0o700);
  }
  assert.equal(first.json.ok, false);
  assert.equal(first.json.code, 'state_write_failed');
  assert.equal(promptCount(supervisor.workspace), 0);

  // The supervisor stays fenced even after guest storage becomes writable.
  const fenced = await submitCli(supervisor, {
    requestId: 'fault-2',
    generation: 1,
    message: 'still fenced',
  });
  assert.equal(fenced.json.ok, false);
  assert.equal(fenced.json.code, 'storage_unavailable');
  assert.equal(promptCount(supervisor.workspace), 0);

  const status = await runCli(['status', '--socket', supervisor.socketPath]);
  assert.equal(status.json.ok, true);
  assert.equal(status.json.status, 'uncertain');
  assert.equal(status.json.storageFault.code, 'state_write_failed');
  assert.equal(status.json.storageFault.operation, 'submit-intent');
});

test('failed generation persistence rolls back pause, resume, and resolve', async (t) => {
  // A failed pause fence must not report or persist the new generation.
  {
    const supervisor = await startSupervisor(t, { scenario: { settleDelayMs: 10 } });
    const submitted = await submitCli(supervisor, {
      requestId: 'pause-1',
      generation: 1,
      message: 'work',
    });
    assert.equal(submitted.json.accepted, true);
    assert.ok(await waitSettledCli(supervisor));
    fs.chmodSync(supervisor.run, 0o500);
    let paused;
    try {
      paused = await runCli([
        'pause', '--socket', supervisor.socketPath,
        '--generation', '1', '--owner', 'op-1', '--abort-active',
      ]);
    } finally {
      fs.chmodSync(supervisor.run, 0o700);
    }
    assert.equal(paused.json.ok, false);
    assert.equal(paused.json.code, 'state_write_failed');
    const status = await runCli(['status', '--socket', supervisor.socketPath]);
    assert.equal(status.json.generation, 1);
    assert.equal(status.json.paused, false);
    assert.equal(status.json.pauseOwner, null);
  }
  // A failed resume must keep the paused generation and owner in force.
  {
    const supervisor = await startSupervisor(t, { scenario: { settleDelayMs: 10 } });
    const submitted = await submitCli(supervisor, {
      requestId: 'resume-1',
      generation: 1,
      message: 'work',
    });
    assert.equal(submitted.json.accepted, true);
    assert.ok(await waitSettledCli(supervisor));
    const paused = await runCli([
      'pause', '--socket', supervisor.socketPath,
      '--generation', '1', '--owner', 'op-2', '--abort-active',
    ]);
    assert.equal(paused.json.ok, true);
    fs.chmodSync(supervisor.run, 0o500);
    let resumed;
    try {
      resumed = await runCli([
        'resume', '--socket', supervisor.socketPath,
        '--generation', String(paused.json.generation), '--owner', 'op-2',
      ]);
    } finally {
      fs.chmodSync(supervisor.run, 0o700);
    }
    assert.equal(resumed.json.ok, false);
    assert.equal(resumed.json.code, 'state_write_failed');
    const status = await runCli(['status', '--socket', supervisor.socketPath]);
    assert.equal(status.json.generation, paused.json.generation);
    assert.equal(status.json.paused, true);
    assert.equal(status.json.pauseOwner, 'op-2');
  }
  // A failed resolve must leave the pending prompt ambiguous, not settled.
  {
    const supervisor = await startSupervisor(t, {
      scenario: { losePromptResponse: true },
      submitDeadlineMs: 200,
    });
    const submitted = await submitCli(supervisor, {
      requestId: 'resolve-1',
      generation: 1,
      message: 'ambiguous',
    });
    assert.equal(submitted.json.uncertain, true);
    fs.chmodSync(supervisor.run, 0o500);
    let resolved;
    try {
      resolved = await runCli([
        'resolve', '--socket', supervisor.socketPath,
        '--request-id', 'resolve-1', '--resolution', 'settled',
      ]);
    } finally {
      fs.chmodSync(supervisor.run, 0o700);
    }
    assert.equal(resolved.json.ok, false);
    assert.equal(resolved.json.code, 'state_write_failed');
    const status = await runCli(['status', '--socket', supervisor.socketPath]);
    // A committed resolve reports status 'settled'; the rollback restored the
    // pre-resolve uncertainty (the fake Pi's agent_settled event had already
    // marked the record settled before the resolve was attempted).
    assert.equal(status.json.status, 'uncertain');
    assert.equal(status.json.pendingPrompt.requestId, 'resolve-1');
    assert.equal(status.json.pendingPrompt.uncertain, true);
  }
});

test('supervisor restart refuses to replace a live Pi child and keeps cleanup pending', async (t) => {
  const supervisor = await startSupervisor(t, { scenario: { settleDelayMs: 10, keepAlive: true } });
  const submitted = await submitCli(supervisor, {
    requestId: 'crash-1',
    generation: 1,
    message: 'before crash',
  });
  assert.equal(submitted.json.accepted, true);
  assert.ok(await waitSettledCli(supervisor));
  const statusBefore = await runCli(['status', '--socket', supervisor.socketPath]);
  const piPid = statusBefore.json.piPid;
  assert.ok(Number.isSafeInteger(piPid) && piPid > 0);

  // Crash the writer without stopping Pi: the child outlives its supervisor.
  supervisor.child.kill('SIGKILL');
  await waitForExit(supervisor.child);
  assert.equal(await waitForSupervisorGone(supervisor.socketPath), true);

  const markerPath = supervisor.statePath + '.owner';
  assert.equal(fs.existsSync(markerPath), true);
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  assert.equal(marker.child.state, 'running');
  assert.equal(marker.child.pid, piPid);
  if (process.platform === 'linux') {
    assert.equal(typeof marker.child.startTime, 'string');
  }

  // A replacement must refuse while the previous child may still be alive.
  const refused = await runCli(supervisorLaunchArgs(supervisor), 15_000);
  assert.equal(refused.code, 2);
  assert.equal(refused.json.ok, false);
  assert.equal(refused.json.code, 'cleanup_pending');
  assert.equal(refused.json.details.cleanupPending, true);

  // The guard is retained as cleanup-pending evidence, the orphaned child was
  // never signalled by the replacement, and no replacement child was spawned.
  assert.equal(fs.existsSync(markerPath), true);
  assert.equal(processAlive(piPid), true);
  assert.equal(promptCount(supervisor.workspace), 1);

  // Explicit verified cleanup: the operator terminates the orphan...
  process.kill(piPid, 'SIGTERM');
  assert.equal(await waitForPidGone(piPid), true);
  // ...and only a positively verified absence lets a replacement recover.
  const replacement = spawnSupervisorProcess(supervisor);
  t.after(async () => {
    if (replacement.exitCode === null && replacement.signalCode === null) {
      replacement.kill('SIGTERM');
      await waitForExit(replacement, 4_000);
    }
    if (replacement.exitCode === null && replacement.signalCode === null) {
      replacement.kill('SIGKILL');
    }
  });
  const statusAfter = await waitForStatus(supervisor.socketPath, 10_000);
  assert.ok(statusAfter, 'replacement supervisor did not become ready');
  assert.equal(statusAfter.generation, 2);
  // The recovered supervisor wrote a fresh guard naming its own child.
  const markerAfter = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  assert.equal(markerAfter.child.state, 'running');
  assert.ok(markerAfter.child.pid !== piPid);

  const recovered = await submitCli(supervisor, {
    requestId: 'crash-2',
    generation: 2,
    message: 'after recovery',
  });
  assert.equal(recovered.json.accepted, true);
});

test('failed stop cleanup keeps the ownership guard until absence is verified', async (t) => {
  const supervisor = await startSupervisor(t, { scenario: { settleDelayMs: 10 } });
  const statusBefore = await runCli(['status', '--socket', supervisor.socketPath]);
  const piPid = statusBefore.json.piPid;
  assert.ok(Number.isSafeInteger(piPid) && piPid > 0);
  const markerPath = supervisor.statePath + '.owner';

  // Critical persistence fails during stop: the observed child exit cannot be
  // recorded, so finalization must not clear the durable ownership guard.
  fs.chmodSync(supervisor.run, 0o500);
  let stopped;
  try {
    stopped = await runCli(['stop', '--socket', supervisor.socketPath], 15_000);
  } finally {
    fs.chmodSync(supervisor.run, 0o700);
  }
  assert.equal(stopped.json.ok, true);
  assert.equal(stopped.json.stopped, true);

  // The guard survived finalization and still names the child.
  assert.equal(fs.existsSync(markerPath), true);
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  assert.equal(marker.child.state, 'running');
  assert.equal(marker.child.pid, piPid);

  // The child did exit; the supervisor just could not record it durably.
  assert.equal(await waitForPidGone(piPid), true);

  // Restart recovers only after the probe independently verifies absence.
  const replacement = spawnSupervisorProcess(supervisor);
  t.after(async () => {
    if (replacement.exitCode === null && replacement.signalCode === null) {
      replacement.kill('SIGTERM');
      await waitForExit(replacement, 4_000);
    }
    if (replacement.exitCode === null && replacement.signalCode === null) {
      replacement.kill('SIGKILL');
    }
  });
  const statusAfter = await waitForStatus(supervisor.socketPath, 10_000);
  assert.ok(statusAfter, 'replacement supervisor did not become ready');
  assert.equal(statusAfter.generation, 2);
  // The recovered supervisor wrote a fresh guard naming its own child.
  const markerAfter = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  assert.equal(markerAfter.child.state, 'running');
  assert.ok(markerAfter.child.pid !== piPid);

  const recovered = await submitCli(supervisor, {
    requestId: 'recover-1',
    generation: 2,
    message: 'after recovery',
  });
  assert.equal(recovered.json.accepted, true);
});

test('concurrent starter cannot claim a lock that is being initialized', async (t) => {
  const spec = await createSupervisorSpec(t, { label: 'lockrace' });
  const gateA = path.join(spec.root, 'gate-lock-init');
  const gateB = path.join(spec.root, 'gate-b-startup');

  // Starter A is paused at lock initialization; the gate fires after the lock
  // pathname exists (pre-fix openSync schedule) or right before it is
  // published via link (post-fix schedule).
  fs.writeFileSync(gateA, 'on');
  const a = spawnWrappedSupervisor(spec, {
    lockGate: { file: gateA, lockPath: spec.statePath + '.lock' },
  });
  spec.attachChild(a);
  assert.equal(
    await waitForFile(gateA + '.reached', 10_000),
    true,
    'starter A did not reach the lock-initialization gate'
  );

  // Starter B runs until its first durable startup-state write.
  fs.writeFileSync(gateB, 'on');
  const b = spawnWrappedSupervisor(spec, { rename: { file: gateB, target: spec.statePath } });
  spec.attachChild(b);
  assert.equal(
    await waitForFile(gateB + '.reached', 20_000),
    true,
    'starter B did not reach its startup gate'
  );

  // Resume A while B holds (or has cleanly acquired) the lock.
  fs.unlinkSync(gateA);
  const aExit = await supervisorExitCode(a, 15_000);
  assert.equal(
    aExit,
    2,
    'starter A must fail while another supervisor owns the session; it stayed live'
  );

  fs.unlinkSync(gateB);
  const status = await waitForStatus(spec.socketPath, 15_000);
  assert.ok(status, 'starter B did not become ready');
  assert.equal(processAlive(b.pid), true);

  // Exactly one supervisor and one Pi child exist for the session.
  const lockRecord = readJsonFile(spec.statePath + '.lock');
  assert.ok(lockRecord);
  assert.equal(lockRecord.pid, b.pid);
  const marker = readJsonFile(spec.statePath + '.owner');
  assert.ok(marker);
  assert.equal(marker.child.state, 'running');
  assert.equal(processAlive(marker.child.pid), true);
  // The fake Pi registers its pid when its JS actually starts running.
  assert.equal(await pollUntil(() => fakePiPids(spec.workspace).length === 1, 5_000), true);
});

test('a failed kill keeps the ownership guard instead of faking exit proof', async (t) => {
  const spec = await createSupervisorSpec(t, {
    label: 'killfault',
    scenario: { keepAlive: true },
    stopDeadlineMs: 300,
  });
  const trigger = path.join(spec.root, 'kill-fault-trigger');
  const a = spawnWrappedSupervisor(spec, { killFault: { trigger, errno: -1 } }, {
    stopDeadlineMs: 300,
  });
  spec.attachChild(a);
  const status = await waitForStatus(spec.socketPath, 10_000);
  assert.ok(status, 'supervisor did not become ready: ' + (spec.lastStderr || ''));
  const piPid = status.piPid;
  assert.ok(Number.isSafeInteger(piPid) && piPid > 0);
  t.after(async () => {
    if (processAlive(piPid)) {
      try {
        process.kill(piPid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  });

  // Inject UV_EPERM at the native kill-handle boundary and stop.
  fs.writeFileSync(trigger, 'on');
  // The CLI stop timeout is deadline + 5s, which is shorter than the
  // double grace window when both kills fail, so talk to the socket directly.
  const stopped = await stopDirect(spec.socketPath, 300, 20_000);
  assert.equal(stopped.ok, true);
  assert.equal(stopped.stopped, false);
  assert.equal(stopped.cleanupUnverified, true);
  await waitForExit(a, 10_000);

  // The live child must never be recorded as exited.
  const marker = readJsonFile(spec.statePath + '.owner');
  assert.ok(marker);
  assert.equal(marker.child.state, 'running');
  assert.equal(marker.child.pid, piPid);
  const state = readJsonFile(spec.statePath);
  assert.ok(state);
  assert.equal(state.child.state, 'running');
  assert.equal(processAlive(piPid), true);

  // A replacement must refuse while the original child may still be alive.
  const refused = await runCli(supervisorLaunchArgs(spec), 20_000);
  assert.equal(refused.code, 2);
  assert.equal(refused.json.ok, false);
  assert.equal(refused.json.code, 'cleanup_pending');

  // Only an independently verified absence unlocks recovery.
  process.kill(piPid, 'SIGKILL');
  assert.equal(await waitForPidGone(piPid), true);
  const replacement = spawnSupervisorProcess(spec);
  spec.attachChild(replacement);
  const statusAfter = await waitForStatus(spec.socketPath, 15_000);
  assert.ok(statusAfter, 'replacement supervisor did not become ready');
  assert.equal(statusAfter.generation, 2);
});

test('stop finalization commits state before releasing the lock', async (t) => {
  const spec = await createSupervisorSpec(t, { label: 'finalize', scenario: { settleDelayMs: 10 } });
  const gateFinal = path.join(spec.root, 'gate-final-fsync');
  fs.writeFileSync(gateFinal, 'on');
  const a = spawnWrappedSupervisor(spec, {
    lockReleaseFsync: { file: gateFinal, lockPath: spec.statePath + '.lock' },
  });
  spec.attachChild(a);
  const status = await waitForStatus(spec.socketPath, 10_000);
  assert.ok(status, 'supervisor did not become ready: ' + (spec.lastStderr || ''));
  const submitted = await submitCli(spec, {
    requestId: 'before-stop',
    generation: 1,
    message: 'before stop',
  });
  assert.equal(submitted.json.accepted, true);
  assert.ok(await waitSettledCli(spec));

  const stopped = await runCli(['stop', '--socket', spec.socketPath], 15_000);
  assert.equal(stopped.json.ok, true);
  assert.equal(
    await waitForFile(gateFinal + '.reached', 10_000),
    true,
    'the departing finalizer never paused at its release boundary'
  );

  // While the finalizer is paused (before releasing the lock in the fixed
  // order, after releasing it in the vulnerable order) a replacement starts.
  const b = spawnSupervisorProcess(spec);
  spec.attachChild(b);
  const bStatus = await waitForStatus(spec.socketPath, 20_000);
  assert.ok(bStatus, 'replacement supervisor did not become ready');
  assert.equal(bStatus.generation, 2);
  const accepted = await submitCli(spec, {
    requestId: 'accepted-before-stale-save',
    generation: 2,
    message: 'replacement work',
  });
  assert.equal(accepted.json.accepted, true);
  const midState = readJsonFile(spec.statePath);
  assert.equal(midState.generation, 2);

  // Let the departing supervisor finish; it must have no state write left.
  fs.unlinkSync(gateFinal);
  await waitForExit(a, 10_000);

  const finalState = readJsonFile(spec.statePath);
  assert.equal(finalState.generation, 2);
  assert.ok(finalState.pendingPrompt);
  assert.equal(finalState.pendingPrompt.requestId, 'accepted-before-stale-save');
  assert.equal(finalState.child.pid, bStatus.piPid);
});

test('unsupported directory fsync fences submit dispatch', async (t) => {
  const spec = await createSupervisorSpec(t, { label: 'fsync-submit' });
  const trigger = path.join(spec.root, 'dirfsync-trigger');
  const a = spawnWrappedSupervisor(spec, {
    dirFsyncFault: { code: 'ENOTSUP', errno: -95, trigger },
  });
  spec.attachChild(a);
  const status = await waitForStatus(spec.socketPath, 10_000);
  assert.ok(status, 'supervisor did not become ready: ' + (spec.lastStderr || ''));

  fs.writeFileSync(trigger, 'on');
  const first = await submitCli(spec, {
    requestId: 'fault-1',
    generation: 1,
    message: 'must not dispatch',
  });
  assert.equal(first.json.ok, false);
  assert.equal(first.json.code, 'state_write_failed');
  assert.equal(promptCount(spec.workspace), 0);

  const fault = await runCli(['status', '--socket', spec.socketPath]);
  assert.equal(fault.json.ok, true);
  assert.equal(fault.json.storageFault.operation, 'submit-intent');

  // The durable state shows the last committed content, not the ambiguous intent.
  const onDisk = readJsonFile(spec.statePath);
  assert.equal(onDisk.status, 'ready');
  assert.equal(onDisk.pendingPrompt, null);

  const second = await submitCli(spec, {
    requestId: 'fault-2',
    generation: 1,
    message: 'still fenced',
  });
  assert.equal(second.json.ok, false);
  assert.equal(second.json.code, 'storage_unavailable');

  // The fault stays latched even after storage recovers.
  fs.unlinkSync(trigger);
  const third = await submitCli(spec, {
    requestId: 'fault-3',
    generation: 1,
    message: 'latched',
  });
  assert.equal(third.json.ok, false);
  assert.equal(third.json.code, 'storage_unavailable');
  assert.equal(promptCount(spec.workspace), 0);
});

test('unsupported directory fsync rolls back generation grants', async (t) => {
  const spec = await createSupervisorSpec(t, { label: 'fsync-pause' });
  const trigger = path.join(spec.root, 'dirfsync-trigger');
  const a = spawnWrappedSupervisor(spec, {
    dirFsyncFault: { code: 'EBADF', errno: -9, trigger },
  });
  spec.attachChild(a);
  const status = await waitForStatus(spec.socketPath, 10_000);
  assert.ok(status, 'supervisor did not become ready: ' + (spec.lastStderr || ''));

  fs.writeFileSync(trigger, 'on');
  const paused = await runCli([
    'pause', '--socket', spec.socketPath, '--generation', '1', '--owner', 'op-1',
  ]);
  assert.equal(paused.json.ok, false);
  assert.equal(paused.json.code, 'state_write_failed');

  const after = await runCli(['status', '--socket', spec.socketPath]);
  assert.equal(after.json.generation, 1);
  assert.equal(after.json.paused, false);
  assert.equal(after.json.pauseOwner, null);

  const onDisk = readJsonFile(spec.statePath);
  assert.equal(onDisk.generation, 1);
  assert.equal(onDisk.paused, false);

  fs.unlinkSync(trigger);
  const again = await runCli([
    'pause', '--socket', spec.socketPath, '--generation', '1', '--owner', 'op-1',
  ]);
  assert.equal(again.json.ok, false);
  assert.equal(again.json.code, 'storage_unavailable');
});

test('a real spawn failure records absence without fencing recovery', async (t) => {
  const spec = await createSupervisorSpec(t, { label: 'spawnfail' });
  const args = supervisorLaunchArgs(spec);
  const piFlag = args.indexOf('--pi');
  args[piFlag + 1] = '/nonexistent/pi-fixture';
  const failed = await runCli(args, 20_000);
  assert.equal(failed.code, 2);
  assert.equal(failed.json.ok, false);
  assert.equal(failed.json.code, 'pi_unavailable');

  const marker = readJsonFile(spec.statePath + '.owner');
  assert.ok(marker, 'spawn failure must still record an ownership record');
  assert.equal(marker.child.state, 'none');

  // No child ever existed, so recovery is not fenced.
  const replacement = spawnSupervisorProcess(spec);
  spec.attachChild(replacement);
  const status = await waitForStatus(spec.socketPath, 15_000);
  assert.ok(status, 'replacement should start after a verified spawn failure');
  assert.equal(status.generation, 2);
});

test('host adapter keeps the attachment when stop is unverified', async () => {
  let stopObserved = false;
  const exec = async ({ argv }) => {
    const command = argv[2];
    if (stopObserved) {
      // After the unverified stop the supervisor is unreachable for every
      // further command.
      return { exitCode: 0, stdout: JSON.stringify({ ok: false,
        code: 'supervisor_unavailable',
        message: 'Guest supervisor socket is unavailable.'
      }) + String.fromCharCode(10), stderr: '' };
    }
    let payload;
    if (command === 'supervise') {
      payload = { ok: true, sessionId: UUID_A };
    } else if (command === 'status') {
      payload = {
        ok: true,
        protocolVersion: 1,
        sessionId: UUID_A,
        cwd: '/home/node/workspace',
        socketPath: '/run/alpi/pi-' + UUID_A + '.sock',
        statePath: '/run/alpi/pi-' + UUID_A + '.state.json',
        provider: 'alpi',
        model: 'fixture',
        generation: 1,
        paused: false,
        pauseOwner: null,
        status: 'ready',
      };
    } else if (command === 'state') {
      payload = {
        ok: true,
        state: { sessionId: UUID_A, isStreaming: false, messageCount: 0 },
        generation: 1,
        paused: false,
        status: 'ready',
      };
    } else if (command === 'stop') {
      stopObserved = true;
      payload = {
        ok: false,
        code: 'supervisor_unavailable',
        message: 'Guest supervisor socket is unavailable.',
      };
    } else {
      payload = { ok: false, code: 'unknown_command', message: 'unexpected ' + command };
    }
    return { exitCode: 0, stdout: JSON.stringify(payload) + String.fromCharCode(10), stderr: '' };
  };
  exec.guestOnly = true;
  const adapter = createPiHarness({
    exec,
    supervisorScript: '/opt/alpi/pi/guest-session.cjs',
    nodeExecutable: '/usr/local/bin/node',
    workspaceDir: '/home/node/workspace',
    sessionDir: '/home/node/workspace/sessions',
    agentDir: '/home/node/.pi/agent',
    socketDir: '/run/alpi',
    guestHome: '/home/node',
    piExecutable: '/opt/alpi/pi/node_modules/.bin/pi',
    provider: 'alpi',
    model: 'fixture',
  });
  await adapter.createSession({ sessionId: UUID_A, model: 'fixture' });

  const closed = await adapter.close({ nativeSessionId: UUID_A });
  assert.equal(closed.stopped, false);
  assert.equal(closed.supervisorGone, true);
  assert.equal(closed.cleanupUnverified, true);

  // The cleanup-pending attachment survives so the session record stays
  // addressable; getState fails with the supervisor, not with detachment.
  await assert.rejects(
    adapter.getState({ nativeSessionId: UUID_A }),
    (error) => error instanceof PiHarnessError && error.code === 'supervisor_unavailable'
  );

  // Only an explicit detach decision drops the unverified attachment.
  const detached = await adapter.close({ nativeSessionId: UUID_A, force: true });
  assert.equal(detached.detached, true);
  // Detachment is an ownership decision, not termination proof: even with
  // the supervisor gone, the response must never claim a verified stop.
  assert.equal(detached.harnessId, 'pi');
  assert.equal(detached.nativeSessionId, UUID_A);
  assert.equal(detached.stopped, false);
  assert.equal(detached.forced, false);
  assert.equal(detached.exitCode, null);
  assert.equal(detached.signal, null);
  assert.equal(detached.cleanupUnverified, true);
  assert.equal(detached.alreadyStopped, false);
  assert.equal(detached.guestData, true);
  await assert.rejects(
    adapter.getState({ nativeSessionId: UUID_A }),
    (error) => error instanceof PiHarnessError && error.code === 'session_not_attached'
  );
  adapter.closeSync();
});

test('host adapter force detach on a live supervisor never claims verified termination', async () => {
  let stopObserved = false;
  const exec = async ({ argv }) => {
    const command = argv[2];
    let payload;
    if (command === 'supervise') {
      payload = { ok: true, sessionId: UUID_A };
    } else if (command === 'status') {
      payload = {
        ok: true,
        protocolVersion: 1,
        sessionId: UUID_A,
        cwd: '/home/node/workspace',
        socketPath: '/run/alpi/pi-' + UUID_A + '.sock',
        statePath: '/run/alpi/pi-' + UUID_A + '.state.json',
        provider: 'alpi',
        model: 'fixture',
        generation: 1,
        paused: false,
        pauseOwner: null,
        status: 'ready',
      };
    } else if (command === 'state') {
      payload = {
        ok: true,
        state: { sessionId: UUID_A, isStreaming: false, messageCount: 0 },
        generation: 1,
        paused: false,
        status: 'ready',
      };
    } else if (command === 'stop') {
      // A verified stop is available on this live supervisor, but an explicit
      // detach must not perform (or claim) a termination it did not observe.
      stopObserved = true;
      payload = { ok: true, stopped: true, forced: false, exitCode: 0 };
    } else {
      payload = { ok: false, code: 'unknown_command', message: 'unexpected ' + command };
    }
    return { exitCode: 0, stdout: JSON.stringify(payload) + String.fromCharCode(10), stderr: '' };
  };
  exec.guestOnly = true;
  const adapter = createPiHarness({
    exec,
    supervisorScript: '/opt/alpi/pi/guest-session.cjs',
    nodeExecutable: '/usr/local/bin/node',
    workspaceDir: '/home/node/workspace',
    sessionDir: '/home/node/workspace/sessions',
    agentDir: '/home/node/.pi/agent',
    socketDir: '/run/alpi',
    guestHome: '/home/node',
    piExecutable: '/opt/alpi/pi/node_modules/.bin/pi',
    provider: 'alpi',
    model: 'fixture',
  });
  await adapter.createSession({ sessionId: UUID_A, model: 'fixture' });

  const detached = await adapter.close({ nativeSessionId: UUID_A, force: true });
  assert.equal(detached.harnessId, 'pi');
  assert.equal(detached.nativeSessionId, UUID_A);
  assert.equal(detached.stopped, false);
  assert.equal(detached.forced, false);
  assert.equal(detached.exitCode, null);
  assert.equal(detached.signal, null);
  assert.equal(detached.cleanupUnverified, true);
  assert.equal(detached.alreadyStopped, false);
  assert.equal(detached.detached, true);
  assert.equal(detached.guestData, true);
  assert.equal(stopObserved, false);
  await assert.rejects(
    adapter.getState({ nativeSessionId: UUID_A }),
    (error) => error instanceof PiHarnessError && error.code === 'session_not_attached'
  );
  adapter.closeSync();
});

// --- PI-R2 repair pass 3 regressions (PI-R3-01 / PI-R3-02) ---

function writeDeadRecord(filePath, pid, sessionId) {
  fs.writeFileSync(filePath, JSON.stringify({
    version: 1,
    pid,
    ...(sessionId ? { sessionId } : {}),
    startedAt: new Date().toISOString(),
  }));
}

test('stale recovery-guard capture never displaces a newer guard and fails closed', async (t) => {
  const spec = await createSupervisorSpec(t, { label: 'stale-guard' });
  const lockPath = spec.statePath + '.lock';
  const reclaimPath = lockPath + '.reclaim';
  // A dead main lock and a dead recovery guard: both complete records naming
  // provably absent pids, so every starter must conclude recovery is needed.
  const deadLockRecord = {
    version: 1,
    pid: await deadPid(),
    sessionId: spec.sessionId,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(lockPath, JSON.stringify(deadLockRecord));
  fs.writeFileSync(reclaimPath, JSON.stringify({
    version: 1,
    pid: await deadPid(),
    startedAt: new Date().toISOString(),
  }));

  // Starter A parks while capturing the dead guard, before its identity
  // re-verification. Starter B completes the guard takeover and parks while
  // capturing the dead main lock, so the public guard names the live B.
  const gateA = path.join(spec.root, 'gate-guard-capture');
  fs.writeFileSync(gateA, 'on');
  const gateB = path.join(spec.root, 'gate-lock-capture-b');
  fs.writeFileSync(gateB, 'on');
  const a = spawnWrappedSupervisor(spec, {
    captureGate: { file: gateA, path: reclaimPath },
  });
  spec.attachChild(a);
  let aStdout = '';
  a.stdout.on('data', (chunk) => { aStdout += chunk; });
  assert.equal(
    await waitForFile(gateA + '.reached', 10_000),
    true,
    'starter A did not reach the guard-capture gate'
  );
  const b = spawnWrappedSupervisor(spec, {
    captureGate: { file: gateB, path: lockPath },
  });
  spec.attachChild(b);
  assert.equal(
    await waitForFile(gateB + '.reached', 20_000),
    true,
    'starter B did not reach the main-lock capture gate'
  );
  const bGuard = readJsonFile(reclaimPath);
  assert.ok(bGuard, 'starter B did not publish a replacement guard');
  assert.equal(bGuard.pid, b.pid);

  // Resume A. Its capture now names B's live guard, so the takeover must
  // fail closed, leave the public guard untouched, and never orphan the
  // live record B already verified as its own.
  fs.unlinkSync(gateA);
  const aExit = await supervisorExitCode(a, 15_000);
  assert.equal(aExit, 2, 'starter A must fail closed; it stayed live');
  const aResult = parseJson(aStdout);
  assert.equal(aResult && aResult.code, 'lock_busy',
    'starter A must report a clear lock error, saw: ' + aStdout);
  const guardAfter = readJsonFile(reclaimPath);
  assert.ok(guardAfter, 'the replacement guard was destroyed by the stale capture');
  assert.equal(guardAfter.pid, b.pid);
  const lockAfter = readJsonFile(lockPath);
  assert.ok(lockAfter, 'the dead main lock was disturbed by the stale capture');
  assert.deepEqual(lockAfter, deadLockRecord);
  const orphans = fs.readdirSync(spec.run).filter((name) => name.endsWith('.captured'));
  assert.equal(orphans.length, 0,
    'a captured live guard was left orphaned: ' + orphans.join(', '));

  // B completes recovery: exactly one supervisor and one Pi child exist.
  fs.unlinkSync(gateB);
  const status = await waitForStatus(spec.socketPath, 15_000);
  assert.ok(status, 'starter B did not become ready');
  assert.equal(processAlive(b.pid), true);
  const lockRecord = readJsonFile(lockPath);
  assert.ok(lockRecord);
  assert.equal(lockRecord.pid, b.pid);
  assert.equal(
    await pollUntil(() => fakePiPids(spec.workspace).length === 1, 5_000),
    true,
    'expected exactly one Pi child'
  );
});

test('main-lock recovery refuses to destroy a lock published after its liveness check', async (t) => {
  const spec = await createSupervisorSpec(t, { label: 'stale-lock' });
  const lockPath = spec.statePath + '.lock';
  const reclaimPath = lockPath + '.reclaim';
  writeDeadRecord(lockPath, await deadPid(), spec.sessionId);
  writeDeadRecord(reclaimPath, await deadPid());

  // The starter parks while capturing the dead lock, after publishing its
  // recovery guard.
  const gateA = path.join(spec.root, 'gate-lock-capture');
  fs.writeFileSync(gateA, 'on');
  const a = spawnWrappedSupervisor(spec, {
    captureGate: { file: gateA, path: lockPath },
  });
  spec.attachChild(a);
  let aStdout = '';
  a.stdout.on('data', (chunk) => { aStdout += chunk; });
  assert.equal(
    await waitForFile(gateA + '.reached', 10_000),
    true,
    'starter did not reach the main-lock capture gate'
  );
  const aGuard = readJsonFile(reclaimPath);
  assert.ok(aGuard, 'starter did not publish its recovery guard');
  assert.equal(aGuard.pid, a.pid);

  // A replacement lock is published after the starter's liveness observation.
  const thiefRecord = {
    version: 1,
    pid: process.pid,
    sessionId: spec.sessionId,
    startedAt: new Date().toISOString(),
  };
  fs.unlinkSync(lockPath);
  fs.writeFileSync(lockPath, JSON.stringify(thiefRecord));

  fs.unlinkSync(gateA);
  const aExit = await supervisorExitCode(a, 15_000);
  assert.equal(aExit, 2, 'starter must fail closed instead of stealing the replacement lock');
  const aResult = parseJson(aStdout);
  assert.equal(aResult && aResult.code, 'lock_busy',
    'starter must report a clear lock error, saw: ' + aStdout);
  const thiefAfter = readJsonFile(lockPath);
  assert.ok(thiefAfter, 'the replacement lock was destroyed by stale recovery');
  assert.deepEqual(thiefAfter, thiefRecord);
  const orphans = fs.readdirSync(spec.run).filter((name) => name.endsWith('.captured'));
  assert.equal(orphans.length, 0,
    'a captured live lock was left orphaned: ' + orphans.join(', '));
});

test('a third lock publisher inside the restore window cannot orphan a captured live record', async (t) => {
  const spec = await createSupervisorSpec(t, { label: 'orphan-lock' });
  const lockPath = spec.statePath + '.lock';
  const reclaimPath = lockPath + '.reclaim';
  writeDeadRecord(lockPath, await deadPid(), spec.sessionId);
  writeDeadRecord(reclaimPath, await deadPid());

  // Starter A captures the dead main lock and parks while holding the
  // capture, before its identity re-verification.
  const captureGate = path.join(spec.root, 'gate-orphan-capture');
  const restoreGate = path.join(spec.root, 'gate-orphan-restore');
  // The restore gate must be armed before the capture is released: on the
  // defective base the restore link parks there with the pathname vacant.
  fs.writeFileSync(restoreGate, 'on');
  fs.writeFileSync(captureGate, 'on');
  const a = spawnWrappedSupervisor(spec, {
    captureGate: { file: captureGate, path: lockPath },
    restoreLinkGate: { file: restoreGate, target: lockPath },
  });
  spec.attachChild(a);
  let aStdout = '';
  a.stdout.on('data', (chunk) => { aStdout += chunk; });
  assert.equal(
    await waitForFile(captureGate + '.reached', 10_000),
    true,
    'starter did not reach the main-lock capture gate'
  );

  // A live thief replaces the public record while the starter holds its
  // capture of the dead record.
  const thiefRecord = {
    version: 1,
    pid: process.pid,
    sessionId: spec.sessionId,
    startedAt: new Date().toISOString(),
  };
  fs.unlinkSync(lockPath);
  fs.writeFileSync(lockPath, JSON.stringify(thiefRecord));

  fs.unlinkSync(captureGate);
  // The repaired capture never moves the public record, so the starter
  // detects the thief at its alias and fails closed. On the defective base
  // the rename-based capture moved the thief away and the restore link parks
  // here with the public pathname vacant; a third publisher then wins the
  // vacancy before the restore.
  const restoreReached = await waitForFile(restoreGate + '.reached', 3_000);
  if (restoreReached) {
    fs.writeFileSync(lockPath, JSON.stringify({
      version: 1,
      pid: await deadPid(),
      sessionId: spec.sessionId,
      startedAt: new Date().toISOString(),
    }));
    fs.unlinkSync(restoreGate);
  }
  const aExit = await supervisorExitCode(a, 15_000);
  // The captured live record must never be left orphaned: its owner may have
  // already verified its publication while the public name moved on.
  const orphans = fs.readdirSync(spec.run).filter((name) => name.endsWith('.captured'));
  assert.equal(orphans.length, 0,
    'a captured live lock was left orphaned by the stale restore: ' + orphans.join(', '));
  assert.equal(aExit, 2, 'starter must fail closed instead of stealing the replacement');
  const aResult = parseJson(aStdout);
  assert.equal(aResult && aResult.code, 'lock_busy',
    'starter must report a clear lock error, saw: ' + aStdout);
  const thiefAfter = readJsonFile(lockPath);
  assert.ok(thiefAfter, 'the replacement lock was destroyed by stale recovery');
  assert.deepEqual(thiefAfter, thiefRecord);
});

test('a third guard publisher inside the restore window cannot orphan a captured live record', async (t) => {
  const spec = await createSupervisorSpec(t, { label: 'orphan-guard' });
  const lockPath = spec.statePath + '.lock';
  const reclaimPath = lockPath + '.reclaim';
  writeDeadRecord(lockPath, await deadPid(), spec.sessionId);
  writeDeadRecord(reclaimPath, await deadPid());

  // Starter A parks while capturing the dead guard.
  const captureGate = path.join(spec.root, 'gate-orphan-guard-capture');
  const restoreGate = path.join(spec.root, 'gate-orphan-guard-restore');
  fs.writeFileSync(restoreGate, 'on');
  fs.writeFileSync(captureGate, 'on');
  const a = spawnWrappedSupervisor(spec, {
    captureGate: { file: captureGate, path: reclaimPath },
    restoreLinkGate: { file: restoreGate, target: reclaimPath },
  });
  spec.attachChild(a);
  let aStdout = '';
  a.stdout.on('data', (chunk) => { aStdout += chunk; });
  assert.equal(
    await waitForFile(captureGate + '.reached', 10_000),
    true,
    'starter did not reach the guard capture gate'
  );

  // A live thief guard replaces the public record while the starter holds
  // its capture of the dead guard.
  const thiefRecord = {
    version: 1,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  fs.unlinkSync(reclaimPath);
  fs.writeFileSync(reclaimPath, JSON.stringify(thiefRecord));

  fs.unlinkSync(captureGate);
  const restoreReached = await waitForFile(restoreGate + '.reached', 3_000);
  if (restoreReached) {
    fs.writeFileSync(reclaimPath, JSON.stringify({
      version: 1,
      pid: await deadPid(),
      startedAt: new Date().toISOString(),
    }));
    fs.unlinkSync(restoreGate);
  }
  const aExit = await supervisorExitCode(a, 15_000);
  const orphans = fs.readdirSync(spec.run).filter((name) => name.endsWith('.captured'));
  assert.equal(orphans.length, 0,
    'a captured live guard was left orphaned by the stale restore: ' + orphans.join(', '));
  // The repaired capture detects the thief at the alias, discards it, and
  // fails closed against the live thief guard. (On the defective base the
  // takeover retries against the third record and reaches the supervisor.)
  if (aExit === 2) {
    const aResult = parseJson(aStdout);
    assert.equal(aResult && aResult.code, 'lock_busy',
      'starter must report a clear lock error, saw: ' + aStdout);
    const thiefAfter = readJsonFile(reclaimPath);
    assert.ok(thiefAfter, 'the live thief guard was destroyed by stale recovery');
    assert.deepEqual(thiefAfter, thiefRecord);
  } else {
    const status = await waitForStatus(spec.socketPath, 15_000);
    assert.ok(status, 'the retried takeover did not reach a terminal state');
    const guardAfter = readJsonFile(reclaimPath);
    assert.ok(guardAfter && guardAfter.pid === a.pid,
      'the supervisor guard must belong to the proceeding starter');
    a.kill('SIGKILL');
    await waitForExit(a, 8_000);
  }
  const orphansAfter = fs.readdirSync(spec.run).filter((name) => name.endsWith('.captured'));
  assert.equal(orphansAfter.length, 0,
    'a captured live guard was left orphaned: ' + orphansAfter.join(', '));
});

test('a starter publishing a third main lock inside the capture window loses exclusively', async (t) => {
  const spec = await createSupervisorSpec(t, { label: 'window-lock' });
  const lockPath = spec.statePath + '.lock';
  const reclaimPath = lockPath + '.reclaim';
  writeDeadRecord(lockPath, await deadPid(), spec.sessionId);
  writeDeadRecord(reclaimPath, await deadPid());

  // Starter A parks after removing the dead record's public name and before
  // publishing its own lock, so the public pathname is genuinely vacant.
  const publishGate = path.join(spec.root, 'gate-window-publish');
  fs.writeFileSync(publishGate, 'on');
  const a = spawnWrappedSupervisor(spec, {
    publishLinkGate: { file: publishGate, path: lockPath },
  });
  spec.attachChild(a);
  assert.equal(
    await waitForFile(publishGate + '.reached', 15_000),
    true,
    'starter A did not reach the lock publication gate'
  );

  // A third starter wins the vacancy with the atomic fast path and proceeds.
  const c = spawnSupervisorProcess(spec);
  spec.attachChild(c);
  const cStatus = await waitForStatus(spec.socketPath, 15_000);
  assert.ok(cStatus, 'the third starter did not become ready inside the window');

  fs.unlinkSync(publishGate);
  const aExit = await supervisorExitCode(a, 15_000);
  assert.equal(aExit, 2, 'starter A must fail closed after losing the vacancy');
  const cLock = readJsonFile(lockPath);
  assert.ok(cLock, 'the winning publication disappeared');
  assert.equal(cLock.pid, c.pid);
  assert.equal(processAlive(c.pid), true);
  assert.equal(
    await pollUntil(() => fakePiPids(spec.workspace).length === 1, 5_000),
    true,
    'expected exactly one Pi child'
  );
  const orphans = fs.readdirSync(spec.run).filter((name) => name.endsWith('.captured'));
  assert.equal(orphans.length, 0,
    'a captured record was left orphaned: ' + orphans.join(', '));
  assert.equal(fs.existsSync(reclaimPath), false,
    'no recovery guard may outlive the failed stale takeover');
});

test('a third starter cannot take the guard while another starter holds its capture', async (t) => {
  const spec = await createSupervisorSpec(t, { label: 'window-guard' });
  const lockPath = spec.statePath + '.lock';
  const reclaimPath = lockPath + '.reclaim';
  writeDeadRecord(lockPath, await deadPid(), spec.sessionId);
  writeDeadRecord(reclaimPath, await deadPid());

  // Starter A parks while capturing the dead guard. A third starter then
  // runs the whole recovery: it cannot publish into the held capture, but it
  // becomes the exclusive recovery actor and proceeds.
  const captureGate = path.join(spec.root, 'gate-window-guard-capture');
  fs.writeFileSync(captureGate, 'on');
  const a = spawnWrappedSupervisor(spec, {
    captureGate: { file: captureGate, path: reclaimPath },
  });
  spec.attachChild(a);
  let aStdout = '';
  a.stdout.on('data', (chunk) => { aStdout += chunk; });
  assert.equal(
    await waitForFile(captureGate + '.reached', 10_000),
    true,
    'starter A did not reach the guard capture gate'
  );
  const c = spawnSupervisorProcess(spec);
  spec.attachChild(c);
  const cStatus = await waitForStatus(spec.socketPath, 15_000);
  assert.ok(cStatus, 'the third starter did not complete recovery');

  fs.unlinkSync(captureGate);
  const aExit = await supervisorExitCode(a, 15_000);
  assert.equal(aExit, 2, 'starter A must fail closed against the proceeding recovery');
  const aResult = parseJson(aStdout);
  assert.ok(aResult && (aResult.code === 'lock_busy' || aResult.code === 'already_running'),
    'starter A must report a clear lock error, saw: ' + aStdout);
  const cLock = readJsonFile(lockPath);
  assert.ok(cLock, 'the proceeding starter lock disappeared');
  assert.equal(cLock.pid, c.pid);
  assert.equal(processAlive(c.pid), true);
  assert.equal(
    await pollUntil(() => fakePiPids(spec.workspace).length === 1, 5_000),
    true,
    'expected exactly one Pi child'
  );
  const orphans = fs.readdirSync(spec.run).filter((name) => name.endsWith('.captured'));
  assert.equal(orphans.length, 0,
    'a captured record was left orphaned: ' + orphans.join(', '));
});

test('resume records a durable transition-ambiguity marker before publishing state', async (t) => {
  const spec = await createSupervisorSpec(t, { label: 'ambig-marker', scenario: { settleDelayMs: 10 } });
  const ambiguityPath = spec.statePath + '.ambiguous';
  const renameGate = path.join(spec.root, 'gate-resume-rename');
  const a = spawnWrappedSupervisor(spec, {
    rename: { file: renameGate, target: spec.statePath },
  });
  spec.attachChild(a);
  const status = await waitForStatus(spec.socketPath, 10_000);
  assert.ok(status, 'supervisor did not become ready: ' + (spec.lastStderr || ''));
  const submitted = await submitCli(spec, {
    requestId: 'marker-1', generation: 1, message: 'work',
  });
  assert.equal(submitted.json.accepted, true);
  assert.ok(await waitSettledCli(spec));
  const paused = await runCli([
    'pause', '--socket', spec.socketPath, '--generation', '1', '--owner', 'op-1',
  ]);
  assert.equal(paused.json.ok, true);

  fs.writeFileSync(renameGate, 'on');
  const resumedPromise = runCli([
    'resume', '--socket', spec.socketPath,
    '--generation', String(paused.json.generation), '--owner', 'op-1',
  ]);
  assert.equal(
    await waitForFile(renameGate + '.reached', 10_000),
    true,
    'resume never reached the state rename'
  );
  // The ambiguity fence is durable before the state rename happens.
  const markerBefore = readJsonFile(ambiguityPath);
  assert.ok(markerBefore, 'no durable ambiguity marker before the rename');
  assert.equal(markerBefore.kind, 'resume');
  assert.equal(markerBefore.generation, paused.json.generation + 1);
  fs.unlinkSync(renameGate);
  const resumed = await resumedPromise;
  assert.equal(resumed.json.ok, true);
  assert.equal(fs.existsSync(ambiguityPath), false,
    'the ambiguity marker must be cleared after a durable commit');
});

test('failed restoration leaves evidence a replacement must refuse', async (t) => {
  const spec = await createSupervisorSpec(t, { label: 'ambig-restore', scenario: { settleDelayMs: 10 } });
  const ambiguityPath = spec.statePath + '.ambiguous';
  const renameGate = path.join(spec.root, 'gate-resume-rename');
  const dirFsyncTrigger = path.join(spec.root, 'trigger-dirfsync');
  const restoreTrigger = path.join(spec.root, 'trigger-restore-rename');
  const a = spawnWrappedSupervisor(spec, {
    rename: { file: renameGate, target: spec.statePath },
    dirFsyncFault: { code: 'EIO', errno: -5, trigger: dirFsyncTrigger },
    restoreRenameFault: { code: 'EIO', errno: -5, trigger: restoreTrigger },
  });
  spec.attachChild(a);
  const status = await waitForStatus(spec.socketPath, 10_000);
  assert.ok(status, 'supervisor did not become ready: ' + (spec.lastStderr || ''));
  const piPid = status.piPid;
  const submitted = await submitCli(spec, {
    requestId: 'restore-1', generation: 1, message: 'work',
  });
  assert.equal(submitted.json.accepted, true);
  assert.ok(await waitSettledCli(spec));
  const paused = await runCli([
    'pause', '--socket', spec.socketPath, '--generation', '1', '--owner', 'op-1',
  ]);
  assert.equal(paused.json.ok, true);
  const resumedGeneration = paused.json.generation + 1;

  fs.writeFileSync(renameGate, 'on');
  const resumedPromise = runCli([
    'resume', '--socket', spec.socketPath,
    '--generation', String(paused.json.generation), '--owner', 'op-1',
  ]);
  assert.equal(await waitForFile(renameGate + '.reached', 10_000), true);
  // The commit fails after the rename lands, and the restoration fails before
  // it can put the old state back.
  fs.writeFileSync(dirFsyncTrigger, 'on');
  fs.writeFileSync(restoreTrigger, 'on');
  fs.unlinkSync(renameGate);
  const resumed = await resumedPromise;
  assert.equal(resumed.json.ok, false);
  assert.equal(resumed.json.code, 'state_write_failed');

  const live = await runCli(['status', '--socket', spec.socketPath]);
  assert.equal(live.json.ok, true);
  assert.equal(live.json.paused, true);
  assert.equal(live.json.generation, paused.json.generation);

  // The unpaused state is visible on disk with the ambiguity marker.
  const onDisk = readJsonFile(spec.statePath);
  assert.equal(onDisk.generation, resumedGeneration);
  assert.equal(onDisk.paused, false);

  // The Pi child must be verifiably absent before the replacement runs.
  process.kill(piPid, 'SIGKILL');
  assert.equal(await waitForPidGone(piPid, 8_000), true);
  a.kill('SIGKILL');
  await waitForExit(a, 8_000);

  // A replacement must refuse to honor the unpaused, never-committed grant.
  const refused = await runCli(supervisorLaunchArgs(spec), 20_000);
  assert.equal(refused.code, 2,
    'replacement must refuse the ambiguous state, saw: ' + refused.stdout);
  assert.equal(refused.json.ok, false);
  assert.equal(refused.json.code, 'cleanup_pending');
  assert.match(refused.json.message, /uncommitted transition/i);
  assert.ok(refused.json.details && refused.json.details.cleanupPending === true);
  assert.equal(refused.json.details.ambiguousTransition.kind, 'resume');

  // The evidence survives the refusal untouched.
  const afterRefusal = readJsonFile(spec.statePath);
  assert.equal(afterRefusal.generation, resumedGeneration);
  assert.equal(afterRefusal.paused, false);
  const marker = readJsonFile(ambiguityPath);
  assert.ok(marker, 'the ambiguity marker did not survive the failed restoration');
  assert.equal(marker.kind, 'resume');
});

test('abrupt exit during rollback leaves an ambiguous grant a replacement refuses', async (t) => {
  const spec = await createSupervisorSpec(t, { label: 'ambig-crash', scenario: { settleDelayMs: 10 } });
  const ambiguityPath = spec.statePath + '.ambiguous';
  const renameGate = path.join(spec.root, 'gate-resume-rename');
  const restoreGate = path.join(spec.root, 'gate-restore-rename');
  const dirFsyncTrigger = path.join(spec.root, 'trigger-dirfsync');
  const a = spawnWrappedSupervisor(spec, {
    rename: { file: renameGate, target: spec.statePath },
    restoreRenameGate: { file: restoreGate, target: spec.statePath },
    dirFsyncFault: { code: 'EIO', errno: -5, trigger: dirFsyncTrigger },
  });
  spec.attachChild(a);
  const status = await waitForStatus(spec.socketPath, 10_000);
  assert.ok(status, 'supervisor did not become ready: ' + (spec.lastStderr || ''));
  const piPid = status.piPid;
  const submitted = await submitCli(spec, {
    requestId: 'crash-1', generation: 1, message: 'work',
  });
  assert.equal(submitted.json.accepted, true);
  assert.ok(await waitSettledCli(spec));
  const paused = await runCli([
    'pause', '--socket', spec.socketPath, '--generation', '1', '--owner', 'op-1',
  ]);
  assert.equal(paused.json.ok, true);
  const resumedGeneration = paused.json.generation + 1;

  fs.writeFileSync(restoreGate, 'on');
  fs.writeFileSync(renameGate, 'on');
  const resumed = runCli([
    'resume', '--socket', spec.socketPath,
    '--generation', String(paused.json.generation), '--owner', 'op-1',
  ]);
  assert.equal(await waitForFile(renameGate + '.reached', 10_000), true);
  fs.writeFileSync(dirFsyncTrigger, 'on');
  fs.unlinkSync(renameGate);
  // The rename lands, the directory fsync fails, the rollback starts, and the
  // supervisor exits abruptly in the middle of it. No rollback is possible.
  assert.equal(
    await waitForFile(restoreGate + '.reached', 10_000),
    true,
    'rollback never reached the restore rename'
  );
  a.kill('SIGKILL');
  await waitForExit(a, 8_000);
  await resumed;

  // The crash boundary leaves the renamed state and the durable marker.
  const onDisk = readJsonFile(spec.statePath);
  assert.equal(onDisk.generation, resumedGeneration);
  assert.equal(onDisk.paused, false);

  try {
    process.kill(piPid, 'SIGKILL');
  } catch (error) {
    // The orphaned child exits on its own once the supervisor's pipe closes.
    if (error.code !== 'ESRCH') throw error;
  }
  assert.equal(await waitForPidGone(piPid, 8_000), true);

  // A replacement must refuse the ambiguous grant instead of resuming it.
  const refused = await runCli(supervisorLaunchArgs(spec), 20_000);
  assert.equal(refused.code, 2,
    'replacement must refuse the ambiguous state, saw: ' + refused.stdout);
  assert.equal(refused.json.ok, false);
  assert.equal(refused.json.code, 'cleanup_pending');
  assert.match(refused.json.message, /uncommitted transition/i);
  assert.equal(refused.json.details.ambiguousTransition.kind, 'resume');
  const marker = readJsonFile(ambiguityPath);
  assert.ok(marker, 'no ambiguity marker at the crash boundary');
  assert.equal(marker.kind, 'resume');
});

test('durable rollback clears the ambiguity marker and recovery proceeds', async (t) => {
  const spec = await createSupervisorSpec(t, { label: 'ambig-rollback', scenario: { settleDelayMs: 10 } });
  const ambiguityPath = spec.statePath + '.ambiguous';
  const renameGate = path.join(spec.root, 'gate-resume-rename');
  const restoreGate = path.join(spec.root, 'gate-restore-rename');
  const dirFsyncTrigger = path.join(spec.root, 'trigger-dirfsync');
  const a = spawnWrappedSupervisor(spec, {
    rename: { file: renameGate, target: spec.statePath },
    restoreRenameGate: { file: restoreGate, target: spec.statePath },
    dirFsyncFault: { code: 'EIO', errno: -5, trigger: dirFsyncTrigger },
  });
  spec.attachChild(a);
  const status = await waitForStatus(spec.socketPath, 10_000);
  assert.ok(status, 'supervisor did not become ready: ' + (spec.lastStderr || ''));
  const submitted = await submitCli(spec, {
    requestId: 'rollback-1', generation: 1, message: 'work',
  });
  assert.equal(submitted.json.accepted, true);
  assert.ok(await waitSettledCli(spec));
  const paused = await runCli([
    'pause', '--socket', spec.socketPath, '--generation', '1', '--owner', 'op-1',
  ]);
  assert.equal(paused.json.ok, true);

  fs.writeFileSync(restoreGate, 'on');
  fs.writeFileSync(renameGate, 'on');
  const resumedPromise = runCli([
    'resume', '--socket', spec.socketPath,
    '--generation', String(paused.json.generation), '--owner', 'op-1',
  ]);
  assert.equal(await waitForFile(renameGate + '.reached', 10_000), true);
  fs.writeFileSync(dirFsyncTrigger, 'on');
  fs.unlinkSync(renameGate);
  assert.equal(await waitForFile(restoreGate + '.reached', 10_000), true);
  // Make the rollback itself durable before letting it land.
  fs.unlinkSync(dirFsyncTrigger);
  fs.unlinkSync(restoreGate);
  const resumed = await resumedPromise;
  assert.equal(resumed.json.ok, false);
  assert.equal(resumed.json.code, 'state_write_failed');

  // The rollback is durable and the marker is cleared in the same critical
  // section.
  const onDisk = readJsonFile(spec.statePath);
  assert.equal(onDisk.generation, paused.json.generation);
  assert.equal(onDisk.paused, true);
  assert.equal(fs.existsSync(ambiguityPath), false,
    'a durable rollback must clear the ambiguity marker');
  const live = await runCli(['status', '--socket', spec.socketPath]);
  assert.equal(live.json.paused, true);
  assert.equal(live.json.pauseOwner, 'op-1');

  // A replacement recovers normally after the cleared fence.
  const piPid = live.json.piPid;
  process.kill(piPid, 'SIGKILL');
  assert.equal(await waitForPidGone(piPid, 8_000), true);
  a.kill('SIGKILL');
  await waitForExit(a, 8_000);
  const replacement = spawnSupervisorProcess(spec);
  spec.attachChild(replacement);
  const replacementStatus = await waitForStatus(spec.socketPath, 15_000);
  assert.ok(replacementStatus, 'replacement did not recover normally');
  assert.equal(replacementStatus.paused, true);
  assert.equal(replacementStatus.pauseOwner, 'op-1');
  const resumedAgain = await runCli([
    'resume', '--socket', spec.socketPath,
    '--generation', String(replacementStatus.generation), '--owner', 'op-1',
  ]);
  assert.equal(resumedAgain.json.ok, true);
});

// --- PI-R4 repair pass 4 regressions (PI-R4-01 / PI-R4-02) ---

/**
 * Start a replacement after a failed or ambiguous transition and assert the
 * result without assuming the verdict: a replacement that grants the state
 * stays alive (the defect this suite refuses), a replacement that refuses
 * exits with cleanup_pending.
 */
async function startReplacementAndExpectRefusal(spec, failureDescription) {
  const replacement = spawnSupervisorProcess(spec);
  spec.attachChild(replacement);
  let grantedStatus = null;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (replacement.exitCode !== null || replacement.signalCode !== null) {
      break;
    }
    grantedStatus = await waitForStatus(spec.socketPath, 250);
    if (grantedStatus) {
      break;
    }
  }
  if (grantedStatus) {
    try {
      await runCli(['stop', '--socket', spec.socketPath], 6_000);
    } catch {
      // The defective grant is being torn down for cleanup only.
    }
    await waitForExit(replacement, 8_000);
    assert.fail(failureDescription +
      ' A replacement granted generation ' + grantedStatus.generation +
      ' with paused=' + grantedStatus.paused + ' after restart.');
  }
  const refused = await runCli(supervisorLaunchArgs(spec), 20_000);
  assert.equal(refused.code, 2,
    'replacement must refuse the state, saw: ' + refused.stdout);
  assert.equal(refused.json.ok, false);
  assert.equal(refused.json.code, 'cleanup_pending');
  assert.ok(refused.json.details && refused.json.details.cleanupPending === true,
    'refusal must carry cleanup_pending evidence');
  return refused;
}

test('marker retirement fsync failure keeps a failed transition ungrantable', async (t) => {
  const spec = await createSupervisorSpec(t, { label: 'marker-retire-fsync', scenario: { settleDelayMs: 10 } });
  const ambiguityPath = spec.statePath + '.ambiguous';
  const trigger = path.join(spec.root, 'trigger-marker-fsync');
  const a = spawnWrappedSupervisor(spec, {
    markerRetireFsyncFault: { markerPath: ambiguityPath, trigger, code: 'EIO', errno: -5 },
  });
  spec.attachChild(a);
  const status = await waitForStatus(spec.socketPath, 10_000);
  assert.ok(status, 'supervisor did not become ready: ' + (spec.lastStderr || ''));
  const submitted = await submitCli(spec, {
    requestId: 'retire-1', generation: 1, message: 'work',
  });
  assert.equal(submitted.json.accepted, true);
  assert.ok(await waitSettledCli(spec));
  const paused = await runCli([
    'pause', '--socket', spec.socketPath, '--generation', '1', '--owner', 'op-1',
  ]);
  assert.equal(paused.json.ok, true);
  const resumedGeneration = paused.json.generation + 1;

  // The fault arms exactly at the marker-retirement boundary: the unlink of
  // the ambiguity marker succeeds, its directory fsync fails.
  fs.writeFileSync(trigger, 'on');
  const resumed = await runCli([
    'resume', '--socket', spec.socketPath,
    '--generation', String(paused.json.generation), '--owner', 'op-1',
  ]);
  assert.equal(resumed.json.ok, false,
    'the transition must report failure, saw: ' + JSON.stringify(resumed.json));
  assert.equal(resumed.json.code, 'state_write_failed');

  // The supervisor rolled its in-memory grant back.
  const live = await runCli(['status', '--socket', spec.socketPath]);
  assert.equal(live.json.ok, true);
  assert.equal(live.json.paused, true);
  assert.equal(live.json.generation, paused.json.generation);

  // The durable state file carries the newer unpaused generation. The defect
  // assertion comes first: a transition reported as failure must never be
  // granted by a replacement.
  const piPid = live.json.piPid;
  process.kill(piPid, 'SIGKILL');
  assert.equal(await waitForPidGone(piPid, 8_000), true);
  a.kill('SIGKILL');
  await waitForExit(a, 8_000);
  await startReplacementAndExpectRefusal(spec,
    'PI-R4-02: a transition reported as failure became effective after restart.');

  // Evidence assertions after the verdict: the newer state file is durable
  // and the fence was re-established during the failure report.
  const onDisk = readJsonFile(spec.statePath);
  assert.equal(onDisk.generation, resumedGeneration);
  assert.equal(onDisk.paused, false);
  const marker = readJsonFile(ambiguityPath);
  assert.ok(marker, 'the retirement failure must re-establish the fence');
  assert.equal(marker.kind, 'resume');
  assert.equal(marker.generation, resumedGeneration);
});

test('crash at the marker unlink/fsync boundary keeps the state ungrantable', async (t) => {
  const spec = await createSupervisorSpec(t, { label: 'marker-retire-crash', scenario: { settleDelayMs: 10 } });
  const ambiguityPath = spec.statePath + '.ambiguous';
  const trigger = path.join(spec.root, 'trigger-marker-crash');
  const gate = path.join(spec.root, 'gate-marker-fsync');
  const a = spawnWrappedSupervisor(spec, {
    markerRetireFsyncGate: { markerPath: ambiguityPath, trigger, file: gate },
  });
  spec.attachChild(a);
  const status = await waitForStatus(spec.socketPath, 10_000);
  assert.ok(status, 'supervisor did not become ready: ' + (spec.lastStderr || ''));
  const piPid = status.piPid;
  const submitted = await submitCli(spec, {
    requestId: 'retire-crash-1', generation: 1, message: 'work',
  });
  assert.equal(submitted.json.accepted, true);
  assert.ok(await waitSettledCli(spec));
  const paused = await runCli([
    'pause', '--socket', spec.socketPath, '--generation', '1', '--owner', 'op-1',
  ]);
  assert.equal(paused.json.ok, true);
  const resumedGeneration = paused.json.generation + 1;

  fs.writeFileSync(trigger, 'on');
  // Arm the crash gate so the fsync hook parks after the marker unlink.
  fs.writeFileSync(gate, 'on');
  const resumedPromise = runCli([
    'resume', '--socket', spec.socketPath,
    '--generation', String(paused.json.generation), '--owner', 'op-1',
  ]);
  // The crash lands after the marker unlink and before its directory fsync.
  assert.equal(
    await waitForFile(gate + '.reached', 10_000),
    true,
    'resume never reached the marker retirement boundary'
  );
  a.kill('SIGKILL');
  await waitForExit(a, 8_000);
  await resumedPromise.catch(() => null);

  // The crash boundary leaves the renamed state without the marker and
  // without a verified commit record.
  const onDisk = readJsonFile(spec.statePath);
  assert.equal(onDisk.generation, resumedGeneration);
  assert.equal(onDisk.paused, false);
  assert.equal(fs.existsSync(ambiguityPath), false,
    'the marker was unlinked before the crash');

  try {
    process.kill(piPid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  assert.equal(await waitForPidGone(piPid, 8_000), true);

  // A replacement must refuse the state whose commit was never verified.
  await startReplacementAndExpectRefusal(spec,
    'PI-R4-02: a crash at the marker retirement boundary became effective after restart.');
});

test('a fully committed transition grants normally after restart', async (t) => {
  const spec = await createSupervisorSpec(t, { label: 'commit-control', scenario: { settleDelayMs: 10 } });
  const committedPath = spec.statePath + '.committed';
  const a = spawnWrappedSupervisor(spec, {});
  spec.attachChild(a);
  const status = await waitForStatus(spec.socketPath, 10_000);
  assert.ok(status, 'supervisor did not become ready: ' + (spec.lastStderr || ''));
  const submitted = await submitCli(spec, {
    requestId: 'commit-control-1', generation: 1, message: 'work',
  });
  assert.equal(submitted.json.accepted, true);
  assert.ok(await waitSettledCli(spec));
  const paused = await runCli([
    'pause', '--socket', spec.socketPath, '--generation', '1', '--owner', 'op-1',
  ]);
  assert.equal(paused.json.ok, true);
  const resumed = await runCli([
    'resume', '--socket', spec.socketPath,
    '--generation', String(paused.json.generation), '--owner', 'op-1',
  ]);
  assert.equal(resumed.json.ok, true);
  const resumedGeneration = paused.json.generation + 1;

  // Success means the whole chain is durable, including marker retirement,
  // and the committed-generation record proves it.
  const committed = readJsonFile(committedPath);
  assert.ok(committed, 'a committed transition must record its committed generation');
  assert.equal(committed.generation, resumedGeneration);
  assert.equal(fs.existsSync(spec.statePath + '.ambiguous'), false,
    'the fence must be retired after a durable commit');

  const live = await runCli(['status', '--socket', spec.socketPath]);
  const piPid = live.json.piPid;
  process.kill(piPid, 'SIGKILL');
  assert.equal(await waitForPidGone(piPid, 8_000), true);
  a.kill('SIGKILL');
  await waitForExit(a, 8_000);

  // A replacement grants the fully committed transition normally.
  const replacement = spawnSupervisorProcess(spec);
  spec.attachChild(replacement);
  const replacementStatus = await waitForStatus(spec.socketPath, 15_000);
  assert.ok(replacementStatus, 'replacement did not grant the committed transition');
  assert.equal(replacementStatus.paused, false);
  assert.equal(replacementStatus.generation, resumedGeneration + 1);
});
