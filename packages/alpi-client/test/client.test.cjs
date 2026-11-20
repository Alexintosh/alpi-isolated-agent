'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const {
  ContextError,
  openStore,
  parseInviteEnvelope,
  readInviteFile,
  readProtectedStdin,
  resolveConfigDir,
} = require('../src/context.cjs');
const {
  ClientError,
  createClient,
  pairClient,
} = require('../src/client.cjs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'alpi-client-cli-'));
const BIN = path.resolve(__dirname, '../bin/alpi.cjs');

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

function token() {
  return crypto.randomBytes(32).toString('base64url');
}

function uuid() {
  return crypto.randomUUID();
}

function newCase(label = 'case') {
  const directory = fs.mkdtempSync(path.join(TMP, `${label}-`));
  const configDir = path.join(directory, 'config');
  fs.mkdirSync(configDir, { mode: 0o700 });
  fs.chmodSync(configDir, 0o700);

  const keyPath = path.join(directory, 'context.key');
  fs.writeFileSync(keyPath, crypto.randomBytes(32), { mode: 0o600 });
  fs.chmodSync(keyPath, 0o600);

  return { directory, configDir, keyPath, keyFile: keyPath };
}

function envelope(overrides = {}) {
  return {
    origin: 'https://127.0.0.1:8443',
    serverId: uuid(),
    fingerprint: 'ab'.repeat(32),
    invitation: token(),
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

function validExchange(overrides = {}) {
  return {
    credential: token(),
    clientId: uuid(),
    project: 'demo',
    role: 'runner',
    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    ...overrides,
  };
}

function validCapabilities(serverId, overrides = {}) {
  return {
    serverId,
    apiVersion: 1,
    project: 'demo',
    role: 'runner',
    runtimes: [],
    ...overrides,
  };
}

function mockTransport(options) {
  const calls = [];
  const requestJson = async (request) => {
    calls.push(request);
    if (request.path === '/v1/identity') {
      if (options.identityError) {
        throw options.identityError;
      }
      return options.identity || { serverId: options.serverId };
    }
    if (request.path === '/v1/pair/exchange') {
      if (options.exchangeError) {
        throw options.exchangeError;
      }
      if (typeof options.exchange === 'function') {
        return options.exchange(request);
      }
      return options.exchange;
    }
    if (request.path === '/v1/capabilities') {
      if (options.capabilitiesError) {
        throw options.capabilitiesError;
      }
      if (typeof options.capabilities === 'function') {
        return options.capabilities(request);
      }
      return options.capabilities;
    }
    throw new Error(`unexpected path ${request.path}`);
  };
  return { calls, requestJson };
}

function transportFailure(code, statusCode) {
  const error = new Error('mock transport failure');
  error.code = code;
  if (statusCode !== undefined) {
    error.statusCode = statusCode;
  }
  return error;
}

function writePrivateJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value), { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

test('pairs after identity match, reserves before exchange and stores encrypted context', async () => {
  const testCase = newCase('pair-success');
  const store = openStore(testCase);
  const invite = envelope();
  const issued = validExchange();
  let reservationAtIdentity = null;
  let reservationAtExchange = null;

  const transport = mockTransport({
    serverId: invite.serverId,
    exchange: () => {
      reservationAtExchange = store.getReservation('work');
      return issued;
    },
  });
  const originalRequest = transport.requestJson;
  const requestJson = async (request) => {
    if (request.path === '/v1/identity') {
      reservationAtIdentity = store.getReservation('work');
    }
    return originalRequest(request);
  };

  try {
    const result = await pairClient({
      envelope: invite,
      name: 'work',
      store,
      requestJson,
    });

    assert.deepEqual(result, {
      name: 'work',
      serverId: invite.serverId,
      clientId: issued.clientId,
      project: issued.project,
      role: issued.role,
      expiresAt: issued.expiresAt,
      reservationRemoved: true,
      reservationPath: path.join(testCase.configDir, 'reservations', 'work.reservation'),
    });
    assert.ok(reservationAtIdentity, 'reservation exists before identity request');
    assert.ok(reservationAtExchange, 'reservation exists before token exchange');

    assert.equal(transport.calls.length, 2);
    assert.equal(transport.calls[0].path, '/v1/identity');
    assert.equal(transport.calls[0].method, 'GET');
    assert.equal(transport.calls[0].credential, undefined);
    assert.equal(transport.calls[0].body, undefined);
    assert.equal(transport.calls[1].path, '/v1/pair/exchange');
    assert.equal(transport.calls[1].method, 'POST');
    assert.deepEqual(transport.calls[1].body, {
      invitation: invite.invitation,
      name: 'work',
    });
    assert.equal(transport.calls[1].credential, undefined);

    const context = store.get('work');
    assert.equal(context.serverId, invite.serverId);
    assert.equal(context.fingerprint, invite.fingerprint);
    assert.equal(context.credential, issued.credential);
    assert.equal(context.clientId, issued.clientId);
    assert.equal(context.project, issued.project);
    assert.equal(context.role, issued.role);
    assert.equal(context.credentialExpiresAt, issued.expiresAt);
    assert.equal(store.getReservation('work'), null);

    const serializedResult = JSON.stringify(result);
    assert.equal(serializedResult.includes(issued.credential), false);
    assert.equal(serializedResult.includes(invite.invitation), false);

    const contextFile = path.join(testCase.configDir, 'contexts', 'work.ctx');
    const contextStat = fs.statSync(contextFile);
    assert.equal(contextStat.mode & 0o777, 0o600);
    const configStat = fs.statSync(testCase.configDir);
    assert.equal(configStat.mode & 0o777, 0o700);
  } finally {
    store.close();
  }
});

test('compares the advertised server UUID before sending the invitation', async () => {
  const testCase = newCase('wrong-server');
  const store = openStore(testCase);
  const invite = envelope();
  const transport = mockTransport({
    serverId: uuid(),
    exchange: validExchange(),
  });

  try {
    await assert.rejects(
      pairClient({
        envelope: invite,
        name: 'wrong',
        store,
        requestJson: transport.requestJson,
      }),
      (error) => {
        assert.equal(error.code, 'SERVER_ID_MISMATCH');
        assert.equal(String(error).includes(invite.invitation), false);
        return true;
      },
    );

    assert.equal(transport.calls.length, 1);
    assert.equal(transport.calls[0].path, '/v1/identity');
    assert.equal(store.getReservation('wrong'), null);
    assert.equal(store.get('wrong'), null);
  } finally {
    store.close();
  }
});

test('rejects an expired invitation before reserving or contacting the server', async () => {
  const testCase = newCase('expired');
  const store = openStore(testCase);
  const invite = envelope({ expiresAt: Date.now() - 1 });
  const transport = mockTransport({
    serverId: invite.serverId,
    exchange: validExchange(),
  });

  assert.throws(
    () => parseInviteEnvelope(JSON.stringify(invite)),
    (error) => error.code === 'INVITE_EXPIRED',
  );

  try {
    await assert.rejects(
      pairClient({
        envelope: invite,
        name: 'expired',
        store,
        requestJson: transport.requestJson,
      }),
      (error) => error.code === 'INVITE_EXPIRED',
    );
    assert.equal(transport.calls.length, 0);
    assert.equal(store.getReservation('expired'), null);
    assert.equal(store.get('expired'), null);
  } finally {
    store.close();
  }
});

test('validates invitation envelopes strictly', () => {
  const base = envelope();
  const invalid = [
    { ...base, extra: true },
    { ...base, origin: 'http://127.0.0.1:8443' },
    { ...base, serverId: 'not-a-uuid' },
    { ...base, fingerprint: 'xyz' },
    { ...base, invitation: 'short' },
    { ...base, expiresAt: 1.5 },
    { ...base, expiresAt: '9999999999999' },
  ];
  for (const value of invalid) {
    assert.throws(
      () => parseInviteEnvelope(JSON.stringify(value)),
      (error) => error instanceof ContextError && error.code === 'INVALID_ENVELOPE',
      JSON.stringify(value),
    );
  }

  assert.throws(
    () => parseInviteEnvelope('not-json'),
    (error) => error.code === 'INVALID_ENVELOPE',
  );
  assert.throws(
    () => parseInviteEnvelope(Buffer.alloc(9 * 1024, 0x20)),
    (error) => error.code === 'INVALID_ENVELOPE',
  );
});

test('enforces private config, key and invitation files', () => {
  const testCase = newCase('permissions');

  fs.chmodSync(testCase.keyPath, 0o644);
  assert.throws(
    () => openStore(testCase),
    (error) => error.code === 'UNSAFE_KEY_FILE',
  );
  fs.chmodSync(testCase.keyPath, 0o600);

  const insideKey = path.join(testCase.configDir, 'inside.key');
  fs.writeFileSync(insideKey, crypto.randomBytes(32), { mode: 0o600 });
  fs.chmodSync(insideKey, 0o600);
  assert.throws(
    () => openStore({ configDir: testCase.configDir, keyFile: insideKey }),
    (error) => error.code === 'KEY_FILE_INSIDE_CONFIG',
  );

  const keyTarget = path.join(testCase.directory, 'key-target');
  fs.writeFileSync(keyTarget, crypto.randomBytes(32), { mode: 0o600 });
  const keyLink = path.join(testCase.directory, 'key-link');
  fs.symlinkSync(keyTarget, keyLink);
  assert.throws(
    () => openStore({ configDir: testCase.configDir, keyFile: keyLink }),
    (error) => error.code === 'UNSAFE_KEY_FILE',
  );

  const shortKey = path.join(testCase.directory, 'short.key');
  fs.writeFileSync(shortKey, crypto.randomBytes(31), { mode: 0o600 });
  assert.throws(
    () => openStore({ configDir: testCase.configDir, keyFile: shortKey }),
    (error) => error.code === 'UNSAFE_KEY_FILE',
  );

  const missingKey = path.join(testCase.directory, 'missing.key');
  assert.throws(
    () => openStore({ configDir: testCase.configDir, keyFile: missingKey }),
    (error) => error.code === 'UNSAFE_KEY_FILE',
  );
  assert.equal(fs.existsSync(missingKey), false);

  const unsafeConfig = path.join(testCase.directory, 'unsafe-config');
  fs.mkdirSync(unsafeConfig, { mode: 0o755 });
  fs.chmodSync(unsafeConfig, 0o755);
  assert.throws(
    () => openStore({ configDir: unsafeConfig, keyFile: testCase.keyPath }),
    (error) => error.code === 'UNSAFE_CONFIG_DIR',
  );

  const inviteFile = path.join(testCase.directory, 'invite.json');
  writePrivateJson(inviteFile, envelope());
  fs.chmodSync(inviteFile, 0o644);
  assert.throws(
    () => readInviteFile(inviteFile),
    (error) => error.code === 'UNSAFE_INVITE_FILE',
  );
  fs.chmodSync(inviteFile, 0o600);
  assert.ok(readInviteFile(inviteFile).length > 0);

  const inviteTarget = path.join(testCase.directory, 'invite-target.json');
  writePrivateJson(inviteTarget, envelope());
  const inviteLink = path.join(testCase.directory, 'invite-link.json');
  fs.symlinkSync(inviteTarget, inviteLink);
  assert.throws(
    () => readInviteFile(inviteLink),
    (error) => error.code === 'UNSAFE_INVITE_FILE',
  );

  const largeInvite = path.join(testCase.directory, 'large.json');
  fs.writeFileSync(largeInvite, 'x'.repeat(9 * 1024), { mode: 0o600 });
  fs.chmodSync(largeInvite, 0o600);
  assert.throws(
    () => readInviteFile(largeInvite),
    (error) => error.code === 'INVITE_TOO_LARGE',
  );

  const stdinFile = path.join(testCase.directory, 'stdin.json');
  writePrivateJson(stdinFile, envelope());
  fs.chmodSync(stdinFile, 0o644);
  const stdinFd = fs.openSync(stdinFile, 'r');
  try {
    assert.throws(
      () => readProtectedStdin({ fd: stdinFd }),
      (error) => error.code === 'UNSAFE_INVITE_STDIN',
    );
  } finally {
    fs.closeSync(stdinFd);
  }
});

test('requires an explicit key file and never creates it', () => {
  const testCase = newCase('key-required');
  assert.throws(
    () => openStore({ configDir: testCase.configDir, env: {} }),
    (error) => error.code === 'KEY_FILE_REQUIRED',
  );
});

test('refuses interactive/character-device stdin for invitations', () => {
  const fd = fs.openSync('/dev/null', 'r');
  try {
    assert.throws(
      () => readProtectedStdin({ fd }),
      (error) => error.code === 'INVITE_STDIN_TTY',
    );
  } finally {
    fs.closeSync(fd);
  }
});

test('prevents duplicate and concurrent pairing on the same context name', async () => {
  const testCase = newCase('race');
  const store = openStore(testCase);
  const invite = envelope();
  let exchangeCalls = 0;
  let releaseGate;
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });

  const requestJson = async (request) => {
    if (request.path === '/v1/identity') {
      await gate;
      return { serverId: invite.serverId };
    }
    exchangeCalls += 1;
    return validExchange();
  };

  try {
    const first = pairClient({
      envelope: invite,
      name: 'race',
      store,
      requestJson,
    });
    const second = pairClient({
      envelope: envelope(),
      name: 'race',
      store,
      requestJson,
    });
    releaseGate();

    const results = await Promise.allSettled([first, second]);
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].status, 'rejected');
    assert.equal(results[1].reason.code, 'RESERVATION_EXISTS');
    assert.equal(
      results[1].reason.message.includes(results[1].reason.reservationPath),
      true,
    );
    assert.equal(exchangeCalls, 1);

    await assert.rejects(
      pairClient({
        envelope: envelope(),
        name: 'race',
        store,
        requestJson,
      }),
      (error) => error.code === 'CONTEXT_EXISTS',
    );
    assert.equal(exchangeCalls, 1);
    assert.equal(store.get('race').serverId, invite.serverId);
  } finally {
    store.close();
  }
});

test('releases reservations after ordinary failures', async () => {
  const testCase = newCase('ordinary');
  const store = openStore(testCase);
  const invite = envelope();

  try {
    const identityFailure = mockTransport({
      identityError: transportFailure('TIMEOUT'),
    });
    await assert.rejects(
      pairClient({
        envelope: invite,
        name: 'identity-fail',
        store,
        requestJson: identityFailure.requestJson,
      }),
      (error) => error.code === 'TIMEOUT',
    );
    assert.equal(store.getReservation('identity-fail'), null);

    const rejected = mockTransport({
      serverId: invite.serverId,
      exchangeError: transportFailure('HTTP_STATUS', 401),
    });
    await assert.rejects(
      pairClient({
        envelope: invite,
        name: 'rejected',
        store,
        requestJson: rejected.requestJson,
      }),
      (error) => {
        assert.equal(error.code, 'HTTP_STATUS');
        assert.equal(error.statusCode, 401);
        return true;
      },
    );
    assert.equal(store.getReservation('rejected'), null);
    assert.equal(store.get('rejected'), null);
  } finally {
    store.close();
  }
});

test('keeps a reservation for ambiguous exchange outcomes and documents recovery', async () => {
  const testCase = newCase('ambiguous');
  const store = openStore(testCase);
  const invite = envelope();
  const lost = mockTransport({
    serverId: invite.serverId,
    exchangeError: transportFailure('TIMEOUT'),
  });

  try {
    await assert.rejects(
      pairClient({
        envelope: invite,
        name: 'lost',
        store,
        requestJson: lost.requestJson,
      }),
      (error) => {
        assert.equal(error.code, 'PAIR_AMBIGUOUS');
        assert.equal(String(error).includes(invite.invitation), false);
        assert.equal(error.message.includes('revoke'), true);
        assert.equal(error.message.includes('fresh invitation'), true);
        assert.equal(error.message.includes(error.reservationPath), true);
        return true;
      },
    );

    const reservation = store.getReservation('lost');
    assert.ok(reservation);
    assert.equal(fs.statSync(reservation.path).mode & 0o777, 0o600);
    assert.equal(store.get('lost'), null);

    await assert.rejects(
      Promise.resolve().then(() => store.releaseReservation('lost', '0'.repeat(32))),
      (error) => error.code === 'RESERVATION_MISMATCH',
    );
    assert.equal(store.releaseReservation('lost', reservation.id), true);
    assert.equal(store.getReservation('lost'), null);

    const retry = mockTransport({
      serverId: invite.serverId,
      exchange: validExchange(),
    });
    const result = await pairClient({
      envelope: envelope({ serverId: invite.serverId }),
      name: 'lost',
      store,
      requestJson: retry.requestJson,
    });
    assert.equal(result.name, 'lost');
    assert.ok(store.get('lost'));
  } finally {
    store.close();
  }
});

test('treats malformed successful exchange responses as ambiguous', async () => {
  const testCase = newCase('bad-exchange');
  const store = openStore(testCase);
  const invite = envelope();
  const transport = mockTransport({
    serverId: invite.serverId,
    exchange: { credential: token() },
  });

  try {
    await assert.rejects(
      pairClient({
        envelope: invite,
        name: 'bad-exchange',
        store,
        requestJson: transport.requestJson,
      }),
      (error) => error.code === 'PAIR_AMBIGUOUS',
    );
    assert.ok(store.getReservation('bad-exchange'));
    assert.equal(store.get('bad-exchange'), null);
  } finally {
    store.close();
  }
});

test('detects tampered ciphertext, wrong keys and context-name substitution', async () => {
  const testCase = newCase('tamper');
  const store = openStore(testCase);
  const invite = envelope();
  const issued = validExchange();
  const transport = mockTransport({
    serverId: invite.serverId,
    exchange: issued,
  });

  try {
    await pairClient({
      envelope: invite,
      name: 'sealed',
      store,
      requestJson: transport.requestJson,
    });

    const contextFile = path.join(testCase.configDir, 'contexts', 'sealed.ctx');
    const original = fs.readFileSync(contextFile);
    const document = JSON.parse(original.toString('utf8'));
    const replacement = document.ciphertext[0] === 'A' ? 'B' : 'A';
    document.ciphertext = replacement + document.ciphertext.slice(1);
    fs.writeFileSync(contextFile, JSON.stringify(document), { mode: 0o600 });
    fs.chmodSync(contextFile, 0o600);

    assert.throws(
      () => store.get('sealed'),
      (error) => {
        assert.equal(error.code, 'CONTEXT_DECRYPT_FAILED');
        assert.equal(String(error).includes(issued.credential), false);
        return true;
      },
    );
    fs.writeFileSync(contextFile, original, { mode: 0o600 });
    fs.chmodSync(contextFile, 0o600);

    const substituted = path.join(testCase.configDir, 'contexts', 'other.ctx');
    fs.copyFileSync(contextFile, substituted);
    fs.chmodSync(substituted, 0o600);
    assert.throws(
      () => store.get('other'),
      (error) => error.code === 'CONTEXT_DECRYPT_FAILED',
    );

    const wrongKey = path.join(testCase.directory, 'wrong.key');
    fs.writeFileSync(wrongKey, crypto.randomBytes(32), { mode: 0o600 });
    fs.chmodSync(wrongKey, 0o600);
    const wrongStore = openStore({
      configDir: testCase.configDir,
      keyFile: wrongKey,
    });
    try {
      assert.throws(
        () => wrongStore.get('sealed'),
        (error) => error.code === 'CONTEXT_DECRYPT_FAILED',
      );
    } finally {
      wrongStore.close();
    }

    assert.equal(store.get('sealed').credential, issued.credential);
  } finally {
    store.close();
  }
});

test('never overwrites an existing context', async () => {
  const testCase = newCase('no-overwrite');
  const store = openStore(testCase);
  const invite = envelope();
  const issued = validExchange();
  const transport = mockTransport({
    serverId: invite.serverId,
    exchange: issued,
  });

  try {
    await pairClient({
      envelope: invite,
      name: 'stable',
      store,
      requestJson: transport.requestJson,
    });
    const before = fs.readFileSync(
      path.join(testCase.configDir, 'contexts', 'stable.ctx'),
    );

    assert.throws(
      () => store.reserve('stable'),
      (error) => error.code === 'CONTEXT_EXISTS',
    );
    assert.deepEqual(
      fs.readFileSync(path.join(testCase.configDir, 'contexts', 'stable.ctx')),
      before,
    );
    assert.equal(store.get('stable').credential, issued.credential);
  } finally {
    store.close();
  }
});

test('validates capabilities responses and uses the stored server identity', async () => {
  const testCase = newCase('capabilities');
  const store = openStore(testCase);
  const invite = envelope();
  const issued = validExchange();
  const pairTransport = mockTransport({
    serverId: invite.serverId,
    exchange: issued,
  });

  try {
    await pairClient({
      envelope: invite,
      name: 'caps',
      store,
      requestJson: pairTransport.requestJson,
    });
    const context = store.get('caps');

    const calls = [];
    const capabilitiesTransport = async (request) => {
      calls.push(request);
      return validCapabilities(invite.serverId, {
        runtimes: [{ id: 'local', name: 'Local runtime' }],
      });
    };
    const client = createClient({
      ...context,
      requestJson: capabilitiesTransport,
    });
    const capabilities = await client.getCapabilities();

    assert.deepEqual(capabilities, {
      serverId: invite.serverId,
      apiVersion: 1,
      project: issued.project,
      role: issued.role,
      runtimes: [{ id: 'local', name: 'Local runtime' }],
    });
    assert.equal(Object.isFrozen(capabilities), true);
    assert.equal(Object.isFrozen(capabilities.runtimes), true);
    assert.equal(Object.isFrozen(capabilities.runtimes[0]), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, '/v1/capabilities');
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].credential, issued.credential);
    assert.equal(calls[0].body, undefined);

    const mismatched = createClient({
      ...context,
      requestJson: async () => validCapabilities(uuid()),
    });
    await assert.rejects(
      mismatched.getCapabilities(),
      (error) => error.code === 'SERVER_ID_MISMATCH',
    );

    const badVersion = createClient({
      ...context,
      requestJson: async () => validCapabilities(invite.serverId, { apiVersion: 2 }),
    });
    await assert.rejects(
      badVersion.getCapabilities(),
      (error) => error.code === 'INVALID_RESPONSE',
    );

    const badProject = createClient({
      ...context,
      requestJson: async () => validCapabilities(invite.serverId, { project: 'other' }),
    });
    await assert.rejects(
      badProject.getCapabilities(),
      (error) => error.code === 'SERVER_RESPONSE_MISMATCH',
    );

    const badRuntimes = createClient({
      ...context,
      requestJson: async () => validCapabilities(invite.serverId, { runtimes: {} }),
    });
    await assert.rejects(
      badRuntimes.getCapabilities(),
      (error) => error.code === 'INVALID_RESPONSE',
    );

    const expired = createClient({
      ...context,
      credentialExpiresAt: 999,
      now: () => 1000,
      requestJson: async () => validCapabilities(invite.serverId),
    });
    await assert.rejects(
      expired.getCapabilities(),
      (error) => error.code === 'CREDENTIAL_EXPIRED',
    );

    const timedOut = createClient({
      ...context,
      requestJson: async () => {
        throw transportFailure('TIMEOUT');
      },
    });
    await assert.rejects(
      timedOut.getCapabilities(),
      (error) => error.code === 'TIMEOUT',
    );
  } finally {
    store.close();
  }
});

test('rejects invalid context names and credentials at use', () => {
  const testCase = newCase('names');
  const store = openStore(testCase);
  try {
    for (const name of ['', 'Upper', '../x', 'a..b', 'a/b', '-lead', 'x'.repeat(65)]) {
      assert.throws(
        () => store.reserve(name),
        (error) => error.code === 'INVALID_CONTEXT_NAME',
        name,
      );
    }
    assert.throws(
      () => createClient({
        origin: 'https://127.0.0.1:8443',
        fingerprint: 'ab'.repeat(32),
        serverId: uuid(),
        credential: 'short',
        project: 'demo',
        role: 'runner',
        credentialExpiresAt: Date.now() + 60_000,
      }),
      (error) => error.code === 'INVALID_CREDENTIAL',
    );
  } finally {
    store.close();
  }
});

test('resolves ALPI_CONFIG_DIR, XDG and macOS default config locations', () => {
  assert.equal(
    resolveConfigDir({
      env: { ALPI_CONFIG_DIR: path.join(TMP, 'explicit') },
      platform: 'linux',
      homedir: '/home/user',
    }),
    path.join(TMP, 'explicit'),
  );
  assert.equal(
    resolveConfigDir({
      env: { XDG_CONFIG_HOME: '/home/user/.config' },
      platform: 'linux',
      homedir: '/home/user',
    }),
    path.join('/home/user/.config', 'alpi'),
  );
  assert.equal(
    resolveConfigDir({
      env: {},
      platform: 'darwin',
      homedir: '/Users/user',
    }),
    path.join('/Users/user', 'Library', 'Application Support', 'alpi'),
  );
  assert.equal(
    resolveConfigDir({
      env: {},
      platform: 'linux',
      homedir: '/home/user',
    }),
    path.join('/home/user', '.config', 'alpi'),
  );
  assert.throws(
    () => resolveConfigDir({
      env: { ALPI_CONFIG_DIR: 'relative' },
      platform: 'linux',
      homedir: '/home/user',
    }),
    (error) => error.code === 'INVALID_CONFIG_DIR',
  );
});

test('CLI --help succeeds without secrets and documents safety', () => {
  const result = spawnSync(process.execPath, [BIN, '--help'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: alpi/);
  assert.match(result.stdout, /ALPI_CONFIG_DIR/);
  assert.match(result.stdout, /ALPI_CONTEXT_KEY_FILE/);
  assert.match(result.stdout, /Safety:/);
  assert.match(result.stdout, /fresh invitation/);
  assert.equal(result.stdout.includes('base64url token'), true);
  assert.equal(/[A-Za-z0-9_-]{43}/.test(result.stdout), false);
});

test('CLI command help succeeds', () => {
  const result = spawnSync(process.execPath, [BIN, 'pair', '--help'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: alpi/);
});

test('CLI safe failures do not echo invitations or credentials', () => {
  const testCase = newCase('cli-safe');
  const invite = envelope();
  const inviteFile = path.join(testCase.directory, 'invite.json');
  writePrivateJson(inviteFile, invite);

  const missingKey = spawnSync(process.execPath, [
    BIN,
    'pair',
    '--name',
    'safe',
    '--invite-file',
    inviteFile,
  ], {
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      ALPI_CONFIG_DIR: testCase.configDir,
      ALPI_CONTEXT_KEY_FILE: '',
    },
  });
  assert.equal(missingKey.status, 1);
  assert.match(missingKey.stderr, /ALPI_CONTEXT_KEY_FILE/);
  assert.equal(missingKey.stderr.includes(invite.invitation), false);

  const missingContext = spawnSync(process.execPath, [
    BIN,
    'capabilities',
    '--context',
    'absent',
  ], {
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      ALPI_CONFIG_DIR: testCase.configDir,
      ALPI_CONTEXT_KEY_FILE: testCase.keyPath,
    },
  });
  assert.equal(missingContext.status, 1);
  assert.match(missingContext.stderr, /Context not found/);
  assert.equal(missingContext.stderr.includes(invite.invitation), false);

  const unsafeInvite = path.join(testCase.directory, 'unsafe-invite.json');
  writePrivateJson(unsafeInvite, invite);
  fs.chmodSync(unsafeInvite, 0o644);
  const unsafe = spawnSync(process.execPath, [
    BIN,
    'pair',
    '--name',
    'safe',
    '--invite-file',
    unsafeInvite,
  ], {
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      ALPI_CONFIG_DIR: testCase.configDir,
      ALPI_CONTEXT_KEY_FILE: testCase.keyPath,
    },
  });
  assert.equal(unsafe.status, 1);
  assert.match(unsafe.stderr, /Unsafe invitation file/);
  assert.equal(unsafe.stderr.includes(invite.invitation), false);

  const expiredFile = path.join(testCase.directory, 'expired.json');
  writePrivateJson(expiredFile, envelope({ expiresAt: Date.now() - 1 }));
  const expired = spawnSync(process.execPath, [
    BIN,
    'pair',
    '--name',
    'safe',
    '--invite-file',
    expiredFile,
  ], {
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      ALPI_CONFIG_DIR: testCase.configDir,
      ALPI_CONTEXT_KEY_FILE: testCase.keyPath,
    },
  });
  assert.equal(expired.status, 1);
  assert.match(expired.stderr, /Invitation has expired/);

  const unknown = spawnSync(process.execPath, [BIN, 'unknown'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown command/);

  const pipedExpired = spawnSync(process.execPath, [
    BIN,
    'pair',
    '--name',
    'piped',
  ], {
    encoding: 'utf8',
    timeout: 10_000,
    input: JSON.stringify(envelope({ expiresAt: Date.now() - 1 })),
    env: {
      ...process.env,
      ALPI_CONFIG_DIR: testCase.configDir,
      ALPI_CONTEXT_KEY_FILE: testCase.keyPath,
    },
  });
  assert.equal(pipedExpired.status, 1);
  assert.match(pipedExpired.stderr, /Invitation has expired/);
  assert.equal(pipedExpired.stderr.includes('interactive terminal'), false);
});
