const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");
const { once } = require("node:events");
const { limaProfile } = require("../src/runtime/lima-profile.cjs");
const run = promisify(execFile);

test("rejects malformed paths and port configuration before generating a profile", () => {
  const valid = { instanceDirectory: "/tmp/isolated-v1", sshPort: 43984, proxyPort: 43982 };
  for (const bad of [{ instanceDirectory: "relative" }, { instanceDirectory: "/tmp/../etc" }, { instanceDirectory: "/tmp/\n(allow network*)" }, { proxyPort: 22 }, { sshPort: 43982 }, { credentialPort: 43982 }, { credentialPort: 22 }])
    assert.throws(() => limaProfile({ ...valid, ...bad }));
});

test("generated stock macOS profile permits only the selected host TCP listener", { skip: process.platform !== "darwin" }, async t => {
  let allowedHits = 0, forbiddenHits = 0, credentialHits = 0;
  const credential = net.createServer(s => { credentialHits++; s.end("credential"); });
  credential.listen(0, "127.0.0.1"); await once(credential, "listening");
  t.after(() => new Promise(r => credential.close(r)));
  const allowed = net.createServer(s => { allowedHits++; s.end("allowed"); });
  const forbidden = net.createServer(s => { forbiddenHits++; s.end("forbidden"); });
  allowed.listen(0, "127.0.0.1"); forbidden.listen(0, "127.0.0.1");
  await Promise.all([once(allowed, "listening"), once(forbidden, "listening")]);
  t.after(async () => { await Promise.all([new Promise(r => allowed.close(r)), new Promise(r => forbidden.close(r))]); });
  // Select a distinct unused SSH port without touching any VM.
  const probe = net.createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const sshPort = probe.address().port; await new Promise(r => probe.close(r));
  const profile = limaProfile({ instanceDirectory: '/tmp/profile-test-"quoted"', sshPort, proxyPort: allowed.address().port, credentialPort: credential.address().port });
  const code = `const s=require('net').connect(Number(process.argv[1]),'127.0.0.1');s.setTimeout(1000,()=>{s.destroy();process.exitCode=2;});s.on('data',d=>process.stdout.write(d));s.on('error',()=>{process.exitCode=3;});`;
  const result = await run("/usr/bin/sandbox-exec", ["-p", profile, process.execPath, "-e", code, String(allowed.address().port)], { timeout: 5000 });
  assert.equal(result.stdout, "allowed");
  await assert.rejects(run("/usr/bin/sandbox-exec", ["-p", profile, process.execPath, "-e", code, String(forbidden.address().port)], { timeout: 5000 }));
  const bridged = await run("/usr/bin/sandbox-exec", ["-p", profile, process.execPath, "-e", code, String(credential.address().port)], { timeout: 5000 });
  assert.equal(bridged.stdout, "credential"); assert.equal(credentialHits, 1);
  assert.equal(allowedHits, 1); assert.equal(forbiddenHits, 0);
});
