'use strict';

// Custom Node test reporter for factory/run-node-tests.cjs.
//
// Loads inside the `node --test` runner process (via --test-reporter) and
// forwards structured `test:summary` events as one framed JSON line per
// occurrence to file descriptor 3, keeping the two Node 24 summary kinds
// separate:
// - the coordinator-level summary (`data.file` absent, emitted exactly once)
//   is forwarded as kind 'alpi-node-test-aggregate';
// - per-file summaries (`data.file` set) are forwarded as kind
//   'alpi-node-test-file-summary'. Per-file summaries carry the file's real
//   declared-test counts. A file that declares no tests emits no per-file
//   summary at all (its only trace is the global file-wrapper count), which
//   the parent treats as an incomplete inventory, never as a passing file.
//
// Security notes (bounded, not a sandbox):
// - fd 3 is opened by the parent runner and is not inherited by stock test
//   worker processes (verified on Node 24.13.0 with default process
//   isolation), and test stdout/stderr reach the reporter only as
//   `test:stdout`/`test:stderr` events, which this reporter ignores. So text
//   printed by tests cannot forge aggregate or file-summary lines here.
// - This is NOT a sandbox or a general anti-forgery proof: same-UID hostile
//   code could still alter the test files or attack the parent process. The
//   caller must isolate the whole worker; process-only separation is not a
//   security boundary.
// - This reporter never throws: a throwing reporter crashes the test runner
//   (exit 7, no summary), so all emission is defensive. The parent fails
//   closed on missing/malformed/duplicate summaries regardless.
// - Duplicates are forwarded (up to explicit caps) rather than silently
//   deduplicated; the parent treats duplicates as an invalid report.

const fs = require('node:fs');

const AGGREGATE_KIND = 'alpi-node-test-aggregate';
const FILE_SUMMARY_KIND = 'alpi-node-test-file-summary';
const SUMMARY_VERSION = 1;
// Node emits exactly one coordinator summary; the caps only bound pathological
// streams while still letting the parent observe duplicates. The file cap
// matches the parent's MAX_FILES inventory bound.
const MAX_AGGREGATE_EMISSIONS = 8;
const MAX_FILE_SUMMARY_EMISSIONS = 256;

module.exports = async function* alpiNodeTestReporter(source) {
  let aggregates = 0;
  let fileSummaries = 0;
  let outputBytes = 0;
  let overflowSent = false;
  let omissionSent = false;
  const status = reason => fs.writeSync(3, JSON.stringify({ kind: 'alpi-node-test-status', v: 1, reason }) + '\n');
  for await (const event of source) {
    try {
      if (event?.type === 'test:stdout' || event?.type === 'test:stderr') {
        outputBytes += Buffer.byteLength(event.data?.message ?? '', 'utf8');
        if (outputBytes > 64 * 1024 && !overflowSent) {
          overflowSent = true;
          status('output-limit');
        }
      }
      if ((event?.type === 'test:pass' || event?.type === 'test:fail') && !omissionSent
        && ['skip', 'todo'].some(key => Object.hasOwn(event.data ?? {}, key) && event.data[key] !== false)) {
        omissionSent = true;
        status('not-passed');
      }
      if (
        event &&
        event.type === 'test:summary' &&
        event.data &&
        typeof event.data === 'object'
      ) {
        let kind = null;
        if (event.data.file === undefined) {
          if (aggregates < MAX_AGGREGATE_EMISSIONS) {
            aggregates += 1;
            kind = AGGREGATE_KIND;
          }
        } else if (typeof event.data.file === 'string' && !event.data.file.includes('\0')) {
          if (fileSummaries < MAX_FILE_SUMMARY_EMISSIONS) {
            fileSummaries += 1;
            kind = FILE_SUMMARY_KIND;
          }
        }
        if (kind !== null) {
          fs.writeSync(
            3,
            JSON.stringify({
              kind,
              v: SUMMARY_VERSION,
              data: event.data,
            }) + '\n'
          );
        }
      }
    } catch {
      // No fd 3 channel (standalone use) or non-serializable payload: stay
      // silent so the run still completes; the parent fails closed.
    }
    yield '';
  }
};
