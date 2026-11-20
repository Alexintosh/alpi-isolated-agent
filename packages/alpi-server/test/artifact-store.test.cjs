'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const {
  openArtifactStore,
  ArtifactStoreError,
  MAX_CHUNK_BYTES,
} = require('../src/artifact-store.cjs');

const WORKSPACE = process.cwd();
const SOURCE_PATH = path.resolve(__dirname, '../src/artifact-store.cjs');

function tempDirectory(t, label) {
  const directory = fs.mkdtempSync(
    path.join(WORKSPACE, `.artifact-test-${label}-`)
  );
  fs.chmodSync(directory, 0o700);
  t.after(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function createClock(start = 1000) {
  let current = start;
  return {
    now: () => current,
    set(value) {
      current = value;
    },
    advance(ms) {
      current += ms;
    },
  };
}

function digestOf(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function chunksOf(buffer, size = MAX_CHUNK_BYTES) {
  const chunks = [];
  for (let offset = 0; offset < buffer.length; offset += size) {
    chunks.push({
      offset,
      data: buffer.subarray(offset, Math.min(offset + size, buffer.length)),
    });
  }
  return chunks;
}

function begin(store, project, buffer, requestId = crypto.randomUUID()) {
  return store.beginUpload({
    project,
    requestId,
    totalLength: buffer.length,
    sha256: digestOf(buffer),
  });
}

function upload(store, project, buffer, requestId = crypto.randomUUID()) {
  const receipt = begin(store, project, buffer, requestId);
  let current = receipt;
  for (const chunk of chunksOf(buffer)) {
    current = store.appendChunk({
      project,
      artifactId: receipt.artifactId,
      offset: chunk.offset,
      data: chunk.data.toString('base64'),
    });
  }
  return store.finishUpload({ project, artifactId: receipt.artifactId });
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof ArtifactStoreError);
    assert.equal(error.code, code);
    return true;
  });
}

function spawnBegin(storeDir, requestId, limits) {
  const script = `
    const { openArtifactStore } = require(process.argv[1]);
    const store = openArtifactStore(process.argv[2], JSON.parse(process.argv[4]));
    try {
      const receipt = store.beginUpload({
        project: 'shared',
        requestId: process.argv[3],
        totalLength: 60,
        sha256: '${'0'.repeat(64)}',
      });
      process.stdout.write('ok ' + receipt.artifactId);
    } catch (error) {
      process.stdout.write('err ' + error.code);
    } finally {
      store.close();
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['-e', script, SOURCE_PATH, storeDir, requestId, JSON.stringify(limits)],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const output = [];
    child.stdout.on('data', (chunk) => output.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`child exited ${code}`));
        return;
      }
      resolve(Buffer.concat(output).toString('utf8'));
    });
  });
}

test('lifecycle publishes, persists across restart and acknowledges', (t) => {
  const directory = tempDirectory(t, 'lifecycle');
  const clock = createClock();
  const data = crypto.randomBytes(100 * 1024 + 37);
  const requestId = crypto.randomUUID();

  let store = openArtifactStore(directory, { now: clock.now });
  const begun = begin(store, 'project-a', data, requestId);
  assert.equal(begun.state, 'uploading');
  assert.equal(begun.receivedBytes, 0);
  assert.equal(begun.totalLength, data.length);
  assert.equal(begun.sha256, digestOf(data));
  assert.equal(begun.retention, 'uploading');
  assert.equal(begun.expiresAt, clock.now() + 24 * 60 * 60 * 1000);

  // Exact retry of begin returns the same receipt.
  assert.deepEqual(begin(store, 'project-a', data, requestId), begun);

  let current = begun;
  const chunks = chunksOf(data);
  for (const chunk of chunks) {
    current = store.appendChunk({
      project: 'project-a',
      artifactId: begun.artifactId,
      offset: chunk.offset,
      data: chunk.data.toString('base64'),
    });
  }
  assert.equal(current.receivedBytes, data.length);
  assert.equal(current.chunkCount, chunks.length);

  const published = store.finishUpload({
    project: 'project-a',
    artifactId: begun.artifactId,
  });
  assert.equal(published.state, 'published');
  assert.equal(published.receivedBytes, data.length);
  assert.equal(published.retention, 'retained-until-acknowledged');
  assert.ok(published.publishedAt !== null);
  assert.equal(published.expiresAt, null);

  // Exact retry of finish returns the published receipt.
  assert.deepEqual(
    store.finishUpload({ project: 'project-a', artifactId: begun.artifactId }),
    published
  );

  for (const chunk of chunks) {
    const read = store.readChunk({
      project: 'project-a',
      artifactId: begun.artifactId,
      offset: chunk.offset,
    });
    assert.equal(read.offset, chunk.offset);
    assert.equal(read.length, chunk.data.length);
    assert.equal(read.sha256, digestOf(chunk.data));
    assert.deepEqual(Buffer.from(read.data, 'base64'), chunk.data);
  }

  store.close();

  // Restart: metadata, chunks and state remain durable.
  store = openArtifactStore(directory, { now: clock.now });
  assert.deepEqual(
    store.getArtifact({ project: 'project-a', artifactId: begun.artifactId }),
    published
  );
  assert.deepEqual(
    Buffer.from(
      store.readChunk({
        project: 'project-a',
        artifactId: begun.artifactId,
        offset: 0,
      }).data,
      'base64'
    ),
    chunks[0].data
  );

  const acknowledged = store.acknowledge({
    project: 'project-a',
    artifactId: begun.artifactId,
  });
  assert.equal(acknowledged.retention, 'acknowledged');
  assert.ok(acknowledged.acknowledgedAt !== null);
  assert.deepEqual(
    store.acknowledge({ project: 'project-a', artifactId: begun.artifactId }),
    acknowledged
  );

  const stat = fs.lstatSync(path.join(directory, 'artifacts.sqlite'));
  assert.equal(stat.mode & 0o777, 0o600);
  store.close();
});

test('begin rejects conflicting metadata and invalid input', (t) => {
  const directory = tempDirectory(t, 'begin-validation');
  const store = openArtifactStore(directory);
  t.after(() => store.close());

  const requestId = crypto.randomUUID();
  const data = Buffer.from('one');
  begin(store, 'project-a', data, requestId);

  expectCode(
    () =>
      store.beginUpload({
        project: 'project-a',
        requestId,
        totalLength: 4,
        sha256: digestOf(Buffer.from('four')),
      }),
    'conflict'
  );
  expectCode(
    () =>
      store.beginUpload({
        project: 'project-a',
        requestId,
        totalLength: 3,
        sha256: 'A'.repeat(64),
      }),
    'invalid_digest'
  );
  expectCode(
    () =>
      store.beginUpload({
        project: 'project-a',
        requestId: 'not-a-uuid',
        totalLength: 3,
        sha256: digestOf(data),
      }),
    'invalid_input'
  );
  expectCode(
    () =>
      store.beginUpload({
        project: '',
        requestId: crypto.randomUUID(),
        totalLength: 3,
        sha256: digestOf(data),
      }),
    'invalid_input'
  );
  expectCode(
    () =>
      store.beginUpload({
        project: 'project-a',
        requestId: crypto.randomUUID(),
        totalLength: 1024 * 1024 * 1024 + 1,
        sha256: digestOf(data),
      }),
    'invalid_size'
  );

  // The same request UUID in another project is independent.
  const other = begin(store, 'project-b', data, requestId);
  assert.notEqual(other.artifactId, store.listArtifacts('project-a')[0].artifactId);
});

test('append supports exact retry and rejects conflicting chunks', (t) => {
  const directory = tempDirectory(t, 'append');
  const store = openArtifactStore(directory);
  t.after(() => store.close());

  const data = crypto.randomBytes(1000);
  const receipt = begin(store, 'project-a', data);
  const first = data.subarray(0, 300);

  const appended = store.appendChunk({
    project: 'project-a',
    artifactId: receipt.artifactId,
    offset: 0,
    data: first.toString('base64'),
  });
  assert.equal(appended.receivedBytes, 300);
  assert.equal(appended.chunkCount, 1);

  // Network retry: identical bytes at the same offset are idempotent.
  assert.deepEqual(
    store.appendChunk({
      project: 'project-a',
      artifactId: receipt.artifactId,
      offset: 0,
      data: first.toString('base64'),
    }),
    appended
  );

  expectCode(
    () =>
      store.appendChunk({
        project: 'project-a',
        artifactId: receipt.artifactId,
        offset: 0,
        data: crypto.randomBytes(300).toString('base64'),
      }),
    'conflict'
  );
  expectCode(
    () =>
      store.appendChunk({
        project: 'project-a',
        artifactId: receipt.artifactId,
        offset: 301,
        data: data.subarray(301, 600).toString('base64'),
      }),
    'offset_mismatch'
  );
  expectCode(
    () =>
      store.appendChunk({
        project: 'project-a',
        artifactId: receipt.artifactId,
        offset: 901,
        data: data.subarray(900).toString('base64'),
      }),
    'invalid_offset'
  );
  expectCode(
    () =>
      store.appendChunk({
        project: 'project-a',
        artifactId: receipt.artifactId,
        offset: 300,
        data: Buffer.alloc(MAX_CHUNK_BYTES + 1).toString('base64'),
      }),
    'invalid_chunk'
  );
  expectCode(
    () =>
      store.appendChunk({
        project: 'project-a',
        artifactId: receipt.artifactId,
        offset: 300,
        data: 'not base64!!',
      }),
    'invalid_chunk'
  );
});

test('finish rejects a digest mismatch and releases quota', (t) => {
  const directory = tempDirectory(t, 'digest');
  const store = openArtifactStore(directory);
  t.after(() => store.close());

  const data = crypto.randomBytes(4096);
  const receipt = store.beginUpload({
    project: 'project-a',
    requestId: crypto.randomUUID(),
    totalLength: data.length,
    sha256: 'f'.repeat(64),
  });
  store.appendChunk({
    project: 'project-a',
    artifactId: receipt.artifactId,
    offset: 0,
    data: data.toString('base64'),
  });
  assert.equal(store.usage('project-a').projectBytes, data.length);

  expectCode(
    () =>
      store.finishUpload({
        project: 'project-a',
        artifactId: receipt.artifactId,
      }),
    'digest_mismatch'
  );

  const failed = store.getArtifact({
    project: 'project-a',
    artifactId: receipt.artifactId,
  });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.retention, 'failed');
  assert.equal(failed.chunkCount, 0);
  assert.equal(store.usage('project-a').projectBytes, 0);

  expectCode(
    () =>
      store.readChunk({
        project: 'project-a',
        artifactId: receipt.artifactId,
        offset: 0,
      }),
    'not_ready'
  );
  expectCode(
    () =>
      store.finishUpload({
        project: 'project-a',
        artifactId: receipt.artifactId,
      }),
    'artifact_failed'
  );
});

test('incomplete finish keeps the upload resumable across restart', (t) => {
  const directory = tempDirectory(t, 'incomplete');
  const clock = createClock();
  const data = crypto.randomBytes(5000);
  const requestId = crypto.randomUUID();

  let store = openArtifactStore(directory, { now: clock.now });
  const receipt = begin(store, 'project-a', data, requestId);
  store.appendChunk({
    project: 'project-a',
    artifactId: receipt.artifactId,
    offset: 0,
    data: data.subarray(0, 2500).toString('base64'),
  });

  expectCode(
    () =>
      store.finishUpload({
        project: 'project-a',
        artifactId: receipt.artifactId,
      }),
    'incomplete'
  );
  assert.equal(
    store.getArtifact({
      project: 'project-a',
      artifactId: receipt.artifactId,
    }).state,
    'uploading'
  );
  store.close();

  store = openArtifactStore(directory, { now: clock.now });
  const resumed = store.appendChunk({
    project: 'project-a',
    artifactId: receipt.artifactId,
    offset: 2500,
    data: data.subarray(2500).toString('base64'),
  });
  assert.equal(resumed.receivedBytes, data.length);
  const published = store.finishUpload({
    project: 'project-a',
    artifactId: receipt.artifactId,
  });
  assert.equal(published.state, 'published');
  store.close();
});

test('projects are isolated for every operation', (t) => {
  const directory = tempDirectory(t, 'isolation');
  const store = openArtifactStore(directory);
  t.after(() => store.close());

  const data = crypto.randomBytes(2048);
  const receipt = begin(store, 'project-a', data);

  expectCode(
    () =>
      store.getArtifact({
        project: 'project-b',
        artifactId: receipt.artifactId,
      }),
    'not_found'
  );
  expectCode(
    () =>
      store.appendChunk({
        project: 'project-b',
        artifactId: receipt.artifactId,
        offset: 0,
        data: data.subarray(0, 100).toString('base64'),
      }),
    'not_found'
  );
  expectCode(
    () =>
      store.finishUpload({
        project: 'project-b',
        artifactId: receipt.artifactId,
      }),
    'not_found'
  );
  expectCode(
    () =>
      store.acknowledge({
        project: 'project-b',
        artifactId: receipt.artifactId,
      }),
    'not_found'
  );
  expectCode(
    () =>
      store.readChunk({
        project: 'project-b',
        artifactId: receipt.artifactId,
        offset: 0,
      }),
    'not_found'
  );
  assert.deepEqual(store.listArtifacts('project-b'), []);
  assert.equal(store.usage('project-b').projectBytes, 0);
  assert.equal(store.usage('project-a').projectBytes, data.length);
});

test('per-project, global, upload and metadata quotas are enforced', (t) => {
  const directory = tempDirectory(t, 'quotas');
  const store = openArtifactStore(directory, {
    maxProjectBytes: 100,
    maxGlobalBytes: 150,
    maxUploadsPerProject: 1,
    maxArtifactsPerProject: 2,
    maxChunksPerArtifact: 3,
  });
  t.after(() => store.close());

  const zeroDigest = digestOf(Buffer.alloc(60));
  const first = store.beginUpload({
    project: 'project-a',
    requestId: crypto.randomUUID(),
    totalLength: 60,
    sha256: zeroDigest,
  });
  assert.equal(first.state, 'uploading');

  // Partial uploads reserve their declared bytes immediately.
  expectCode(
    () =>
      store.beginUpload({
        project: 'project-a',
        requestId: crypto.randomUUID(),
        totalLength: 60,
        sha256: zeroDigest,
      }),
    'quota_exceeded'
  );

  // Another project has its own reservation.
  const second = store.beginUpload({
    project: 'project-b',
    requestId: crypto.randomUUID(),
    totalLength: 60,
    sha256: zeroDigest,
  });
  assert.equal(second.state, 'uploading');

  // Global cap (120 used of 150; a third 60-byte reservation would exceed it).
  expectCode(
    () =>
      store.beginUpload({
        project: 'project-c',
        requestId: crypto.randomUUID(),
        totalLength: 60,
        sha256: zeroDigest,
      }),
    'quota_exceeded'
  );

  // Chunk row cap for a small artifact.
  const chunks = chunksOf(Buffer.alloc(12), 4);
  assert.equal(chunks.length, 3);
  store.appendChunk({
    project: 'project-b',
    artifactId: second.artifactId,
    offset: 0,
    data: chunks[0].data.toString('base64'),
  });
  store.appendChunk({
    project: 'project-b',
    artifactId: second.artifactId,
    offset: 4,
    data: chunks[1].data.toString('base64'),
  });
  store.appendChunk({
    project: 'project-b', artifactId: second.artifactId,
    offset: 8, data: chunks[2].data.toString('base64'),
  });
  expectCode(
    () =>
      store.appendChunk({
        project: 'project-b',
        artifactId: second.artifactId,
        offset: 12,
        data: chunks[2].data.toString('base64'),
      }),
    'chunk_limit'
  );

  // Complete the first reservation, then admit a second artifact.
  const small = Buffer.alloc(10);
  store.appendChunk({
    project: 'project-a',
    artifactId: first.artifactId,
    offset: 0,
    data: small.toString('base64'),
  });
  for (const chunk of chunksOf(Buffer.alloc(50), 25)) {
    store.appendChunk({
      project: 'project-a',
      artifactId: first.artifactId,
      offset: 10 + chunk.offset,
      data: chunk.data.toString('base64'),
    });
  }
  store.finishUpload({ project: 'project-a', artifactId: first.artifactId });

  const secondArtifact = store.beginUpload({
    project: 'project-a',
    requestId: crypto.randomUUID(),
    totalLength: 1,
    sha256: digestOf(Buffer.from('x')),
  });
  store.appendChunk({
    project: 'project-a',
    artifactId: secondArtifact.artifactId,
    offset: 0,
    data: Buffer.from('x').toString('base64'),
  });
  store.finishUpload({
    project: 'project-a',
    artifactId: secondArtifact.artifactId,
  });

  // Metadata cap: project-a now holds two artifact rows.
  expectCode(
    () =>
      store.beginUpload({
        project: 'project-a',
        requestId: crypto.randomUUID(),
        totalLength: 1,
        sha256: digestOf(Buffer.from('y')),
      }),
    'quota_exceeded'
  );
});

test('garbage collection reclaims only expired or retained rows', (t) => {
  const directory = tempDirectory(t, 'gc');
  const clock = createClock();
  const store = openArtifactStore(directory, {
    now: clock.now,
    uploadTtlMs: 1000,
    acknowledgedRetentionMs: 1000,
    failedRetentionMs: 1000,
  });
  t.after(() => store.close());

  const partial = begin(store, 'project-a', Buffer.from('partial'));
  const published = upload(store, 'project-a', Buffer.from('published'));
  const acknowledged = upload(store, 'project-b', Buffer.from('acknowledged'));
  store.acknowledge({
    project: 'project-b',
    artifactId: acknowledged.artifactId,
  });
  const failedData = Buffer.from('failed');
  const failed = store.beginUpload({
    project: 'project-c',
    requestId: crypto.randomUUID(),
    totalLength: failedData.length,
    sha256: 'e'.repeat(64),
  });
  store.appendChunk({
    project: 'project-c',
    artifactId: failed.artifactId,
    offset: 0,
    data: failedData.toString('base64'),
  });
  expectCode(
    () =>
      store.finishUpload({
        project: 'project-c',
        artifactId: failed.artifactId,
      }),
    'digest_mismatch'
  );

  clock.advance(1500);
  const removed = store.collectGarbage();
  assert.equal(removed.expiredUploads, 1);
  assert.equal(removed.acknowledged, 1);
  assert.equal(removed.failed, 1);
  assert.equal(removed.publishedExpired, 0);
  assert.equal(removed.releasedBytes, Buffer.byteLength('partial') + Buffer.byteLength('acknowledged'));

  expectCode(
    () =>
      store.getArtifact({
        project: 'project-a',
        artifactId: partial.artifactId,
      }),
    'not_found'
  );
  expectCode(
    () =>
      store.getArtifact({
        project: 'project-b',
        artifactId: acknowledged.artifactId,
      }),
    'not_found'
  );
  expectCode(
    () =>
      store.getArtifact({
        project: 'project-c',
        artifactId: failed.artifactId,
      }),
    'not_found'
  );

  // Published but unacknowledged content is retained.
  const retained = store.getArtifact({
    project: 'project-a',
    artifactId: published.artifactId,
  });
  assert.equal(retained.state, 'published');
  assert.equal(retained.retention, 'retained-until-acknowledged');
  assert.equal(store.usage('project-a').projectBytes, Buffer.byteLength('published'));

  // After acknowledgement and retention expiry it is reclaimable.
  store.acknowledge({
    project: 'project-a',
    artifactId: published.artifactId,
  });
  clock.advance(1500);
  const second = store.collectGarbage();
  assert.equal(second.acknowledged, 1);
  assert.equal(second.releasedBytes, Buffer.byteLength('published'));

  // The request receipt was reclaimed with the artifact; reuse is a new upload.
  const reused = begin(store, 'project-a', Buffer.from('partial'), partial.requestId);
  assert.notEqual(reused.artifactId, partial.artifactId);
});

test('chunk and artifact limits reject invalid configurations', (t) => {
  const directory = tempDirectory(t, 'limits');
  expectCode(
    () => openArtifactStore(directory, { maxProjectBytes: 0 }),
    'invalid_limit'
  );
  expectCode(
    () => openArtifactStore(directory, { maxChunksPerArtifact: -1 }),
    'invalid_limit'
  );
  expectCode(
    () => openArtifactStore(directory, { uploadTtlMs: 1.5 }),
    'invalid_limit'
  );
  const store = openArtifactStore(directory);
  t.after(() => store.close());
  assert.equal(store.usage('project-a').globalBytes, 0);
  expectCode(() => store.usage(''), 'invalid_input');
});

test('concurrent processes cannot over-admit the global byte quota', async (t) => {
  const directory = tempDirectory(t, 'concurrent');
  const limits = { maxGlobalBytes: 200 };
  const requestIds = Array.from({ length: 6 }, () => crypto.randomUUID());
  const results = await Promise.all(
    requestIds.map((requestId) => spawnBegin(directory, requestId, limits))
  );
  const accepted = results.filter((value) => value.startsWith('ok '));
  const rejected = results.filter((value) => value === 'err quota_exceeded');
  assert.equal(accepted.length, 3);
  assert.equal(rejected.length, 3);

  const store = openArtifactStore(directory, limits);
  t.after(() => store.close());
  assert.equal(store.usage('shared').globalBytes, 180);
  assert.equal(store.usage('shared').projectUploads, 3);
});

test('readChunk only serves exact published chunk offsets', (t) => {
  const directory = tempDirectory(t, 'read');
  const store = openArtifactStore(directory);
  t.after(() => store.close());

  const data = crypto.randomBytes(100);
  const receipt = begin(store, 'project-a', data);
  store.appendChunk({
    project: 'project-a',
    artifactId: receipt.artifactId,
    offset: 0,
    data: data.subarray(0, 50).toString('base64'),
  });
  expectCode(
    () =>
      store.readChunk({
        project: 'project-a',
        artifactId: receipt.artifactId,
        offset: 0,
      }),
    'not_ready'
  );
  store.appendChunk({
    project: 'project-a',
    artifactId: receipt.artifactId,
    offset: 50,
    data: data.subarray(50).toString('base64'),
  });
  store.finishUpload({ project: 'project-a', artifactId: receipt.artifactId });

  expectCode(
    () =>
      store.readChunk({
        project: 'project-a',
        artifactId: receipt.artifactId,
        offset: 25,
      }),
    'not_found'
  );
  expectCode(
    () =>
      store.readChunk({
        project: 'project-a',
        artifactId: receipt.artifactId,
        offset: 100,
      }),
    'invalid_offset'
  );
  assert.equal(
    Buffer.from(
      store.readChunk({
        project: 'project-a',
        artifactId: receipt.artifactId,
        offset: 50,
      }).data,
      'base64'
    ).length,
    50
  );
});
