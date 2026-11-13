const net = require("node:net");
const path = require("node:path");
const {
  command,
  available,
  checkCancelled,
  parseLaunch,
  socketPath,
  launchCommand,
} = require("./common.cjs");

class SmolvmEngine {
  constructor({ stateRoot }) {
    this.id = "wrapvm-poc";
    this.kind = "smolvm";
    this.name = "WrapVM · smolvm";
    this.machine = "harness-wrapvm-poc";
    this.binary = path.join(stateRoot, "runtimes", "smolvm-1.34.1", "smolvm");
    this.socket = socketPath(stateRoot, this.id);
    this.port = 43881;
    this.partition = "persist:env-wrapvm-poc";
    this.capabilities = {
      local: true,
      lifecycle: true,
      browser: true,
      desktop: true,
      workspace: "isolated",
      fileTransfer: true,
    };
  }
  async inspect({ signal } = {}) {
    if (!available(this.binary))
      return {
        available: false,
        state: "unavailable",
        detail: "Runtime smolvm da preparare: scripts/setup-wrapvm.sh.",
      };
    try {
      const { stdout } = await command(
        this.binary,
        ["machine", "status", "--name", this.machine, "--json"],
        { signal },
      );
      const info = JSON.parse(stdout);
      if (
        info.name !== this.machine ||
        info.labels?.owner !== "harness-native-vm-poc" ||
        info.mounts !== 0 ||
        info.ports !== 0
      )
        return {
          available: false,
          state: "conflict",
          detail:
            "La macchina WrapVM non corrisponde all’ambiente isolato del PoC. Nessuna adozione automatica.",
        };
      return {
        available: true,
        state: String(info.state ?? info.status ?? "unknown").toLowerCase(),
        detail: "MicroVM WrapVM · browser e desktop · workspace isolato",
      };
    } catch (error) {
      checkCancelled(signal);
      return {
        available: false,
        state: "missing",
        detail: "Ambiente WrapVM da preparare: scripts/setup-wrapvm.sh.",
      };
    }
  }
  async exec(script, signal) {
    return (
      await command(
        this.binary,
        [
          "machine",
          "exec",
          "--name",
          this.machine,
          "-u",
          "user",
          "--",
          "sh",
          "-c",
          script,
        ],
        { signal },
      )
    ).stdout.trim();
  }
  async start({ signal } = {}) {
    const status = await this.inspect({ signal });
    if (!status.available) throw new Error(status.detail);
    await command(this.binary, ["machine", "start", "--name", this.machine], {
      signal,
      timeout: 180000,
    });
    checkCancelled(signal);
    // A hard VM stop can leave the previous process's launch URL on disk.
    await this.exec(
      'if ! /usr/bin/curl -s --max-time 2 -o /dev/null http://127.0.0.1:3080/; then rm -f "$HOME/.harness-native-poc/launch-url"; fi',
      signal,
    );
    // flock and the private lock keep reconnects from starting another backend.
    await command(
      this.binary,
      [
        "machine",
        "exec",
        "--name",
        this.machine,
        "-u",
        "user",
        "--detach",
        "--",
        "sh",
        "-c",
        'test -f "$HOME/.harness-native-poc/wrapvm-service.cjs" && exec flock -n "$HOME/.harness-native-poc/service.lock" "$HOME/.harness-native-poc/node/bin/node" "$HOME/.harness-native-poc/wrapvm-service.cjs" >>"$HOME/.harness-native-poc/service.log" 2>&1',
      ],
      { signal },
    );
  }
  async stop({ signal } = {}) {
    const status = await this.inspect({ signal });
    if (!status.available) throw new Error(status.detail);
    await command(this.binary, ["machine", "stop", "--name", this.machine], {
      signal,
      timeout: 60000,
    });
  }
  async connect({ signal, onDisconnect } = {}) {
    const launch = parseLaunch(await this.exec(launchCommand, signal));
    checkCancelled(signal);
    const sockets = new Set();
    let closed = false,
      closePromise;
    const server = net.createServer((client) => {
      const upstream = net.createConnection(this.socket);
      for (const socket of [client, upstream]) sockets.add(socket);
      const dispose = () => {
        client.destroy();
        upstream.destroy();
        sockets.delete(client);
        sockets.delete(upstream);
      };
      client.on("error", dispose);
      upstream.on("error", () => {
        dispose();
        if (!closed) onDisconnect?.();
      });
      client.on("close", dispose);
      upstream.on("close", dispose);
      client.pipe(upstream).pipe(client);
    });
    const close = () => {
      if (closePromise) return closePromise;
      closed = true;
      signal?.removeEventListener("abort", abort);
      for (const socket of sockets) socket.destroy();
      closePromise = new Promise((resolve) => server.close(resolve));
      return closePromise;
    };
    const abort = () => {
      void close();
    };
    try {
      await new Promise((resolve, reject) => {
        server.once("error", () =>
          reject(
            new Error(
              "La porta locale WrapVM è occupata. Nessun collegamento alternativo è stato usato.",
            ),
          ),
        );
        server.listen(this.port, "127.0.0.1", resolve);
      });
      checkCancelled(signal);
      signal?.addEventListener("abort", abort, { once: true });
      const origin = `http://127.0.0.1:${server.address().port}`;
      return { origin, launchUrl: origin + "/" + launch.search, close };
    } catch (error) {
      await close();
      throw error;
    }
  }
}
module.exports = { SmolvmEngine };
