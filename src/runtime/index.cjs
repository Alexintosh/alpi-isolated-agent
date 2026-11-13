const path = require("node:path");
const os = require("node:os");
const { ENVIRONMENTS } = require("./environments.cjs");
const { desktopImage } = require('./desktop-images.cjs');
const { Network } = require("./network.cjs");
const { Provisioner } = require("./provisioner.cjs");
const { SmolDriver } = require("./smol-driver.cjs");
const { LimaDriver } = require("./lima-driver.cjs");
const { Coordinator } = require("./coordinator.cjs");
const { FileTransfers } = require("./file-transfers.cjs");
const { FolderShares } = require("./folder-shares.cjs");
const { ResourceSettings } = require('./resource-settings.cjs');

function createRuntime({ projectRoot = path.resolve(__dirname, "../.."),
  artifactRoot = path.join(projectRoot, 'vendor'),
  smolRuntime = path.join(artifactRoot, 'smolvm/smolvm-1.34.1-darwin-arm64'),
  hostPython = path.join(artifactRoot, 'v1/host-python/python/bin/python3.13'),
  stateRoot = path.join(os.homedir(), "Library/Application Support/Harness Isolated"),
  runtimeRoot = path.join(os.homedir(), ".harness-isolated"), decide, credentialBridge, onFault,
  definitions = ENVIRONMENTS, wrapvmVariant = 'legacy', limaVariant = 'bundled', localImageArchive } = {}) {
  if (!['legacy', 'stock-amd64'].includes(wrapvmVariant)) throw new Error('Unsupported desktop image variant.');
  if(!['system','bundled'].includes(limaVariant))throw new Error('Unsupported Lima runtime variant.');
  if (localImageArchive !== undefined && (typeof localImageArchive !== 'string' || !path.isAbsolute(localImageArchive)))
    throw new Error('The local desktop image archive must be an absolute host path.');
  // Validate explicit choices before constructing services. An invalid imageId
  // must never reach the legacy variant's implicit defaults.
  const images = new Map(definitions.filter(definition => definition.imageId !== undefined).map(definition => {
    const image = desktopImage(definition.imageId);
    if (definition.kind !== 'smolvm' || definition.id !== image.environmentId)
      throw new Error('Desktop image does not match its environment.');
    return [definition.id, image];
  }));
  const artifacts = path.join(artifactRoot, "v1");
  const network = new Network({ stateRoot, ironBinary: path.join(artifactRoot, "m0/iron-bin/iron-proxy"), decide, credentialBridge, onFault });
  const provisioner = new Provisioner({ stateRoot, artifacts,
    serviceFile: path.join(projectRoot, "guest/v1/service.cjs"), lockFile: path.join(projectRoot, "guest/package-lock.json") });
  const desktopProvisioner = wrapvmVariant === 'stock-amd64' ? new Provisioner({ stateRoot,
    artifacts: path.join(artifacts, 'x64'), architecture: 'x64', configureDesktop: true,
    browserTool:path.join(artifacts,require('./browser-artifact.cjs').name), serviceFile: path.join(projectRoot, 'guest/v1/service.cjs'),
    lockFile: path.join(projectRoot, 'guest/package-lock.json') }) : provisioner;
  const imageProvisioners = new Map([...images.values()].map(image => [image.id, new Provisioner({ stateRoot,
    artifacts: image.architecture === 'x64' ? path.join(artifacts, 'x64') : artifacts,
    architecture: image.architecture, configureDesktop: true,
    // Both desktops use the verified official ARM64 browser tool on the host CPU.
    browserTool: path.join(artifacts, require('./browser-artifact.cjs').name),
    serviceFile: path.join(projectRoot, 'guest/v1/service.cjs'), lockFile: path.join(projectRoot, 'guest/package-lock.json') })]));
  const drivers = new Map(definitions.map(definition => {
    const image = images.get(definition.id);
    return [definition.id, definition.kind === "lima" ?
    new LimaDriver({ definition, runtimeRoot, binary: limaVariant==='bundled'?path.join(artifacts,'lima/bin/limactl'):"/opt/homebrew/bin/limactl",
      ...(limaVariant==='bundled'?{guestAgent:path.join(artifacts,'lima/bin/lima-guestagent.Linux-aarch64')}:{ }),
      imageFile: path.join(artifacts, "ubuntu-24.04-arm64.img"), provisioner }) :
    new SmolDriver({ definition, runtimeRoot, binary: path.join(smolRuntime, "smolvm"),
      imageArchive: image ? (image.id === 'local-arm64' ? localImageArchive ?? path.join(artifactRoot, 'wrapvm-desktop.tar') :
        path.join(artifacts, 'wrapvm-stock-amd64.tar')) :
        wrapvmVariant === 'stock-amd64' ? path.join(artifacts, 'wrapvm-stock-amd64.tar') : path.join(artifactRoot, "wrapvm-desktop.tar"),
      ...(image ? { imageSha256: image.sha256, rosetta: image.architecture === 'x64' } :
        wrapvmVariant === 'stock-amd64' ? {imageSha256:desktopImage('stock-amd64').sha256,rosetta:true} : {}),
      provisioner: image ? imageProvisioners.get(image.id) : desktopProvisioner })];
  }));
  const coordinator = new Coordinator({ stateRoot, definitions, drivers, network });
  const transfers = new FileTransfers({ coordinator, stateRoot, runtimeRoot, python:hostPython,
    protectedPaths: [path.join(os.homedir(), '.harness-isolated'), artifactRoot, path.join(projectRoot, '.state/electron'), path.join(os.homedir(), '.lima/harness-native-poc')] });
  const shares = new FolderShares({ stateRoot, definitions, coordinator, transfers });
  const resources = new ResourceSettings({stateRoot,definitions,coordinator});
  coordinator.checkRecreate = id => {
    transfers.requireJournal(); shares.requireValid();
    if (transfers.active || transfers.snapshot().interrupted.some(item => item.environmentId === id))
      throw new Error('Resolve interrupted transfers in Files before recreating this environment.');
  };
  // Called under the coordinator queue, only after confirmed guest shutdown.
  // Revoke grants, never unlink their host source paths. Saved policy and host
  // credentials are intentionally retained; a fresh guest starts with no shares.
  coordinator.beforeRecreate = id => {
    coordinator.checkRecreate(id);
    transfers.cancel(); shares.cancel();
    shares.persist(shares.data.shares.filter(item => item.environmentId !== id));
  };
  for (const [id, driver] of drivers) {
    driver.getShares = () => shares.forEnvironment(id);
    driver.getResources = () => resources.forEnvironment(id);
  }
  return { coordinator, drivers, network, transfers, shares, resources, stateRoot, runtimeRoot, limaVariant, wrapvmVariant };
}

module.exports = { createRuntime };
