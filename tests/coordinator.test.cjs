const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Coordinator } = require("../src/runtime/coordinator.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "isolated-coordinator-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const events = [];
  let launchGuard, state = "missing", token, guardCount = 0, stopFails = false, startGate, protectedLaunch = false;
  const definition = { id: "test-v1", name: "Test", kind: "fixture" };
  const driver = {
    async inspect({ ownershipToken }) { return { state, owned: token === ownershipToken, protected: protectedLaunch }; },
    async prepare({ ownershipToken, network }) {
      assert(network.healthy()); events.push("prepare"); token = ownershipToken; state = "created";
    },
    async start({ network, signal }) {
      assert(network.healthy()); events.push("start");
      if (startGate) await startGate(signal);
      state = "running"; protectedLaunch = true; launchGuard = network;
    },
    async verifyRetainedLaunch({ownershipToken, network}) {
      if (ownershipToken !== token || state !== 'running' || !protectedLaunch || launchGuard !== network)
        throw Error('Retained launch mismatch');
    },
    async stop() { events.push("stop"); if (stopFails) throw new Error("token=never-persist-this"); state = "stopped"; },
    async connect({ ownershipToken }) {
      if (ownershipToken !== token) throw new Error("Resource not owned at connection.");
      events.push("connect");
      return { origin: "http://127.0.0.1:9", launchUrl: "http://127.0.0.1:9/?token=secret", async close() { events.push("disconnect"); } };
    },
  };
  const network = {
    async open() {
      events.push("network-open"); guardCount++;
      let live = true;
      return { healthy: () => live, async close() { events.push("network-close"); live = false; guardCount--; } };
    },
  };
  const options = { stateRoot: root, definitions: [definition], drivers: new Map([[definition.id, driver]]), network };
  return { root, events, driver, options, runtime: new Coordinator(options),
    get state() { return state; }, get guards() { return guardCount; },
    foreign() { state = "running"; token = "someone-else"; },
    externalRestart() { protectedLaunch = false; },
    failStop(value) { stopFails = value; }, setStartGate(fn) { startGate = fn; },
  };
}

test("serializes duplicate starts and stops the guest before releasing its network", async t => {
  const f = fixture(t);
  await Promise.all([f.runtime.start("test-v1"), f.runtime.start("test-v1")]);
  assert.deepEqual(f.events, ["network-open", "prepare", "start"]);
  await f.runtime.connect("test-v1");
  await f.runtime.shutdown();
  assert.deepEqual(f.events.slice(-3), ["disconnect", "stop", "network-close"]);
  assert.equal(f.guards, 0);
  const saved = fs.readFileSync(path.join(f.root, "environments.json"), "utf8");
  assert(!saved.includes("token=secret"));
});

test('folder grants change only after confirmed stop and retain the guard on failed stop', async t => {
  const f = fixture(t); await f.runtime.start('test-v1'); await f.runtime.connect('test-v1');
  f.failStop(true);
  await assert.rejects(f.runtime.withStopped('test-v1', async () => f.events.push('change-share')));
  assert(!f.events.includes('change-share')); assert.equal(f.guards, 1);
  f.failStop(false);
  await f.runtime.withStopped('test-v1', async () => f.events.push('change-share'));
  assert.deepEqual(f.events.slice(-3), ['stop', 'network-close', 'change-share']);
  assert.equal(f.guards, 0);
});

test("file operations retain the protected launch, serialize stop and are cancelled by Quit", async t => {
  const f = fixture(t); await f.runtime.start("test-v1");
  let begin;
  const started = new Promise(resolve => { begin = resolve; });
  const transfer = f.runtime.withRunning("test-v1", async (driver, { signal, ownershipToken }) => {
    assert.equal(driver, f.driver); assert.equal(ownershipToken, f.runtime.journal.environments['test-v1'].ownershipToken);
    begin(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once:true }));
  });
  const rejected = assert.rejects(transfer, /cancelled/);
  await started; await f.runtime.shutdown(); await rejected;
  assert.equal(f.state, 'stopped'); assert.equal(f.guards, 0);
  assert.equal(f.runtime.journal.environments['test-v1'].issue, null);
});

test("a failed stop preserves the guard and a retry completes shutdown", async t => {
  const f = fixture(t); await f.runtime.start("test-v1"); f.failStop(true);
  await assert.rejects(f.runtime.shutdown(), /Shutdown incomplete/);
  assert.equal(f.state, "running"); assert.equal(f.guards, 1);
  assert(!f.events.includes("network-close"));
  assert(!fs.readFileSync(path.join(f.root, "environments.json"), "utf8").includes("never-persist"));
  await assert.rejects(f.runtime.start("test-v1"), /shutdown/);
  f.failStop(false); await f.runtime.shutdown(); assert.equal(f.guards, 0);
});

test("reconnect rejects a foreign resource substituted while the previous lease closes", async t => {
  const f = fixture(t); await f.runtime.start("test-v1");
  const lease = await f.runtime.connect("test-v1");
  lease.close = async () => { f.foreign(); };
  await assert.rejects(f.runtime.connect("test-v1"), /not owned at connection/);
  assert.equal(f.events.filter(e => e === "connect").length, 1);
  assert.equal(f.runtime.snapshot()[0].connected, false);
  assert.equal(f.guards, 1);
  for (const guard of f.runtime.guards.values()) await guard.close();
});

test("unowned resources are never prepared, started, stopped, or connected", async t => {
  const f = fixture(t); f.foreign();
  await assert.rejects(f.runtime.start("test-v1"), /not owned/);
  await assert.rejects(f.runtime.stop("test-v1"), /not owned/);
  assert.deepEqual(f.events, []);
});

test("restart reconciles a running owned VM by stopping it before a new guard is used", async t => {
  const f = fixture(t); await f.runtime.start("test-v1");
  const recovered = new Coordinator(f.options);
  await recovered.reconcile(); assert.equal(f.state, "stopped");
  await recovered.start("test-v1");
  assert.deepEqual(f.events, ["network-open", "prepare", "start", "stop", "network-open", "start"]);
  await recovered.shutdown();
  await f.runtime.shutdown(); // Close the fixture's old-process guard after confirmed stop.
});

test("quit cancels an active start, rejects queued starts and retains ordering", async t => {
  const f = fixture(t); let entered;
  const ready = new Promise(r => { entered = r; });
  f.setStartGate(signal => new Promise((_resolve, reject) => {
    entered(); signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  const first = f.runtime.start("test-v1"); const firstResult = assert.rejects(first);
  await ready;
  const queued = f.runtime.start("test-v1"); const queuedResult = assert.rejects(queued, /shutdown/);
  await f.runtime.shutdown(); await firstResult; await queuedResult;
  assert.equal(f.events.filter(e => e === "start").length, 1);
  assert.equal(f.guards, 0); assert.equal(f.state, "created");
});

test("corrupt persisted intent cannot silently reset to a fresh environment", t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, "environments.json"), '{"version":99}');
  assert.throws(() => new Coordinator(f.options), /registry/);
});

test("a still-live proxy cannot bless a VM restarted outside the protected driver", async t => {
  const f = fixture(t); await f.runtime.start("test-v1");
  f.externalRestart();
  await assert.rejects(f.runtime.connect("test-v1"), /Start the protected/);
  await f.runtime.start("test-v1");
  assert.deepEqual(f.events.slice(-4), ["stop", "network-close", "network-open", "start"]);
  await f.runtime.shutdown();
});

test("one foreign environment does not prevent recovery of another owned VM", async t => {
  const first = fixture(t), second = fixture(t);
  first.options.definitions.push({ id: "second-v1", name: "Second", kind: "fixture" });
  first.options.drivers.set("second-v1", second.driver);
  const runtime = new Coordinator(first.options);
  await runtime.start("test-v1"); await runtime.start("second-v1");
  first.foreign();
  const recovered = new Coordinator(first.options);
  await assert.rejects(recovered.reconcile(), /recovery/);
  assert.equal(first.state, "running"); assert(!first.events.includes("stop"));
  assert.equal(second.state, "stopped"); assert(second.events.includes("stop"));
  // Fixture guard cleanup only; no foreign guest mutation.
  for (const guard of runtime.guards.values()) await guard.close();
});


test('reconnect with no view repairs retained proxy without stopping jobs, and failed repair leaves guest running', async t => {
  const f=fixture(t);await f.runtime.start('test-v1');await f.runtime.connect('test-v1');
  await f.runtime.disconnect('test-v1');
  const guard=f.runtime.guards.get('test-v1');let healthy=false, fail=true;
  guard.healthy=()=>healthy;
  f.options.network.restore=async (id,{validate})=>{assert.equal(id,'test-v1');f.events.push('network-restore');if(fail)throw Error('proxy repair failed');await validate();healthy=true};
  await assert.rejects(f.runtime.start('test-v1'),/proxy repair failed/);
  assert.equal(f.state,'running');assert(!f.events.includes('stop'));assert.equal(f.guards,1);
  fail=false;await f.runtime.start('test-v1');await f.runtime.connect('test-v1');
  assert.equal(f.events.filter(e=>e==='start').length,1);assert(!f.events.includes('stop'));
  assert.equal(f.runtime.snapshot()[0].connected,true);
  await f.runtime.shutdown();
});

test('proxy recovery refuses a replaced launch without touching it or restarting the proxy', async t => {
  const f=fixture(t);await f.runtime.start('test-v1');
  const guard=f.runtime.guards.get('test-v1');guard.healthy=()=>false;
  f.options.network.restore=async()=>{throw Error('must not reach proxy restore')};
  f.externalRestart();
  await assert.rejects(f.runtime.start('test-v1'),/Retained launch mismatch/);
  await assert.rejects(f.runtime.restoreNetwork('test-v1'),/Retained launch mismatch/);
  assert.equal(f.state,'running');assert(!f.events.includes('stop'));assert.equal(f.guards,1);
  await guard.close();
});


test('failure during the post-recovery observation never enters VM stop/recreate', async t => {
  const f=fixture(t);await f.runtime.start('test-v1');
  const guard=f.runtime.guards.get('test-v1');let healthy=false,recovered=false;
  guard.healthy=()=>healthy;
  f.options.network.restore=async (_id,{validate})=>{await validate();healthy=true;recovered=true};
  const inspect=f.driver.inspect;
  f.driver.inspect=async options=>{const result=await inspect(options);if(recovered)healthy=false;return result};
  await assert.rejects(f.runtime.start('test-v1'),/retained environment is unavailable/);
  assert.equal(f.state,'running');assert(!f.events.includes('stop'));assert.equal(f.events.filter(e=>e==='start').length,1);
  assert.equal(f.guards,1);await guard.close();
});

test('a launch change during proxy repair fails the final paused validation', async t => {
  const f=fixture(t);await f.runtime.start('test-v1');
  const guard=f.runtime.guards.get('test-v1');let healthy=false;
  guard.healthy=()=>healthy;
  f.options.network.restore=async (_id,{validate})=>{f.externalRestart();await validate();healthy=true};
  await assert.rejects(f.runtime.start('test-v1'),/Retained launch mismatch/);
  assert.equal(healthy,false);assert.equal(f.state,'running');assert(!f.events.includes('stop'));
  await guard.close();
});


test('retained proxy recovery retries unfinished guest setup without stopping the VM', async t => {
  const f=fixture(t);await f.runtime.start('test-v1');
  f.runtime.save('test-v1',{prepared:false});
  const guard=f.runtime.guards.get('test-v1');let healthy=false;
  guard.healthy=()=>healthy;
  f.options.network.restore=async (_id,{validate})=>{await validate();healthy=true};
  let attempts=0;
  f.driver.prepare=async()=>{attempts++;if(attempts===1)throw Error('unfinished setup')};
  await assert.rejects(f.runtime.start('test-v1'),/unfinished setup/);
  assert.equal(f.state,'running');assert(!f.events.includes('stop'));
  assert.equal(f.runtime.journal.environments['test-v1'].prepared,false);
  healthy=false;await f.runtime.start('test-v1');
  assert.equal(attempts,2);assert.equal(f.runtime.journal.environments['test-v1'].prepared,true);
  assert(!f.events.includes('stop'));await f.runtime.shutdown();
});
