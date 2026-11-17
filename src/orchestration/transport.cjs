// Host-only Unix socket transport for the orchestration coordinator.
// The endpoint lives inside a private Alpi state directory; guest content
// never receives a path to it. Same host UID is the trust boundary.
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { randomBytes, randomUUID } = require("node:crypto");

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_CONCURRENT_SOCKETS = 16;
const MAX_DEADLINE_MS = 180000;
const MAX_SOCKET_PATH_BYTES = 100;
const MAX_ID_LENGTH = 256;
const MAX_METHOD_LENGTH = 256;
const MAX_ERROR_CODE_LENGTH = 64;
const MAX_ERROR_MESSAGE_LENGTH = 512;
const SAFE_CODE = /^[a-z][a-z0-9_]{0,63}$/;

function transportError(code, message, name = "Error") {
  const error = new Error(message);
  error.name = name;
  error.code = code;
  return error;
}

const invalidPath = () => transportError("EINVAL", "The socket path is invalid.");
const pathTooLong = () => transportError("ENAMETOOLONG", "The socket path is too long.");
const privateDirectory = () => transportError("EACCES", "The socket directory is not private.");
const symlinkDirectory = () => transportError("EACCES", "The socket directory contains a symbolic link.");
const endpointExists = () => transportError("EEXIST", "The socket endpoint already exists.");
const endpointUnavailable = () => transportError("ENOENT", "The socket endpoint is unavailable.");
const endpointUntrusted = () => transportError("EACCES", "The socket endpoint is not trusted.");
const invalidRequest = () => transportError("EINVAL", "The request is invalid.");
const requestTooLarge = () => transportError("EMSGSIZE", "The request is too large.");
const invalidResponse = () => transportError("EPROTO", "The response is invalid.");
const incompleteResponse = () => transportError("EPROTO", "The response was incomplete.");
const responseTooLarge = () => transportError("EMSGSIZE", "The response is too large.");
const abortedRequest = () => transportError("ABORT_ERR", "The request was aborted.", "AbortError");
const timedOutRequest = () => transportError("ETIMEDOUT", "The request timed out.", "TimeoutError");
const connectionFailure = () => transportError("TRANSPORT_ERROR", "The request could not be completed.");
const remoteFailure = (code) => transportError(code, "The request failed.", "RequestError");

function lstatIfPresent(file, onError) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw onError ? onError() : error;
  }
}

function decodeUtf8(buffer) {
  return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validId(id) {
  return (
    (typeof id === "string" && id.length > 0 && id.length <= MAX_ID_LENGTH) ||
    Number.isSafeInteger(id)
  );
}

function validMethod(method) {
  return typeof method === "string" && method.length > 0 && method.length <= MAX_METHOD_LENGTH;
}

function safeCode(code) {
  return typeof code === "string" && SAFE_CODE.test(code) && code.length <= MAX_ERROR_CODE_LENGTH
    ? code
    : "request_failed";
}

function checkPrivateDirectory(directory) {
  if (typeof process.getuid !== "function") {
    throw transportError("ENOTSUP", "Unix sockets require a POSIX host.");
  }
  const parsed = path.parse(directory);
  const relative = path.relative(parsed.root, directory);
  const parts = relative === "" ? [] : relative.split(path.sep);
  let current = parsed.root;
  const check = (stat, immediate) => {
    if (stat.isSymbolicLink()) throw symlinkDirectory();
    if (!stat.isDirectory()) throw privateDirectory();
    // Only the immediate parent must be a private directory. Ancestors are
    // inspected to reject symlinks, but they may have ordinary system modes.
    if (immediate && (stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700)) {
      throw privateDirectory();
    }
  };
  const inspect = (file, immediate) => {
    let stat;
    try {
      stat = fs.lstatSync(file);
    } catch {
      throw privateDirectory();
    }
    check(stat, immediate);
  };
  if (parts.length === 0) {
    inspect(current, true);
  } else {
    for (const part of parts) {
      current = path.join(current, part);
      inspect(current, current === directory);
    }
  }
  let canonical;
  try {
    canonical = fs.realpathSync(directory);
  } catch {
    throw privateDirectory();
  }
  if (canonical !== directory) throw privateDirectory();
}

function assertSocketPath(socketPath) {
  if (typeof socketPath !== "string" || socketPath.length === 0 || socketPath.includes("\0")) {
    throw invalidPath();
  }
  if (!path.isAbsolute(socketPath) || path.normalize(socketPath) !== socketPath) {
    throw invalidPath();
  }
  if (Buffer.byteLength(socketPath) >= MAX_SOCKET_PATH_BYTES) throw pathTooLong();
  const parent = path.dirname(socketPath);
  if (parent === socketPath || path.basename(socketPath) === "") throw invalidPath();
  checkPrivateDirectory(parent);
  return parent;
}

function assertClientEndpoint(socketPath) {
  let stat;
  try {
    stat = fs.lstatSync(socketPath);
  } catch {
    throw endpointUnavailable();
  }
  if (stat.isSymbolicLink() || !stat.isSocket()) throw endpointUntrusted();
  if (stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) throw endpointUntrusted();
}

function hiddenPath(parent, socketPath) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = path.join(parent, `.s${randomBytes(3).toString("hex")}`);
    if (candidate === socketPath) continue;
    if (Buffer.byteLength(candidate) >= MAX_SOCKET_PATH_BYTES) throw pathTooLong();
    if (
      lstatIfPresent(candidate, () =>
        transportError("EACCES", "A private socket name could not be reserved."),
      ) === null
    ) {
      return candidate;
    }
  }
  throw transportError("EEXIST", "A private socket name could not be reserved.");
}

function removeEndpointIfOwned(file, expected) {
  try {
    const current = lstatIfPresent(file);
    if (current && current.isSocket() && current.dev === expected.dev && current.ino === expected.ino) {
      fs.unlinkSync(file);
    }
  } catch {
    // Cleanup is best effort; a replacement endpoint is never removed.
  }
}

function closeServer(server) {
  return new Promise((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

async function startServer(options) {
  const { socketPath, dispatch } = options || {};
  if (typeof dispatch !== "function") {
    throw transportError("EINVAL", "A dispatch function is required.");
  }
  assertSocketPath(socketPath);
  if (lstatIfPresent(socketPath, () => privateDirectory()) !== null) throw endpointExists();
  const hidden = hiddenPath(path.dirname(socketPath), socketPath);

  const connections = new Set();
  let closing = false;
  let closingPromise;
  let endpointStat;

  // Liveness is independent of response eligibility: a connection stays live
  // while a response is draining, so its absolute deadline remains armed.
  const isLive = (connection) => !connection.socket.destroyed;
  const canRespond = (connection) => !closing && isLive(connection) && !connection.responded;
  const dispatchActive = (connection) =>
    canRespond(connection) && !connection.controller.signal.aborted;

  // AbortController.abort() is specified not to throw.
  const abortConnection = (connection) => connection.controller.abort();

  const sendFrame = (connection, frame) => {
    if (!canRespond(connection)) return;
    connection.responded = true;
    // The deadline deliberately survives the response drain. A peer that stops
    // reading is destroyed by onDeadline instead of holding a slot forever.
    try {
      connection.socket.end(Buffer.from(frame + "\n", "utf8"), () => {
        connection.socket.destroy();
      });
    } catch {
      connection.socket.destroy();
    }
  };

  const sendErrorFrame = (connection, code, message) => {
    if (!canRespond(connection) || !validId(connection.id)) return;
    sendFrame(connection, JSON.stringify({ id: connection.id, error: { code, message } }));
  };

  const sendResult = (connection, result) => {
    if (!dispatchActive(connection)) return;
    let serializedResult;
    try {
      serializedResult = JSON.stringify(result);
    } catch {
      sendErrorFrame(connection, "invalid_result", "The result could not be serialized.");
      return;
    }
    if (typeof serializedResult !== "string") {
      sendErrorFrame(connection, "invalid_result", "The result could not be serialized.");
      return;
    }
    // connection.id was validated as a string or safe integer, so stringify
    // cannot throw here.
    const serialized = `{"id":${JSON.stringify(connection.id)},"result":${serializedResult}}`;
    if (Buffer.byteLength(serialized) > MAX_RESPONSE_BYTES) {
      sendErrorFrame(connection, "response_too_large", "The response is too large.");
      return;
    }
    sendFrame(connection, serialized);
  };

  const sendDispatchError = (connection, error) => {
    if (!dispatchActive(connection)) return;
    sendErrorFrame(connection, safeCode(error?.code), "The request could not be completed.");
  };

  const rejectConnection = (connection) => {
    abortConnection(connection);
    connection.socket.destroy();
  };

  const parseRequest = (value) => {
    if (!isObject(value) || !validId(value.id)) return { id: undefined };
    const keys = Object.keys(value);
    if (keys.length !== 3 || !keys.includes("method") || !keys.includes("params")) {
      return { id: value.id };
    }
    if (!validMethod(value.method)) return { id: value.id };
    return { request: { id: value.id, method: value.method, params: value.params } };
  };

  const processFrame = (connection, frame) => {
    let text;
    try {
      text = decodeUtf8(frame);
    } catch {
      rejectConnection(connection);
      return;
    }
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      rejectConnection(connection);
      return;
    }
    const parsed = parseRequest(value);
    if (!parsed.request) {
      connection.id = parsed.id;
      abortConnection(connection);
      if (parsed.id !== undefined) {
        sendErrorFrame(connection, "invalid_request", "The request is invalid.");
      } else {
        connection.socket.destroy();
      }
      return;
    }

    connection.id = parsed.request.id;
    let dispatched;
    try {
      dispatched = dispatch(parsed.request.method, parsed.request.params, {
        signal: connection.controller.signal,
      });
    } catch (error) {
      sendDispatchError(connection, error);
      return;
    }
    Promise.resolve(dispatched).then(
      (result) => {
        if (!dispatchActive(connection)) return;
        sendResult(connection, result);
      },
      (error) => {
        if (!dispatchActive(connection)) return;
        sendDispatchError(connection, error);
      },
    );
  };

  const onData = (connection, chunk) => {
    if (!canRespond(connection)) return;
    if (connection.frameDone) {
      // A second frame before the first reply is a protocol violation.
      rejectConnection(connection);
      return;
    }
    if (connection.buffer.length + chunk.length > MAX_REQUEST_BYTES + 1) {
      rejectConnection(connection);
      return;
    }
    connection.buffer = Buffer.concat([connection.buffer, chunk]);
    const newline = connection.buffer.indexOf(10);
    if (newline === -1) return;
    if (newline > MAX_REQUEST_BYTES || connection.buffer.length > newline + 1) {
      // Oversized frame or trailing bytes / a second frame in the same write.
      rejectConnection(connection);
      return;
    }
    let frame = connection.buffer.subarray(0, newline);
    if (frame.length > 0 && frame[frame.length - 1] === 13) {
      frame = frame.subarray(0, frame.length - 1);
    }
    connection.frameDone = true;
    connection.buffer = Buffer.alloc(0);
    if (frame.length === 0) {
      rejectConnection(connection);
      return;
    }
    processFrame(connection, frame);
  };

  const onDeadline = (connection) => {
    // The deadline covers receipt, dispatch and response drain. It destroys the
    // connection even after a response was queued, so a peer that stops reading
    // cannot retain an admission slot.
    if (!isLive(connection)) return;
    abortConnection(connection);
    if (canRespond(connection) && connection.frameDone && validId(connection.id)) {
      // Best effort only: this frame is never waited on. Destruction below is
      // unconditional and does not extend the connection lifetime.
      try {
        connection.socket.write(
          `${JSON.stringify({
            id: connection.id,
            error: { code: "timeout", message: "The request timed out." },
          })}\n`,
        );
      } catch {
        // An unwritable socket is destroyed immediately afterwards.
      }
    }
    connection.socket.destroy();
  };

  const onConnection = (socket) => {
    if (closing || connections.size >= MAX_CONCURRENT_SOCKETS) {
      socket.destroy();
      return;
    }
    const connection = {
      socket,
      controller: new AbortController(),
      timer: null,
      buffer: Buffer.alloc(0),
      frameDone: false,
      responded: false,
      id: undefined,
    };
    connections.add(connection);
    connection.timer = setTimeout(() => onDeadline(connection), MAX_DEADLINE_MS);
    socket.on("data", (chunk) => onData(connection, chunk));
    socket.on("end", () => {
      // The client keeps its writable side open until the reply. EOF before
      // the reply therefore means the peer is gone: abort dispatch and close.
      if (!connection.frameDone) {
        rejectConnection(connection);
      } else if (!connection.responded) {
        abortConnection(connection);
      }
    });
    socket.on("error", () => {
      abortConnection(connection);
      socket.destroy();
    });
    socket.on("close", () => {
      clearTimeout(connection.timer);
      abortConnection(connection);
      connections.delete(connection);
    });
  };

  const server = net.createServer({ allowHalfOpen: false }, onConnection);

  try {
    await new Promise((resolve, reject) => {
      const onError = () => {
        server.removeListener("listening", onListening);
        reject(transportError("EADDRINUSE", "The socket endpoint is unavailable."));
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      try {
        server.listen(hidden);
      } catch {
        server.removeListener("error", onError);
        server.removeListener("listening", onListening);
        reject(transportError("EINVAL", "The socket endpoint is unavailable."));
      }
    });
  } catch (error) {
    await closeServer(server);
    throw error;
  }

  // From here on the listener owns the hidden name. A failed setup closes the
  // server, which unlinks only that hidden name; the public path is untouched.
  server.on("error", () => {});

  let linked = false;
  let linkedStat = null;
  let hiddenStat = null;
  try {
    try {
      hiddenStat = fs.lstatSync(hidden);
    } catch {
      throw endpointUntrusted();
    }
    if (!hiddenStat.isSocket() || hiddenStat.uid !== process.getuid()) {
      throw endpointUntrusted();
    }
    try {
      fs.chmodSync(hidden, 0o600);
    } catch {
      throw privateDirectory();
    }
    try {
      fs.linkSync(hidden, socketPath);
    } catch (error) {
      if (error.code === "EEXIST") throw endpointExists();
      throw transportError("EACCES", "The socket endpoint is unavailable.");
    }
    linked = true;
    let current;
    try {
      current = fs.lstatSync(socketPath);
    } catch {
      throw endpointUntrusted();
    }
    if (current.dev !== hiddenStat.dev || current.ino !== hiddenStat.ino) {
      throw endpointExists();
    }
    linkedStat = current;
    if (!current.isSocket() || current.uid !== process.getuid() || (current.mode & 0o777) !== 0o600) {
      throw endpointUntrusted();
    }
    // Keep the hidden name reserved for the listener's lifetime. Node records
    // its listen pathname and unlinks it during close(); freeing that name now
    // would let a replacement listener bound there be removed by our close.
    // The public path stays guarded by the dev/ino check on removal.
    endpointStat = linkedStat;
  } catch (error) {
    if (linked && linkedStat) removeEndpointIfOwned(socketPath, linkedStat);
    await closeServer(server);
    // Node normally unlinks its listen pathname; only remove the hidden name if
    // it still belongs to this listener.
    if (hiddenStat) removeEndpointIfOwned(hidden, hiddenStat);
    throw error;
  }

  const close = () => {
    if (closingPromise) return closingPromise;
    closingPromise = (async () => {
      closing = true;
      for (const connection of connections) {
        clearTimeout(connection.timer);
        abortConnection(connection);
        connection.socket.destroy();
      }
      connections.clear();
      await closeServer(server);
      if (hiddenStat) removeEndpointIfOwned(hidden, hiddenStat);
      if (endpointStat) removeEndpointIfOwned(socketPath, endpointStat);
    })();
    return closingPromise;
  };

  return { close };
}

async function request(options) {
  const { socketPath, method, params, signal, timeoutMs = 60000 } = options || {};
  assertSocketPath(socketPath);
  if (!validMethod(method)) throw invalidRequest();
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_DEADLINE_MS) {
    throw transportError("EINVAL", "The request timeout is invalid.");
  }
  if (signal !== undefined && (signal === null || typeof signal.addEventListener !== "function")) {
    throw transportError("EINVAL", "The request signal is invalid.");
  }
  if (signal?.aborted) throw abortedRequest();

  const id = randomUUID();
  const body = { id, method, params: params === undefined ? null : params };
  if (
    body.params !== null &&
    (typeof body.params === "function" || typeof body.params === "symbol" || typeof body.params === "bigint")
  ) {
    throw invalidRequest();
  }
  let serialized;
  try {
    serialized = JSON.stringify(body);
  } catch {
    throw invalidRequest();
  }
  if (typeof serialized !== "string") throw invalidRequest();
  if (Buffer.byteLength(serialized) > MAX_REQUEST_BYTES) throw requestTooLarge();
  const frame = Buffer.from(serialized + "\n", "utf8");

  assertClientEndpoint(socketPath);

  return new Promise((resolve, reject) => {
    let settled = false;
    let socket;
    let timer;
    let buffer = Buffer.alloc(0);
    let responseDone = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", onAbort);
      }
      if (socket && !socket.destroyed) socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };

    const onAbort = () => finish(abortedRequest());

    const parseResponse = (frameBytes) => {
      let text;
      try {
        text = decodeUtf8(frameBytes);
      } catch {
        return { error: invalidResponse() };
      }
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        return { error: invalidResponse() };
      }
      if (!isObject(value) || value.id !== id) return { error: invalidResponse() };
      const keys = Object.keys(value);
      if (keys.length !== 2) return { error: invalidResponse() };
      if (keys.includes("result") && !keys.includes("error")) {
        return { result: value.result };
      }
      if (keys.includes("error") && !keys.includes("result")) {
        const remote = value.error;
        if (!isObject(remote)) return { error: invalidResponse() };
        const remoteKeys = Object.keys(remote);
        if (
          remoteKeys.length !== 2 ||
          !remoteKeys.includes("code") ||
          !remoteKeys.includes("message")
        ) {
          return { error: invalidResponse() };
        }
        if (
          typeof remote.code !== "string" ||
          remote.code.length === 0 ||
          remote.code.length > MAX_ERROR_CODE_LENGTH ||
          typeof remote.message !== "string" ||
          remote.message.length > MAX_ERROR_MESSAGE_LENGTH
        ) {
          return { error: invalidResponse() };
        }
        // The message is intentionally not surfaced; only a sanitized code is.
        return { error: remoteFailure(safeCode(remote.code)) };
      }
      return { error: invalidResponse() };
    };

    const onData = (chunk) => {
      if (settled || responseDone) return;
      if (buffer.length + chunk.length > MAX_RESPONSE_BYTES + 1) {
        finish(responseTooLarge());
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(10);
      if (newline === -1) return;
      if (newline > MAX_RESPONSE_BYTES || buffer.length > newline + 1) {
        finish(buffer.length > newline + 1 ? invalidResponse() : responseTooLarge());
        return;
      }
      let responseFrame = buffer.subarray(0, newline);
      if (responseFrame.length > 0 && responseFrame[responseFrame.length - 1] === 13) {
        responseFrame = responseFrame.subarray(0, responseFrame.length - 1);
      }
      responseDone = true;
      buffer = Buffer.alloc(0);
      const outcome = parseResponse(responseFrame);
      if (outcome.error) finish(outcome.error);
      else finish(null, outcome.result);
    };

    timer = setTimeout(() => finish(timedOutRequest()), timeoutMs);

    try {
      socket = net.createConnection({ path: socketPath, allowHalfOpen: true });
    } catch {
      finish(connectionFailure());
      return;
    }

    socket.on("connect", () => {
      if (settled) return;
      try {
        // Keep the writable side open: the server replies before the client
        // closes its half of the connection.
        socket.write(frame);
      } catch {
        finish(connectionFailure());
      }
    });
    socket.on("data", onData);
    socket.on("error", () => finish(connectionFailure()));
    socket.on("end", () => {
      if (!settled) finish(responseDone ? invalidResponse() : incompleteResponse());
    });
    socket.on("close", () => {
      if (!settled) finish(responseDone ? invalidResponse() : incompleteResponse());
    });

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }
  });
}

module.exports = { startServer, request };
