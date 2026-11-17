const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const { executeGuest, harnessRpc } = require("../src/orchestration/guest.cjs");

const execFileAsync = promisify(execFile);
const HELPER_PATH = path.join(__dirname, "..", "guest", "v1", "orchestration.cjs");
const HELPER_SOURCE = fs.readFileSync(HELPER_PATH, "utf8");
const TOKEN = "synthetic-token-abcdefghijklmnop";
const COOKIE = "dsh-auth-synthetic=v1.eyJhIjoxfQ.signature";

const quote = value => `'${value.replace(/'/g, `'\\''`)}'`;
const decode = value => Buffer.from(value, "base64").toString("utf8");
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await delay(10);
  }
  throw new Error(`fixture file was not created: ${file}`);
}

function waitForClose(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("the helper did not settle"));
    }, timeoutMs);
    const onClose = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener("close", onClose);
    };
    child.once("close", onClose);
  });
}
const hasCode = code => error => {
  assert.equal(error.code, code);
  return true;
};

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alpi-orchestration-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeFixture(t) {
  const root = fixture(t);
  const configRoot = path.join(root, "guest");
  const homeUser = path.join(root, "home-user");
  const homeRoot = path.join(root, "home-root");
  const work = path.join(root, "work");
  for (const directory of [configRoot, homeUser, homeRoot, work,
    path.join(configRoot, "node/bin"), path.join(configRoot, "tools")]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(path.join(configRoot, "network.json"), JSON.stringify({
    proxy: "http://192.0.2.10:3128",
    credentialHost: "192.0.2.10",
    desktop: true,
  }));
  const launchFile = path.join(root, "launch-url");
  return {
    root, configRoot, homeUser, homeRoot, work, launchFile,
    origin: "http://127.0.0.1:1",
    dependencies: {
      testOnly: true,
      configRoot,
      launchFile,
      origin: "http://127.0.0.1:1",
      homeUser,
      homeRoot,
    },
  };
}

async function runHelper(payload, timeout = 20000) {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ["-e", HELPER_SOURCE, encoded],
    { timeout, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
  );
  assert.equal(stderr, "");
  return JSON.parse(stdout);
}

function execPayload(f, command, extra = {}) {
  return {
    mode: "exec",
    command,
    cwd: f.work,
    root: false,
    timeoutMs: 10000,
    dependencies: f.dependencies,
    ...extra,
  };
}

function rpcPayload(f, origin, method, args, extra = {}) {
  return {
    mode: "rpc",
    method,
    args,
    timeoutMs: 5000,
    dependencies: { ...f.dependencies, origin },
    ...extra,
  };
}

// Synthetic driver: emulates the guest's fixed `/bin/sh -c <script>` entrypoint
// by rewriting the pinned guest Node path and injecting test-only dependencies.
// Production host code never spawns a shell or accepts endpoint overrides.
function makeGuestDriver(f, overrides = {}) {
  const calls = [];
  return {
    calls,
    async exec(script, options, { root } = {}) {
      calls.push({ script, options, root });
      if (overrides.fail) throw overrides.fail;
      if (overrides.output !== undefined) return overrides.output;
      const match = script.match(/'([A-Za-z0-9+/=]+)'\s*$/);
      assert(match, "the script must end with one base64 request argument");
      const payload = JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
      assert.equal(payload.dependencies, undefined, "production payloads must not carry endpoint overrides");
      payload.dependencies = {
        testOnly: true,
        configRoot: f.configRoot,
        launchFile: f.launchFile,
        origin: f.origin,
        homeUser: f.homeUser,
        homeRoot: f.homeRoot,
      };
      const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
      let rewritten = script.replace(/'[A-Za-z0-9+/=]+'\s*$/, () => quote(encoded));
      rewritten = rewritten.replace(/^'[^']*'/, () => quote(process.execPath));
      const { stdout } = await execFileAsync("/bin/sh", ["-c", rewritten], {
        timeout: 20000,
        maxBuffer: 4 * 1024 * 1024,
        encoding: "utf8",
        signal: options.signal,
      });
      return stdout;
    },
  };
}

async function startServer(t, handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    res.on("error", () => {});
    req.on("error", () => {});
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const record = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(record);
      handler(record, res);
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  return { server, requests, origin: `http://127.0.0.1:${port}`, port };
}

function exchangeThen(respond) {
  return (request, response) => {
    if (request.method === "GET") {
      response.writeHead(303, {
        "set-cookie": `${COOKIE}; Path=/; HttpOnly; SameSite=Strict`,
        location: "./",
      });
      response.end();
      return;
    }
    respond(request, response);
  };
}

test("executeGuest returns bounded stdout, stderr and a structured nonzero exit", async t => {
  const f = makeFixture(t);
  const driver = makeGuestDriver(f);
  const result = await executeGuest(driver, { ownershipToken: "synthetic-token" }, {
    command: "printf out; printf err >&2; exit 4",
    cwd: f.work,
  });
  assert.deepEqual(result, {
    stdout: "out",
    stderr: "err",
    exitCode: 4,
    signal: null,
    timedOut: false,
    truncated: false,
  });
  assert.equal(driver.calls.length, 1);
  assert.equal(driver.calls[0].root, false);
  assert(driver.calls[0].script.startsWith("'/home/user/.harness-isolated/node/bin/node' -e '"));
  assert(driver.calls[0].script.includes("First-party guest orchestration helper"));
});

test("executeGuest preserves shell quoting and never interpolates the command into the host script", async t => {
  const f = makeFixture(t);
  const marker = path.join(f.root, "host-marker");
  const command = "printf '%s' 'literal $(touch " + marker + ") `echo nope`'";
  const driver = makeGuestDriver(f);
  const result = await executeGuest(driver, { ownershipToken: "synthetic-token" }, {
    command,
    cwd: f.work,
  });
  assert.equal(result.stdout, `literal $(touch ${marker}) \`echo nope\``);
  assert.equal(result.exitCode, 0);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(driver.calls[0].script.includes(command), false);
});

test("executeGuest uses the guest network proxy, CA and root HOME", async t => {
  const f = makeFixture(t);
  const driver = makeGuestDriver(f);
  const command = 'printf "%s\\n" "$HOME" "$HTTPS_PROXY" "$NODE_EXTRA_CA_CERTS" "$NO_PROXY" "$PATH" "$DISPLAY" "$GIT_SSL_CAINFO" "$GIT_CONFIG_SYSTEM" "$GIT_TERMINAL_PROMPT" "$DSH_HOME"';
  const user = await executeGuest(driver, { ownershipToken: "synthetic-token" }, { command, cwd: f.work });
  const userLines = user.stdout.trim().split("\n");
  assert.equal(userLines[0], f.homeUser);
  assert.equal(userLines[1], "http://192.0.2.10:3128");
  assert.equal(userLines[2], path.join(f.configRoot, "ca.crt"));
  assert.equal(userLines[3], "127.0.0.1,localhost,::1,192.0.2.10");
  assert(userLines[4].startsWith(`${path.join(f.configRoot, "node/bin")}:${path.join(f.configRoot, "tools")}:`));
  assert.equal(userLines[5], ":1");
  assert.equal(userLines[6], path.join(f.configRoot, "ca.crt"));
  assert.equal(userLines[7], path.join(f.configRoot, "gitconfig"));
  assert.equal(userLines[8], "0");
  assert.equal(userLines[9], path.join(f.configRoot, "data"));

  const root = await executeGuest(driver, { ownershipToken: "synthetic-token" }, {
    command: 'printf "%s" "$HOME"',
    cwd: f.work,
    root: true,
  });
  assert.equal(root.stdout, f.homeRoot);
  assert.equal(driver.calls.at(-1).root, true);
});

test("executeGuest truncates each stream at 64 KiB and reports truncation", async t => {
  const f = makeFixture(t);
  const driver = makeGuestDriver(f);
  const result = await executeGuest(driver, { ownershipToken: "synthetic-token" }, {
    command: "yes x | head -c 70000; yes y | head -c 70000 >&2",
    cwd: f.work,
    timeoutMs: 5000,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.length, 65536);
  assert.equal(result.stderr.length, 65536);
  assert.equal(result.truncated, true);
  assert.equal(result.timedOut, false);
});

test("executeGuest rejects malformed guest output, oversize output and raw driver errors", async t => {
  const f = makeFixture(t);
  await assert.rejects(
    executeGuest(makeGuestDriver(f, { output: "not-json" }), { ownershipToken: "t" }, { command: "true", cwd: f.work }),
    hasCode("guest-output-invalid"),
  );
  await assert.rejects(
    executeGuest(makeGuestDriver(f, { output: "x".repeat(524289) }), { ownershipToken: "t" }, { command: "true", cwd: f.work }),
    hasCode("guest-output-oversize"),
  );
  const secret = "token=must-not-leak";
  await assert.rejects(
    executeGuest(makeGuestDriver(f, { fail: new Error(secret) }), { ownershipToken: "t" }, { command: "true", cwd: f.work }),
    error => {
      assert.equal(error.code, "guest-transport-failed");
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
  await assert.rejects(
    executeGuest(makeGuestDriver(f, {
      fail: Object.assign(new Error(secret), { code: "guest-command-failed" }),
    }), { ownershipToken: "t" }, { command: "true", cwd: f.work }),
    error => {
      assert.equal(error.code, "guest-command-failed");
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
});

test("executeGuest bounds decoded streams even when a helper over-reports", async t => {
  const f = makeFixture(t);
  const driver = {
    async exec() {
      return JSON.stringify({
        ok: true,
        stdout: Buffer.alloc(70000, 97).toString("base64"),
        stderr: "",
        exitCode: 0,
        signal: null,
        timedOut: false,
        truncated: false,
      });
    },
  };
  const result = await executeGuest(driver, { ownershipToken: "t" }, { command: "true", cwd: f.work });
  assert.equal(result.stdout.length, 65536);
  assert.equal(result.truncated, true);
});

test("harnessRpc rejects a helper success envelope without a value", async t => {
  const f = makeFixture(t);
  const driver = {
    async exec() {
      return JSON.stringify({ ok: true });
    },
  };
  await assert.rejects(
    harnessRpc(driver, { ownershipToken: "t" }, "session/state", { sessionId: "s" }),
    hasCode("guest-output-invalid"),
  );
});

test("executeGuest validates command, cwd, root, timeout and options", async t => {
  const f = makeFixture(t);
  const driver = makeGuestDriver(f);
  await assert.rejects(
    executeGuest(driver, { ownershipToken: "t" }, { command: "x".repeat(32769), cwd: f.work }),
    hasCode("guest-command-invalid"),
  );
  await assert.rejects(
    executeGuest(driver, { ownershipToken: "t" }, { command: "true", cwd: "relative" }),
    hasCode("guest-cwd-invalid"),
  );
  await assert.rejects(
    executeGuest(driver, { ownershipToken: "t" }, { command: "true", cwd: f.work, root: "yes" }),
    hasCode("guest-options-invalid"),
  );
  await assert.rejects(
    executeGuest(driver, { ownershipToken: "t" }, { command: "true", cwd: f.work, timeoutMs: 0 }),
    hasCode("guest-timeout-invalid"),
  );
  await assert.rejects(
    executeGuest(driver, { ownershipToken: "t" }, null),
    hasCode("guest-options-invalid"),
  );
  await assert.rejects(
    executeGuest({}, { ownershipToken: "t" }, { command: "true", cwd: f.work }),
    hasCode("guest-options-invalid"),
  );
  await assert.rejects(
    executeGuest(driver, {}, { command: "true", cwd: f.work }),
    hasCode("guest-options-invalid"),
  );
});

test("executeGuest honours caller abort with a fixed error", async t => {
  const f = makeFixture(t);
  const controller = new AbortController();
  const driver = {
    async exec(script, { signal }) {
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("raw token=secret")), { once: true });
      });
    },
  };
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(
    executeGuest(driver, { ownershipToken: "t", signal: controller.signal }, { command: "true", cwd: f.work }),
    error => {
      assert.equal(error.code, "guest-aborted");
      assert.equal(error.message.includes("secret"), false);
      return true;
    },
  );
});

test("executeGuest returns the helper's structured guest timeout result", async t => {
  const f = makeFixture(t);
  const driver = makeGuestDriver(f);
  const started = Date.now();
  const result = await executeGuest(driver, { ownershipToken: "t" }, {
    command: "sleep 30",
    cwd: f.work,
    timeoutMs: 200,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, "SIGKILL");
  assert.equal(result.truncated, false);
  assert(Date.now() - started < 5000);
});

test("executeGuest reports a host deadline as a bounded timeout result", async t => {
  const f = makeFixture(t);
  const driver = {
    async exec(script, { signal }) {
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("deadline")), { once: true });
      });
    },
  };
  const result = await executeGuest(driver, { ownershipToken: "t" }, {
    command: "true",
    cwd: f.work,
    timeoutMs: 1,
  });
  assert.deepEqual(result, {
    stdout: "",
    stderr: "",
    exitCode: null,
    signal: null,
    timedOut: true,
    truncated: false,
  });
});

test("executeGuest does not turn a late driver success into success after caller abort", async t => {
  const f = makeFixture(t);
  const controller = new AbortController();
  const envelope = JSON.stringify({
    ok: true,
    stdout: "",
    stderr: "",
    exitCode: 0,
    signal: null,
    timedOut: false,
    truncated: false,
  });
  const driver = {
    async exec() {
      controller.abort();
      return envelope;
    },
  };
  await assert.rejects(
    executeGuest(driver, { ownershipToken: "t", signal: controller.signal }, { command: "true", cwd: f.work }),
    hasCode("guest-aborted"),
  );
});

test("executeGuest bounds a driver that ignores the deadline signal", async t => {
  const f = makeFixture(t);
  const driver = {
    exec() {
      return new Promise(() => {});
    },
  };
  const started = Date.now();
  const result = await executeGuest(driver, { ownershipToken: "t" }, {
    command: "true",
    cwd: f.work,
    timeoutMs: 1,
  });
  assert.deepEqual(result, {
    stdout: "",
    stderr: "",
    exitCode: null,
    signal: null,
    timedOut: true,
    truncated: false,
  });
  assert(Date.now() - started < 6000);
});

test("the helper times out and kills the guest process group including descendants", async t => {
  const f = makeFixture(t);
  const marker = path.join(f.work, "alive");
  const command = `(sleep 2; printf alive > ${quote(marker)}) & sleep 30`;
  const started = Date.now();
  const envelope = await runHelper(execPayload(f, command, { timeoutMs: 300 }));
  assert.equal(envelope.ok, true);
  assert.equal(envelope.timedOut, true);
  assert.equal(envelope.exitCode, null);
  assert.equal(envelope.signal, "SIGKILL");
  assert(Date.now() - started < 5000);
  await new Promise(resolve => setTimeout(resolve, 2500));
  assert.equal(fs.existsSync(marker), false);
});

test("the helper does not hang when a descendant keeps the output pipe open", async t => {
  const f = makeFixture(t);
  const command = "(sleep 30) & printf done";
  const started = Date.now();
  const envelope = await runHelper(execPayload(f, command, { timeoutMs: 5000 }));
  assert.equal(envelope.ok, true);
  assert.equal(decode(envelope.stdout), "done");
  assert.equal(envelope.timedOut, false);
  assert(Date.now() - started < 3000);
});

test("executeGuest aborts an actual helper and kills its command group before the deadline", async t => {
  const f = makeFixture(t);
  const ready = path.join(f.work, "ready");
  const marker = path.join(f.work, "late-marker");
  const command = `printf ready > ${quote(ready)}; sleep 0.8; printf late > ${quote(marker)}`;
  const controller = new AbortController();
  // Attach the rejection handler immediately so a fast helper failure cannot
  // surface as an unhandled rejection while the fixture waits for readiness.
  const run = executeGuest(
    makeGuestDriver(f),
    { ownershipToken: "synthetic-token", signal: controller.signal },
    { command, cwd: f.work, timeoutMs: 400 },
  ).then(
    value => ({ ok: true, value }),
    error => ({ ok: false, error }),
  );

  await waitForFile(ready, 2000);
  assert.equal(fs.existsSync(ready), true);
  controller.abort();
  const outcome = await run;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, "guest-aborted");
  // The shell would write the marker after 0.8 s, beyond the original 400 ms
  // command deadline, unless the helper killed its owned group on termination.
  await delay(1200);
  assert.equal(fs.existsSync(marker), false);
});

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  test(`the helper kills its command group and settles on ${signal}`, async t => {
    const f = makeFixture(t);
    const ready = path.join(f.work, "ready");
    const marker = path.join(f.work, "late-marker");
    const command = `printf ready > ${quote(ready)}; sleep 0.8; printf late > ${quote(marker)}`;
    const encoded = Buffer.from(JSON.stringify(execPayload(f, command, { timeoutMs: 400 })), "utf8")
      .toString("base64");
    const child = spawn(process.execPath, ["-e", HELPER_SOURCE, encoded], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.resume();
    child.stderr.resume();
    const closed = waitForClose(child, 4000);
    try {
      await waitForFile(ready, 2000);
      child.kill(signal);
      await closed;
      // The helper re-raises the signal with the default disposition instead of
      // exiting as a normal success.
      assert.equal(child.signalCode, signal);
      assert.equal(child.exitCode, null);
      await delay(1200);
      assert.equal(fs.existsSync(marker), false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });
}

test("the helper returns a fixed error when the guest command cannot start", async t => {
  const f = makeFixture(t);
  const envelope = await runHelper(execPayload(f, "true", {
    cwd: path.join(f.root, "missing-directory"),
  }));
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "guest-command-failed");
});

test("the helper rejects malformed guest configuration without echoing it", async t => {
  const f = makeFixture(t);
  fs.writeFileSync(path.join(f.configRoot, "network.json"), "{not-json-secret");
  const malformed = await runHelper(execPayload(f, "true"));
  assert.equal(malformed.ok, false);
  assert.equal(malformed.error.code, "guest-config-invalid");
  assert.equal(JSON.stringify(malformed).includes("not-json-secret"), false);

  fs.writeFileSync(path.join(f.configRoot, "network.json"), "x".repeat(70000));
  const oversized = await runHelper(execPayload(f, "true"));
  assert.equal(oversized.ok, false);
  assert.equal(oversized.error.code, "guest-config-invalid");
});

test("the helper rejects non-regular config and launch files without blocking", async t => {
  const f = makeFixture(t);
  const configFile = path.join(f.configRoot, "network.json");
  fs.rmSync(configFile, { force: true });
  try {
    await execFileAsync("mkfifo", [configFile]);
    await execFileAsync("mkfifo", [f.launchFile]);
  } catch {
    t.skip("mkfifo is unavailable");
    return;
  }

  const config = await runHelper(execPayload(f, "true"), 5000);
  assert.equal(config.ok, false);
  assert.equal(config.error.code, "guest-config-invalid");

  const launch = await runHelper({
    mode: "rpc",
    method: "session/state",
    args: { sessionId: "s" },
    timeoutMs: 1000,
    dependencies: f.dependencies,
  }, 5000);
  assert.equal(launch.ok, false);
  assert.equal(launch.error.code, "guest-launch-invalid");
});

test("the helper ignores dependency overrides unless testOnly is explicit", async t => {
  const f = makeFixture(t);
  assert.match(HELPER_SOURCE, /const PINNED = Object\.freeze\(\{/);
  assert.match(HELPER_SOURCE, /dependencies\.testOnly !== true/);
  const envelope = await runHelper({
    mode: "exec",
    command: 'printf "%s" "$DSH_HOME"',
    cwd: f.work,
    root: false,
    timeoutMs: 5000,
    dependencies: { configRoot: f.configRoot, homeUser: f.homeUser },
  });
  if (envelope.ok) {
    // A pinned guest home may exist on a developer machine; the override must
    // still not be used.
    assert.notEqual(decode(envelope.stdout), path.join(f.configRoot, "data"));
  } else {
    assert.equal(envelope.error.code, "guest-config-invalid");
  }
});

test("harnessRpc exchanges the launch token for a browser cookie and wraps args as request", async t => {
  const f = makeFixture(t);
  const server = await startServer(t, exchangeThen((request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/api/session/create");
    assert.equal(request.headers.cookie, COOKIE);
    assert.equal(request.headers.host, `127.0.0.1:${server.port}`);
    const body = JSON.parse(request.body);
    assert.equal(body.type, "client-request");
    assert.equal(body.method, "session/create");
    assert.deepEqual(body.payload.args.request, { cwd: "/home/user/workspace", sessionId: "synthetic" });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      type: "server-response",
      rpcId: body.rpcId,
      result: { ok: true, value: { sessionId: "synthetic" } },
    }));
  }));
  fs.writeFileSync(f.launchFile, `${server.origin}/?token=${TOKEN}\n`);
  f.origin = server.origin;
  const driver = makeGuestDriver(f);
  const value = await harnessRpc(driver, { ownershipToken: "t" }, "session/create", {
    cwd: "/home/user/workspace",
    sessionId: "synthetic",
  });
  assert.deepEqual(value, { sessionId: "synthetic" });
  assert.equal(server.requests.length, 2);
  assert.equal(server.requests[0].url, `/?token=${TOKEN}`);
  assert.equal(driver.calls[0].root, false);
});

test("harnessRpc rejects authentication failures without echoing the token", async t => {
  const f = makeFixture(t);
  const server = await startServer(t, (request, response) => {
    response.writeHead(401, { "content-type": "text/plain" });
    response.end("authentication required");
  });
  fs.writeFileSync(f.launchFile, `${server.origin}/?token=${TOKEN}\n`);
  f.origin = server.origin;
  const driver = makeGuestDriver(f);
  await assert.rejects(
    harnessRpc(driver, { ownershipToken: "t" }, "session/state", { sessionId: "s" }),
    error => {
      assert.equal(error.code, "guest-rpc-auth");
      assert.equal(error.message.includes(TOKEN), false);
      return true;
    },
  );
  assert.equal(server.requests.length, 1);
});

test("harnessRpc does not follow redirects", async t => {
  const f = makeFixture(t);
  const server = await startServer(t, exchangeThen((request, response) => {
    response.writeHead(302, { location: "/api/other" });
    response.end();
  }));
  fs.writeFileSync(f.launchFile, `${server.origin}/?token=${TOKEN}\n`);
  f.origin = server.origin;
  const driver = makeGuestDriver(f);
  await assert.rejects(
    harnessRpc(driver, { ownershipToken: "t" }, "session/state", { sessionId: "s" }),
    hasCode("guest-rpc-http"),
  );
  assert.equal(server.requests.length, 2);
  assert.equal(server.requests.some(request => request.url === "/api/other"), false);
});

test("harnessRpc rejects a non-stock exchange location and a malformed cookie", async t => {
  const f = makeFixture(t);
  const wrongLocation = await startServer(t, (request, response) => {
    response.writeHead(303, {
      "set-cookie": `${COOKIE}; Path=/; HttpOnly; SameSite=Strict`,
      location: "/elsewhere",
    });
    response.end();
  });
  fs.writeFileSync(f.launchFile, `${wrongLocation.origin}/?token=${TOKEN}\n`);
  f.origin = wrongLocation.origin;
  await assert.rejects(
    harnessRpc(makeGuestDriver(f), { ownershipToken: "t" }, "session/state", { sessionId: "s" }),
    hasCode("guest-rpc-http"),
  );
  assert.equal(wrongLocation.requests.length, 1);
  assert.equal(wrongLocation.requests.some(request => request.url === "/elsewhere"), false);

  const badCookie = await startServer(t, (request, response) => {
    response.writeHead(303, {
      "set-cookie": "dsh-auth-synthetic=not-a-valid-cookie; Path=/; HttpOnly",
      location: "./",
    });
    response.end();
  });
  fs.writeFileSync(f.launchFile, `${badCookie.origin}/?token=${TOKEN}\n`);
  f.origin = badCookie.origin;
  await assert.rejects(
    harnessRpc(makeGuestDriver(f), { ownershipToken: "t" }, "session/state", { sessionId: "s" }),
    hasCode("guest-rpc-auth"),
  );
  assert.equal(badCookie.requests.length, 1);
});

test("harnessRpc rejects correlation mismatches and malformed responses", async t => {
  const f = makeFixture(t);
  const server = await startServer(t, exchangeThen((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      type: "server-response",
      rpcId: "not-the-sent-id",
      result: { ok: true, value: { sessionId: "synthetic" } },
    }));
  }));
  fs.writeFileSync(f.launchFile, `${server.origin}/?token=${TOKEN}\n`);
  f.origin = server.origin;
  await assert.rejects(
    harnessRpc(makeGuestDriver(f), { ownershipToken: "t" }, "session/state", { sessionId: "s" }),
    hasCode("guest-rpc-invalid"),
  );

  const malformed = await startServer(t, exchangeThen((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{");
  }));
  fs.writeFileSync(f.launchFile, `${malformed.origin}/?token=${TOKEN}\n`);
  f.origin = malformed.origin;
  await assert.rejects(
    harnessRpc(makeGuestDriver(f), { ownershipToken: "t" }, "session/state", { sessionId: "s" }),
    hasCode("guest-rpc-invalid"),
  );

  const wrongType = await startServer(t, exchangeThen((request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("{}");
  }));
  fs.writeFileSync(f.launchFile, `${wrongType.origin}/?token=${TOKEN}\n`);
  f.origin = wrongType.origin;
  await assert.rejects(
    harnessRpc(makeGuestDriver(f), { ownershipToken: "t" }, "session/state", { sessionId: "s" }),
    hasCode("guest-rpc-invalid"),
  );
});

test("harnessRpc bounds the RPC body before parsing and reports oversize", async t => {
  const f = makeFixture(t);
  const server = await startServer(t, exchangeThen((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("x".repeat(600000));
  }));
  fs.writeFileSync(f.launchFile, `${server.origin}/?token=${TOKEN}\n`);
  f.origin = server.origin;
  await assert.rejects(
    harnessRpc(makeGuestDriver(f), { ownershipToken: "t" }, "session/state", { sessionId: "s" }),
    hasCode("guest-rpc-oversize"),
  );
});

test("harnessRpc maps a stock rejection to a fixed error without forwarding a remote code", async t => {
  const f = makeFixture(t);
  const server = await startServer(t, exchangeThen((request, response) => {
    const body = JSON.parse(request.body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      type: "server-response",
      rpcId: body.rpcId,
      result: {
        ok: false,
        error: {
          code: "session/not-found",
          message: `token=${TOKEN} cookie=${COOKIE}`,
          details: { secret: "raw" },
        },
      },
    }));
  }));
  fs.writeFileSync(f.launchFile, `${server.origin}/?token=${TOKEN}\n`);
  f.origin = server.origin;
  await assert.rejects(
    harnessRpc(makeGuestDriver(f), { ownershipToken: "t" }, "session/state", { sessionId: "s" }),
    error => {
      assert.equal(error.code, "guest-rpc-rejected");
      assert.equal(Object.hasOwn(error, "remoteCode"), false);
      assert.equal(error.message.includes(TOKEN), false);
      assert.equal(error.message.includes(COOKIE), false);
      assert.equal(error.message.includes("raw"), false);
      return true;
    },
  );
});

test("the helper rejects a nested success value that reflects the launch token", async t => {
  const f = makeFixture(t);
  const server = await startServer(t, exchangeThen((request, response) => {
    const body = JSON.parse(request.body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      type: "server-response",
      rpcId: body.rpcId,
      result: { ok: true, value: { nested: [{ deep: { token: TOKEN } }] } },
    }));
  }));
  fs.writeFileSync(f.launchFile, `${server.origin}/?token=${TOKEN}\n`);
  const envelope = await runHelper(rpcPayload(f, server.origin, "session/state", { sessionId: "s" }));
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "guest-rpc-reflection");
  assert.equal(JSON.stringify(envelope).includes(TOKEN), false);
});

test("the helper rejects success values that reflect the cookie value or full cookie header", async t => {
  const f = makeFixture(t);
  const cookieValue = COOKIE.slice(COOKIE.indexOf("=") + 1);
  for (const reflected of [
    { kind: "cookie-value", value: { note: cookieValue } },
    { kind: "cookie-header", value: { [COOKIE]: "present" } },
    { kind: "cookie-header-string", value: { header: COOKIE } },
  ]) {
    const server = await startServer(t, exchangeThen((request, response) => {
      const body = JSON.parse(request.body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        type: "server-response",
        rpcId: body.rpcId,
        result: { ok: true, value: reflected.value },
      }));
    }));
    fs.writeFileSync(f.launchFile, `${server.origin}/?token=${TOKEN}\n`);
    const envelope = await runHelper(rpcPayload(f, server.origin, "session/state", { sessionId: "s" }));
    assert.equal(envelope.ok, false, reflected.kind);
    assert.equal(envelope.error.code, "guest-rpc-reflection", reflected.kind);
    assert.equal(JSON.stringify(envelope).includes(cookieValue), false, reflected.kind);
  }
});

test("the helper rejects a success value reflecting auth at bounded deep nesting", async t => {
  const f = makeFixture(t);
  const depth = 5000;
  const nested = `${"[".repeat(depth)}${JSON.stringify(TOKEN)}${"]".repeat(depth)}`;
  const server = await startServer(t, exchangeThen((request, response) => {
    const body = JSON.parse(request.body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(`{"type":"server-response","rpcId":${JSON.stringify(body.rpcId)},`
      + `"result":{"ok":true,"value":${nested}}}`);
  }));
  fs.writeFileSync(f.launchFile, `${server.origin}/?token=${TOKEN}\n`);
  const envelope = await runHelper(rpcPayload(f, server.origin, "session/state", { sessionId: "s" }));
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "guest-rpc-reflection");
  assert.equal(JSON.stringify(envelope).includes(TOKEN), false);
});

test("the helper does not forward a remote rejection code that embeds the launch token", async t => {
  const f = makeFixture(t);
  const reflectedCode = `${TOKEN}/x`;
  const server = await startServer(t, exchangeThen((request, response) => {
    const body = JSON.parse(request.body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      type: "server-response",
      rpcId: body.rpcId,
      result: { ok: false, error: { code: reflectedCode, message: "rejected" } },
    }));
  }));
  fs.writeFileSync(f.launchFile, `${server.origin}/?token=${TOKEN}\n`);
  const envelope = await runHelper(rpcPayload(f, server.origin, "session/state", { sessionId: "s" }));
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "guest-rpc-rejected");
  assert.equal(Object.hasOwn(envelope.error, "remoteCode"), false);
  assert.equal(JSON.stringify(envelope).includes(TOKEN), false);
});

test("harnessRpc rejects invalid launch origins and missing launch files", async t => {
  const f = makeFixture(t);
  const server = await startServer(t, exchangeThen((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ type: "server-response", rpcId: "x", result: { ok: true } }));
  }));
  fs.writeFileSync(f.launchFile, `http://127.0.0.1:${server.port + 1}/?token=${TOKEN}\n`);
  f.origin = server.origin;
  await assert.rejects(
    harnessRpc(makeGuestDriver(f), { ownershipToken: "t" }, "session/state", { sessionId: "s" }),
    error => {
      assert.equal(error.code, "guest-launch-invalid");
      assert.equal(error.message.includes(TOKEN), false);
      return true;
    },
  );
  assert.equal(server.requests.length, 0);

  fs.writeFileSync(f.launchFile, "x".repeat(5000));
  await assert.rejects(
    harnessRpc(makeGuestDriver(f), { ownershipToken: "t" }, "session/state", { sessionId: "s" }),
    hasCode("guest-launch-invalid"),
  );
  assert.equal(server.requests.length, 0);

  fs.rmSync(f.launchFile, { force: true });
  await assert.rejects(
    harnessRpc(makeGuestDriver(f), { ownershipToken: "t" }, "session/state", { sessionId: "s" }),
    hasCode("guest-launch-unavailable"),
  );
});

test("the helper applies a fixed RPC timeout", async t => {
  const f = makeFixture(t);
  const server = await startServer(t, exchangeThen((request, response) => {
    setTimeout(() => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    }, 400);
  }));
  fs.writeFileSync(f.launchFile, `${server.origin}/?token=${TOKEN}\n`);
  const envelope = await runHelper({
    mode: "rpc",
    method: "session/state",
    args: { sessionId: "s" },
    timeoutMs: 100,
    dependencies: {
      testOnly: true,
      launchFile: f.launchFile,
      origin: server.origin,
      configRoot: f.configRoot,
      homeUser: f.homeUser,
      homeRoot: f.homeRoot,
    },
  });
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "guest-rpc-timeout");
});

test("harnessRpc enforces the method allowlist and argument bounds", async t => {
  const f = makeFixture(t);
  const driver = makeGuestDriver(f);
  await assert.rejects(
    harnessRpc(driver, { ownershipToken: "t" }, "session/list", {}),
    hasCode("guest-method-invalid"),
  );
  assert.equal(driver.calls.length, 0);
  await assert.rejects(
    harnessRpc(driver, { ownershipToken: "t" }, "session/create", { cwd: "/x", workspaceId: "w" }),
    hasCode("guest-args-invalid"),
  );
  await assert.rejects(
    harnessRpc(driver, { ownershipToken: "t" }, "session/prompt", {
      sessionId: "s",
      requestId: "r",
      mode: "queue",
      content: [{ type: "text", text: "x".repeat(70000) }],
    }),
    hasCode("guest-args-invalid"),
  );
  await assert.rejects(
    harnessRpc(driver, { ownershipToken: "t" }, "session/state", { sessionId: "s", extra: true }),
    hasCode("guest-args-invalid"),
  );
});

test("the helper enforces the RPC method allowlist and argument bounds", async t => {
  const f = makeFixture(t);
  const method = await runHelper({
    mode: "rpc",
    method: "session/list",
    args: {},
    timeoutMs: 1000,
    dependencies: f.dependencies,
  });
  assert.equal(method.ok, false);
  assert.equal(method.error.code, "guest-method-invalid");

  const extra = await runHelper({
    mode: "rpc",
    method: "session/state",
    args: { sessionId: "s", extra: true },
    timeoutMs: 1000,
    dependencies: f.dependencies,
  });
  assert.equal(extra.ok, false);
  assert.equal(extra.error.code, "guest-args-invalid");
});

test("wait timeout validation matches the broker range in the host and helper", async t => {
  const f = makeFixture(t);
  for (const timeoutMs of [0, -1, 20001, 600000, 1.5, "1"]) {
    await assert.rejects(
      harnessRpc(makeGuestDriver(f), { ownershipToken: "t" }, "session/wait", { sessionId: "s", timeoutMs }),
      hasCode("guest-args-invalid"),
    );
    const envelope = await runHelper({
      mode: "rpc",
      method: "session/wait",
      args: { sessionId: "s", timeoutMs },
      timeoutMs: 1000,
      dependencies: f.dependencies,
    });
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error.code, "guest-args-invalid");
  }

  for (const timeoutMs of [1, 20000]) {
    const server = await startServer(t, exchangeThen((request, response) => {
      const body = JSON.parse(request.body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        type: "server-response",
        rpcId: body.rpcId,
        result: { ok: true, value: body.payload.args.request },
      }));
    }));
    fs.writeFileSync(f.launchFile, `${server.origin}/?token=${TOKEN}\n`);
    f.origin = server.origin;
    const hostValue = await harnessRpc(
      makeGuestDriver(f), { ownershipToken: "t" }, "session/wait", { sessionId: "s", timeoutMs },
    );
    assert.equal(hostValue.timeoutMs, timeoutMs);
    const envelope = await runHelper(rpcPayload(f, server.origin, "session/wait", { sessionId: "s", timeoutMs }));
    assert.equal(envelope.ok, true);
    assert.equal(envelope.value.timeoutMs, timeoutMs);
  }

  const server = await startServer(t, exchangeThen((request, response) => {
    const body = JSON.parse(request.body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      type: "server-response",
      rpcId: body.rpcId,
      result: { ok: true, value: body.payload.args.request },
    }));
  }));
  fs.writeFileSync(f.launchFile, `${server.origin}/?token=${TOKEN}\n`);
  f.origin = server.origin;
  const omittedHost = await harnessRpc(
    makeGuestDriver(f), { ownershipToken: "t" }, "session/wait", { sessionId: "s" },
  );
  assert.equal(omittedHost.timeoutMs, 1000);
  const omittedHelper = await runHelper(rpcPayload(f, server.origin, "session/wait", { sessionId: "s" }));
  assert.equal(omittedHelper.ok, true);
  assert.equal(omittedHelper.value.timeoutMs, 1000);
});

test("host and helper agree on positive arguments for all six RPC methods", async t => {
  const f = makeFixture(t);
  const cases = [
    { method: "session/create", args: { cwd: "/home/user/workspace", sessionId: "synthetic" } },
    { method: "session/selectModel", args: { sessionId: "s", provider: "p", model: "m", reasoningEffort: "high" } },
    {
      method: "session/prompt",
      args: {
        sessionId: "s",
        requestId: "r",
        mode: "queue",
        content: [{ type: "text", text: "hello" }],
        clientTimeZone: "UTC",
      },
    },
    { method: "session/wait", args: { sessionId: "s", timeoutMs: 1, afterSeq: 0, maxMessages: 1 } },
    { method: "session/cancel", args: { sessionId: "s" } },
    { method: "session/state", args: { sessionId: "s" } },
  ];

  for (const { method, args } of cases) {
    await t.test(method, async t => {
      const server = await startServer(t, exchangeThen((request, response) => {
        const body = JSON.parse(request.body);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          type: "server-response",
          rpcId: body.rpcId,
          result: { ok: true, value: { method: body.method, args: body.payload.args.request } },
        }));
      }));
      fs.writeFileSync(f.launchFile, `${server.origin}/?token=${TOKEN}\n`);
      f.origin = server.origin;
      const hostValue = await harnessRpc(makeGuestDriver(f), { ownershipToken: "t" }, method, args);
      assert.deepEqual(hostValue, { method, args });
      const envelope = await runHelper(rpcPayload(f, server.origin, method, args));
      assert.equal(envelope.ok, true);
      assert.deepEqual(envelope.value, { method, args });
    });
  }
});

test("host and helper reject malformed arguments for all six RPC methods", async t => {
  const f = makeFixture(t);
  const cases = [
    { method: "session/create", args: { cwd: "relative" } },
    { method: "session/create", args: { cwd: "/x", extra: true } },
    { method: "session/selectModel", args: { sessionId: "s", provider: "", model: "m" } },
    { method: "session/selectModel", args: { sessionId: "s", provider: "p" } },
    { method: "session/prompt", args: { sessionId: "s", requestId: "r", mode: "invalid", content: [] } },
    {
      method: "session/prompt",
      args: { sessionId: "s", requestId: "r", mode: "queue", content: [{ type: "text", text: 1 }] },
    },
    { method: "session/wait", args: { sessionId: "s", timeoutMs: 0 } },
    { method: "session/wait", args: { sessionId: "s", timeoutMs: 20001 } },
    { method: "session/wait", args: { sessionId: "s", maxMessages: 0 } },
    { method: "session/cancel", args: { sessionId: "" } },
    { method: "session/state", args: { sessionId: "s", extra: true } },
    { method: "session/state", args: null },
    { method: "session/state", args: [] },
  ];

  for (const { method, args } of cases) {
    await t.test(`${method} ${JSON.stringify(args)}`, async t => {
      const driver = makeGuestDriver(f);
      await assert.rejects(
        harnessRpc(driver, { ownershipToken: "t" }, method, args),
        hasCode("guest-args-invalid"),
      );
      assert.equal(driver.calls.length, 0);
      const envelope = await runHelper({
        mode: "rpc",
        method,
        args,
        timeoutMs: 1000,
        dependencies: f.dependencies,
      });
      assert.equal(envelope.ok, false);
      assert.equal(envelope.error.code, "guest-args-invalid");
    });
  }

  const driver = makeGuestDriver(f);
  await assert.rejects(
    harnessRpc(driver, { ownershipToken: "t" }, "session/list", {}),
    hasCode("guest-method-invalid"),
  );
  assert.equal(driver.calls.length, 0);
  const envelope = await runHelper({
    mode: "rpc",
    method: "session/list",
    args: {},
    timeoutMs: 1000,
    dependencies: f.dependencies,
  });
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "guest-method-invalid");
});

test("host exports never accept arbitrary endpoints", async t => {
  const f = makeFixture(t);
  const driver = makeGuestDriver(f);
  await executeGuest(driver, {
    ownershipToken: "t",
    origin: "http://evil.invalid",
    launchFile: "/tmp/evil",
  }, { command: "true", cwd: f.work });
  assert.equal(driver.calls[0].script.includes("evil.invalid"), false);
  assert.equal(driver.calls[0].script.includes("/tmp/evil"), false);

  const server = await startServer(t, exchangeThen((request, response) => {
    const body = JSON.parse(request.body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      type: "server-response",
      rpcId: body.rpcId,
      result: { ok: true, value: { cursor: 1 } },
    }));
  }));
  fs.writeFileSync(f.launchFile, `${server.origin}/?token=${TOKEN}\n`);
  f.origin = server.origin;
  const rpcDriver = makeGuestDriver(f);
  const value = await harnessRpc(rpcDriver, {
    ownershipToken: "t",
    origin: "http://evil.invalid",
    launchFile: "/tmp/evil",
  }, "session/state", { sessionId: "s" });
  assert.deepEqual(value, { cursor: 1 });
  assert.equal(rpcDriver.calls[0].root, false);
});
