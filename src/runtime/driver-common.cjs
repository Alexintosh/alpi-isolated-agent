const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const { privateDirectory } = require("./iron-ca.cjs");
const { parseLaunch } = require("../engines/common.cjs");
const execute = promisify(execFile);

// Stream bytes through a runtime CLI without buffering guest-controlled output
// or including argv/stdout/stderr in errors. The caller must drain stdout.
function streamCommand(binary, args, { env, signal, timeout = 30 * 60 * 1000 } = {}) {
  signal?.throwIfAborted();
  // Each transfer CLI owns a process group: terminating limactl must also
  // terminate its SSH child, which otherwise may retain the streaming pipes.
  const child = spawn(binary, args, { env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  let stderrBytes = 0;
  let killTimer, stopped = false, settled = false;
  const stop = () => {
    if (stopped || settled) return;
    stopped = true;
    const kill = signal => { if (child.pid) { try { process.kill(-child.pid, signal); } catch {} } };
    kill("SIGTERM");
    killTimer ??= setTimeout(() => kill("SIGKILL"), 3000);
    killTimer.unref();
  };
  const timer = timeout > 0 ? setTimeout(stop, timeout) : undefined; timer?.unref();
  child.stderr.on("data", chunk => { stderrBytes += chunk.length; if (stderrBytes > 65536) stop(); });
  signal?.addEventListener("abort", stop, { once: true });
  const done = new Promise((resolve, reject) => {
    child.once("error", () => reject(new Error("The file channel is unavailable.")));
    child.once("close", code => code === 0 && !signal?.aborted && !stopped ? resolve() : reject(new Error("The file transfer was interrupted or refused.")));
  }).finally(() => {
    settled = true;
    clearTimeout(timer); clearTimeout(killTimer);
    signal?.removeEventListener("abort", stop);
  });
  done.catch(() => {}); // Caller observes done after attaching stream consumers.
  child.stdin.on("error", () => {});
  child.stdout.on("error", () => {});
  if (signal?.aborted) stop();
  return { input: child.stdin, output: child.stdout, done, stop };
}

function cleanEnvironment(home, additions = {}) {
  return { HOME: home, PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "en_US.UTF-8", ...additions };
}

async function run(binary, args, { signal, env, timeout = 30000 } = {}) {
  try {
    return await execute(binary, args, { env, signal, timeout, maxBuffer: 1024 * 1024 });
  } catch (error) {
    signal?.throwIfAborted();
    // execFile errors include argv/stdout/stderr, which may contain a launch token.
    const code = Number.isInteger(error.code) ? ` (exit ${error.code})` :
      typeof error.code === "string" && /^[A-Z_]+$/.test(error.code) ? ` (${error.code})` : error.killed ? " (timeout)" : "";
    const failure = new Error(`Runtime command failed${code}.`);
    failure.runtimeOperation = [path.basename(binary), ...args.slice(0, 2)].filter(x => /^[a-zA-Z0-9_-]+$/.test(x)).join(" ");
    throw failure;
  }
}

function runtimePaths(runtimeRoot, id) {
  if (!path.isAbsolute(runtimeRoot) || path.normalize(runtimeRoot) !== runtimeRoot || !/^[a-z0-9-]+$/.test(id))
    throw new Error("Invalid runtime path.");
  privateDirectory(runtimeRoot);
  const directory = path.join(runtimeRoot, id);
  privateDirectory(directory);
  const socket = path.join(directory, "ui.sock");
  if (Buffer.byteLength(socket) >= 100) throw new Error("The socket path is too long. Choose a shorter runtime root.");
  return { directory, socket };
}

async function socketLease({ socket, port, launch, signal, assertCurrent }) {
  if (typeof assertCurrent !== "function") throw new Error("Launch verification is required.");
  const url = parseLaunch(launch);
  const stat = fs.lstatSync(socket);
  if (!stat.isSocket() || stat.isSymbolicLink()) throw new Error("Invalid guest channel.");
  const sockets = new Set();
  const validate = async () => {
    await assertCurrent();
    const current = fs.lstatSync(socket);
    if (!current.isSocket() || current.dev !== stat.dev || current.ino !== stat.ino)
      throw new Error("The guest channel belongs to another launch.");
  };
  const server = net.createServer(async client => {
    client.pause(); sockets.add(client);
    let upstream;
    const dispose = () => { client.destroy(); upstream?.destroy(); sockets.delete(client); sockets.delete(upstream); };
    client.on("error", dispose); client.on("close", dispose);
    try {
      await validate();
      if (closing || client.destroyed) return dispose();
      upstream = net.connect(socket); sockets.add(upstream);
      upstream.on("error", dispose); upstream.on("close", dispose);
      await new Promise((resolve, reject) => {
        upstream.once("connect", resolve); upstream.once("error", reject);
        upstream.once("close", () => reject(new Error("Channel closed.")));
      });
      await validate();
      if (closing || client.destroyed || upstream.destroyed) return dispose();
      client.pipe(upstream).pipe(client); client.resume();
    } catch { dispose(); void close(); }
  });
  let closing, monitor, checking = false;
  const close = () => closing ??= new Promise(resolve => {
    clearInterval(monitor);
    signal?.removeEventListener("abort", abort);
    for (const socket of sockets) socket.destroy();
    server.close(resolve);
  });
  const abort = () => { void close(); };
  try {
    signal?.throwIfAborted();
    await new Promise((resolve, reject) => {
      server.once("error", () => reject(new Error("The client port is in use or unavailable.")));
      server.listen(port, "127.0.0.1", resolve);
    });
    signal?.throwIfAborted(); signal?.addEventListener("abort", abort, { once: true });
    monitor = setInterval(async () => {
      if (checking || closing) return;
      checking = true;
      try { await validate(); } catch { void close(); }
      finally { checking = false; }
    }, 2000);
    monitor.unref();
    const origin = `http://127.0.0.1:${port}`;
    return { origin, launchUrl: origin + "/" + url.search, close };
  } catch (error) { await close(); throw error; }
}

const launchCommand = 'for i in $(seq 1 20); do if test -s "$HOME/.harness-isolated/launch-url"; then cat "$HOME/.harness-isolated/launch-url"; exit 0; fi; sleep 1; done; exit 1';
module.exports = { run, streamCommand, runtimePaths, cleanEnvironment, socketLease, launchCommand };
