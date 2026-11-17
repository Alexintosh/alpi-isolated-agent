// Host adapter for guest-only command execution and stock Harness RPC calls.
// It never spawns a host shell or fetches a guest URL: every operation is a
// fixed `/bin/sh -c` script executed through an owned VM driver. Guest output
// remains untrusted data and is parsed with bounded, fixed error codes.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const GUEST_NODE = "/home/user/.harness-isolated/node/bin/node";
const DEFAULT_CWD = "/home/user/workspace";
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_COMMAND_BYTES = 32768;
const MAX_ARGS_BYTES = 65536;
const MAX_OUTPUT_BYTES = 524288;
const MAX_STREAM_BYTES = 65536;
const MAX_SCRIPT_BYTES = 131072;
const MAX_COMMAND_TIMEOUT_MS = 95000;
const MAX_DEADLINE_MS = 100000;
const HOST_GRACE_MS = 3000;
const RPC_TIMEOUT_MS = 90000;

const RPC_METHODS = new Set([
  "session/create",
  "session/selectModel",
  "session/prompt",
  "session/wait",
  "session/cancel",
  "session/state",
]);

// The host validates these arguments before invoking the guest, and the
// standalone helper repeats the checks because it cannot trust its caller.
const RPC_ARG_KEYS = Object.freeze({
  "session/create": ["cwd", "sessionId"],
  "session/selectModel": ["sessionId", "provider", "model", "reasoningEffort"],
  "session/prompt": ["sessionId", "requestId", "mode", "content", "clientTimeZone"],
  "session/wait": ["sessionId", "timeoutMs", "afterSeq", "maxMessages"],
  "session/cancel": ["sessionId"],
  "session/state": ["sessionId"],
});

const HELPER_CODES = new Set([
  "guest-request-invalid",
  "guest-config-invalid",
  "guest-command-invalid",
  "guest-cwd-invalid",
  "guest-command-failed",
  "guest-launch-invalid",
  "guest-launch-unavailable",
  "guest-method-invalid",
  "guest-args-invalid",
  "guest-rpc-auth",
  "guest-rpc-http",
  "guest-rpc-invalid",
  "guest-rpc-oversize",
  "guest-rpc-timeout",
  "guest-rpc-rejected",
  "guest-rpc-failed",
  "guest-output-oversize",
]);

const HOST_CODES = new Set([
  "guest-options-invalid",
  "guest-timeout-invalid",
  "guest-output-invalid",
  "guest-transport-failed",
  "guest-aborted",
]);

const MESSAGES = Object.freeze({
  "guest-options-invalid": "Invalid guest orchestration options.",
  "guest-command-invalid": "The guest command is invalid or too large.",
  "guest-cwd-invalid": "The guest working directory is invalid.",
  "guest-timeout-invalid": "The guest timeout is invalid.",
  "guest-method-invalid": "The Harness RPC method is not allowed.",
  "guest-args-invalid": "The Harness RPC arguments are invalid or too large.",
  "guest-output-invalid": "The guest returned an invalid response.",
  "guest-output-oversize": "The guest response exceeded the size limit.",
  "guest-transport-failed": "The guest command could not be executed.",
  "guest-aborted": "The guest operation was cancelled.",
  "guest-rpc-timeout": "The Harness RPC request timed out.",
  "guest-rpc-auth": "The guest Harness authentication was rejected.",
  "guest-rpc-http": "The guest Harness request failed.",
  "guest-rpc-invalid": "The guest Harness returned an invalid response.",
  "guest-rpc-oversize": "The guest Harness response exceeded the size limit.",
  "guest-rpc-rejected": "The guest Harness rejected the request.",
  "guest-launch-invalid": "The guest Harness launch information is invalid.",
  "guest-launch-unavailable": "The guest Harness launch information is unavailable.",
  "guest-config-invalid": "The guest network configuration is invalid.",
  "guest-command-failed": "The guest command failed to start.",
  "guest-rpc-failed": "The guest Harness request failed.",
  "guest-request-invalid": "The guest orchestration request is invalid.",
});

const REMOTE_CODE_PATTERN = /^[a-z][a-z0-9-]{0,31}\/[a-z][a-z0-9-]{0,31}$/;
const CONTROL_PATTERN = /[\x00-\x1f\x7f]/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const HELPER_SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "..", "guest", "v1", "orchestration.cjs"),
  "utf8",
);
if (!HELPER_SOURCE || HELPER_SOURCE.includes("\0")) {
  throw new Error("The guest orchestration helper is unavailable.");
}

function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeError(code) {
  const message = Object.hasOwn(MESSAGES, code) ? MESSAGES[code] : "The guest operation failed.";
  const error = new Error(message);
  error.code = code;
  return error;
}

// Rebuild a known error instead of rethrowing a driver/helper object whose
// message, stack or cause may contain raw guest or transport data.
function knownError(error) {
  let code;
  let remoteCode;
  try {
    code = error && typeof error.code === "string" ? error.code : undefined;
    remoteCode = error && error.remoteCode;
  } catch {
    return undefined;
  }
  if (code === undefined || (!HOST_CODES.has(code) && !HELPER_CODES.has(code))) return undefined;
  const safe = safeError(code);
  if (code === "guest-rpc-rejected"
    && typeof remoteCode === "string"
    && REMOTE_CODE_PATTERN.test(remoteCode)) {
    safe.remoteCode = remoteCode;
  }
  return safe;
}

function quoteShellArgument(value) {
  if (typeof value !== "string" || value.includes("\0")) {
    throw safeError("guest-request-invalid");
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function assertDriver(driver) {
  if (!driver || typeof driver.exec !== "function") throw safeError("guest-options-invalid");
}

function assertOptions(options) {
  if (!isPlainObject(options)) throw safeError("guest-options-invalid");
  if (typeof options.ownershipToken !== "string"
    || options.ownershipToken.length === 0
    || options.ownershipToken.length > 256
    || CONTROL_PATTERN.test(options.ownershipToken)) {
    throw safeError("guest-options-invalid");
  }
  if (options.signal !== undefined) {
    const signal = options.signal;
    if (!signal
      || typeof signal.aborted !== "boolean"
      || typeof signal.addEventListener !== "function"
      || typeof signal.removeEventListener !== "function") {
      throw safeError("guest-options-invalid");
    }
  }
}

function assertCommand(command) {
  if (typeof command !== "string"
    || command.includes("\0")
    || Buffer.byteLength(command, "utf8") > MAX_COMMAND_BYTES) {
    throw safeError("guest-command-invalid");
  }
}

function assertCwd(cwd) {
  if (!isSafeAbsolutePath(cwd)) throw safeError("guest-cwd-invalid");
}

function isIdentifier(value) {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 256
    && !CONTROL_PATTERN.test(value);
}

function isBoundedText(value, maximum) {
  return typeof value === "string"
    && value.length <= maximum
    && !CONTROL_PATTERN.test(value);
}

function isSafeAbsolutePath(value) {
  return typeof value === "string"
    && value.startsWith("/")
    && value.length <= 4096
    && !CONTROL_PATTERN.test(value);
}

function validContent(content) {
  if (!Array.isArray(content) || content.length > 256) return false;
  for (const part of content) {
    if (!isPlainObject(part)) return false;
    if (part.type === "text") {
      if (typeof part.text !== "string") return false;
      continue;
    }
    if (part.type === "image") {
      if (typeof part.mediaType !== "string" || typeof part.data !== "string") return false;
      if (part.name !== undefined && typeof part.name !== "string") return false;
      continue;
    }
    if (part.type === "file") {
      if (typeof part.receiptId !== "string") return false;
      continue;
    }
    return false;
  }
  return true;
}

function validateRpcArgs(method, args) {
  if (!isPlainObject(args)) return false;
  const allowed = RPC_ARG_KEYS[method];
  if (allowed === undefined) return false;
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) return false;
  }
  switch (method) {
    case "session/create":
      return (args.cwd === undefined || isSafeAbsolutePath(args.cwd))
        && (args.sessionId === undefined || isIdentifier(args.sessionId));
    case "session/selectModel":
      return isIdentifier(args.sessionId)
        && isIdentifier(args.provider)
        && isIdentifier(args.model)
        && (args.reasoningEffort === undefined
          || (isBoundedText(args.reasoningEffort, 128) && args.reasoningEffort.length > 0));
    case "session/prompt":
      return isIdentifier(args.sessionId)
        && isIdentifier(args.requestId)
        && (args.mode === "queue" || args.mode === "steer")
        && validContent(args.content)
        && (args.clientTimeZone === undefined || isBoundedText(args.clientTimeZone, 128));
    case "session/wait":
      return isIdentifier(args.sessionId)
        && (args.timeoutMs === undefined
          || (Number.isSafeInteger(args.timeoutMs) && args.timeoutMs >= 0 && args.timeoutMs <= 600000))
        && (args.afterSeq === undefined
          || (Number.isSafeInteger(args.afterSeq) && args.afterSeq >= 0))
        && (args.maxMessages === undefined
          || (Number.isSafeInteger(args.maxMessages) && args.maxMessages > 0 && args.maxMessages <= 1000));
    case "session/cancel":
    case "session/state":
      return isIdentifier(args.sessionId);
    default:
      return false;
  }
}

function buildScript(payload) {
  let encoded;
  try {
    encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  } catch {
    throw safeError("guest-request-invalid");
  }
  const script = `${quoteShellArgument(GUEST_NODE)} -e ${quoteShellArgument(HELPER_SOURCE)} ${quoteShellArgument(encoded)}`;
  if (Buffer.byteLength(script, "utf8") > MAX_SCRIPT_BYTES) {
    throw safeError("guest-command-invalid");
  }
  return script;
}

function createDeadline(signal, milliseconds) {
  const controller = new AbortController();
  let expired = false;
  let callerAborted = false;
  let rejectDeadline;
  // The host-side race bounds a driver that ignores its abort signal. The
  // rejection value is never exposed: callers map it from the flags below.
  const promise = new Promise((_, reject) => { rejectDeadline = reject; });
  // Keep an already-aborted deadline handled even if the caller throws before
  // the race attaches its own handler.
  promise.catch(() => {});
  const trigger = () => rejectDeadline(safeError("guest-transport-failed"));
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
    trigger();
  }, milliseconds);
  const onAbort = () => {
    callerAborted = true;
    controller.abort(signal.reason);
    trigger();
  };
  if (signal !== undefined) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    promise,
    expired: () => expired,
    callerAborted: () => callerAborted,
    dispose() {
      clearTimeout(timer);
      if (signal !== undefined) signal.removeEventListener("abort", onAbort);
    },
  };
}

function decodeBase64(value) {
  if (typeof value !== "string"
    || value.length % 4 !== 0
    || !BASE64_PATTERN.test(value)) {
    throw safeError("guest-output-invalid");
  }
  return Buffer.from(value, "base64");
}

function parseEnvelope(stdout) {
  const text = stdout.trim();
  if (!text) throw safeError("guest-output-invalid");
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw safeError("guest-output-invalid");
  }
  if (!isPlainObject(envelope) || typeof envelope.ok !== "boolean") {
    throw safeError("guest-output-invalid");
  }
  if (envelope.ok === false) {
    const reported = isPlainObject(envelope.error) ? envelope.error : {};
    const code = typeof reported.code === "string" && HELPER_CODES.has(reported.code)
      ? reported.code
      : "guest-output-invalid";
    const error = safeError(code);
    if (code === "guest-rpc-rejected"
      && typeof reported.remoteCode === "string"
      && REMOTE_CODE_PATTERN.test(reported.remoteCode)) {
      error.remoteCode = reported.remoteCode;
    }
    throw error;
  }
  return envelope;
}

function decodeExecResult(envelope) {
  const stdoutBytes = decodeBase64(envelope.stdout);
  const stderrBytes = decodeBase64(envelope.stderr);
  const { exitCode, signal } = envelope;
  if (exitCode !== null
    && (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255)) {
    throw safeError("guest-output-invalid");
  }
  if (signal !== null
    && (typeof signal !== "string" || !/^[A-Z][A-Z0-9+]{0,15}$/.test(signal))) {
    throw safeError("guest-output-invalid");
  }
  if (typeof envelope.timedOut !== "boolean" || typeof envelope.truncated !== "boolean") {
    throw safeError("guest-output-invalid");
  }
  let truncated = envelope.truncated;
  let stdout = stdoutBytes;
  let stderr = stderrBytes;
  if (stdout.length > MAX_STREAM_BYTES) {
    stdout = stdout.subarray(0, MAX_STREAM_BYTES);
    truncated = true;
  }
  if (stderr.length > MAX_STREAM_BYTES) {
    stderr = stderr.subarray(0, MAX_STREAM_BYTES);
    truncated = true;
  }
  return {
    stdout: stdout.toString("utf8"),
    stderr: stderr.toString("utf8"),
    exitCode,
    signal,
    timedOut: envelope.timedOut,
    truncated,
  };
}

async function runGuest(driver, options, payload, deadlineMs, root) {
  const script = buildScript(payload);
  const deadline = createDeadline(options.signal, deadlineMs);
  try {
    if (deadline.callerAborted()) throw safeError("guest-aborted");
    let stdout;
    try {
      stdout = await Promise.race([
        Promise.resolve().then(() => {
          if (deadline.signal.aborted) throw safeError("guest-transport-failed");
          return driver.exec(
            script,
            { ownershipToken: options.ownershipToken, signal: deadline.signal },
            { root },
          );
        }),
        deadline.promise,
      ]);
    } catch (error) {
      if (deadline.callerAborted()) throw safeError("guest-aborted");
      // Cancelling the host transport cannot guarantee termination of a hostile
      // guest process. The caller receives a bounded timeout result and must
      // separately verify guest state when that distinction matters.
      if (deadline.expired()) return { envelope: null, expired: true };
      const known = knownError(error);
      if (known) throw known;
      throw safeError("guest-transport-failed");
    }
    // A caller abort or deadline that races with a successful driver return
    // must not be reported as success.
    if (deadline.callerAborted()) throw safeError("guest-aborted");
    if (deadline.expired()) return { envelope: null, expired: true };
    if (typeof stdout !== "string") throw safeError("guest-output-invalid");
    if (Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES) {
      throw safeError("guest-output-oversize");
    }
    return { envelope: parseEnvelope(stdout), expired: false };
  } finally {
    deadline.dispose();
  }
}

/**
 * Execute one command inside the verified VM.
 * @param driver - owned VM driver exposing `exec(script, options, { root })`.
 * @param options - `{ ownershipToken, signal? }` for the owned launch.
 * @param request - `{ command, cwd?, root?, timeoutMs? }`.
 * @returns bounded `{ stdout, stderr, exitCode, signal, timedOut, truncated }`.
 */
async function executeGuest(driver, options, request = {}) {
  assertDriver(driver);
  assertOptions(options);
  if (!isPlainObject(request)) throw safeError("guest-options-invalid");
  const {
    command,
    cwd = DEFAULT_CWD,
    root = false,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = request;
  assertCommand(command);
  assertCwd(cwd);
  if (typeof root !== "boolean") throw safeError("guest-options-invalid");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_COMMAND_TIMEOUT_MS) {
    throw safeError("guest-timeout-invalid");
  }
  const payload = { mode: "exec", command, cwd, root, timeoutMs };
  const deadlineMs = Math.min(timeoutMs + HOST_GRACE_MS, MAX_DEADLINE_MS);
  const run = await runGuest(driver, options, payload, deadlineMs, root);
  if (run.expired) {
    return {
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: null,
      timedOut: true,
      truncated: false,
    };
  }
  return decodeExecResult(run.envelope);
}

/**
 * Call one allowlisted stock Harness RPC method through the guest loopback
 * browser-cookie route. Always runs as the guest user; never accepts an
 * endpoint or launch URL from the caller.
 * @param driver - owned VM driver exposing `exec(script, options, { root })`.
 * @param options - `{ ownershipToken, signal? }` for the owned launch.
 * @param method - one of the fixed session methods.
 * @param args - validated request object, wrapped as `{ request: args }`.
 * @returns parsed stock Harness result value. The value is guest-derived and
 *   remains untrusted data; it is not a host-authoritative fact.
 */
async function harnessRpc(driver, options, method, args) {
  assertDriver(driver);
  assertOptions(options);
  if (typeof method !== "string" || !RPC_METHODS.has(method)) {
    throw safeError("guest-method-invalid");
  }
  if (!validateRpcArgs(method, args)) throw safeError("guest-args-invalid");
  let serialized;
  try {
    serialized = JSON.stringify(args);
  } catch {
    throw safeError("guest-args-invalid");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_ARGS_BYTES) {
    throw safeError("guest-args-invalid");
  }
  const payload = { mode: "rpc", method, args, timeoutMs: RPC_TIMEOUT_MS };
  const deadlineMs = Math.min(RPC_TIMEOUT_MS + HOST_GRACE_MS, MAX_DEADLINE_MS);
  const run = await runGuest(driver, options, payload, deadlineMs, false);
  if (run.expired) throw safeError("guest-rpc-timeout");
  if (!Object.hasOwn(run.envelope, "value")) throw safeError("guest-output-invalid");
  return run.envelope.value;
}

module.exports = { executeGuest, harnessRpc };
