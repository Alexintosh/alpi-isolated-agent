// Stock Harness observation adapter. This is the only module that knows the
// current stock RPC method names, request field names and response shapes. It
// projects them into the neutral contract in observation.cjs; callers consume
// normalized values only.
//
// The adapter holds no filesystem, driver, journal or host-mutation access. It
// receives an injected `rpc(method, args)` closure owned by the service inside
// its verified withRunning call, and it never retries with another method or
// widens authority when a call fails or a capability is absent.
"use strict";

const { validateObservation, validateCancellation } = require("./observation.cjs");

const MAX_IDENTIFIER = 256;
const MAX_TEXT_BYTES = 16384;
const MAX_WAIT_TIMEOUT_MS = 20000;
const MAX_MESSAGES = 32;
const COMPACT_MAX_MESSAGES = 1;
const RAW_MAX_MESSAGES = 8;
// Hard loop bounds independent of what a backend returns. Stock `session/wait`
// already caps records at the requested maxMessages, but a hostile or future
// backend response must not drive unbounded traversal.
const MAX_RECORDS = 64;
const MAX_BLOCKS = 64;

const CONTROL = /[\x00-\x1f\x7f]/;

const MESSAGES = Object.freeze({
  invalid_arguments: "Invalid orchestration request.",
  unsupported: "This orchestration operation is not available yet.",
  aborted: "The orchestration operation was cancelled.",
  guest_failed: "The guest operation failed.",
});

const WAIT_REASONS = new Set(["idle", "input-required", "timeout"]);
const OPTION_KEYS = new Set(["cursor", "timeoutMs", "maxMessages"]);
const ABORT_CODES = new Set(["ABORT_ERR", "guest-aborted", "aborted"]);

function fixed(code) {
  const error = new Error(MESSAGES[code]);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// Rebuild a known category instead of rethrowing a dependency object whose
// message, stack, cause or extra properties may carry guest/transport data.
function sanitize(error) {
  let code = null;
  try {
    code = error !== null && typeof error === "object" ? error.code : null;
  } catch {
    code = null;
  }
  if (typeof code === "string") {
    if (code === "guest_failed" || code === "invalid_arguments" || code === "unsupported") {
      return fixed(code);
    }
    if (ABORT_CODES.has(code)) return fixed("aborted");
  }
  let name = null;
  try {
    name = error !== null && typeof error === "object" ? error.name : null;
  } catch {
    name = null;
  }
  if (name === "AbortError") return fixed("aborted");
  return fixed("guest_failed");
}

function identifier(value) {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= MAX_IDENTIFIER
    && !CONTROL.test(value);
}

// The binding is host-recorded intent metadata. A guest-supplied identity is
// never accepted: the caller must pass exactly one conversation identity.
function bindingId(binding) {
  if (!isPlainObject(binding)
    || Object.keys(binding).length !== 1
    || !Object.hasOwn(binding, "conversationId")
    || !identifier(binding.conversationId)) {
    throw fixed("invalid_arguments");
  }
  return binding.conversationId;
}

// Request bounds are validated defensively; unknown keys are refused rather
// than guessed. A cursor of -1 is the stock "no lower bound" sentinel and is
// normalized to null so the caller omits the argument instead of sending it.
function parseOptions(request, defaultMaxMessages) {
  if (request === undefined) request = {};
  if (!isPlainObject(request)) throw fixed("invalid_arguments");
  if (Object.keys(request).some(key => !OPTION_KEYS.has(key))) {
    throw fixed("invalid_arguments");
  }

  let cursor = null;
  const rawCursor = request.cursor;
  if (rawCursor !== undefined && rawCursor !== null) {
    if (!Number.isSafeInteger(rawCursor) || rawCursor < -1) throw fixed("invalid_arguments");
    if (rawCursor >= 0) cursor = rawCursor;
  }

  let timeoutMs = null;
  if (request.timeoutMs !== undefined) {
    if (!Number.isSafeInteger(request.timeoutMs)
      || request.timeoutMs < 1
      || request.timeoutMs > MAX_WAIT_TIMEOUT_MS) {
      throw fixed("invalid_arguments");
    }
    timeoutMs = request.timeoutMs;
  }

  let maxMessages = defaultMaxMessages;
  if (request.maxMessages !== undefined) {
    if (!Number.isSafeInteger(request.maxMessages)
      || request.maxMessages < 1
      || request.maxMessages > MAX_MESSAGES) {
      throw fixed("invalid_arguments");
    }
    maxMessages = request.maxMessages;
  }

  return { cursor, timeoutMs, maxMessages };
}

function waitArgs(conversationId, options) {
  const args = { sessionId: conversationId, maxMessages: options.maxMessages };
  if (options.timeoutMs !== null) args.timeoutMs = options.timeoutMs;
  if (options.cursor !== null) args.afterSeq = options.cursor;
  return args;
}

// Replace unpaired surrogates with U+FFFD so projected text is always valid
// UTF-8. Guest JSON can carry lone escapes; the visible text stays deterministic.
function wellFormed(value) {
  return Buffer.from(value, "utf8").toString("utf8");
}

// Truncate to a byte budget on a code-point boundary. Never splits a surrogate
// pair or a multi-byte code point.
function truncateUtf8(value, maximumBytes) {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) {
    return { text: value, truncated: false };
  }
  let text = "";
  let used = 0;
  for (const codePoint of value) {
    const bytes = Buffer.byteLength(codePoint, "utf8");
    if (used + bytes > maximumBytes) break;
    text += codePoint;
    used += bytes;
  }
  return { text, truncated: true };
}

function pendingKinds(value) {
  if (!Array.isArray(value)) return null;
  const kinds = [];
  const seen = new Set();
  for (const item of value) {
    // Only sampled kind strings are projected. A non-string entry means the
    // pending list itself is malformed: refusing it avoids hiding a handoff
    // behind a fabricated idle claim.
    if (typeof item !== "string") return null;
    const kind = item === "approval" ? "approval"
      : item === "question" ? "question" : "other";
    if (seen.has(kind)) continue;
    seen.add(kind);
    kinds.push(kind);
    if (kinds.length === 3) break;
  }
  return kinds;
}

// Project only text content blocks from assistant/message records. Reasoning,
// tool-call arguments, images, unknown blocks, the per-message stream tree and
// the queue are never traversed. Records are newest-first; text is assembled in
// that order and in log order within a message.
function projectText(output, maxMessages) {
  if (!isPlainObject(output)) {
    return { text: "", textTruncated: false, recordsTruncated: false };
  }
  const sourceTruncated = output.truncated === true;
  const records = output.records;
  if (!Array.isArray(records)) {
    return { text: "", textTruncated: false, recordsTruncated: sourceTruncated };
  }

  const limit = Math.min(records.length, Math.min(maxMessages, MAX_RECORDS));
  let recordsTruncated = sourceTruncated || records.length > limit;
  let textTruncated = false;
  const parts = [];

  for (let index = 0; index < limit; index += 1) {
    const record = records[index];
    if (!isPlainObject(record) || record.type !== "event") continue;
    const event = record.event;
    if (!isPlainObject(event) || event.type !== "assistant/message") continue;
    const data = event.data;
    if (!isPlainObject(data)) continue;
    const message = data.message;
    if (!isPlainObject(message)) continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;

    const blockLimit = Math.min(content.length, MAX_BLOCKS);
    if (content.length > blockLimit) textTruncated = true;
    for (let blockIndex = 0; blockIndex < blockLimit; blockIndex += 1) {
      const block = content[blockIndex];
      if (!isPlainObject(block)
        || block.type !== "text"
        || typeof block.text !== "string"
        || block.text.length === 0) {
        continue;
      }
      parts.push(wellFormed(block.text));
    }
  }

  let text = "";
  let remaining = MAX_TEXT_BYTES;
  let first = true;
  for (const part of parts) {
    const separatorBytes = first ? 0 : 1;
    const partBytes = Buffer.byteLength(part, "utf8");
    if (separatorBytes + partBytes <= remaining) {
      text += first ? part : `\n${part}`;
      remaining -= separatorBytes + partBytes;
      first = false;
      continue;
    }
    if (separatorBytes === 1) {
      if (remaining < 1) {
        textTruncated = true;
        break;
      }
      text += "\n";
      remaining -= 1;
      first = false;
    }
    const piece = truncateUtf8(part, remaining);
    text += piece.text;
    textTruncated = true;
    break;
  }

  return { text, textTruncated, recordsTruncated };
}

function unknownSnapshot(cursor, live, capabilities) {
  return {
    state: "unknown",
    live,
    cursor,
    pendingActions: [],
    assistantText: "",
    truncated: { text: false, records: false },
    capabilities,
  };
}

function project(value, maxMessages, capabilities) {
  if (!isPlainObject(value)) return unknownSnapshot(null, null, capabilities);

  const state = isPlainObject(value.state) ? value.state : null;
  let cursor = null;
  let live = null;
  if (state !== null) {
    if (Number.isSafeInteger(state.cursor) && state.cursor >= 0) cursor = state.cursor;
    if (typeof state.active === "boolean") live = state.active;
  }

  // A known stopping reason and a sampled state block are required before any
  // state is claimed. Unknown reasons map to explicit unknown, never to idle.
  if (state === null
    || typeof value.reason !== "string"
    || !WAIT_REASONS.has(value.reason)
    || typeof state.active !== "boolean"
    || typeof state.running !== "boolean") {
    return unknownSnapshot(cursor, live, capabilities);
  }

  const kinds = pendingKinds(state.pendingInput);
  if (kinds === null) return unknownSnapshot(cursor, live, capabilities);

  const pendingActions = kinds.map(kind => ({
    kind,
    detailAvailable: false,
    resolution: "guest-ui",
  }));
  // A stopping reason that reports required input with no sampled pending kind
  // is contradictory. Never hide that handoff behind an idle claim.
  if (value.reason === "input-required" && pendingActions.length === 0) {
    return unknownSnapshot(cursor, live, capabilities);
  }
  const text = projectText(value.output, maxMessages);
  let observed;
  if (pendingActions.length > 0) observed = "waiting";
  else if (state.running) observed = "running";
  else observed = "idle";

  return {
    state: observed,
    live,
    cursor,
    pendingActions,
    assistantText: text.text,
    truncated: { text: text.textTruncated, records: text.recordsTruncated },
    capabilities,
  };
}

function capabilities() {
  return {
    observation: true,
    pendingActionDetail: "kind-only",
    approvalResolution: false,
    cancellationRequest: true,
    rawObservation: true,
  };
}

async function call(rpc, method, args) {
  try {
    return await rpc(method, args);
  } catch (error) {
    throw sanitize(error);
  }
}

/**
 * Create the stock observation adapter.
 * @param dependencies - `{ rpc }` where `rpc(method, args)` is an injected
 *   closure owned by the service inside its verified withRunning call.
 * @returns `{ capabilities, observe, observeRaw, requestCancel }`.
 */
function createHarnessAdapter(dependencies) {
  const rpc = dependencies !== null && typeof dependencies === "object"
    ? dependencies.rpc
    : undefined;
  if (typeof rpc !== "function") throw fixed("invalid_arguments");

  async function observe(binding, request) {
    const conversationId = bindingId(binding);
    const options = parseOptions(request, COMPACT_MAX_MESSAGES);
    const value = await call(rpc, "session/wait", waitArgs(conversationId, options));
    return validateObservation(project(value, options.maxMessages, capabilities()));
  }

  // Explicit diagnostic mode only. The bounded helper payload is returned
  // unchanged and remains backend-specific, untrusted data; it is excluded from
  // the neutral guarantees and never requested by ordinary workflow.
  async function observeRaw(binding, request) {
    const conversationId = bindingId(binding);
    const options = parseOptions(request, RAW_MAX_MESSAGES);
    return call(rpc, "session/wait", waitArgs(conversationId, options));
  }

  async function requestCancel(binding) {
    const conversationId = bindingId(binding);
    const value = await call(rpc, "session/cancel", { sessionId: conversationId });
    // Stock acknowledges admission only. Anything other than an explicit
    // accepted:true is an unknown outcome, never a successful request.
    if (!isPlainObject(value) || value.accepted !== true) throw fixed("guest_failed");
    return validateCancellation({
      requested: true,
      acknowledged: true,
      cooperative: true,
      processTermination: "unknown",
    });
  }

  return { capabilities, observe, observeRaw, requestCancel };
}

module.exports = { createHarnessAdapter };
