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
const { TOOLS } = require("../src/orchestration/tools.cjs");
const { createMcpServer } = require("../src/orchestration/mcp.cjs");

const TMP_ROOT = fs.realpathSync(os.tmpdir());
const MCP_SOURCE = path.join(__dirname, "../src/orchestration/mcp.cjs");
const MAX_LINE_BYTES = 1024 * 1024;
const WRITE_STALL_MS = 30000;
const CALL_TIMEOUT_MS = 180000;

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
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "synthetic-test", version: "1.0.0" },
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
function loadFacade({ setTimeoutFn = setTimeout } = {}) {
  const source = fs.readFileSync(MCP_SOURCE, "utf8");
  const module = { exports: {} };
  const sandbox = {
    module,
    exports: module.exports,
    require: (specifier) => {
      if (specifier === "./tools.cjs") return require("../src/orchestration/tools.cjs");
      if (specifier === "./transport.cjs") return require("../src/orchestration/transport.cjs");
      return require(specifier);
    },
    setTimeout: setTimeoutFn,
    clearTimeout,
    Buffer,
    process,
    TextDecoder,
    AbortController,
    console,
  };
  vm.runInNewContext(source, sandbox, { filename: MCP_SOURCE });
  return module.exports;
}

function blockedOutput() {
  return new Writable({
    write() {
      // Never completes: the reader is not draining stdout.
    },
  });
}

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
  assert.equal(response.error.code, -32602);

  f.send(request(14, "tools/call", { name: "alpi_status", arguments: [], extra: true }));
  response = JSON.parse(await f.out.next());
  assert.equal(response.id, 14);
  assert.equal(response.error.code, -32602);

  assert.equal(seen.length, before, "invalid calls must not reach the broker");

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
  input.write(frame(request("init", "initialize", { protocolVersion: "2025-06-18" })));
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
  input.write(frame(request("init", "initialize", { protocolVersion: "2025-06-18" })));
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
  input.write(frame(request("init", "initialize", { protocolVersion: "2025-06-18" })));
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
  input.write(frame(request("init", "initialize", { protocolVersion: "2025-06-18" })));
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
