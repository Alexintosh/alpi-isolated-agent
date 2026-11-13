const { spawn } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");
const {
  command,
  available,
  checkCancelled,
  delay,
  parseLaunch,
  assertFreePort,
  kill,
  launchCommand,
} = require("./common.cjs");

class LimaEngine {
  constructor({ stateRoot }) {
    this.id = "lima-poc";
    this.kind = "lima";
    this.name = "Lima · Ubuntu";
    this.machine = "harness-native-poc";
    this.binary = "/opt/homebrew/bin/limactl";
    this.port = 43880;
    this.partition = "persist:harness-guest"; // Preserve the original PoC profile.
    this.stateRoot = stateRoot;
    this.capabilities = {
      local: true,
      lifecycle: true,
      browser: false,
      desktop: false,
      workspace: "isolated",
      fileTransfer: true,
    };
  }
  async inspect({ signal } = {}) {
    if (!available(this.binary))
      return {
        available: false,
        state: "unavailable",
        detail: "Lima non è installato.",
      };
    try {
      const { stdout } = await command(
        this.binary,
        ["list", "--json", this.machine],
        { signal },
      );
      const record = stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .find((item) => item.name === this.machine);
      return record
        ? {
            available: true,
            state: String(record.status).toLowerCase(),
            detail:
              "VM Linux dedicata · workspace isolato · browser non installato",
          }
        : {
            available: false,
            state: "missing",
            detail: "Ambiente Lima da preparare: scripts/setup-guest.sh.",
          };
    } catch (error) {
      checkCancelled(signal);
      return {
        available: false,
        state: "unknown",
        detail: "Impossibile verificare la VM Lima.",
      };
    }
  }
  async exec(script, signal) {
    return (
      await command(
        this.binary,
        ["shell", "--workdir=/tmp", this.machine, "sh", "-c", script],
        { signal },
      )
    ).stdout.trim();
  }
  async start({ signal } = {}) {
    const status = await this.inspect({ signal });
    if (!status.available) throw new Error(status.detail);
    await command(this.binary, ["start", "--tty=false", this.machine], {
      signal,
      timeout: 180000,
    });
    checkCancelled(signal);
    await this.exec("sudo systemctl start harness-native-poc", signal);
  }
  async stop({ signal } = {}) {
    await command(this.binary, ["stop", this.machine], {
      signal,
      timeout: 60000,
    });
  }
  async connect({ signal, onDisconnect } = {}) {
    const launch = parseLaunch(await this.exec(launchCommand, signal));
    await assertFreePort(this.port);
    checkCancelled(signal);
    const config = path.join(os.homedir(), ".lima", this.machine, "ssh.config");
    const socket = path.join(this.stateRoot, "tunnel.sock");
    const destination = `lima-${this.machine}`;
    const child = spawn(
      "/usr/bin/ssh",
      [
        "-F",
        config,
        "-o",
        "ControlMaster=yes",
        "-o",
        "ControlPersist=no",
        "-S",
        socket,
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=5",
        "-o",
        "ServerAliveCountMax=2",
        "-N",
        "-L",
        `127.0.0.1:${this.port}:127.0.0.1:3080`,
        destination,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    child.stderr.resume();
    let closed = false,
      failed = false;
    child.on("error", () => {
      failed = true;
      if (!closed) onDisconnect?.();
    });
    child.on("exit", () => {
      failed = true;
      if (!closed) onDisconnect?.();
    });
    const close = async () => {
      closed = true;
      signal?.removeEventListener("abort", abort);
      await kill(child);
    };
    const abort = () => {
      void close();
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      let ready = false;
      for (let i = 0; i < 100; i++) {
        checkCancelled(signal);
        if (failed) throw new Error("Il tunnel SSH non è disponibile.");
        try {
          await command(
            "/usr/bin/ssh",
            ["-F", config, "-S", socket, "-O", "check", destination],
            { signal, timeout: 1000 },
          );
          ready = true;
          break;
        } catch {
          await delay(100, signal);
        }
      }
      if (!ready) throw new Error("Timeout del tunnel SSH.");
      const origin = `http://127.0.0.1:${this.port}`;
      return { origin, launchUrl: origin + "/" + launch.search, close };
    } catch (error) {
      await close();
      throw error;
    }
  }
}
module.exports = { LimaEngine };
