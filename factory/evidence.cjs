"use strict";

// Deterministic evidence-acceptance predicate for the Alpi software factory.
//
// Scope and limits of this module:
// - It is a pure validation layer. No I/O, no mutation of inputs, no clocks,
//   no randomness. It cannot authenticate the runner that produced a report,
//   cannot attest that reported results are truthful, and does not authorize
//   merging. It only decides whether supplied records structurally match the
//   identity and lanes the caller expects.
// - The caller MUST obtain `expected` and `requiredChecks` from trusted
//   control-plane data (its own checkout state, CI configuration, pinned
//   policy), never from the candidate report itself. A candidate cannot
//   define which evidence validates it.
// - All failure output is limited to the fixed reason-code vocabulary below
//   plus check identifiers already validated as safe. No report strings,
//   errors, URLs or repository data are ever echoed.
//
// Acceptance-boundary hardening:
// - Every accepted object is read exactly once through own data-property
//   descriptors and copied into a private snapshot. Evaluation compares only
//   snapshots, so a proxy or mutable object cannot change a value between
//   validation and use (no stale-identity bypass).
// - Accessor properties (getters/setters) and symbol-keyed properties are
//   rejected as adversarial shape WITHOUT ever being invoked. Arrays must be
//   dense ordinary arrays: exact Array.prototype, no holes, no extra own
//   properties, no own index accessors, no custom iterators. Array length
//   bounds are enforced before any enumeration or element read.
// - String boundaries combine exact length checks with an explicit newline
//   guard because `$` alone matches before a final newline.
// - Throwing descriptor traps fail as invalid-input. No protection is claimed
//   against arbitrary proxy side effects beyond failing closed.

const REASON_CODES = Object.freeze([
  "invalid-input",
  "missing-check",
  "duplicate-check",
  "unexpected-check",
  "identity-mismatch",
  "environment-mismatch",
  "nonpassing-outcome",
  "nonzero-exit",
  "insufficient-tests",
  "unsuccessful-tests",
]);

const MAX_REPOSITORY_LENGTH = 200;
const MAX_REQUIRED_CHECKS = 64;
const MAX_RECORDS = 128;
const MAX_TEST_COUNT = 1000000;
// [a-z0-9][a-z0-9-]{0,63} is at most 64 characters.
const MAX_ID_LENGTH = 64;

// GitHub-safe ASCII "owner/name": each segment starts and ends with an
// alphanumeric character and may contain dots, hyphens and underscores.
const REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const SHA_40_PATTERN = /^[0-9a-f]{40}$/;
const DIGEST_64_PATTERN = /^[0-9a-f]{64}$/;
// Lowercase ASCII lane/environment identifiers: [a-z0-9][a-z0-9-]{0,63}.
const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
// `$` alone matches before a final newline; every string boundary below also
// rejects embedded CR/LF explicitly.
const NEWLINE_PATTERN = /[\r\n]/;

const OUTCOMES = Object.freeze([
  "pass",
  "fail",
  "blocked",
  "skipped",
  "cancelled",
  "inconclusive",
]);

const IDENTITY_KEYS = Object.freeze([
  "repository",
  "pullRequest",
  "baseSha",
  "headSha",
  "testedTreeSha",
  "policyDigest",
  "evaluatorDigest",
  "fixtureDigest",
]);
const CHECK_KEYS = Object.freeze(["id", "environmentId", "minimumTests"]);
const RECORD_KEYS = Object.freeze([
  "schemaVersion",
  "checkId",
  "environmentId",
  "identity",
  "outcome",
  "exitCode",
  "tests",
]);
const TESTS_KEYS = Object.freeze([
  "discovered",
  "passed",
  "failed",
  "skipped",
  "cancelled",
  "todo",
]);
const INPUT_KEYS = Object.freeze(["expected", "requiredChecks", "records"]);

// Thrown (never returned) when input carries an adversarial shape: a symbol
// key or an accessor property. It propagates to the evaluateEvidence catch,
// which fails the whole call closed as invalid-input. It never escapes.
const ADVERSARIAL_SHAPE = Symbol("adversarial-evidence-shape");

function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Reads exactly the requested own data properties, in order, without ever
// touching the object through ordinary property access, so accessor getters
// are never invoked. Returns the values array, or null when own keys are
// missing or extra (malformed data). Throws ADVERSARIAL_SHAPE on any symbol
// key or accessor descriptor. May throw on hostile proxies; the top-level
// catch turns that into invalid-input.
function readOwnDataFields(object, fieldNames) {
  const symbols = Object.getOwnPropertySymbols(object);
  if (symbols.length !== 0) {
    throw ADVERSARIAL_SHAPE;
  }
  const names = Object.getOwnPropertyNames(object);
  if (names.length !== fieldNames.length) {
    return null;
  }
  const values = [];
  for (const name of fieldNames) {
    const descriptor = Object.getOwnPropertyDescriptor(object, name);
    if (descriptor === undefined) {
      return null;
    }
    if (!("value" in descriptor)) {
      throw ADVERSARIAL_SHAPE;
    }
    values.push(descriptor.value);
  }
  return values;
}

// Dense ordinary array only: exact Array.prototype, no subclass, no holes, no
// extra own properties, no symbol keys, data descriptors only. The length is
// validated against [min, max] BEFORE any enumeration, so oversized hostile
// arrays are refused before their keys or elements are touched. Returns the
// element values or null. Throws ADVERSARIAL_SHAPE on symbols or accessors.
function readDenseArray(value, min, max) {
  if (!Array.isArray(value)) {
    return null;
  }
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    return null;
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor)) {
    throw ADVERSARIAL_SHAPE;
  }
  const length = lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || length < min || length > max) {
    return null;
  }
  const symbols = Object.getOwnPropertySymbols(value);
  if (symbols.length !== 0) {
    throw ADVERSARIAL_SHAPE;
  }
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== length + 1) {
    return null;
  }
  const elements = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined) {
      return null; // sparse hole
    }
    if (!("value" in descriptor)) throw ADVERSARIAL_SHAPE; // own index accessor
    elements.push(descriptor.value);
  }
  return elements;
}

function isSafeId(value) {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAX_ID_LENGTH &&
    !NEWLINE_PATTERN.test(value) &&
    SAFE_ID_PATTERN.test(value)
  );
}

function isRepository(value) {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAX_REPOSITORY_LENGTH &&
    !NEWLINE_PATTERN.test(value) &&
    REPOSITORY_PATTERN.test(value)
  );
}

function isSha40(value) {
  return (
    typeof value === "string" &&
    value.length === 40 &&
    !NEWLINE_PATTERN.test(value) &&
    SHA_40_PATTERN.test(value)
  );
}

function isDigest64(value) {
  return (
    typeof value === "string" &&
    value.length === 64 &&
    !NEWLINE_PATTERN.test(value) &&
    DIGEST_64_PATTERN.test(value)
  );
}

function isCount(value) {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_TEST_COUNT
  );
}

function isPullRequestValue(value) {
  // Positive safe integer, or null for local/push validation without a PR.
  return (
    value === null ||
    (typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 1 &&
      value <= Number.MAX_SAFE_INTEGER)
  );
}

// The snapshot functions below validate raw values and return freshly built
// plain objects holding only validated data. Everything downstream reads the
// snapshots, never the caller's objects.

function snapshotIdentity(value) {
  if (!isPlainObject(value)) {
    return null;
  }
  const fields = readOwnDataFields(value, IDENTITY_KEYS);
  if (fields === null) {
    return null;
  }
  const [
    repository,
    pullRequest,
    baseSha,
    headSha,
    testedTreeSha,
    policyDigest,
    evaluatorDigest,
    fixtureDigest,
  ] = fields;
  if (!isRepository(repository)) {
    return null;
  }
  if (!isPullRequestValue(pullRequest)) {
    return null;
  }
  if (
    !isSha40(baseSha) ||
    !isSha40(headSha) ||
    !isSha40(testedTreeSha)
  ) {
    return null;
  }
  if (
    !isDigest64(policyDigest) ||
    !isDigest64(evaluatorDigest) ||
    !isDigest64(fixtureDigest)
  ) {
    return null;
  }
  return {
    repository,
    pullRequest,
    baseSha,
    headSha,
    testedTreeSha,
    policyDigest,
    evaluatorDigest,
    fixtureDigest,
  };
}

function snapshotCheck(value) {
  if (!isPlainObject(value)) {
    return null;
  }
  const fields = readOwnDataFields(value, CHECK_KEYS);
  if (fields === null) {
    return null;
  }
  const [id, environmentId, minimumTests] = fields;
  if (!isSafeId(id) || !isSafeId(environmentId)) {
    return null;
  }
  if (
    typeof minimumTests !== "number" ||
    !Number.isSafeInteger(minimumTests) ||
    minimumTests < 1 ||
    minimumTests > MAX_TEST_COUNT
  ) {
    return null;
  }
  return { id, environmentId, minimumTests };
}

function snapshotTests(value) {
  if (!isPlainObject(value)) {
    return null;
  }
  const fields = readOwnDataFields(value, TESTS_KEYS);
  if (fields === null) {
    return null;
  }
  const [discovered, passed, failed, skipped, cancelled, todo] = fields;
  if (
    !isCount(discovered) ||
    !isCount(passed) ||
    !isCount(failed) ||
    !isCount(skipped) ||
    !isCount(cancelled) ||
    !isCount(todo)
  ) {
    return null;
  }
  if (passed + failed + skipped + cancelled + todo !== discovered) {
    return null;
  }
  return { discovered, passed, failed, skipped, cancelled, todo };
}

function snapshotRecord(value) {
  if (!isPlainObject(value)) {
    return null;
  }
  const fields = readOwnDataFields(value, RECORD_KEYS);
  if (fields === null) {
    return null;
  }
  const [schemaVersion, checkId, environmentId, identity, outcome, exitCode, tests] =
    fields;
  if (schemaVersion !== 1) {
    return null;
  }
  if (!isSafeId(checkId) || !isSafeId(environmentId)) {
    return null;
  }
  const identitySnapshot = snapshotIdentity(identity);
  if (identitySnapshot === null) {
    return null;
  }
  if (typeof outcome !== "string" || !OUTCOMES.includes(outcome)) {
    return null;
  }
  if (
    !(
      exitCode === null ||
      (typeof exitCode === "number" &&
        Number.isInteger(exitCode) &&
        exitCode >= 0 &&
        exitCode <= 255)
    )
  ) {
    return null;
  }
  const testsSnapshot = snapshotTests(tests);
  if (testsSnapshot === null) {
    return null;
  }
  return {
    schemaVersion: 1,
    checkId,
    environmentId,
    identity: identitySnapshot,
    outcome,
    exitCode,
    tests: testsSnapshot,
  };
}

// Only echo a malformed record's checkId when it is itself a validated safe
// identifier held in an own data descriptor. This never invokes a getter and
// never reads through the prototype chain.
function safeRecordCheckId(record) {
  if (!isPlainObject(record)) {
    return null;
  }
  const descriptor = Object.getOwnPropertyDescriptor(record, "checkId");
  if (descriptor === undefined || !("value" in descriptor)) {
    return null;
  }
  return isSafeId(descriptor.value) ? descriptor.value : null;
}

function identityEquals(a, b) {
  // Both sides are private snapshots; strict field comparison, no coercion.
  for (const key of IDENTITY_KEYS) {
    if (a[key] !== b[key]) {
      return false;
    }
  }
  return true;
}

function invalidInputResult() {
  return {
    eligible: false,
    reasons: [{ code: "invalid-input", checkId: null }],
  };
}

// evaluateEvidence({ expected, requiredChecks, records })
//
// Synchronous, pure predicate. Returns exactly
// { eligible: boolean, reasons: Array<{ code, checkId }> }.
// - Malformed global input (argument, expected, requiredChecks, records
//   container) yields a single invalid-input reason with checkId null.
// - A malformed individual record yields invalid-input echoing only its
//   validated checkId (or null); evaluation continues for other lanes.
// - Adversarial shape anywhere in the input (accessor property, symbol key,
//   hostile trap) fails the whole call closed as invalid-input with checkId
//   null; such input is never attributed to a lane.
// - Per-lane reasons are emitted in requiredChecks order, then
//   unexpected-check reasons in records order, deduplicated.
function evaluateEvidence(input) {
  try {
    return evaluate(input);
  } catch {
    // Never throw, even on hostile inputs such as throwing getters, hostile
    // proxies or the internal ADVERSARIAL_SHAPE marker.
    return invalidInputResult();
  }
}

function evaluate(input) {
  if (!isPlainObject(input)) {
    return invalidInputResult();
  }
  const inputFields = readOwnDataFields(input, INPUT_KEYS);
  if (inputFields === null) {
    return invalidInputResult();
  }
  const [expectedValue, requiredChecksValue, recordsValue] = inputFields;

  const expected = snapshotIdentity(expectedValue);
  if (expected === null) {
    return invalidInputResult();
  }

  const checkElements = readDenseArray(requiredChecksValue, 1, MAX_REQUIRED_CHECKS);
  if (checkElements === null) {
    return invalidInputResult();
  }
  const required = [];
  const requiredIds = new Set();
  for (const element of checkElements) {
    const check = snapshotCheck(element);
    if (check === null) {
      return invalidInputResult();
    }
    // Duplicate required IDs make "exactly one record per lane" ambiguous.
    if (requiredIds.has(check.id)) {
      return invalidInputResult();
    }
    requiredIds.add(check.id);
    required.push(check);
  }

  const recordElements = readDenseArray(recordsValue, 0, MAX_RECORDS);
  if (recordElements === null) {
    return invalidInputResult();
  }

  const reasons = [];
  const seenReasons = new Set();
  const addReason = (code, checkId) => {
    const key = code + "\u0000" + (checkId === null ? "" : checkId);
    if (!seenReasons.has(key)) {
      seenReasons.add(key);
      reasons.push({ code, checkId });
    }
  };

  // Bucket record snapshots by their validated checkId. A malformed record
  // still occupies its lane (reported as invalid-input) so the same evidence
  // is not double-reported as missing; records without a safe checkId cannot
  // be attributed to any lane.
  const byCheck = new Map();
  const validRecords = [];
  for (const element of recordElements) {
    const record = snapshotRecord(element);
    const valid = record !== null;
    const checkId = valid ? record.checkId : safeRecordCheckId(element);
    if (!valid) {
      addReason("invalid-input", checkId);
    }
    if (checkId === null) {
      continue;
    }
    let bucket = byCheck.get(checkId);
    if (bucket === undefined) {
      bucket = [];
      byCheck.set(checkId, bucket);
    }
    bucket.push(valid ? record : null);
    if (valid) {
      validRecords.push(record);
    }
  }

  for (const check of required) {
    const matches = byCheck.get(check.id);
    if (matches === undefined || matches.length === 0) {
      addReason("missing-check", check.id);
      continue;
    }
    if (matches.length > 1) {
      // Never pick the "best" or "newest" duplicate.
      addReason("duplicate-check", check.id);
      continue;
    }
    const record = matches[0];
    if (record === null) {
      // Malformed record for this lane; already reported as invalid-input.
      continue;
    }
    if (!identityEquals(record.identity, expected)) {
      addReason("identity-mismatch", check.id);
    }
    if (record.environmentId !== check.environmentId) {
      addReason("environment-mismatch", check.id);
    }
    if (record.outcome !== "pass") {
      addReason("nonpassing-outcome", check.id);
    }
    if (record.exitCode !== 0) {
      // A null exitCode is not a proven zero exit and is rejected here.
      addReason("nonzero-exit", check.id);
    }
    const tests = record.tests;
    if (tests.discovered < check.minimumTests) {
      addReason("insufficient-tests", check.id);
    }
    if (
      tests.failed !== 0 ||
      tests.skipped !== 0 ||
      tests.cancelled !== 0 ||
      tests.todo !== 0 ||
      tests.passed !== tests.discovered
    ) {
      addReason("unsuccessful-tests", check.id);
    }
  }

  for (const record of validRecords) {
    if (!requiredIds.has(record.checkId)) {
      addReason("unexpected-check", record.checkId);
    }
  }

  return { eligible: reasons.length === 0, reasons };
}

module.exports = { evaluateEvidence, REASON_CODES };
