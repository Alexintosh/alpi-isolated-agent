'use strict';

// Pure admission predicate for ATC guard results.
// Pinned upstream protocol: ashhart/ATC
// https://github.com/ashhart/ATC/tree/c8787cc58648732e1fb21c4d5ad80b1bab4e4ec0
// Schema mirrors src/hooks/guardResults.js at commit
// c8787cc58648732e1fb21c4d5ad80b1bab4e4ec0 (version 0.9.6).
//
// This module validates data only. It does NOT acquire or release any lease,
// does NOT authenticate the subprocess that produced the guard result, does
// NOT prove freshness, and does NOT enforce exclusivity across processes.
// The controller must still: authenticate a fresh `atc guard` subprocess run
// and its exit status, bind cwd/repository/HEAD/base, serialize actual scope
// leases across controller processes, and enforce required GitHub checks.
// Comparing the `files` count is NOT validation of actual paths, repository,
// scope or current Git state.

const GUARD_FIELDS = Object.freeze([
  'command', 'issue', 'complete', 'outcome', 'ready',
  'session', 'plan', 'base', 'files', 'conflicts',
]);
const EXPECTED_FIELDS = Object.freeze(['issue', 'session', 'plan', 'base', 'files']);
const ENVELOPE_FIELDS = Object.freeze(['guard', 'expected']);
const CONFLICT_FIELDS = Object.freeze(['issue', 'plan', 'session', 'sharedFiles']);

const OUTCOMES = Object.freeze([
  'ready', 'noTicket', 'incomplete', 'scopeTaken', 'claimRequired', 'notEnabled',
  'planExpired', 'scopeChanged', 'baseChanged', 'notInScope', 'readOnly', 'pending',
  'notOpen', 'uncertain', 'claimLimit', 'planLimit', 'prerequisitesUnavailable',
  'dryRun', 'mergeConflicts',
]);
const READY_LIKE_OUTCOMES = Object.freeze(['ready', 'noTicket']);

const REASON_READY = 'ready';
const REASON_INVALID = 'invalid-input';
const REASON_INCOMPLETE = 'incomplete';
const REASON_NOT_READY = 'not-ready';
const REASON_IDENTITY = 'identity-mismatch';

const ISSUE_MIN = 1;
const ISSUE_MAX = 999999999;
const SESSION_MIN = 1;
const SESSION_MAX = 999999999999999;
const PLAN_MIN = 1;
const PLAN_MAX = Number.MAX_SAFE_INTEGER;
const FILES_MIN = 0;
const FILES_MAX = 32;
const SHARED_FILES_MIN = 1;
const SHARED_FILES_MAX = 32;
const CONFLICTS_MAX = 1000;

// `$` alone would match before a trailing newline; the newline guard below
// closes that hole, mirroring the upstream isSha check.
const SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const NEWLINE_PATTERN = /[\r\n]/;

function verdict(admitted, reason) {
  return { admitted, reason };
}

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

// Reads exactly the requested own data properties, in order, without ever
// touching the object through property access (so accessor getters are never
// invoked). Returns null when the record carries any symbol key, accessor
// property, missing field or extra own property. May throw on hostile proxies;
// callers rely on the top-level catch.
function readOwnDataFields(record, fieldNames) {
  const names = Object.getOwnPropertyNames(record);
  const symbols = Object.getOwnPropertySymbols(record);
  if (names.length !== fieldNames.length || symbols.length !== 0) return null;
  const nameSet = new Set(names);
  const values = [];
  for (const name of fieldNames) {
    if (!nameSet.has(name)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(record, name);
    if (descriptor === undefined || !('value' in descriptor)) return null;
    values.push(descriptor.value);
  }
  return values;
}

// Dense standard array only: exact Array.prototype, no subclass, no holes, no
// extra own properties, no symbol keys, data descriptors only. Returns the
// element values or null.
function readDenseArrayElements(value) {
  if (!Array.isArray(value)) return null;
  if (Object.getPrototypeOf(value) !== Array.prototype) return null;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (!lengthDescriptor || !('value' in lengthDescriptor)) return null;
  const length = lengthDescriptor.value;
  if (!isBoundedInteger(length, 0, CONFLICTS_MAX)) return null;
  const names = Object.getOwnPropertyNames(value);
  const symbols = Object.getOwnPropertySymbols(value);
  if (symbols.length !== 0) return null;
  if (names.length !== length + 1) return null;
  const nameSet = new Set(names);
  if (!nameSet.has('length')) return null;
  const elements = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    if (!nameSet.has(key)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) return null;
    elements.push(descriptor.value);
  }
  return elements;
}

function isBoundedInteger(value, low, high) {
  return Number.isSafeInteger(value) && value >= low && value <= high;
}

function isNullableBoundedInteger(value, low, high) {
  return value === null || isBoundedInteger(value, low, high);
}

function isSha(value) {
  return typeof value === 'string'
    && (value.length === 40 || value.length === 64)
    && !NEWLINE_PATTERN.test(value)
    && SHA_PATTERN.test(value);
}

function isOutcome(value) {
  return typeof value === 'string' && OUTCOMES.includes(value);
}

function readConflict(value) {
  if (!isPlainRecord(value)) return null;
  const values = readOwnDataFields(value, CONFLICT_FIELDS);
  if (values === null) return null;
  const [issue, plan, session, sharedFiles] = values;
  if (!isBoundedInteger(issue, ISSUE_MIN, ISSUE_MAX)) return null;
  if (!isBoundedInteger(plan, PLAN_MIN, PLAN_MAX)) return null;
  if (!isBoundedInteger(session, SESSION_MIN, SESSION_MAX)) return null;
  if (!isBoundedInteger(sharedFiles, SHARED_FILES_MIN, SHARED_FILES_MAX)) return null;
  return { issue, plan, session, sharedFiles };
}

// Structural + semantic validation of the untrusted guard record, mirroring
// readGuardResult in the pinned upstream source. Returns a normalized view or
// null for any malformed shape, type or semantic contradiction.
function readGuard(value) {
  if (!isPlainRecord(value)) return null;
  const values = readOwnDataFields(value, GUARD_FIELDS);
  if (values === null) return null;
  const [command, issue, complete, outcome, ready, session, plan, base, files, conflicts] = values;

  if (command !== 'guard') return null;
  if (typeof complete !== 'boolean') return null;
  if (typeof ready !== 'boolean') return null;
  if (!isOutcome(outcome)) return null;
  if (!isNullableBoundedInteger(issue, ISSUE_MIN, ISSUE_MAX)) return null;
  if (!isNullableBoundedInteger(session, SESSION_MIN, SESSION_MAX)) return null;
  if (!isNullableBoundedInteger(plan, PLAN_MIN, PLAN_MAX)) return null;
  if (base !== null && !isSha(base)) return null;
  if (!isBoundedInteger(files, FILES_MIN, FILES_MAX)) return null;

  const conflictElements = readDenseArrayElements(conflicts);
  if (conflictElements === null) return null;
  for (const element of conflictElements) {
    if (readConflict(element) === null) return null;
  }

  // Semantic constraints from the pinned upstream source.
  const readyLike = READY_LIKE_OUTCOMES.includes(outcome);
  if (ready !== readyLike) return null;
  if (ready && !complete) return null;
  if (outcome === 'noTicket'
    && (issue !== null || session !== null || plan !== null || base !== null
      || files !== 0 || conflictElements.length !== 0)) return null;
  if (outcome === 'ready'
    && (issue === null || session === null || plan === null || base === null
      || files < 1 || conflictElements.length !== 0)) return null;

  return { complete, ready, outcome, issue, session, plan, base, files };
}

// Validation of the trusted current identity supplied by the controller. All
// fields are required non-null with the same numeric bounds as the guard.
function readExpected(value) {
  if (!isPlainRecord(value)) return null;
  const values = readOwnDataFields(value, EXPECTED_FIELDS);
  if (values === null) return null;
  const [issue, session, plan, base, files] = values;
  if (!isBoundedInteger(issue, ISSUE_MIN, ISSUE_MAX)) return null;
  if (!isBoundedInteger(session, SESSION_MIN, SESSION_MAX)) return null;
  if (!isBoundedInteger(plan, PLAN_MIN, PLAN_MAX)) return null;
  if (!isSha(base)) return null;
  if (!isBoundedInteger(files, 1, FILES_MAX)) return null;
  return { issue, session, plan, base, files };
}

// evaluateAtcGuard({guard, expected}) -> {admitted, reason}
//
// Pure, synchronous, deterministic. No IO, no input mutation, never throws on
// malformed ordinary JS inputs (including throwing getters and hostile
// proxies, which fail as invalid-input; no protection is claimed against
// arbitrary proxy side effects). Reasons: success 'ready'; failures
// 'invalid-input' | 'incomplete' | 'not-ready' | 'identity-mismatch'.
// No untrusted value ever appears in the returned object.
function evaluateAtcGuard(envelope) {
  try {
    if (!isPlainRecord(envelope)) return verdict(false, REASON_INVALID);
    const envelopeValues = readOwnDataFields(envelope, ENVELOPE_FIELDS);
    if (envelopeValues === null) return verdict(false, REASON_INVALID);
    const [guardValue, expectedValue] = envelopeValues;

    const guard = readGuard(guardValue);
    const expected = readExpected(expectedValue);
    if (guard === null || expected === null) return verdict(false, REASON_INVALID);

    if (!guard.complete) return verdict(false, REASON_INCOMPLETE);
    if (guard.outcome !== 'ready') return verdict(false, REASON_NOT_READY);

    if (guard.issue !== expected.issue) return verdict(false, REASON_IDENTITY);
    if (guard.session !== expected.session) return verdict(false, REASON_IDENTITY);
    if (guard.plan !== expected.plan) return verdict(false, REASON_IDENTITY);
    if (guard.base !== expected.base) return verdict(false, REASON_IDENTITY);
    if (guard.files !== expected.files) return verdict(false, REASON_IDENTITY);

    return verdict(true, REASON_READY);
  } catch {
    return verdict(false, REASON_INVALID);
  }
}

module.exports = { evaluateAtcGuard };
