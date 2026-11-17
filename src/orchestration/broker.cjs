"use strict";
// Host-only orchestration broker bootstrap. It owns one private Unix socket and
// one service instance inside the existing native main process. It creates no
// runtime, profile, VM, credential or listener outside the protected state
// root. The main process owns when this is started and closed.
const fs = require("node:fs");
const path = require("node:path");
const { OrchestrationService } = require("./service.cjs");
const transport = require("./transport.cjs");

const SOCKET_DIRECTORY = "o";
const SOCKET_NAME = "s";

// Broker failures are reported through one fixed message. Callers expose a
// fixed status; raw filesystem or socket errors are never surfaced.
function unavailable() {
  const error = new Error("The orchestration broker could not be started.");
  error.code = "broker_unavailable";
  return error;
}

function lstatIfPresent(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw unavailable();
  }
}

// A refused bootstrap must not create, chmod, adopt or remove anything. Walk
// every existing component from the filesystem root and reject symlinks and
// non-directories before the socket directory or service can touch the tree.
// The final spelling must already be canonical: an unsafe alias is refused
// rather than resolved and adopted.
function assertCanonicalStateRoot(directory) {
  const parsed = path.parse(directory);
  const relative = path.relative(parsed.root, directory);
  const parts = relative === "" ? [] : relative.split(path.sep);
  let current = parsed.root;
  const inspect = (file) => {
    const info = lstatIfPresent(file);
    if (info === null) return false;
    if (info.isSymbolicLink() || !info.isDirectory()) throw unavailable();
    return true;
  };
  if (parts.length === 0) {
    if (!inspect(current)) throw unavailable();
  } else {
    for (const part of parts) {
      current = path.join(current, part);
      if (!inspect(current)) throw unavailable();
    }
  }
  let canonical;
  try {
    canonical = fs.realpathSync(directory);
  } catch {
    throw unavailable();
  }
  if (canonical !== directory) throw unavailable();
}

// Create only a missing socket directory with mode 0700. An existing directory
// is inspected, never chmodded, adopted or removed.
function assertPrivateDirectory(directory) {
  let info = lstatIfPresent(directory);
  if (info === null) {
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
    } catch {
      throw unavailable();
    }
    info = lstatIfPresent(directory);
  }
  if (
    !info ||
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    typeof process.getuid !== "function" ||
    info.uid !== process.getuid() ||
    (info.mode & 0o777) !== 0o700
  ) {
    throw unavailable();
  }
}

async function startBroker(options) {
  const { stateRoot, getRuntime, getModels, runExclusive } = options || {};
  if (
    typeof stateRoot !== "string" ||
    !path.isAbsolute(stateRoot) ||
    path.normalize(stateRoot) !== stateRoot ||
    typeof getRuntime !== "function" ||
    typeof getModels !== "function" ||
    typeof runExclusive !== "function"
  ) {
    throw unavailable();
  }

  const socketDirectory = path.join(stateRoot, SOCKET_DIRECTORY);
  const socketPath = path.join(socketDirectory, SOCKET_NAME);
  // Validate the complete existing ancestry and canonical spelling before any
  // side effect. The transport repeats this at bind time; doing it first keeps
  // a refused bootstrap from creating `o` or normalizing a journal through a
  // symlinked ancestor.
  assertCanonicalStateRoot(stateRoot);
  assertPrivateDirectory(socketDirectory);
  // Preserve an existing endpoint exactly as found: refuse, never unlink it.
  if (lstatIfPresent(socketPath) !== null) throw unavailable();

  let service;
  try {
    service = new OrchestrationService({ stateRoot, getRuntime, getModels, runExclusive });
  } catch {
    throw unavailable();
  }

  let server;
  try {
    server = await transport.startServer({
      socketPath,
      dispatch: (name, args, context) => service.dispatch(name, args, context),
    });
  } catch {
    await service.close();
    throw unavailable();
  }

  let closing;
  return {
    socketPath,
    close() {
      if (closing) return closing;
      closing = (async () => {
        // Abort admitted requests first, then close the listener. The transport
        // destroys every connection before awaiting its listener close.
        try {
          await service.close();
        } finally {
          await server.close();
        }
      })();
      return closing;
    },
  };
}

module.exports = { startBroker };
