'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { PassThrough } = require('node:stream');
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

function createHarness(getCapabilities) {
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

  const done = runMcp({ getCapabilities, input, output });

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
