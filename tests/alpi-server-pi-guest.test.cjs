'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createInterface } = require('node:readline');
const { test } = require('node:test');

const executable = process.env.ALPI_PI_BIN;

async function withSession(cwd, sessionId, run) {
  const child = spawn(executable, [
    '--mode', 'rpc', '--session-id', sessionId, '--session-dir', path.join(cwd, 'sessions'),
    '--model', 'alpi/fixture', '--no-context-files', '--no-approve', '--no-mcp',
    '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-tools',
  ], {
    cwd,
    env: { PATH: process.env.PATH, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_CODING_AGENT_DIR: path.join(cwd, 'agent') },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const exit = once(child, 'close');
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const events = lines[Symbol.asyncIterator]();
  const deadline = setTimeout(() => child.kill('SIGKILL'), 10000);
  try {
    await run({
      send(message) { child.stdin.write(JSON.stringify(message) + '\n'); },
      async next() {
        const frame = await events.next();
        assert.equal(frame.done, false, 'Pi stopped before the expected RPC event');
        return JSON.parse(frame.value);
      },
    });
  } finally {
    clearTimeout(deadline);
    lines.close();
    child.kill('SIGKILL');
    await exit;
  }
}

test('stock Pi persists a completed turn under its native session ID', {
  skip: executable ? false : 'Set ALPI_PI_BIN to the pinned stock guest executable',
  timeout: 30000,
}, async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'alpi-pi-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  let requests = 0;
  const provider = http.createServer(async (req, res) => {
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks));
    if (request.model !== 'fixture') { res.writeHead(400).end(); return; }
    requests++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const [delta, finish] of [[{ role: 'assistant', content: 'alpi-fixture-result' }, null], [{}, 'stop']]) {
      const chunk = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: request.model,
        choices: [{ index: 0, delta, finish_reason: finish }] };
      res.write('data: ' + JSON.stringify(chunk) + '\n\n');
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve, reject) => provider.once('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => provider.close(resolve)));
  await fs.mkdir(path.join(cwd, 'agent'), { mode: 0o700 });
  const models = { providers: { alpi: { baseUrl: 'http://127.0.0.1:' + provider.address().port + '/v1',
    api: 'openai-completions', apiKey: 'fixture', models: [{ id: 'fixture' }] } } };
  await fs.writeFile(path.join(cwd, 'agent', 'models.json'), JSON.stringify(models), { mode: 0o600 });
  const session = randomUUID();
  await withSession(cwd, session, async ({ send, next }) => {
    send({ id: 'state', type: 'get_state' });
    let event;
    do { event = await next(); } while (event.id !== 'state');
    assert.equal(event.data.sessionId, session);
    send({ id: 'turn', type: 'prompt', message: 'Return the fixture response.' });
    let accepted = false;
    let settled = false;
    while (!accepted || !settled) {
      event = await next();
      if (event.id === 'turn') { assert.equal(event.success, true); accepted = true; }
      if (event.type === 'agent_settled') settled = true;
    }
  });
  await withSession(cwd, session, async ({ send, next }) => {
    send({ id: 'history', type: 'get_messages' });
    let message;
    do { message = await next(); } while (message.id !== 'history');
    assert.equal(message.success, true);
    assert.match(JSON.stringify(message.data), /alpi-fixture-result/);
  });
  assert.equal(requests, 1);
});
