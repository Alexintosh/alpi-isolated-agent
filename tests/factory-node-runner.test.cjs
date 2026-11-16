'use strict';

// Acceptance tests for factory/run-node-tests.cjs and
// factory/node-test-reporter.cjs.
//
// All execution tests spawn REAL Node child processes against synthetic test
// files in temporary directories. No mocks pretend to be process execution.
// The reporter is additionally exercised directly (duplicate/malformed
// synthetic events) via separate real Node helper children with an fd-3 pipe.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runNodeTests, __internals } = require('../factory/run-node-tests.cjs');
const RUNNER_CLI = path.join(__dirname, '..', 'factory', 'run-node-tests.cjs');
const REPORTER = path.join(__dirname, '..', 'factory', 'node-test-reporter.cjs');

const tempDirs = [];
function makeTempDir(prefix = 'alpi-ntr-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeTestFile(dir, name, body) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return name; // relative to dir, as the runner expects
}

function passingProject() {
  const dir = makeTempDir();
  writeTestFile(
    dir,
    'a.test.cjs',
    `'use strict';
const { test } = require('node:test');
test('one', () => {});
test('two', async (t) => { await t.test('nested', () => {}); });
`
  );
  return { dir, files: ['a.test.cjs'] };
}

// --- structured aggregate reporting --------------------------------------

test('passing suite with nested tests reports real aggregate counts', async () => {
  const { dir, files } = passingProject();
  const result = await runNodeTests({ cwd: dir, files });
  assert.equal(result.outcome, 'pass');
  assert.equal(result.reason, null);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.tests, {
    discovered: 3,
    passed: 3,
    failed: 0,
    skipped: 0,
    cancelled: 0,
    todo: 0,
  });
  assert.ok(Number.isSafeInteger(result.durationMs) && result.durationMs >= 0);
});

test('failing test fails with real counts and nonzero exit', async () => {
  const dir = makeTempDir();
  writeTestFile(
    dir,
    'a.test.cjs',
    `'use strict';
const { test } = require('node:test');
test('ok', () => {});
test('bad', () => { throw new Error('boom'); });
`
  );
  const result = await runNodeTests({ cwd: dir, files: ['a.test.cjs'] });
  assert.equal(result.outcome, 'fail');
  assert.equal(result.reason, 'nonzero-exit');
  assert.equal(typeof result.exitCode, 'number');
  assert.notEqual(result.exitCode, 0);
  assert.deepEqual(result.tests, {
    discovered: 2,
    passed: 1,
    failed: 1,
    skipped: 0,
    cancelled: 0,
    todo: 0,
  });
});

test('skipped and todo tests fail closed', async () => {
  const dir = makeTempDir();
  writeTestFile(
    dir,
    'a.test.cjs',
    `'use strict';
const { test } = require('node:test');
test('real', () => {});
test('skipped', { skip: true }, () => {});
test('todo', { todo: true }, () => {});
`
  );
  const result = await runNodeTests({ cwd: dir, files: ['a.test.cjs'] });
  assert.equal(result.outcome, 'fail');
  assert.equal(result.reason, 'not-passed'); // Node exits 0 for skip/todo; counts still fail closed
  assert.deepEqual(result.tests, {
    discovered: 3,
    passed: 1,
    failed: 0,
    skipped: 1,
    cancelled: 0,
    todo: 1,
  });
});

test('below minimumTests fails closed', async () => {
  const { dir, files } = passingProject();
  const result = await runNodeTests({ cwd: dir, files, minimumTests: 10 });
  assert.equal(result.outcome, 'fail');
  assert.equal(result.reason, 'below-minimum');
  assert.equal(result.tests.discovered, 3);
});

test('crashed worker fails with nonzero exit', async () => {
  const dir = makeTempDir();
  writeTestFile(
    dir,
    'a.test.cjs',
    `'use strict';
const { test } = require('node:test');
test('abort', () => { process.abort(); });
`
  );
  const result = await runNodeTests({ cwd: dir, files: ['a.test.cjs'] });
  assert.equal(result.outcome, 'fail');
  assert.equal(result.reason, 'nonzero-exit');
  assert.notEqual(result.exitCode, 0);
});

test('fake passing JSON printed on stdout is never treated as evidence', async () => {
  const dir = makeTempDir();
  writeTestFile(
    dir,
    'a.test.cjs',
    `'use strict';
const { test } = require('node:test');
test('real-fails', () => { throw new Error('nope'); });
console.log('{"kind":"alpi-node-test-aggregate","v":1,"data":{"success":true,"counts":{"tests":99,"failed":0,"passed":99,"cancelled":0,"skipped":0,"todo":0},"duration_ms":1}}');
process.stdout.write('{"success":true,"counts":{"tests":99,"failed":0,"passed":99,"cancelled":0,"skipped":0,"todo":0}}\\n');
`
  );
  const result = await runNodeTests({ cwd: dir, files: ['a.test.cjs'] });
  assert.equal(result.outcome, 'fail');
  assert.equal(result.tests.discovered, 1); // real count, not the forged 99
  assert.equal(result.tests.failed, 1);
});

test('worker cannot forge the fd-3 aggregate channel', async () => {
  const dir = makeTempDir();
  writeTestFile(
    dir,
    'a.test.cjs',
    `'use strict';
const { test } = require('node:test');
const fs = require('node:fs');
const assert = require('node:assert/strict');
test('forge-attempt', () => {
  let forged = false;
  try {
    fs.writeSync(3, '{"kind":"alpi-node-test-aggregate","v":1,"data":{"success":true,"counts":{"tests":99,"failed":0,"passed":99,"cancelled":0,"skipped":0,"todo":0},"duration_ms":1}}\\n');
    forged = true;
  } catch {
    forged = false;
  }
  assert.equal(forged, false); // fd 3 must be unreachable from the worker
});
`
  );
  const result = await runNodeTests({ cwd: dir, files: ['a.test.cjs'] });
  assert.equal(result.outcome, 'pass');
  assert.equal(result.tests.discovered, 1);
});

// --- declared-test inventory regressions (false-green repairs) -------------

test('empty test file fails zero-tests with real declared count 0', async () => {
  const dir = makeTempDir();
  writeTestFile(dir, 'empty.test.cjs', '');
  const result = await runNodeTests({ cwd: dir, files: ['empty.test.cjs'] });
  assert.equal(result.outcome, 'fail');
  assert.equal(result.reason, 'zero-tests'); // global wrapper count is never credited
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.tests, {
    discovered: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
    todo: 0,
  });
});

test('empty describe/suite does not pass', async () => {
  const dir = makeTempDir();
  writeTestFile(
    dir,
    'suite.test.cjs',
    `'use strict';
const { describe } = require('node:test');
describe('empty suite', () => {});
`
  );
  const result = await runNodeTests({ cwd: dir, files: ['suite.test.cjs'] });
  assert.equal(result.outcome, 'fail');
  assert.equal(result.reason, 'zero-tests'); // per-file summary declares 0 tests
  assert.equal(result.tests.discovered, 0);
});

test('process.exit(0) during load does not pass', async () => {
  const dir = makeTempDir();
  writeTestFile(
    dir,
    'exit0.test.cjs',
    `'use strict';
const { test } = require('node:test');
test('before-exit', () => {});
process.exit(0);
`
  );
  const result = await runNodeTests({ cwd: dir, files: ['exit0.test.cjs'] });
  assert.equal(result.outcome, 'fail'); // no per-file summary: wrapper count rejected
  assert.equal(result.reason, 'zero-tests');
  assert.equal(result.tests.discovered, 0);
});

test('mixed valid and empty file fails on incomplete inventory', async () => {
  const dir = makeTempDir();
  writeTestFile(
    dir,
    'one.test.cjs',
    "'use strict';\nconst { test } = require('node:test');\ntest('one', () => {});\n"
  );
  writeTestFile(dir, 'empty.test.cjs', '');
  const result = await runNodeTests({ cwd: dir, files: ['one.test.cjs', 'empty.test.cjs'] });
  assert.equal(result.outcome, 'blocked'); // missing required per-file summary
  assert.equal(result.reason, 'invalid-report');
  assert.equal(result.tests, null);
});

test('symlink alias of the same canonical file is rejected before spawn', async () => {
  const dir = makeTempDir();
  const marker = path.join(dir, 'loaded.marker');
  writeTestFile(
    dir,
    'one.test.cjs',
    `'use strict';
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(marker)}, 'loaded');
const { test } = require('node:test');
test('one', () => {});
`
  );
  fs.symlinkSync(path.join(dir, 'one.test.cjs'), path.join(dir, 'alias.test.cjs'));
  const result = await runNodeTests({ cwd: dir, files: ['one.test.cjs', 'alias.test.cjs'] });
  assert.deepEqual(result, {
    outcome: 'blocked',
    reason: 'invalid-input',
    exitCode: null,
    tests: null,
    durationMs: 0,
  });
  assert.equal(fs.existsSync(marker), false); // zero dispatch: nothing was ever loaded
});

test('unique in-repo symlink entry is allowed and passes', async () => {
  const dir = makeTempDir();
  writeTestFile(
    dir,
    'sub/target.test.cjs',
    "'use strict';\nconst { test } = require('node:test');\ntest('one', () => {});\n"
  );
  fs.symlinkSync(path.join(dir, 'sub', 'target.test.cjs'), path.join(dir, 'link.test.cjs'));
  const result = await runNodeTests({ cwd: dir, files: ['link.test.cjs'] });
  assert.equal(result.outcome, 'pass');
  assert.equal(result.tests.discovered, 1);
});

test('multi-file inventory passes with summed per-file declared counts', async () => {
  const dir = makeTempDir();
  writeTestFile(
    dir,
    'a.test.cjs',
    `'use strict';
const { test } = require('node:test');
test('one', async (t) => { await t.test('n1', () => {}); await t.test('n2', () => {}); });
`
  );
  writeTestFile(
    dir,
    'b.test.cjs',
    "'use strict';\nconst { test } = require('node:test');\ntest('solo', () => {});\n"
  );
  const result = await runNodeTests({ cwd: dir, files: ['a.test.cjs', 'b.test.cjs'] });
  assert.equal(result.outcome, 'pass');
  assert.deepEqual(result.tests, {
    discovered: 4,
    passed: 4,
    failed: 0,
    skipped: 0,
    cancelled: 0,
    todo: 0,
  });
});

// --- process status --------------------------------------------------------

test('hung test times out and the owned child group is cleaned up', async () => {
  const dir = makeTempDir();
  const pidFile = path.join(dir, 'worker.pid');
  writeTestFile(
    dir,
    'hang.test.cjs',
    `'use strict';
const { test } = require('node:test');
const fs = require('node:fs');
test('hang', () => {
  fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
  setInterval(() => {}, 1000);
});
`
  );
  const result = await runNodeTests({ cwd: dir, files: ['hang.test.cjs'], timeoutMs: 1500 });
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.reason, 'timeout');
  assert.equal(result.exitCode, null);
  assert.equal(result.tests, null);
  const workerPid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(workerPid > 0);
  assert.throws(() => process.kill(workerPid, 0), (err) => err.code === 'ESRCH');
});

test('child killed by an external signal reports cancelled/signal', async () => {
  const dir = makeTempDir();
  writeTestFile(
    dir,
    'a.test.cjs',
    `'use strict';
const { test } = require('node:test');
test('kill-runner', () => { process.kill(process.ppid, 'SIGKILL'); });
`
  );
  const result = await runNodeTests({ cwd: dir, files: ['a.test.cjs'] });
  assert.equal(result.outcome, 'cancelled');
  assert.equal(result.reason, 'signal');
  assert.equal(result.exitCode, null);
});

// --- child isolation ---------------------------------------------------------

test('inherited NODE_OPTIONS is stripped from the child', async () => {
  const { dir, files } = passingProject();
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = '--definitely-not-a-real-node-flag';
  try {
    const result = await runNodeTests({ cwd: dir, files });
    assert.equal(result.outcome, 'pass'); // would be nonzero-exit if inherited
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
  }
});

// --- input validation (must never spawn) -------------------------------------

test('invalid file inventory entries are rejected', async () => {
  const dir = makeTempDir();
  const outside = makeTempDir('alpi-ntr-outside-');
  writeTestFile(outside, 'secret.test.cjs', "'use strict';\n");
  writeTestFile(dir, 'good.test.cjs', "'use strict';\nconst { test } = require('node:test');\ntest('x', () => {});\n");
  fs.symlinkSync(path.join(outside, 'secret.test.cjs'), path.join(dir, 'escape.test.cjs'));
  fs.symlinkSync(path.join(dir, 'good.test.cjs'), path.join(dir, 'alias.test.cjs'));
  fs.mkdirSync(path.join(dir, 'adir.test.cjs'));
  writeTestFile(dir, 'notatest.cjs', "'use strict';\n");

  const badCases = {
    'absolute path': [path.join(dir, 'good.test.cjs')],
    'parent traversal': ['../outside.test.cjs'],
    'flag-like entry': ['--test-reporter=tap'],
    'flag-like basename': ['-x.test.cjs'],
    'missing file': ['nope.test.cjs'],
    'symlink escape outside cwd': ['escape.test.cjs'],
    'symlink alias of same file': ['good.test.cjs', 'alias.test.cjs'],
    'directory instead of file': ['adir.test.cjs'],
    'wrong extension': ['notatest.cjs'],
    'duplicate entries': ['good.test.cjs', 'good.test.cjs'],
    'empty inventory': [],
    'non-string entry': [42],
  };
  for (const [label, files] of Object.entries(badCases)) {
    const result = await runNodeTests({ cwd: dir, files });
    assert.deepEqual(
      result,
      { outcome: 'blocked', reason: 'invalid-input', exitCode: null, tests: null, durationMs: 0 },
      label
    );
  }
});

test('invalid options are rejected without spawning', async () => {
  const { dir, files } = passingProject();
  const badOptionSets = [
    undefined,
    null,
    'not-an-object',
    [],
    { files }, // missing cwd
    { cwd: path.join(dir, 'does-not-exist'), files },
    { cwd: path.join(dir, 'a.test.cjs'), files }, // cwd is a file
    { cwd: dir, files, timeoutMs: 50 },
    { cwd: dir, files, timeoutMs: 300001 },
    { cwd: dir, files, timeoutMs: 1000.5 },
    { cwd: dir, files, timeoutMs: '1000' },
    { cwd: dir, files, minimumTests: 0 },
    { cwd: dir, files, minimumTests: 1000001 },
    { cwd: dir, files, unknownOption: true },
    { cwd: dir, files: Array.from({ length: 257 }, (_, i) => `t${i}.test.cjs`) },
  ];
  for (const options of badOptionSets) {
    const result = await runNodeTests(options);
    assert.deepEqual(
      result,
      { outcome: 'blocked', reason: 'invalid-input', exitCode: null, tests: null, durationMs: 0 }
    );
  }
});

test('module import does not mutate process.exitCode', async () => {
  const before = process.exitCode;
  const dir = makeTempDir();
  writeTestFile(
    dir,
    'a.test.cjs',
    "'use strict';\nconst { test } = require('node:test');\ntest('x', () => { throw new Error('y'); });\n"
  );
  const result = await runNodeTests({ cwd: dir, files: ['a.test.cjs'] });
  assert.equal(result.outcome, 'fail');
  assert.equal(process.exitCode, before);
});

// --- reporter unit coverage via real helper children --------------------------

function runReporterHelper(eventLiterals, { withFd3 = true } = {}) {
  return new Promise((resolve, reject) => {
    const dir = makeTempDir('alpi-ntr-helper-');
    const script = path.join(dir, 'helper.cjs');
    fs.writeFileSync(
      script,
      `'use strict';
const reporter = require(${JSON.stringify(REPORTER)});
const events = ${eventLiterals};
(async () => {
  const source = (async function* () { for (const e of events) yield e; })();
  for await (const _ of reporter(source)) { /* drain */ }
})().catch((err) => { process.stderr.write(String(err) + '\\n'); process.exitCode = 9; });
`
    );
    const child = spawn(process.execPath, [script], {
      stdio: ['ignore', 'pipe', 'pipe', withFd3 ? 'pipe' : 'ignore'],
    });
    let fd3 = '';
    let stderr = '';
    if (withFd3) child.stdio[3].on('data', (d) => { fd3 += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, fd3, stderr }));
  });
}

const GOOD_DATA =
  '{success:true,counts:{tests:2,failed:0,passed:2,cancelled:0,skipped:0,todo:0},duration_ms:1.5}';
const GOOD_FILE_DATA = '{file:"/x/a.test.cjs",' + GOOD_DATA.slice(1);

// Synthetic decision-table context: paths need not exist; canonicalization
// falls back to the resolved path.
const SYNTH_CWD = '/x';
const SYNTH_EXPECTED = ['/x/a.test.cjs'];

test('reporter forwards per-file and coordinator summaries as distinct kinds', async () => {
  const events =
    '[{type:"test:summary",data:' + GOOD_FILE_DATA + '},' +
    '{type:"test:summary",data:' + GOOD_DATA + '},' +
    '{type:"test:stdout",data:{message:"fake"}}]';
  const { code, fd3, stderr } = await runReporterHelper(events);
  assert.equal(code, 0);
  assert.equal(stderr, '');
  const lines = fd3.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 2); // stdout events ignored
  const fileRecord = JSON.parse(lines[0]);
  assert.equal(fileRecord.kind, 'alpi-node-test-file-summary');
  assert.equal(fileRecord.v, 1);
  assert.equal(fileRecord.data.file, '/x/a.test.cjs');
  assert.equal(__internals.validateFileSummaryRecord(fileRecord) !== null, true);
  const aggregateRecord = JSON.parse(lines[1]);
  assert.equal(aggregateRecord.kind, 'alpi-node-test-aggregate');
  assert.equal(aggregateRecord.v, 1);
  assert.equal(aggregateRecord.data.counts.tests, 2);
  assert.equal(__internals.validateAggregateRecord(aggregateRecord) !== null, true);
});

test('reporter forwards duplicate coordinator summaries so the parent can fail closed', async () => {
  const events = '[{type:"test:summary",data:' + GOOD_DATA + '},' +
    '{type:"test:summary",data:' + GOOD_DATA + '}]';
  const { code, fd3 } = await runReporterHelper(events);
  assert.equal(code, 0);
  const lines = fd3.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 2);
  const verdict = __internals.evaluateRunResult({
    forced: null,
    signal: null,
    exitCode: 0,
    reportLines: lines,
    reportOverflow: false,
    minimumTests: 1,
    expectedFiles: SYNTH_EXPECTED,
    realCwd: SYNTH_CWD,
  });
  assert.equal(verdict.outcome, 'blocked');
  assert.equal(verdict.reason, 'invalid-report');
});

test('reporter forwards duplicate per-file summaries so the parent can fail closed', async () => {
  const events = '[{type:"test:summary",data:' + GOOD_FILE_DATA + '},' +
    '{type:"test:summary",data:' + GOOD_FILE_DATA + '},' +
    '{type:"test:summary",data:' + GOOD_DATA + '}]';
  const { code, fd3 } = await runReporterHelper(events);
  assert.equal(code, 0);
  const lines = fd3.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 3);
  const verdict = __internals.evaluateRunResult({
    forced: null,
    signal: null,
    exitCode: 0,
    reportLines: lines,
    reportOverflow: false,
    minimumTests: 1,
    expectedFiles: SYNTH_EXPECTED,
    realCwd: SYNTH_CWD,
  });
  assert.equal(verdict.outcome, 'blocked');
  assert.equal(verdict.reason, 'invalid-report'); // duplicate file summary
});

test('parent rejects a missing per-file summary for an expected file', async () => {
  // One valid per-file summary for a and the aggregate, but the inventory
  // also expected b.test.cjs (e.g. an empty file emitted no summary).
  const events = '[{type:"test:summary",data:' + GOOD_FILE_DATA + '},' +
    '{type:"test:summary",data:' + GOOD_DATA + '}]';
  const { code, fd3 } = await runReporterHelper(events);
  assert.equal(code, 0);
  const lines = fd3.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 2);
  const verdict = __internals.evaluateRunResult({
    forced: null,
    signal: null,
    exitCode: 0,
    reportLines: lines,
    reportOverflow: false,
    minimumTests: 1,
    expectedFiles: ['/x/a.test.cjs', '/x/b.test.cjs'],
    realCwd: SYNTH_CWD,
  });
  assert.equal(verdict.outcome, 'blocked');
  assert.equal(verdict.reason, 'invalid-report'); // incomplete inventory
});

test('parent rejects a per-file summary for an unexpected file identifier', async () => {
  const events = '[{type:"test:summary",data:{file:"/x/evil.test.cjs",' +
    'success:true,counts:{tests:9,failed:0,passed:9,cancelled:0,skipped:0,todo:0},duration_ms:1}},' +
    '{type:"test:summary",data:' + GOOD_DATA + '}]';
  const { code, fd3 } = await runReporterHelper(events);
  assert.equal(code, 0);
  const lines = fd3.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 2);
  const verdict = __internals.evaluateRunResult({
    forced: null,
    signal: null,
    exitCode: 0,
    reportLines: lines,
    reportOverflow: false,
    minimumTests: 1,
    expectedFiles: SYNTH_EXPECTED,
    realCwd: SYNTH_CWD,
  });
  assert.equal(verdict.outcome, 'blocked');
  assert.equal(verdict.reason, 'invalid-report'); // unknown file
});

test('reporter forwards malformed aggregate data untouched; parent rejects it', async () => {
  const events = '[{type:"test:summary",data:{success:"yes",counts:{tests:"2"}}}]';
  const { code, fd3 } = await runReporterHelper(events);
  assert.equal(code, 0);
  const lines = fd3.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(__internals.validateAggregateRecord(parsed), null);
  const verdict = __internals.evaluateRunResult({
    forced: null,
    signal: null,
    exitCode: 0,
    reportLines: lines,
    reportOverflow: false,
    minimumTests: 1,
    expectedFiles: SYNTH_EXPECTED,
    realCwd: SYNTH_CWD,
  });
  assert.equal(verdict.reason, 'invalid-report');
});

test('reporter does not throw when fd 3 is absent', async () => {
  const events = '[{type:"test:summary",data:' + GOOD_DATA + '}]';
  const { code, stderr } = await runReporterHelper(events, { withFd3: false });
  assert.equal(code, 0);
  assert.equal(stderr, '');
});

// --- decision-table coverage for paths not producible by stock Node ----------

test('decision table: missing report, zero tests, output limit, signal precedence', () => {
  const base = {
    forced: null,
    signal: null,
    exitCode: 0,
    reportLines: [],
    reportOverflow: false,
    minimumTests: 1,
    expectedFiles: SYNTH_EXPECTED,
    realCwd: SYNTH_CWD,
  };
  const goodLine = JSON.stringify({
    kind: 'alpi-node-test-aggregate',
    v: 1,
    data: { success: true, counts: { tests: 0, failed: 0, passed: 0, cancelled: 0, skipped: 0, todo: 0 }, duration_ms: 1 },
  });

  assert.equal(__internals.evaluateRunResult({ ...base }).reason, 'invalid-report');
  assert.equal(__internals.evaluateRunResult({ ...base, reportLines: ['not json'] }).reason, 'invalid-report');
  assert.equal(
    __internals.evaluateRunResult({
      ...base,
      reportLines: [JSON.stringify({ kind: 'other', v: 1, data: {} })],
    }).reason,
    'invalid-report'
  );
  assert.equal(
    __internals.evaluateRunResult({ ...base, reportOverflow: true, reportLines: [goodLine] }).reason,
    'invalid-report'
  );
  assert.equal(__internals.evaluateRunResult({ ...base, reportLines: [goodLine] }).reason, 'zero-tests');
  assert.equal(
    __internals.evaluateRunResult({ ...base, forced: 'timeout', signal: 'SIGKILL', reportLines: [goodLine] }).reason,
    'timeout'
  );
  assert.equal(
    __internals.evaluateRunResult({ ...base, forced: 'output-limit', signal: 'SIGKILL' }).reason,
    'output-limit'
  );
  assert.equal(
    __internals.evaluateRunResult({ ...base, forced: 'invalid-report', signal: 'SIGKILL' }).reason,
    'invalid-report'
  );
  assert.deepEqual(
    __internals.evaluateRunResult({ ...base, signal: 'SIGTERM' }),
    { outcome: 'cancelled', reason: 'signal', exitCode: null, tests: null }
  );
  // nonzero exit wins over summary claims
  const failLine = JSON.stringify({
    kind: 'alpi-node-test-aggregate',
    v: 1,
    data: { success: true, counts: { tests: 5, failed: 0, passed: 5, cancelled: 0, skipped: 0, todo: 0 }, duration_ms: 1 },
  });
  const nonzero = __internals.evaluateRunResult({ ...base, exitCode: 1, reportLines: [failLine] });
  assert.equal(nonzero.outcome, 'fail');
  assert.equal(nonzero.reason, 'nonzero-exit');
  assert.equal(nonzero.tests.discovered, 5);
  // inconsistent counts are malformed
  assert.equal(
    __internals.evaluateRunResult({
      ...base,
      reportLines: [JSON.stringify({
        kind: 'alpi-node-test-aggregate',
        v: 1,
        data: { success: true, counts: { tests: 9, failed: 0, passed: 5, cancelled: 0, skipped: 0, todo: 0 }, duration_ms: 1 },
      })],
    }).reason,
    'invalid-report'
  );
});

test('decision table: per-file inventory consistency', () => {
  const base = {
    forced: null,
    signal: null,
    exitCode: 0,
    reportLines: [],
    reportOverflow: false,
    minimumTests: 1,
    expectedFiles: SYNTH_EXPECTED,
    realCwd: SYNTH_CWD,
  };
  const fileLine = (file, tests, success = true) => JSON.stringify({
    kind: 'alpi-node-test-file-summary',
    v: 1,
    data: { file, success, counts: { tests, failed: 0, passed: tests, cancelled: 0, skipped: 0, todo: 0 }, duration_ms: 1 },
  });
  const aggLine = (tests) => JSON.stringify({
    kind: 'alpi-node-test-aggregate',
    v: 1,
    data: { success: true, counts: { tests, failed: 0, passed: tests, cancelled: 0, skipped: 0, todo: 0 }, duration_ms: 1 },
  });

  // complete, consistent inventory passes
  const ok = __internals.evaluateRunResult({
    ...base,
    reportLines: [fileLine('/x/a.test.cjs', 2), aggLine(2)],
  });
  assert.equal(ok.outcome, 'pass');
  assert.equal(ok.tests.discovered, 2);

  // per-file sum disagrees with the aggregate
  assert.equal(
    __internals.evaluateRunResult({ ...base, reportLines: [fileLine('/x/a.test.cjs', 2), aggLine(3)] }).reason,
    'invalid-report'
  );
  // per-file summary declaring zero tests
  const zero = __internals.evaluateRunResult({
    ...base,
    reportLines: [fileLine('/x/a.test.cjs', 0), aggLine(1)],
  });
  assert.equal(zero.outcome, 'fail');
  assert.equal(zero.reason, 'zero-tests');
  assert.equal(zero.tests.discovered, 0);
  // per-file summary reporting failure
  assert.equal(
    __internals.evaluateRunResult({
      ...base,
      reportLines: [fileLine('/x/a.test.cjs', 2, false), aggLine(2)],
    }).reason,
    'not-passed'
  );
  // unknown file identifier
  assert.equal(
    __internals.evaluateRunResult({ ...base, reportLines: [fileLine('/x/evil.test.cjs', 2), aggLine(2)] }).reason,
    'invalid-report'
  );
  // duplicate summary for the same file
  assert.equal(
    __internals.evaluateRunResult({
      ...base,
      reportLines: [fileLine('/x/a.test.cjs', 2), fileLine('/x/a.test.cjs', 2), aggLine(2)],
    }).reason,
    'invalid-report'
  );
  // missing per-file summary while another file carries tests
  assert.equal(
    __internals.evaluateRunResult({
      ...base,
      expectedFiles: ['/x/a.test.cjs', '/x/b.test.cjs'],
      reportLines: [fileLine('/x/a.test.cjs', 2), aggLine(3)],
    }).reason,
    'invalid-report'
  );
  // malformed per-file summary
  assert.equal(
    __internals.evaluateRunResult({
      ...base,
      reportLines: [JSON.stringify({ kind: 'alpi-node-test-file-summary', v: 1, data: { file: '/x/a.test.cjs' } }), aggLine(2)],
    }).reason,
    'invalid-report'
  );
  // below minimum uses the per-file sum, not the wrapper-inflated aggregate
  const below = __internals.evaluateRunResult({
    ...base,
    minimumTests: 3,
    reportLines: [fileLine('/x/a.test.cjs', 2), aggLine(2)],
  });
  assert.equal(below.outcome, 'fail');
  assert.equal(below.reason, 'below-minimum');
  assert.equal(below.tests.discovered, 2);
});

// --- CLI ---------------------------------------------------------------------

function runCli(args) {
  return spawnSync(process.execPath, [RUNNER_CLI, ...args], { encoding: 'utf8' });
}

function parseSingleJsonRecord(stdout) {
  const lines = stdout.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 1, 'CLI must print exactly one record');
  return JSON.parse(lines[0]);
}

test('CLI exits 0 with one JSON record on pass', () => {
  const { dir, files } = passingProject();
  const proc = runCli(['--cwd', dir, '--timeout-ms', '30000', '--minimum-tests', '1', '--', ...files]);
  const record = parseSingleJsonRecord(proc.stdout);
  assert.equal(record.outcome, 'pass');
  assert.equal(record.tests.discovered, 3);
  assert.equal(proc.status, 0);
});

test('CLI exits nonzero with one JSON record on failure', () => {
  const dir = makeTempDir();
  writeTestFile(
    dir,
    'a.test.cjs',
    "'use strict';\nconst { test } = require('node:test');\ntest('x', () => { throw new Error('y'); });\n"
  );
  const proc = runCli(['--cwd', dir, '--', 'a.test.cjs']);
  const record = parseSingleJsonRecord(proc.stdout);
  assert.equal(record.outcome, 'fail');
  assert.notEqual(proc.status, 0);
});

test('CLI rejects unknown, duplicate and malformed flags', () => {
  const { dir, files } = passingProject();
  const badInvocations = [
    ['--bogus', 'x', '--', ...files],
    ['--cwd', dir, '--cwd', dir, '--', ...files],
    ['--timeout-ms', 'abc', '--cwd', dir, '--', ...files],
    ['--timeout-ms', '--cwd', dir, '--', ...files], // value consumed then rejected
    ['--cwd', dir], // missing '--' separator
    ['--cwd', dir, '--'], // no files
    ['--cwd'], // missing value
    ['positional', '--cwd', dir, '--', ...files],
  ];
  for (const args of badInvocations) {
    const proc = runCli(args);
    const record = parseSingleJsonRecord(proc.stdout);
    assert.deepEqual(record, {
      outcome: 'blocked',
      reason: 'invalid-input',
      exitCode: null,
      tests: null,
      durationMs: 0,
    }, args.join(' '));
    assert.notEqual(proc.status, 0);
  }
});

test('CLI semantic validation errors also exit nonzero', () => {
  const proc = runCli(['--cwd', '/definitely/not/a/real/dir', '--', 'x.test.cjs']);
  const record = parseSingleJsonRecord(proc.stdout);
  assert.equal(record.outcome, 'blocked');
  assert.equal(record.reason, 'invalid-input');
  assert.notEqual(proc.status, 0);
});

test('CLI rejects an empty test file with zero-tests', () => {
  const dir = makeTempDir();
  writeTestFile(dir, 'empty.test.cjs', '');
  const proc = runCli(['--cwd', dir, '--minimum-tests', '1', '--', 'empty.test.cjs']);
  const record = parseSingleJsonRecord(proc.stdout);
  assert.equal(record.outcome, 'fail');
  assert.equal(record.reason, 'zero-tests');
  assert.equal(record.tests.discovered, 0);
  assert.notEqual(proc.status, 0);
});

// Regressions from Sol's independent PR review.
test('skipped and todo suites cannot hide behind a passing test', async () => {
  for (const modifier of ['skip', 'todo']) {
    const dir = makeTempDir();
    writeTestFile(dir, 'a.test.cjs', `const {test,describe,it}=require('node:test');
      test('ok',()=>{});describe.${modifier}('omitted',()=>it('never',()=>{}));`);
    const result = await runNodeTests({cwd:dir,files:['a.test.cjs']});
    assert.equal(result.outcome, 'fail');
    assert.equal(result.reason, 'not-passed');
  }
});

test('worker output overflow is counted without exposing its text', async () => {
  const dir = makeTempDir();
  writeTestFile(dir, 'a.test.cjs', `require('node:test')('loud',()=>{
    process.stdout.write('x'.repeat(128*1024));process.stderr.write('y'.repeat(128*1024));
  });`);
  const result = await runNodeTests({cwd:dir,files:['a.test.cjs']});
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.reason, 'output-limit');
  assert.equal(JSON.stringify(result).includes('xxxxx'),false);
});

test('glob characters in canonical paths cannot execute sibling tests', async () => {
  const root = makeTempDir();
  const marker = path.join(root,'executed');
  for (const name of ['work[ab]','worka','workb']) {
    writeTestFile(root, `${name}/a.test.cjs`, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad');`);
  }
  const result = await runNodeTests({cwd:path.join(root,'work[ab]'),files:['a.test.cjs']});
  assert.equal(result.reason,'invalid-input');
  assert.equal(fs.existsSync(marker),false);
});

test('hard-link aliases cannot inflate the test minimum', async () => {
  const {dir,files} = passingProject();
  fs.linkSync(path.join(dir,files[0]),path.join(dir,'alias.test.cjs'));
  const result = await runNodeTests({cwd:dir,files:[...files,'alias.test.cjs'],minimumTests:6});
  assert.equal(result.reason,'invalid-input');
  assert.equal(result.durationMs,0);
});

async function assertProcessesGone(pids) {
  for(let attempt=0;attempt<100;attempt++) {
    const alive = pids.filter(pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}});
    if(!alive.length)return;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.fail('owned processes survived completion');
}

test('successful completion cleans up unrefed ordinary descendants', async () => {
  const dir=makeTempDir(), pidFile=path.join(dir,'descendant.pid');
  writeTestFile(dir,'a.test.cjs',`require('node:test')('spawn',()=>{
    const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(child.pid));child.unref();
  });`);
  let pid;
  try {
    const result=await runNodeTests({cwd:dir,files:['a.test.cjs']});
    pid=Number(fs.readFileSync(pidFile,'utf8'));
    assert.equal(result.outcome,'pass');
    await assertProcessesGone([pid]);
  } finally {if(pid)try{process.kill(pid,'SIGKILL');}catch{}}
});

test('SIGTERM to the CLI cancels and cleans up its test group', async () => {
  const dir=makeTempDir(), pidFile=path.join(dir,'owned.json');
  writeTestFile(dir,'a.test.cjs',`require('node:test')('hang',()=>{
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)},JSON.stringify([process.pid,process.ppid]));
    setInterval(()=>{},1000);
  });`);
  const child=spawn(process.execPath,[RUNNER_CLI,'--cwd',dir,'--','a.test.cjs'],{stdio:['ignore','pipe','pipe']});
  let output='',pids=[];child.stdout.on('data',b=>{output+=b;});child.stderr.resume();
  const closed=new Promise(resolve=>child.on('close',(code,signal)=>resolve({code,signal})));
  try {
    for(let i=0;i<150&&!fs.existsSync(pidFile);i++)await new Promise(resolve=>setTimeout(resolve,20));
    assert.ok(fs.existsSync(pidFile),'test started');
    pids=JSON.parse(fs.readFileSync(pidFile,'utf8'));
    child.kill('SIGTERM');
    const status=await closed;
    assert.equal(status.code,1);
    assert.equal(JSON.parse(output).outcome,'cancelled');
    await assertProcessesGone(pids);
  } finally {child.kill('SIGKILL');for(const pid of pids)try{process.kill(pid,'SIGKILL');}catch{}}
});
