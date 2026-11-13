const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { privateDirectory } = require("./iron-ca.cjs");
const { run, streamCommand, runtimePaths, cleanEnvironment, socketLease, launchCommand } = require("./driver-common.cjs");
const { assertIdentity } = require('./folder-shares.cjs');
const { openGuestViewer } = require('./guest-viewer.cjs');

const SMOL_BINARY_SHA256 = "b703eadcd77a18cc5a4187920f239f2aadd5abe97d1eace5f0a8987c847af055";
const WRAP_IMAGE = "local:f4143564dbe143660989d7f919ec99a1be92258d95d73d99020b855a742dd566";

// Fixed stock desktop endpoint; neither the client nor openViewer options can
// choose a guest command, port, or host resource. No PTY or login shell.
const VIEWER_RELAY = `exec "$HOME/.harness-isolated/node/bin/node" -e 'const net = require("node:net"); const socket = net.connect(6080, "127.0.0.1"); process.stdin.pause(); socket.on("connect", () => { process.stdin.pipe(socket); socket.pipe(process.stdout); process.stdin.resume(); }); socket.on("error", () => { process.exitCode = 1; }); socket.on("close", () => { process.stdin.destroy(); process.stdout.end(); }); process.stdin.on("error", () => socket.destroy()); process.stdout.on("error", () => { process.exitCode = 1; socket.destroy(); });'`;
const VIEWER_FOCUS = "DISPLAY=:1 exec xdotool search --onlyvisible --limit 1 --class '^Google-chrome$' windowactivate --sync";
const VIEWER_FOCUS_CHROMIUM = "DISPLAY=:1 exec xdotool search --onlyvisible --limit 1 --class '^[Cc]hromium$' windowactivate --sync";

function configurationValid(record, expectedImage = WRAP_IMAGE) {
  return record.network === true && record.mounts === 0 && record.ports === 0 &&
    record.image === expectedImage && record.restart_policy === "never" &&
    !record.parent_machine && !record.ephemeral &&
    JSON.stringify(record.allowed_hosts) === '["=host.smolvm.internal"]' &&
    JSON.stringify(record.allowed_cidrs) === '["192.0.2.1/32"]';
}

class SmolDriver {
  constructor({ definition, runtimeRoot, binary, imageArchive, provisioner,
    imageSha256 = WRAP_IMAGE.slice(6), rosetta = false }) {
    if (definition.kind !== "smolvm") throw new Error("Incorrect engine.");
    if (!/^[a-f0-9]{64}$/.test(imageSha256) || typeof rosetta !== 'boolean') throw new Error('Invalid desktop artifact configuration.');
    this.imageSha256 = imageSha256; this.expectedImage = `local:${imageSha256}`; this.rosetta = rosetta;
    this.definition = definition; this.binary = binary; this.imageArchive = imageArchive;
    this.provisioner = provisioner;
    const paths = runtimePaths(runtimeRoot, definition.id);
    this.socket = paths.socket;
    // --state-dir/SMOLVM_DATA_DIR is Linux-only in stock 1.34.1. A private HOME
    // is the supported dirs-based boundary on macOS; no personal registry config.
    this.home = path.join(runtimeRoot, "s"); privateDirectory(this.home);
    this.env = cleanEnvironment(this.home);
    this.launch = undefined;
  }

  verifyRuntime() {
    const file = path.join(path.dirname(this.binary), "smolvm-bin");
    const stat = fs.statSync(file), signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    if (this.verifiedRuntime === signature) return;
    if (createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== SMOL_BINARY_SHA256)
      throw new Error("The smolvm runtime differs from the verified version.");
    this.verifiedRuntime = signature;
  }

  command(args, options = {}) { return run(this.binary, args, { ...options, env: { ...this.env, ...options.env } }); }

  async inspect({ ownershipToken, signal } = {}) {
    this.verifyRuntime();
    const { stdout } = await this.command(["machine", "ls", "--json"], { signal });
    const records = JSON.parse(stdout);
    if (!Array.isArray(records)) throw new Error("Invalid smolvm inventory.");
    const record = records.find(item => item.name === this.definition.machine);
    if (!record) return { state: "missing", owned: false, protected: false };
    const owned = Boolean(ownershipToken && record.labels?.owner === this.definition.owner &&
      record.labels?.identity === ownershipToken);
    return { state: record.state, owned, configurationValid: configurationValid(record, this.expectedImage),
      resources:{cpus:record.cpus,memoryMiB:record.memory_mib,diskGiB:record.storage_gb??20,overlayGiB:record.overlay_gb??10},
      protected: Boolean(owned && configurationValid(record, this.expectedImage) && record.state === "running" &&
        this.launch && this.launch.pid === record.pid && !this.launch.invalid && this.launch.network.healthy()), pid: record.pid };
  }

  async requireOwned(options, { protectedLaunch = false, validate = true } = {}) {
    const observed = await this.inspect(options);
    if (!observed.owned) throw new Error("The smolvm resource is not owned by this app.");
    if (validate && !observed.configurationValid) throw new Error("The smolvm configuration does not match the required settings.");
    if (protectedLaunch && !observed.protected) throw new Error("Protected smolvm launch could not be confirmed.");
    return observed;
  }

  async verifyRetainedLaunch({ network, ...options }) {
    const expected = this.launch;
    const observed = await this.requireOwned(options);
    if (!expected || this.launch !== expected || expected.invalid ||
        expected.network !== network || observed.state !== "running" || observed.pid !== expected.pid)
      throw new Error("The owned launch cannot be recovered in place.");
  }

  async prepare(options) {
    if (!this.provisioner?.prepare) throw new Error("The guest bundle is unavailable.");
    if (!options.network?.healthy() || !options.network.mediator?.healthy()) throw new Error("The mediated network is not ready.");
    const observed = await this.inspect(options);
    if (observed.state === "missing") {
      if (!/^[a-f0-9-]{36}$/.test(options.ownershipToken ?? "")) throw new Error("Invalid environment identity.");
      await this.provisioner.verifyArtifacts({ signal: options.signal });
      if (this.rosetta && !fs.existsSync('/Library/Apple/usr/libexec/oah/RosettaLinux/rosetta'))
        throw new Error('Rosetta Linux is required for the stock desktop image.');
      const hash = createHash('sha256');
      for await (const chunk of fs.createReadStream(this.imageArchive, { signal: options.signal })) hash.update(chunk);
      if (hash.digest('hex') !== this.imageSha256) throw new Error('Desktop image digest mismatch.');
      const resources=this.getResources?.()??{cpus:2,memoryMiB:4096};
      await this.command(["machine", "create", "--name", this.definition.machine,
        "--label", `owner=${this.definition.owner}`, "--label", `identity=${options.ownershipToken}`,
        "--image", this.imageArchive, ...(this.rosetta ? ['--rosetta'] : []), "--cpus", String(resources.cpus), "--mem", String(resources.memoryMiB), "--storage", String(resources.diskGiB??20), "--overlay", String(resources.overlayGiB??10),
        "--net", "--net-backend", "virtio-net", "--allow-host-pattern", "host.smolvm.internal",
        "--allow-cidr", "192.0.2.1/32", "--user", "user", "--workdir", "/home/user/workspace",
        "--expose-socket", `/home/user/.harness-isolated/harness.sock:${this.socket}`],
      { signal: options.signal, timeout: 600000 });
    }
    await this.boot(options);
    await this.provisioner.prepare(this, options);
  }

  async boot(options) {
    const observed = await this.requireOwned(options);
    if (!options.network?.healthy() || !options.network.mediator?.healthy()) throw new Error("The mediated network is not ready.");
    if (observed.state === "running") {
      if (!observed.protected || this.launch.network !== options.network) throw new Error("Stop the previous launch before recovery.");
      return;
    }
    if (!["created", "stopped"].includes(observed.state)) throw new Error("smolvm cannot start in its current state.");
    if(this.getResources){
      const resources=this.getResources();
      const diskGiB=resources.diskGiB??20,overlayGiB=resources.overlayGiB??10;
      if(diskGiB<observed.resources.diskGiB||overlayGiB<observed.resources.overlayGiB)throw new Error('Disk capacity cannot shrink.');
      if(observed.resources.cpus!==resources.cpus || observed.resources.memoryMiB!==resources.memoryMiB||observed.resources.diskGiB!==diskGiB||observed.resources.overlayGiB!==overlayGiB){
        await this.command(['machine','update','--name',this.definition.machine,'--cpus',String(resources.cpus),'--mem',String(resources.memoryMiB),'--storage',String(diskGiB),'--overlay',String(overlayGiB)],{signal:options.signal});
        const configured=await this.requireOwned(options);
        if(!['created','stopped'].includes(configured.state)||configured.resources.cpus!==resources.cpus||configured.resources.memoryMiB!==resources.memoryMiB||configured.resources.diskGiB!==diskGiB||configured.resources.overlayGiB!==overlayGiB)
          throw new Error('Updated VM resources were not confirmed.');
      }
    }
    const shares = this.getShares?.() ?? [];
    const mediator = options.network.mediator;
    const result = await this.command(["machine", "start", "--name", this.definition.machine,
      "--mediated-egress", "--egress-interceptor", mediator.address], {
      signal: options.signal, timeout: 180000, env: { SMOLVM_INTERCEPTOR_TOKEN: mediator.token },
    });
    const matches = [...result.stdout.matchAll(/^Mediation machine ID: ([a-f0-9]{32})\s*$/gm)];
    if (matches.length !== 1) throw new Error("The mediated launch identity could not be confirmed.");
    const running = await this.requireOwned(options);
    if (running.state !== "running" || !Number.isInteger(running.pid)) throw new Error("smolvm startup could not be confirmed.");
    mediator.activate(matches[0][1]);
    this.launch = { pid: running.pid, network: options.network };
    try {
      for (const share of shares) {
        assertIdentity(share);
        await this.requireOwned(options, { protectedLaunch: true });
        await this.command(['machine', 'mount', 'add', '-n', this.definition.machine,
          '-v', `${share.source}:${share.target}:${share.mode}`], { signal: options.signal, timeout: 30000 });
      }
    } catch (error) {
      // Partial attach never becomes a successful or reusable start. Full stop
      // revokes devices even if a compromised guest refuses ordinary unmount.
      this.launch.invalid = true;
      await this.stop({ ...options, signal: AbortSignal.timeout(60000) });
      throw error;
    }
  }

  async start(options) { await this.boot(options); await this.provisioner.start(this, options); }

  async stop(options) {
    const observed = await this.requireOwned(options, { validate: false });
    if (observed.state === "running") await this.command(["machine", "stop", "--name", this.definition.machine],
      { signal: options.signal, timeout: 60000 });
    const stopped = await this.requireOwned(options, { validate: false });
    if (!["created", "stopped"].includes(stopped.state)) throw new Error("smolvm shutdown could not be confirmed.");
    this.launch?.network.mediator.revoke(); this.launch = undefined;
  }

  async remove({ ownershipToken, signal } = {}) {
    const options = { ownershipToken, signal };
    signal?.throwIfAborted();
    const observed = await this.inspect(options);
    signal?.throwIfAborted();
    if (observed.state !== 'missing') {
      if (!observed.owned) throw new Error('The smolvm resource is not owned by this app.');
      if (!observed.configurationValid) throw new Error('The smolvm configuration does not match the required settings.');
      if (!['created', 'stopped'].includes(observed.state)) throw new Error('Stop smolvm before removing the environment.');
      // Stock 1.34.1 --force skips confirmation; it is not a stopped-only
      // guard. The caller must serialize lifecycle operations: stock delete
      // has no ownership-token/CAS or refuse-running option. Never --cascade.
      await this.command(['machine', 'delete', '--name', this.definition.machine, '--force'], { signal, timeout: 60000 });
      signal?.throwIfAborted();
      const after = await this.inspect(options);
      signal?.throwIfAborted();
      if (after.state !== 'missing') throw new Error('smolvm removal could not be confirmed.');
    }
    this.launch?.network.mediator.revoke(); this.launch = undefined;
    return { state: 'missing', removed: observed.state !== 'missing' };
  }

  async exec(script, options, { root = false, detach = false } = {}) {
    await this.requireOwned(options, { protectedLaunch: true });
    return (await this.command(["machine", "exec", "--name", this.definition.machine,
      "--user", root ? "root" : "user", ...(detach ? ["--detach"] : []), "--", "/bin/sh", "-c", script],
    { signal: options.signal, timeout: 180000 })).stdout;
  }

  async putFile(source, destination, options, { mode = "600", root = false } = {}) {
    await this.requireOwned(options, { protectedLaunch: true });
    if (!destination.startsWith("/") || destination.includes("\0")) throw new Error("Invalid guest destination.");
    await this.command(["machine", "cp", "--uid", root ? "0" : "1000", "--gid", root ? "0" : "1000",
      "--mode", mode, source, `${this.definition.machine}:${destination}`], { signal: options.signal, timeout: 600000 });
  }

  async fileChannel(script, options) {
    await this.requireOwned(options, { protectedLaunch: true });
    return streamCommand(this.binary, ["machine", "exec", "--name", this.definition.machine,
      "--user", "user", "--interactive", "--stream", "--", "/bin/sh", "-c", script],
    { env: this.env, signal: options.signal });
  }

  // Main-process capability only: callers must keep the password in memory and
  // inject auth only for this exact origin through a dedicated browser session.
  async openViewer({ network, ownershipToken, signal } = {}) {
    const expected = this.launch;
    if (!network || typeof network !== 'object' || !expected || expected.network !== network)
      throw new Error('The guest desktop viewer is unavailable.');
    const assertCurrent = async signal => {
      if (this.launch !== expected) throw new Error('The smolvm launch was replaced.');
      await this.verifyRetainedLaunch({ network, ownershipToken, signal });
      if (this.launch !== expected) throw new Error('The smolvm launch was replaced.');
    };
    const args = ['machine', 'exec', '--name', this.definition.machine, '--user', 'user'];
    return openGuestViewer({ signal, assertCurrent,
      passwordChannel: signal => streamCommand(this.binary,
        [...args, '--', '/opt/wrap/bin/wrap-desktop', 'password'],
        { env: this.env, signal, timeout: 5000 }),
      openChannel: signal => streamCommand(this.binary,
        [...args, '--interactive', '--stream', '--', '/bin/sh', '-c', VIEWER_RELAY],
        { env: this.env, signal, timeout: 0 }),
      focus: signal => this.command([...args, '--', '/bin/sh', '-c', this.definition.imageId === 'local-arm64' ? VIEWER_FOCUS_CHROMIUM : VIEWER_FOCUS],
        { signal, timeout: 10000 }),
    });
  }

  async connect(options) {
    await this.requireOwned(options, { protectedLaunch: true });
    const expectedLaunch = this.launch;
    const launch = await this.exec(launchCommand, options);
    const assertCurrent = async () => {
      // The UI control channel remains useful while egress is closed. It is
      // still bound to the exact owned, validated launch; network availability
      // must not turn a policy revocation into loss of VM control.
      const observed = await this.requireOwned(options);
      if (this.launch !== expectedLaunch || expectedLaunch.invalid ||
          observed.state !== 'running' || observed.pid !== expectedLaunch.pid)
        throw new Error("The smolvm launch was replaced.");
    };
    const lease = await socketLease({ socket: this.socket, port: this.definition.controlPort,
      launch, signal: options.signal, assertCurrent });
    try { await this.requireOwned(options, { protectedLaunch: true }); return lease; }
    catch (error) { await lease.close(); throw error; }
  }
}

module.exports = { SmolDriver, configurationValid, SMOL_BINARY_SHA256, WRAP_IMAGE };
