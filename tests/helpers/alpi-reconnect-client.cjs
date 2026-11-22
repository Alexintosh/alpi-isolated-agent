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
function armSever(mode) {
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
            // The first server bytes prove the admission committed; destroy
            // before the packaged client can parse the receipt.
            originalOn('data', () => socket.destroy());
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

async function severSubmit(contextName, receiptFile, mode) {
  const restoreTls = armSever(mode);
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
    // The client-owned receipt an app would persist before submitting: with
      // it, a fresh process can replay the exact submission or resolve the
    // job by its request key after the process died.
    fs.writeFileSync(receiptFile, JSON.stringify({
      version: 1,
      sandboxId: sandbox.sandboxId,
      workspaceId: sandbox.workspaceId,
      engine: sandbox.engine,
      submission,
    }), { mode: 0o600 });

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
    }) + '\n');
    return 0;
  } finally {
    store.close();
    restoreTls();
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
    return severSubmit(contextName, receiptFile, severMode);
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
