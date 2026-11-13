const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");
const { startOwnedProcess } = require("../src/runtime/owned-process.cjs");
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("owned process closes idempotently and reports an unexpected exit", async () => {
  let exits = 0;
  const child = await startOwnedProcess({ binary: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"], env: {}, onExit: () => exits++ });
  assert(child.healthy()); assert(alive(child.pid));
  await Promise.all([child.close(), child.close()]);
  assert(!child.healthy()); assert(!alive(child.pid)); assert.equal(exits, 1);
  await assert.rejects(startOwnedProcess({ binary: "/nonexistent/isolated-test", args: [], env: {} }), /non riuscito/);
});

test("SIGKILL of the app closes the worker IPC and terminates its owned child", { timeout: 10000 }, async t => {
  const modulePath = require.resolve("../src/runtime/owned-process.cjs");
  const code = `require(${JSON.stringify(modulePath)}).startOwnedProcess({binary:process.execPath,args:['-e','setInterval(()=>{},1000)'],env:{}}).then(child=>process.send({pid:child.pid}));`;
  const app = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  let pid;
  t.after(() => { app.kill("SIGKILL"); if (pid && alive(pid)) process.kill(pid, "SIGKILL"); });
  const [message] = await once(app, "message"); pid = message.pid; assert(alive(pid));
  const exited = once(app, "exit"); app.kill("SIGKILL"); await exited;
  for (let i = 0; i < 50 && alive(pid); i++) await delay(100);
  assert(!alive(pid), "proxy child must not survive its app");
});
