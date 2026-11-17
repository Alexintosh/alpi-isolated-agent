// First-party guest orchestration helper. The host passes one base64 JSON
// request to the pinned guest Node binary; guest commands are executed only by
// this helper inside the VM, never by a host shell. Keep this file standalone
// CommonJS: it runs through `node -e` and imports Node built-ins only.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");

// Production paths and the only origin this helper may talk to. Tests inject
// dependency overrides only through `dependencies.testOnly: true`; the host
// adapter never supplies that field.
const PINNED = Object.freeze({
  configRoot: "/home/user/.harness-isolated",
  launchFile: "/home/user/.harness-isolated/launch-url",
  origin: "http://127.0.0.1:3080",
  homeUser: "/home/user",
  homeRoot: "/root",
  defaultCwd: "/home/user/workspace",
});

const MAX_COMMAND_BYTES = 32768;
const MAX_ARGS_BYTES = 65536;
const MAX_OUTPUT_BYTES = 524288;
const MAX_STREAM_BYTES = 65536;
const MAX_CONFIG_BYTES = 65536;
const MAX_LAUNCH_BYTES = 4096;
const MAX_EXCHANGE_BYTES = 8192;
const MAX_REQUEST_ARG_CHARS = 200000;
const MAX_TIMEOUT_MS = 100000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30000;
const DEFAULT_RPC_TIMEOUT_MS = 90000;
// The orchestration broker exposes a bounded wait window. An omitted wait
// timeout uses the broker default rather than the stock 30 second default so
// every accepted wait stays inside the documented 1..20000 ms range.
const MAX_WAIT_TIMEOUT_MS = 20000;
const DEFAULT_WAIT_TIMEOUT_MS = 1000;
const TERMINATION_SIGNALS = Object.freeze(["SIGTERM", "SIGINT", "SIGHUP"]);

const RPC_METHODS = new Set([
  "session/create",
  "session/selectModel",
  "session/prompt",
  "session/wait",
  "session/cancel",
  "session/state",
]);

const RPC_ARG_KEYS = Object.freeze({
  "session/create": ["cwd", "sessionId"],
  "session/selectModel": ["sessionId", "provider", "model", "reasoningEffort"],
  "session/prompt": ["sessionId", "requestId", "mode", "content", "clientTimeZone"],
  "session/wait": ["sessionId", "timeoutMs", "afterSeq", "maxMessages"],
  "session/cancel": ["sessionId"],
  "session/state": ["sessionId"],
});

const SAFE_CODES = new Set([
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
  "guest-rpc-reflection",
  "guest-rpc-failed",
  "guest-output-oversize",
]);

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
const COOKIE_NAME_PATTERN = /^dsh-auth-[A-Za-z0-9_-]+$/;
const COOKIE_VALUE_PATTERN = /^v[12]\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const CONTROL_PATTERN = /[\x00-\x1f\x7f]/;

function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSafeAbsolutePath(value) {
  return typeof value === "string"
    && value.startsWith("/")
    && value.length <= 4096
    && !CONTROL_PATTERN.test(value);
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

function isProxyUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:")
      && url.hostname.length > 0
      && !url.username
      && !url.password
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

// Read at most `maximum` bytes from a regular file before parsing it. Opening
// with O_NONBLOCK and rejecting non-regular files keeps a hostile FIFO,
// directory or oversized file from blocking or being loaded whole.
function readBoundedText(filePath, maximum, unavailableCode, invalidCode) {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  } catch {
    throw fail(unavailableCode);
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maximum) throw fail(invalidCode);
    const buffer = Buffer.alloc(maximum + 1);
    let total = 0;
    while (total <= maximum) {
      const read = fs.readSync(descriptor, buffer, total, buffer.length - total, null);
      if (read === 0) break;
      total += read;
    }
    if (total > maximum) throw fail(invalidCode);
    return buffer.subarray(0, total).toString("utf8");
  } catch (error) {
    if (error && typeof error.code === "string" && SAFE_CODES.has(error.code)) throw error;
    throw fail(invalidCode);
  } finally {
    try { fs.closeSync(descriptor); } catch { /* already closed */ }
  }
}

function emit(envelope) {
  const text = JSON.stringify(envelope);
  if (Buffer.byteLength(text, "utf8") > MAX_OUTPUT_BYTES) {
    process.stdout.write(JSON.stringify({ ok: false, error: { code: "guest-output-oversize" } }));
    return;
  }
  process.stdout.write(text);
}

function writeError(code, fallback) {
  const safe = SAFE_CODES.has(code) ? code : fallback;
  // Remote rejection codes are not forwarded: the syntax pattern only proves
  // shape, not that a hostile server did not embed authentication material.
  emit({ ok: false, error: { code: safe } });
}

function requireAbsolute(value) {
  if (!isSafeAbsolutePath(value)) throw fail("guest-request-invalid");
  return value;
}

function requireLoopbackOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw fail("guest-request-invalid");
  }
  if (url.protocol !== "http:"
    || url.hostname !== "127.0.0.1"
    || !url.port
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== ""
    || url.username !== ""
    || url.password !== "") {
    throw fail("guest-request-invalid");
  }
  return url.origin;
}

// Dependency overrides exist only for synthetic helper tests. Without an
// explicit `testOnly: true` marker the production paths and origin stay pinned.
function resolveDependencies(payload) {
  const pinned = { ...PINNED };
  const dependencies = payload.dependencies;
  if (dependencies === undefined) return pinned;
  if (!isPlainObject(dependencies) || dependencies.testOnly !== true) return pinned;
  return {
    ...pinned,
    configRoot: dependencies.configRoot === undefined
      ? pinned.configRoot
      : requireAbsolute(dependencies.configRoot),
    launchFile: dependencies.launchFile === undefined
      ? pinned.launchFile
      : requireAbsolute(dependencies.launchFile),
    origin: dependencies.origin === undefined
      ? pinned.origin
      : requireLoopbackOrigin(dependencies.origin),
    homeUser: dependencies.homeUser === undefined
      ? pinned.homeUser
      : requireAbsolute(dependencies.homeUser),
    homeRoot: dependencies.homeRoot === undefined
      ? pinned.homeRoot
      : requireAbsolute(dependencies.homeRoot),
  };
}

function resolveTimeout(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw fail("guest-request-invalid");
  }
  return value;
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
          || (Number.isSafeInteger(args.timeoutMs)
            && args.timeoutMs >= 1
            && args.timeoutMs <= MAX_WAIT_TIMEOUT_MS))
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

// Normalize the only optional value whose stock default exceeds the supported
// broker budget. The host adapter performs the same normalization; the helper
// repeats it because it cannot trust its caller.
function normalizeRpcArgs(method, args) {
  if (method === "session/wait" && args.timeoutMs === undefined) {
    return { ...args, timeoutMs: DEFAULT_WAIT_TIMEOUT_MS };
  }
  return args;
}

function buildEnvironment(dependencies, root) {
  const raw = readBoundedText(
    path.join(dependencies.configRoot, "network.json"),
    MAX_CONFIG_BYTES,
    "guest-config-invalid",
    "guest-config-invalid",
  );
  let settings;
  try {
    settings = JSON.parse(raw);
  } catch {
    throw fail("guest-config-invalid");
  }
  if (!isPlainObject(settings)) throw fail("guest-config-invalid");
  if (typeof settings.proxy !== "string" || !isProxyUrl(settings.proxy)) throw fail("guest-config-invalid");
  let credentialHost = "";
  if (settings.credentialHost !== undefined) {
    if (typeof settings.credentialHost !== "string"
      || settings.credentialHost.length > 253
      || (settings.credentialHost.length > 0 && !/^[A-Za-z0-9.:\[\]-]+$/.test(settings.credentialHost))) {
      throw fail("guest-config-invalid");
    }
    credentialHost = settings.credentialHost;
  }
  const configRoot = dependencies.configRoot;
  const home = root ? dependencies.homeRoot : dependencies.homeUser;
  const noProxy = ["127.0.0.1", "localhost", "::1", credentialHost].filter(Boolean).join(",");
  const ca = path.join(configRoot, "ca.crt");
  const env = {
    HOME: home,
    USER: root ? "root" : "user",
    LANG: "C.UTF-8",
    PATH: `${path.join(configRoot, "node/bin")}:${path.join(configRoot, "tools")}:`
      + "/opt/wrap/bin:/opt/mise/data/shims:/opt/mise/shims:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    DSH_HOME: path.join(configRoot, "data"),
    DSH_TELEMETRY_DISABLED: "1",
    HTTP_PROXY: settings.proxy,
    HTTPS_PROXY: settings.proxy,
    http_proxy: settings.proxy,
    https_proxy: settings.proxy,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    NODE_USE_ENV_PROXY: "1",
    NODE_EXTRA_CA_CERTS: ca,
    CURL_CA_BUNDLE: ca,
    GIT_SSL_CAINFO: ca,
    GIT_CONFIG_SYSTEM: path.join(configRoot, "gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
  };
  if (settings.desktop === true) {
    const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
    Object.assign(env, {
      DISPLAY: ":1",
      XDG_RUNTIME_DIR: `/tmp/wrap-desktop-${uid}/runtime`,
      DBUS_SESSION_BUS_ADDRESS: `unix:path=/tmp/wrap-desktop-${uid}/runtime/bus`,
      AGENT_BROWSER_CONFIG: "/home/user/workspace/agent-browser.json",
      AGENT_BROWSER_SKILLS_DIR: "/opt/agent-browser/skill-data",
    });
  }
  return env;
}

function executeCommand(command, cwd, env, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let exitCode = null;
    let exitSignal = null;
    let timedOut = false;
    let settled = false;
    let closed = false;
    let timeoutTimer;
    let exitTimer;
    let closeTimer;
    let killTimer;

    const clearTimers = () => {
      clearTimeout(timeoutTimer);
      clearTimeout(exitTimer);
      clearTimeout(closeTimer);
      clearTimeout(killTimer);
    };
    const killGroup = signal => {
      if (!child || !child.pid) return;
      // A descendant that deliberately creates its own session can escape this
      // process group. Guest root remains untrusted; host transport cancellation
      // cannot guarantee termination of a hostile guest process.
      try { process.kill(-child.pid, signal); } catch { /* already gone */ }
      try { child.kill(signal); } catch { /* already gone */ }
    };
    const destroyPipes = () => {
      try { child?.stdout?.destroy(); } catch { /* already closed */ }
      try { child?.stderr?.destroy(); } catch { /* already closed */ }
    };
    const removeSignalHandlers = () => {
      for (const signal of TERMINATION_SIGNALS) process.removeListener(signal, onSignal);
    };
    // The helper owns the command's process group. A termination signal sent to
    // the helper (for example when the host aborts its driver) must still kill
    // that group, release inherited pipes and clear its own timers. Re-raise the
    // signal with the default disposition afterwards so the helper is reported
    // as signal-terminated rather than as a normal success. This cleanup is
    // cooperative: it runs only when SIGTERM/SIGINT/SIGHUP is actually delivered
    // to this helper. SIGKILL, a replaced helper or a descendant that creates its
    // own session can escape; host cancellation alone cannot guarantee guest
    // termination.
    const onSignal = signal => {
      if (settled) return;
      settled = true;
      clearTimers();
      killGroup("SIGKILL");
      destroyPipes();
      removeSignalHandlers();
      try {
        process.kill(process.pid, signal);
      } catch {
        process.exit(1);
      }
    };
    for (const signal of TERMINATION_SIGNALS) process.on(signal, onSignal);

    try {
      child = spawn("/bin/sh", ["-c", command], {
        cwd,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      removeSignalHandlers();
      reject(fail("guest-command-failed"));
      return;
    }
    if (!child.pid || !child.stdout || !child.stderr) {
      removeSignalHandlers();
      child.on("error", () => {});
      child.stdout?.destroy();
      child.stderr?.destroy();
      reject(fail("guest-command-failed"));
      return;
    }

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimers();
      removeSignalHandlers();
      // A bounded command owns its process group. Kill any remaining members so
      // descendants cannot be orphaned and inherited pipes cannot block close.
      killGroup("SIGKILL");
      const stdout = Buffer.concat(stdoutChunks).subarray(0, MAX_STREAM_BYTES);
      const stderr = Buffer.concat(stderrChunks).subarray(0, MAX_STREAM_BYTES);
      destroyPipes();
      resolve({
        stdout,
        stderr,
        exitCode,
        signal: exitSignal === null && timedOut ? "SIGKILL" : exitSignal,
        timedOut,
        truncated,
      });
    };
    const failCommand = () => {
      if (settled) return;
      settled = true;
      clearTimers();
      removeSignalHandlers();
      killGroup("SIGKILL");
      destroyPipes();
      reject(fail("guest-command-failed"));
    };
    const capture = (chunk, chunks, currentBytes, limit) => {
      if (settled) return currentBytes;
      if (currentBytes >= limit) {
        truncated = true;
        return currentBytes;
      }
      const remaining = limit - currentBytes;
      if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, remaining));
        truncated = true;
        return limit;
      }
      chunks.push(chunk);
      return currentBytes + chunk.length;
    };

    child.stdout.on("data", chunk => {
      stdoutBytes = capture(chunk, stdoutChunks, stdoutBytes, MAX_STREAM_BYTES);
    });
    child.stderr.on("data", chunk => {
      stderrBytes = capture(chunk, stderrChunks, stderrBytes, MAX_STREAM_BYTES);
    });
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});
    child.once("error", failCommand);
    child.once("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      if (closed || settled) return;
      // The shell may exit while a descendant keeps the inherited pipes open.
      // Give buffered output a brief drain, then terminate the group so close
      // cannot wait forever.
      exitTimer = setTimeout(() => {
        if (closed || settled) return;
        killGroup("SIGKILL");
        closeTimer = setTimeout(finish, 1000);
      }, 250);
    });
    child.once("close", (code, signal) => {
      closed = true;
      if (code !== null || exitCode === null) exitCode = code;
      if (signal !== null || exitSignal === null) exitSignal = signal;
      finish();
    });
    timeoutTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      killGroup("SIGKILL");
      killTimer = setTimeout(finish, 1000);
    }, timeoutMs);
  });
}

async function runExec(payload, dependencies) {
  try {
    const command = payload.command;
    if (typeof command !== "string"
      || command.includes("\0")
      || Buffer.byteLength(command, "utf8") > MAX_COMMAND_BYTES) {
      throw fail("guest-command-invalid");
    }
    const cwd = payload.cwd === undefined ? dependencies.defaultCwd : payload.cwd;
    if (!isSafeAbsolutePath(cwd)) throw fail("guest-cwd-invalid");
    if (typeof payload.root !== "boolean") throw fail("guest-request-invalid");
    const timeoutMs = resolveTimeout(payload.timeoutMs, DEFAULT_COMMAND_TIMEOUT_MS);
    const env = buildEnvironment(dependencies, payload.root);
    const result = await executeCommand(command, cwd, env, timeoutMs);
    emit({
      ok: true,
      stdout: result.stdout.toString("base64"),
      stderr: result.stderr.toString("base64"),
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      truncated: result.truncated,
    });
  } catch (error) {
    writeError(
      error && typeof error.code === "string" ? error.code : "guest-command-failed",
      "guest-command-failed",
    );
  }
}

function readLaunchToken(dependencies) {
  let text = readBoundedText(
    dependencies.launchFile,
    MAX_LAUNCH_BYTES,
    "guest-launch-unavailable",
    "guest-launch-invalid",
  ).trim();
  if (!text) throw fail("guest-launch-invalid");
  let url;
  try {
    url = new URL(text);
  } catch {
    throw fail("guest-launch-invalid");
  }
  if (url.protocol !== "http:"
    || url.origin !== dependencies.origin
    || url.pathname !== "/"
    || url.search === ""
    || url.hash !== ""
    || url.username !== ""
    || url.password !== "") {
    throw fail("guest-launch-invalid");
  }
  const tokens = url.searchParams.getAll("token");
  const keys = Array.from(url.searchParams.keys());
  if (tokens.length !== 1
    || keys.length !== 1
    || keys[0] !== "token"
    || !TOKEN_PATTERN.test(tokens[0])) {
    throw fail("guest-launch-invalid");
  }
  return tokens[0];
}

function cookieFrom(headers) {
  const raw = headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  for (const value of values) {
    const first = value.split(";", 1)[0].trim();
    const separator = first.indexOf("=");
    if (separator <= 0) continue;
    const name = first.slice(0, separator).trim();
    const cookie = first.slice(separator + 1).trim();
    if (!COOKIE_NAME_PATTERN.test(name) || !COOKIE_VALUE_PATTERN.test(cookie)) continue;
    return `${name}=${cookie}`;
  }
  return undefined;
}

function httpRequest(options, body, timeoutMs, maxBytes) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let totalTimer;
    const settle = (action, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      action(value);
    };
    let request;
    try {
      request = http.request({ ...options, agent: false }, response => {
        const chunks = [];
        let bytes = 0;
        response.on("data", chunk => {
          if (settled) return;
          bytes += chunk.length;
          if (bytes > maxBytes) {
            settle(reject, fail("guest-rpc-oversize"));
            request.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          settle(resolve, {
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
        response.on("error", () => settle(reject, fail("guest-rpc-http")));
      });
    } catch {
      reject(fail("guest-rpc-http"));
      return;
    }
    // A total deadline, in addition to socket inactivity, bounds a trickling
    // guest server.
    totalTimer = setTimeout(() => {
      settle(reject, fail("guest-rpc-timeout"));
      request.destroy();
    }, timeoutMs);
    request.setTimeout(timeoutMs, () => {
      settle(reject, fail("guest-rpc-timeout"));
      request.destroy();
    });
    request.on("error", () => settle(reject, fail("guest-rpc-http")));
    if (body !== undefined) request.write(body);
    request.end();
  });
}

async function exchange(dependencies, timeoutMs) {
  const token = readLaunchToken(dependencies);
  const origin = new URL(dependencies.origin);
  const response = await httpRequest({
    hostname: origin.hostname,
    port: origin.port || 80,
    path: `/?token=${encodeURIComponent(token)}`,
    method: "GET",
    headers: {
      host: origin.host,
      connection: "close",
      accept: "text/html",
    },
  }, undefined, timeoutMs, MAX_EXCHANGE_BYTES);
  if (response.status === 401 || response.status === 403) throw fail("guest-rpc-auth");
  // The stock exchange answers with a fixed 303 to `./` and a browser cookie.
  // Do not follow Location and do not fetch any guest-supplied URL.
  if (response.status !== 303 || response.headers.location !== "./") throw fail("guest-rpc-http");
  const cookie = cookieFrom(response.headers);
  if (!cookie) throw fail("guest-rpc-auth");
  // Keep both active authentication values inside this operation so the
  // success value can be checked before it is emitted.
  return { token, cookie };
}

async function callRpc(method, args, cookie, dependencies, timeoutMs) {
  const rpcId = randomUUID();
  const body = Buffer.from(JSON.stringify({
    type: "client-request",
    rpcId,
    method,
    payload: { args: { request: args } },
  }), "utf8");
  const origin = new URL(dependencies.origin);
  const response = await httpRequest({
    hostname: origin.hostname,
    port: origin.port || 80,
    path: `/api/${method}`,
    method: "POST",
    headers: {
      host: origin.host,
      cookie,
      "content-type": "application/json",
      "content-length": String(body.length),
      accept: "application/json",
      connection: "close",
    },
  }, body, timeoutMs, MAX_OUTPUT_BYTES);
  if (response.status === 401 || response.status === 403) throw fail("guest-rpc-auth");
  if (response.status === 413) throw fail("guest-rpc-oversize");
  if (response.status !== 200) throw fail("guest-rpc-http");
  const mediaType = String(response.headers["content-type"] || "")
    .split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") throw fail("guest-rpc-invalid");
  let parsed;
  try {
    parsed = JSON.parse(response.body.toString("utf8"));
  } catch {
    throw fail("guest-rpc-invalid");
  }
  if (!isPlainObject(parsed)
    || parsed.type !== "server-response"
    || parsed.rpcId !== rpcId
    || !isPlainObject(parsed.result)
    || typeof parsed.result.ok !== "boolean") {
    throw fail("guest-rpc-invalid");
  }
  if (parsed.result.ok === true) return parsed.result.value;
  // Do not forward a remote code. Its shape is bounded, but it may still be a
  // hostile server's literal copy of an active token or cookie value.
  throw fail("guest-rpc-rejected");
}

function cookieValue(cookie) {
  const separator = cookie.indexOf("=");
  return separator >= 0 ? cookie.slice(separator + 1) : cookie;
}

// Scan the parsed success value iteratively. Parsed JSON has no cycles, and an
// explicit stack avoids a recursion limit on deeply nested but bounded bodies.
// Only the active launch token and cookie are checked; unrelated guest strings
// remain untrusted data, not a reason to reject ordinary output.
function containsActiveAuth(value, secrets) {
  const stack = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current === "string") {
      if (secrets.some(secret => current.includes(secret))) return true;
      continue;
    }
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    if (isPlainObject(current)) {
      for (const [key, item] of Object.entries(current)) {
        if (secrets.some(secret => key.includes(secret))) return true;
        stack.push(item);
      }
    }
  }
  return false;
}

async function runRpc(payload, dependencies) {
  try {
    const method = payload.method;
    if (typeof method !== "string" || !RPC_METHODS.has(method)) throw fail("guest-method-invalid");
    const args = payload.args;
    if (!validateRpcArgs(method, args)) throw fail("guest-args-invalid");
    const rpcArgs = normalizeRpcArgs(method, args);
    let serialized;
    try {
      serialized = JSON.stringify(rpcArgs);
    } catch {
      throw fail("guest-args-invalid");
    }
    if (Buffer.byteLength(serialized, "utf8") > MAX_ARGS_BYTES) throw fail("guest-args-invalid");
    const timeoutMs = resolveTimeout(payload.timeoutMs, DEFAULT_RPC_TIMEOUT_MS);
    const started = Date.now();
    const remaining = () => {
      const value = timeoutMs - (Date.now() - started);
      if (value <= 0) throw fail("guest-rpc-timeout");
      return value;
    };
    const auth = await exchange(dependencies, remaining());
    const value = await callRpc(method, rpcArgs, auth.cookie, dependencies, remaining());
    if (containsActiveAuth(value, [auth.token, cookieValue(auth.cookie), auth.cookie])) {
      throw fail("guest-rpc-reflection");
    }
    emit({ ok: true, value });
  } catch (error) {
    writeError(
      error && typeof error.code === "string" ? error.code : "guest-rpc-failed",
      "guest-rpc-failed",
    );
  }
}

async function main() {
  const raw = process.argv[1];
  if (typeof raw !== "string"
    || raw.length > MAX_REQUEST_ARG_CHARS
    || !/^[A-Za-z0-9+/=]+$/.test(raw)) {
    throw fail("guest-request-invalid");
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    throw fail("guest-request-invalid");
  }
  if (!isPlainObject(payload)) throw fail("guest-request-invalid");
  const dependencies = resolveDependencies(payload);
  if (payload.mode === "exec") return runExec(payload, dependencies);
  if (payload.mode === "rpc") return runRpc(payload, dependencies);
  throw fail("guest-request-invalid");
}

main().catch(error => {
  writeError(
    error && typeof error.code === "string" ? error.code : "guest-request-invalid",
    "guest-request-invalid",
  );
});
