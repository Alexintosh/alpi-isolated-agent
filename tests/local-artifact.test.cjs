'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { acquireLocalArtifact } = require('../src/runtime/artifact-download.cjs');

const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const payload = Buffer.from('trusted local artifact');

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-artifact-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source');
  await fs.writeFile(source, payload);
  return { dir, source, destination: path.join(dir, 'artifact'), sha256: digest(payload), maxBytes: 1 << 20 };
}

test('copies a local artifact with progress and private modes', async t => {
  const opts = await setup(t);
  const destination = path.join(opts.dir, 'nest', 'artifact');
  const progress = [];
  await acquireLocalArtifact({ ...opts, destination, onProgress: p => progress.push(p) });
  assert.deepEqual(await fs.readFile(destination), payload);
  assert.equal((await fs.stat(destination)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.join(opts.dir, 'nest'))).mode & 0o777, 0o700);
  assert.ok(progress.length >= 1, 'progress should be reported');
  for (const p of progress) {
    assert.equal(typeof p.received, 'number');
    assert.equal(p.total, payload.length);
    assert.ok(p.received <= p.total);
  }
  assert.equal(progress[progress.length - 1].received, payload.length);
  assert.deepEqual(await fs.readdir(path.join(opts.dir, 'nest')), ['artifact']);
});

test('reuses an existing verified destination without opening the source', async t => {
  const opts = await setup(t);
  await fs.writeFile(opts.destination, payload);
  await fs.unlink(opts.source);
  await acquireLocalArtifact({ ...opts });
  assert.equal(await fs.readFile(opts.destination, 'utf8'), payload.toString());
  await assert.rejects(acquireLocalArtifact({...opts,maxBytes:2}),/maxBytes/);
});

test('leaves a destination with different bytes untouched', async t => {
  const opts = await setup(t);
  await fs.writeFile(opts.destination, 'other bytes');
  await assert.rejects(acquireLocalArtifact({ ...opts }), /mismatch/);
  assert.equal(await fs.readFile(opts.destination, 'utf8'), 'other bytes');
  assert.deepEqual((await fs.readdir(opts.dir)).sort(), ['artifact', 'source']);
});

test('rejects symlink and directory sources and a symlink destination', async t => {
  const opts = await setup(t);
  await fs.symlink(opts.source, path.join(opts.dir, 'source-link'));
  await assert.rejects(acquireLocalArtifact({ ...opts, source: path.join(opts.dir, 'source-link') }));
  await fs.mkdir(path.join(opts.dir, 'source-dir'));
  await assert.rejects(acquireLocalArtifact({ ...opts, source: path.join(opts.dir, 'source-dir') }));
  await fs.writeFile(path.join(opts.dir, 'real'), payload);
  await fs.symlink(path.join(opts.dir, 'real'), opts.destination);
  await assert.rejects(acquireLocalArtifact({ ...opts }));
  assert.equal((await fs.lstat(opts.destination)).isSymbolicLink(), true);
  assert.deepEqual((await fs.readdir(opts.dir)).sort(), ['artifact', 'real', 'source', 'source-dir', 'source-link']);
});

test('cleans up temp on digest mismatch, oversize, and abort', async t => {
  const opts = await setup(t);
  await assert.rejects(acquireLocalArtifact({ ...opts, sha256: digest('wrong') }), /mismatch/);
  assert.deepEqual(await fs.readdir(opts.dir), ['source']);

  await assert.rejects(acquireLocalArtifact({ ...opts, maxBytes: 2 }), /maxBytes/);
  assert.deepEqual(await fs.readdir(opts.dir), ['source']);

  const big = Buffer.alloc(1 << 20, 0x61);
  await fs.writeFile(opts.source, big);
  const controller = new AbortController();
  await assert.rejects(acquireLocalArtifact({
    ...opts,
    sha256: digest(big),
    signal: controller.signal,
    onProgress() { controller.abort(); },
  }), { name: 'AbortError' });
  assert.deepEqual(await fs.readdir(opts.dir), ['source']);
});

test('never replaces a destination created while the copy is in progress', async t => {
  const opts = await setup(t);
  const big = Buffer.alloc(4 << 20, 0x62);
  await fs.writeFile(opts.source, big);
  let raced = false;
  await assert.rejects(acquireLocalArtifact({
    ...opts,
    sha256: digest(big),
    maxBytes: 8 << 20,
    onProgress() {
      if (!raced) { raced = true; fsSync.writeFileSync(opts.destination, 'concurrent owner'); }
    },
  }), { code: 'EEXIST' });
  assert.equal(raced, true);
  assert.equal(await fs.readFile(opts.destination, 'utf8'), 'concurrent owner');
  assert.deepEqual(await fs.readdir(opts.dir), ['artifact', 'source']);
});
