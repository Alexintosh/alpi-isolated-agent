// Guest-only wrapper around the unmodified Harness web distribution.
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const home = require("node:os").homedir(), root = path.join(home, ".harness-isolated");
const settings = JSON.parse(fs.readFileSync(path.join(root, "network.json"), "utf8"));
const yaml = require(path.join(root, "runtime/node_modules/js-yaml"));
const profile = path.join(root, "data/profiles/web"); fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
const patchFile = path.join(profile, "cordis.patch.yml"), credentialFile = path.join(root, "data/.credentials.yaml");
const old = fs.existsSync(patchFile) ? yaml.load(fs.readFileSync(patchFile, "utf8")) ?? [] : [];
let patches = old.filter(item => item.id !== "workspace-controller");
// Stock deployment override: minimal Linux images need not expose an XDG
// Documents directory. Keep the first-use workspace beneath the guest workspace.
patches.push({ id: "workspace-controller", name: "@deepseek-ai/dsh-api-workspace-controller",
  config: { documentsDirectory: "/home/user/workspace" } });
const modelFile = path.join(root, "model-providers.json");
if (fs.existsSync(modelFile)) {
  const modelSettings = JSON.parse(fs.readFileSync(modelFile, "utf8"));
  patches = patches.filter(item => !["llm-pi-ai", "agent-default-model"].includes(item.id));
  patches.push({ id: "llm-pi-ai", name: "@deepseek-ai/dsh-llm-pi-ai", config: { providers: modelSettings.providers } });
  if (modelSettings.selected) patches.push({ id: "agent-default-model", name: "@deepseek-ai/dsh-agent-default-model", config: modelSettings.selected });
  const credentials = fs.existsSync(credentialFile) ? yaml.load(fs.readFileSync(credentialFile, "utf8")) : { version: 1, refs: {}, records: {} };
  for (const [ref, value] of Object.entries(credentials.refs ?? {}))
    if ((ref.startsWith("ISOLATED_MODEL_") || ref.startsWith("isolated-")) && /^isolated-[a-f0-9]{64}$/.test(value)) delete credentials.refs[ref];
  credentials.refs = { ...credentials.refs, ...modelSettings.credentials };
  fs.writeFileSync(credentialFile + ".next", yaml.dump(credentials), { mode: 0o600 }); fs.renameSync(credentialFile + ".next", credentialFile);
}
fs.writeFileSync(patchFile + ".next", yaml.dump(patches), { mode: 0o600 }); fs.renameSync(patchFile + ".next", patchFile);
const socket = path.join(root, "harness.sock"), launchFile = path.join(root, "launch-url");
const sockets = new Set();
let child, timer, stopping = false;
fs.rmSync(socket, { force: true }); fs.rmSync(launchFile, { force: true });
const server = net.createServer(client => {
  const upstream = net.connect(3080, "127.0.0.1");
  sockets.add(client); sockets.add(upstream);
  const dispose = () => { client.destroy(); upstream.destroy(); sockets.delete(client); sockets.delete(upstream); };
  for (const s of [client, upstream]) { s.on("error", dispose); s.on("close", dispose); }
  client.pipe(upstream).pipe(client);
});
server.listen(socket, () => fs.chmodSync(socket, 0o600));
server.on("error", () => process.exit(1));

function start() {
  fs.rmSync(launchFile, { force: true });
  const ca = path.join(root, "ca.crt");
  const env = {
    HOME: home, USER: "user", LANG: "C.UTF-8",
    PATH: path.join(root, "node/bin") + ":" + path.join(root,'tools') + ":/opt/wrap/bin:/opt/mise/data/shims:/opt/mise/shims:/usr/local/bin:/usr/bin:/bin",
    DSH_HOME: path.join(root, "data"), DSH_TELEMETRY_DISABLED: "1",
    HTTP_PROXY: settings.proxy, HTTPS_PROXY: settings.proxy, http_proxy: settings.proxy, https_proxy: settings.proxy,
    NO_PROXY: ["127.0.0.1", "localhost", "::1", settings.credentialHost].filter(Boolean).join(","),
    no_proxy: ["127.0.0.1", "localhost", "::1", settings.credentialHost].filter(Boolean).join(","),
    NODE_USE_ENV_PROXY: "1", NODE_EXTRA_CA_CERTS: ca, CURL_CA_BUNDLE: ca, GIT_SSL_CAINFO: ca,
    GIT_CONFIG_SYSTEM: path.join(root, 'gitconfig'), GIT_TERMINAL_PROMPT: '0',
  };
  if (settings.desktop) Object.assign(env, { DISPLAY: ":1",
    XDG_RUNTIME_DIR: `/tmp/wrap-desktop-${process.getuid()}/runtime`,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=/tmp/wrap-desktop-${process.getuid()}/runtime/bus`,
    AGENT_BROWSER_CONFIG: "/home/user/workspace/agent-browser.json",
    // Stock VM defines AGENT_BROWSER_SKILLS_DIR in its env, but the Harness launcher
    // constructs env explicitly and drops it; the browser skill guides live at this fixed path.
    AGENT_BROWSER_SKILLS_DIR: "/opt/agent-browser/skill-data" });
  child = spawn(path.join(root, "node/bin/node"), [path.join(root, "runtime/node_modules/@deepseek-ai/dsh/lib/bin.js"),
    "--profile", "web", "--host", "127.0.0.1", "--port", "3080", "--no-open"], {
    cwd: "/home/user/workspace", env, stdio: ["ignore", "pipe", "pipe"],
  });
  function consume(stream) {
    let pending = "";
    stream.on("data", data => {
      pending = (pending + data.toString()).slice(-65536);
      let index;
      while ((index = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, index); pending = pending.slice(index + 1);
        const match = line.match(/http:\/\/127\.0\.0\.1:3080\/[^\s\x1b]*[?&]token=[A-Za-z0-9_-]+/);
        if (match) {
          fs.writeFileSync(launchFile + ".tmp", match[0] + "\n", { mode: 0o600 });
          fs.renameSync(launchFile + ".tmp", launchFile);
        }
        // No raw plugin output, prompt or credential material in supervisor logs.
      }
    });
  }
  consume(child.stdout); consume(child.stderr);
  child.on("error", () => {});
  child.on("close", () => {
    fs.rmSync(launchFile, { force: true });
    if (stopping) { server.close(); fs.rmSync(socket, { force: true }); process.exit(0); }
    timer = setTimeout(start, 2000);
  });
}
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => {
  stopping = true; clearTimeout(timer);
  for (const socket of sockets) socket.destroy();
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  else process.exit(0);
});
start();
