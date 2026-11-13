const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { writeJson } = require("./atomic-json.cjs");
const { privateDirectory } = require("./iron-ca.cjs");
const { launchCommand } = require("./driver-common.cjs");
const { parseLaunch } = require("../engines/common.cjs");
const browserArtifact=require('./browser-artifact.cjs');
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
async function fileHash(file) {
  const digest = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

class Provisioner {
  constructor({ stateRoot, artifacts, serviceFile, lockFile, architecture = 'arm64', configureDesktop = false, browserTool }) {
    if (!['arm64', 'x64'].includes(architecture)) throw new Error('Unsupported guest architecture.');
    this.architecture = architecture;
    this.configureDesktop = configureDesktop;
    this.browserTool=browserTool;
    this.stateRoot = stateRoot; this.artifacts = artifacts; this.serviceFile = serviceFile; this.lockFile = lockFile;
  }

  async verifyArtifacts({ signal } = {}) {
    signal?.throwIfAborted();
    const manifest = JSON.parse(fs.readFileSync(path.join(this.artifacts, "guest-runtime.json"), "utf8"));
    if (manifest.version !== 1 || manifest.platform !== `linux-${this.architecture}-glibc` || manifest.node !== "24.13.0" ||
        manifest.harness !== "0.2.2-rc.2" || manifest.npmLifecycleScripts !== false ||
        manifest.lockSha256 !== await fileHash(this.lockFile) ||
        manifest.bundleSha256 !== await fileHash(path.join(this.artifacts, "guest-runtime.tar.gz")))
      throw new Error("The guest bundle could not be verified.");
    if(this.configureDesktop)await this.verifyBrowserTool();
    signal?.throwIfAborted(); return manifest;
  }
  async verifyBrowserTool() {
    if(!this.browserTool || await fileHash(this.browserTool)!==browserArtifact.sha256)
      throw new Error('The verified stock browser tool is unavailable.');
  }

  async prepare(driver, options) {
    const manifest = await this.verifyArtifacts(options);
    const guestRoot = "/home/user/.harness-isolated";
    await driver.exec(`umask 077; mkdir -p ${guestRoot}/data /home/user/workspace`, options);
    const installed = await driver.exec(`cat ${guestRoot}/installed-bundle 2>/dev/null || true`, options);
    if (installed.trim() && installed.trim() !== manifest.bundleSha256)
      throw new Error("A different guest bundle is already installed. Implicit upgrades are disabled.");
    if (installed.trim() !== manifest.bundleSha256) {
      await driver.putFile(path.join(this.artifacts, "guest-runtime.tar.gz"), `${guestRoot}/runtime.tar.gz`, options);
      await driver.exec(`set -eu
cd ${guestRoot}
printf '%s  %s\n' ${quote(manifest.bundleSha256)} runtime.tar.gz | sha256sum -c - >/dev/null
mkdir -p releases staging
if ! test -d releases/${manifest.bundleSha256}; then
  if ! tar -xzf runtime.tar.gz -C staging >extract.log 2>&1; then tail -c 4096 extract.log >&2; exit 1; fi
  rm -f extract.log
  mv staging releases/${manifest.bundleSha256}
fi
test -x releases/${manifest.bundleSha256}/node/bin/node
releases/${manifest.bundleSha256}/node/bin/node -e 'if(process.version!=="v24.13.0" || process.platform!=="linux" || process.arch!=="${this.architecture}")process.exit(1)'
cd releases/${manifest.bundleSha256}/runtime
../node/bin/node -e 'require("node-pty"); require("koffi")'
cd ../../..
ln -sfn releases/${manifest.bundleSha256}/node node.next
mv -Tf node.next node
ln -sfn releases/${manifest.bundleSha256}/runtime runtime.next
mv -Tf runtime.next runtime
printf '%s\n' ${quote(manifest.bundleSha256)} > installed-bundle.next
mv installed-bundle.next installed-bundle
rm runtime.tar.gz`, options);
    }
    await driver.putFile(this.serviceFile, `${guestRoot}/service.cjs`, options);
    await driver.putFile(options.network.caFile, `${guestRoot}/ca.crt`, options);
    const directory = path.join(this.stateRoot, "provision", driver.definition.id); privateDirectory(directory);
    const configFile = path.join(directory, "network.json");
    const proxy = `http://${driver.definition.kind === "lima" ? "192.168.5.2" : "192.0.2.1"}:${options.network.proxyPort}`;
    writeJson(configFile, { proxy, desktop: driver.definition.browser });
    await driver.putFile(configFile, `${guestRoot}/network.json`, options);
    await this.start(driver, options);
  }

  async start(driver, options) {
    // Refresh per-launch substitute tokens through the engine control channel.
    // Only public CA, settings and placeholders enter the guest, never vault data.
    const guestRoot = "/home/user/.harness-isolated";
    const directory = path.join(this.stateRoot, "provision", driver.definition.id); privateDirectory(directory);
    const credentialHost = driver.definition.kind === "lima" ? "192.168.5.2" : "192.0.2.1";
    writeJson(path.join(directory, "network.json"), { proxy: `http://${credentialHost}:${options.network.proxyPort}`,
      desktop: driver.definition.browser, ...(options.network.bridge ? { credentialHost } : {}) });
    await driver.putFile(path.join(directory, "network.json"), `${guestRoot}/network.json`, options);
    await driver.putFile(this.serviceFile, `${guestRoot}/service.cjs`, options);
    // App-owned guest skill, using the same stock discovery root as WrapVM's
    // browser/desktop guides. No host workspace or personal skills are mounted.
    const skillRoot = '/home/user/.agents/skills/harness-isolated';
    await driver.exec(`mkdir -p ${skillRoot}`, options);
    await driver.putFile(path.join(path.dirname(this.serviceFile), 'skills/harness-isolated/SKILL.md'), `${skillRoot}/SKILL.md`, options);
    if (driver.definition.browser && this.configureDesktop) {
      await this.verifyBrowserTool();
      await driver.exec(`mkdir -p ${guestRoot}/tools`,options);
      await driver.putFile(this.browserTool,`${guestRoot}/tools/agent-browser`,options,{mode:'755'});
      await driver.putFile(path.join(path.dirname(this.serviceFile), 'configure-desktop.sh'), `${guestRoot}/configure-desktop.sh`, options);
      await driver.exec(`/bin/sh ${guestRoot}/configure-desktop.sh ${quote(`http://${credentialHost}:${options.network.proxyPort}`)} ${quote(this.architecture)}`, options);
    }
    const gitConfig = options.network.bridge?.guestGitConfig?.(`http://${credentialHost}:${options.network.bridge.port}`) ?? '';
    fs.writeFileSync(path.join(directory, 'gitconfig'), gitConfig, { mode: 0o600 });
    await driver.putFile(path.join(directory, 'gitconfig'), `${guestRoot}/gitconfig`, options);
    if (options.network.bridge) {
      const entries = options.network.bridge.guestProviders(`http://${credentialHost}:${options.network.bridge.port}`);
      const providers = {}, credentials = {};
      for (const { provider, token } of entries) {
        const ref = `ISOLATED_MODEL_${provider.id.replaceAll("-", "_").toUpperCase()}`;
        providers[provider.id] = { displayName: provider.displayName ?? provider.id, api: provider.api, baseURL: provider.baseURL,
          models: provider.models, apiKeyEnv: ref };
        credentials[ref] = token;
      }
      writeJson(path.join(directory, "model-providers.json"), { providers, credentials,
        selected: options.network.bridge.defaultModel });
      await driver.putFile(path.join(directory, "model-providers.json"), `${guestRoot}/model-providers.json`, options);
    }
    // flock owns the service lifetime. Repeated starts do not create a backend.
    await driver.exec('if ! /usr/bin/curl -s --max-time 2 -o /dev/null http://127.0.0.1:3080/; then rm -f "$HOME/.harness-isolated/launch-url"; fi', options);
    await driver.exec('test -x "$HOME/.harness-isolated/node/bin/node" && test -s "$HOME/.harness-isolated/service.cjs" && nohup flock -n "$HOME/.harness-isolated/service.lock" "$HOME/.harness-isolated/node/bin/node" "$HOME/.harness-isolated/service.cjs" </dev/null >/dev/null 2>&1 &', options);
    parseLaunch(await driver.exec(launchCommand, options));
  }
}

module.exports = { Provisioner, fileHash };
