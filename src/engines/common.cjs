const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const runFile = promisify(execFile);

function command(binary, args, { signal, timeout = 30000, ...options } = {}) {
  return runFile(binary, args, {
    timeout,
    maxBuffer: 1024 * 1024,
    signal,
    ...options,
  });
}
function available(binary) {
  try {
    fs.accessSync(binary, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
function checkCancelled(signal) {
  signal?.throwIfAborted();
}
async function delay(ms, signal) {
  const { setTimeout } = require("node:timers/promises");
  await setTimeout(ms, undefined, { signal });
}
function parseLaunch(raw) {
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("URL di avvio guest non valido.");
  }
  if (
    url.origin !== "http://127.0.0.1:3080" ||
    url.pathname !== "/" ||
    url.username ||
    url.password ||
    url.hash ||
    !url.searchParams.get("token")
  )
    throw new Error("URL di avvio guest non valido.");
  return url;
}
async function assertFreePort(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", () =>
      reject(
        new Error(
          "La porta locale dell’ambiente è occupata. Nessun collegamento alternativo è stato usato.",
        ),
      ),
    );
    server.listen(port, "127.0.0.1", () => server.close(resolve));
  });
}
async function kill(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    let timer;
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once("exit", done);
    child.kill("SIGTERM");
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      done();
    }, 2000);
    timer.unref();
  });
}
function socketPath(stateRoot, id) {
  const dir = path.join(stateRoot, "engines", id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, "harness.sock");
}
const launchCommand =
  'for i in $(seq 1 20); do if test -s "$HOME/.harness-native-poc/launch-url"; then cat "$HOME/.harness-native-poc/launch-url"; exit 0; fi; sleep 1; done; exit 1';
module.exports = {
  command,
  available,
  checkCancelled,
  delay,
  parseLaunch,
  assertFreePort,
  kill,
  socketPath,
  launchCommand,
};
