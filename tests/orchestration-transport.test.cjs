const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { once } = require("node:events");
const { startServer, request } = require("../src/orchestration/transport.cjs");

const TMP_ROOT = fs.realpathSync(os.tmpdir());
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_DEADLINE_MS = 180000;

function privateDir(t) {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, "at-"));
  fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function socketIn(dir) {
  return path.join(dir, `t-${randomBytes(4).toString("hex")}.sock`);
}

function frame(value) {
  return JSON.stringify(value) + "\n";
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rawConnect(socketPath) {
  const socket = net.createConnection({ path: socketPath });
  socket.on("error", () => {});
  await once(socket, "connect");
  return socket;
}

function readFrame(socket, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for a frame."));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.off("error", onError);
    };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(10);
      if (newline === -1) {
        if (buffer.length > MAX_RESPONSE_BYTES) {
          cleanup();
          reject(new Error("Response exceeded the bound."));
        }
        return;
      }
      cleanup();
      resolve(buffer.subarray(0, newline).toString("utf8"));
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Socket closed before a frame arrived."));
    };
    const onError = () => {
      cleanup();
      reject(new Error("Socket error before a frame arrived."));
    };
    socket.on("data", onData);
    socket.on("close", onClose);
    socket.on("error", onError);
  });
}

async function expectClose(socket, timeoutMs = 3000) {
  if (socket.destroyed) return;
  const closed = once(socket, "close");
  if (socket.destroyed) return;
  await Promise.race([
    closed,
    delay(timeoutMs).then(() => {
      throw new Error("Socket was not closed.");
    }),
  ]);
}

async function fakeServer(t, socketPath, handler) {
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.resume();
    handler(socket);
  });
  server.listen(socketPath);
  await once(server, "listening");
  fs.chmodSync(socketPath, 0o600);
  t.after(async () => {
    await new Promise((resolve) => server.close(() => resolve()));
  });
  return server;
}

function errorCode(error) {
  return error && typeof error === "object" ? error.code : undefined;
}

test("real Unix roundtrip, endpoint permissions and close removal", async (t) => {
  const dir = privateDir(t);
  const socketPath = socketIn(dir);
  const seen = [];
  const server = await startServer({
    socketPath,
    dispatch: async (method, params, { signal }) => {
      seen.push({ method, params, aborted: signal.aborted });
      return { method, echo: params };
    },
  });
  try {
    const stat = fs.lstatSync(socketPath);
    assert.equal(stat.isSocket(), true);
    assert.equal(stat.mode & 0o777, 0o600);
    assert.equal(stat.uid, process.getuid());
    assert.equal(fs.lstatSync(dir).mode & 0o777, 0o700);

    const result = await request({ socketPath, method: "echo", params: { value: 42 } });
    assert.deepEqual(result, { method: "echo", echo: { value: 42 } });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].aborted, false);

    const nullResult = await request({ socketPath, method: "echo", params: null });
    assert.deepEqual(nullResult, { method: "echo", echo: null });
  } finally {
    await server.close();
  }
  assert.equal(fs.existsSync(socketPath), false);
});

test("sixteen concurrent requests are served within the socket bound", async (t) => {
  const dir = privateDir(t);
  const socketPath = socketIn(dir);
  const server = await startServer({
    socketPath,
    dispatch: async (method, params) => {
      await delay(20);
      return { index: params.index };
    },
  });
  try {
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        request({ socketPath, method: "concurrent", params: { index } }),
      ),
    );
    assert.deepEqual(
      results,
      Array.from({ length: 16 }, (_, index) => ({ index })),
    );
  } finally {
    await server.close();
  }
});

test("dispatch errors expose only a sanitized code and generic message", async (t) => {
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
  try {
    const error = await request({ socketPath, method: "fail", params: {} }).then(
      () => {
        throw new Error("Expected the request to fail.");
      },
      (failure) => failure,
    );
    assert.equal(error.name, "RequestError");
    assert.equal(error.code, "boom");
    assert.equal(error.message.includes("SECRET-CANARY"), false);
  } finally {
    await server.close();
  }
});

test("an unserializable result and an oversized response are rejected", async (t) => {
  const dir = privateDir(t);
  const socketPath = socketIn(dir);
  let mode = "undefined";
  const server = await startServer({
    socketPath,
    dispatch: () => {
      if (mode === "undefined") return undefined;
      if (mode === "toJSON") {
        return {
          toJSON() {
            return undefined;
          },
        };
      }
      return "a".repeat(MAX_RESPONSE_BYTES);
    },
  });
  try {
    const invalid = await request({ socketPath, method: "result", params: {} }).then(
      () => {
        throw new Error("Expected the request to fail.");
      },
      (failure) => failure,
    );
    assert.equal(invalid.code, "invalid_result");

    mode = "toJSON";
    const unserializable = await request({ socketPath, method: "result", params: {} }).then(
      () => {
        throw new Error("Expected the request to fail.");
      },
      (failure) => failure,
    );
    assert.equal(unserializable.code, "invalid_result");

    mode = "oversize";
    const oversized = await request({ socketPath, method: "result", params: {} }).then(
      () => {
        throw new Error("Expected the request to fail.");
      },
      (failure) => failure,
    );
    assert.equal(oversized.code, "response_too_large");
  } finally {
    await server.close();
  }
});

test("client rejects oversized requests and invalid deadlines before connecting", async (t) => {
  const dir = privateDir(t);
  const socketPath = socketIn(dir);

  const oversized = await request({
    socketPath,
    method: "large",
    params: { blob: "a".repeat(MAX_REQUEST_BYTES) },
  }).then(
    () => {
      throw new Error("Expected the request to fail.");
    },
    (failure) => failure,
  );
  assert.equal(oversized.code, "EMSGSIZE");

  await assert.rejects(
    request({ socketPath, method: "large", timeoutMs: MAX_DEADLINE_MS + 1 }),
    (failure) => failure.code === "EINVAL",
  );

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    request({ socketPath, method: "aborted", signal: controller.signal }),
    (failure) => failure.name === "AbortError" && failure.code === "ABORT_ERR",
  );
});

test("aborting a request aborts the server dispatch signal", async (t) => {
  const dir = privateDir(t);
  const socketPath = socketIn(dir);
  const started = deferred();
  const aborted = deferred();
  const server = await startServer({
    socketPath,
    dispatch: (method, params, { signal }) => {
      started.resolve();
      return new Promise((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted.resolve();
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
    },
  });
  try {
    const controller = new AbortController();
    const pending = request({
      socketPath,
      method: "wait",
      params: {},
      signal: controller.signal,
    }).then(
      () => {
        throw new Error("Expected the request to fail.");
      },
      (failure) => failure,
    );
    await started.promise;
    controller.abort();
    const failure = await pending;
    assert.equal(failure.name, "AbortError");
    await aborted.promise;
  } finally {
    await server.close();
  }
});

test("a client disconnect aborts the dispatch signal", async (t) => {
  const dir = privateDir(t);
  const socketPath = socketIn(dir);
  const started = deferred();
  const aborted = deferred();
  const server = await startServer({
    socketPath,
    dispatch: (method, params, { signal }) => {
      started.resolve();
      return new Promise((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted.resolve();
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
    },
  });
  try {
    const socket = await rawConnect(socketPath);
    socket.write(frame({ id: "disconnect", method: "wait", params: {} }));
    await started.promise;
    socket.destroy();
    await aborted.promise;
  } finally {
    await server.close();
  }
});

test("close finishes even when dispatch ignores the abort signal", async (t) => {
  const dir = privateDir(t);
  const socketPath = socketIn(dir);
  const started = deferred();
  let sawAbort = false;
  const server = await startServer({
    socketPath,
    dispatch: (method, params, { signal }) => {
      started.resolve();
      signal.addEventListener("abort", () => {
        sawAbort = true;
      });
      return new Promise(() => {});
    },
  });
  let pending;
  try {
    pending = request({ socketPath, method: "ignore", params: {} }).then(
      () => {
        throw new Error("Expected the request to fail.");
      },
      (failure) => failure,
    );
    await started.promise;
    await Promise.race([
      server.close(),
      delay(3000).then(() => {
        throw new Error("close did not finish.");
      }),
    ]);
    assert.equal(fs.existsSync(socketPath), false);
    assert.equal(sawAbort, true);
    const failure = await pending;
    assert.equal(failure instanceof Error, true);
  } finally {
    await server.close();
  }
});

test("close preserves a replacement endpoint at the same path", async (t) => {
  const dir = privateDir(t);
  const socketPath = socketIn(dir);
  const first = await startServer({
    socketPath,
    dispatch: () => ({ from: "first" }),
  });
  const firstStat = fs.lstatSync(socketPath);
  let second;
  try {
    // Simulate an external replacement: remove the first endpoint while its
    // listener is still alive, then bind a new server at the same path.
    fs.unlinkSync(socketPath);
    second = await startServer({
      socketPath,
      dispatch: () => ({ from: "second" }),
    });
    const secondStat = fs.lstatSync(socketPath);
    assert.notEqual(secondStat.ino, firstStat.ino);

    await first.close();
    assert.equal(fs.existsSync(socketPath), true);
    assert.equal(fs.lstatSync(socketPath).ino, secondStat.ino);

    const result = await request({ socketPath, method: "which", params: {} });
    assert.deepEqual(result, { from: "second" });
  } finally {
    await first.close();
    if (second) await second.close();
  }
  assert.equal(fs.existsSync(socketPath), false);
});

test("an occupied endpoint is rejected and left intact", async (t) => {
  const dir = privateDir(t);
  const socketPath = socketIn(dir);
  const first = await startServer({
    socketPath,
    dispatch: () => ({ ok: true }),
  });
  try {
    const firstStat = fs.lstatSync(socketPath);
    const failure = await startServer({
      socketPath,
      dispatch: () => ({}),
    }).then(
      () => {
        throw new Error("Expected the second server to fail.");
      },
      (error) => error,
    );
    assert.equal(failure.code, "EEXIST");
    assert.equal(fs.existsSync(socketPath), true);
    assert.equal(fs.lstatSync(socketPath).ino, firstStat.ino);
    assert.deepEqual(await request({ socketPath, method: "ping", params: {} }), { ok: true });
  } finally {
    await first.close();
  }
});

test("a failed start never removes another server endpoint", async (t) => {
  const dir = privateDir(t);
  const socketPath = socketIn(dir);
  const external = net.createServer((socket) => socket.end("external\n"));
  external.listen(socketPath);
  await once(external, "listening");
  fs.chmodSync(socketPath, 0o600);
  try {
    const stat = fs.lstatSync(socketPath);
    await assert.rejects(
      startServer({ socketPath, dispatch: () => ({}) }),
      (failure) => failure.code === "EEXIST",
    );
    assert.equal(fs.existsSync(socketPath), true);
    assert.equal(fs.lstatSync(socketPath).ino, stat.ino);
  } finally {
    await new Promise((resolve) => external.close(() => resolve()));
  }
  assert.equal(fs.existsSync(socketPath), false);
});

test("private parent, symlink ancestors and socket mode are enforced", async (t) => {
  const dir = privateDir(t);
  const socketPath = socketIn(dir);
  const server = await startServer({
    socketPath,
    dispatch: () => ({ ok: true }),
  });
  try {
    fs.chmodSync(dir, 0o755);
    const clientFailure = await request({ socketPath, method: "ping", params: {} }).then(
      () => {
        throw new Error("Expected the request to fail.");
      },
      (failure) => failure,
    );
    assert.equal(clientFailure.code, "EACCES");
    fs.chmodSync(dir, 0o700);
    assert.deepEqual(await request({ socketPath, method: "ping", params: {} }), { ok: true });

    const publicDir = fs.mkdtempSync(path.join(TMP_ROOT, "atp-"));
    t.after(() => fs.rmSync(publicDir, { recursive: true, force: true }));
    fs.chmodSync(publicDir, 0o755);
    const publicSocket = socketIn(publicDir);
    await assert.rejects(
      startServer({ socketPath: publicSocket, dispatch: () => ({}) }),
      (failure) => failure.code === "EACCES",
    );
    await assert.rejects(
      request({ socketPath: publicSocket, method: "ping", params: {} }),
      (failure) => failure.code === "EACCES",
    );
    assert.equal(fs.existsSync(publicSocket), false);
  } finally {
    fs.chmodSync(dir, 0o700);
    await server.close();
  }

  const realDir = privateDir(t);
  const linkParent = privateDir(t);
  const link = path.join(linkParent, "linked");
  fs.symlinkSync(realDir, link);
  const linkedSocket = path.join(link, "nested.sock");
  await assert.rejects(
    startServer({ socketPath: linkedSocket, dispatch: () => ({}) }),
    (failure) => failure.code === "EACCES",
  );
  await assert.rejects(
    request({ socketPath: linkedSocket, method: "ping", params: {} }),
    (failure) => failure.code === "EACCES",
  );

  const nestedDir = path.join(realDir, "nested");
  fs.mkdirSync(nestedDir, { mode: 0o700 });
  const ancestorLink = path.join(linkParent, "ancestor");
  fs.symlinkSync(realDir, ancestorLink);
  const ancestorSocket = path.join(ancestorLink, "nested", "inner.sock");
  await assert.rejects(
    startServer({ socketPath: ancestorSocket, dispatch: () => ({}) }),
    (failure) => failure.code === "EACCES",
  );
});

test("existing endpoint files and symlinks are rejected without removal", async (t) => {
  const dir = privateDir(t);
  const filePath = socketIn(dir);
  fs.writeFileSync(filePath, "keep me");
  await assert.rejects(
    startServer({ socketPath: filePath, dispatch: () => ({}) }),
    (failure) => failure.code === "EEXIST",
  );
  assert.equal(fs.readFileSync(filePath, "utf8"), "keep me");
  await assert.rejects(
    request({ socketPath: filePath, method: "ping", params: {} }),
    (failure) => failure.code === "EACCES",
  );

  const realSocket = socketIn(dir);
  const external = await fakeServer(t, realSocket, (socket) => {
    socket.once("data", () => socket.end(frame({ id: "unused", result: null })));
  });
  const linkPath = socketIn(dir);
  fs.symlinkSync(realSocket, linkPath);
  await assert.rejects(
    startServer({ socketPath: linkPath, dispatch: () => ({}) }),
    (failure) => failure.code === "EEXIST",
  );
  await assert.rejects(
    request({ socketPath: linkPath, method: "ping", params: {} }),
    (failure) => failure.code === "EACCES",
  );
  fs.unlinkSync(linkPath);
  await new Promise((resolve) => external.close(() => resolve()));
});

test("client rejects invalid and unavailable socket paths", async (t) => {
  const dir = privateDir(t);
  const socketPath = socketIn(dir);

  await assert.rejects(
    request({ socketPath, method: "ping", params: {} }),
    (failure) => failure.code === "ENOENT",
  );
  await assert.rejects(
    request({ socketPath: "relative.sock", method: "ping", params: {} }),
    (failure) => failure.code === "EINVAL",
  );
  await assert.rejects(
    request({
      socketPath: `${dir}/../escaped.sock`,
      method: "ping",
      params: {},
    }),
    (failure) => failure.code === "EINVAL",
  );
});

test("client rejects a socket with group or world permissions", async (t) => {
  const dir = privateDir(t);
  const socketPath = socketIn(dir);
  const external = await fakeServer(t, socketPath, (socket) => {
    socket.once("data", () => socket.end(frame({ id: "unused", result: null })));
  });
  try {
    fs.chmodSync(socketPath, 0o644);
    await assert.rejects(
      request({ socketPath, method: "ping", params: {} }),
      (failure) => failure.code === "EACCES",
    );
    fs.chmodSync(socketPath, 0o600);
  } finally {
    await new Promise((resolve) => external.close(() => resolve()));
  }
});

test("server rejects oversized, trailing, malformed, invalid UTF-8 and incomplete frames", async (t) => {
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
  try {
    let socket = await rawConnect(socketPath);
    socket.write(Buffer.alloc(MAX_REQUEST_BYTES + 2, 0x61));
    await expectClose(socket);

    socket = await rawConnect(socketPath);
    socket.write(frame({ id: "trailing", method: "ping", params: {} }) + "trailing");
    await expectClose(socket);

    socket = await rawConnect(socketPath);
    socket.write("not json\n");
    await expectClose(socket);

    socket = await rawConnect(socketPath);
    socket.write(
      Buffer.concat([
        Buffer.from('{"id":"'),
        Buffer.from([0xff]),
        Buffer.from('","method":"ping","params":{}}\n'),
      ]),
    );
    await expectClose(socket);

    socket = await rawConnect(socketPath);
    socket.write('{"id":"incomplete","method":"ping","params":{}}');
    socket.end();
    await expectClose(socket);

    assert.equal(calls, 0);
  } finally {
    await server.close();
  }
});

test("a malformed but identified request receives a bounded error", async (t) => {
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
  try {
    const socket = await rawConnect(socketPath);
    socket.write(frame({ id: "bad", method: "ping", params: {}, extra: true }));
    const line = await readFrame(socket);
    const response = JSON.parse(line);
    assert.equal(response.id, "bad");
    assert.equal(response.error.code, "invalid_request");
    assert.equal(typeof response.error.message, "string");
    assert.equal(calls, 0);
    await expectClose(socket);
  } finally {
    await server.close();
  }
});

test("a second frame in a later write aborts dispatch and closes the socket", async (t) => {
  const dir = privateDir(t);
  const socketPath = socketIn(dir);
  const started = deferred();
  const aborted = deferred();
  let calls = 0;
  const server = await startServer({
    socketPath,
    dispatch: (method, params, { signal }) => {
      calls += 1;
      started.resolve();
      return new Promise((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted.resolve();
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
    },
  });
  try {
    const socket = await rawConnect(socketPath);
    socket.write(frame({ id: "one", method: "wait", params: {} }));
    await started.promise;
    const closed = once(socket, "close");
    socket.write(frame({ id: "two", method: "wait", params: {} }));
    await aborted.promise;
    await closed;
    assert.equal(calls, 1);
  } finally {
    await server.close();
  }
});

test("a client that half-closes before the reply cannot receive one", async (t) => {
  const dir = privateDir(t);
  const socketPath = socketIn(dir);
  const started = deferred();
  const aborted = deferred();
  const server = await startServer({
    socketPath,
    dispatch: (method, params, { signal }) => {
      started.resolve();
      return new Promise((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted.resolve();
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
    },
  });
  try {
    const socket = await rawConnect(socketPath);
    socket.write(frame({ id: "half", method: "wait", params: {} }));
    socket.end();
    await started.promise;
    await aborted.promise;
  } finally {
    await server.close();
  }
});

test("client rejects a premature EOF instead of waiting forever", async (t) => {
  const dir = privateDir(t);
  const socketPath = socketIn(dir);
  await fakeServer(t, socketPath, (socket) => {
    socket.once("data", () => socket.end());
  });
  const failure = await request({ socketPath, method: "ping", params: {} }).then(
    () => {
      throw new Error("Expected the request to fail.");
    },
    (error) => error,
  );
  assert.equal(failure.code, "EPROTO");
  assert.equal(failure.message, "The response was incomplete.");
});

test("client rejects a response with the wrong id or shape", async (t) => {
  const dir = privateDir(t);
  const socketPath = socketIn(dir);
  await fakeServer(t, socketPath, (socket) => {
    socket.once("data", (chunk) => {
      const requestValue = JSON.parse(chunk.toString("utf8").trim());
      socket.end(frame({ id: "wrong", result: requestValue.id }));
    });
  });
  const failure = await request({ socketPath, method: "ping", params: {} }).then(
    () => {
      throw new Error("Expected the request to fail.");
    },
    (error) => error,
  );
  assert.equal(failure.code, "EPROTO");

  const secondDir = privateDir(t);
  const secondSocket = socketIn(secondDir);
  await fakeServer(t, secondSocket, (socket) => {
    socket.once("data", (chunk) => {
      const requestValue = JSON.parse(chunk.toString("utf8").trim());
      socket.end(frame({ id: requestValue.id, result: 1, error: { code: "x", message: "y" } }));
    });
  });
  const malformed = await request({ socketPath: secondSocket, method: "ping", params: {} }).then(
    () => {
      throw new Error("Expected the request to fail.");
    },
    (error) => error,
  );
  assert.equal(malformed.code, "EPROTO");
});

test("client rejects trailing frames and oversized responses", async (t) => {
  const dir = privateDir(t);
  const socketPath = socketIn(dir);
  await fakeServer(t, socketPath, (socket) => {
    socket.once("data", (chunk) => {
      const requestValue = JSON.parse(chunk.toString("utf8").trim());
      socket.end(
        frame({ id: requestValue.id, result: 1 }) +
          frame({ id: requestValue.id, result: 2 }),
      );
    });
  });
  const trailing = await request({ socketPath, method: "ping", params: {} }).then(
    () => {
      throw new Error("Expected the request to fail.");
    },
    (error) => error,
  );
  assert.equal(trailing.code, "EPROTO");

  const secondDir = privateDir(t);
  const secondSocket = socketIn(secondDir);
  await fakeServer(t, secondSocket, (socket) => {
    socket.once("data", () => {
      socket.write(Buffer.alloc(MAX_RESPONSE_BYTES + 2, 0x61));
      socket.end();
    });
  });
  const oversized = await request({ socketPath: secondSocket, method: "ping", params: {} }).then(
    () => {
      throw new Error("Expected the request to fail.");
    },
    (error) => error,
  );
  assert.equal(oversized.code, "EMSGSIZE");
});

test("client does not surface a remote error message", async (t) => {
  const dir = privateDir(t);
  const socketPath = socketIn(dir);
  await fakeServer(t, socketPath, (socket) => {
    socket.once("data", (chunk) => {
      const requestValue = JSON.parse(chunk.toString("utf8").trim());
      socket.end(
        frame({
          id: requestValue.id,
          error: { code: "boom", message: "SECRET-CANARY" },
        }),
      );
    });
  });
  const failure = await request({ socketPath, method: "ping", params: {} }).then(
    () => {
      throw new Error("Expected the request to fail.");
    },
    (error) => error,
  );
  assert.equal(failure.name, "RequestError");
  assert.equal(failure.code, "boom");
  assert.equal(failure.message.includes("SECRET-CANARY"), false);
});

test("client times out a server that never replies", async (t) => {
  const dir = privateDir(t);
  const socketPath = socketIn(dir);
  await fakeServer(t, socketPath, () => {});
  const failure = await request({
    socketPath,
    method: "ping",
    params: {},
    timeoutMs: 50,
  }).then(
    () => {
      throw new Error("Expected the request to fail.");
    },
    (error) => error,
  );
  assert.equal(failure.name, "TimeoutError");
  assert.equal(failure.code, "ETIMEDOUT");
});

test("at most sixteen concurrent sockets are accepted", async (t) => {
  const dir = privateDir(t);
  const socketPath = socketIn(dir);
  const allStarted = deferred();
  let calls = 0;
  const server = await startServer({
    socketPath,
    dispatch: (method, params, { signal }) => {
      calls += 1;
      if (calls === 16) allStarted.resolve();
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
  });
  const pending = [];
  try {
    for (let index = 0; index < 16; index += 1) {
      pending.push(
        request({ socketPath, method: "wait", params: { index } }).then(
          () => {
            throw new Error("Expected the request to fail.");
          },
          (error) => error,
        ),
      );
    }
    await allStarted.promise;

    const extra = await request({ socketPath, method: "wait", params: { extra: true } }).then(
      () => {
        throw new Error("Expected the extra request to fail.");
      },
      (error) => error,
    );
    assert.equal(extra instanceof Error, true);
    assert.equal(calls, 16);
  } finally {
    await server.close();
  }
  const settled = await Promise.all(pending);
  assert.equal(settled.every((value) => value instanceof Error), true);
});
