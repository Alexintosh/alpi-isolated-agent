const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { privateDirectory } = require("./iron-ca.cjs");
const { writeJson, readJson } = require("./atomic-json.cjs");
const { limaProfile } = require("./lima-profile.cjs");
const { startOwnedProcess } = require("./owned-process.cjs");
const { parseLaunch, assertFreePort } = require("../engines/common.cjs");
const { run, streamCommand, runtimePaths, cleanEnvironment, launchCommand } = require("./driver-common.cjs");
const { assertIdentity } = require('./folder-shares.cjs');

const LIMA_SHA256 = "8d07e22c4f9616ff86aed8e509268d24e2d5f073a6d2bbe6024f3b17b1c4c5d6";
const UBUNTU_SHA256 = "50e24e1fb79e89116e939d90aa7738f7af48c442fa1bc2510131e0b39c50348e";
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

class LimaDriver {
  constructor({ definition, runtimeRoot, binary, imageFile, provisioner, guestAgent }) {
    if (definition.kind !== "lima") throw new Error("Incorrect engine.");
    this.definition = definition; this.binary = binary; this.imageFile = imageFile;
    this.provisioner = provisioner;
    this.guestAgent=guestAgent;
    this.paths = runtimePaths(runtimeRoot, definition.id);
    this.home = path.join(runtimeRoot, "lhome"); privateDirectory(this.home);
    this.limaHome = path.join(runtimeRoot, "l"); privateDirectory(this.limaHome);
    this.instanceDirectory = path.join(this.limaHome, definition.machine);
    if (Buffer.byteLength(path.join(this.instanceDirectory, "guestagent.sock")) >= 104)
      throw new Error("The Lima path is too long.");
    this.env = cleanEnvironment(this.home, { LIMA_HOME: this.limaHome });
    this.ownerFile = path.join(this.instanceDirectory, ".isolated-owner.json");
    this.configFile = path.join(this.instanceDirectory, "lima.yaml");
    this.reservationFile = path.join(this.paths.directory, "creation.json");
    this.launch = undefined;
  }

  verifyRuntime() {
    const files=[this.binary,...(this.guestAgent?[this.guestAgent]:[])];
    const signature=files.map(file=>{const s=fs.statSync(file);return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;}).join('|');
    if(signature===this.verifiedRuntime)return;
    if (hash(this.binary) !== LIMA_SHA256) throw new Error("The Lima runtime differs from the verified version.");
    if(this.guestAgent && hash(this.guestAgent)!==require('./lima-artifacts.cjs').files[1].sha256)
      throw new Error('Packaged Lima guest agent differs from the pinned artifact.');
    this.verifiedRuntime=signature;
  }
  command(args, options = {}) { return run(this.binary, args, { ...options, env: this.env }); }

  async inspect({ ownershipToken, signal } = {}) {
    this.verifyRuntime();
    const { stdout } = await this.command(["list", "--json"], { signal });
    const records = stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    const record = records.find(item => item.name === this.definition.machine);
    if (!record) {
      // lstat also detects a dangling symlink; existsSync would call it missing.
      let directory;
      try { directory = fs.lstatSync(this.instanceDirectory); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (directory) throw new Error("The existing Lima directory is not recognized.");
      return { state: "missing", owned: false, protected: false };
    }
    const directory = fs.lstatSync(this.instanceDirectory);
    const owner = readJson(this.ownerFile, null);
    const configStat = fs.lstatSync(this.configFile);
    const regularConfig = configStat.isFile() && !configStat.isSymbolicLink();
    const configHash = regularConfig ? hash(this.configFile) : undefined;
    const reservation = readJson(this.reservationFile, null);
    // Recovery applies only to the exact unique configuration reserved before
    // create. Never infer ownership from a familiar name or generic template.
    const reserved = !owner && regularConfig && ownershipToken && reservation?.ownershipToken === ownershipToken &&
      /^[a-f0-9]{64}$/.test(reservation.configSha256 ?? "") &&
      reservation.owner === this.definition.owner && reservation.instanceDirectory === this.instanceDirectory &&
      reservation.configSha256 === configHash && reservation.resourceNonce === ownershipToken &&
      JSON.parse(fs.readFileSync(this.configFile, "utf8")).env?.HARNESS_ISOLATED_RESOURCE_ID === ownershipToken;
    const marked = owner?.ownershipToken === ownershipToken &&
      owner.owner === this.definition.owner && owner.inode === directory.ino && owner.device === directory.dev &&
      ownershipToken;
    const owned = Boolean((marked || reserved) && directory.isDirectory() && !directory.isSymbolicLink() && record.dir === this.instanceDirectory);
    const configurationValid = owned && regularConfig && (configHash === (owner?.configSha256 ?? reservation.configSha256) ||
      /^[a-f0-9]{64}$/.test(owner?.pendingConfigSha256 ?? '') && configHash === owner.pendingConfigSha256);
    return { state: String(record.status).toLowerCase(), owned, configurationValid,
      resources:configurationValid?{diskGiB:Number(/^(\d+)GiB$/.exec(require('js-yaml').load(fs.readFileSync(this.configFile,'utf8'))?.disk)?.[1])}:undefined,
      reserved: Boolean(reserved),
      pid: record.hostAgentPID,
      protected: Boolean(configurationValid && record.status === "Running" &&
        this.launch && this.launch.pid === record.hostAgentPID && this.launch.network.healthy()) };
  }

  async requireOwned(options, { protectedLaunch = false, validate = true } = {}) {
    const observed = await this.inspect(options);
    if (!observed.owned) throw new Error("The Lima resource is not owned by this app.");
    if (validate && !observed.configurationValid) throw new Error("The Lima configuration changed. Recovery is required.");
    if (protectedLaunch && !observed.protected) throw new Error("Protected Lima launch could not be confirmed.");
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
    if (!options.network?.healthy()) throw new Error("The host network is not ready.");
    const observed = await this.inspect(options);
    if (observed.state === "missing") {
      if (!/^[a-f0-9-]{36}$/.test(options.ownershipToken ?? "")) throw new Error("Invalid environment identity.");
      await this.provisioner.verifyArtifacts({ signal: options.signal });
      if (hash(this.imageFile) !== UBUNTU_SHA256) throw new Error("The Ubuntu image could not be verified.");
      const config = path.join(this.paths.directory, "create.yaml");
      const resources=this.getResources?.()??{cpus:2,memoryMiB:4096};
      writeJson(config, {
        minimumLimaVersion: "1.0.0", vmType: "vz", arch: "aarch64", cpus: resources.cpus, memory: `${resources.memoryMiB}MiB`, disk: `${resources.diskGiB??20}GiB`,
        images: [{ location: this.imageFile, arch: "aarch64", digest: `sha256:${UBUNTU_SHA256}` }],
        mounts: [], networks: [], containerd: { system: false, user: false },
        ssh: { localPort: this.definition.sshPort, forwardAgent: false, loadDotSSHPubKeys: false,
          forwardX11: false, forwardX11Trusted: false },
        portForwards: [{ guestPortRange: [1, 65535], ignore: true }],
        propagateProxyEnv: false, upgradePackages: false,
        env: { HARNESS_ISOLATED_RESOURCE_ID: options.ownershipToken },
        user: { name: "user", uid: 1000, home: "/home/user", shell: "/bin/bash", comment: "Harness Isolated" },
      });
      writeJson(this.reservationFile, { owner: this.definition.owner, ownershipToken: options.ownershipToken,
        resourceNonce: options.ownershipToken, instanceDirectory: this.instanceDirectory, configSha256: hash(config) });
      await this.command(["create", `--name=${this.definition.machine}`, "--tty=false", config],
        { signal: options.signal, timeout: 180000 });
    }
    const created = await this.requireOwned(options);
    if (created.reserved) {
      const directory = fs.lstatSync(this.instanceDirectory);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Invalid Lima directory.");
      writeJson(this.ownerFile, { owner: this.definition.owner, ownershipToken: options.ownershipToken,
        inode: directory.ino, device: directory.dev, configSha256: hash(this.configFile) });
    }
    await this.boot(options);
    await this.provisioner.prepare(this, options);
  }

  async boot(options) {
    const observed = await this.requireOwned(options);
    if (!options.network?.healthy()) throw new Error("The host network is not ready.");
    if (observed.state === "running") {
      if (!observed.protected || this.launch.network !== options.network) throw new Error("Stop the previous launch before recovery.");
      return;
    }
    if (observed.state !== "stopped") throw new Error("Lima cannot start in its current state.");
    const shares = this.getShares?.() ?? [];
    await this.configureShares(shares, options);
    for (const share of shares) assertIdentity(share);
    const profile = path.join(this.paths.directory, "network.sb");
    fs.writeFileSync(profile, limaProfile({ instanceDirectory: this.instanceDirectory,
      sshPort: this.definition.sshPort, proxyPort: options.network.proxyPort, credentialPort: options.network.bridge?.port }), { mode: 0o600 });
    await run("/usr/bin/sandbox-exec", ["-f", profile, this.binary, "start", "--tty=false", this.definition.machine],
      { env: this.env, signal: options.signal, timeout: 180000 });
    const running = await this.requireOwned(options);
    if (running.state !== "running" || !Number.isInteger(running.pid)) throw new Error("Lima startup could not be confirmed.");
    this.launch = { pid: running.pid, network: options.network };
  }

  async configureShares(shares, options) {
    const observed = await this.requireOwned(options);
    if (observed.state !== 'stopped') throw new Error('Stop Lima before changing folder shares.');
    for (const share of shares) assertIdentity(share);
    const config = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
    if(this.getResources){const resources=this.getResources();
      if(config.disk!==`${resources.diskGiB??20}GiB`)throw new Error('Existing Lima disk capacity differs from the selected settings. No disk resize was attempted.');
      config.cpus=resources.cpus;config.memory=`${resources.memoryMiB}MiB`;}
    config.mountType = 'virtiofs';
    config.mounts = shares.map(share => ({ location: share.source, mountPoint: share.target, writable: share.mode === 'rw' }));
    const serialized = JSON.stringify(config, null, 2) + '\n';
    const nextHash = createHash('sha256').update(serialized).digest('hex');
    const owner = readJson(this.ownerFile, null);
    if (!owner || owner.ownershipToken !== options.ownershipToken) throw new Error('The Lima ownership marker is unavailable.');
    // Reserve both legitimate hashes before replacing the config. Recovery may
    // finish either side of an interrupted update, never accept arbitrary YAML.
    writeJson(this.ownerFile, { ...owner, configSha256: hash(this.configFile), pendingConfigSha256: nextHash });
    writeJson(this.configFile, config);
    const { pendingConfigSha256, ...committed } = owner;
    writeJson(this.ownerFile, { ...committed, configSha256: nextHash });
  }

  async start(options) { await this.boot(options); await this.provisioner.start(this, options); }

  async stop(options) {
    const observed = await this.requireOwned(options, { validate: false });
    if (observed.state === "running") await this.command(["stop", this.definition.machine], { signal: options.signal, timeout: 60000 });
    const stopped = await this.requireOwned(options, { validate: false });
    if (stopped.state !== "stopped") throw new Error("Lima shutdown could not be confirmed.");
    this.launch = undefined;
  }

  async remove({ ownershipToken, signal } = {}) {
    const options = { ownershipToken, signal };
    signal?.throwIfAborted();
    const observed = await this.inspect(options);
    signal?.throwIfAborted();
    if (observed.state !== 'missing') {
      if (!observed.owned) throw new Error('The Lima resource is not owned by this app.');
      if (!observed.configurationValid) throw new Error('The Lima configuration changed. Recovery is required.');
      if (observed.state !== 'stopped') throw new Error('Stop Lima before removing the environment.');
      // Stock 1.0.7 independently requires Stopped without --force. Limit the
      // command to this fixed instance in our private LIMA_HOME; no disk/cache prune.
      await this.command(['delete', '--tty=false', this.definition.machine], { signal, timeout: 60000 });
      signal?.throwIfAborted();
      const after = await this.inspect(options);
      signal?.throwIfAborted();
      if (after.state !== 'missing') throw new Error('Lima removal could not be confirmed.');
    }
    this.clearCreationReservation(ownershipToken);
    this.launch = undefined;
    return { state: 'missing', removed: observed.state !== 'missing' };
  }

  clearCreationReservation(ownershipToken) {
    // Only retire our exact, fixed reservation file after confirmed absence.
    // Never traverse a path recorded in its contents or follow a symlink.
    let fd;
    try { fd = fs.openSync(this.reservationFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw new Error('Invalid Lima creation reservation.');
      const reservation = JSON.parse(fs.readFileSync(fd, 'utf8'));
      if (!ownershipToken || reservation?.ownershipToken !== ownershipToken ||
          reservation.owner !== this.definition.owner || reservation.resourceNonce !== ownershipToken ||
          reservation.instanceDirectory !== this.instanceDirectory ||
          !/^[a-f0-9]{64}$/.test(reservation.configSha256 ?? '')) return;
      const current = fs.lstatSync(this.reservationFile);
      if (!current.isFile() || current.isSymbolicLink() || current.ino !== stat.ino || current.dev !== stat.dev ||
          current.size !== stat.size || current.mtimeMs !== stat.mtimeMs || current.ctimeMs !== stat.ctimeMs)
        throw new Error('The Lima creation reservation changed during removal.');
      fs.unlinkSync(this.reservationFile);
    } finally { fs.closeSync(fd); }
  }

  async exec(script, options, { root = false } = {}) {
    await this.requireOwned(options, { protectedLaunch: true });
    return (await this.command(["shell", "--workdir=/tmp", this.definition.machine,
      ...(root ? ["sudo", "-n"] : []), "/bin/sh", "-c", script], { signal: options.signal, timeout: 180000 })).stdout;
  }

  async putFile(source, destination, options) {
    await this.requireOwned(options, { protectedLaunch: true });
    if (!destination.startsWith("/") || destination.includes("\0")) throw new Error("Invalid guest destination.");
    await this.command(["copy", source, `${this.definition.machine}:${destination}`], { signal: options.signal, timeout: 600000 });
  }

  async fileChannel(script, options) {
    await this.requireOwned(options, { protectedLaunch: true });
    return streamCommand(this.binary, ["shell", "--workdir=/tmp", this.definition.machine,
      "/bin/sh", "-c", script], { env: this.env, signal: options.signal });
  }

  async connect(options) {
    await this.requireOwned(options, { protectedLaunch: true });
    const launch = parseLaunch(await this.exec(launchCommand, options));
    const port = this.definition.controlPort;
    await assertFreePort(port);
    const config = path.join(this.instanceDirectory, "ssh.config");
    const control = path.join(this.paths.directory, "ssh.sock");
    const destination = `lima-${this.definition.machine}`;
    const child = await startOwnedProcess({ binary: "/usr/bin/ssh", args: ["-F", config,
      "-o", "ControlMaster=yes", "-o", "ControlPersist=no", "-S", control,
      "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2",
      "-N", "-L", `127.0.0.1:${port}:127.0.0.1:3080`, destination], env: this.env, signal: options.signal });
    try {
      let ready = false;
      for (let i = 0; i < 100; i++) {
        options.signal?.throwIfAborted();
        if (!child.healthy()) throw new Error("The SSH tunnel is unavailable.");
        try {
          await run("/usr/bin/ssh", ["-F", config, "-S", control, "-O", "check", destination],
            { env: this.env, signal: options.signal, timeout: 1000 }); ready = true; break;
        } catch { await delay(100, undefined, { signal: options.signal }); }
      }
      if (!ready) throw new Error("The SSH tunnel is not ready.");
      await this.requireOwned(options, { protectedLaunch: true });
      const origin = `http://127.0.0.1:${port}`;
      return { origin, launchUrl: origin + "/" + launch.search, close: child.close };
    } catch (error) { await child.close(); throw error; }
  }
}

module.exports = { LimaDriver, LIMA_SHA256, UBUNTU_SHA256 };
