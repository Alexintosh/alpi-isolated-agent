const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { randomBytes, randomUUID } = require("node:crypto");
const { PassThrough, Writable } = require("node:stream");
const vm = require("node:vm");
const { startServer } = require("../src/orchestration/transport.cjs");
const { TOOLS, validateCall } = require("../src/orchestration/tools.cjs");
const { createMcpServer } = require("../src/orchestration/mcp.cjs");

const TMP_ROOT = fs.realpathSync(os.tmpdir());
const MCP_SOURCE = path.join(__dirname, "../src/orchestration/mcp.cjs");
const MAX_LINE_BYTES = 1024 * 1024;
const WRITE_STALL_MS = 30000;
const CALL_TIMEOUT_MS = 180000;
const INITIALIZE_PARAMS = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "synthetic-test", version: "1.0.0" },
};

function privateDir(t) {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, "am-"));
  fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function socketIn(dir) {
  return path.join(dir, `t-${randomBytes(4).toString("hex")}.sock`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Condition was not met in time.");
    await delay(10);
  }
}

function frame(value) {
  return `${JSON.stringify(value)}\n`;
}

function request(id, method, params) {
  return { jsonrpc: "2.0", id, method, params };
}

function notification(method, params) {
  return { jsonrpc: "2.0", method, params };
}

function makeReader(stream) {
  const lines = [];
  const waiters = [];
  const all = [];
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      all.push(line);
      if (waiters.length > 0) {
        const waiter = waiters.shift();
        clearTimeout(waiter.timer);
        waiter.resolve(line);
      } else {
        lines.push(line);
      }
    }
  });
  return {
    all,
    next(timeoutMs = 3000) {
      if (lines.length > 0) return Promise.resolve(lines.shift());
      return new Promise((resolve, reject) => {
        const waiter = { resolve, timer: null };
        waiter.timer = setTimeout(() => {
          const at = waiters.indexOf(waiter);
          if (at !== -1) waiters.splice(at, 1);
          reject(new Error("Timed out waiting for a protocol line."));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
}

function spawnFacade(t, socketPath) {
  const child = spawn(process.execPath, [MCP_SOURCE, "--socket", socketPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.on("error", () => {});
  const out = makeReader(child.stdout);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  t.after(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
  });
  return {
    child,
    out,
    stderr: () => stderr,
    send(value) {
      child.stdin.write(frame(value));
    },
    sendRaw(bytes) {
      child.stdin.write(bytes);
    },
  };
}

function waitExit(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => reject(new Error("The facade did not exit.")), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function initialize(f, protocolVersion = "2025-06-18") {
  f.send(
    request("init", "initialize", {
      ...INITIALIZE_PARAMS,
      protocolVersion,
    }),
  );
  const response = JSON.parse(await f.out.next());
  f.send(notification("notifications/initialized"));
  return response;
}

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MCP_SOURCE, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// Loads the facade with an injected timer so stall and call deadlines can be
// exercised without production test knobs.
function loadFacade({ setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  const source = fs.readFileSync(MCP_SOURCE, "utf8");
  const facadeModule = { exports: {} };
  const sandbox = {
    module: facadeModule,
    exports: facadeModule.exports,
    require: (specifier) => {
      if (specifier === "./tools.cjs") return require("../src/orchestration/tools.cjs");
      if (specifier === "./transport.cjs") return require("../src/orchestration/transport.cjs");
      return require(specifier);
    },
    setTimeout: setTimeoutFn,
    clearTimeout: clearTimeoutFn,
    setImmediate,
    Buffer,
    process,
    TextDecoder,
    AbortController,
    console,
  };
  vm.runInNewContext(source, sandbox, { filename: MCP_SOURCE });
  return facadeModule.exports;
}

function blockedOutput() {
  return new Writable({
    write() {
      // Never completes: the reader is not draining stdout.
    },
  });
}

// Runs the facade in an isolated child so a late stream error that escapes the
// facade's ownership is observed as the child's own failure instead of taking
// down the test process.
function runOwnedWriteChild(t, scenario) {
  const dir = privateDir(t);
  const scriptPath = path.join(dir, "owned-write-child.cjs");
  fs.writeFileSync(scriptPath, OWNED_WRITE_CHILD_SOURCE, { mode: 0o600 });
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, scenario], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already exited.
      }
      resolve({ code: null, signal: "timeout", stdout, stderr });
    }, 8000);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

const OWNED_WRITE_CHILD_SOURCE = `
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { PassThrough, Writable } = require("node:stream");
const MODULE_PATH = ${JSON.stringify(MCP_SOURCE)};
const INITIALIZE_PARAMS = ${JSON.stringify(INITIALIZE_PARAMS)};
const WRITE_STALL_MS = ${WRITE_STALL_MS};
const scenario = process.argv[2];

const source = fs.readFileSync(MODULE_PATH, "utf8");
const facadeModule = { exports: {} };
const timers =
  scenario === "stall"
    ? {
        setTimeout: (fn, ms) => setTimeout(fn, ms === WRITE_STALL_MS ? 150 : ms),
        clearTimeout,
      }
    : { setTimeout, clearTimeout };
vm.runInNewContext(
  source,
  {
    module: facadeModule,
    exports: facadeModule.exports,
    require: (specifier) => {
      if (specifier === "./tools.cjs" || specifier === "./transport.cjs") {
        return require(path.join(path.dirname(MODULE_PATH), specifier));
      }
      return require(specifier);
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setImmediate,
    Buffer,
    process,
    TextDecoder,
    AbortController,
    console,
  },
  { filename: MODULE_PATH },
);
const { createMcpServer } = facadeModule.exports;

const frame = (value) => JSON.stringify(value) + "\\n";
const immediate = () => new Promise((resolve) => setImmediate(resolve));
const input = new PassThrough();
const chunks = [];
const pending = [];
const output = new Writable({
  write(chunk, _encoding, callback) {
    chunks.push(chunk.toString("utf8"));
    pending.push(callback);
  },
});
const terminations = [];
const payload = "x".repeat(4 * 1024 * 1024 - 4096);
const facade = createMcpServer({
  input,
  output,
  call: () => payload,
  onTerminate: (code) => terminations.push(code),
});
input.write(frame({ jsonrpc: "2.0", id: "init", method: "initialize", params: INITIALIZE_PARAMS }));
input.write(frame({ jsonrpc: "2.0", method: "notifications/initialized" }));
if (scenario === "overflow") {
  for (let id = 1; id <= 6; id += 1) {
    input.write(
      frame({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "alpi_status", arguments: {} },
      }),
    );
  }
}

(async () => {
  const code = await facade.done;
  await immediate();
  await immediate();
  const before = {
    code,
    terminations: terminations.slice(),
    listeners: output.listenerCount("error"),
    pending: pending.length,
    ids: chunks.map((chunk) => JSON.parse(chunk).id),
  };
  // Fail the facade-owned write after the cleanup the previous implementation
  // would already have run. Its deferred stream error must stay contained.
  pending[0](new Error("synthetic-owned-write-failed-after-" + scenario));
  await immediate();
  await immediate();
  const after = {
    terminations: terminations.slice(),
    listeners: output.listenerCount("error"),
    pending: pending.length,
    chunks: chunks.length,
    leaked: chunks.some((chunk) => chunk.includes("synthetic-owned-write-failed")),
  };
  process.stdout.write(JSON.stringify({ before, after }) + "\\n");
  process.exit(0);
})().catch((error) => {
  process.stderr.write(String(error && error.stack ? error.stack : error));
  process.exit(2);
});
`;

test("CLI requires exactly one explicit absolute socket", async () => {
  const cases = [
    [],
    ["--socket"],
    ["--socket", "relative.sock"],
    ["--socket", "/tmp/one.sock", "--extra"],
    ["--socket", "/tmp/one.sock", "--socket", "/tmp/two.sock"],
  ];
  for (const args of cases) {
    const result = await runCli(args);
    assert.equal(result.code, 2, `expected exit 2 for ${JSON.stringify(args)}`);
    assert.match(result.stderr, /usage:/);
    assert.equal(result.stdout, "");
  }
});

test("initialize negotiation gates tools while ping stays available", async (t) => {
  const dir = privateDir(t);
  const socketPath = socketIn(dir);
  let calls = 0;
  const server = await startServer({
    socketPath,
    dispatch: () => {
      calls += 1;
      return {};
    },
  });
  t.after(() => server.close());
  const f = spawnFacade(t, socketPath);

  // Notifications never receive replies, and a premature initialized
  // notification does not advance the lifecycle.
  f.send(notification("notifications/initialized"));
  f.send(request(1, "ping"));
  assert.deepEqual(JSON.parse(await f.out.next()), { jsonrpc: "2.0", id: 1, result: {} });

  f.send(request(0, "initialize"));
  let response = JSON.parse(await f.out.next());
  assert.equal(response.id, 0);
  assert.equal(response.error.code, -32602);

  f.send(request(2, "tools/list", {}));
  response = JSON.parse(await f.out.next());
  assert.equal(response.id, 2);
  assert.equal(response.error.code, -32600);

  // An older requested version is answered with this server's supported
  // version.
  f.send(
    request(3, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "synthetic-test", version: "1.0.0" },
    }),
  );
  response = JSON.parse(await f.out.next());
  assert.equal(response.id, 3);
  assert.equal(response.result.protocolVersion, "2025-06-18");
  assert.deepEqual(response.result.serverInfo, { name: "alpi", version: "0.1.0" });
  assert.deepEqual(response.result.capabilities, { tools: { listChanged: false } });
  assert.match(response.result.instructions, /untrusted/i);

  f.send(request(4, "tools/list"));
  response = JSON.parse(await f.out.next());
  assert.equal(response.id, 4);
  assert.equal(response.error.code, -32600);

  f.send(notification("notifications/initialized"));
  f.send(request(5, "tools/list", {}));
  response = JSON.parse(await f.out.next());
  assert.equal(response.id, 5);
  assert.deepEqual(response.result.tools, TOOLS);
  assert.equal(Object.hasOwn(response.result, "nextCursor"), false);

  f.send(request(6, "tools/list", { cursor: "next" }));
  response = JSON.parse(await f.out.next());
  assert.equal(response.id, 6);
  assert.equal(response.error.code, -32602);

  f.send(request(7, "initialize", { protocolVersion: "2025-06-18" }));
  response = JSON.parse(await f.out.next());
  assert.equal(response.id, 7);
  assert.equal(response.error.code, -32600);

  f.send(request(8, "unsupported/method"));
  response = JSON.parse(await f.out.next());
  assert.equal(response.id, 8);
  assert.equal(response.error.code, -32601);

  assert.equal(calls, 0);
  assert.equal(f.stderr(), "");
});

test("tools/call validates and forwards only the tool name and arguments", async (t) => {
  const dir = privateDir(t);
  const socketPath = socketIn(dir);
  const seen = [];
  const server = await startServer({
    socketPath,
    dispatch: (method, params) => {
      seen.push({ method, params });
      return { method, params };
    },
  });
  t.after(() => server.close());
  const f = spawnFacade(t, socketPath);
  await initialize(f);

  f.send(request(9, "tools/call"));
  let response = JSON.parse(await f.out.next());
  assert.equal(response.id, 9);
  assert.equal(response.error.code, -32602);

  f.send(request(10, "tools/call", { name: "alpi_status", arguments: {} }));
  response = JSON.parse(await f.out.next());
  assert.equal(response.id, 10);
  assert.equal(response.result.isError, false);
  assert.deepEqual(JSON.parse(response.result.content[0].text), {
    method: "alpi_status",
    params: {},
  });

  const before = seen.length;
  f.send(request(11, "tools/call", { name: "alpi_status", arguments: { environmentId: "env-1" } }));
  response = JSON.parse(await f.out.next());
  assert.equal(response.id, 11);
  assert.equal(response.error.code, -32602);

  f.send(request(12, "tools/call", { name: "alpi_unknown", arguments: {} }));
  response = JSON.parse(await f.out.next());
  assert.equal(response.id, 12);
  assert.equal(response.error.code, -32602);

  f.send(request(13, "tools/call", { name: "alpi_status" }));
  response = JSON.parse(await f.out.next());
  assert.equal(response.id, 13);
  assert.equal(response.result.isError, false);
  assert.deepEqual(JSON.parse(response.result.content[0].text), {
    method: "alpi_status",
    params: {},
  });

  f.send(request(14, "tools/call", { name: "alpi_status", arguments: [], extra: true }));
  response = JSON.parse(await f.out.next());
  assert.equal(response.id, 14);
  assert.equal(response.error.code, -32602);

  assert.equal(seen.length, before + 1, "invalid calls must not reach the broker");

  f.send(
    request(15, "tools/call", {
      name: "alpi_exec",
      arguments: { environmentId: "env-1", command: "echo synthetic" },
    }),
  );
  response = JSON.parse(await f.out.next());
  assert.equal(response.id, 15);
  assert.equal(response.result.isError, false);
  assert.deepEqual(seen.at(-1), {
    method: "alpi_exec",
    params: { environmentId: "env-1", command: "echo synthetic" },
  });
});

test("broker failures become sanitized tool errors, not protocol errors", async (t) => {
  const dir = privateDir(t);
  const socketPath = socketIn(dir);
  const server = await startServer({
    socketPath,
    dispatch: () => {
      const error = new Error("SECRET-CANARY");
      error.code = "boom";
      throw error;
    },
  });
  t.after(() => server.close());
  const f = spawnFacade(t, socketPath);
  await initialize(f);

  f.send(request(20, "tools/call", { name: "alpi_status", arguments: {} }));
  const response = JSON.parse(await f.out.next());
  assert.equal(response.id, 20);
  assert.equal(response.error, undefined);
  assert.equal(response.result.isError, true);
  const body = JSON.parse(response.result.content[0].text);
  assert.deepEqual(body, { code: "request_failed", message: "The Alpi request failed." });
  assert.equal(JSON.stringify(response).includes("SECRET-CANARY"), false);
  assert.equal(f.stderr(), "");

  const missingDir = privateDir(t);
  const missingSocket = socketIn(missingDir);
  const missing = spawnFacade(t, missingSocket);
  await initialize(missing);
  missing.send(request(21, "tools/call", { name: "alpi_status", arguments: {} }));
  const unavailable = JSON.parse(await missing.out.next());
  assert.equal(unavailable.id, 21);
  assert.equal(unavailable.result.isError, true);
  assert.deepEqual(JSON.parse(unavailable.result.content[0].text), {
    code: "broker_unavailable",
    message: "The Alpi broker is unavailable.",
  });
});

test("cancellation aborts only the referenced call and suppresses its response", async (t) => {
  const dir = privateDir(t);
  const socketPath = socketIn(dir);
  const firstTask = randomUUID();
  const secondTask = randomUUID();
  const aborted = [];
  let starts = 0;
  let allStarted;
  const started = new Promise((resolve) => {
    allStarted = resolve;
  });
  const server = await startServer({
    socketPath,
    dispatch: (method, params, { signal }) => {
      starts += 1;
      if (starts === 2) allStarted();
      return new Promise((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted.push(params.taskId);
            reject(Object.assign(new Error("aborted"), { name: "AbortError", code: "ABORT_ERR" }));
          },
          { once: true },
        );
      });
    },
  });
  t.after(() => server.close());
  const f = spawnFacade(t, socketPath);
  await initialize(f);

  f.send(request("a", "tools/call", { name: "alpi_wait", arguments: { taskId: firstTask } }));
  f.send(request("b", "tools/call", { name: "alpi_wait", arguments: { taskId: secondTask } }));
  await started;

  f.send(notification("notifications/cancelled", { requestId: "a" }));
  await until(() => aborted.includes(firstTask));
  await delay(100);
  assert.deepEqual(aborted, [firstTask], "the second call must remain active");

  // The cancelled request receives no response: the next frame is the ping.
  f.send(request(30, "ping"));
  let response = JSON.parse(await f.out.next());
  assert.equal(response.id, 30);

  f.send(notification("notifications/cancelled", { requestId: "unknown" }));
  f.send(notification("notifications/cancelled", { requestId: null }));
  f.send(notification("notifications/cancelled", {}));
  f.send(request(31, "ping"));
  response = JSON.parse(await f.out.next());
  assert.equal(response.id, 31);

  f.send(notification("notifications/cancelled", { requestId: "b" }));
  await until(() => aborted.includes(secondTask));
  f.send(request(32, "ping"));
  response = JSON.parse(await f.out.next());
  assert.equal(response.id, 32);
});

test("EOF aborts pending calls, sends no reply and exits cleanly", async (t) => {
  const dir = privateDir(t);
  const socketPath = socketIn(dir);
  let abortedResolve;
  const aborted = new Promise((resolve) => {
    abortedResolve = resolve;
  });
  let startedResolve;
  const started = new Promise((resolve) => {
    startedResolve = resolve;
  });
  const server = await startServer({
    socketPath,
    dispatch: (method, params, { signal }) => {
      startedResolve();
      return new Promise((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            abortedResolve();
            reject(Object.assign(new Error("aborted"), { name: "AbortError", code: "ABORT_ERR" }));
          },
          { once: true },
        );
      });
    },
  });
  t.after(() => server.close());
  const f = spawnFacade(t, socketPath);
  await initialize(f);

  f.send(request(40, "tools/call", { name: "alpi_wait", arguments: { taskId: randomUUID() } }));
  await started;
  f.child.stdin.end();
  await aborted;
  const exit = await waitExit(f.child);
  assert.equal(exit.code, 0);
  assert.equal(
    f.out.all.some((line) => JSON.parse(line).id === 40),
    false,
    "a disconnected pending call must not receive a replayed reply",
  );
});

test("SIGTERM aborts pending calls, sends no reply and exits cleanly", async (t) => {
  const dir = privateDir(t);
  const socketPath = socketIn(dir);
  let abortedResolve;
  const aborted = new Promise((resolve) => {
    abortedResolve = resolve;
  });
  let startedResolve;
  const started = new Promise((resolve) => {
    startedResolve = resolve;
  });
  const server = await startServer({
    socketPath,
    dispatch: (method, params, { signal }) => {
      startedResolve();
      return new Promise((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            abortedResolve();
            reject(Object.assign(new Error("aborted"), { name: "AbortError", code: "ABORT_ERR" }));
          },
          { once: true },
        );
      });
    },
  });
  t.after(() => server.close());
  const f = spawnFacade(t, socketPath);
  await initialize(f);

  f.send(request(41, "tools/call", { name: "alpi_wait", arguments: { taskId: randomUUID() } }));
  await started;
  f.child.kill("SIGTERM");
  await aborted;
  const exit = await waitExit(f.child);
  assert.equal(exit.code, 0);
  assert.equal(f.out.all.some((line) => JSON.parse(line).id === 41), false);
});

test("duplicate active IDs and the eight-call bound are rejected before dispatch", async (t) => {
  const dir = privateDir(t);
  const socketPath = socketIn(dir);
  const aborted = [];
  let starts = 0;
  let allStarted;
  const started = new Promise((resolve) => {
    allStarted = resolve;
  });
  let allAborted;
  const aborts = new Promise((resolve) => {
    allAborted = resolve;
  });
  const server = await startServer({
    socketPath,
    dispatch: (method, params, { signal }) => {
      if (method === "alpi_status") return { ok: true };
      starts += 1;
      if (starts === 8) allStarted();
      return new Promise((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted.push(params.taskId);
            if (aborted.length === 8) allAborted();
            reject(Object.assign(new Error("aborted"), { name: "AbortError", code: "ABORT_ERR" }));
          },
          { once: true },
        );
      });
    },
  });
  t.after(() => server.close());
  const f = spawnFacade(t, socketPath);
  await initialize(f);

  const taskId = randomUUID();
  for (let id = 1; id <= 8; id += 1) {
    f.send(request(id, "tools/call", { name: "alpi_wait", arguments: { taskId } }));
  }
  await started;

  f.send(request(9, "tools/call", { name: "alpi_wait", arguments: { taskId } }));
  let response = JSON.parse(await f.out.next());
  assert.equal(response.id, 9);
  assert.equal(response.error.code, -32603);

  f.send(request(1, "tools/call", { name: "alpi_wait", arguments: { taskId } }));
  response = JSON.parse(await f.out.next());
  assert.equal(response.id, 1);
  assert.equal(response.error.code, -32600);
  assert.equal(starts, 8);

  for (let id = 1; id <= 8; id += 1) {
    f.send(notification("notifications/cancelled", { requestId: id }));
  }
  await aborts;

  f.send(request(20, "ping"));
  response = JSON.parse(await f.out.next());
  assert.equal(response.id, 20);

  f.send(request(21, "tools/call", { name: "alpi_status", arguments: {} }));
  response = JSON.parse(await f.out.next());
  assert.equal(response.id, 21);
  assert.equal(response.result.isError, false);
});

test("malformed UTF-8 and invalid envelopes are bounded and non-fatal", async (t) => {
  const dir = privateDir(t);
  const socketPath = socketIn(dir);
  const server = await startServer({ socketPath, dispatch: () => ({ ok: true }) });
  t.after(() => server.close());
  const f = spawnFacade(t, socketPath);
  await initialize(f);

  f.sendRaw(Buffer.from([0x7b, 0xff, 0x0a]));
  let response = JSON.parse(await f.out.next());
  assert.equal(response.id, null);
  assert.equal(response.error.code, -32700);

  f.sendRaw(Buffer.from("not json\n"));
  response = JSON.parse(await f.out.next());
  assert.equal(response.id, null);
  assert.equal(response.error.code, -32700);

  f.sendRaw(Buffer.from("[1,2]\n"));
  response = JSON.parse(await f.out.next());
  assert.equal(response.id, null);
  assert.equal(response.error.code, -32600);

  f.sendRaw(Buffer.from('{"jsonrpc":"2.0","id":null,"method":"ping"}\n'));
  response = JSON.parse(await f.out.next());
  assert.equal(response.id, null);
  assert.equal(response.error.code, -32600);

  f.sendRaw(Buffer.from('{"jsonrpc":"2.0","id":1.5,"method":"ping"}\n'));
  response = JSON.parse(await f.out.next());
  assert.equal(response.id, null);
  assert.equal(response.error.code, -32600);

  f.sendRaw(Buffer.from('{"jsonrpc":"2.0","id":3,"method":"ping","extra":true}\n'));
  response = JSON.parse(await f.out.next());
  assert.equal(response.id, 3);
  assert.equal(response.error.code, -32600);

  f.sendRaw(Buffer.from('{"jsonrpc":"2.0","id":9,"result":{}}\n'));
  response = JSON.parse(await f.out.next());
  assert.equal(response.id, 9);
  assert.equal(response.error.code, -32600);

  f.sendRaw(Buffer.from('{"jsonrpc":"1.0","id":10,"method":"ping"}\n'));
  response = JSON.parse(await f.out.next());
  assert.equal(response.id, 10);
  assert.equal(response.error.code, -32600);

  // Structurally valid notifications are ignored, not answered.
  f.send(notification("ping"));
  f.send(notification("notifications/unknown"));
  f.send(request(50, "ping"));
  response = JSON.parse(await f.out.next());
  assert.equal(response.id, 50);
  assert.deepEqual(response.result, {});
});

test("oversized input is rejected fatally and truncated input is rejected at EOF", async (t) => {
  const dir = privateDir(t);
  const socketPath = socketIn(dir);
  let calls = 0;
  const server = await startServer({
    socketPath,
    dispatch: () => {
      calls += 1;
      return {};
    },
  });
  t.after(() => server.close());

  const f = spawnFacade(t, socketPath);
  await initialize(f);
  f.sendRaw(Buffer.alloc(MAX_LINE_BYTES + 2, 0x61));
  let response = JSON.parse(await f.out.next());
  assert.equal(response.id, null);
  assert.equal(response.error.code, -32700);
  const exit = await waitExit(f.child);
  assert.equal(exit.code, 1);
  assert.equal(calls, 0);

  const truncated = spawnFacade(t, socketPath);
  await initialize(truncated);
  truncated.sendRaw(Buffer.from('{"jsonrpc":"2.0","id":5,"method":"ping"'));
  truncated.child.stdin.end();
  response = JSON.parse(await truncated.out.next());
  assert.equal(response.id, null);
  assert.equal(response.error.code, -32700);
  const truncatedExit = await waitExit(truncated.child);
  assert.equal(truncatedExit.code, 0);
});

test("tool results are bounded and unserializable values fail safely", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const out = makeReader(output);
  let mode = "oversize";
  const call = () => {
    if (mode === "oversize") return "x".repeat(4 * 1024 * 1024 + 1024);
    if (mode === "undefined") return undefined;
    if (mode === "newline") return "line one\nline two";
    return 1n;
  };
  const facade = createMcpServer({ input, output, call });
  input.write(frame(request("init", "initialize", INITIALIZE_PARAMS)));
  assert.equal(JSON.parse(await out.next()).id, "init");
  input.write(frame(notification("notifications/initialized")));

  input.write(frame(request(60, "tools/call", { name: "alpi_status", arguments: {} })));
  let response = JSON.parse(await out.next());
  assert.equal(response.id, 60);
  assert.equal(response.result.isError, true);
  assert.deepEqual(JSON.parse(response.result.content[0].text), {
    code: "result_too_large",
    message: "The tool result is too large.",
  });

  mode = "undefined";
  input.write(frame(request(61, "tools/call", { name: "alpi_tasks", arguments: {} })));
  response = JSON.parse(await out.next());
  assert.equal(response.id, 61);
  assert.deepEqual(JSON.parse(response.result.content[0].text), {
    code: "invalid_result",
    message: "The tool result could not be serialized.",
  });

  mode = "bigint";
  input.write(
    frame(request(62, "tools/call", { name: "alpi_cancel", arguments: { taskId: randomUUID() } })),
  );
  response = JSON.parse(await out.next());
  assert.equal(response.id, 62);
  assert.deepEqual(JSON.parse(response.result.content[0].text), {
    code: "invalid_result",
    message: "The tool result could not be serialized.",
  });

  mode = "newline";
  input.write(frame(request(63, "tools/call", { name: "alpi_status", arguments: {} })));
  response = JSON.parse(await out.next());
  assert.equal(response.id, 63);
  assert.equal(response.result.isError, false);
  assert.equal(JSON.parse(response.result.content[0].text), "line one\nline two");

  input.end();
  assert.equal(await facade.done, 0);
});

test("a stalled stdout reader is terminated at the write deadline", async () => {
  const facadeModule = loadFacade({
    setTimeoutFn: (fn, ms) => setTimeout(fn, ms === WRITE_STALL_MS ? 150 : ms),
  });
  const input = new PassThrough();
  const output = blockedOutput();
  let aborted = false;
  const call = (method, params, { signal }) =>
    new Promise((resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          aborted = true;
          reject(Object.assign(new Error("aborted"), { name: "AbortError", code: "ABORT_ERR" }));
        },
        { once: true },
      );
    });
  const facade = facadeModule.createMcpServer({ input, output, call });
  input.write(frame(request("init", "initialize", INITIALIZE_PARAMS)));
  input.write(frame(notification("notifications/initialized")));
  input.write(
    frame(request(70, "tools/call", { name: "alpi_wait", arguments: { taskId: randomUUID() } })),
  );

  const code = await Promise.race([
    facade.done,
    delay(2000).then(() => {
      throw new Error("The stalled facade did not terminate.");
    }),
  ]);
  assert.equal(code, 1);
  assert.equal(aborted, true);
  input.end();
});

test("the output queue is bounded at 16 MiB and drops blocked output", async () => {
  const facadeModule = loadFacade({
    setTimeoutFn: (fn, ms) => setTimeout(fn, ms === WRITE_STALL_MS ? 5000 : ms),
  });
  const input = new PassThrough();
  const output = blockedOutput();
  const payload = "x".repeat(4 * 1024 * 1024 - 4096);
  const call = () => payload;
  const facade = facadeModule.createMcpServer({ input, output, call });
  input.write(frame(request("init", "initialize", INITIALIZE_PARAMS)));
  input.write(frame(notification("notifications/initialized")));
  for (let id = 1; id <= 6; id += 1) {
    input.write(frame(request(id, "tools/call", { name: "alpi_status", arguments: {} })));
  }

  const code = await Promise.race([
    facade.done,
    delay(3000).then(() => {
      throw new Error("The bounded queue did not terminate.");
    }),
  ]);
  assert.equal(code, 1);
  input.end();
});

test("an unresponsive call times out at its bound and aborts the broker signal", async () => {
  const facadeModule = loadFacade({
    setTimeoutFn: (fn, ms) => setTimeout(fn, ms === CALL_TIMEOUT_MS ? 100 : ms),
  });
  const input = new PassThrough();
  const output = new PassThrough();
  const out = makeReader(output);
  let aborted = false;
  const call = (method, params, { signal }) =>
    new Promise((resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          aborted = true;
          reject(Object.assign(new Error("aborted"), { name: "AbortError", code: "ABORT_ERR" }));
        },
        { once: true },
      );
    });
  const facade = facadeModule.createMcpServer({ input, output, call });
  input.write(frame(request("init", "initialize", INITIALIZE_PARAMS)));
  assert.equal(JSON.parse(await out.next()).id, "init");
  input.write(frame(notification("notifications/initialized")));
  input.write(
    frame(request(80, "tools/call", { name: "alpi_wait", arguments: { taskId: randomUUID() } })),
  );

  const response = JSON.parse(await out.next());
  assert.equal(response.id, 80);
  assert.equal(response.result.isError, true);
  assert.deepEqual(JSON.parse(response.result.content[0].text), {
    code: "timeout",
    message: "The Alpi request timed out.",
  });
  assert.equal(aborted, true);

  input.end();
  assert.equal(await facade.done, 0);
});

test("valid omitted arguments, request metadata and list metadata are accepted", async (t) => {
  const dir = privateDir(t);
  const socketPath = socketIn(dir);
  const seen = [];
  const server = await startServer({
    socketPath,
    dispatch: (method, params) => {
      seen.push({ method, params });
      return { method, params };
    },
  });
  t.after(() => server.close());
  const f = spawnFacade(t, socketPath);
  await initialize(f);

  f.send(request(100, "tools/list", { _meta: {} }));
  let response = JSON.parse(await f.out.next());
  assert.equal(response.id, 100);
  assert.deepEqual(response.result.tools, TOOLS);

  // CallToolRequest.arguments is optional for zero-argument tools.
  f.send(request(101, "tools/call", { name: "alpi_status" }));
  response = JSON.parse(await f.out.next());
  assert.equal(response.id, 101);
  assert.equal(response.result.isError, false);
  assert.deepEqual(JSON.parse(response.result.content[0].text), {
    method: "alpi_status",
    params: {},
  });

  // Request metadata is accepted and never forwarded as broker arguments.
  f.send(
    request(102, "tools/call", {
      name: "alpi_status",
      arguments: {},
      _meta: { progressToken: "p" },
    }),
  );
  response = JSON.parse(await f.out.next());
  assert.equal(response.id, 102);
  assert.equal(response.result.isError, false);
  assert.deepEqual(JSON.parse(response.result.content[0].text), {
    method: "alpi_status",
    params: {},
  });

  // Required tool fields are still enforced after normalization.
  f.send(request(103, "tools/call", { name: "alpi_exec" }));
  response = JSON.parse(await f.out.next());
  assert.equal(response.id, 103);
  assert.equal(response.error.code, -32602);

  f.send(
    request(104, "tools/call", {
      name: "alpi_exec",
      arguments: { environmentId: "env-1" },
      _meta: {},
    }),
  );
  response = JSON.parse(await f.out.next());
  assert.equal(response.id, 104);
  assert.equal(response.error.code, -32602);

  // Malformed metadata and arbitrary extra params are rejected.
  f.send(request(105, "tools/call", { name: "alpi_status", arguments: {}, _meta: [] }));
  response = JSON.parse(await f.out.next());
  assert.equal(response.id, 105);
  assert.equal(response.error.code, -32602);

  f.send(request(106, "tools/list", { _meta: "not-an-object" }));
  response = JSON.parse(await f.out.next());
  assert.equal(response.id, 106);
  assert.equal(response.error.code, -32602);

  f.send(request(107, "tools/list", { _meta: {}, cursor: "next" }));
  response = JSON.parse(await f.out.next());
  assert.equal(response.id, 107);
  assert.equal(response.error.code, -32602);

  f.send(request(108, "tools/call", { name: "alpi_status", arguments: {}, extra: true }));
  response = JSON.parse(await f.out.next());
  assert.equal(response.id, 108);
  assert.equal(response.error.code, -32602);

  assert.deepEqual(
    seen.map((entry) => entry.method),
    ["alpi_status", "alpi_status"],
    "only the two valid calls may reach the broker",
  );
  assert.equal(f.stderr(), "");
});

test("initialize requires a capabilities object and clientInfo name/version", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const out = makeReader(output);
  const facade = createMcpServer({ input, output, call: () => ({}) });
  const invalid = [
    {},
    { protocolVersion: "2025-06-18" },
    { protocolVersion: "2025-06-18", capabilities: {} },
    { protocolVersion: "2025-06-18", capabilities: [], clientInfo: { name: "n", version: "v" } },
    { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "", version: "v" } },
    { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "n" } },
    { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "n", version: 7 } },
    {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "n".repeat(129), version: "v" },
    },
  ];
  for (let index = 0; index < invalid.length; index += 1) {
    input.write(frame(request(index, "initialize", invalid[index])));
    const response = JSON.parse(await out.next());
    assert.equal(response.id, index);
    assert.equal(response.error.code, -32602);
  }

  // Optional spec fields are allowed, and an unsupported version still
  // negotiates the single supported version.
  input.write(
    frame(
      request("valid", "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: { roots: { listChanged: true } },
        clientInfo: { name: "synthetic-test", version: "1.0.0", title: "optional" },
        _meta: { progressToken: 1 },
      }),
    ),
  );
  const response = JSON.parse(await out.next());
  assert.equal(response.id, "valid");
  assert.equal(response.result.protocolVersion, "2025-06-18");
  input.write(frame(notification("notifications/initialized")));
  input.end();
  assert.equal(await facade.done, 0);
});

test("deferred dispatch is skipped after same-chunk cancellation", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const out = makeReader(output);
  const dispatches = [];
  const call = (name, params, { signal }) => {
    dispatches.push({ name, params, aborted: signal.aborted });
    if (name === "alpi_status") return { ok: true };
    return new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve({ aborted: true }), { once: true });
    });
  };
  const timers = new Set();
  const facadeModule = loadFacade({
    setTimeoutFn: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      timers.add(timer);
      return timer;
    },
    clearTimeoutFn: (timer) => {
      timers.delete(timer);
      clearTimeout(timer);
    },
  });
  const facade = facadeModule.createMcpServer({ input, output, call });
  input.write(frame(request("init", "initialize", INITIALIZE_PARAMS)));
  assert.equal(JSON.parse(await out.next()).id, "init");
  input.write(frame(notification("notifications/initialized")));

  input.write(
    frame(
      request("c", "tools/call", {
        name: "alpi_wait",
        arguments: { taskId: randomUUID() },
      }),
    ) +
      frame(notification("notifications/cancelled", { requestId: "c" })) +
      frame(request("d", "tools/call", { name: "alpi_status" })),
  );
  const response = JSON.parse(await out.next());
  assert.equal(response.id, "d");
  assert.equal(response.result.isError, false);
  assert.deepEqual(
    dispatches.map((entry) => entry.name),
    ["alpi_status"],
    "the cancelled call must never invoke the callback",
  );
  assert.equal(dispatches[0].aborted, false);

  input.end();
  assert.equal(await facade.done, 0);
  assert.equal(timers.size, 0, "cancelled call timers must be cleared");
});

test("synchronous close prevents a deferred dispatch", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let dispatches = 0;
  const call = () => {
    dispatches += 1;
    return new Promise(() => {});
  };
  const timers = new Set();
  const facadeModule = loadFacade({
    setTimeoutFn: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      timers.add(timer);
      return timer;
    },
    clearTimeoutFn: (timer) => {
      timers.delete(timer);
      clearTimeout(timer);
    },
  });
  const facade = facadeModule.createMcpServer({ input, output, call });
  // Deliver the frames synchronously so the call entry exists before close(),
  // then close before the deferred dispatch microtask can run.
  input.emit(
    "data",
    Buffer.from(
      frame(request("init", "initialize", INITIALIZE_PARAMS)) +
        frame(notification("notifications/initialized")) +
        frame(request("c", "tools/call", { name: "alpi_status", arguments: {} })),
    ),
  );
  facade.close();
  assert.equal(await facade.done, 0);
  assert.equal(dispatches, 0, "the callback must not run after close");
  assert.equal(timers.size, 0, "the call timer must be cleared");
  input.end();
});

test("an output write callback failure terminates once and owns its deferred stream error", async () => {
  const input = new PassThrough();
  const written = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      written.push(chunk.toString());
      // Fail on a later tick: the stream error is deferred behind this callback.
      setImmediate(() => callback(new Error("synthetic-output-failure")));
    },
  });
  const terminations = [];
  const facade = createMcpServer({
    input,
    output,
    call: () => ({ ok: true }),
    onTerminate: (code) => terminations.push(code),
  });
  input.write(frame(request("init", "initialize", INITIALIZE_PARAMS)));
  input.write(frame(notification("notifications/initialized")));
  input.write(frame(request("p", "ping")));
  assert.equal(await facade.done, 1);
  assert.deepEqual(terminations, [1]);
  // The guard has to survive the deferred error the failed write schedules and
  // is released once that error has been delivered.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(output.listenerCount("error"), 0);
  assert.equal(output.listenerCount("close"), 0);
  assert.equal(
    written.some((chunk) => chunk.includes("synthetic-output-failure")),
    false,
    "raw stream errors must not appear in protocol output",
  );
  assert.deepEqual(terminations, [1], "termination must stay exactly once");
  input.end();
});

test("a forced write stall terminates once and keeps the guard for the outstanding write", async () => {
  const facadeModule = loadFacade({
    setTimeoutFn: (fn, ms) => setTimeout(fn, ms === WRITE_STALL_MS ? 150 : ms),
  });
  const input = new PassThrough();
  let retained = null;
  const chunks = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      retained = callback;
    },
  });
  const terminations = [];
  const facade = facadeModule.createMcpServer({
    input,
    output,
    call: () => ({ ok: true }),
    onTerminate: (code) => terminations.push(code),
  });
  input.write(frame(request("init", "initialize", INITIALIZE_PARAMS)));
  input.write(frame(notification("notifications/initialized")));

  const code = await Promise.race([
    facade.done,
    delay(2000).then(() => {
      throw new Error("The stalled facade did not terminate.");
    }),
  ]);
  assert.equal(code, 1);
  assert.deepEqual(terminations, [1]);
  assert.equal(typeof retained, "function");
  assert.equal(
    output.listenerCount("error"),
    1,
    "the guard must outlive finish while a write is pending",
  );
  assert.equal(output.listenerCount("close"), 1);

  // A late successful callback retires the owned write; the guard is released
  // without waiting for an error that will never arrive.
  retained(null);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(output.listenerCount("error"), 0);
  assert.equal(output.listenerCount("close"), 0);
  assert.deepEqual(terminations, [1], "termination must stay exactly once");
  assert.equal(chunks.length, 1);
  input.end();
});

test("an emitted output error does not release the guard for a pending owned write", async () => {
  const input = new PassThrough();
  let retained = null;
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      retained = callback;
    },
  });
  const terminations = [];
  const facade = createMcpServer({
    input,
    output,
    call: () => ({}),
    onTerminate: (code) => terminations.push(code),
  });
  input.write(frame(request("init", "initialize", INITIALIZE_PARAMS)));
  assert.equal(typeof retained, "function");
  output.emit("error", new Error("synthetic-live-error"));
  assert.equal(await facade.done, 1);
  assert.deepEqual(terminations, [1]);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    output.listenerCount("error"),
    1,
    "the guard must stay while a facade-owned write is still pending",
  );
  retained(null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(output.listenerCount("error"), 0);
  assert.deepEqual(terminations, [1], "termination must stay exactly once");
  input.end();
});

test("close waits for an outstanding owned write and releases its guard afterwards", async () => {
  const input = new PassThrough();
  let retained = null;
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      retained = callback;
    },
  });
  const terminations = [];
  const facade = createMcpServer({
    input,
    output,
    call: () => ({}),
    onTerminate: (code) => terminations.push(code),
  });
  input.write(frame(request("init", "initialize", INITIALIZE_PARAMS)));
  facade.close();
  let settled = false;
  facade.done.then(() => {
    settled = true;
  });
  await delay(50);
  assert.equal(settled, false, "done must not resolve while an owned write is outstanding");
  assert.equal(output.listenerCount("error"), 1);

  retained(null);
  assert.equal(await facade.done, 0);
  assert.deepEqual(terminations, [0]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(output.listenerCount("error"), 0);
  assert.equal(output.listenerCount("close"), 0);
});

test("reused input and output release owned listeners without disturbing caller listeners", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const callerData = () => {};
  const callerError = () => {};
  const callerClose = () => {};
  input.on("data", callerData);
  input.on("error", callerError);
  output.on("error", callerError);
  output.on("close", callerClose);

  const counts = () => ({
    data: input.listenerCount("data"),
    end: input.listenerCount("end"),
    inputError: input.listenerCount("error"),
    outputError: output.listenerCount("error"),
    outputClose: output.listenerCount("close"),
  });
  const baseline = { data: 1, end: 0, inputError: 1, outputError: 1, outputClose: 1 };
  assert.deepEqual(counts(), baseline);

  for (let index = 0; index < 2; index += 1) {
    const facade = createMcpServer({ input, output, call: () => ({}) });
    const active = counts();
    assert.deepEqual(
      {
        data: active.data,
        end: active.end,
        inputError: active.inputError,
        outputError: active.outputError,
      },
      { data: 2, end: 1, inputError: 2, outputError: 2 },
      "one owned listener per event on top of the caller's listeners",
    );
    input.write(frame(request(`init-${index}`, "initialize", INITIALIZE_PARAMS)));
    input.write(frame(notification("notifications/initialized")));
    input.write(frame(request(`ping-${index}`, "ping")));
    facade.close();
    assert.equal(await facade.done, 0);
    assert.deepEqual(counts(), baseline, "owned listeners must be released at finish");
    // The facade pauses input while closing; a caller reusing the stream
    // resumes it for the next cycle.
    input.resume();
  }

  // A readable that already ended disposes its owned listeners too.
  const facade = createMcpServer({ input, output, call: () => ({}) });
  input.write(frame(request("init-end", "initialize", INITIALIZE_PARAMS)));
  input.write(frame(notification("notifications/initialized")));
  input.end();
  assert.equal(await facade.done, 0);
  assert.deepEqual(counts(), baseline);
});

test("independently emitted output errors abort active calls and terminate once", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const out = makeReader(output);
  let startedResolve;
  const started = new Promise((resolve) => {
    startedResolve = resolve;
  });
  let aborted = false;
  const terminations = [];
  const call = (name, params, { signal }) => {
    startedResolve();
    return new Promise((resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          aborted = true;
          reject(Object.assign(new Error("aborted"), { name: "AbortError", code: "ABORT_ERR" }));
        },
        { once: true },
      );
    });
  };
  const facade = createMcpServer({
    input,
    output,
    call,
    onTerminate: (code) => terminations.push(code),
  });
  input.write(frame(request("init", "initialize", INITIALIZE_PARAMS)));
  assert.equal(JSON.parse(await out.next()).id, "init");
  input.write(frame(notification("notifications/initialized")));
  input.write(
    frame(request("w", "tools/call", { name: "alpi_wait", arguments: { taskId: randomUUID() } })),
  );
  await started;

  // The error arrives after the initialize write completed while a call is
  // active; it must abort that call and terminate exactly once.
  output.emit("error", new Error("synthetic-late-error"));
  assert.equal(await facade.done, 1);
  assert.equal(aborted, true);
  assert.deepEqual(terminations, [1]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(output.listenerCount("error"), 0);
  assert.equal(
    out.all.some((line) => line.includes("synthetic-late-error")),
    false,
    "raw stream errors must not appear in protocol output",
  );
  input.end();
});

test("a delayed owned write failing after termination stays contained", async (t) => {
  for (const scenario of ["overflow", "stall"]) {
    const result = await runOwnedWriteChild(t, scenario);
    assert.equal(
      result.code,
      0,
      `child ${scenario} must not exit on an unhandled stream error: ${result.stderr}`,
    );
    const report = JSON.parse(result.stdout.trim());
    assert.equal(report.before.code, 1, `${scenario}: termination code`);
    assert.deepEqual(report.before.terminations, [1], `${scenario}: exactly one termination`);
    assert.equal(report.before.pending, 1, `${scenario}: the owned write must still be pending`);
    assert.equal(
      report.before.listeners,
      1,
      `${scenario}: the guard must outlive finish while the owned write is pending`,
    );
    assert.deepEqual(
      report.before.ids,
      ["init"],
      `${scenario}: only the initialize frame is written`,
    );
    assert.deepEqual(
      report.after.terminations,
      [1],
      `${scenario}: termination must stay exactly once`,
    );
    assert.equal(
      report.after.listeners,
      0,
      `${scenario}: the guard must be released once the owned write retires`,
    );
    assert.equal(report.after.leaked, false, `${scenario}: raw stream errors must not reach protocol output`);
  }
});

test("the output error handler does not leak across repeated server use", async () => {
  const output = new PassThrough();
  for (let index = 0; index < 3; index += 1) {
    const input = new PassThrough();
    const facade = createMcpServer({ input, output, call: () => ({}) });
    assert.equal(output.listenerCount("error"), 1, "one output error handler per active server");
    input.write(frame(request("init", "initialize", INITIALIZE_PARAMS)));
    input.write(frame(notification("notifications/initialized")));
    input.write(frame(request("p", "ping")));
    input.end();
    assert.equal(await facade.done, 0);
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(output.listenerCount("error"), 0);
});

test("shared transfer contract rejects relative host paths and unsafe names", () => {
  const importBase = { environmentId: "env-1", guestParent: "/work" };
  assert.throws(() =>
    validateCall("alpi_import", { ...importBase, source: "relative", name: "ok" }),
  );
  assert.throws(() =>
    validateCall("alpi_import", { ...importBase, source: "/Users/synthetic/file.txt", guestParent: "relative", name: "ok" }),
  );
  for (const name of ["", ".", "..", "a/b", "a\\b", "bad\u0000name", "bad\nname"]) {
    assert.throws(
      () =>
        validateCall("alpi_import", {
          ...importBase,
          source: "/Users/synthetic/file.txt",
          name,
        }),
      `expected rejection for ${JSON.stringify(name)}`,
    );
  }
  assert.doesNotThrow(() =>
    validateCall("alpi_import", { ...importBase, source: "/Users/synthetic/file.txt", name: "my folder" }),
  );
  assert.doesNotThrow(() =>
    validateCall("alpi_import", { ...importBase, source: "/Users/synthetic/file.txt", name: "結果 名前" }),
  );

  const exportBase = { environmentId: "env-1", source: "/work" };
  assert.throws(() =>
    validateCall("alpi_export", { ...exportBase, hostParent: "relative", name: "ok" }),
  );
  assert.throws(() =>
    validateCall("alpi_export", { ...exportBase, hostParent: "", name: "ok" }),
  );
  assert.throws(() =>
    validateCall("alpi_export", { ...exportBase, hostParent: "/Users/synthetic", name: "/absolute" }),
  );
  assert.doesNotThrow(() =>
    validateCall("alpi_export", { ...exportBase, hostParent: "/Users/synthetic", name: "my folder" }),
  );

  const importTool = TOOLS.find((entry) => entry.name === "alpi_import");
  const exportTool = TOOLS.find((entry) => entry.name === "alpi_export");
  assert.equal(importTool.inputSchema.properties.source.pattern, "^/[^\\u0000]*$");
  assert.equal(exportTool.inputSchema.properties.hostParent.pattern, "^/[^\\u0000]*$");
  assert.equal(importTool.inputSchema.properties.name.pattern, "^(?!\\.{1,2}$)[^\\u0000-\\u001F\\u007F/\\\\]+$");
  assert.equal(exportTool.inputSchema.properties.name.pattern, importTool.inputSchema.properties.name.pattern);
});

test("invalid transfer arguments never reach the broker", async (t) => {
  const dir = privateDir(t);
  const socketPath = socketIn(dir);
  const seen = [];
  const server = await startServer({
    socketPath,
    dispatch: (method, params) => {
      seen.push({ method, params });
      return { ok: true };
    },
  });
  t.after(() => server.close());
  const f = spawnFacade(t, socketPath);
  await initialize(f);

  const invalid = [
    {
      name: "alpi_import",
      arguments: { environmentId: "env-1", source: "relative", guestParent: "/work", name: "ok" },
    },
    {
      name: "alpi_import",
      arguments: {
        environmentId: "env-1",
        source: "/Users/synthetic/file.txt",
        guestParent: "/work",
        name: "../escape",
      },
    },
    {
      name: "alpi_export",
      arguments: { environmentId: "env-1", source: "/work", hostParent: "relative", name: "ok" },
    },
    {
      name: "alpi_export",
      arguments: {
        environmentId: "env-1",
        source: "/work",
        hostParent: "/Users/synthetic",
        name: "/absolute",
      },
    },
  ];
  for (let index = 0; index < invalid.length; index += 1) {
    f.send(request(200 + index, "tools/call", invalid[index]));
    const response = JSON.parse(await f.out.next());
    assert.equal(response.id, 200 + index);
    assert.equal(response.error.code, -32602);
  }
  assert.equal(seen.length, 0, "invalid transfer calls must not reach the broker");

  f.send(
    request(210, "tools/call", {
      name: "alpi_import",
      arguments: {
        environmentId: "env-1",
        source: "/Users/synthetic/file.txt",
        guestParent: "/work",
        name: "my folder",
      },
    }),
  );
  const response = JSON.parse(await f.out.next());
  assert.equal(response.id, 210);
  assert.equal(response.result.isError, false);
  assert.deepEqual(seen.at(-1), {
    method: "alpi_import",
    params: {
      environmentId: "env-1",
      source: "/Users/synthetic/file.txt",
      guestParent: "/work",
      name: "my folder",
    },
  });
});

test("text limits use schema characters with an explicit UTF-8 byte bound", () => {
  const delegate = TOOLS.find((entry) => entry.name === "alpi_delegate");
  const promptSchema = delegate.inputSchema.properties.prompt;
  assert.equal(promptSchema.maxLength, 32768);
  assert.equal(promptSchema.maxUtf8Bytes, 32768);
  assert.match(promptSchema.description, /32768 UTF-8 bytes/);

  const base = {
    environmentId: "env-1",
    cwd: "/work",
    provider: "provider",
    model: "model",
    requestId: randomUUID(),
  };

  // ASCII stays within both the character and byte bound.
  assert.doesNotThrow(() =>
    validateCall("alpi_delegate", { ...base, prompt: "a".repeat(32768) }),
  );
  assert.throws(() => validateCall("alpi_delegate", { ...base, prompt: "a".repeat(32769) }));

  // Multibyte text is capped by the preserved UTF-8 byte bound.
  assert.doesNotThrow(() =>
    validateCall("alpi_delegate", { ...base, prompt: "é".repeat(16000) }),
  );
  assert.throws(() => validateCall("alpi_delegate", { ...base, prompt: "é".repeat(20000) }));

  // Astral characters count as one schema character but four UTF-8 bytes.
  assert.doesNotThrow(() =>
    validateCall("alpi_delegate", { ...base, prompt: "😀".repeat(8192) }),
  );
  assert.throws(() => validateCall("alpi_delegate", { ...base, prompt: "😀".repeat(32768) }));
  assert.equal([..."😀".repeat(32768)].length, 32768);
  assert.equal("😀".repeat(32768).length, 65536);
});


test("fixed transfer categories survive Unix transport and MCP without dependency messages", async (t) => {
  const expected = {
    transfer_path_refused: "The selected path is not permitted for transfer.",
    transfer_collision: "The transfer destination already exists.",
    transfer_preview_failed: "Preview unavailable. Check paths, permissions and file types.",
    transfer_unknown: "The Alpi request failed.",
  };
  let currentCode;
  const socketPath = socketIn(privateDir(t));
  const server = await startServer({ socketPath, dispatch: () => {
    throw Object.assign(new Error("PRIVATE-TRANSFER-CANARY"), {
      code: currentCode, cause: new Error("PRIVATE-TRANSFER-CANARY"),
    });
  }});
  t.after(() => server.close());
  const f = spawnFacade(t, socketPath);
  await initialize(f);
  let id = 100;
  for (const [code, message] of Object.entries(expected)) {
    currentCode = code;
    f.send(request(++id, "tools/call", {name: "alpi_import", arguments: {
      environmentId: "test", source: "/synthetic/source", guestParent: "/home/user/workspace", name: "copy",
    }}));
    const response = JSON.parse(await f.out.next());
    assert.equal(response.id, id);
    assert.equal(response.result.isError, true);
    assert.deepEqual(JSON.parse(response.result.content[0].text), {
      code: code === "transfer_unknown" ? "request_failed" : code, message,
    });
    assert.equal(JSON.stringify(response).includes("PRIVATE-TRANSFER-CANARY"), false);
  }
  assert.equal(f.stderr(), "");
});


test("actual MCP and service normalize stock observations and keep raw explicit", async (t) => {
  const { OrchestrationService } = require("../src/orchestration/service.cjs");
  const root = privateDir(t);
  const calls = [];
  const envelope = {
    reason: "input-required",
    state: {cursor: 12, active: true, running: true, queue: [], pendingInput: ["approval"]},
    output: {truncated: false, records: [{type: "event", event: {
      type: "assistant/message", seq: 12, data: {message: {content: [
        {type: "text", text: "Waiting for user input"},
        {type: "reasoning", text: "SYNTHETIC-REASONING-CANARY"},
      ]}, stream: [{arguments: "SYNTHETIC-ARGS-CANARY"}]},
    }}]},
  };
  const runtime = {coordinator: {
    withRunning: async (_id, fn, {signal}) => fn({}, {ownershipToken: "synthetic-owner", signal}),
  }};
  const service = new OrchestrationService({stateRoot: root, getRuntime: () => runtime,
    getModels: () => ({fault: false, providers: [{id: "p", models: [{id: "m"}]}]}),
    runExclusive: work => work(),
    guest: {harnessRpc: async (_driver, _options, method, args) => {
      calls.push({method, args});
      if (method === "session/create") return {sessionId: args.sessionId};
      if (method === "session/wait") return envelope;
      return {accepted: true};
    }},
  });
  t.after(() => service.close());
  const socketPath = socketIn(root);
  const server = await startServer({socketPath, dispatch: (method, args, context) => service.dispatch(method, args, context)});
  t.after(() => server.close());
  const f = spawnFacade(t, socketPath);
  await initialize(f);
  let id = 100;
  async function invoke(name, args) {
    f.send(request(++id, "tools/call", {name, arguments: args}));
    const response = JSON.parse(await f.out.next());
    assert.equal(response.id, id);
    assert.equal(response.error, undefined);
    return {error: response.result.isError, value: JSON.parse(response.result.content[0].text)};
  }
  const delegated = await invoke("alpi_delegate", {environmentId: "test", cwd: "/home/user/workspace",
    provider: "p", model: "m", prompt: "Synthetic task", requestId: randomUUID()});
  assert.equal(delegated.error, false);
  const taskId = delegated.value.taskId;
  const compact = await invoke("alpi_wait", {taskId});
  assert.equal(compact.error, false);
  assert.equal(compact.value.snapshot.state, "waiting");
  assert.equal(compact.value.snapshot.cursor, 12);
  assert.deepEqual(compact.value.snapshot.pendingActions, [{kind: "approval", detailAvailable: false, resolution: "guest-ui"}]);
  assert.equal(JSON.stringify(compact).includes("CANARY"), false);
  assert.equal(calls.at(-1).args.maxMessages, 1);
  const raw = await invoke("alpi_wait", {taskId, format: "raw", afterSeq: 12});
  assert.deepEqual(raw.value.value, envelope);
  assert.equal(calls.at(-1).args.maxMessages, 8);
  assert.equal(calls.at(-1).args.afterSeq, 12);
  const cancelled = await invoke("alpi_cancel", {taskId});
  assert.deepEqual(cancelled.value, {taskId, requested: true, acknowledged: true, cooperative: true, processTermination: "unknown"});
  const after = await invoke("alpi_wait", {taskId});
  assert.equal(after.value.snapshot.state, "waiting", "acknowledgment cannot imply completion");
  const count = calls.length;
  service.createAdapter = () => ({capabilities: () => ({observation: false})});
  const unsupported = await invoke("alpi_wait", {taskId});
  assert.equal(unsupported.error, true);
  assert.deepEqual(unsupported.value, {code: "unsupported", message: "This orchestration operation is not available yet."});
  assert.equal(calls.length, count);
  assert.equal(f.stderr(), "");
});
