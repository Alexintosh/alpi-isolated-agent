const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const { once } = require("node:events");
const { randomUUID, createHash } = require("node:crypto");
const { SmolDriver, WRAP_IMAGE } = require("../src/runtime/smol-driver.cjs");
const { LimaDriver } = require("../src/runtime/lima-driver.cjs");
const { environment } = require("../src/runtime/environments.cjs");
const { cleanEnvironment, socketLease } = require("../src/runtime/driver-common.cjs");

function root(t) {
  // Keep Unix socket paths within Darwin's limit even on long TMPDIR paths.
  const directory = fs.mkdtempSync("/tmp/isolated-driver-");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("smol driver binds only a host-reported mediated launch and checks it before guest access", async t => {
  const runtimeRoot = root(t), definition = environment("wrapvm-v1"), token = randomUUID(), calls = [];
  const record = { name: definition.machine, labels: { owner: definition.owner, identity: token },
    state: "stopped", pid: null, network: true, mounts: 0, ports: 0, image: WRAP_IMAGE,
    restart_policy: "never", allowed_hosts: ["=host.smolvm.internal"], allowed_cidrs: ["192.0.2.1/32"] };
  const driver = new SmolDriver({ definition, runtimeRoot, binary: "/fixture/smolvm" });
  driver.verifyRuntime = () => {};
  driver.command = async (args, options) => {
    calls.push({ args, options });
    if (args[1] === "ls") return { stdout: JSON.stringify([record]) };
    if (args[1] === "start") { record.state = "running"; record.pid = 123; return { stdout: `Mediation machine ID: ${"ab".repeat(16)}\n` }; }
    if (args[1] === "stop") { record.state = "stopped"; return { stdout: "" }; }
    return { stdout: "guest" };
  };
  let activated, revoked = 0;
  const network = { healthy: () => true, mediator: { healthy: () => true,
    address: "127.0.0.1:12345", token: "cd".repeat(32), activate: id => { activated = id; }, revoke: () => revoked++ } };
  const options = { ownershipToken: token, network };
  await driver.boot(options); assert.equal(activated, "ab".repeat(16));
  const start = calls.find(c => c.args[1] === "start");
  assert(start.args.includes("--mediated-egress")); assert(!start.args.includes(network.mediator.token));
  assert.equal(start.options.env.SMOLVM_INTERCEPTOR_TOKEN, network.mediator.token);
  assert.equal((await driver.inspect(options)).protected, true);
  network.healthy = () => false;
  await driver.verifyRetainedLaunch(options);
  await assert.rejects(driver.verifyRetainedLaunch({...options, network: {}}), /cannot be recovered/);
  record.pid = 456; // Same resource, outside launch: cannot silently reconnect.
  await assert.rejects(driver.verifyRetainedLaunch(options), /cannot be recovered/);
  await assert.rejects(driver.exec("id", options), /Protected smolvm launch/);
  record.labels.identity = "foreign";
  await assert.rejects(driver.stop(options), /not owned/);
  assert(!calls.some(c => c.args[1] === "stop"));
  record.labels.identity = token;
  record.allowed_hosts = ["host.smolvm.internal"]; // Broadened DNS policy.
  assert.equal((await driver.inspect(options)).configurationValid, false);
  await driver.stop(options); assert.equal(revoked, 1);
});

test("a failed smol inventory is not treated as an absent VM to recreate", async t => {
  const driver = new SmolDriver({ definition: environment("wrapvm-v1"), runtimeRoot: root(t), binary: "/fixture/smolvm" });
  driver.verifyRuntime = () => {};
  driver.command = async () => { throw new Error("inventory unavailable"); };
  await assert.rejects(driver.inspect(), /inventory unavailable/);
});

test("Lima ownership binds the host directory and configuration while permitting safe stop after config drift", async t => {
  const runtimeRoot = root(t), definition = environment("lima-v1"), token = randomUUID();
  const driver = new LimaDriver({ definition, runtimeRoot, binary: "/fixture/limactl" });
  driver.verifyRuntime = () => {};
  fs.mkdirSync(driver.instanceDirectory);
  fs.writeFileSync(driver.configFile, "mounts: []\n");
  const stat = fs.statSync(driver.instanceDirectory);
  fs.writeFileSync(driver.ownerFile, JSON.stringify({ owner: definition.owner, ownershipToken: token,
    inode: stat.ino, device: stat.dev, configSha256: createHash("sha256").update(fs.readFileSync(driver.configFile)).digest("hex") }));
  const record = { name: definition.machine, dir: driver.instanceDirectory, status: "Running", hostAgentPID: 123 };
  driver.command = async args => {
    if (args[0] === "stop") record.status = "Stopped";
    return { stdout: JSON.stringify(record) };
  };
  driver.launch = { pid: 123, network: { healthy: () => true } };
  const options = { ownershipToken: token };
  assert((await driver.inspect(options)).protected);
  const retained = {...options, network: driver.launch.network};
  driver.launch.network.healthy = () => false;
  await driver.verifyRetainedLaunch(retained);
  record.hostAgentPID = 456;
  await assert.rejects(driver.verifyRetainedLaunch(retained), /cannot be recovered/);
  record.hostAgentPID = 123;
  fs.appendFileSync(driver.configFile, "networks: [{}]\n");
  await assert.rejects(driver.verifyRetainedLaunch(retained), /configuration/);
  assert(!(await driver.inspect(options)).protected);
  await assert.rejects(driver.connect(options), /configuration/);
  await driver.stop(options); assert.equal(record.status, "Stopped");
  await assert.rejects(driver.stop({ ownershipToken: randomUUID() }), /not owned/);
});

test("runtime command environment carries no inherited keys, SSH agent, or proxy settings", () => {
  const env = cleanEnvironment("/fixture/home");
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "LANG", "PATH"]);
  assert.equal(env.HOME, "/fixture/home"); assert(!("SSH_AUTH_SOCK" in env));
});

test('Lima share updates preserve ownership across an interrupted two-file commit and reject drift', async t => {
  const runtimeRoot = root(t), definition = environment('lima-v1'), token = randomUUID();
  const driver = new LimaDriver({ definition, runtimeRoot, binary: '/fixture/limactl' }); driver.verifyRuntime = () => {};
  fs.mkdirSync(driver.instanceDirectory); fs.writeFileSync(driver.configFile, JSON.stringify({ mounts: [], networks: [] }));
  const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const stat = fs.statSync(driver.instanceDirectory);
  fs.writeFileSync(driver.ownerFile, JSON.stringify({ owner: definition.owner, ownershipToken: token,
    inode: stat.ino, device: stat.dev, configSha256: hash(driver.configFile) }));
  driver.command = async () => ({ stdout: JSON.stringify({ name: definition.machine, dir: driver.instanceDirectory, status: 'Stopped' }) });
  const source = fs.realpathSync(fs.mkdtempSync(path.join(runtimeRoot, 'shared-'))), info = fs.statSync(source);
  const share = { source, target: '/mnt/harness-shares/fixture', mode: 'ro', identity: `${info.dev}:${info.ino}` };
  const options = { ownershipToken: token };
  await driver.configureShares([share], options);
  assert.deepEqual(JSON.parse(fs.readFileSync(driver.configFile)).mounts, [{ location: source, mountPoint: share.target, writable: false }]);
  assert.equal(JSON.parse(fs.readFileSync(driver.configFile)).mountType, 'virtiofs');
  assert((await driver.inspect(options)).configurationValid);
  const owner = JSON.parse(fs.readFileSync(driver.ownerFile));
  // Simulate interruption after config write and before final owner commit.
  fs.writeFileSync(driver.ownerFile, JSON.stringify({ ...owner, configSha256: '0'.repeat(64), pendingConfigSha256: hash(driver.configFile) }));
  assert((await driver.inspect(options)).configurationValid);
  // Start a different update while B is still pending; crash before writing C.
  const rename = fs.renameSync;
  try {
    fs.renameSync = (source, destination) => {
      if (destination === driver.configFile) throw new Error('simulated config write interruption');
      return rename(source, destination);
    };
    await assert.rejects(driver.configureShares([], options), /simulated/);
  } finally { fs.renameSync = rename; }
  assert((await driver.inspect(options)).configurationValid, 'B must remain recognized after reserving C');
  await driver.configureShares([], options);
  assert.equal(JSON.parse(fs.readFileSync(driver.ownerFile)).pendingConfigSha256, undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(driver.configFile)).mounts, []);
  fs.appendFileSync(driver.configFile, '\n');
  await assert.rejects(driver.configureShares([share], options), /configuration changed/);
});

test('a partial smol attach followed by failed stop invalidates the launch until confirmed stop', async t => {
  const runtimeRoot = root(t), definition = environment('wrapvm-v1'), token = randomUUID();
  const driver = new SmolDriver({ definition, runtimeRoot, binary: '/fixture/smolvm' }); driver.verifyRuntime = () => {};
  const source = fs.realpathSync(fs.mkdtempSync(path.join(runtimeRoot, 'share-'))), info = fs.statSync(source);
  driver.getShares = () => [{ source, target: '/mnt/harness-shares/fixture', mode: 'ro', identity: `${info.dev}:${info.ino}` }];
  const record = { name: definition.machine, labels: { owner: definition.owner, identity: token },
    state: 'stopped', pid: 123, network: true, mounts: 0, ports: 0, image: WRAP_IMAGE, restart_policy: 'never',
    allowed_hosts: ['=host.smolvm.internal'], allowed_cidrs: ['192.0.2.1/32'] };
  let stopFails = true, stops = 0;
  driver.command = async args => {
    if (args[1] === 'ls') return { stdout: JSON.stringify([record]) };
    if (args[1] === 'start') { record.state = 'running'; return { stdout: `Mediation machine ID: ${'ab'.repeat(16)}\n` }; }
    if (args[1] === 'mount') throw new Error('attach failed');
    if (args[1] === 'stop') { stops++; if (stopFails) throw new Error('stop failed'); record.state = 'stopped'; }
    return { stdout: '' };
  };
  const network = { healthy: () => true, mediator: { healthy: () => true, activate() {}, revoke() {} } };
  const options = { ownershipToken: token, network };
  await assert.rejects(driver.boot(options), /stop failed/);
  assert.equal((await driver.inspect(options)).protected, false);
  assert(network.healthy(), 'guard remains available until confirmed stop');
  await assert.rejects(driver.boot(options), /Stop the previous/);
  await assert.rejects(driver.exec('true', options), /Protected smolvm launch/);
  assert.equal(stops, 1);
  stopFails = false; await driver.stop(options);
  assert.equal(driver.launch, undefined); assert.equal((await driver.inspect(options)).state, 'stopped');
});

test("socket lease revalidates the launch before forwarding a new client's bytes", async t => {
  const socket = path.join(root(t), "guest.sock");
  let current = true, seen = "";
  const server = net.createServer(client => client.on("data", bytes => { seen += bytes; client.end("ok"); }));
  server.listen(socket); await once(server, "listening");
  t.after(() => server.close());
  const reservation = net.createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const lease = await socketLease({ socket, port, launch: "http://127.0.0.1:3080/?token=fixture",
    assertCurrent: async () => { if (!current) throw new Error("changed launch"); } });
  t.after(() => lease.close());
  const send = value => new Promise(resolve => {
    const client = net.connect(port, "127.0.0.1", () => client.end(value));
    client.on("data", () => {}); client.on("error", () => {}); client.on("close", resolve);
  });
  await send("first"); assert.equal(seen, "first");
  current = false; await send("must-not-forward");
  assert.equal(seen, "first");
  await lease.close();
});

test("interrupted Lima creation recovers only the exact pre-reserved unique configuration", async t => {
  const runtimeRoot = root(t), definition = environment("lima-v1"), token = randomUUID();
  const driver = new LimaDriver({ definition, runtimeRoot, binary: "/fixture/limactl", imageFile: "/fixture/image", provisioner: {
    verifyArtifacts: async () => {}, prepare: async () => {},
  } });
  driver.verifyRuntime = () => {};
  fs.mkdirSync(driver.instanceDirectory);
  const config = JSON.stringify({ env: { HARNESS_ISOLATED_RESOURCE_ID: token }, mounts: [] });
  fs.writeFileSync(driver.configFile, config);
  fs.writeFileSync(driver.reservationFile, JSON.stringify({ owner: definition.owner, ownershipToken: token,
    resourceNonce: token, instanceDirectory: driver.instanceDirectory,
    configSha256: createHash("sha256").update(config).digest("hex") }));
  driver.command = async () => ({ stdout: JSON.stringify({ name: definition.machine,
    dir: driver.instanceDirectory, status: "Stopped" }) });
  driver.boot = async () => {}; // This test covers pre-boot identity recovery only.
  const options = { ownershipToken: token, network: { healthy: () => true } };
  assert.equal((await driver.inspect(options)).reserved, true);
  await driver.prepare(options);
  assert.equal(JSON.parse(fs.readFileSync(driver.ownerFile)).ownershipToken, token);
  assert.equal((await driver.inspect(options)).reserved, false);
  fs.unlinkSync(driver.ownerFile);
  fs.appendFileSync(driver.configFile, "\n"); // Familiar name + different bytes is foreign.
  assert.equal((await driver.inspect(options)).owned, false);
  await assert.rejects(driver.prepare(options), /not owned/);
  fs.writeFileSync(driver.configFile, config);
  assert.equal((await driver.inspect({ ownershipToken: randomUUID() })).owned, false);
});

test('smol UI lease survives closed egress but rejects replacement of the owned launch', async t => {
  const runtimeRoot=root(t), base=environment('wrapvm-v1'), token=randomUUID();
  const reserve=net.createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');
  const controlPort=reserve.address().port;await new Promise(r=>reserve.close(r));
  const definition={...base,controlPort},driver=new SmolDriver({definition,runtimeRoot,binary:'/fixture/smolvm'});
  driver.verifyRuntime=()=>{};
  const record={name:definition.machine,labels:{owner:definition.owner,identity:token},state:'running',pid:123,
    network:true,mounts:0,ports:0,image:WRAP_IMAGE,restart_policy:'never',allowed_hosts:['=host.smolvm.internal'],allowed_cidrs:['192.0.2.1/32']};
  driver.command=async args=>({stdout:args[1]==='ls'?JSON.stringify([record]):'http://127.0.0.1:3080/?token=fixture'});
  let ready=true;driver.launch={pid:123,network:{healthy:()=>ready}};
  let forwarded=0;
  const server=net.createServer(socket=>{socket.on('error',()=>{});socket.on('data',()=>{forwarded++;socket.end('guest-ui')})});
  server.listen(driver.socket);await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));
  const lease=await driver.connect({ownershipToken:token});t.after(()=>lease.close());
  const read=()=>new Promise((resolve,reject)=>{const s=net.connect(controlPort,'127.0.0.1');let data='';s.on('connect',()=>s.write('fixture'));s.on('data',b=>data+=b);s.on('close',()=>resolve(data));s.on('error',reject);s.setTimeout(2000,()=>s.destroy(new Error('timeout')))});
  assert.equal(await read(),'guest-ui');ready=false;
  assert.equal((await driver.inspect({ownershipToken:token})).protected,false);
  assert.equal(await read(),'guest-ui','egress failure does not close the existing owned UI channel');
  record.pid=456;
  assert.equal(await read().catch(error=>{assert.equal(error.code,'ECONNRESET');return ''}),'','a foreign replacement receives no client bytes');
  assert.equal(forwarded,2);
  await lease.close();
});
