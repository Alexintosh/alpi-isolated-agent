'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const { evaluateAtcGuard } = require('../factory/atc-adapter.cjs');

const BASE40 = '0123456789abcdef0123456789abcdef01234567';
const BASE64 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const ALT_BASE40 = 'ffffffffffffffffffffffffffffffffffffffff';

const READY_GUARD = Object.freeze({
  command: 'guard', issue: 4217, complete: true, outcome: 'ready', ready: true,
  session: 1717171717171, plan: 88, base: BASE40, files: 3, conflicts: Object.freeze([]),
});
const EXPECTED = Object.freeze({
  issue: 4217, session: 1717171717171, plan: 88, base: BASE40, files: 3,
});

function envelope(guard, expected) {
  return { guard, expected };
}
function readyGuard(overrides) {
  return { ...READY_GUARD, ...overrides };
}
function expectedWith(overrides) {
  return { ...EXPECTED, ...overrides };
}
function noTicketGuard(overrides) {
  return {
    command: 'guard', issue: null, complete: true, outcome: 'noTicket', ready: true,
    session: null, plan: null, base: null, files: 0, conflicts: [], ...overrides,
  };
}
function nonReadyGuard(outcome, overrides) {
  return {
    command: 'guard', issue: null, complete: true, outcome, ready: false,
    session: null, plan: null, base: null, files: 0, conflicts: [], ...overrides,
  };
}

const NON_READY_OUTCOMES = [
  'noTicket', 'incomplete', 'scopeTaken', 'claimRequired', 'notEnabled', 'planExpired',
  'scopeChanged', 'baseChanged', 'notInScope', 'readOnly', 'pending', 'notOpen',
  'uncertain', 'claimLimit', 'planLimit', 'prerequisitesUnavailable', 'dryRun',
  'mergeConflicts',
];

// ---------------------------------------------------------------- positives

test('admits a complete ready guard matching the expected identity', () => {
  assert.deepEqual(evaluateAtcGuard(envelope(READY_GUARD, EXPECTED)),
    { admitted: true, reason: 'ready' });
});

test('admits 40-hex and 64-hex bases', () => {
  for (const base of [BASE40, BASE64]) {
    assert.deepEqual(evaluateAtcGuard(envelope(
      readyGuard({ base }), expectedWith({ base }))),
    { admitted: true, reason: 'ready' });
  }
});

test('supports null-prototype envelope, guard and expected', () => {
  const guard = Object.assign(Object.create(null), READY_GUARD);
  const expected = Object.assign(Object.create(null), EXPECTED);
  const env = Object.assign(Object.create(null), { guard, expected });
  assert.deepEqual(evaluateAtcGuard(env), { admitted: true, reason: 'ready' });
});

test('never mutates frozen inputs', () => {
  const guard = Object.freeze(readyGuard({ conflicts: Object.freeze([]) }));
  const expected = Object.freeze(expectedWith());
  const env = Object.freeze({ guard, expected });
  const before = JSON.stringify(env);
  assert.deepEqual(evaluateAtcGuard(env), { admitted: true, reason: 'ready' });
  assert.equal(JSON.stringify(env), before);
});

test('conflicts array is accepted when structurally valid', () => {
  const guard = nonReadyGuard('mergeConflicts', {
    issue: 4217, session: 1717171717171, plan: 88, base: BASE40, files: 2,
    conflicts: [{ issue: 99, plan: 12, session: 555, sharedFiles: 7 }],
  });
  assert.deepEqual(evaluateAtcGuard(envelope(guard, EXPECTED)),
    { admitted: false, reason: 'not-ready' });
});

// ------------------------------------------------------- state-based verdicts

test('noTicket with ready:true is not-ready, never admitted', () => {
  assert.deepEqual(evaluateAtcGuard(envelope(noTicketGuard(), EXPECTED)),
    { admitted: false, reason: 'not-ready' });
});

test('complete:false is incomplete', () => {
  for (const outcome of ['pending', 'uncertain', 'incomplete']) {
    assert.deepEqual(evaluateAtcGuard(envelope(
      nonReadyGuard(outcome, { complete: false }), EXPECTED)),
    { admitted: false, reason: 'incomplete' }, outcome);
  }
});

test('every non-ready outcome with complete:true is not-ready', () => {
  for (const outcome of NON_READY_OUTCOMES) {
    const guard = outcome === 'noTicket' ? noTicketGuard() : nonReadyGuard(outcome);
    assert.deepEqual(evaluateAtcGuard(envelope(guard, EXPECTED)),
      { admitted: false, reason: 'not-ready' }, outcome);
  }
});

test('identity mismatch per expected field', () => {
  const cases = [
    { issue: 4218 }, { session: 1717171717172 }, { plan: 89 },
    { base: ALT_BASE40 }, { files: 2 },
  ];
  for (const overrides of cases) {
    assert.deepEqual(evaluateAtcGuard(envelope(READY_GUARD, expectedWith(overrides))),
      { admitted: false, reason: 'identity-mismatch' }, JSON.stringify(overrides));
  }
});

// ---------------------------------------------------------------- malformed

test('malformed envelopes are invalid-input', () => {
  const guard = READY_GUARD;
  const expected = EXPECTED;
  const cases = {
    undefined: undefined,
    null: null,
    string: 'guard',
    number: 7,
    array: [guard, expected],
    'missing guard': { expected },
    'missing expected': { guard },
    'extra field': { guard, expected, extra: 1 },
    'symbol key': Object.defineProperty({ guard, expected }, Symbol('x'), { value: 1 }),
    'inherited field': Object.assign(Object.create({ expected }), { guard }),
    'accessor field': { guard, get expected() { throw new Error('getter invoked'); } },
    'class instance': new (class { constructor() { this.guard = guard; this.expected = expected; } })(),
  };
  for (const [label, env] of Object.entries(cases)) {
    assert.deepEqual(evaluateAtcGuard(env), { admitted: false, reason: 'invalid-input' }, label);
  }
});

test('guard missing any required field is invalid-input', () => {
  for (const field of ['command', 'issue', 'complete', 'outcome', 'ready',
    'session', 'plan', 'base', 'files', 'conflicts']) {
    const guard = { ...READY_GUARD };
    delete guard[field];
    assert.deepEqual(evaluateAtcGuard(envelope(guard, EXPECTED)),
      { admitted: false, reason: 'invalid-input' }, field);
  }
});

test('guard field type and bound violations are invalid-input', () => {
  const cases = {
    'command not guard': { command: 'guardx' },
    'command coerced': { command: true },
    'complete string': { complete: 'true' },
    'ready number': { ready: 1 },
    'unknown outcome': { outcome: 'approved' },
    'outcome null': { outcome: null },
    'issue zero': { issue: 0 },
    'issue too large': { issue: 1000000000 },
    'issue fractional': { issue: 4.5 },
    'issue NaN': { issue: NaN },
    'issue Infinity': { issue: Infinity },
    'issue string': { issue: '4217' },
    'session zero': { session: 0 },
    'session too large': { session: 1000000000000000 },
    'plan zero': { plan: 0 },
    'plan unsafe': { plan: Number.MAX_SAFE_INTEGER + 1 },
    'files negative': { files: -1 },
    'files too large': { files: 33 },
    'files null': { files: null },
    'base uppercase': { base: BASE40.toUpperCase() },
    'base 39 chars': { base: BASE40.slice(1) },
    'base 41 chars': { base: BASE40 + 'a' },
    'base 63 chars': { base: BASE64.slice(1) },
    'base trailing newline': { base: `${BASE40}\n` },
    'base non-string': { base: 12345 },
  };
  for (const [label, overrides] of Object.entries(cases)) {
    assert.deepEqual(evaluateAtcGuard(envelope(readyGuard(overrides), EXPECTED)),
      { admitted: false, reason: 'invalid-input' }, label);
  }
});

test('guard semantic contradictions are invalid-input', () => {
  const cases = {
    'ready true with pending outcome': nonReadyGuard('pending', { ready: true }),
    'ready false with ready outcome': readyGuard({ ready: false }),
    'ready true with complete false': readyGuard({ complete: false }),
    'noTicket with non-null issue': noTicketGuard({ issue: 5 }),
    'noTicket with files 1': noTicketGuard({ files: 1 }),
    'noTicket with conflicts': noTicketGuard({
      conflicts: [{ issue: 1, plan: 1, session: 1, sharedFiles: 1 }],
    }),
    'ready outcome with null base': readyGuard({ base: null }),
    'ready outcome with files 0': readyGuard({ files: 0 }),
    'ready outcome with conflicts': readyGuard({
      conflicts: [{ issue: 1, plan: 1, session: 1, sharedFiles: 1 }],
    }),
  };
  for (const [label, guard] of Object.entries(cases)) {
    assert.deepEqual(evaluateAtcGuard(envelope(guard, EXPECTED)),
      { admitted: false, reason: 'invalid-input' }, label);
  }
});

test('guard shape violations: extra, symbol, inherited, accessor, class, array', () => {
  const cases = {
    'extra field': readyGuard({ extra: 1 }),
    'symbol key': Object.defineProperty(readyGuard(), Symbol('x'), { value: 1 }),
    'inherited field': Object.assign(Object.create({ extra: 1 }), readyGuard()),
    'accessor field': {
      ...READY_GUARD,
      get conflicts() { throw new Error('getter invoked'); },
    },
    'class instance': new (class {
      constructor() { Object.assign(this, READY_GUARD); }
    })(),
    array: [READY_GUARD],
    null: null,
    string: JSON.stringify(READY_GUARD),
  };
  for (const [label, guard] of Object.entries(cases)) {
    assert.deepEqual(evaluateAtcGuard(envelope(guard, EXPECTED)),
      { admitted: false, reason: 'invalid-input' }, label);
  }
});

test('conflicts array violations are invalid-input', () => {
  const conflict = { issue: 1, plan: 1, session: 1, sharedFiles: 1 };
  const oversized = new Array(1001).fill(null).map(() => ({ ...conflict }));
  const sparse = [conflict];
  delete sparse[0];
  const withExtraProp = Object.assign([conflict], { extra: 1 });
  const withSymbol = Object.defineProperty([conflict], Symbol('x'), { value: 1 });
  const withAccessor = [conflict];
  Object.defineProperty(withAccessor, 0, { get() { throw new Error('getter invoked'); } });
  const cases = {
    'not an array': 'conflicts',
    'oversized (1001)': oversized,
    sparse,
    'extra own property': withExtraProp,
    'symbol key': withSymbol,
    'accessor element': withAccessor,
    'subclass array': new (class extends Array {})(),
    'element missing field': [{ issue: 1, plan: 1, session: 1 }],
    'element extra field': [{ ...conflict, extra: 1 }],
    'element null': [null],
    'element nested array': [[1, 2, 3, 4]],
    'sharedFiles zero': [{ ...conflict, sharedFiles: 0 }],
    'sharedFiles 33': [{ ...conflict, sharedFiles: 33 }],
    'issue string': [{ ...conflict, issue: '1' }],
  };
  for (const [label, conflicts] of Object.entries(cases)) {
    assert.deepEqual(evaluateAtcGuard(envelope(readyGuard({ conflicts }), EXPECTED)),
      { admitted: false, reason: 'invalid-input' }, label);
  }
});

test('expected violations are invalid-input', () => {
  const cases = {
    'missing issue': { session: EXPECTED.session, plan: EXPECTED.plan, base: BASE40, files: 3 },
    'missing session': { issue: 4217, plan: EXPECTED.plan, base: BASE40, files: 3 },
    'missing plan': { issue: 4217, session: EXPECTED.session, base: BASE40, files: 3 },
    'missing base': { issue: 4217, session: EXPECTED.session, plan: 88, files: 3 },
    'missing files': { issue: 4217, session: EXPECTED.session, plan: 88, base: BASE40 },
    'null issue': { ...EXPECTED, issue: null },
    'null base': { ...EXPECTED, base: null },
    'files zero': { ...EXPECTED, files: 0 },
    'files 33': { ...EXPECTED, files: 33 },
    'extra field': { ...EXPECTED, extra: 1 },
    'string coercion': { ...EXPECTED, session: '1717171717171' },
    'class instance': new (class {
      constructor() { Object.assign(this, EXPECTED); }
    })(),
    null: null,
  };
  for (const [label, expected] of Object.entries(cases)) {
    assert.deepEqual(evaluateAtcGuard(envelope(READY_GUARD, expected)),
      { admitted: false, reason: 'invalid-input' }, label);
  }
});

test('hostile proxies fail as invalid-input without throwing', () => {
  const hostile = new Proxy({}, {
    getOwnPropertyNames() { throw new Error('hostile'); },
    getOwnPropertySymbols() { throw new Error('hostile'); },
    getOwnPropertyDescriptor() { throw new Error('hostile'); },
    getPrototypeOf() { throw new Error('hostile'); },
  });
  assert.deepEqual(evaluateAtcGuard(envelope(hostile, EXPECTED)),
    { admitted: false, reason: 'invalid-input' });
  assert.deepEqual(evaluateAtcGuard(envelope(READY_GUARD, hostile)),
    { admitted: false, reason: 'invalid-input' });
  assert.deepEqual(evaluateAtcGuard(hostile),
    { admitted: false, reason: 'invalid-input' });
});

test('output is exactly {admitted, reason} with fixed vocabulary and no echo', () => {
  const results = [
    evaluateAtcGuard(envelope(READY_GUARD, EXPECTED)),
    evaluateAtcGuard(envelope(READY_GUARD, expectedWith({ base: ALT_BASE40 }))),
    evaluateAtcGuard(envelope(noTicketGuard(), EXPECTED)),
    evaluateAtcGuard(envelope(nonReadyGuard('pending', { complete: false }), EXPECTED)),
    evaluateAtcGuard('nonsense-4217'),
  ];
  const vocabulary = new Set(['ready', 'invalid-input', 'incomplete', 'not-ready', 'identity-mismatch']);
  for (const result of results) {
    assert.deepEqual(Object.keys(result).sort(), ['admitted', 'reason']);
    assert.equal(typeof result.admitted, 'boolean');
    assert.ok(vocabulary.has(result.reason), result.reason);
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes('4217'));
    assert.ok(!serialized.includes(BASE40.slice(0, 12)));
    assert.ok(!serialized.includes('nonsense'));
  }
});

// ------------------------------------------- mutation calibration (temp dirs)

const PRODUCTION_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'factory', 'atc-adapter.cjs'), 'utf8');

// Loads module source in this realm (shared intrinsics keep prototype checks
// meaningful) via a vm-wrapped CommonJS factory. No production file is touched.
function loadFromSource(source, label) {
  const factory = vm.runInThisContext(
    `(function (module, exports) {\n${source}\n})`,
    { filename: `atc-variant-${label}.cjs` },
  );
  const module = { exports: {} };
  factory(module, module.exports);
  assert.equal(typeof module.exports.evaluateAtcGuard, 'function', label);
  return module.exports.evaluateAtcGuard;
}

function applyUniqueReplacement(source, from, to, label) {
  const count = source.split(from).length - 1;
  assert.equal(count, 1, `${label}: anchor must occur exactly once, found ${count}`);
  return source.replace(from, to);
}

// Writes the variant into a fresh temp directory, loads it back from there,
// and removes the directory. Calibration never modifies the production module.
function loadVariantFromTempDir(source, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atc-adapter-mut-'));
  try {
    const file = path.join(dir, `${label}.cjs`);
    fs.writeFileSync(file, source, 'utf8');
    return loadFromSource(fs.readFileSync(file, 'utf8'), label);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const ADMISSION_GATE = `if (guard.outcome !== 'ready') return verdict(false, REASON_NOT_READY);`;
const INCOMPLETE_GATE = `if (!guard.complete) return verdict(false, REASON_INCOMPLETE);`;
const BASE_COMPARISON = `if (guard.base !== expected.base) return verdict(false, REASON_IDENTITY);`;

// One acceptance oracle runs against the unchanged module and every mutant.
// Each mutant must actually admit its invalid case before the oracle rejects it.
const CALIBRATION_CASES = [
  { label: 'no-ticket', input: envelope(noTicketGuard(), EXPECTED) },
  { label: 'incomplete-ready', input: envelope(readyGuard({ complete: false }), EXPECTED) },
  { label: 'stale-base', input: envelope(readyGuard({ base: ALT_BASE40 }), EXPECTED) },
  ...['issue', 'session', 'plan', 'files'].map(field => ({
    label: `stale-${field}`,
    input: envelope(readyGuard({ [field]: EXPECTED[field] + 1 }), EXPECTED),
  })),
];
function assertAdmissionContract(evaluate) {
  assert.equal(evaluate(envelope(READY_GUARD, EXPECTED)).admitted, true);
  for (const { label, input } of CALIBRATION_CASES) {
    assert.equal(evaluate(input).admitted, false, label);
  }
}

test('positive control: unmutated source passes the shared acceptance oracle', () => {
  assertAdmissionContract(evaluateAtcGuard);
  assertAdmissionContract(loadVariantFromTempDir(PRODUCTION_SOURCE, 'control'));
});

test('mutation 1: accepting a valid noTicket result fails the acceptance oracle', () => {
  const source = applyUniqueReplacement(PRODUCTION_SOURCE, ADMISSION_GATE,
    `if (guard.outcome === 'noTicket') return verdict(true, REASON_READY);\n    ${ADMISSION_GATE}`, 'm1');
  const mutant = loadVariantFromTempDir(source, 'm1');
  assert.equal(mutant(CALIBRATION_CASES[0].input).admitted, true);
  assert.throws(() => assertAdmissionContract(mutant), { code: 'ERR_ASSERTION', message: /no-ticket/ });
});

test('mutation 2: accepting incomplete ready data fails the acceptance oracle', () => {
  let source = applyUniqueReplacement(PRODUCTION_SOURCE,
    'if (ready && !complete) return null;', '', 'm2-semantic');
  source = applyUniqueReplacement(source, INCOMPLETE_GATE, '', 'm2-admission');
  const mutant = loadVariantFromTempDir(source, 'm2');
  assert.equal(mutant(CALIBRATION_CASES[1].input).admitted, true);
  assert.throws(() => assertAdmissionContract(mutant), { code: 'ERR_ASSERTION', message: /incomplete-ready/ });
});

test('mutation 3: accepting a changed base fails the acceptance oracle', () => {
  const source = applyUniqueReplacement(PRODUCTION_SOURCE, BASE_COMPARISON, '', 'm3');
  const mutant = loadVariantFromTempDir(source, 'm3');
  assert.equal(mutant(CALIBRATION_CASES[2].input).admitted, true);
  assert.throws(() => assertAdmissionContract(mutant), { code: 'ERR_ASSERTION', message: /stale-base/ });
});

test('shared oracle kills every remaining ATC identity comparison bypass', () => {
  for (const field of ['issue', 'session', 'plan', 'files']) {
    const source = applyUniqueReplacement(PRODUCTION_SOURCE,
      `if (guard.${field} !== expected.${field}) return verdict(false, REASON_IDENTITY);`, '', field);
    const mutant = loadVariantFromTempDir(source, field);
    const sample = CALIBRATION_CASES.find(({ label }) => label === `stale-${field}`);
    assert.equal(mutant(sample.input).admitted, true, `${field}: mutant must be live`);
    assert.throws(() => assertAdmissionContract(mutant), { code: 'ERR_ASSERTION' });
  }
});

test('oversized conflicts are rejected before enumeration or element reads', () => {
  let enumerations = 0;
  const conflicts = new Proxy(new Array(1001), {
    ownKeys() { enumerations++; throw new Error('must reject length first'); },
    get() { throw new Error('ordinary property reads are forbidden'); },
  });
  assert.deepEqual(evaluateAtcGuard(envelope(readyGuard({ conflicts }), EXPECTED)),
    { admitted: false, reason: 'invalid-input' });
  assert.equal(enumerations, 0);
});

test('accessor getters are never invoked at any data boundary', () => {
  let calls = 0;
  function accessor(object, key) {
    Object.defineProperty(object, key, { get() { calls++; return null; } });
    return object;
  }
  const conflict = { issue: 1, plan: 1, session: 1, sharedFiles: 1 };
  const cases = [
    accessor(envelope(READY_GUARD, EXPECTED), 'guard'),
    envelope(accessor(readyGuard(), 'base'), EXPECTED),
    envelope(READY_GUARD, accessor(expectedWith(), 'base')),
    envelope(readyGuard({ conflicts: accessor([conflict], '0') }), EXPECTED),
    envelope(readyGuard({ conflicts: [accessor(conflict, 'issue')] }), EXPECTED),
  ];
  for (const input of cases) assert.equal(evaluateAtcGuard(input).reason, 'invalid-input');
  assert.equal(calls, 0);
});
