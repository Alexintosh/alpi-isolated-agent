const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { evaluateEvidence, REASON_CODES } = require("../factory/evidence.cjs");

// Synthetic identities only. Nothing here touches real repositories,
// runners or credentials.

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const SHA_D = "d".repeat(40);
const DIG_1 = "1".repeat(64);
const DIG_2 = "2".repeat(64);
const DIG_3 = "3".repeat(64);
const DIG_4 = "4".repeat(64);

function makeExpected(overrides = {}) {
  return {
    repository: "acme/widget",
    pullRequest: 42,
    baseSha: SHA_A,
    headSha: SHA_B,
    testedTreeSha: SHA_C,
    policyDigest: DIG_1,
    evaluatorDigest: DIG_2,
    fixtureDigest: DIG_3,
    ...overrides,
  };
}

function makeCheck(overrides = {}) {
  return {
    id: "unit-tests",
    environmentId: "portable-linux",
    minimumTests: 10,
    ...overrides,
  };
}

function makeTests(overrides = {}) {
  const tests = {
    discovered: 10,
    passed: 10,
    failed: 0,
    skipped: 0,
    cancelled: 0,
    todo: 0,
    ...overrides,
  };
  if (!("discovered" in overrides)) {
    tests.discovered =
      tests.passed + tests.failed + tests.skipped + tests.cancelled + tests.todo;
  }
  return tests;
}

function makeRecord(overrides = {}) {
  return {
    schemaVersion: 1,
    checkId: "unit-tests",
    environmentId: "portable-linux",
    identity: makeExpected(),
    outcome: "pass",
    exitCode: 0,
    tests: makeTests(),
    ...overrides,
  };
}

function makeInput(overrides = {}) {
  return {
    expected: makeExpected(),
    requiredChecks: [makeCheck()],
    records: [makeRecord()],
    ...overrides,
  };
}

function codes(result) {
  return result.reasons.map((reason) => reason.code);
}

function reasonFor(result, code) {
  return result.reasons.find((reason) => reason.code === code);
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      deepFreeze(value[key]);
    }
    Object.freeze(value);
  }
  return value;
}

// --- positive cases -------------------------------------------------------

test("all-current evidence is eligible with empty reasons", () => {
  const result = evaluateEvidence(makeInput());
  assert.deepEqual(result, { eligible: true, reasons: [] });
});

test("local/push validation with pullRequest null is eligible", () => {
  const expected = makeExpected({ pullRequest: null });
  const result = evaluateEvidence(
    makeInput({ expected, records: [makeRecord({ identity: expected })] })
  );
  assert.equal(result.eligible, true);
});

test("result shape is exact and codes stay inside the fixed vocabulary", () => {
  const result = evaluateEvidence(
    makeInput({ records: [makeRecord({ outcome: "fail", exitCode: 7 })] })
  );
  assert.deepEqual(Object.keys(result).sort(), ["eligible", "reasons"]);
  assert.equal(result.eligible, false);
  for (const reason of result.reasons) {
    assert.deepEqual(Object.keys(reason).sort(), ["checkId", "code"]);
    assert.ok(REASON_CODES.includes(reason.code));
    assert.ok(
      reason.checkId === null || typeof reason.checkId === "string"
    );
  }
});

// --- identity mismatch, field by field -------------------------------------

test("each identity field changed independently yields identity-mismatch", () => {
  const mutations = {
    repository: "other/widget",
    pullRequest: 43,
    baseSha: SHA_D,
    headSha: SHA_D,
    testedTreeSha: SHA_D,
    policyDigest: DIG_4,
    evaluatorDigest: DIG_4,
    fixtureDigest: DIG_4,
  };
  for (const [field, value] of Object.entries(mutations)) {
    const identity = makeExpected({ [field]: value });
    const result = evaluateEvidence(
      makeInput({ records: [makeRecord({ identity })] })
    );
    assert.equal(result.eligible, false, `field ${field}`);
    assert.deepEqual(codes(result), ["identity-mismatch"], `field ${field}`);
    assert.equal(reasonFor(result, "identity-mismatch").checkId, "unit-tests");
  }
});

// --- lane / environment binding --------------------------------------------

test("record from another environment cannot satisfy the lane", () => {
  const result = evaluateEvidence(
    makeInput({
      records: [makeRecord({ environmentId: "portable-macos" })],
    })
  );
  assert.equal(result.eligible, false);
  assert.deepEqual(codes(result), ["environment-mismatch"]);
});

test("missing lane yields missing-check", () => {
  const result = evaluateEvidence(makeInput({ records: [] }));
  assert.equal(result.eligible, false);
  assert.deepEqual(codes(result), ["missing-check"]);
  assert.equal(reasonFor(result, "missing-check").checkId, "unit-tests");
});

test("unknown lane record is rejected as unexpected evidence", () => {
  const result = evaluateEvidence(
    makeInput({ records: [makeRecord(), makeRecord({ checkId: "extra-lane" })] })
  );
  assert.equal(result.eligible, false);
  assert.deepEqual(codes(result), ["unexpected-check"]);
  assert.equal(reasonFor(result, "unexpected-check").checkId, "extra-lane");
});

test("duplicate records never pick the best or newest", () => {
  const good = makeRecord();
  const bad = makeRecord({ outcome: "fail", exitCode: 1 });
  for (const order of [
    [good, bad],
    [bad, good],
    [good, good],
  ]) {
    const result = evaluateEvidence(makeInput({ records: order }));
    assert.equal(result.eligible, false);
    assert.deepEqual(codes(result), ["duplicate-check"]);
  }
});

// --- outcome / exit / test counts ------------------------------------------

test("every non-pass outcome yields nonpassing-outcome", () => {
  for (const outcome of ["fail", "blocked", "skipped", "cancelled", "inconclusive"]) {
    const result = evaluateEvidence(
      makeInput({ records: [makeRecord({ outcome })] })
    );
    assert.equal(result.eligible, false, outcome);
    assert.deepEqual(codes(result), ["nonpassing-outcome"], outcome);
  }
});

test("nonzero and null exit codes are both rejected", () => {
  for (const exitCode of [1, 2, 127, 255, null]) {
    const result = evaluateEvidence(
      makeInput({ records: [makeRecord({ exitCode })] })
    );
    assert.equal(result.eligible, false, String(exitCode));
    assert.deepEqual(codes(result), ["nonzero-exit"], String(exitCode));
  }
});

test("discovered below minimumTests yields insufficient-tests", () => {
  const result = evaluateEvidence(
    makeInput({
      records: [makeRecord({ tests: makeTests({ passed: 9 }) })],
    })
  );
  assert.equal(result.eligible, false);
  assert.deepEqual(codes(result), ["insufficient-tests"]);
});

test("all-zero passing record is rejected", () => {
  const zeroTests = {
    discovered: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
    todo: 0,
  };
  const result = evaluateEvidence(
    makeInput({ records: [makeRecord({ tests: zeroTests })] })
  );
  assert.equal(result.eligible, false);
  assert.deepEqual(codes(result), ["insufficient-tests"]);
});

test("skipped, todo, cancelled or failed counts defeat exit 0", () => {
  for (const field of ["failed", "skipped", "cancelled", "todo"]) {
    const result = evaluateEvidence(
      makeInput({
        records: [makeRecord({ tests: makeTests({ [field]: 1 }) })],
      })
    );
    assert.equal(result.eligible, false, field);
    assert.deepEqual(codes(result), ["unsuccessful-tests"], field);
  }
});

test("passed below discovered despite zero other counts is unsuccessful", () => {
  const tests = {
    discovered: 10,
    passed: 9,
    failed: 0,
    skipped: 0,
    cancelled: 0,
    todo: 1,
  };
  const result = evaluateEvidence(
    makeInput({ records: [makeRecord({ tests })] })
  );
  assert.equal(result.eligible, false);
  assert.deepEqual(codes(result), ["unsuccessful-tests"]);
});

// --- malformed input --------------------------------------------------------

test("contradictory test totals are invalid-input, not accepted evidence", () => {
  const tests = {
    discovered: 10,
    passed: 10,
    failed: 1,
    skipped: 0,
    cancelled: 0,
    todo: 0,
  };
  const result = evaluateEvidence(
    makeInput({ records: [makeRecord({ tests })] })
  );
  assert.equal(result.eligible, false);
  assert.deepEqual(codes(result), ["invalid-input"]);
  assert.equal(reasonFor(result, "invalid-input").checkId, "unit-tests");
});

test("unsupported schema version is invalid-input", () => {
  for (const schemaVersion of [2, 0, "1", true, null, undefined]) {
    const result = evaluateEvidence(
      makeInput({ records: [makeRecord({ schemaVersion })] })
    );
    assert.equal(result.eligible, false, String(schemaVersion));
    assert.deepEqual(codes(result), ["invalid-input"], String(schemaVersion));
  }
});

test("malformed global inputs return invalid-input with null checkId", () => {
  const badInputs = [
    undefined,
    null,
    42,
    "evidence",
    [],
    () => {},
    {},
    { expected: makeExpected(), requiredChecks: [makeCheck()] },
    { ...makeInput(), extra: true },
    { ...makeInput(), expected: undefined },
    { ...makeInput(), expected: { ...makeExpected(), extra: 1 } },
    { ...makeInput(), expected: { ...makeExpected(), baseSha: SHA_A.slice(1) } },
    { ...makeInput(), expected: { ...makeExpected(), policyDigest: DIG_1.slice(1) } },
    { ...makeInput(), expected: { ...makeExpected(), headSha: SHA_A.toUpperCase() } },
    { ...makeInput(), expected: { ...makeExpected(), repository: "" } },
    { ...makeInput(), expected: { ...makeExpected(), repository: "no-slash" } },
    { ...makeInput(), expected: { ...makeExpected(), repository: "a/b/c" } },
    { ...makeInput(), expected: { ...makeExpected(), repository: "x".repeat(201) } },
    { ...makeInput(), expected: { ...makeExpected(), pullRequest: 0 } },
    { ...makeInput(), expected: { ...makeExpected(), pullRequest: -1 } },
    { ...makeInput(), expected: { ...makeExpected(), pullRequest: "42" } },
    { ...makeInput(), expected: { ...makeExpected(), pullRequest: 1.5 } },
    { ...makeInput(), expected: { ...makeExpected(), pullRequest: 2 ** 53 } },
    { ...makeInput(), requiredChecks: [] },
    { ...makeInput(), requiredChecks: {} },
    { ...makeInput(), requiredChecks: [makeCheck(), makeCheck()] },
    { ...makeInput(), requiredChecks: [{ ...makeCheck(), minimumTests: 0 }] },
    { ...makeInput(), requiredChecks: [{ ...makeCheck(), minimumTests: "10" }] },
    { ...makeInput(), requiredChecks: [{ ...makeCheck(), id: "Unit-Tests" }] },
    { ...makeInput(), requiredChecks: [{ ...makeCheck(), id: "-lead" }] },
    { ...makeInput(), requiredChecks: [{ ...makeCheck(), id: "a".repeat(65) }] },
    { ...makeInput(), records: {} },
    makeInput({ records: Array.from({ length: 129 }, () => makeRecord()) }),
    makeInput({
      requiredChecks: Array.from({ length: 65 }, (_unused, i) =>
        makeCheck({ id: `lane-${i}` })
      ),
    }),
  ];
  for (const input of badInputs) {
    const result = evaluateEvidence(input);
    assert.equal(result.eligible, false);
    assert.deepEqual(
      result.reasons,
      [{ code: "invalid-input", checkId: null }],
      JSON.stringify(codes(result))
    );
  }
});

test("malformed record fields are invalid-input", () => {
  // Records that still name a valid lane occupy that lane's slot.
  const attributed = [
    { ...makeRecord(), extra: 1 },
    { ...makeRecord(), exitCode: 256 },
    { ...makeRecord(), exitCode: -1 },
    { ...makeRecord(), exitCode: "0" },
    { ...makeRecord(), exitCode: 1.5 },
    { ...makeRecord(), outcome: "PASSED" },
    { ...makeRecord(), outcome: "success" },
    { ...makeRecord(), environmentId: "portable linux" },
    { ...makeRecord(), identity: null },
    { ...makeRecord(), tests: null },
    { ...makeRecord(), tests: { ...makeTests(), extra: 0 } },
    { ...makeRecord(), tests: { discovered: 10, passed: 10 } },
    { ...makeRecord(), tests: makeTests({ passed: Number.NaN }) },
    { ...makeRecord(), tests: makeTests({ passed: Number.POSITIVE_INFINITY }) },
    { ...makeRecord(), tests: makeTests({ passed: -1 }) },
    { ...makeRecord(), tests: makeTests({ passed: 1.5 }) },
    { ...makeRecord(), tests: makeTests({ passed: "10" }) },
    { ...makeRecord(), tests: makeTests({ passed: 2 ** 53 }) },
    { ...makeRecord(), tests: makeTests({ passed: 1000001, discovered: 1000001 }) },
  ];
  for (const record of attributed) {
    const result = evaluateEvidence(makeInput({ records: [record] }));
    assert.equal(result.eligible, false);
    assert.deepEqual(result.reasons, [
      { code: "invalid-input", checkId: "unit-tests" },
    ]);
  }

  // Records that cannot be attributed to any lane also leave it missing.
  const unattributable = [null, "record", [], { ...makeRecord(), checkId: "Unit-Tests" }];
  for (const record of unattributable) {
    const result = evaluateEvidence(makeInput({ records: [record] }));
    assert.equal(result.eligible, false);
    assert.deepEqual(result.reasons, [
      { code: "invalid-input", checkId: null },
      { code: "missing-check", checkId: "unit-tests" },
    ]);
  }
});

test("no truthiness or coercion shortcuts on typed fields", () => {
  for (const record of [
    makeRecord({ schemaVersion: true }),
    makeRecord({ exitCode: false }),
    makeRecord({ outcome: new String("pass") }),
  ]) {
    const result = evaluateEvidence(makeInput({ records: [record] }));
    assert.equal(result.eligible, false);
    assert.deepEqual(codes(result), ["invalid-input"]);
  }
  for (const check of [
    { id: "unit-tests", environmentId: "portable-linux", minimumTests: true },
    { id: "unit-tests", environmentId: 7, minimumTests: 10 },
  ]) {
    const result = evaluateEvidence(makeInput({ requiredChecks: [check] }));
    assert.equal(result.eligible, false);
    assert.deepEqual(result.reasons, [
      { code: "invalid-input", checkId: null },
    ]);
  }
});

// --- hostile object shapes ---------------------------------------------------

test("unknown, injected and inherited properties are rejected", () => {
  const withInjectedProto = JSON.parse(
    '{"schemaVersion":1,"checkId":"unit-tests","environmentId":"portable-linux",' +
      '"identity":{"repository":"acme/widget","pullRequest":42,"baseSha":"' +
      SHA_A + '","headSha":"' + SHA_B + '","testedTreeSha":"' + SHA_C +
      '","policyDigest":"' + DIG_1 + '","evaluatorDigest":"' + DIG_2 +
      '","fixtureDigest":"' + DIG_3 + '"},"outcome":"pass","exitCode":0,' +
      '"tests":{"discovered":10,"passed":10,"failed":0,"skipped":0,"cancelled":0,"todo":0},' +
      '"__proto__":{"polluted":true}}'
  );
  const result = evaluateEvidence(makeInput({ records: [withInjectedProto] }));
  assert.equal(result.eligible, false);
  assert.deepEqual(result.reasons, [
    { code: "invalid-input", checkId: "unit-tests" },
  ]);
  assert.equal({}.polluted, undefined, "prototype must not be polluted");

  // Fields reachable only through the prototype chain must not count.
  const inherited = Object.create(makeRecord());
  const viaInheritance = evaluateEvidence(makeInput({ records: [inherited] }));
  assert.equal(viaInheritance.eligible, false);
  assert.deepEqual(codes(viaInheritance), ["invalid-input", "missing-check"]);

  class RecordLike {
    constructor() {
      this.schemaVersion = 1;
      this.checkId = "unit-tests";
      this.environmentId = "portable-linux";
      this.identity = makeExpected();
      this.outcome = "pass";
      this.exitCode = 0;
      this.tests = makeTests();
    }
  }
  const classResult = evaluateEvidence(
    makeInput({ records: [new RecordLike()] })
  );
  assert.equal(classResult.eligible, false);
  assert.deepEqual(codes(classResult), ["invalid-input", "missing-check"]);

  // Null-prototype records are plain data and must be accepted.
  const nullProto = Object.assign(Object.create(null), makeRecord());
  const ok = evaluateEvidence(makeInput({ records: [nullProto] }));
  assert.equal(ok.eligible, true);
});

test("unsafe identifiers are never echoed back", () => {
  const sneaky = makeRecord({
    checkId: "evil</script> https://example.invalid/repo",
  });
  const result = evaluateEvidence(makeInput({ records: [sneaky] }));
  assert.equal(result.eligible, false);
  assert.deepEqual(result.reasons, [
    { code: "invalid-input", checkId: null },
    { code: "missing-check", checkId: "unit-tests" },
  ]);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("evil"));
  assert.ok(!serialized.includes("example.invalid"));
});

test("never throws, even on hostile getters", () => {
  const hostile = makeRecord();
  Object.defineProperty(hostile, "checkId", {
    enumerable: true,
    get() {
      throw new Error("boom");
    },
  });
  for (const input of [
    makeInput({ records: [hostile] }),
    {
      get expected() {
        throw new Error("boom");
      },
      requiredChecks: [makeCheck()],
      records: [],
    },
  ]) {
    const result = evaluateEvidence(input);
    assert.equal(result.eligible, false);
    assert.deepEqual(codes(result), ["invalid-input"]);
  }
});

// --- ordering, deduplication, multiple reasons -------------------------------

test("multiple applicable reasons are reported deterministically", () => {
  const result = evaluateEvidence(
    makeInput({
      records: [
        makeRecord({
          identity: makeExpected({ headSha: SHA_D }),
          environmentId: "portable-macos",
          outcome: "fail",
          exitCode: 3,
          tests: makeTests({ passed: 2 }),
        }),
      ],
    })
  );
  assert.equal(result.eligible, false);
  assert.deepEqual(codes(result), [
    "identity-mismatch",
    "environment-mismatch",
    "nonpassing-outcome",
    "nonzero-exit",
    "insufficient-tests",
  ]);
});

test("reasons follow requiredChecks order, not alphabetical order", () => {
  const result = evaluateEvidence({
    expected: makeExpected(),
    requiredChecks: [
      makeCheck({ id: "zeta-lane" }),
      makeCheck({ id: "alpha-lane" }),
    ],
    records: [],
  });
  assert.equal(result.eligible, false);
  assert.deepEqual(
    result.reasons.map((reason) => reason.checkId),
    ["zeta-lane", "alpha-lane"]
  );
});

test("repeated identical reasons are deduplicated", () => {
  const malformed = makeRecord({ exitCode: 999 });
  const result = evaluateEvidence(
    makeInput({ records: [malformed, malformed] })
  );
  assert.equal(result.eligible, false);
  // One invalid-input despite two malformed records; the lane is also
  // over-claimed, but never resolved by picking a winner.
  assert.deepEqual(result.reasons, [
    { code: "invalid-input", checkId: "unit-tests" },
    { code: "duplicate-check", checkId: "unit-tests" },
  ]);
});

test("bounds: 64 lanes and 128 records are processable", () => {
  const checks = Array.from({ length: 64 }, (_unused, i) =>
    makeCheck({ id: `lane-${i}` })
  );
  const wide = evaluateEvidence({
    expected: makeExpected(),
    requiredChecks: checks,
    records: [],
  });
  assert.equal(wide.reasons.length, 64);
  assert.ok(wide.reasons.every((reason) => reason.code === "missing-check"));

  const many = evaluateEvidence(
    makeInput({ records: Array.from({ length: 128 }, () => makeRecord()) })
  );
  assert.equal(many.eligible, false);
  assert.deepEqual(codes(many), ["duplicate-check"]);
});

// --- purity -------------------------------------------------------------------

test("evaluation is pure: frozen inputs, no mutation, no throw", () => {
  const input = deepFreeze(makeInput());
  const before = JSON.stringify(input);
  const result = evaluateEvidence(input);
  assert.equal(result.eligible, true);
  assert.equal(JSON.stringify(input), before);
});

test("malformed evaluation also leaves inputs untouched", () => {
  const input = deepFreeze(
    makeInput({ records: [makeRecord({ tests: makeTests({ failed: 1 }) })] })
  );
  const before = JSON.stringify(input);
  const result = evaluateEvidence(input);
  assert.equal(result.eligible, false);
  assert.equal(JSON.stringify(input), before);
});

// --- calibration table: known-bad gate behavior -------------------------------

test("calibration: stale and deficient evidence is refused", () => {
  const cases = [
    {
      name: "stale head",
      records: [
        makeRecord({ identity: makeExpected({ headSha: SHA_D }) }),
      ],
      codes: ["identity-mismatch"],
    },
    {
      name: "stale base",
      records: [
        makeRecord({ identity: makeExpected({ baseSha: SHA_D }) }),
      ],
      codes: ["identity-mismatch"],
    },
    {
      name: "missing lane",
      records: [],
      codes: ["missing-check"],
    },
    {
      name: "skipped despite green exit",
      records: [
        makeRecord({ tests: makeTests({ passed: 9, skipped: 1 }) }),
      ],
      codes: ["unsuccessful-tests"],
    },
    {
      name: "zero tests reported as pass",
      records: [
        makeRecord({
          tests: {
            discovered: 0,
            passed: 0,
            failed: 0,
            skipped: 0,
            cancelled: 0,
            todo: 0,
          },
        }),
      ],
      codes: ["insufficient-tests"],
    },
    {
      name: "green report for wrong pull request",
      records: [
        makeRecord({ identity: makeExpected({ pullRequest: 43 }) }),
      ],
      codes: ["identity-mismatch"],
    },
    {
      name: "macos record cannot satisfy linux lane",
      records: [makeRecord({ environmentId: "portable-macos" })],
      codes: ["environment-mismatch"],
    },
  ];
  for (const spec of cases) {
    const result = evaluateEvidence(makeInput({ records: spec.records }));
    assert.equal(result.eligible, false, spec.name);
    assert.deepEqual(codes(result), spec.codes, spec.name);
  }
});

// --- hardened acceptance boundary: accessors, symbols, iterators --------------

const GLOBAL_INVALID = [{ code: "invalid-input", checkId: null }];

test("non-throwing getters are rejected at every boundary without invocation", () => {
  let calls = 0;
  const withGetter = (object, key, value) => {
    Object.defineProperty(object, key, {
      enumerable: true,
      configurable: true,
      get() {
        calls += 1;
        return value;
      },
    });
    return object;
  };
  const cases = {
    "input.expected": withGetter(makeInput(), "expected", makeExpected()),
    "expected.repository": makeInput({
      expected: withGetter(makeExpected(), "repository", "acme/widget"),
    }),
    "check.id": makeInput({
      requiredChecks: [withGetter(makeCheck(), "id", "unit-tests")],
    }),
    "record.outcome": makeInput({
      records: [withGetter(makeRecord(), "outcome", "pass")],
    }),
    "record.checkId": makeInput({
      records: [withGetter(makeRecord(), "checkId", "unit-tests")],
    }),
    "identity.headSha": makeInput({
      records: [
        makeRecord({
          identity: withGetter(makeExpected(), "headSha", SHA_B),
        }),
      ],
    }),
    "tests.passed": makeInput({
      records: [makeRecord({ tests: withGetter(makeTests(), "passed", 10) })],
    }),
    "records[0]": makeInput({ records: withGetter([], "0", makeRecord()) }),
    "requiredChecks[0]": makeInput({
      requiredChecks: withGetter([], "0", makeCheck()),
    }),
  };
  for (const [label, input] of Object.entries(cases)) {
    const result = evaluateEvidence(input);
    assert.equal(result.eligible, false, label);
    assert.deepEqual(result.reasons, GLOBAL_INVALID, label);
  }
  assert.equal(calls, 0, "no getter may be invoked");
});

test("symbol-keyed properties are rejected at every boundary", () => {
  const cases = {
    input: Object.defineProperty(makeInput(), Symbol("x"), { value: 1 }),
    expected: makeInput({
      expected: Object.defineProperty(makeExpected(), Symbol("x"), { value: 1 }),
    }),
    check: makeInput({
      requiredChecks: [
        Object.defineProperty(makeCheck(), Symbol("x"), { value: 1 }),
      ],
    }),
    record: makeInput({
      records: [Object.defineProperty(makeRecord(), Symbol("x"), { value: 1 })],
    }),
    identity: makeInput({
      records: [
        makeRecord({
          identity: Object.defineProperty(makeExpected(), Symbol("x"), {
            value: 1,
          }),
        }),
      ],
    }),
    tests: makeInput({
      records: [
        makeRecord({
          tests: Object.defineProperty(makeTests(), Symbol("x"), { value: 1 }),
        }),
      ],
    }),
    "records array": makeInput({
      records: Object.defineProperty([makeRecord()], Symbol("x"), { value: 1 }),
    }),
    "requiredChecks array": makeInput({
      requiredChecks: Object.defineProperty([makeCheck()], Symbol("x"), {
        value: 1,
      }),
    }),
  };
  for (const [label, input] of Object.entries(cases)) {
    const result = evaluateEvidence(input);
    assert.equal(result.eligible, false, label);
    assert.deepEqual(result.reasons, GLOBAL_INVALID, label);
  }
});

test("own custom iterators are rejected without invocation", () => {
  let iterated = 0;
  const records = [makeRecord()];
  records[Symbol.iterator] = function () {
    iterated += 1;
    return Array.prototype[Symbol.iterator].call(this);
  };
  const checks = [makeCheck()];
  checks[Symbol.iterator] = function () {
    iterated += 1;
    return Array.prototype[Symbol.iterator].call(this);
  };
  for (const input of [
    makeInput({ records }),
    makeInput({ requiredChecks: checks }),
  ]) {
    const result = evaluateEvidence(input);
    assert.equal(result.eligible, false);
    assert.deepEqual(result.reasons, GLOBAL_INVALID);
  }
  assert.equal(iterated, 0, "custom iterators must never be called");
});

test("newline-suffixed identity strings are rejected at both trust levels", () => {
  // Trusted-side (expected/check) violations fail the whole call globally.
  const globalCases = [
    makeInput({ expected: makeExpected({ repository: "acme/widget\n" }) }),
    makeInput({ expected: makeExpected({ repository: "acme/widget\r\n" }) }),
    makeInput({ expected: makeExpected({ baseSha: SHA_A + "\n" }) }),
    makeInput({ expected: makeExpected({ headSha: SHA_B + "\n" }) }),
    makeInput({ expected: makeExpected({ testedTreeSha: SHA_C + "\n" }) }),
    makeInput({ expected: makeExpected({ policyDigest: DIG_1 + "\n" }) }),
    makeInput({ expected: makeExpected({ evaluatorDigest: DIG_2 + "\n" }) }),
    makeInput({ expected: makeExpected({ fixtureDigest: DIG_3 + "\n" }) }),
    makeInput({ requiredChecks: [makeCheck({ id: "unit-tests\n" })] }),
    makeInput({
      requiredChecks: [makeCheck({ environmentId: "portable-linux\n" })],
    }),
  ];
  for (const input of globalCases) {
    const result = evaluateEvidence(input);
    assert.equal(result.eligible, false);
    assert.deepEqual(result.reasons, GLOBAL_INVALID);
  }

  // Candidate-side violations keep lane attribution when checkId is safe.
  const attributedCases = [
    makeRecord({ environmentId: "portable-linux\n" }),
    makeRecord({ identity: makeExpected({ repository: "acme/widget\n" }) }),
    makeRecord({ identity: makeExpected({ headSha: SHA_B + "\n" }) }),
    makeRecord({ identity: makeExpected({ policyDigest: DIG_1 + "\n" }) }),
  ];
  for (const record of attributedCases) {
    const result = evaluateEvidence(makeInput({ records: [record] }));
    assert.equal(result.eligible, false);
    assert.deepEqual(result.reasons, [
      { code: "invalid-input", checkId: "unit-tests" },
    ]);
  }

  // A newline-suffixed checkId is not a safe identifier and is never echoed.
  const result = evaluateEvidence(
    makeInput({ records: [makeRecord({ checkId: "unit-tests\n" })] })
  );
  assert.equal(result.eligible, false);
  assert.deepEqual(result.reasons, [
    { code: "invalid-input", checkId: null },
    { code: "missing-check", checkId: "unit-tests" },
  ]);
  assert.ok(!JSON.stringify(result).includes("\n"));
});

test("sparse and non-standard arrays are rejected before enumeration", () => {
  const sparseRecords = [makeRecord()];
  delete sparseRecords[0];
  const sparseChecks = [makeCheck(), makeCheck({ id: "second-lane" })];
  delete sparseChecks[0];
  const cases = {
    "sparse records": makeInput({ records: sparseRecords }),
    "sparse requiredChecks": makeInput({ requiredChecks: sparseChecks }),
    "records hole after element": (() => {
      const records = [makeRecord(), makeRecord({ checkId: "other" })];
      delete records[0];
      return makeInput({ records });
    })(),
    "records extra own property": makeInput({
      records: Object.assign([makeRecord()], { extra: 1 }),
    }),
    "requiredChecks extra own property": makeInput({
      requiredChecks: Object.assign([makeCheck()], { extra: 1 }),
    }),
    "records subclass": makeInput({
      records: new (class extends Array {})(makeRecord()),
    }),
    "requiredChecks subclass": makeInput({
      requiredChecks: new (class extends Array {})(makeCheck()),
    }),
    "array-like records": makeInput({ records: { length: 0 } }),
    "array-like requiredChecks": makeInput({ requiredChecks: { length: 1 } }),
  };
  for (const [label, input] of Object.entries(cases)) {
    const result = evaluateEvidence(input);
    assert.equal(result.eligible, false, label);
    assert.deepEqual(result.reasons, GLOBAL_INVALID, label);
  }
});

test("oversized arrays are refused before key enumeration or element reads", () => {
  let enumerations = 0;
  const hostileRecords = new Proxy(new Array(129), {
    ownKeys() {
      enumerations += 1;
      throw new Error("must reject length first");
    },
    get() {
      throw new Error("ordinary property reads are forbidden");
    },
  });
  const hostileChecks = new Proxy(new Array(65), {
    ownKeys() {
      enumerations += 1;
      throw new Error("must reject length first");
    },
    get() {
      throw new Error("ordinary property reads are forbidden");
    },
  });
  for (const input of [
    makeInput({ records: hostileRecords }),
    makeInput({ requiredChecks: hostileChecks }),
  ]) {
    const result = evaluateEvidence(input);
    assert.equal(result.eligible, false);
    assert.deepEqual(result.reasons, GLOBAL_INVALID);
  }
  assert.equal(enumerations, 0);
});

test("throwing descriptor traps fail closed as invalid-input", () => {
  const hostile = new Proxy({}, {
    getOwnPropertyNames() {
      throw new Error("hostile");
    },
    getOwnPropertySymbols() {
      throw new Error("hostile");
    },
    getOwnPropertyDescriptor() {
      throw new Error("hostile");
    },
    getPrototypeOf() {
      throw new Error("hostile");
    },
  });
  const cases = [
    hostile,
    makeInput({ expected: hostile }),
    makeInput({ requiredChecks: [hostile] }),
    makeInput({ requiredChecks: hostile }),
    makeInput({ records: [hostile] }),
    makeInput({ records: hostile }),
  ];
  for (const input of cases) {
    const result = evaluateEvidence(input);
    assert.equal(result.eligible, false);
    assert.deepEqual(result.reasons, GLOBAL_INVALID);
  }
});

// --- hardened positives --------------------------------------------------------

test("frozen arrays and records are accepted as ordinary dense data", () => {
  const input = {
    expected: Object.freeze(makeExpected()),
    requiredChecks: Object.freeze([Object.freeze(makeCheck())]),
    records: Object.freeze([Object.freeze(makeRecord())]),
  };
  const result = evaluateEvidence(input);
  assert.deepEqual(result, { eligible: true, reasons: [] });
});

test("null-prototype objects at every nested level are accepted", () => {
  const identity = Object.assign(Object.create(null), makeExpected());
  const tests = Object.assign(Object.create(null), makeTests());
  const record = Object.assign(Object.create(null), {
    schemaVersion: 1,
    checkId: "unit-tests",
    environmentId: "portable-linux",
    identity,
    outcome: "pass",
    exitCode: 0,
    tests,
  });
  const result = evaluateEvidence({
    expected: Object.assign(Object.create(null), makeExpected()),
    requiredChecks: [Object.assign(Object.create(null), makeCheck())],
    records: [record],
  });
  assert.deepEqual(result, { eligible: true, reasons: [] });
});

test("accessor-based evidence is neither invoked, mutated nor echoed", () => {
  const evil = "evil</script> https://example.invalid/repo";
  const record = makeRecord();
  Object.defineProperty(record, "outcome", {
    enumerable: true,
    configurable: true,
    get() {
      return evil;
    },
  });
  const input = makeInput({ records: [record] });
  const namesBefore = Object.getOwnPropertyNames(record).join(",");
  const result = evaluateEvidence(input);
  assert.equal(result.eligible, false);
  assert.deepEqual(result.reasons, GLOBAL_INVALID);
  assert.equal(Object.getOwnPropertyNames(record).join(","), namesBefore);
  const descriptor = Object.getOwnPropertyDescriptor(record, "outcome");
  assert.equal(typeof descriptor.get, "function", "accessor left untouched");
  assert.ok(!JSON.stringify(result).includes("evil"));
  assert.ok(!JSON.stringify(result).includes("example.invalid"));
});

// --- mutation calibration (temp artifacts only, never production) --------------

const PRODUCTION_SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "factory", "evidence.cjs"),
  "utf8"
);

// Loads module source in this realm (shared intrinsics keep prototype checks
// meaningful) via a vm-wrapped CommonJS factory. No production file is touched.
function loadFromSource(source, label) {
  const factory = vm.runInThisContext(
    `(function (module, exports) {\n${source}\n})`,
    { filename: `factory-evidence-variant-${label}.cjs` }
  );
  const module = { exports: {} };
  factory(module, module.exports);
  assert.equal(typeof module.exports.evaluateEvidence, "function", label);
  return module.exports.evaluateEvidence;
}

function applyUniqueReplacement(source, from, to, label) {
  const count = source.split(from).length - 1;
  assert.equal(count, 1, `${label}: anchor must occur exactly once, found ${count}`);
  return source.replace(from, to);
}

// Writes the variant into a fresh temp directory, loads it back from there,
// and removes the directory. Calibration never modifies the production module.
function loadVariantFromTempDir(source, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-evidence-mut-"));
  try {
    const file = path.join(dir, `${label}.cjs`);
    fs.writeFileSync(file, source, "utf8");
    return loadFromSource(fs.readFileSync(file, "utf8"), label);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// A record whose every field is a getter returning otherwise-valid data.
function fullyAccessorizedRecord() {
  const values = makeRecord();
  const record = {};
  for (const key of Object.keys(values)) {
    Object.defineProperty(record, key, {
      enumerable: true,
      configurable: true,
      get() {
        return values[key];
      },
    });
  }
  return record;
}

// One acceptance oracle runs against the unchanged module and every mutant.
// Each mutant must actually accept its invalid case before the oracle rejects
// it, proving the mutant is live and the oracle is discriminating.
const CALIBRATION_CASES = [
  {
    label: "stale-head",
    input: makeInput({
      records: [makeRecord({ identity: makeExpected({ headSha: SHA_D }) })],
    }),
  },
  {
    label: "accessor-record",
    input: makeInput({ records: [fullyAccessorizedRecord()] }),
  },
  {
    label: "failed-outcome",
    input: makeInput({ records: [makeRecord({ outcome: "fail" })] }),
  },
  { label: "nonzero-exit", input: makeInput({ records: [makeRecord({ exitCode: 1 })] }) },
  { label: "environment-mismatch", input: makeInput({ records: [makeRecord({ environmentId: "portable-macos" })] }) },
  { label: "insufficient-tests", input: makeInput({ records: [makeRecord({ tests: makeTests({ passed: 9 }) })] }) },
  { label: "unsuccessful-tests", input: makeInput({ records: [makeRecord({ tests: makeTests({ passed: 9, skipped: 1 }) })] }) },
  { label: "duplicate-check", input: makeInput({ records: [makeRecord(), makeRecord()] }) },
  { label: "missing-check", input: makeInput({ records: [] }) },
  { label: "unexpected-check", input: makeInput({ records: [makeRecord(), makeRecord({ checkId: "unexpected" })] }) },
];

function assertAcceptanceContract(evaluate) {
  assert.equal(evaluate(makeInput()).eligible, true, "positive-control");
  for (const { label, input } of CALIBRATION_CASES) {
    assert.equal(evaluate(input).eligible, false, label);
  }
}

test("positive control: unmutated source passes the shared acceptance oracle", () => {
  assertAcceptanceContract(evaluateEvidence);
  assertAcceptanceContract(loadVariantFromTempDir(PRODUCTION_SOURCE, "control"));
});

const IDENTITY_GATE = `if (!identityEquals(record.identity, expected)) {
      addReason("identity-mismatch", check.id);
    }`;
const ACCESSOR_GUARD = `if (!("value" in descriptor)) {
      throw ADVERSARIAL_SHAPE;
    }`;

test("mutation 1: accepting stale identity fails the acceptance oracle", () => {
  const source = applyUniqueReplacement(PRODUCTION_SOURCE, IDENTITY_GATE, "", "m1");
  const mutant = loadVariantFromTempDir(source, "m1");
  assert.equal(mutant(CALIBRATION_CASES[0].input).eligible, true);
  assert.throws(() => assertAcceptanceContract(mutant), {
    code: "ERR_ASSERTION",
    message: /stale-head/,
  });
});

test("mutation 2: accepting accessor-based records fails the acceptance oracle", () => {
  const source = applyUniqueReplacement(
    PRODUCTION_SOURCE,
    ACCESSOR_GUARD,
    `if (!("value" in descriptor)) { values.push(object[name]); continue; }`,
    "m2"
  );
  const mutant = loadVariantFromTempDir(source, "m2");
  assert.equal(mutant(CALIBRATION_CASES[1].input).eligible, true);
  assert.throws(() => assertAcceptanceContract(mutant), {
    code: "ERR_ASSERTION",
    message: /accessor-record/,
  });
});

test("shared oracle kills each remaining evidence acceptance gate bypass", () => {
  for (const code of ["nonzero-exit", "environment-mismatch", "insufficient-tests",
    "unsuccessful-tests", "duplicate-check", "missing-check", "unexpected-check"]) {
    const id = code === "unexpected-check" ? "record.checkId" : "check.id";
    const source = applyUniqueReplacement(PRODUCTION_SOURCE,
      `addReason("${code}", ${id});`, "", code);
    const mutant = loadVariantFromTempDir(source, code);
    const sample = CALIBRATION_CASES.find(({ label }) => label === code);
    assert.equal(mutant(sample.input).eligible, true, `${code}: mutant must be live`);
    assert.throws(() => assertAcceptanceContract(mutant), { code: "ERR_ASSERTION" });
  }
});
