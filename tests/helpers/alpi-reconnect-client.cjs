'use strict';

// Fresh-process client used by tests/alpi-job-reconnect.test.cjs.
//
// The child loads the persisted pairing context exactly the way the packaged
// CLI does (openStore + createClient) and drives the packaged HTTPS API from
// a brand-new transport, so a reconnect in the test exercises the real
// packaged client path instead of an in-process shortcut.
//
// Modes (argv: mode contextName receiptFile [severMode]):
//   sever-submit <contextName> <receiptFile> <on-response|after-request>
//       Create the sandbox through the packaged API, persist the client-side
//       job receipt, then submit the job while the transport is severed, so
//       the process dies without ever holding the submission receipt.
//   reconnect <contextName> <receiptFile>
//       Reattach with the persisted credential: replay the exact submission
//       (idempotent duplicate-admission branch) and additionally resolve the
//       job explicitly by its request key, then observe the event page.
//   lookup-only <contextName> <receiptFile>
//       Reattach and resolve the job only through the explicit request-key
//       lookup; nothing is submitted.
//   lookup-expect-missing <contextName> <receiptFile>
//       Reattach and require the explicit request-key lookup to fail with
//       not_found: the caller's own (project, clientId, requestId) key has
//       no job, proving the lookup cannot reach another client's job.
//   submit-fresh <contextName> <receiptFile> [requestId]
//       Create the caller's own-project sandbox and submit a job under the
//       given request key (a fresh key when omitted), persisting the
//       client-side receipt. The probe for cross-principal key namespacing:
//       the same request key must admit independently in another
//       principal's own (project, clientId) namespace.
//   prepare-race <contextName> <receiptFile>
//       Create the sandbox and persist a fixed, not-yet-submitted request
//       key, so independent processes can race the same first submission.
//   race-submit <contextName> <receiptFile>
//       Submit exactly the recorded submission once and report the outcome:
//       either the admitted receipt or a clean idempotency_conflict.
//
// Sever modes inject the abrupt connection loss at the TLS socket the
// packaged transport opens for the POST .../jobs request only:
//   on-response    destroy the socket the moment the first response bytes
//                  arrive, so the admission committed but the receipt never
//                  reached the client (the exact durability boundary case).
//   after-request  destroy the socket right after the request bytes were
//                  written, so the drop may land before the server has read
//                  the request at all (the ambiguous mid-flight case).

const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const tls = require('node:tls');
const { openStore } = require('../../packages/alpi-client/src/context.cjs');
const { createClient, ClientError } = require('../../packages/alpi-client/src/client.cjs');
const { openWorkStore } = require('../../packages/alpi-server/src/work-store.cjs');

const SEVERABLE_JOB_POST = /^POST \/v1\/sandboxes\/[0-9a-f-]+\/jobs HTTP/;
const EXPECTED_SEVER_CODES = new Set(['CONNECTION_CLOSED', 'CONNECTION_ERROR']);

function isSeveredJobPost(data) {
  const head = Buffer.isBuffer(data) ? data.toString('latin1') : String(data);
  return SEVERABLE_JOB_POST.test(head);
}

// Wrap tls.connect so the next POST .../jobs connection is severed. The
// diversion only affects connections that carry a severable job POST: every
// other request (capabilities preflights, sandbox creation) keeps the real
// packaged transport behaviour.
function armSever(mode, onAckSever) {
  const originalConnect = tls.connect;
  tls.connect = function severedConnect(...args) {
    const socket = originalConnect.apply(this, args);
    let pendingDataListener = null;
    let severed = false;
    const originalOn = socket.on.bind(socket);
    socket.on = function severedOn(event, listener) {
      if (event === 'data' && !severed) {
        // Hold the transport's data listener until the request head shows
        // whether this connection carries the severable job POST.
        pendingDataListener = listener;
        return socket;
      }
      return originalOn(event, listener);
    };
    const originalWrite = socket.write.bind(socket);
    socket.write = function severedWrite(data, ...rest) {
      const result = originalWrite(data, ...rest);
      if (pendingDataListener !== null) {
        const listener = pendingDataListener;
        pendingDataListener = null;
        if (!severed && isSeveredJobPost(data)) {
          severed = true;
          if (mode === 'on-response') {
            // The first server bytes prove the admission committed; the
            // ack-boundary audit runs before the destroy, and the destroy
            // itself lands before the packaged client can parse the receipt.
            originalOn('data', () => {
              if (onAckSever) onAckSever();
              socket.destroy();
            });
          } else {
            // The request bytes were written; kill the transport before any
            // response can be processed. No data listener is attached, so
            // the receipt can never be parsed even if it arrives.
            setImmediate(() => socket.destroy());
          }
        } else {
          originalOn('data', listener);
        }
      }
      return result;
    };
    return socket;
  };
  return () => {
    tls.connect = originalConnect;
  };
}

function loadClient(contextName) {
  const store = openStore();
  const context = store.get(contextName);
  if (!context) {
    store.close();
    throw new Error('persisted context not found: ' + contextName);
  }
  return { store, client: createClient(context), context };
}

// The client-owned receipt an app persists before submitting: with it, a
// fresh process can replay the exact submission or resolve the job by its
// request key after the process died.
function writeReceipt(receiptFile, sandbox, submission) {
  fs.writeFileSync(receiptFile, JSON.stringify({
    version: 1,
    sandboxId: sandbox.sandboxId,
    workspaceId: sandbox.workspaceId,
    engine: sandbox.engine,
    submission,
  }), { mode: 0o600 });
}

// Sever-time audit for the ack boundary: from an independent store
// connection in this fresh process, check that the admission for the
// caller's own key is already committed at the instant the first response
// byte arrives. This pins the transport assumption the reconnect proof
// relies on: the daemon writes the response only after the admission
// transaction commits, so the first byte implies a committed admission.
function auditAdmission(stateDir, clientId, requestId) {
  const peer = openWorkStore(stateDir);
  try {
    const jobRows = peer.db
      .prepare('SELECT COUNT(*) AS n FROM jobs WHERE client_id = ? AND request_id = ?')
      .get(clientId, requestId).n;
    const submittedRows = peer.db
      .prepare(
        "SELECT COUNT(*) AS n FROM events WHERE type = 'job.submitted'" +
        ' AND job_id IN (SELECT job_id FROM jobs WHERE client_id = ? AND request_id = ?)'
      )
      .get(clientId, requestId).n;
    return { jobRows, submittedRows };
  } finally {
    peer.close();
  }
}

async function severSubmit(contextName, receiptFile, mode, stateDir) {
  let admissionAtSever = null;
  let submission = null;
  const restoreTls = armSever(mode, mode === 'on-response' ? () => {
    try {
      admissionAtSever = auditAdmission(stateDir, context.clientId, submission.requestId);
    } catch (error) {
      admissionAtSever = { error: error instanceof Error ? error.message : String(error) };
    }
  } : null);
  const { store, client, context } = loadClient(contextName);
  try {
    const sandbox = await client.requestResource('createSandbox', {}, {
      requestId: randomUUID(),
      engine: 'fixture',
      profile: 'dev',
    });
    submission = {
      requestId: randomUUID(),
      engine: sandbox.engine,
      payload: { prompt: 'reconnect-me' },
    };
    writeReceipt(receiptFile, sandbox, submission);

    let severedCode = null;
    let receiptLeaked = false;
    try {
      await client.requestResource('submitJob', { sandboxId: sandbox.sandboxId }, submission);
      receiptLeaked = true;
    } catch (error) {
      severedCode = error instanceof ClientError ? error.code : 'UNEXPECTED';
    }
    if (receiptLeaked || !EXPECTED_SEVER_CODES.has(severedCode)) {
      process.stdout.write(JSON.stringify({
        ok: false,
        phase: 'sever-submit',
        receiptLeaked,
        severedCode,
      }) + '\n');
      return 1;
    }
    process.stdout.write(JSON.stringify({
      ok: true,
      phase: 'sever-submit',
      severedCode,
      clientId: context.clientId,
      sandboxId: sandbox.sandboxId,
      requestId: submission.requestId,
      admissionAtSever,
    }) + '\n');
    return 0;
  } finally {
    store.close();
    restoreTls();
  }
}

// Create the caller's own-project sandbox and submit under a specific
// request key (or a fresh one). The caller's sandbox is provisioned in the
// caller's own project, so another principal's credential must admit its
// own independent job under the same request key the first principal used.
async function submitFresh(contextName, receiptFile, requestId) {
  if (requestId !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/.test(requestId)) {
    throw new Error('invalid request key: ' + String(requestId));
  }
  const { store, client, context } = loadClient(contextName);
  try {
    const sandbox = await client.requestResource('createSandbox', {}, {
      requestId: randomUUID(),
      engine: 'fixture',
      profile: 'dev',
    });
    const submission = {
      requestId: requestId ?? randomUUID(),
      engine: sandbox.engine,
      payload: { prompt: 'reconnect-me' },
    };
    writeReceipt(receiptFile, sandbox, submission);
    const job = await client.requestResource(
      'submitJob',
      { sandboxId: sandbox.sandboxId },
      submission,
    );
    process.stdout.write(JSON.stringify({
      ok: true,
      phase: 'submit-fresh',
      clientId: context.clientId,
      project: context.project,
      jobId: job.jobId,
      workspaceId: job.workspaceId,
      sandboxId: sandbox.sandboxId,
      requestId: submission.requestId,
    }) + '\n');
    return 0;
  } finally {
    store.close();
  }
}

// Create the sandbox and persist the fixed, not-yet-submitted request key.
async function prepareRace(contextName, receiptFile) {
  const { store, client, context } = loadClient(contextName);
  try {
    const sandbox = await client.requestResource('createSandbox', {}, {
      requestId: randomUUID(),
      engine: 'fixture',
      profile: 'dev',
    });
    const submission = {
      requestId: randomUUID(),
      engine: sandbox.engine,
      payload: { prompt: 'reconnect-me' },
    };
    writeReceipt(receiptFile, sandbox, submission);
    process.stdout.write(JSON.stringify({
      ok: true,
      phase: 'prepare-race',
      clientId: context.clientId,
      sandboxId: sandbox.sandboxId,
      requestId: submission.requestId,
    }) + '\n');
    return 0;
  } finally {
    store.close();
  }
}

// One uncoordinated racer: submit exactly the recorded submission and
// report the outcome. Exit 0 for either a receipt or a clean
// idempotency_conflict; anything else fails the run.
async function raceSubmit(contextName, receiptFile) {
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  const { store, client, context } = loadClient(contextName);
  try {
    try {
      const job = await client.requestResource(
        'submitJob',
        { sandboxId: receipt.sandboxId },
        receipt.submission,
      );
      process.stdout.write(JSON.stringify({
        ok: true,
        phase: 'race-submit',
        clientId: context.clientId,
        admitted: true,
        jobId: job.jobId,
        errorCode: null,
      }) + '\n');
      return 0;
    } catch (error) {
      const conflict = error instanceof ClientError &&
        error.code === 'HTTP_STATUS' &&
        error.statusCode === 409 &&
        error.resourceCode === 'idempotency_conflict';
      if (!conflict) throw error;
      process.stdout.write(JSON.stringify({
        ok: true,
        phase: 'race-submit',
        clientId: context.clientId,
        admitted: false,
        jobId: null,
        errorCode: error.resourceCode,
      }) + '\n');
      return 0;
    }
  } finally {
    store.close();
  }
}

async function reconnect(contextName, receiptFile, { lookupOnly = false, expectMissing = false } = {}) {
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  const { store, client, context } = loadClient(contextName);
  try {
    // Reconnect mechanism 1: replay the exact submission. The store's
    // duplicate-admission branch returns the persisted receipt when the
    // severed request committed; otherwise it admits the one missing job.
    const replay = lookupOnly || expectMissing ? null : await client.requestResource(
      'submitJob',
      { sandboxId: receipt.sandboxId },
      receipt.submission,
    );
    // Reconnect mechanism 2: explicit request-key lookup, scoped to this
    // client's own (project, clientId, requestId) key on the server.
    let lookup = null;
    let errorCode = null;
    if (expectMissing) {
      try {
        lookup = await client.requestResource('lookupJob', {}, {
          requestId: receipt.submission.requestId,
        });
      } catch (error) {
        if (!(error instanceof ClientError) || error.code !== 'HTTP_STATUS' ||
            error.statusCode !== 404 || error.resourceCode !== 'not_found') {
          throw error;
        }
        errorCode = error.resourceCode;
      }
    } else {
      lookup = await client.requestResource('lookupJob', {}, {
        requestId: receipt.submission.requestId,
      });
    }
    if (expectMissing) {
      if (errorCode !== 'not_found') {
        process.stdout.write(JSON.stringify({
          ok: false,
          phase: 'lookup-expect-missing',
          resolvedReceipt: lookup,
        }) + '\n');
        return 1;
      }
      process.stdout.write(JSON.stringify({
        ok: true,
        phase: 'lookup-expect-missing',
        clientId: context.clientId,
        lookup: null,
        errorCode,
      }) + '\n');
      return 0;
    }
    const events = await client.requestResource('getEvents', {
      jobId: lookup.jobId,
      after: '0',
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      phase: lookupOnly ? 'lookup-only' : 'reconnect',
      clientId: context.clientId,
      replay,
      lookup,
      events,
    }) + '\n');
    return 0;
  } finally {
    store.close();
  }
}

async function main(argv) {
  const [mode, contextName, receiptFile, severMode] = argv;
  if (mode === 'sever-submit') {
    if (!contextName || !receiptFile || (severMode !== 'on-response' && severMode !== 'after-request')) {
      throw new Error('usage: sever-submit <contextName> <receiptFile> <on-response|after-request>');
    }
    return severSubmit(contextName, receiptFile, severMode, process.env.ALPI_TEST_SERVER_STATE_DIR);
  }
  if (mode === 'reconnect') {
    if (!contextName || !receiptFile) {
      throw new Error('usage: reconnect <contextName> <receiptFile>');
    }
    return reconnect(contextName, receiptFile, { lookupOnly: false });
  }
  if (mode === 'lookup-only') {
    if (!contextName || !receiptFile) {
      throw new Error('usage: lookup-only <contextName> <receiptFile>');
    }
    return reconnect(contextName, receiptFile, { lookupOnly: true });
  }
  if (mode === 'lookup-expect-missing') {
    if (!contextName || !receiptFile) {
      throw new Error('usage: lookup-expect-missing <contextName> <receiptFile>');
    }
    return reconnect(contextName, receiptFile, { expectMissing: true });
  }
  if (mode === 'submit-fresh') {
    if (!contextName || !receiptFile) {
      throw new Error('usage: submit-fresh <contextName> <receiptFile> [requestId]');
    }
    return submitFresh(contextName, receiptFile, argv[3]);
  }
  if (mode === 'prepare-race') {
    if (!contextName || !receiptFile) {
      throw new Error('usage: prepare-race <contextName> <receiptFile>');
    }
    return prepareRace(contextName, receiptFile);
  }
  if (mode === 'race-submit') {
    if (!contextName || !receiptFile) {
      throw new Error('usage: race-submit <contextName> <receiptFile>');
    }
    return raceSubmit(contextName, receiptFile);
  }
  throw new Error('unknown mode: ' + String(mode));
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}).catch((error) => {
  process.stdout.write(JSON.stringify({
    ok: false,
    phase: 'unhandled',
    message: error && error.message ? error.message : String(error),
  }) + '\n');
  process.exitCode = 1;
});
