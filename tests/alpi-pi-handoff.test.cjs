'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const executable = process.env.ALPI_PI_BIN;
const supervisor = process.env.ALPI_PI_SUPERVISOR || path.resolve(
  __dirname, '../packages/alpi-server/profiles/pi-dev/guest-session.cjs');

function reply(res, delta, finish) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const [content, reason] of [[delta, null], [{}, finish]]) {
    const frame = { id: 'test', object: 'chat.completion.chunk', created: 1, model: 'fixture',
      choices: [{ index: 0, delta: content, finish_reason: reason }] };
    res.write('data: ' + JSON.stringify(frame) + '\n\n');
  }
  res.end('data: [DONE]\n\n');
}

test('stock Pi executes a file write and fences both sides of a same-session handoff', {
  skip: executable ? false : 'Set ALPI_PI_BIN to the pinned stock guest executable',
  timeout: 60000,
}, async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'alpi-handoff-'));
  const socket = path.join(base, 'rpc.sock');
  const session = randomUUID();
  const requests = [];
  const fileText = 'verified workspace result\n';
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return res.writeHead(404).end();
    const body = [];
    for await (const chunk of req) body.push(chunk);
    requests.push(JSON.parse(Buffer.concat(body)));
    if (requests.length === 1) {
      const args = JSON.stringify({ path: 'alpi-result.txt', content: fileText });
      reply(res, { role: 'assistant', tool_calls: [{ index: 0, type: 'function', id: 'write_file',
        function: { name: 'write', arguments: args } }] }, 'tool_calls');
    } else {
      reply(res, { role: 'assistant', content: 'turn ' + requests.length + ' complete' }, 'stop');
    }
  });
  async function command(action, ...args) {
    const params = [supervisor, action, '--socket', socket, ...args.map(String)];
    try {
      const { stdout } = await execFile(process.execPath, params, { timeout: 15000 });
      const result = JSON.parse(stdout);
      assert.equal(result.ok, true);
      return result;
    } catch (error) {
      if (typeof error.code !== 'number') throw error;
      const envelope = JSON.parse(error.stdout || error.stderr);
      assert.equal(envelope.ok, false);
      throw Object.assign(new Error(action + ' failed'), { code: envelope.code || envelope.error?.code });
    }
  }
  async function awaitTurn(id) {
    const deadline = Date.now() + 10000;
    let after = 0;
    while (Date.now() < deadline) {
      const result = await command('events', '--after', after, '--wait-ms', 500);
      if (result.activeTurn?.requestId === id && result.settled) return;
      after = result.nextSeq;
    }
    assert.fail('Pi did not settle the expected turn');
  }
  let started = false;
  try {
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    for (const name of ['agent', 'work', 'sessions']) await fs.mkdir(path.join(base, name), { mode: 0o700 });
    const config = { providers: { alpi: { baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1',
      api: 'openai-completions', apiKey: 'fixture', models: [{ id: 'fixture' }] } } };
    await fs.writeFile(path.join(base, 'agent/models.json'), JSON.stringify(config), { mode: 0o600 });
    await command('supervise', '--state', path.join(base, 'state.json'), '--session-id', session,
      '--cwd', path.join(base, 'work'), '--session-dir', path.join(base, 'sessions'), '--agent-dir',
      path.join(base, 'agent'), '--home', base, '--provider', 'alpi', '--model', 'fixture',
      '--pi', executable, '--path-env', process.env.PATH);
    started = true;
    const { generation } = await command('status');
    const submit = (id, gen, ...extra) => command('submit', '--request-id', id, '--generation', gen,
      ...extra, '--chunk', 'Work in this session.');
    assert.equal((await submit('first', generation)).accepted, true);
    await awaitTurn('first');
    assert.equal(await fs.readFile(path.join(base, 'work/alpi-result.txt'), 'utf8'), fileText);
    const handoff = await command('pause', '--generation', generation, '--owner', 'operator');
    assert.equal(handoff.quiescent, true);
    await assert.rejects(submit('stale-agent', generation), { code: 'stale_writer' });
    const operator = ['--owner', 'operator', '--operator'];
    assert.equal((await submit('second', handoff.generation, ...operator)).accepted, true);
    await awaitTurn('second');
    const resumed = await command('resume', '--generation', handoff.generation, '--owner', 'operator');
    assert.ok(resumed.generation > handoff.generation);
    await assert.rejects(submit('stale-human', handoff.generation, ...operator), { code: 'stale_writer' });
    assert.equal((await command('status')).sessionId, session);
    assert.match(JSON.stringify(await command('messages')), /turn 3 complete/);
    assert.equal(requests.length, 3);
    assert.ok(requests.every(r => r.model === 'fixture'));
    assert.ok(requests[0].tools.some(t => t.function?.name === 'write'));
  } finally {
    try {
      if (started) await command('stop');
    } finally {
      await new Promise(resolve => server.close(resolve));
      await fs.rm(base, { recursive: true, force: true });
    }
  }
});
