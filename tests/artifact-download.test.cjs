'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { acquireArtifact } = require('../src/runtime/artifact-download.cjs');

const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const payload = Buffer.from('trusted artifact');
async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, destination: path.join(dir, 'artifact'), url: 'https://example.test/a', sha256: digest(payload), maxBytes: 1024 };
}
const okFetch = async () => new Response(payload);

test('downloads verified bytes privately and reuses an existing verified file', async t => {
  const opts = await setup(t);
  await acquireArtifact({ ...opts, fetch: okFetch });
  assert.deepEqual(await fs.readFile(opts.destination), payload);
  assert.equal((await fs.stat(opts.destination)).mode & 0o777, 0o600);
  await acquireArtifact({ ...opts, fetch: () => { throw new Error('unexpected fetch'); } });
  await fs.writeFile(opts.destination, 'corrupt');
  await assert.rejects(acquireArtifact({ ...opts, fetch: okFetch }), /mismatch/);
  assert.equal(await fs.readFile(opts.destination, 'utf8'), 'corrupt');
});

test('removes temporary file on digest mismatch', async t => {
  const opts = await setup(t);
  await assert.rejects(acquireArtifact({ ...opts, sha256: digest('wrong'), fetch: okFetch }), /mismatch/);
  assert.deepEqual(await fs.readdir(opts.dir), []);
});

test('cleans up when canceled during streaming', async t => {
  const opts = await setup(t);
  const controller = new AbortController();
  const stream = new ReadableStream({ start(c) { c.enqueue(payload); } });
  await assert.rejects(acquireArtifact({ ...opts, signal: controller.signal, fetch: async () => new Response(stream), onProgress() { controller.abort(); } }), { name: 'AbortError' });
  assert.deepEqual(await fs.readdir(opts.dir), []);
});

test('rejects streaming data larger than maxBytes', async t => {
  const opts = await setup(t);
  await assert.rejects(acquireArtifact({ ...opts, maxBytes: 2, fetch: okFetch }), /maxBytes/);
  assert.deepEqual(await fs.readdir(opts.dir), []);
});

test('rejects a symlink destination', async t => {
  const opts = await setup(t);
  await fs.writeFile(path.join(opts.dir, 'target'), payload);
  await fs.symlink(path.join(opts.dir, 'target'), opts.destination);
  await assert.rejects(acquireArtifact({ ...opts, fetch: okFetch }));
  assert.equal((await fs.lstat(opts.destination)).isSymbolicLink(), true);
});

test('never replaces a destination created while the download is in progress', async t => {
  const opts = await setup(t);
  await assert.rejects(acquireArtifact({...opts, fetch:async () => {
    await fs.writeFile(opts.destination, 'concurrent owner');
    return new Response(payload);
  }}), {code:'EEXIST'});
  assert.equal(await fs.readFile(opts.destination,'utf8'), 'concurrent owner');
  assert.deepEqual(await fs.readdir(opts.dir), ['artifact']);
});

test('validates redirects, limits hops and sends no authorization', async t => {
  const opts = await setup(t);
  const calls = [];
  await acquireArtifact({ ...opts, fetch: async (url, init) => {
    calls.push({ url, init });
    return calls.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://other.test/a' } }) : new Response(payload);
  } });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://other.test/a');
  assert.equal(calls[1].init.redirect, 'manual');
  assert.equal(calls[1].init.headers, undefined);
  await fs.unlink(opts.destination);
  await assert.rejects(acquireArtifact({ ...opts, fetch: async () => new Response(null, { status: 302, headers: { location: 'http://other.test/a' } }) }), /HTTPS/);
  let count = 0;
  await assert.rejects(acquireArtifact({ ...opts, fetch: async () => { count++; return new Response(null, { status: 302, headers: { location: '/again' } }); } }), /redirect/);
  assert.equal(count, 4);
  assert.deepEqual(await fs.readdir(opts.dir), []);
});
