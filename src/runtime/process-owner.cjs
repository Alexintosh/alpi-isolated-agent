// Private Node worker. Its IPC channel closes even when the app is SIGKILLed.
// Keep the worker alive until its one child is confirmed dead; never detach it.
const { spawn } = require("node:child_process");
let child, stopping = false, timer;
function stop() {
  if (stopping) return;
  stopping = true;
  if (!child) return process.exit(0);
  child.kill("SIGTERM");
  timer = setTimeout(() => child.kill("SIGKILL"), 3000);
}
process.on("disconnect", stop);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("message", message => {
  if (message?.type === "stop") return stop();
  if (message?.type !== "start" || child || stopping) return;
  child = spawn(message.binary, message.args, {
    env: message.env, stdio: "ignore", detached: false,
  });
  child.once("spawn", () => {
    if (process.connected) process.send({ type: "spawned", pid: child.pid });
    else stop();
  });
  child.once("error", () => process.exit(1));
  child.once("exit", code => { clearTimeout(timer); process.exit(stopping ? 0 : (code || 1)); });
});
