// Harness-neutral observation and cancellation result contract.
//
// This module knows only the portable field names Alpi publishes. It never
// imports, names or parses a specific backend, RPC method, record type or stock
// payload shape. Validators return fresh picked objects; any shape that does not
// match the frozen contract is a fixed `guest_failed` error. The fixed message
// intentionally matches the service vocabulary; dependency text is never reused.
"use strict";

const MAX_TEXT_BYTES = 16384;
const MAX_PENDING_ACTIONS = 3;

const STATES = new Set(["running", "waiting", "idle", "unknown"]);
const PENDING_KINDS = new Set(["approval", "question", "other"]);

const OBSERVATION_KEYS = ["state", "live", "cursor", "pendingActions",
  "assistantText", "truncated", "capabilities"];
const ACTION_KEYS = ["kind", "detailAvailable", "resolution"];
const TRUNCATED_KEYS = ["text", "records"];
const CAPABILITY_KEYS = ["observation", "pendingActionDetail", "approvalResolution",
  "cancellationRequest", "rawObservation"];
const CANCELLATION_KEYS = ["requested", "acknowledged", "cooperative", "processTermination"];

const GUEST_FAILED_MESSAGE = "The guest operation failed.";

function guestFailed() {
  const error = new Error(GUEST_FAILED_MESSAGE);
  error.code = "guest_failed";
  return error;
}

function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys) {
  return isPlainObject(value)
    && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

// Bounded, well-formed UTF-8 text. A lone surrogate would round-trip to a
// replacement character, so it is rejected rather than silently changed.
function boundedText(value, maximumBytes) {
  if (typeof value !== "string") return false;
  if (Buffer.byteLength(value, "utf8") > maximumBytes) return false;
  return Buffer.from(value, "utf8").toString("utf8") === value;
}

/**
 * Validate one compact observation snapshot.
 * @param value - untrusted snapshot produced by a harness adapter.
 * @returns a fresh object containing only the frozen contract fields.
 * @throws fixed `guest_failed` for any shape outside the contract.
 */
function validateObservation(value) {
  if (!exactKeys(value, OBSERVATION_KEYS)) throw guestFailed();
  if (!STATES.has(value.state)) throw guestFailed();
  if (!(value.live === null || typeof value.live === "boolean")) throw guestFailed();
  if (!(value.cursor === null
    || (Number.isSafeInteger(value.cursor) && value.cursor >= 0))) {
    throw guestFailed();
  }

  const actions = value.pendingActions;
  if (!Array.isArray(actions) || actions.length > MAX_PENDING_ACTIONS) {
    throw guestFailed();
  }
  const kinds = new Set();
  const pendingActions = actions.map(action => {
    if (!exactKeys(action, ACTION_KEYS)) throw guestFailed();
    if (!PENDING_KINDS.has(action.kind)
      || action.detailAvailable !== false
      || action.resolution !== "guest-ui") {
      throw guestFailed();
    }
    // Duplicate kinds are never surfaced twice; the adapter deduplicates and a
    // duplicate here is a contract violation, not something to silently repair.
    if (kinds.has(action.kind)) throw guestFailed();
    kinds.add(action.kind);
    return { kind: action.kind, detailAvailable: false, resolution: "guest-ui" };
  });

  if (!boundedText(value.assistantText, MAX_TEXT_BYTES)) throw guestFailed();

  const truncated = value.truncated;
  if (!exactKeys(truncated, TRUNCATED_KEYS)
    || typeof truncated.text !== "boolean"
    || typeof truncated.records !== "boolean") {
    throw guestFailed();
  }

  const capabilities = value.capabilities;
  if (!exactKeys(capabilities, CAPABILITY_KEYS)) throw guestFailed();
  if (capabilities.observation !== true
    || capabilities.pendingActionDetail !== "kind-only"
    || capabilities.approvalResolution !== false
    || typeof capabilities.cancellationRequest !== "boolean"
    || typeof capabilities.rawObservation !== "boolean") {
    throw guestFailed();
  }

  return {
    state: value.state,
    live: value.live,
    cursor: value.cursor,
    pendingActions,
    assistantText: value.assistantText,
    truncated: { text: truncated.text, records: truncated.records },
    capabilities: {
      observation: true,
      pendingActionDetail: "kind-only",
      approvalResolution: false,
      cancellationRequest: capabilities.cancellationRequest,
      rawObservation: capabilities.rawObservation,
    },
  };
}

/**
 * Validate one cooperative cancellation receipt.
 * @param value - untrusted receipt produced by a harness adapter.
 * @returns the fresh frozen receipt shape.
 * @throws fixed `guest_failed` for any other shape.
 */
function validateCancellation(value) {
  if (!exactKeys(value, CANCELLATION_KEYS)) throw guestFailed();
  if (value.requested !== true
    || value.acknowledged !== true
    || value.cooperative !== true
    || value.processTermination !== "unknown") {
    throw guestFailed();
  }
  return {
    requested: true,
    acknowledged: true,
    cooperative: true,
    processTermination: "unknown",
  };
}

module.exports = { validateObservation, validateCancellation };
