const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const net = require("node:net");
const { once } = require("node:events");
const { Network } = require("../src/runtime/network.cjs");
const binary = path.resolve(__dirname, "../vendor/m0/iron-bin/iron-proxy");
const stockAvailable = process.platform === "darwin" && process.arch === "arm64" && fs.existsSync(binary);

function request(port, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method,
      path: method === "CONNECT" ? "example.invalid:443" : "http://example.invalid/deny",
      headers: { Host: "example.invalid" } });
    req.on("error", reject); req.setTimeout(3000, () => req.destroy(new Error("timeout")));
    req.on("response", res => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("connect", (res, socket) => { socket.destroy(); resolve(res.statusCode); });
    req.end();
  });
}

test("real stock Iron guard denies HTTP and CONNECT, persists host CA, and releases listeners", { skip: !stockAvailable }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "isolated-network-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const reservation = net.createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const manager = new Network({ stateRoot: root, ironBinary: binary });
  const definition = { id: "fixture-v1", kind: "smolvm", proxyPort: port };
  let guard;
  t.after(async () => guard?.close());
  guard = await manager.open(definition);
  assert(guard.healthy()); assert(guard.mediator.healthy());
  assert.equal(await request(port), 403); assert.equal(await request(port, "CONNECT"), 403);
  assert.equal(guard.keyFile, undefined);
  const ca = fs.readFileSync(guard.caFile, "utf8");
  const configFile = path.join(root, "network", definition.id, "iron.json");
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  assert.equal(config.proxy.upstream_deny_cidrs, undefined);
  assert.equal(config.tls.mode, "mitm"); assert.equal(config.dns.enabled, false);
  assert.equal(fs.statSync(config.tls.ca_key).mode & 0o777, 0o600);
  assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);
  await assert.rejects(manager.open(definition), /already managed/);
  const another = new Network({ stateRoot: path.join(root, "other"), ironBinary: binary });
  await assert.rejects(another.open(definition), /already in use/);
  await guard.close(); assert(!guard.healthy());
  await assert.rejects(request(port));
  guard = await manager.open(definition);
  assert.equal(fs.readFileSync(guard.caFile, "utf8"), ca);
  assert.equal(await request(port), 403);
  await guard.close();
  const starting = manager.open(definition);
  starting.catch(() => {});
  await manager.quarantine(definition.id);
  await assert.rejects(starting);
  assert(!manager.active.has(definition.id));
  // A revoked in-flight start cannot leave a late Iron listener behind.
  guard = await manager.open(definition);
  assert(guard.healthy());
  await guard.close();
});

test('stock proxy crash stays closed and explicit recovery retains the VM mediation endpoint', {skip:!stockAvailable}, async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'isolated-proxy-recover-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const reservation=net.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
  const port=reservation.address().port;await new Promise(r=>reservation.close(r));
  let failed;const fault=new Promise(resolve=>failed=resolve);
  const network=new Network({stateRoot:root,ironBinary:binary,onFault:(_id,reason,phase)=>{if(reason==='proxy-exited'&&phase==='offline')failed()}});
  const controller=new AbortController();
  const guard=await network.open({id:'fixture-v1',kind:'smolvm',proxyPort:port},{signal:controller.signal});t.after(()=>guard.close());
  guard.mediator.activate('ab'.repeat(16));const endpoint=guard.mediator.address,token=guard.mediator.token;
  // Only the Iron fixture bound to this freshly reserved port is terminated.
  const pidText=require('node:child_process').execFileSync('/usr/sbin/lsof',['-t','-nP',`-iTCP:${port}`,'-sTCP:LISTEN'],{encoding:'utf8'}).trim();
  assert.match(pidText,/^\d+$/);process.kill(Number(pidText),'SIGKILL');
  await Promise.race([fault,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Missing proxy failure')),3000);timer.unref()})]);
  assert(!guard.healthy());assert.equal(guard.status().reason,'proxy-exited');
  await assert.rejects(request(port));
  // A saved-rule expiry/revocation must not turn a crash into automatic retry.
  await network.quarantine('fixture-v1');
  assert(!guard.healthy()); assert.equal(guard.status().reason,'proxy-exited');
  await assert.rejects(request(port));
  // Ending the original Connect operation must not poison later network repair.
  controller.abort();await network.restore('fixture-v1');
  assert(guard.healthy());assert.equal(guard.mediator.address,endpoint);assert.equal(guard.mediator.token,token);
  assert.equal(await request(port),403);
  const changes=JSON.parse(fs.readFileSync(path.join(root,'network/fixture-v1/status.json'))).transitions;
  assert(changes.some(x=>x.reason==='proxy-exited'&&x.phase==='offline'));
  assert.equal(changes.at(-1).reason,'user-retry');
  // Final identity validation runs before any mediator/callback is resumed.
  let entered;
  const started=new Promise(resolve=>entered=resolve);
  let finishValidation;
  const validation=new Promise(resolve=>finishValidation=resolve);
  const recovering=network.restore('fixture-v1',{validate:async()=>{
    assert(!guard.healthy());assert(!guard.mediator.healthy());entered();await validation;
    throw Error('replacement launch');
  }});
  const rejected=assert.rejects(recovering,/replacement launch/);
  await started;assert.equal(await request(port),503);finishValidation();await rejected;
  assert.equal(guard.status().reason,'recovery-failed');assert(!guard.mediator.healthy());
  await network.quarantine('fixture-v1');assert(!guard.healthy());await assert.rejects(request(port));
  // A reconnect joining a pending policy reset must validate before resume too.
  const policyReset=network.quarantine('fixture-v1');await policyReset; // latched no-op
  await network.restore('fixture-v1');
  let checked=false;const cancelled=new AbortController();
  const policyChange=network.quarantine('fixture-v1');
  const joined=network.restore('fixture-v1',{validate:()=>{checked=true;assert(!guard.mediator.healthy());cancelled.abort(Error('cancelled recovery'));cancelled.signal.throwIfAborted()}});
  await assert.rejects(joined,/cancelled recovery/);await assert.rejects(policyChange,/cancelled recovery/);
  assert(checked);assert(!guard.healthy());
  await network.restore('fixture-v1');
  const reset=network.quarantine('fixture-v1');const closing=guard.close();await Promise.allSettled([reset,closing]);
  assert(!guard.healthy());await assert.rejects(request(port));assert(!network.active.has('fixture-v1'));
});


test('directory setup failure releases the reservation for a later attempt', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'network-directory-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'network'),'blocked directory');
  const manager=new Network({stateRoot:root,ironBinary:path.join(root,'absent-binary')});
  const definition={id:'fixture-v1',kind:'smolvm',proxyPort:39491};
  await assert.rejects(manager.open(definition));
  assert(!manager.active.has(definition.id));assert(!manager.closers.has(definition.id));
  fs.unlinkSync(path.join(root,'network'));
  await assert.rejects(manager.open(definition), error=>error.code==='ENOENT');
  assert(fs.statSync(path.join(root,'network',definition.id)).isDirectory());
  assert(!manager.active.has(definition.id));
});
