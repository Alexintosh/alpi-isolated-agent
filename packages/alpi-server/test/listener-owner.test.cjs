'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { test } = require('node:test');
const { ownsLoopbackListener } = require('../src/network/listener-owner.cjs');

test('attributes the selected loopback port to the process which actually listens', {
  skip: process.platform !== 'linux' && 'Linux procfs ownership check',
}, async t => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const other = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'] });
  const done = once(other, 'exit');
  t.after(async () => { other.stdin.end(); await done; });
  await once(other, 'spawn');
  assert.equal(await ownsLoopbackListener(process.pid, port), true);
  assert.equal(await ownsLoopbackListener(other.pid, port), false);
});
