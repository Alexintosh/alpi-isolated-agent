const { fork } = require("node:child_process");
const path = require("node:path");

// The parent never kills this worker directly: that would orphan its child.
// A broken IPC channel makes the worker terminate its child before exiting.
async function startOwnedProcess({ binary, args, env, signal, onExit = () => {} }) {
  signal?.throwIfAborted();
  const worker = fork(path.join(__dirname, "process-owner.cjs"), [], {
    execArgv: [], env: { PATH: "/usr/bin:/bin", ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  let alive = true, pid, closePromise;
  const exited = new Promise(resolve => {
    worker.once("exit", () => { alive = false; onExit(); resolve(); });
  });
  function close() {
    if (closePromise) return closePromise;
    if (worker.connected) worker.disconnect();
    closePromise = exited;
    return closePromise;
  }
  try {
    await new Promise((resolve, reject) => {
      const abort = () => reject(new Error("Avvio processo annullato."));
      const fail = () => reject(new Error("Avvio processo non riuscito."));
      const timeout = setTimeout(fail, 10000);
      const cleanup = () => {
        clearTimeout(timeout); signal?.removeEventListener("abort", abort);
        worker.removeListener("error", fail); worker.removeListener("exit", fail);
      };
      worker.once("message", message => {
        if (message?.type !== "spawned" || !Number.isInteger(message.pid)) return fail();
        pid = message.pid; cleanup(); resolve();
      });
      worker.once("error", fail); worker.once("exit", fail);
      signal?.addEventListener("abort", abort, { once: true });
      worker.send({ type: "start", binary, args, env }, error => { if (error) fail(); });
      // Cleanup also on rejection, without creating an unhandled promise.
      exited.then(cleanup);
      if (signal?.aborted) abort();
    });
    signal?.throwIfAborted();
    return { pid, healthy: () => alive, close };
  } catch (error) { await close(); throw error; }
}

module.exports = { startOwnedProcess };
