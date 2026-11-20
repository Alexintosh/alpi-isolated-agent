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
  fs.writeFileSync(path.join(workspace, 'fake-pi-scenario.json'), JSON.stringify(scenario));
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
  const args = [
    'supervise',
    '--foreground',
    '--socket', socketPath,
    '--state', statePath,
    '--session-id', sessionId,
    '--cwd', workspace,
    '--session-dir', sessions,
    '--agent-dir', agent,
    '--home', home,
    '--provider', 'alpi',
    '--model', 'fixture',
    '--pi', fakePi,
    '--path-env', process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    '--log', logPath,
    '--max-events', String(options.maxEvents || 32),
    '--submit-deadline-ms', String(options.submitDeadlineMs || 500),
    '--command-deadline-ms', String(options.commandDeadlineMs || 2_000),
    '--quiesce-deadline-ms', String(options.quiesceDeadlineMs || 800),
    '--stop-deadline-ms', String(options.stopDeadlineMs || 2_000),
  ];
  const child = spawn(NODE, [SUPERVISOR, ...args], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
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
    fs.rmSync(root, { recursive: true, force: true });
  });
  const status = await waitForStatus(socketPath);
  if (!status) {
    throw new Error(`Supervisor did not start: ${stderr}`);
  }
  return {
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
    child,
    status,
  };
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
