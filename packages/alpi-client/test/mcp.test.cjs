'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { PassThrough, Readable, Writable } = require('node:stream');
const { test } = require('node:test');

const { MAX_INPUT_BYTES, runMcp } = require('../src/mcp.cjs');

const BIN = path.resolve(__dirname, '../bin/alpi.cjs');

function capabilities(overrides = {}) {
  return {
    serverId: '11111111-1111-4111-8111-111111111111',
    apiVersion: 1,
    project: 'demo',
    role: 'runner',
    runtimes: [],
    ...overrides,
  };
}

function initialize(id = 1, protocolVersion = '2025-06-18') {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0.0' },
    },
  };
}

function createHarness(getCapabilities, workTools) {
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding('utf8');

  const messages = [];
  const waiters = [];
  let text = '';

  function notify(message) {
    messages.push(message);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const waiter = waiters[i];
      if (waiter.predicate(message)) {
        waiters.splice(i, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  }

  output.on('data', (chunk) => {
    text += chunk;
    let newline = text.indexOf('\n');
    while (newline !== -1) {
      const line = text.slice(0, newline);
      text = text.slice(newline + 1);
      if (line.trim().length > 0) {
        notify(JSON.parse(line));
      }
      newline = text.indexOf('\n');
    }
  });

  function waitFor(predicate, timeoutMs = 2000) {
    const found = messages.find(predicate);
    if (found !== undefined) {
      return Promise.resolve(found);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index !== -1) {
            waiters.splice(index, 1);
          }
          reject(new Error('Timed out waiting for MCP message.'));
        }, timeoutMs),
      };
      waiters.push(waiter);
    });
  }

  function waitForId(id, timeoutMs) {
    return waitFor((message) => message.id === id, timeoutMs);
  }

  function waitForCount(count, timeoutMs) {
    return waitFor(() => messages.length >= count, timeoutMs);
  }

  function send(value) {
    input.write(typeof value === 'string' ? value : `${JSON.stringify(value)}\n`);
  }

  function sendRaw(value) {
    input.write(value);
  }

  function end() {
    input.end();
  }

  const done = runMcp({ getCapabilities, workTools, input, output });

  return {
    done,
    end,
    input,
    messages,
    output,
    send,
    sendRaw,
    waitFor,
    waitForCount,
    waitForId,
  };
}

test('initializes, negotiates, and discovers only the implemented tool', async () => {
  const harness = createHarness(async () => capabilities());

  const line = `${JSON.stringify(initialize(1))}\n`;
  harness.sendRaw(line.slice(0, 30));
  harness.sendRaw(line.slice(30));

  const init = await harness.waitForId(1);
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.equal(init.result.serverInfo.name, 'alpi');
  assert.equal(typeof init.result.serverInfo.version, 'string');

  harness.sendRaw([
    '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
    JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
    '',
  ].join('\n'));

  const ping = await harness.waitForId(2);
  assert.deepEqual(ping.result, {});

  const list = await harness.waitForId(3);
  assert.equal(list.result.tools.length, 1);
  assert.equal(list.result.tools[0].name, 'alpi_capabilities');
  assert.equal(list.result.tools[0].inputSchema.type, 'object');
  assert.equal(list.result.tools[0].inputSchema.additionalProperties, false);
  assert.deepEqual(list.result.tools[0].inputSchema.properties, {});

  harness.send(initialize(4, '2026-01-01'));
  const newer = await harness.waitForId(4);
  assert.equal(newer.result.protocolVersion, '2025-06-18');

  harness.end();
  await harness.done;
});

test('calls capabilities without caching and returns text plus structured content', async () => {
  const caps = capabilities({ runtimes: [{ id: 'r1', status: 'ready' }] });
  let calls = 0;
  const harness = createHarness(async () => {
    calls += 1;
    return caps;
  });

  harness.send(initialize(1));
  await harness.waitForId(1);

  harness.send({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'alpi_capabilities', arguments: {} },
  });
  const first = await harness.waitForId(2);
  assert.equal(first.result.isError, undefined);
  assert.equal(first.result.content.length, 1);
  assert.equal(first.result.content[0].type, 'text');
  assert.deepEqual(JSON.parse(first.result.content[0].text), caps);
  assert.deepEqual(first.result.structuredContent, caps);
  assert.equal(calls, 1);

  harness.send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'alpi_capabilities' },
  });
  const second = await harness.waitForId(3);
  assert.deepEqual(second.result.structuredContent, caps);
  assert.equal(calls, 2);

  harness.send({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'alpi_capabilities',
      arguments: { origin: 'https://example.invalid' },
    },
  });
  const rejected = await harness.waitForId(4);
  assert.equal(rejected.error.code, -32602);
  assert.equal(calls, 2);

  harness.end();
  await harness.done;
});

test('turns remote and revocation errors into safe bounded tool errors', async () => {
  let mode = 'revoked';
  const harness = createHarness(async () => {
    if (mode === 'revoked') {
      const error = new Error('credential secret-token-should-not-leak');
      error.code = 'HTTP_STATUS';
      error.statusCode = 401;
      throw error;
    }
    const error = new Error('credential secret-token-should-not-leak');
    error.code = 'CREDENTIAL_EXPIRED';
    throw error;
  });

  harness.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'alpi_capabilities' },
  });
  const revoked = await harness.waitForId(1);
  assert.equal(revoked.result.isError, true);
  assert.equal(revoked.result.content[0].type, 'text');
  assert.match(revoked.result.content[0].text, /revoked/i);
  assert.equal(revoked.result.structuredContent, undefined);
  assert.doesNotMatch(
    revoked.result.content[0].text,
    /secret-token-should-not-leak/,
  );

  mode = 'expired';
  harness.send({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'alpi_capabilities' },
  });
  const expired = await harness.waitForId(2);
  assert.equal(expired.result.isError, true);
  assert.match(expired.result.content[0].text, /expired/i);
  assert.doesNotMatch(
    expired.result.content[0].text,
    /secret-token-should-not-leak/,
  );

  harness.end();
  await harness.done;
});

test('reports malformed and oversized input safely and keeps serving', async () => {
  const harness = createHarness(async () => capabilities());

  let count = harness.messages.length;
  harness.sendRaw('not json\n');
  await harness.waitForCount(count + 1);
  assert.equal(harness.messages.at(-1).id, null);
  assert.equal(harness.messages.at(-1).error.code, -32700);

  count = harness.messages.length;
  harness.send({ jsonrpc: '1.0', id: 2, method: 'ping' });
  await harness.waitForCount(count + 1);
  assert.equal(harness.messages.at(-1).id, 2);
  assert.equal(harness.messages.at(-1).error.code, -32600);

  count = harness.messages.length;
  harness.send({ jsonrpc: '1.0', method: 'ping' });
  await harness.waitForCount(count + 1);
  assert.equal(harness.messages.at(-1).id, null);
  assert.equal(harness.messages.at(-1).error.code, -32600);

  count = harness.messages.length;
  harness.send({ jsonrpc: '2.0', id: 3, method: 'unknown/method' });
  await harness.waitForCount(count + 1);
  assert.equal(harness.messages.at(-1).id, 3);
  assert.equal(harness.messages.at(-1).error.code, -32601);

  count = harness.messages.length;
  harness.sendRaw('x'.repeat(MAX_INPUT_BYTES + 1));
  harness.sendRaw('\n');
  await harness.waitForCount(count + 1);
  assert.equal(harness.messages.at(-1).id, null);
  assert.equal(harness.messages.at(-1).error.code, -32700);

  harness.send({ jsonrpc: '2.0', id: 4, method: 'ping' });
  const ping = await harness.waitForId(4);
  assert.deepEqual(ping.result, {});

  harness.end();
  await harness.done;
});

test('handles cancellation without emitting a cancelled response', async () => {
  let resolveFirst;
  const first = new Promise((resolve) => {
    resolveFirst = resolve;
  });
  const harness = createHarness(() => first);

  harness.send({
    jsonrpc: '2.0',
    id: 10,
    method: 'tools/call',
    params: { name: 'alpi_capabilities' },
  });
  await new Promise((resolve) => setImmediate(resolve));

  harness.send({
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: { requestId: 10, reason: 'test' },
  });
  await new Promise((resolve) => setImmediate(resolve));

  resolveFirst(capabilities());
  await new Promise((resolve) => setImmediate(resolve));

  harness.send({ jsonrpc: '2.0', id: 11, method: 'ping' });
  await harness.waitForId(11);
  harness.end();
  await harness.done;

  assert.equal(harness.messages.some((message) => message.id === 10), false);
  assert.equal(harness.messages.some((message) => message.id === 11), true);
});

test('waits for pending tool work and output before resolving on EOF', async () => {
  const harness = createHarness(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    return capabilities();
  });

  harness.send({
    jsonrpc: '2.0',
    id: 20,
    method: 'tools/call',
    params: { name: 'alpi_capabilities' },
  });
  harness.end();
  await harness.done;

  const message = harness.messages.find((entry) => entry.id === 20);
  assert.ok(message);
  assert.equal(message.result.isError, undefined);
});

test('rejects safely when the output stream fails', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const done = runMcp({
    getCapabilities: async () => capabilities(),
    input,
    output,
  });

  const expectation = assert.rejects(done, /MCP stream failure/);
  output.destroy(new Error('boom'));
  await expectation;
  input.destroy();
});

test('drains buffered requests after EOF beyond the in-flight limit', async () => {
  const harness = createHarness(async () => capabilities());
  for (let id = 1; id <= 20; id += 1) {
    harness.send({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'alpi_capabilities' },
    });
  }
  harness.end();
  await harness.done;

  const responses = harness.messages.filter(
    (message) => message.id >= 1 && message.id <= 20,
  );
  assert.equal(responses.length, 20);
  for (const response of responses) {
    assert.equal(response.result.isError, undefined);
  }
});

test('drains coalesced complete frames after EOF beyond the in-flight limit', async () => {
  const input = new Readable({ read() {} });
  const output = new PassThrough();
  output.setEncoding('utf8');

  const messages = [];
  let text = '';
  output.on('data', (chunk) => {
    text += chunk;
    let newline = text.indexOf('\n');
    while (newline !== -1) {
      const line = text.slice(0, newline);
      text = text.slice(newline + 1);
      if (line.trim().length > 0) {
        messages.push(JSON.parse(line));
      }
      newline = text.indexOf('\n');
    }
  });

  const done = runMcp({
    getCapabilities: async () => capabilities(),
    input,
    output,
  });

  const requests = [];
  for (let id = 1; id <= 20; id += 1) {
    requests.push(JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'alpi_capabilities' },
    }));
  }
  input.push(`${requests.join('\n')}\n`);
  input.push(null);
  await done;

  const responses = messages.filter(
    (message) => message.id >= 1 && message.id <= 20,
  );
  assert.equal(responses.length, 20);
  assert.equal(messages.some((message) => message.id === null), false);
  for (const response of responses) {
    assert.equal(response.result.isError, undefined);
  }
});

test('waits for delayed output writes and rejects deferred failures', async () => {
  class DelayedWritable extends Writable {
    constructor({ delayMs = 30, fail = false } = {}) {
      super();
      this.delayMs = delayMs;
      this.fail = fail;
      this.callbacks = 0;
      this.chunks = [];
    }

    _write(chunk, _encoding, callback) {
      this.chunks.push(Buffer.from(chunk));
      setTimeout(() => {
        this.callbacks += 1;
        callback(this.fail ? new Error('late write failure') : null);
      }, this.delayMs);
    }
  }

  const ping = '{"jsonrpc":"2.0","id":1,"method":"ping"}\n';

  const successInput = new PassThrough();
  const successOutput = new DelayedWritable({ delayMs: 30 });
  const successDone = runMcp({
    getCapabilities: async () => capabilities(),
    input: successInput,
    output: successOutput,
  });
  successInput.write(ping);
  successInput.end();
  await successDone;

  assert.equal(successOutput.callbacks, 1);
  assert.equal(successOutput.chunks.length, 1);
  assert.equal(successOutput.listenerCount('error'), 0);
  assert.equal(successOutput.listenerCount('close'), 0);
  assert.equal(successInput.listenerCount('data'), 0);
  assert.equal(successInput.listenerCount('end'), 0);
  assert.equal(successInput.listenerCount('close'), 0);
  assert.equal(successInput.listenerCount('error'), 0);

  const failedInput = new PassThrough();
  const failedOutput = new DelayedWritable({ delayMs: 30, fail: true });
  const failedDone = runMcp({
    getCapabilities: async () => capabilities(),
    input: failedInput,
    output: failedOutput,
  });
  failedInput.write(ping);
  failedInput.end();
  await assert.rejects(failedDone, /MCP stream failure/);

  assert.equal(failedOutput.callbacks, 1);
  assert.equal(failedOutput.listenerCount('error'), 0);
  assert.equal(failedOutput.listenerCount('close'), 0);
  assert.equal(failedInput.listenerCount('data'), 0);
  assert.equal(failedInput.listenerCount('end'), 0);
  assert.equal(failedInput.listenerCount('close'), 0);
  assert.equal(failedInput.listenerCount('error'), 0);

  const lateInput = new PassThrough();
  const lateOutput = new DelayedWritable({ delayMs: 80 });
  const lateDone = runMcp({
    getCapabilities: async () => capabilities(),
    input: lateInput,
    output: lateOutput,
  });
  lateInput.write(ping);
  lateInput.end();
  const lateError = setTimeout(() => {
    lateOutput.destroy(new Error('late stream failure'));
  }, 10);
  await assert.rejects(lateDone, /MCP stream failure/);
  clearTimeout(lateError);

  assert.equal(lateOutput.listenerCount('error'), 0);
  assert.equal(lateOutput.listenerCount('close'), 0);
  assert.equal(lateInput.listenerCount('data'), 0);
  assert.equal(lateInput.listenerCount('end'), 0);
  assert.equal(lateInput.listenerCount('close'), 0);
  assert.equal(lateInput.listenerCount('error'), 0);
});

test('handles streams that ended or failed before the bridge attached', async () => {
  const endedInput = new PassThrough();
  endedInput.resume();
  endedInput.end();
  await new Promise((resolve) => setImmediate(resolve));

  const endedOutput = new PassThrough();
  const endedDone = runMcp({
    getCapabilities: async () => capabilities(),
    input: endedInput,
    output: endedOutput,
  });
  await endedDone;

  const closedOutput = new PassThrough();
  closedOutput.destroy();
  const closedDone = runMcp({
    getCapabilities: async () => capabilities(),
    input: new PassThrough(),
    output: closedOutput,
  });
  await assert.rejects(closedDone, /MCP stream failure/);
});

test('respects output backpressure without dropping responses', async () => {
  const input = new PassThrough();
  const output = new PassThrough({ highWaterMark: 1 });
  const done = runMcp({
    getCapabilities: async () => capabilities(),
    input,
    output,
  });

  input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  input.write('{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
  input.write('{"jsonrpc":"2.0","id":3,"method":"ping"}\n');
  await new Promise((resolve) => setImmediate(resolve));

  let text = '';
  output.setEncoding('utf8');
  output.on('data', (chunk) => {
    text += chunk;
  });
  input.end();
  await done;

  const ids = text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line).id)
    .sort();
  assert.deepEqual(ids, [1, 2, 3]);
});

test('keeps CLI help compatible', () => {
  const help = spawnSync(process.execPath, [BIN, '--help'], {
    encoding: 'utf8',
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /alpi mcp --context NAME/);
  assert.equal(help.stderr, '');

  const mcpHelp = spawnSync(process.execPath, [BIN, 'mcp', '--help'], {
    encoding: 'utf8',
  });
  assert.equal(mcpHelp.status, 0);
  assert.match(mcpHelp.stdout, /alpi mcp --context NAME/);
});

test('each stdio connection lists and calls its own tools and cancels a waiting call', async () => {
  const name = 'alpi_wait';
  const definition = { name, inputSchema: { type: 'object' } };
  const started = Promise.withResolvers();
  const calls = [];
  const tool = { definition, async run(args, signal) {
    calls.push(args);
    if (args.wait) {
      started.resolve();
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    }
    return { content: [{ type: 'text', text: 'done' }] };
  } };
  const session = createHarness(capabilities, new Map([[name, tool]]));
  const other = createHarness(capabilities);
  for (const client of [session, other]) {
    client.send(initialize());
    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  }
  assert.ok((await session.waitForId(2)).result.tools.some(entry => entry.name === name));
  assert.ok(!(await other.waitForId(2)).result.tools.some(entry => entry.name === name));
  const call = (id, args) => session.send({
    jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args },
  });
  call(3, { wait: false });
  assert.equal((await session.waitForId(3)).result.content[0].text, 'done');
  call(4, { wait: true });
  await started.promise;
  session.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 4 } });
  session.end();
  other.end();
  await Promise.all([session.done, other.done]);
  assert.deepEqual(calls, [{ wait: false }, { wait: true }]);
  assert.ok(!session.messages.some(message => message.id === 4));
});


// ---- Paired job workflow work tools (work-tools.cjs) ----

const { createJobWorkTools } = require('../src/work-tools.cjs');
const ID = '11111111-1111-4111-8111-111111111111';
const { ClientError } = require('../src/client.cjs');

function jobHarness(client) {
  const harness = createHarness(capabilities, createJobWorkTools(client));
  harness.send(initialize(80));
  harness.send({ jsonrpc: '2.0', id: 90, method: 'tools/list' });
  return harness;
}

test('advertises the paired job workflow tools and calls the shared routes', async () => {
  const calls = [];
  const client = {
    requestResource: async (name, params, body) => {
      calls.push([name, params, body]);
      if (name === 'submitJob') {
        return { jobId: ID, disposition: 'acknowledged' };
      }
      if (name === 'getEvents') {
        return { events: [{ type: 'job.submitted', seq: 1 }], nextSeq: 1,
          firstSeq: 1, lastSeq: 1, gap: false, reset: false };
      }
      return { ok: name };
    },
  };
  const harness = jobHarness(client);
  const listing = await harness.waitForId(90);
  const names = listing.result.tools.map((tool) => tool.name);
  for (const expected of ['alpi_job_submit', 'alpi_job_get', 'alpi_job_events',
    'alpi_job_lookup', 'alpi_job_outputs']) {
    assert.ok(names.includes(expected), expected + ' advertised');
  }
  const call = (id, name, args) => harness.send({
    jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args },
  });
  call(91, 'alpi_job_submit', { sandboxId: ID, engine: 'fixture', requestId: ID });
  const submit = await harness.waitForId(91);
  assert.equal(submit.result.structuredContent.disposition, 'acknowledged');
  call(92, 'alpi_job_events', { jobId: ID, after: 3, limit: 2 });
  const events = await harness.waitForId(92);
  assert.equal(events.result.structuredContent.events.length, 1);
  call(93, 'alpi_job_lookup', { requestId: ID });
  await harness.waitForId(93);
  call(94, 'alpi_job_get', { jobId: ID });
  await harness.waitForId(94);
  assert.deepEqual(calls, [
    ['submitJob', { sandboxId: ID }, { requestId: ID, engine: 'fixture' }],
    ['getEvents', { jobId: ID, after: '3' }, undefined],
    ['lookupJob', {}, { requestId: ID }],
    ['getJob', { jobId: ID }, undefined],
  ]);
  harness.end();
  await harness.done;
});

test('job tools refuse malformed arguments without touching the client', async () => {
  let touched = 0;
  const client = { requestResource: async () => { touched += 1; return {}; } };
  const harness = jobHarness(client);
  const call = (id, name, args) => harness.send({
    jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args },
  });
  call(95, 'alpi_job_submit', { sandboxId: ID, engine: 'fixture' });
  call(96, 'alpi_job_submit', { sandboxId: ID, engine: 'BAD ENGINE', requestId: ID });
  call(97, 'alpi_job_get', { jobId: 'not-a-uuid' });
  call(98, 'alpi_job_events', { jobId: ID, after: -1 });
  for (const id of [95, 96, 97, 98]) {
    const response = await harness.waitForId(id);
    assert.equal(response.result.isError, true);
    assert.equal(response.result.content[0].text, 'Invalid job tool arguments.');
  }
  assert.equal(touched, 0);
  harness.end();
  await harness.done;
});

test('job tools map client failures to short safe messages', async () => {
  const conflicts = new ClientError('HTTP_STATUS', 'Server rejected the request.', {
    statusCode: 409, resourceCode: 'engine_identity_conflict',
  });
  const expired = new ClientError('CREDENTIAL_EXPIRED', 'The client credential has expired.');
  const failures = [conflicts, expired];
  const client = {
    requestResource: async () => { throw failures.shift(); },
  };
  const harness = jobHarness(client);
  const call = (id, name, args) => harness.send({
    jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args },
  });
  call(99, 'alpi_job_submit', { sandboxId: ID, engine: 'fixture', requestId: ID });
  const refused = await harness.waitForId(99);
  assert.equal(refused.result.isError, true);
  assert.equal(refused.result.content[0].text,
    'The server refused the job request (engine_identity_conflict).');
  call(100, 'alpi_job_get', { jobId: ID });
  const credential = await harness.waitForId(100);
  assert.equal(credential.result.content[0].text, 'The client credential has expired.');
  harness.end();
  await harness.done;
});

test('job events trim a larger page without skipping the trimmed tail', async () => {
  // Stand-in for the shared route: server pages hold three events and
  // nextSeq tracks the last event of the full page, exactly like
  // publicEvents does for the packaged getEvents route.
  const stream = Array.from({ length: 7 }, (_, index) => ({
    type: 'job.log', seq: index + 1, jobId: ID, createdAt: `t${index + 1}`,
  }));
  const requests = [];
  const client = {
    requestResource: async (name, params) => {
      assert.equal(name, 'getEvents');
      const after = Number(params.after);
      const events = stream.filter((event) => event.seq > after).slice(0, 3);
      requests.push({ after, pageEvents: events.map((event) => event.seq) });
      return {
        events,
        nextSeq: events.at(-1)?.seq ?? 7,
        firstSeq: 1, lastSeq: 7, gap: false, reset: false,
      };
    },
  };
  const harness = jobHarness(client);
  const call = (id, args) => harness.send({
    jsonrpc: '2.0', id, method: 'tools/call',
    params: { name: 'alpi_job_events', arguments: args },
  });

  let cursor = 0;
  const seen = [];
  for (let id = 110; ; id += 1) {
    call(id, { jobId: ID, after: cursor, limit: 2 });
    const response = await harness.waitForId(id);
    assert.ok(!response.result.isError, response.result.content?.[0]?.text);
    const page = response.result.structuredContent;
    assert.ok(page.events.length <= 2);
    if (page.events.length === 2) {
      // A trimmed page resumes at the last event it actually returned.
      assert.equal(page.nextSeq, page.events.at(-1).seq);
    }
    seen.push(...page.events.map((event) => event.seq));
    cursor = page.nextSeq;
    if (page.events.length === 0) break;
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(cursor, 7);
  assert.deepEqual(requests.map((request) => request.after), [0, 2, 4, 6, 7]);
  harness.end();
  await harness.done;
});

test('job events pass the server page through unchanged at the trim boundaries', async () => {
  // The shared getEvents route takes no caller limit: it pages at most
  // DEFAULT_POLL_LIMIT = 100 events (work-store.cjs) and, for a non-empty
  // page, sets nextSeq to the last event it returned. The tool trims only
  // when that page exceeds the requested limit, so when limit === page and
  // at the advertised cap the server page must arrive untouched, nextSeq
  // included. Each read is an independent boundary scenario over its own
  // coherent stream.
  const log = (seq) => ({ type: 'job.log', seq, jobId: ID, createdAt: `t${seq}` });
  const scenarios = [
    {
      // Exact limit: five events remain and limit is 5, so the page
      // length equals the limit. No trim runs and the server's own
      // nextSeq (the last event it returned) is kept.
      after: 4, limit: 5,
      page: {
        events: [5, 6, 7, 8, 9].map(log),
        nextSeq: 9, firstSeq: 1, lastSeq: 9, gap: false, reset: false,
      },
    },
    {
      // Limit above page: the last two events meet a maximum limit. A
      // server page can never exceed the 100-event route bound, so no
      // trim is possible and the page passes through.
      after: 7, limit: 100,
      page: {
        events: [8, 9].map(log),
        nextSeq: 9, firstSeq: 1, lastSeq: 9, gap: false, reset: false,
      },
    },
    {
      // Limit at the cap against a full server page: the route pages at
      // 100 events, so even its own full page equals the advertised
      // maximum and the trim branch stays unreachable.
      after: 0, limit: 100,
      page: {
        events: Array.from({ length: 100 }, (_, index) => log(index + 1)),
        nextSeq: 100, firstSeq: 1, lastSeq: 105, gap: false, reset: false,
      },
    },
  ];
  const harness = jobHarness({
    requestResource: async (name, params) => {
      assert.equal(name, 'getEvents');
      const scenario = scenarios.find((entry) => entry.after === Number(params.after));
      assert.ok(scenario, 'unexpected events cursor ' + params.after);
      return scenario.page;
    },
  });
  const listing = await harness.waitForId(90);
  const eventsSchema = listing.result.tools.find(
    (tool) => tool.name === 'alpi_job_events').inputSchema.properties.limit;
  // The advertised maximum equals the server page bound, which is what
  // makes the cap boundary above airtight.
  assert.equal(eventsSchema.maximum, 100);

  const call = (id, args) => harness.send({
    jsonrpc: '2.0', id, method: 'tools/call',
    params: { name: 'alpi_job_events', arguments: args },
  });
  const callIds = [];
  let nextId = 120;
  for (const scenario of scenarios) {
    callIds.push(nextId);
    call(nextId, { jobId: ID, after: scenario.after, limit: scenario.limit });
    nextId += 1;
  }
  for (const [index, callId] of callIds.entries()) {
    const response = await harness.waitForId(callId);
    assert.ok(!response.result.isError, response.result.content?.[0]?.text);
    assert.deepEqual(response.result.structuredContent, scenarios[index].page);
  }
  harness.end();
  await harness.done;
});

test('job tools accept uppercase UUIDs like the server routes do', async () => {
  const UPPER = 'ABCDEFAB-CDEF-ABCD-EFAB-CDEFABCDEFAB';
  const calls = [];
  const client = {
    requestResource: async (name, params, body) => {
      calls.push([name, params, body]);
      return { jobId: UPPER, disposition: 'acknowledged' };
    },
  };
  const harness = jobHarness(client);
  const call = (id, name, args) => harness.send({
    jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args },
  });
  call(115, 'alpi_job_submit', { sandboxId: UPPER, engine: 'fixture', requestId: UPPER });
  const submit = await harness.waitForId(115);
  assert.ok(!submit.result.isError, submit.result.content?.[0]?.text);
  call(116, 'alpi_job_get', { jobId: UPPER });
  const got = await harness.waitForId(116);
  assert.ok(!got.result.isError, got.result.content?.[0]?.text);
  assert.deepEqual(calls, [
    ['submitJob', { sandboxId: UPPER }, { requestId: UPPER, engine: 'fixture' }],
    ['getJob', { jobId: UPPER }, undefined],
  ]);
  harness.end();
  await harness.done;
});



test('job outputs return verified bounded bytes and paginate without duplicates', async () => {
  const crypto = require('node:crypto');
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const bytes = Buffer.alloc(20000, 42);
  const row = { jobId: ID, artifactId: ID, label: 'patch', totalLength: bytes.length,
    sha256: hash(bytes), recordedAt: 1 };
  const calls = [];
  const client = { requestResource: async (name, params) => {
    calls.push([name, params]);
    if (name === 'getJobArtifacts') return { artifacts: [row, row], count: 2 };
    if (name === 'getArtifact') return { ...row, state: 'published' };
    if (name === 'readChunk') return { artifactId: ID, offset: 0, length: bytes.length,
      sha256: hash(bytes), data: bytes.toString('base64') };
    throw Error('unexpected route');
  } };
  const tool = createJobWorkTools(client).get('alpi_job_outputs');
  const first = (await tool.run({ jobId: ID })).structuredContent;
  assert.equal(first.artifacts.length, 1);
  assert.equal(first.nextOffset, 1);
  assert.equal(first.truncated, true);
  assert.deepEqual(Buffer.from(first.artifacts[0].data, 'base64'), bytes);
  assert.equal(first.artifacts[0].sha256, hash(bytes));
  const second = (await tool.run({ jobId: ID, offset: first.nextOffset })).structuredContent;
  assert.equal(second.nextOffset, 2);
  assert.equal(second.truncated, false);
  assert.deepEqual(calls.slice(0, 3), [
    ['getJobArtifacts', { jobId: ID }], ['getArtifact', { artifactId: ID }],
    ['readChunk', { artifactId: ID, offset: '0' }],
  ]);
  for (const args of [{ jobId: 'bad' }, { jobId: ID, limit: 9 },
    { jobId: ID, offset: -1 }, { jobId: ID, project: 'other' }]) {
    assert.equal((await tool.run(args)).isError, true);
  }
});

test('job output projection refuses malformed identities, sizes, metadata and corrupt chunks', async () => {
  const bytes = Buffer.from('fixture patch');
  const hash = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  const row = { jobId: ID, artifactId: ID, label: 'patch', totalLength: bytes.length,
    sha256: hash, recordedAt: 1 };
  const goodChunk = { artifactId: ID, offset: 0, length: bytes.length,
    sha256: hash, data: bytes.toString('base64') };
  const cases = [
    { list: { artifacts: [row], count: 2 } },
    { row: { ...row, jobId: '22222222-2222-4222-8222-222222222222' } },
    { row: { ...row, totalLength: 32769 } },
    { meta: { ...row, state: 'uploading' } },
    { chunk: { ...goodChunk, offset: 1 } },
    { chunk: { ...goodChunk, length: 0 } },
    { chunk: { ...goodChunk, data: Buffer.from('broken bytes!').toString('base64') } },
    { row: { ...row, sha256: '0'.repeat(64) }, meta: { ...row, state: 'published', sha256: '0'.repeat(64) } },
  ];
  for (const invalid of cases) {
    const tool = createJobWorkTools({ requestResource: async name => {
      if (name === 'getJobArtifacts') return invalid.list ?? { artifacts: [invalid.row ?? row], count: 1 };
      if (name === 'getArtifact') return invalid.meta ?? { ...row, state: 'published' };
      return invalid.chunk ?? goodChunk;
    } }).get('alpi_job_outputs');
    const result = await tool.run({ jobId: ID });
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, 'The server returned an invalid response.');
  }
});
