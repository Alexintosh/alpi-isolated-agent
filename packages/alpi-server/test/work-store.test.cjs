'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const {
  openWorkStore,
  WorkStoreError,
  DEFAULT_LIMITS,
} = require('../src/work-store.cjs');

const WORKSPACE = process.cwd();
const SOURCE_PATH = path.resolve(__dirname, '../src/work-store.cjs');
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALPHA_OPERATOR = {
  clientId: 'client-alpha-operator',
  project: 'alpha',
  role: 'operator',
};
const ALPHA_RUNNER = {
  clientId: 'client-alpha-runner',
  project: 'alpha',
  role: 'runner',
};
const ALPHA_OBSERVER = {
  clientId: 'client-alpha-observer',
  project: 'alpha',
  role: 'observer',
};
const BETA_OPERATOR = {
  clientId: 'client-beta-operator',
  project: 'beta',
  role: 'operator',
};

function tempDirectory(t, label) {
  const directory = fs.mkdtempSync(
    path.join(WORKSPACE, `.work-test-${label}-`)
  );
  fs.chmodSync(directory, 0o700);
  t.after(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function createClock(start) {
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

function assertCode(expectedCode) {
  return (error) => {
    assert.ok(error instanceof WorkStoreError);
    assert.equal(error.code, expectedCode);
    return true;
  };
}

function baseReservation(overrides = {}) {
  return {
    requestId: 'request-1',
    engine: 'boxlite',
    engineVersion: '0.14.1',
    profile: 'pi-dev',
    imageDigest: 'sha256:0123456789abcdef',
    resources: { vcpus: 1, memoryMiB: 512, diskMiB: 100 },
    retention: 'ephemeral',
    ...overrides,
  };
}

function reserve(store, principal, overrides = {}) {
  return store.reserveSandbox(principal, baseReservation(overrides));
}

function runNode(workerCode, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', workerCode, ...args], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', () => resolve({ code: -1, stdout }));
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

test('private state, stable receipts and reopen across connections', (t) => {
  const directory = tempDirectory(t, 'reopen');
  const first = openWorkStore(directory);
  const second = openWorkStore(directory);
  t.after(() => {
    first.close();
    second.close();
  });

  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.equal(
    fs.statSync(path.join(directory, 'work.sqlite')).mode & 0o777,
    0o600
  );

  const receipt = reserve(first, ALPHA_OPERATOR);
  assert.match(receipt.sandboxId, UUID_PATTERN);
  assert.match(receipt.workspaceId, UUID_PATTERN);
  assert.equal(receipt.project, 'alpha');
  assert.equal(receipt.ownerClientId, ALPHA_OPERATOR.clientId);
  assert.equal(receipt.ownerMarker, ALPHA_OPERATOR.clientId);
  assert.equal(receipt.generation, 1);
  assert.equal(receipt.desiredState, 'running');
  assert.equal(receipt.observedState, 'unknown');
  assert.equal(receipt.nativeId, null);
  assert.deepEqual(receipt.resources, {
    vcpus: 1,
    memoryMiB: 512,
    diskMiB: 100,
  });

  const fromSecond = second.getSandbox(
    ALPHA_OPERATOR,
    receipt.sandboxId
  );
  assert.deepEqual(fromSecond, receipt);
  assert.equal(second.listSandboxes(ALPHA_OPERATOR).length, 1);

  first.close();
  const reopened = openWorkStore(directory);
  t.after(() => reopened.close());
  assert.deepEqual(
    reopened.getSandbox(ALPHA_OPERATOR, receipt.sandboxId),
    receipt
  );

  reopened.close();
  reopened.close();
  assert.throws(
    () => reopened.listSandboxes(ALPHA_OPERATOR),
    assertCode('store_closed')
  );
});

test('reserve validates input, denies observers and enforces generations', (t) => {
  const directory = tempDirectory(t, 'generation');
  const clock = createClock(1_000_000);
  const store = openWorkStore(directory, { now: clock.now });
  t.after(() => store.close());

  assert.throws(
    () => reserve(store, ALPHA_OBSERVER),
    assertCode('forbidden')
  );
  assert.throws(
    () =>
      store.reserveSandbox(ALPHA_OPERATOR, {
        ...baseReservation(),
        resources: { vcpus: 0, memoryMiB: 512, diskMiB: 100 },
      }),
    assertCode('invalid_input')
  );
  assert.throws(
    () =>
      store.reserveSandbox(ALPHA_OPERATOR, {
        ...baseReservation(),
        retention: 'forever',
      }),
    assertCode('invalid_input')
  );
  assert.throws(
    () =>
      store.reserveSandbox(ALPHA_OPERATOR, {
        ...baseReservation(),
        retention: 'ttl',
      }),
    assertCode('invalid_input')
  );

  const receipt = reserve(store, ALPHA_OPERATOR, {
    retention: 'ttl',
    ttlSeconds: 120,
  });
  assert.equal(receipt.retention, 'ttl');
  assert.equal(receipt.ttlSeconds, 120);
  assert.equal(receipt.expiresAt, 1_000_000 + 120_000);

  assert.deepEqual(
    store.getSandbox(ALPHA_OBSERVER, receipt.sandboxId),
    receipt
  );

  assert.throws(
    () =>
      store.attachEngine(ALPHA_RUNNER, {
        sandboxId: receipt.sandboxId,
        nativeId: 'box-123',
        generation: 99,
      }),
    assertCode('generation_conflict')
  );

  const attached = store.attachEngine(ALPHA_RUNNER, {
    sandboxId: receipt.sandboxId,
    nativeId: 'box-123',
    generation: 1,
  });
  assert.equal(attached.nativeId, 'box-123');
  assert.equal(attached.observedState, 'running');
  assert.equal(attached.generation, 2);

  assert.throws(
    () =>
      store.recordObserved(ALPHA_RUNNER, {
        sandboxId: receipt.sandboxId,
        generation: 1,
        observedState: 'stopped',
      }),
    assertCode('generation_conflict')
  );

  const observed = store.recordObserved(ALPHA_RUNNER, {
    sandboxId: receipt.sandboxId,
    generation: 2,
    observedState: 'stopped',
  });
  assert.equal(observed.observedState, 'stopped');
  assert.equal(observed.stoppedAt, 1_000_000);
  assert.equal(observed.generation, 3);

  const stopped = store.stopSandbox(ALPHA_RUNNER, {
    sandboxId: receipt.sandboxId,
    generation: 3,
  });
  assert.equal(stopped.desiredState, 'stopped');
  assert.equal(stopped.generation, 4);

  assert.throws(
    () => store.stopSandbox(ALPHA_OBSERVER, {
      sandboxId: receipt.sandboxId,
    }),
    assertCode('forbidden')
  );
});

test('lost reply replay is stable and changed payloads conflict', (t) => {
  const directory = tempDirectory(t, 'idempotency');
  const store = openWorkStore(directory);
  t.after(() => store.close());

  const first = reserve(store, ALPHA_OPERATOR, { requestId: 'lost-1' });
  const replay = reserve(store, ALPHA_OPERATOR, { requestId: 'lost-1' });
  assert.equal(replay.sandboxId, first.sandboxId);
  assert.equal(replay.workspaceId, first.workspaceId);
  assert.equal(store.listSandboxes(ALPHA_OPERATOR).length, 1);

  assert.throws(
    () =>
      reserve(store, ALPHA_OPERATOR, {
        requestId: 'lost-1',
        resources: { vcpus: 2, memoryMiB: 512, diskMiB: 100 },
      }),
    assertCode('idempotency_conflict')
  );

  const otherClient = {
    ...ALPHA_RUNNER,
    clientId: 'client-alpha-runner-2',
  };
  const other = reserve(store, otherClient, { requestId: 'lost-1' });
  assert.notEqual(other.sandboxId, first.sandboxId);

  const workspaceId = first.workspaceId;
  const job = store.submitJob(ALPHA_RUNNER, {
    requestId: 'job-lost-1',
    workspaceId,
    payload: { prompt: 'hello', options: { temperature: 0 } },
  });
  assert.match(job.jobId, UUID_PATTERN);
  assert.match(job.sessionUuid, UUID_PATTERN);
  assert.equal(job.disposition, 'acknowledged');

  const jobReplay = store.submitJob(ALPHA_RUNNER, {
    requestId: 'job-lost-1',
    workspaceId,
    payload: { options: { temperature: 0 }, prompt: 'hello' },
  });
  assert.equal(jobReplay.jobId, job.jobId);
  assert.equal(jobReplay.sessionUuid, job.sessionUuid);
  assert.equal(store.listJobs(ALPHA_RUNNER).length, 1);

  assert.throws(
    () =>
      store.submitJob(ALPHA_RUNNER, {
        requestId: 'job-lost-1',
        workspaceId,
        payload: { prompt: 'different' },
      }),
    assertCode('idempotency_conflict')
  );

  store.close();
  const reopened = openWorkStore(directory);
  t.after(() => reopened.close());
  assert.equal(
    reopened.submitJob(ALPHA_RUNNER, {
      requestId: 'job-lost-1',
      workspaceId,
      payload: { prompt: 'hello', options: { temperature: 0 } },
    }).jobId,
    job.jobId
  );
  assert.equal(
    reserve(reopened, ALPHA_OPERATOR, { requestId: 'lost-1' }).sandboxId,
    first.sandboxId
  );
});

test('host quotas are atomic and global across projects', (t) => {
  const directory = tempDirectory(t, 'quota');
  const store = openWorkStore(directory, {
    limits: { vcpus: 4, memoryMiB: 4096, diskMiB: 1000 },
  });
  const peer = openWorkStore(directory, {
    limits: { vcpus: 4, memoryMiB: 4096, diskMiB: 1000 },
  });
  t.after(() => {
    store.close();
    peer.close();
  });

  const alpha = reserve(store, ALPHA_OPERATOR, {
    requestId: 'alpha-1',
    resources: { vcpus: 2, memoryMiB: 2048, diskMiB: 400 },
  });
  const beta = reserve(peer, BETA_OPERATOR, {
    requestId: 'beta-1',
    resources: { vcpus: 2, memoryMiB: 2048, diskMiB: 400 },
  });

  assert.throws(
    () =>
      reserve(store, ALPHA_OPERATOR, {
        requestId: 'alpha-2',
        resources: { vcpus: 1, memoryMiB: 1, diskMiB: 1 },
      }),
    assertCode('quota_exceeded')
  );

  assert.throws(
    () =>
      reserve(store, ALPHA_OPERATOR, {
        requestId: 'alpha-too-big',
        resources: { vcpus: 5, memoryMiB: 1, diskMiB: 1 },
      }),
    assertCode('quota_exceeded')
  );

  store.stopSandbox(ALPHA_OPERATOR, { sandboxId: alpha.sandboxId });
  assert.throws(
    () =>
      reserve(store, ALPHA_OPERATOR, {
        requestId: 'alpha-3',
        resources: { vcpus: 1, memoryMiB: 1, diskMiB: 1 },
      }),
    assertCode('quota_exceeded')
  );

  store.recordObserved(ALPHA_OPERATOR, { sandboxId: alpha.sandboxId,
    generation: store.getSandbox(ALPHA_OPERATOR, alpha.sandboxId).generation, observedState: 'removed' });
  store.discardSandbox(ALPHA_OPERATOR, {
    sandboxId: alpha.sandboxId,
    reason: 'quota release test',
  });

  const replacement = reserve(peer, ALPHA_OPERATOR, {
    requestId: 'alpha-3',
    resources: { vcpus: 2, memoryMiB: 2048, diskMiB: 400 },
  });
  assert.equal(replacement.project, 'alpha');

  assert.throws(
    () =>
      reserve(store, BETA_OPERATOR, {
        requestId: 'beta-2',
        resources: { vcpus: 1, memoryMiB: 1, diskMiB: 1 },
      }),
    assertCode('quota_exceeded')
  );
  assert.equal(beta.project, 'beta');
  assert.equal(DEFAULT_LIMITS.vcpus, 8);
});

test('cross-project identifiers are indistinguishable from missing', (t) => {
  const directory = tempDirectory(t, 'cross-project');
  const store = openWorkStore(directory);
  t.after(() => store.close());

  const sandbox = reserve(store, ALPHA_OPERATOR);
  const job = store.submitJob(ALPHA_RUNNER, {
    requestId: 'alpha-job',
    workspaceId: sandbox.workspaceId,
    payload: { prompt: 'secret' },
  });
  store.appendEvent(ALPHA_RUNNER, {
    type: 'job.started',
    jobId: job.jobId,
    data: { private: true },
  });

  assert.deepEqual(store.listSandboxes(BETA_OPERATOR), []);
  assert.deepEqual(store.listJobs(BETA_OPERATOR), []);
  assert.deepEqual(store.listPendingRecovery(BETA_OPERATOR), {
    sandboxes: [],
    jobs: [],
  });
  assert.equal(
    store.pollEvents(BETA_OPERATOR, { afterSeq: 0 }).events.length,
    0
  );

  assert.throws(
    () => store.getSandbox(BETA_OPERATOR, sandbox.sandboxId),
    assertCode('not_found')
  );
  assert.throws(
    () => store.getJob(BETA_OPERATOR, job.jobId),
    assertCode('not_found')
  );
  assert.throws(
    () =>
      store.attachEngine(BETA_OPERATOR, {
        sandboxId: sandbox.sandboxId,
        nativeId: 'stolen',
        generation: 1,
      }),
    assertCode('not_found')
  );
  assert.throws(
    () =>
      store.stopSandbox(BETA_OPERATOR, {
        sandboxId: sandbox.sandboxId,
      }),
    assertCode('not_found')
  );
  assert.throws(
    () =>
      store.discardSandbox(BETA_OPERATOR, {
        sandboxId: sandbox.sandboxId,
      }),
    assertCode('not_found')
  );
  assert.throws(
    () =>
      store.submitJob(BETA_OPERATOR, {
        requestId: 'beta-job',
        workspaceId: sandbox.workspaceId,
      }),
    assertCode('not_found')
  );
  assert.throws(
    () =>
      store.acquireLease(BETA_OPERATOR, {
        workspaceId: sandbox.workspaceId,
      }),
    assertCode('not_found')
  );
  assert.throws(
    () =>
      store.markJob(BETA_OPERATOR, {
        jobId: job.jobId,
        disposition: 'completed',
      }),
    assertCode('not_found')
  );

  assert.equal(store.listSandboxes(ALPHA_OPERATOR).length, 1);
});

test('pending recovery enumerates unsettled sandboxes and jobs', (t) => {
  const directory = tempDirectory(t, 'recovery');
  const store = openWorkStore(directory);
  t.after(() => store.close());

  const sandbox = reserve(store, ALPHA_OPERATOR);
  const job = store.submitJob(ALPHA_RUNNER, {
    requestId: 'recovery-job',
    workspaceId: sandbox.workspaceId,
  });

  let pending = store.listPendingRecovery(ALPHA_OPERATOR);
  assert.equal(pending.sandboxes.length, 1);
  assert.equal(pending.jobs.length, 1);
  assert.equal(pending.jobs[0].jobId, job.jobId);

  const attached = store.attachEngine(ALPHA_RUNNER, {
    sandboxId: sandbox.sandboxId,
    nativeId: 'native-1',
    generation: 1,
  });
  assert.equal(
    store.listPendingRecovery(ALPHA_OPERATOR).sandboxes.length,
    0
  );

  store.stopSandbox(ALPHA_RUNNER, {
    sandboxId: sandbox.sandboxId,
    generation: attached.generation,
  });
  pending = store.listPendingRecovery(ALPHA_OPERATOR);
  assert.equal(pending.sandboxes.length, 1);
  assert.equal(pending.sandboxes[0].desiredState, 'stopped');
  assert.equal(pending.sandboxes[0].observedState, 'running');

  store.recordObserved(ALPHA_RUNNER, {
    sandboxId: sandbox.sandboxId,
    generation: pending.sandboxes[0].generation,
    observedState: 'stopped',
  });
  assert.equal(
    store.listPendingRecovery(ALPHA_OPERATOR).sandboxes.length,
    0
  );

  store.markJob(ALPHA_RUNNER, {
    jobId: job.jobId,
    disposition: 'uncertain',
    detail: { reason: 'reply lost' },
  });
  assert.equal(
    store.listPendingRecovery(ALPHA_OPERATOR).jobs.length,
    1
  );
  store.markJob(ALPHA_RUNNER, {
    jobId: job.jobId,
    disposition: 'completed',
    detail: { digest: 'sha256:result' },
  });
  assert.equal(
    store.listPendingRecovery(ALPHA_OPERATOR).jobs.length,
    0
  );
});

test('two jobs on different workspaces are independent', (t) => {
  const directory = tempDirectory(t, 'two-jobs');
  const store = openWorkStore(directory);
  t.after(() => store.close());

  const firstSandbox = reserve(store, ALPHA_OPERATOR, {
    requestId: 'ws-1',
  });
  const secondSandbox = reserve(store, ALPHA_OPERATOR, {
    requestId: 'ws-2',
  });

  const firstJob = store.submitJob(ALPHA_RUNNER, {
    requestId: 'job-1',
    workspaceId: firstSandbox.workspaceId,
    payload: { prompt: 'one' },
  });
  const secondJob = store.submitJob(ALPHA_RUNNER, {
    requestId: 'job-2',
    workspaceId: secondSandbox.workspaceId,
    payload: { prompt: 'two' },
  });

  assert.notEqual(firstJob.jobId, secondJob.jobId);
  assert.notEqual(firstJob.sessionUuid, secondJob.sessionUuid);
  assert.equal(firstJob.workspaceId, firstSandbox.workspaceId);
  assert.equal(secondJob.workspaceId, secondSandbox.workspaceId);
  assert.equal(store.listJobs(ALPHA_RUNNER).length, 2);

  store.markJob(ALPHA_RUNNER, {
    jobId: firstJob.jobId,
    disposition: 'completed',
  });
  store.markJob(ALPHA_RUNNER, {
    jobId: secondJob.jobId,
    disposition: 'uncertain',
  });

  assert.equal(
    store.getJob(ALPHA_RUNNER, firstJob.jobId).disposition,
    'completed'
  );
  assert.equal(
    store.getJob(ALPHA_RUNNER, secondJob.jobId).disposition,
    'uncertain'
  );
  assert.deepEqual(
    store.getJob(ALPHA_RUNNER, firstJob.jobId).payload,
    { prompt: 'one' }
  );
});

test('job dispositions enforce strict transitions and never resend uncertain', (t) => {
  const directory = tempDirectory(t, 'transitions');
  const store = openWorkStore(directory);
  t.after(() => store.close());

  const sandbox = reserve(store, ALPHA_OPERATOR);
  const job = store.submitJob(ALPHA_RUNNER, {
    requestId: 'transition-job',
    workspaceId: sandbox.workspaceId,
  });

  const uncertain = store.markJob(ALPHA_RUNNER, {
    jobId: job.jobId,
    disposition: 'uncertain',
  });
  assert.equal(uncertain.disposition, 'uncertain');

  assert.throws(
    () =>
      store.markJob(ALPHA_RUNNER, {
        jobId: job.jobId,
        disposition: 'acknowledged',
      }),
    assertCode('invalid_transition')
  );

  store.markJob(ALPHA_RUNNER, {
    jobId: job.jobId,
    disposition: 'cancelRequested',
  });
  const cancelled = store.markJob(ALPHA_RUNNER, {
    jobId: job.jobId,
    disposition: 'cancelled',
  });
  assert.equal(cancelled.disposition, 'cancelled');

  assert.throws(
    () =>
      store.markJob(ALPHA_RUNNER, {
        jobId: job.jobId,
        disposition: 'completed',
      }),
    assertCode('invalid_transition')
  );

  assert.throws(
    () =>
      store.markJob(ALPHA_OBSERVER, {
        jobId: job.jobId,
        disposition: 'failed',
      }),
    assertCode('forbidden')
  );

  assert.throws(
    () =>
      store.markJob(ALPHA_RUNNER, {
        jobId: job.jobId,
        disposition: 'running',
      }),
    assertCode('invalid_input')
  );
});

test('event replay reports gaps and reset semantics', (t) => {
  const directory = tempDirectory(t, 'events');
  const clock = createClock(5_000);
  const store = openWorkStore(directory, {
    now: clock.now,
    maxEvents: 3,
  });
  t.after(() => store.close());

  const sandbox = reserve(store, ALPHA_OPERATOR);
  for (let index = 1; index <= 5; index += 1) {
    clock.advance(10);
    const appended = store.appendEvent(ALPHA_RUNNER, {
      type: 'job.output',
      sandboxId: sandbox.sandboxId,
      cursor: `cursor-${index}`,
      data: { chunk: index },
    });
    assert.equal(appended.seq, index);
  }

  const all = store.pollEvents(ALPHA_OPERATOR, { afterSeq: 0 });
  assert.equal(all.gap, true);
  assert.equal(all.reset, false);
  assert.equal(all.firstSeq, 3);
  assert.equal(all.lastSeq, 5);
  assert.deepEqual(
    all.events.map((event) => event.seq),
    [3, 4, 5]
  );
  assert.equal(all.events[2].cursor, 'cursor-5');
  assert.deepEqual(all.events[2].data, { chunk: 5 });
  assert.equal(all.nextSeq, 5);

  const contiguous = store.pollEvents(ALPHA_OPERATOR, { afterSeq: 2 });
  assert.equal(contiguous.gap, false);
  assert.deepEqual(
    contiguous.events.map((event) => event.seq),
    [3, 4, 5]
  );

  const limited = store.pollEvents(ALPHA_OPERATOR, {
    afterSeq: 0,
    limit: 1,
  });
  assert.equal(limited.gap, true);
  assert.deepEqual(limited.events.map((event) => event.seq), [3]);
  assert.equal(limited.nextSeq, 3);

  const reset = store.pollEvents(ALPHA_OPERATOR, { afterSeq: 99 });
  assert.equal(reset.reset, true);
  assert.equal(reset.gap, false);
  assert.deepEqual(
    reset.events.map((event) => event.seq),
    [3, 4, 5]
  );
  assert.equal(reset.nextSeq, 5);

  const empty = store.pollEvents(BETA_OPERATOR, { afterSeq: 0 });
  assert.deepEqual(empty, {
    events: [],
    nextSeq: 0,
    firstSeq: 1,
    lastSeq: 0,
    gap: false,
    reset: false,
  });

  assert.throws(
    () => store.pollEvents(ALPHA_OPERATOR, { afterSeq: -1 }),
    assertCode('invalid_input')
  );
  assert.throws(
    () => store.pollEvents(ALPHA_OPERATOR, { limit: 4 }),
    assertCode('invalid_input')
  );
  assert.throws(
    () => store.appendEvent(ALPHA_OBSERVER, { type: 'ignored' }),
    assertCode('forbidden')
  );
});

test('lease epochs fence writes and survive restart', (t) => {
  const directory = tempDirectory(t, 'lease');
  const clock = createClock(10_000);
  let store = openWorkStore(directory, { now: clock.now });
  t.after(() => {
    if (store) {
      store.close();
    }
  });

  const first = reserve(store, ALPHA_OPERATOR, { requestId: 'lease-1' });
  const second = reserve(store, ALPHA_OPERATOR, { requestId: 'lease-2' });

  const leaseA = store.acquireLease(ALPHA_RUNNER, {
    workspaceId: first.workspaceId,
    holder: 'worker-a',
    ttlSeconds: 30,
  });
  assert.equal(leaseA.epoch, 1);
  assert.equal(leaseA.holder, 'worker-a');
  assert.equal(leaseA.active, true);
  for (const action of ['validateLease', 'renewLease', 'releaseLease']) {
    assert.throws(() => store[action](ALPHA_OPERATOR, {
      workspaceId: first.workspaceId, epoch: leaseA.epoch,
    }), assertCode('forbidden'));
  }

  assert.throws(
    () =>
      store.acquireLease(ALPHA_RUNNER, {
        workspaceId: first.workspaceId,
        holder: 'worker-b',
      }),
    assertCode('lease_held')
  );

  assert.deepEqual(
    store.validateLease(ALPHA_RUNNER, {
      workspaceId: first.workspaceId,
      epoch: 1,
    }),
    {
      workspaceId: first.workspaceId,
      epoch: 1,
      holder: 'worker-a',
      expiresAt: 40_000,
      valid: true,
    }
  );

  const other = store.acquireLease(ALPHA_RUNNER, {
    workspaceId: second.workspaceId,
    holder: 'worker-b',
    ttlSeconds: 30,
  });
  assert.equal(other.epoch, 1);
  assert.equal(
    store.validateLease(ALPHA_RUNNER, {
      workspaceId: second.workspaceId,
      epoch: 1,
    }).valid,
    true
  );

  store.releaseLease(ALPHA_RUNNER, {
    workspaceId: first.workspaceId,
    epoch: 1,
  });
  assert.throws(
    () =>
      store.validateLease(ALPHA_RUNNER, {
        workspaceId: first.workspaceId,
        epoch: 1,
      }),
    assertCode('lease_missing')
  );

  const leaseB = store.acquireLease(ALPHA_RUNNER, {
    workspaceId: first.workspaceId,
    holder: 'worker-b',
    ttlSeconds: 30,
  });
  assert.equal(leaseB.epoch, 2);
  assert.throws(
    () =>
      store.validateLease(ALPHA_RUNNER, {
        workspaceId: first.workspaceId,
        epoch: 1,
      }),
    assertCode('lease_stale')
  );

  clock.advance(31_000);
  assert.throws(
    () =>
      store.validateLease(ALPHA_RUNNER, {
        workspaceId: first.workspaceId,
        epoch: 2,
      }),
    assertCode('lease_expired')
  );
  const leaseC = store.acquireLease(ALPHA_RUNNER, {
    workspaceId: first.workspaceId,
    holder: 'worker-c',
    ttlSeconds: 30,
  });
  assert.equal(leaseC.epoch, 3);

  store.close();
  store = openWorkStore(directory, { now: clock.now });
  store.releaseLease(ALPHA_RUNNER, {
    workspaceId: first.workspaceId,
    epoch: 3,
  });
  const leaseD = store.acquireLease(ALPHA_RUNNER, {
    workspaceId: first.workspaceId,
    holder: 'worker-d',
    ttlSeconds: 30,
  });
  assert.equal(leaseD.epoch, 4);

  assert.throws(
    () =>
      store.validateLease(ALPHA_OBSERVER, {
        workspaceId: first.workspaceId,
        epoch: 4,
      }),
    assertCode('forbidden')
  );
});

test('retention and export protect disposal', (t) => {
  const directory = tempDirectory(t, 'disposal');
  const store = openWorkStore(directory);
  t.after(() => store.close());

  const retained = reserve(store, ALPHA_OPERATOR, {
    requestId: 'retained',
    retention: 'until-export',
  });
  store.stopSandbox(ALPHA_RUNNER, {
    sandboxId: retained.sandboxId,
  });

  assert.throws(
    () =>
      store.deleteSandbox(ALPHA_OPERATOR, {
        sandboxId: retained.sandboxId,
      }),
    assertCode('export_required')
  );
  assert.throws(
    () =>
      store.deleteSandbox(ALPHA_RUNNER, {
        sandboxId: retained.sandboxId,
      }),
    assertCode('forbidden')
  );

  const exported = store.acknowledgeExport(ALPHA_RUNNER, {
    sandboxId: retained.sandboxId,
    digest: 'sha256:exported-tree',
  });
  assert.equal(exported.exportDigest, 'sha256:exported-tree');
  assert.equal(exported.exportedAt, exported.updatedAt);

  store.recordObserved(ALPHA_OPERATOR, { sandboxId: retained.sandboxId,
    generation: store.getSandbox(ALPHA_OPERATOR, retained.sandboxId).generation, observedState: 'removed' });
  const deleted = store.deleteSandbox(ALPHA_OPERATOR, {
    sandboxId: retained.sandboxId,
  });
  assert.notEqual(deleted.deletedAt, null);
  assert.equal(deleted.deletedReason, 'deleted');
  assert.deepEqual(store.deleteSandbox(ALPHA_OPERATOR, { sandboxId: retained.sandboxId }), deleted);
  assert.equal(store.listSandboxes(ALPHA_OPERATOR).length, 0);

  const running = reserve(store, ALPHA_OPERATOR, {
    requestId: 'running-delete',
  });
  assert.throws(
    () =>
      store.deleteSandbox(ALPHA_OPERATOR, {
        sandboxId: running.sandboxId,
      }),
    assertCode('invalid_transition')
  );

  const discarded = reserve(store, ALPHA_OPERATOR, {
    requestId: 'discard-me',
    retention: 'until-export',
  });
  store.stopSandbox(ALPHA_RUNNER, {
    sandboxId: discarded.sandboxId,
  });
  assert.throws(
    () =>
      store.discardSandbox(ALPHA_RUNNER, {
        sandboxId: discarded.sandboxId,
      }),
    assertCode('forbidden')
  );
  assert.throws(
    () =>
      store.discardSandbox(ALPHA_OBSERVER, {
        sandboxId: discarded.sandboxId,
      }),
    assertCode('forbidden')
  );
  store.recordObserved(ALPHA_OPERATOR, { sandboxId: discarded.sandboxId,
    generation: store.getSandbox(ALPHA_OPERATOR, discarded.sandboxId).generation, observedState: 'removed' });
  const forced = store.discardSandbox(ALPHA_OPERATOR, {
    sandboxId: discarded.sandboxId,
    reason: 'operator decision',
  });
  assert.equal(forced.deletedReason, 'operator decision');
  assert.notEqual(forced.deletedAt, null);
});

test('text and payload bounds are enforced', (t) => {
  const directory = tempDirectory(t, 'bounds');
  const store = openWorkStore(directory);
  t.after(() => store.close());

  assert.throws(
    () =>
      store.reserveSandbox(
        { ...ALPHA_OPERATOR, project: 'p'.repeat(129) },
        baseReservation()
      ),
    assertCode('invalid_input')
  );
  assert.throws(
    () =>
      store.reserveSandbox(
        { ...ALPHA_OPERATOR, role: 'admin' },
        baseReservation()
      ),
    assertCode('invalid_input')
  );
  assert.throws(
    () =>
      store.reserveSandbox(
        { ...ALPHA_OPERATOR, project: 'line\nbreak' },
        baseReservation()
      ),
    assertCode('invalid_input')
  );
  assert.throws(
    () =>
      store.reserveSandbox(ALPHA_OPERATOR, {
        ...baseReservation(),
        engine: 'e'.repeat(65),
      }),
    assertCode('invalid_input')
  );

  const sandbox = reserve(store, ALPHA_OPERATOR);
  assert.throws(
    () =>
      store.submitJob(ALPHA_RUNNER, {
        requestId: 'large-job',
        workspaceId: sandbox.workspaceId,
        payload: { text: 'x'.repeat(70 * 1024) },
      }),
    assertCode('payload_too_large')
  );
  assert.throws(
    () =>
      store.appendEvent(ALPHA_RUNNER, {
        type: 't'.repeat(65),
      }),
    assertCode('invalid_input')
  );
  assert.throws(
    () =>
      store.appendEvent(ALPHA_RUNNER, {
        type: 'job.output',
        data: { text: 'x'.repeat(70 * 1024) },
      }),
    assertCode('payload_too_large')
  );
  assert.throws(
    () =>
      store.appendEvent(ALPHA_RUNNER, {
        type: 'job.output',
        sandboxId: 'missing',
      }),
    assertCode('not_found')
  );
});

test('quota reservations are atomic across independent processes', async (t) => {
  const directory = tempDirectory(t, 'process-quota');
  const owner = openWorkStore(directory, {
    limits: { vcpus: 4, memoryMiB: 4096, diskMiB: 1000 },
  });
  owner.close();

  const worker = `
const { openWorkStore } = require(${JSON.stringify(SOURCE_PATH)});
let store;
try {
  store = openWorkStore(process.argv[1], {
    limits: { vcpus: 4, memoryMiB: 4096, diskMiB: 1000 },
  });
  const receipt = store.reserveSandbox(
    { clientId: 'process-client', project: 'process', role: 'runner' },
    {
      requestId: process.argv[2],
      engine: 'boxlite',
      engineVersion: '0.14.1',
      profile: 'pi-dev',
      imageDigest: 'sha256:process',
      resources: { vcpus: 1, memoryMiB: 1024, diskMiB: 250 },
      retention: 'ephemeral',
    }
  );
  store.close();
  process.stdout.write(JSON.stringify({
    ok: true,
    sandboxId: receipt.sandboxId,
  }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    code: error && error.code,
  }));
}
`;

  const results = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      runNode(worker, [directory, `process-${index}`])
    )
  );
  const parsed = results.map((result) => {
    assert.equal(result.code, 0);
    return JSON.parse(result.stdout);
  });
  const winners = parsed.filter((result) => result.ok);
  assert.equal(winners.length, 4);
  for (const result of parsed.filter((item) => !item.ok)) {
    assert.equal(result.code, 'quota_exceeded');
  }

  const reopened = openWorkStore(directory, {
    limits: { vcpus: 4, memoryMiB: 4096, diskMiB: 1000 },
  });
  t.after(() => reopened.close());
  assert.equal(
    reopened.listSandboxes({
      clientId: 'process-client',
      project: 'process',
      role: 'operator',
    }).length,
    4
  );
});

test('a committed reservation survives abrupt process death', async (t) => {
  const directory = tempDirectory(t, 'crash');
  const worker = `
const { openWorkStore } = require(${JSON.stringify(SOURCE_PATH)});
const store = openWorkStore(process.argv[1]);
const receipt = store.reserveSandbox(
  { clientId: 'crash-client', project: 'crash', role: 'operator' },
  {
    requestId: 'crash-request',
    engine: 'boxlite',
    engineVersion: '0.14.1',
    profile: 'pi-dev',
    imageDigest: 'sha256:crash',
    resources: { vcpus: 1, memoryMiB: 256, diskMiB: 64 },
    retention: 'until-export',
  }
);
process.stdout.write(JSON.stringify(receipt));
process.kill(process.pid, 'SIGKILL');
`;
  const result = await runNode(worker, [directory]);
  assert.notEqual(result.code, 0);
  const receipt = JSON.parse(result.stdout);

  const reopened = openWorkStore(directory);
  t.after(() => reopened.close());
  const recovered = reopened.getSandbox(
    { clientId: 'crash-client', project: 'crash', role: 'observer' },
    receipt.sandboxId
  );
  assert.equal(recovered.workspaceId, receipt.workspaceId);
  assert.equal(recovered.retention, 'until-export');
  assert.equal(recovered.desiredState, 'running');
  assert.equal(recovered.observedState, 'unknown');
});

test('job cursors are independent and advance across a fully pruned window', t => {
  const store = openWorkStore(tempDirectory(t, 'job-cursors'), { maxEvents: 2 });
  t.after(() => store.close());
  const sandbox = reserve(store, ALPHA_RUNNER, { requestId: 'cursor-box' });
  const job = name => store.submitJob(ALPHA_RUNNER, { requestId: name, workspaceId: sandbox.workspaceId }).jobId;
  const first = job('one'), second = job('two');
  const append = jobId => store.appendEvent(ALPHA_RUNNER, { jobId, sandboxId: sandbox.sandboxId, type: 'progress' });
  const poll = (jobId, afterSeq = 0) => store.pollJobEvents(ALPHA_OBSERVER, { jobId, afterSeq });
  append(first); append(second);
  assert.deepEqual(poll(second).events.map(e => [e.jobId, e.seq]), [[second, 1]]);
  append(second);
  assert.deepEqual(poll(first), { events: [], firstSeq: 2, lastSeq: 1, nextSeq: 1, gap: true, reset: false });
  append(first);
  assert.deepEqual(poll(first, 1).events.map(e => e.seq), [2]);
  assert.equal(poll(first, 20).reset, true);
  assert.throws(() => store.pollJobEvents(BETA_OPERATOR, { jobId: first }), assertCode('not_found'));
});

test('a stop request retains quota and native identity until engine removal is observed', t => {
  const store = openWorkStore(tempDirectory(t, 'observed-removal'));
  t.after(() => store.close());
  const reserved = reserve(store, ALPHA_RUNNER, { requestId: 'proof' });
  const sandboxId = reserved.sandboxId;
  const running = store.attachEngine(ALPHA_RUNNER, { sandboxId, nativeId: 'original', generation: reserved.generation });
  assert.throws(() => store.attachEngine(ALPHA_RUNNER, { sandboxId, nativeId: 'other', generation: running.generation }), assertCode('generation_conflict'));
  const stopping = store.stopSandbox(ALPHA_RUNNER, { sandboxId });
  assert.equal(stopping.stoppedAt, null);
  assert.throws(() => store.discardSandbox(ALPHA_OPERATOR, { sandboxId }), assertCode('invalid_transition'));
  assert.throws(() => store.startSandbox(ALPHA_RUNNER, { sandboxId, generation: stopping.generation }), assertCode('invalid_transition'));
  const stopped = store.recordObserved(ALPHA_RUNNER, { sandboxId, generation: stopping.generation, observedState: 'stopped' });
  assert.throws(() => store.deleteSandbox(ALPHA_OPERATOR, { sandboxId }), assertCode('invalid_transition'));
  const restarting = store.startSandbox(ALPHA_RUNNER, { sandboxId, generation: stopped.generation });
  assert.equal(restarting.nativeId, running.nativeId);
  assert.equal(restarting.observedState, 'stopped');
  assert.equal(restarting.desiredState, 'running');
});
