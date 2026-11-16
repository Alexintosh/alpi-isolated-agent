'use strict';

// Bounded executable factory test runner (pilot, pinned to Node 24).
//
// Runs an explicitly supplied inventory of Node test files in one disposable
// `node --test` worker process and reports the real structured counts (via
// factory/node-test-reporter.cjs over a dedicated fd 3 channel) plus process
// status. It never parses human TAP/spec output and never treats text printed
// by tests as evidence.
//
// Evidence model: the reporter forwards the single coordinator-level
// `test:summary` (kind 'alpi-node-test-aggregate') separately from the
// per-file `test:summary` events (kind 'alpi-node-test-file-summary'). The
// global summary counts each file's runner wrapper as a test when the file
// declares none, so it alone cannot prove any test ran. The parent therefore
// requires exactly one well-formed per-file summary per expected canonical
// file (no missing, unknown or duplicate files), each with more than zero
// declared tests, and derives the reported counts and minimumTests check
// from the sum of those per-file declared counts, cross-checked against the
// global aggregate.
//
// THIS RUNNER IS NOT: a sandbox, a runner attestation, an independent
// acceptance oracle, or merge authorization. Same-UID hostile code could
// still alter the test files or attack this parent process; the caller must
// run untrusted tests in isolated workers with no secrets and obtain
// checkout/policy identity separately. Process-only separation is not a
// security boundary. No identity digest is computed here.
//
// API:
//   await runNodeTests({ cwd, files, timeoutMs = 60000, minimumTests = 1 })
//     -> { outcome, reason, exitCode, tests, durationMs }
//   outcome: 'pass' | 'fail' | 'blocked' | 'cancelled'
//   tests:   { discovered, passed, failed, skipped, cancelled, todo } | null
//   durationMs: wall-clock milliseconds of the call (integer)
//
// Fixed reason vocabulary (never a raw error, path, test name, or output):
//   blocked / 'invalid-input'      bad options; nothing is spawned (includes
//                                  duplicate inventory entries resolving to
//                                  the same canonical file)
//   blocked / 'unsupported-runtime' Node major is not the pinned 24
//   blocked / 'spawn-failed'       child process could not be launched
//   blocked / 'cleanup-unconfirmed' group ownership/completion was lost
//   blocked / 'timeout'            hard timeout hit; owned child group killed
//   blocked / 'output-limit'       child stdout+stderr exceeded 64 KiB
//   blocked / 'invalid-report'     missing / duplicate / malformed / unknown
//                                  aggregate or per-file summary, incomplete
//                                  per-file inventory, per-file vs aggregate
//                                  count mismatch, or report-channel overflow
//   fail    / 'nonzero-exit'       child exited nonzero (failure regardless
//                                  of what the summaries claim)
//   fail    / 'not-passed'         any summary success=false or any failed /
//                                  cancelled / skipped / todo test
//   fail    / 'zero-tests'         per-file declared tests sum to zero (an
//                                  empty file emits no per-file summary; its
//                                  global wrapper count is never credited)
//   fail    / 'below-minimum'      fewer per-file declared tests than
//                                  minimumTests
//   pass    / null                 exactly one valid aggregate plus one valid
//                                  per-file summary per expected file, all
//                                  success=true with >0 declared tests, exit
//                                  0, summed counts >= minimumTests, all
//                                  discovered passed, other counts zero
//
// CLI: node factory/run-node-tests.cjs --cwd <path> --timeout-ms <int>
//        --minimum-tests <int> -- <explicit test files...>
// Prints exactly one JSON record; exit 0 only on 'pass'.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPORTER_PATH = path.join(__dirname, 'node-test-reporter.cjs');
const AGGREGATE_KIND = 'alpi-node-test-aggregate';
const FILE_SUMMARY_KIND = 'alpi-node-test-file-summary';
const SUMMARY_VERSION = 1;
const SUPPORTED_NODE_MAJOR = 24;
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_MINIMUM_TESTS = 1;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 300000;
const MIN_MINIMUM_TESTS = 1;
const MAX_MINIMUM_TESTS = 1000000;
const MAX_FILES = 256;
const MAX_CHILD_OUTPUT_BYTES = 64 * 1024;
// Bounded report channel: up to MAX_FILES per-file summaries plus a few
// aggregate emissions, each a small framed JSON line.
const MAX_REPORT_BYTES = 256 * 1024;
const GLOB_META = /[*?[\]{}()!\\]/;
const COUNT_FIELDS = ['tests', 'failed', 'passed', 'cancelled', 'skipped', 'todo'];
const activeRuns = new Set();

// Keep the detached group leader alive until the parent kills its owned group.
// A finished Node coordinator may leave unref'ed descendants behind. Holding
// the leader prevents its PID/PGID being reused before cleanup is requested.
function supervise(files) {
  setInterval(() => {}, 60000);
  const report = value => {
    try { fs.writeSync(4, JSON.stringify(value) + '\n'); } catch { /* Parent owns cleanup. */ }
  };
  let child;
  try {
    child = spawn(process.execPath, ['--test', '--test-reporter=' + REPORTER_PATH, ...files], {
      stdio: ['ignore', 'inherit', 'inherit', 3], shell: false,
    });
  } catch { report({ code: null, signal: null, error: true }); return; }
  let error = false;
  child.on('error', () => { error = true; });
  child.on('exit', (code, signal) => report({ code, signal, error }));
}

function blockedRecord(reason) {
  return { outcome: 'blocked', reason, exitCode: null, tests: null, durationMs: 0 };
}

function isTestFileName(basename) {
  return basename.endsWith('.test.cjs') || basename.endsWith('.test.js');
}

function isWithin(root, target) {
  return target === root || target.startsWith(root + path.sep);
}

// Returns { ok: true, value } or { ok: false }. Never throws.
function validateOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    return { ok: false };
  }
  for (const key of Object.keys(options)) {
    if (key !== 'cwd' && key !== 'files' && key !== 'timeoutMs' && key !== 'minimumTests') {
      return { ok: false };
    }
  }

  if (typeof options.cwd !== 'string' || options.cwd.length === 0 || options.cwd.includes('\0')) {
    return { ok: false };
  }
  const cwd = path.resolve(options.cwd);
  let cwdStat;
  try {
    cwdStat = fs.statSync(cwd);
  } catch {
    return { ok: false };
  }
  if (!cwdStat.isDirectory()) return { ok: false };
  let realCwd;
  try {
    realCwd = fs.realpathSync(cwd);
  } catch {
    return { ok: false };
  }

  if (!Array.isArray(options.files) || options.files.length < 1 || options.files.length > MAX_FILES) {
    return { ok: false };
  }
  // Uniqueness and the spawn inventory are keyed on the canonical realpath,
  // resolved consistently with cwd. In-repo symlinks to distinct targets are
  // allowed; aliases of the same file are rejected before any spawn.
  const seen = new Set();
  const identities = new Set();
  const files = [];
  for (const entry of options.files) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.includes('\0')) return { ok: false };
    if (entry.startsWith('-')) return { ok: false }; // flag-like
    if (path.isAbsolute(entry)) return { ok: false };
    const segments = entry.split('/');
    if (segments.some((s) => s === '..' || s === '.')) return { ok: false };
    if (!isTestFileName(path.basename(entry))) return { ok: false };
    const abs = path.resolve(cwd, entry);
    if (!isWithin(cwd, abs)) return { ok: false };
    let real;
    try {
      real = fs.realpathSync(abs);
    } catch {
      return { ok: false }; // missing or broken link
    }
    if (!isWithin(realCwd, real)) return { ok: false }; // symlink escape
    // Node's CLI interprets even absolute arguments as glob patterns.
    if (GLOB_META.test(real)) return { ok: false };
    let st;
    try {
      st = fs.statSync(real, { bigint: true });
    } catch {
      return { ok: false };
    }
    if (!st.isFile()) return { ok: false };
    if (seen.has(real)) return { ok: false }; // duplicate canonical file
    const identity = `${st.dev}:${st.ino}`;
    if (identities.has(identity)) return { ok: false }; // hard-link alias
    identities.add(identity);
    seen.add(real);
    files.push(real); // spawn with canonical paths so reports match the inventory
  }

  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < MIN_TIMEOUT_MS ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    return { ok: false };
  }

  const minimumTests = options.minimumTests === undefined ? DEFAULT_MINIMUM_TESTS : options.minimumTests;
  if (
    !Number.isSafeInteger(minimumTests) ||
    minimumTests < MIN_MINIMUM_TESTS ||
    minimumTests > MAX_MINIMUM_TESTS
  ) {
    return { ok: false };
  }

  return { ok: true, value: { cwd, realCwd, files, timeoutMs, minimumTests } };
}

// Validates the shared `data` shape of both summary kinds.
// Returns { success, counts } or null. Never throws on JSON-parsed input.
function validateSummaryData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (typeof data.success !== 'boolean') return null;
  if (typeof data.duration_ms !== 'number' || !Number.isFinite(data.duration_ms) || data.duration_ms < 0) {
    return null;
  }
  const counts = data.counts;
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) return null;
  const values = {};
  for (const field of COUNT_FIELDS) {
    const value = counts[field];
    if (!Number.isSafeInteger(value) || value < 0) return null;
    values[field] = value;
  }
  if (
    values.failed + values.passed + values.skipped + values.todo + values.cancelled !==
    values.tests
  ) {
    return null; // internally inconsistent counts
  }
  return { success: data.success, counts: values };
}

function validateFramedRecord(record, kind) {
  if (
    !record ||
    typeof record !== 'object' ||
    Array.isArray(record) ||
    record.kind !== kind ||
    record.v !== SUMMARY_VERSION
  ) {
    return null;
  }
  return validateSummaryData(record.data);
}

// Validates one parsed coordinator aggregate record. Returns { success, counts } or null.
function validateAggregateRecord(record) {
  return validateFramedRecord(record, AGGREGATE_KIND);
}

// Validates one parsed per-file summary record. Returns
// { file, success, counts } or null.
function validateFileSummaryRecord(record) {
  const base = validateFramedRecord(record, FILE_SUMMARY_KIND);
  if (!base) return null;
  const file = record.data.file;
  if (typeof file !== 'string' || file.length === 0 || file.includes('\0')) return null;
  return { file, success: base.success, counts: base.counts };
}

// Maps a reported file path to its canonical form for inventory matching.
// Falls back to the resolved path when realpath fails (e.g. the file was
// removed mid-run); a mismatch then fails closed as an unknown file.
function canonicalizeReportedFile(file, realCwd) {
  const abs = path.resolve(realCwd, file);
  try {
    return fs.realpathSync(abs);
  } catch {
    return abs;
  }
}

function toTestsField(counts) {
  return {
    discovered: counts.tests,
    passed: counts.passed,
    failed: counts.failed,
    skipped: counts.skipped,
    cancelled: counts.cancelled,
    todo: counts.todo,
  };
}

function sumFileCounts(fileSummaries) {
  const totals = {};
  for (const field of COUNT_FIELDS) totals[field] = 0;
  for (const summary of fileSummaries.values()) {
    for (const field of COUNT_FIELDS) totals[field] += summary.counts[field];
  }
  return totals;
}

// Pure decision function over one run's observations (plus bounded
// filesystem canonicalization of reported file paths).
// forced: null | 'timeout' | 'output-limit' | 'invalid-report'
// expectedFiles: canonical absolute paths of the accepted inventory
function evaluateRunResult({
  forced,
  signal,
  exitCode,
  reportLines,
  reportOverflow,
  minimumTests,
  expectedFiles,
  realCwd,
}) {
  if (forced === 'cancelled') {
    return { outcome: 'cancelled', reason: 'signal', exitCode: null, tests: null };
  }
  // Forced terminations we initiated take precedence over the SIGKILL the
  // child will report, so their real cause is preserved.
  if (forced === 'timeout') {
    return { outcome: 'blocked', reason: 'timeout', exitCode: null, tests: null };
  }
  if (forced === 'output-limit') {
    return { outcome: 'blocked', reason: 'output-limit', exitCode: null, tests: null };
  }
  if (forced === 'invalid-report') {
    return { outcome: 'blocked', reason: 'invalid-report', exitCode: null, tests: null };
  }
  if (signal) {
    return { outcome: 'cancelled', reason: 'signal', exitCode: null, tests: null };
  }

  const expected = new Set(expectedFiles);
  const fileSummaries = new Map(); // canonical file -> { success, counts }
  let aggregate = null;
  let aggregateCount = 0;
  let malformed = false;
  let duplicateFile = false;
  let unknownFile = false;
  let omittedSuite = false;
  if (reportOverflow) malformed = true;
  for (const line of reportLines) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformed = true;
      continue;
    }
    if (parsed?.kind === 'alpi-node-test-status' && parsed.v === 1) {
      if (parsed.reason === 'output-limit') {
        return { outcome: 'blocked', reason: 'output-limit', exitCode, tests: null };
      }
      if (parsed.reason === 'not-passed') {
        omittedSuite = true;
        continue;
      }
      malformed = true;
      continue;
    }
    if (parsed && typeof parsed === 'object' && parsed.kind === FILE_SUMMARY_KIND) {
      const summary = validateFileSummaryRecord(parsed);
      if (!summary) {
        malformed = true;
        continue;
      }
      const canonical = canonicalizeReportedFile(summary.file, realCwd);
      if (!expected.has(canonical)) {
        unknownFile = true;
      } else if (fileSummaries.has(canonical)) {
        duplicateFile = true;
      } else {
        fileSummaries.set(canonical, { success: summary.success, counts: summary.counts });
      }
      continue;
    }
    const validated = validateAggregateRecord(parsed);
    if (!validated) {
      malformed = true;
      continue;
    }
    aggregateCount += 1;
    aggregate = validated;
  }

  // Declared-test evidence comes from the per-file summaries only; the
  // global wrapper count is never credited to an empty file.
  const fileTotals = fileSummaries.size > 0 ? sumFileCounts(fileSummaries) : null;
  const tests = fileTotals
    ? toTestsField(fileTotals)
    : aggregate
      ? toTestsField(aggregate.counts)
      : null;

  // Nonzero exit is a failure regardless of what the summaries claim.
  if (typeof exitCode !== 'number' || exitCode !== 0) {
    return {
      outcome: 'fail',
      reason: 'nonzero-exit',
      exitCode: typeof exitCode === 'number' ? exitCode : null,
      tests,
    };
  }
  // Exactly one well-formed aggregate and no malformed records are required.
  if (malformed || aggregateCount !== 1 || !aggregate) {
    return { outcome: 'blocked', reason: 'invalid-report', exitCode: 0, tests: null };
  }
  // Per-file summaries must map 1:1 onto the expected canonical inventory.
  if (duplicateFile || unknownFile) {
    return { outcome: 'blocked', reason: 'invalid-report', exitCode: 0, tests: null };
  }
  if (omittedSuite) {
    return { outcome: 'fail', reason: 'not-passed', exitCode: 0, tests };
  }
  // Zero declared tests across every reported file (including the empty-file
  // case, which reports no per-file summary at all) is never a pass.
  if (fileSummaries.size === 0 || fileTotals.tests === 0) {
    const zeroTests = toTestsField(
      fileTotals || { tests: 0, failed: 0, passed: 0, cancelled: 0, skipped: 0, todo: 0 }
    );
    return { outcome: 'fail', reason: 'zero-tests', exitCode: 0, tests: zeroTests };
  }
  // Every expected file must have declared its own tests; an incomplete
  // inventory (e.g. a valid file plus an empty one) is not success.
  if (fileSummaries.size !== expected.size) {
    return { outcome: 'blocked', reason: 'invalid-report', exitCode: 0, tests: null };
  }
  // Per-file summaries must individually be clean and non-empty.
  for (const summary of fileSummaries.values()) {
    const c = summary.counts;
    if (
      !summary.success ||
      c.tests === 0 ||
      c.failed > 0 ||
      c.cancelled > 0 ||
      c.skipped > 0 ||
      c.todo > 0 ||
      c.passed !== c.tests
    ) {
      return { outcome: 'fail', reason: 'not-passed', exitCode: 0, tests };
    }
  }
  if (!aggregate.success) {
    return { outcome: 'fail', reason: 'not-passed', exitCode: 0, tests };
  }
  const g = aggregate.counts;
  if (g.failed > 0 || g.cancelled > 0 || g.skipped > 0 || g.todo > 0 || g.passed !== g.tests) {
    return { outcome: 'fail', reason: 'not-passed', exitCode: 0, tests };
  }
  // With a complete inventory the aggregate must agree with the per-file sum.
  for (const field of COUNT_FIELDS) {
    if (g[field] !== fileTotals[field]) {
      return { outcome: 'blocked', reason: 'invalid-report', exitCode: 0, tests: null };
    }
  }
  if (fileTotals.tests < minimumTests) {
    return { outcome: 'fail', reason: 'below-minimum', exitCode: 0, tests };
  }
  return { outcome: 'pass', reason: null, exitCode: 0, tests };
}

function executeRun(opts, startedAt) {
  return new Promise((resolve) => {
    let settled = false;
    let childClosed = false;
    let childExited = false;
    let forced = null;
    let child = null;
    let timer = null;
    let outputBytes = 0;
    let reportBytes = 0;
    let reportOverflow = false;
    let reportBuffer = '';
    let completionBuffer = '';
    let completion = null;
    let cleanupSent = false;
    const reportLines = [];

    const killOwnedGroup = () => {
      if (!child || !child.pid || childExited || childClosed || cleanupSent) return;
      try {
        process.kill(-child.pid, 'SIGKILL'); // owned detached process group
        cleanupSent = true;
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }
    };

    const terminate = (reason) => {
      if (settled || forced) return;
      forced = reason;
      killOwnedGroup();
    };
    const cancel = () => terminate('cancelled');

    const consumeReportChunk = (chunk) => {
      reportBytes += chunk.length;
      if (reportBytes > MAX_REPORT_BYTES) {
        reportOverflow = true;
        terminate('invalid-report');
        return;
      }
      reportBuffer += chunk.toString('utf8');
      let idx;
      while ((idx = reportBuffer.indexOf('\n')) !== -1) {
        const line = reportBuffer.slice(0, idx);
        reportBuffer = reportBuffer.slice(idx + 1);
        if (line.length > 0) {
          reportLines.push(line);
          try {
            const status = JSON.parse(line);
            if (status.kind === 'alpi-node-test-status' && status.v === 1 && status.reason === 'output-limit') {
              terminate('output-limit');
            }
          } catch { /* Final report validation rejects malformed lines. */ }
        }
      }
    };

    const settle = (record) => {
      if (settled) return;
      settled = true;
      activeRuns.delete(cancel);
      if (timer) clearTimeout(timer);
      if (!childClosed) killOwnedGroup(); // never re-signal a reaped group (pgid reuse)
      resolve({ ...record, durationMs: Math.max(0, Date.now() - startedAt) });
    };

    let spawnError = null;
    try {
      const env = { ...process.env };
      delete env.NODE_OPTIONS; // child isolation
      delete env.NODE_TEST_CONTEXT;
      child = spawn(
        process.execPath,
        [__filename, '--supervise', ...opts.files],
        {
          cwd: opts.cwd,
          env,
          stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
          detached: true, // own process group so cleanup kills only our tree
          shell: false,
        }
      );
    } catch {
      settle({ outcome: 'blocked', reason: 'spawn-failed', exitCode: null, tests: null });
      return;
    }

    child.on('error', () => {
      spawnError = true;
    });
    child.on('exit', () => { childExited = true; });
    activeRuns.add(cancel);
    child.stdio[4].on('data', chunk => {
      completionBuffer += chunk.toString('utf8');
      if (completionBuffer.length > 1024) { terminate('invalid-report'); return; }
      if (!completionBuffer.includes('\n')) return;
      try {
        const value = JSON.parse(completionBuffer.trim());
        if (completion || typeof value.error !== 'boolean'
          || !(value.code === null || (Number.isInteger(value.code) && value.code >= 0 && value.code <= 255))
          || !(value.signal === null || typeof value.signal === 'string')) throw new Error();
        completion = value;
        killOwnedGroup();
      } catch { terminate('invalid-report'); }
    });

    const countOutput = (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_CHILD_OUTPUT_BYTES) terminate('output-limit');
    };
    child.stdout.on('data', countOutput);
    child.stderr.on('data', countOutput);
    child.stdio[3].on('data', consumeReportChunk);

    timer = setTimeout(() => terminate('timeout'), opts.timeoutMs);

    child.on('close', (code, signalName) => {
      childClosed = true;
      if (settled) return;
      if (spawnError || completion?.error) {
        settle({ outcome: 'blocked', reason: 'spawn-failed', exitCode: null, tests: null });
        return;
      }
      if (!forced && (!completion || !cleanupSent)) {
        settle({ outcome: 'blocked', reason: 'cleanup-unconfirmed', exitCode: code, tests: null });
        return;
      }
      if (reportBuffer.length > 0) {
        reportLines.push(reportBuffer); // unterminated tail counts as a line
        reportBuffer = '';
      }
      settle(
        evaluateRunResult({
          forced,
          signal: completion ? completion.signal : signalName,
          exitCode: completion ? completion.code : code,
          reportLines,
          reportOverflow,
          minimumTests: opts.minimumTests,
          expectedFiles: opts.files,
          realCwd: opts.realCwd,
        })
      );
    });
  });
}

async function runNodeTests(options) {
  const startedAt = Date.now();
  const validated = validateOptions(options);
  if (!validated.ok) return blockedRecord('invalid-input');
  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (major !== SUPPORTED_NODE_MAJOR) return blockedRecord('unsupported-runtime');
  return executeRun(validated.value, startedAt);
}

// CLI --------------------------------------------------------------------

function parseCliArgv(argv) {
  const seen = new Set();
  const options = {};
  let i = 0;
  let sawSeparator = false;
  for (; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      sawSeparator = true;
      i += 1;
      break;
    }
    if (arg !== '--cwd' && arg !== '--timeout-ms' && arg !== '--minimum-tests') {
      return { ok: false }; // unknown flag or positional before '--'
    }
    if (seen.has(arg)) return { ok: false }; // duplicate flag
    seen.add(arg);
    const value = argv[i + 1];
    if (value === undefined) return { ok: false }; // missing value
    i += 1;
    if (arg === '--cwd') {
      options.cwd = value;
    } else {
      if (!/^\d+$/.test(value)) return { ok: false };
      const num = Number(value);
      if (!Number.isSafeInteger(num)) return { ok: false };
      if (arg === '--timeout-ms') options.timeoutMs = num;
      else options.minimumTests = num;
    }
  }
  if (!sawSeparator) return { ok: false };
  const files = argv.slice(i);
  if (files.length < 1) return { ok: false };
  options.files = files;
  return { ok: true, value: options };
}

async function main() {
  const parsed = parseCliArgv(process.argv.slice(2));
  const result = parsed.ok
    ? await runNodeTests(parsed.value)
    : blockedRecord('invalid-input');
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = result.outcome === 'pass' ? 0 : 1;
}

module.exports = {
  runNodeTests,
  // Test-only internals (pure functions; no side effects).
  __internals: {
    validateOptions,
    validateAggregateRecord,
    validateFileSummaryRecord,
    evaluateRunResult,
    parseCliArgv,
  },
};

if (require.main === module && process.argv[2] === '--supervise') {
  supervise(process.argv.slice(3));
} else if (require.main === module) {
  const cancel = () => { for (const abort of activeRuns) abort(); };
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  main().catch(() => {
    process.stdout.write(JSON.stringify(blockedRecord('spawn-failed')) + '\n');
    process.exitCode = 1;
  }).finally(() => {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  });
}
