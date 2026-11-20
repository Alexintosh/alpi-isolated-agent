'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const {
  openPairingStore,
  PairingStoreError,
} = require('../src/pairing-store.cjs');

const WORKSPACE = process.cwd();
const SOURCE_PATH = path.resolve(__dirname, '../src/pairing-store.cjs');
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BEARER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function tempDirectory(t, label) {
  const directory = fs.mkdtempSync(
    path.join(WORKSPACE, `.pairing-test-${label}-`)
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

function digestOf(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function listFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function runNode(workerCode, args) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['-e', workerCode, ...args],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    );
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', () => resolve({ code: -1, stdout }));
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

function assertCode(expectedCode) {
  return (error) => {
    assert.ok(error instanceof PairingStoreError);
    assert.equal(error.code, expectedCode);
    return true;
  };
}

test('server identity is stable across reopen and independent connections', (t) => {
  const directory = tempDirectory(t, 'identity');
  const first = openPairingStore(directory);
  const serverId = first.serverId;

  assert.match(serverId, UUID_PATTERN);

  const second = openPairingStore(directory);
  assert.equal(second.serverId, serverId);
  second.close();
  first.close();

  const reopened = openPairingStore(directory);
  assert.equal(reopened.serverId, serverId);
  reopened.close();

  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.equal(
    fs.statSync(path.join(directory, 'pairing.sqlite')).mode & 0o777,
    0o600
  );
});

test('invite, exchange, authenticate and list expose bounded metadata', (t) => {
  const directory = tempDirectory(t, 'lifecycle');
  const clock = createClock(1_000_000);
  const store = openPairingStore(directory, { now: clock.now });
  t.after(() => store.close());

  const invite = store.issueInvite({
    project: 'demo-project',
    role: 'runner',
  });
  assert.match(invite.invitation, TOKEN_PATTERN);
  assert.equal(Buffer.from(invite.invitation, 'base64url').length, 32);
  assert.equal(invite.expiresAt, 1_000_000 + 5 * 60 * 1000);

  const exchanged = store.exchange({
    invitation: invite.invitation,
    name: 'worker-1',
  });
  assert.match(exchanged.credential, TOKEN_PATTERN);
  assert.equal(Buffer.from(exchanged.credential, 'base64url').length, 32);
  assert.match(exchanged.clientId, UUID_PATTERN);
  assert.equal(exchanged.project, 'demo-project');
  assert.equal(exchanged.role, 'runner');
  assert.equal(exchanged.expiresAt, 1_000_000 + BEARER_TTL_MS);

  const authenticated = store.authenticate(exchanged.credential);
  assert.deepEqual(authenticated, {
    clientId: exchanged.clientId,
    name: 'worker-1',
    project: 'demo-project',
    role: 'runner',
    expiresAt: 1_000_000 + BEARER_TTL_MS,
  });

  const clients = store.listClients();
  assert.equal(clients.length, 1);
  assert.equal(clients[0].clientId, exchanged.clientId);
  assert.equal(clients[0].name, 'worker-1');
  assert.equal(clients[0].project, 'demo-project');
  assert.equal(clients[0].role, 'runner');
  assert.equal(clients[0].revoked, false);
  assert.equal(clients[0].revokedAt, null);
  assert.equal(clients[0].expired, false);
  assert.equal('credential' in clients[0], false);
  assert.equal('credentialDigest' in clients[0], false);
  assert.equal('digest' in clients[0], false);
});

test('invite TTL defaults to five minutes and cannot exceed it', (t) => {
  const directory = tempDirectory(t, 'ttl');
  const clock = createClock(2_000_000);
  const store = openPairingStore(directory, { now: clock.now });
  t.after(() => store.close());

  const short = store.issueInvite({
    project: 'ttl',
    role: 'observer',
    ttlMs: 1500,
  });
  assert.equal(short.expiresAt, 2_001_500);

  assert.throws(
    () =>
      store.issueInvite({
        project: 'ttl',
        role: 'observer',
        ttlMs: 5 * 60 * 1000 + 1,
      }),
    assertCode('invalid_input')
  );
  assert.throws(
    () =>
      store.issueInvite({
        project: 'ttl',
        role: 'observer',
        ttlMs: 0,
      }),
    assertCode('invalid_input')
  );
  assert.throws(
    () =>
      store.issueInvite({
        project: 'ttl',
        role: 'observer',
        ttlMs: -1,
      }),
    assertCode('invalid_input')
  );
  assert.throws(
    () =>
      store.issueInvite({
        project: 'ttl',
        role: 'observer',
        ttlMs: 1.5,
      }),
    assertCode('invalid_input')
  );
  assert.throws(
    () =>
      store.issueInvite({
        project: 'ttl',
        role: 'observer',
        ttlMs: '1000',
      }),
    assertCode('invalid_input')
  );
});

test('invalid named fields and roles are rejected without leaking values', (t) => {
  const directory = tempDirectory(t, 'invalid');
  const store = openPairingStore(directory);
  t.after(() => store.close());

  for (const role of ['observer', 'runner', 'operator']) {
    const invite = store.issueInvite({ project: 'roles', role });
    assert.equal(invite.expiresAt > 0, true);
  }

  assert.throws(
    () => store.issueInvite({ project: 'p', role: 'admin' }),
    assertCode('invalid_input')
  );
  assert.throws(
    () => store.issueInvite({ project: '', role: 'runner' }),
    assertCode('invalid_input')
  );
  assert.throws(
    () => store.issueInvite({ project: '   ', role: 'runner' }),
    assertCode('invalid_input')
  );
  assert.throws(
    () =>
      store.issueInvite({
        project: 'p'.repeat(129),
        role: 'runner',
      }),
    assertCode('invalid_input')
  );
  assert.throws(
    () =>
      store.issueInvite({
        project: 'line\nbreak',
        role: 'runner',
      }),
    assertCode('invalid_input')
  );
  assert.throws(
    () =>
      store.issueInvite({
        project: 'separator\u2028break',
        role: 'runner',
      }),
    assertCode('invalid_input')
  );

  const token = 'A'.repeat(43);
  assert.throws(
    () => store.exchange({ invitation: 'short', name: 'n' }),
    assertCode('invalid_invitation')
  );
  assert.throws(
    () => store.exchange({ invitation: token, name: '' }),
    assertCode('invalid_input')
  );
  assert.throws(
    () => store.exchange({ invitation: token }),
    assertCode('invalid_input')
  );
  assert.throws(
    () => store.exchange({ invitation: token, name: 'n'.repeat(65) }),
    assertCode('invalid_input')
  );
  assert.throws(
    () => store.exchange({ invitation: token, name: 'n' }),
    assertCode('invalid_invitation')
  );

  assert.throws(
    () => store.authenticate('not-a-token'),
    assertCode('invalid_credential')
  );
  assert.throws(
    () => store.authenticate(token),
    assertCode('invalid_credential')
  );
  assert.throws(
    () => store.revoke('not-a-uuid'),
    assertCode('invalid_input')
  );
  assert.throws(
    () => store.revoke('00000000-0000-4000-8000-000000000000'),
    assertCode('unknown_client')
  );

  try {
    store.exchange({ invitation: token, name: 'n' });
    assert.fail('expected exchange to fail');
  } catch (error) {
    assert.equal(error.code, 'invalid_invitation');
    assert.equal(error.message.includes(token), false);
  }
});

test('expiry boundary is exclusive for invites and bearers', (t) => {
  const directory = tempDirectory(t, 'expiry');
  const clock = createClock(1_000);
  const store = openPairingStore(directory, { now: clock.now });
  t.after(() => store.close());

  const invite = store.issueInvite({
    project: 'expiry',
    role: 'observer',
    ttlMs: 1000,
  });
  assert.equal(invite.expiresAt, 2000);

  clock.set(1999);
  const exchanged = store.exchange({
    invitation: invite.invitation,
    name: 'just-in-time',
  });
  assert.equal(exchanged.expiresAt, 1999 + BEARER_TTL_MS);

  clock.set(exchanged.expiresAt - 1);
  assert.equal(
    store.authenticate(exchanged.credential).clientId,
    exchanged.clientId
  );

  clock.set(exchanged.expiresAt);
  assert.throws(
    () => store.authenticate(exchanged.credential),
    assertCode('invalid_credential')
  );

  clock.set(5000);
  const lateInvite = store.issueInvite({
    project: 'expiry',
    role: 'observer',
    ttlMs: 1000,
  });
  clock.set(6000);
  assert.throws(
    () =>
      store.exchange({
        invitation: lateInvite.invitation,
        name: 'too-late',
      }),
    assertCode('invalid_invitation')
  );
});

test('an invitation is consumed exactly once across independent connections', (t) => {
  const directory = tempDirectory(t, 'race-local');
  const clock = createClock(10_000);
  const owner = openPairingStore(directory, { now: clock.now });
  t.after(() => owner.close());

  const invite = owner.issueInvite({
    project: 'race',
    role: 'operator',
  });

  const peers = Array.from({ length: 8 }, () =>
    openPairingStore(directory, { now: clock.now })
  );
  t.after(() => {
    for (const peer of peers) {
      peer.close();
    }
  });

  const results = peers.map((peer, index) => {
    try {
      return {
        ok: true,
        result: peer.exchange({
          invitation: invite.invitation,
          name: `peer-${index}`,
        }),
      };
    } catch (error) {
      return { ok: false, code: error.code };
    }
  });

  const winners = results.filter((result) => result.ok);
  assert.equal(winners.length, 1);
  assert.match(winners[0].result.credential, TOKEN_PATTERN);

  for (const result of results.filter((item) => !item.ok)) {
    assert.equal(result.code, 'invalid_invitation');
  }

  assert.equal(owner.listClients().length, 1);
  assert.throws(
    () =>
      owner.exchange({
        invitation: invite.invitation,
        name: 'second-use',
      }),
    assertCode('invalid_invitation')
  );
});

test('an invitation is consumed exactly once across processes', async (t) => {
  const directory = tempDirectory(t, 'race-process');
  const owner = openPairingStore(directory);
  const serverId = owner.serverId;
  const invite = owner.issueInvite({
    project: 'race-process',
    role: 'runner',
  });
  owner.close();

  const worker = `
const { openPairingStore } = require(${JSON.stringify(SOURCE_PATH)});
let store;
try {
  store = openPairingStore(process.argv[1]);
  const result = store.exchange({
    invitation: process.argv[2],
    name: 'multi-process',
  });
  store.close();
  process.stdout.write(JSON.stringify({
    ok: true,
    serverId: store.serverId,
    credential: result.credential,
    clientId: result.clientId,
  }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    serverId: store && store.serverId,
    code: error && error.code,
  }));
}
`;

  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      runNode(worker, [directory, invite.invitation])
    )
  );

  const parsed = results.map((result) => {
    assert.equal(result.code, 0);
    return JSON.parse(result.stdout);
  });
  for (const result of parsed) {
    assert.equal(result.serverId, serverId);
  }
  const winners = parsed.filter((result) => result.ok);
  assert.equal(winners.length, 1);
  assert.match(winners[0].credential, TOKEN_PATTERN);

  for (const result of parsed.filter((item) => !item.ok)) {
    assert.equal(result.code, 'invalid_invitation');
  }

  const reopened = openPairingStore(directory);
  t.after(() => reopened.close());
  const clients = reopened.listClients();
  assert.equal(clients.length, 1);
  assert.equal(clients[0].clientId, winners[0].clientId);
  assert.equal(
    reopened.authenticate(winners[0].credential).clientId,
    winners[0].clientId
  );
});

test('a failed exchange rolls back the consume and client creation', (t) => {
  const directory = tempDirectory(t, 'rollback');
  const store = openPairingStore(directory);
  t.after(() => store.close());

  const invite = store.issueInvite({
    project: 'rollback',
    role: 'runner',
  });

  const dbPath = path.join(directory, 'pairing.sqlite');
  const raw = new DatabaseSync(dbPath);
  raw.exec(`
    CREATE TRIGGER fail_client_insert
    BEFORE INSERT ON clients
    BEGIN
      SELECT RAISE(ABORT, 'injected failure');
    END;
  `);
  raw.close();

  assert.throws(
    () =>
      store.exchange({
        invitation: invite.invitation,
        name: 'rollback',
      }),
    assertCode('store_error')
  );
  assert.equal(store.listClients().length, 0);

  const cleanup = new DatabaseSync(dbPath);
  cleanup.exec('DROP TRIGGER fail_client_insert');
  cleanup.close();

  const exchanged = store.exchange({
    invitation: invite.invitation,
    name: 'rollback',
  });
  assert.match(exchanged.credential, TOKEN_PATTERN);
  assert.equal(store.listClients().length, 1);
});

test('uncommitted consume is rolled back after an abrupt process death', async (t) => {
  const directory = tempDirectory(t, 'crash');
  const store = openPairingStore(directory);
  const invite = store.issueInvite({
    project: 'crash',
    role: 'runner',
  });
  store.close();

  const dbPath = path.join(directory, 'pairing.sqlite');
  const digest = digestOf(invite.invitation);
  const worker = `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1]);
db.exec('BEGIN IMMEDIATE');
db.prepare('UPDATE invites SET consumed_at = ?, consumed_by = ? WHERE digest = ?')
  .run(1, 'ghost', process.argv[2]);
db.prepare(
  'INSERT INTO clients (client_id, name, project, role, credential_digest, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)'
).run(
  '00000000-0000-4000-8000-000000000001',
  'ghost',
  'crash',
  'runner',
  'deadbeef',
  1,
  2
);
process.kill(process.pid, 'SIGKILL');
`;

  const result = await runNode(worker, [dbPath, digest]);
  assert.notEqual(result.code, 0);

  const reopened = openPairingStore(directory);
  t.after(() => reopened.close());
  const exchanged = reopened.exchange({
    invitation: invite.invitation,
    name: 'after-crash',
  });
  assert.match(exchanged.credential, TOKEN_PATTERN);

  const clients = reopened.listClients();
  assert.equal(clients.length, 1);
  assert.equal(clients[0].name, 'after-crash');
  assert.equal(clients[0].clientId, exchanged.clientId);
});

test('revocation is idempotent and immediately invalidates the bearer', (t) => {
  const directory = tempDirectory(t, 'revoke');
  const clock = createClock(20_000);
  const store = openPairingStore(directory, { now: clock.now });
  t.after(() => store.close());

  const firstInvite = store.issueInvite({
    project: 'revoke',
    role: 'operator',
  });
  const first = store.exchange({
    invitation: firstInvite.invitation,
    name: 'first',
  });
  const secondInvite = store.issueInvite({
    project: 'revoke',
    role: 'observer',
  });
  const second = store.exchange({
    invitation: secondInvite.invitation,
    name: 'second',
  });

  clock.set(21_000);
  const revoked = store.revoke(first.clientId.toUpperCase());
  assert.deepEqual(revoked, {
    clientId: first.clientId,
    revokedAt: 21_000,
  });
  assert.throws(
    () => store.authenticate(first.credential),
    assertCode('invalid_credential')
  );

  clock.set(22_000);
  const revokedAgain = store.revoke(first.clientId);
  assert.deepEqual(revokedAgain, {
    clientId: first.clientId,
    revokedAt: 21_000,
  });

  assert.equal(
    store.authenticate(second.credential).clientId,
    second.clientId
  );

  const clients = store.listClients();
  const firstMetadata = clients.find(
    (client) => client.clientId === first.clientId
  );
  const secondMetadata = clients.find(
    (client) => client.clientId === second.clientId
  );
  assert.equal(firstMetadata.revoked, true);
  assert.equal(firstMetadata.revokedAt, 21_000);
  assert.equal(secondMetadata.revoked, false);
  assert.equal(secondMetadata.revokedAt, null);
});

test('private state and database files are created and enforced', (t) => {
  const base = tempDirectory(t, 'private');
  const state = path.join(base, 'state');
  const store = openPairingStore(path.relative(WORKSPACE, state));
  t.after(() => store.close());

  assert.equal(fs.statSync(state).mode & 0o777, 0o700);
  assert.equal(
    fs.statSync(path.join(state, 'pairing.sqlite')).mode & 0o777,
    0o600
  );
  assert.equal(fs.lstatSync(state).isSymbolicLink(), false);

  const existingState = path.join(base, 'existing-state');
  fs.mkdirSync(existingState, { mode: 0o700 });
  fs.chmodSync(existingState, 0o700);
  const existingStore = openPairingStore(existingState);
  existingStore.close();
  assert.equal(fs.statSync(existingState).mode & 0o777, 0o700);
  assert.equal(
    fs.statSync(path.join(existingState, 'pairing.sqlite')).mode & 0o777,
    0o600
  );
});

test('unsafe preexisting directories, symlinks and files are rejected', (t) => {
  const base = tempDirectory(t, 'unsafe');

  const openDirectory = path.join(base, 'open-directory');
  fs.mkdirSync(openDirectory, { mode: 0o755 });
  fs.chmodSync(openDirectory, 0o755);
  assert.throws(
    () => openPairingStore(openDirectory),
    assertCode('unsafe_state_directory')
  );
  assert.equal(fs.statSync(openDirectory).mode & 0o777, 0o755);

  const target = path.join(base, 'target');
  fs.mkdirSync(target, { mode: 0o700 });
  fs.chmodSync(target, 0o700);
  const linkedState = path.join(base, 'linked-state');
  fs.symlinkSync(target, linkedState, 'dir');
  assert.throws(
    () => openPairingStore(linkedState),
    assertCode('unsafe_state_directory')
  );

  const untrustedParent = path.join(base, 'untrusted-parent');
  fs.mkdirSync(untrustedParent, { mode: 0o700 });
  fs.chmodSync(untrustedParent, 0o777);
  assert.throws(
    () => openPairingStore(path.join(untrustedParent, 'state')),
    assertCode('unsafe_state_directory')
  );
  assert.equal(fs.statSync(untrustedParent).mode & 0o777, 0o777);
  assert.equal(fs.existsSync(path.join(untrustedParent, 'state')), false);

  const symlinkState = path.join(base, 'symlink-state');
  fs.mkdirSync(symlinkState, { mode: 0o700 });
  fs.chmodSync(symlinkState, 0o700);
  const outsideDatabase = path.join(base, 'outside.sqlite');
  fs.writeFileSync(outsideDatabase, '', { mode: 0o600 });
  fs.chmodSync(outsideDatabase, 0o600);
  fs.symlinkSync(outsideDatabase, path.join(symlinkState, 'pairing.sqlite'));
  assert.throws(
    () => openPairingStore(symlinkState),
    assertCode('unsafe_database_file')
  );

  const looseState = path.join(base, 'loose-state');
  fs.mkdirSync(looseState, { mode: 0o700 });
  fs.chmodSync(looseState, 0o700);
  const looseDatabase = path.join(looseState, 'pairing.sqlite');
  fs.writeFileSync(looseDatabase, '', { mode: 0o644 });
  fs.chmodSync(looseDatabase, 0o644);
  assert.throws(
    () => openPairingStore(looseState),
    assertCode('unsafe_database_file')
  );
  assert.equal(fs.statSync(looseDatabase).mode & 0o777, 0o644);

  const fileState = path.join(base, 'file-state');
  fs.writeFileSync(fileState, 'not a directory', { mode: 0o600 });
  assert.throws(
    () => openPairingStore(fileState),
    assertCode('unsafe_state_directory')
  );
});

test('invitations and bearer credentials are never persisted in plaintext', (t) => {
  const directory = tempDirectory(t, 'plaintext');
  const store = openPairingStore(directory);
  const invite = store.issueInvite({
    project: 'plaintext',
    role: 'operator',
  });
  const exchanged = store.exchange({
    invitation: invite.invitation,
    name: 'plaintext-client',
  });
  store.close();

  const files = listFiles(directory);
  assert.ok(files.length >= 1);
  for (const file of files) {
    const contents = fs.readFileSync(file);
    assert.equal(
      contents.includes(Buffer.from(invite.invitation, 'utf8')),
      false,
      `invitation found in ${file}`
    );
    assert.equal(
      contents.includes(Buffer.from(exchanged.credential, 'utf8')),
      false,
      `credential found in ${file}`
    );
  }

  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };
  const calls = [];
  for (const method of Object.keys(original)) {
    console[method] = (...args) => calls.push([method, args]);
  }

  try {
    const reopened = openPairingStore(directory);
    const nextInvite = reopened.issueInvite({
      project: 'plaintext',
      role: 'runner',
    });
    const nextClient = reopened.exchange({
      invitation: nextInvite.invitation,
      name: 'logging-check',
    });
    reopened.authenticate(nextClient.credential);
    reopened.listClients();
    reopened.revoke(nextClient.clientId);
    reopened.close();
  } finally {
    for (const [method, fn] of Object.entries(original)) {
      console[method] = fn;
    }
  }

  assert.deepEqual(calls, []);
});

test('close is idempotent and later operations fail safely', (t) => {
  const directory = tempDirectory(t, 'closed');
  const store = openPairingStore(directory);
  store.close();
  store.close();

  assert.throws(
    () => store.issueInvite({ project: 'closed', role: 'runner' }),
    assertCode('store_closed')
  );
  assert.throws(
    () => store.exchange({ invitation: 'A'.repeat(43), name: 'closed' }),
    assertCode('store_closed')
  );
  assert.throws(
    () => store.authenticate('A'.repeat(43)),
    assertCode('store_closed')
  );
  assert.throws(() => store.listClients(), assertCode('store_closed'));
  assert.throws(
    () => store.revoke('00000000-0000-4000-8000-000000000000'),
    assertCode('store_closed')
  );
});
