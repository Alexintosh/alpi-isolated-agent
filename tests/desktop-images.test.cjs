'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');
const { DESKTOP_IMAGES, desktopImage } = require('../src/runtime/desktop-images.cjs');
const { ENVIRONMENTS, PERSONAL_ENVIRONMENTS, environment } = require('../src/runtime/environments.cjs');

// Capture constructor arguments without reading host state, starting services,
// copying archives, or connecting to a VM.
function runtimeFactory() {
  const file = path.resolve(__dirname, '../src/runtime/index.cjs');
  const realRequire = createRequire(file), constructions = [];
  const dependencies = {
    './network.cjs': 'Network', './provisioner.cjs': 'Provisioner',
    './smol-driver.cjs': 'SmolDriver', './lima-driver.cjs': 'LimaDriver',
    './coordinator.cjs': 'Coordinator', './file-transfers.cjs': 'FileTransfers',
    './folder-shares.cjs': 'FolderShares', './resource-settings.cjs': 'ResourceSettings',
  };
  const context = { module: { exports: {} }, __dirname: path.dirname(file), require(name) {
    const kind = dependencies[name];
    if (!kind) return realRequire(name);
    return { [kind]: class {
      constructor(options) { Object.assign(this, options); constructions.push({ kind, options }); }
    } };
  } };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  return { create: options => context.module.exports.createRuntime({ projectRoot: '/fixture/project',
    stateRoot: '/fixture/state', runtimeRoot: '/fixture/runtime', ...options }), constructions };
}

test('the immutable catalog pins both exact archives and describes their provenance', () => {
  assert(Object.isFrozen(DESKTOP_IMAGES));
  assert.deepEqual(DESKTOP_IMAGES.map(image => [image.id, image.architecture, image.browser, image.sha256, image.bytes, image.environmentId]), [
    ['local-arm64', 'arm64', 'Chromium', 'f4143564dbe143660989d7f919ec99a1be92258d95d73d99020b855a742dd566', 6780605952, 'wrapvm-arm64-v1'],
    ['stock-amd64', 'x64', 'Google Chrome', 'e87b3757c0e05b97ca35291e1963e47b20d46c0a741886e39e0d4738b3a678df', 1394883072, 'wrapvm-v1'],
  ]);
  for (const image of DESKTOP_IMAGES) {
    assert(Object.isFrozen(image));
    assert.equal(desktopImage(image.id), image);
    assert.throws(() => { image.sha256 = 'changed'; }, TypeError);
  }
  assert.match(desktopImage('local-arm64').provenance, /Local adapted/);
  assert.match(desktopImage('local-arm64').provenance, /84fe5bbb156936b79eb4d95e022944245ac62f65bc151d4e2134ebc442892315/);
  assert.match(desktopImage('local-arm64').provenance, /not independently attested/);
  assert.match(desktopImage('stock-amd64').name, /Rosetta/);
  for (const id of [undefined, null, '', 'legacy', '../local-arm64', {}, 'toString'])
    assert.throws(() => desktopImage(id), /Unknown desktop image/);
});

test('personal identities retain official data and isolate the local image on every endpoint', () => {
  assert(Object.isFrozen(PERSONAL_ENVIRONMENTS));
  assert.equal(PERSONAL_ENVIRONMENTS[0], ENVIRONMENTS[0]);
  const official = PERSONAL_ENVIRONMENTS[1], local = PERSONAL_ENVIRONMENTS[2];
  const { name, imageId, ...identity } = official;
  const { name: legacyName, ...legacyIdentity } = ENVIRONMENTS[1];
  assert.deepEqual(identity, legacyIdentity);
  assert.equal(name, 'Official AMD64 Chrome');
  assert.equal(imageId, 'stock-amd64');
  assert.deepEqual(local, {
    id: 'wrapvm-arm64-v1', kind: 'smolvm', name: 'Local ARM64 Chromium',
    machine: 'harness-isolated-wrapvm-arm64-v1', partition: 'persist:isolated-wrapvm-arm64-v1',
    owner: 'harness-isolated-v1', controlPort: 43988, proxyPort: 43989, credentialPort: 43990,
    browser: true, desktop: true, imageId: 'local-arm64',
  });
  for (const key of ['id', 'machine', 'partition'])
    assert.equal(new Set(PERSONAL_ENVIRONMENTS.map(item => item[key])).size, 3);
  const ports = PERSONAL_ENVIRONMENTS.flatMap(item => [item.controlPort, item.proxyPort, item.credentialPort, item.sshPort].filter(Boolean));
  assert.equal(new Set(ports).size, ports.length);
  for (const item of PERSONAL_ENVIRONMENTS) assert(Object.isFrozen(item));
  assert.equal(environment(local.id), local);
  // Existing callers still receive their original rows and implicit behavior.
  assert.equal(ENVIRONMENTS.length, 2);
  assert.equal(environment('wrapvm-v1'), ENVIRONMENTS[1]);
  assert.equal(legacyName, 'WrapVM · Browser and desktop');
  assert.equal(ENVIRONMENTS[1].imageId, undefined);
  for (const id of ['cloud', '../wrapvm-v1', null, {}]) assert.throws(() => environment(id), /Unknown v1 environment/);
});

test('each explicit image overrides either legacy variant with its pinned archive and correct guest bundle', () => {
  for (const wrapvmVariant of ['legacy', 'stock-amd64']) {
    const { create } = runtimeFactory();
    const runtime = create({ definitions: PERSONAL_ENVIRONMENTS, wrapvmVariant });
    for (const image of DESKTOP_IMAGES) {
      const driver = runtime.drivers.get(image.environmentId), provisioner = driver.provisioner;
      assert.equal(driver.definition.imageId, image.id);
      assert.equal(driver.imageSha256, image.sha256);
      assert.equal(driver.rosetta, image.architecture === 'x64');
      assert.equal(driver.imageArchive, image.id === 'local-arm64' ? '/fixture/project/vendor/wrapvm-desktop.tar' :
        '/fixture/project/vendor/v1/wrapvm-stock-amd64.tar');
      assert.equal(provisioner.architecture, image.architecture);
      assert.equal(provisioner.configureDesktop, true);
      assert.equal(provisioner.artifacts, '/fixture/project/vendor/v1' + (image.architecture === 'x64' ? '/x64' : ''));
      assert.equal(provisioner.browserTool, '/fixture/project/vendor/v1/' + require('../src/runtime/browser-artifact.cjs').name);
    }
    const lima = runtime.drivers.get('lima-v1');
    assert.equal(lima.provisioner.configureDesktop, undefined);
    assert.equal(lima.provisioner.artifacts, '/fixture/project/vendor/v1');
  }
});

test('the optional absolute host archive affects only the explicit local image', () => {
  const { create } = runtimeFactory();
  const options = { definitions: PERSONAL_ENVIRONMENTS, artifactRoot: '/fixture/installed', localImageArchive: '/fixture/optional/local.tar' };
  const runtime = create(options);
  assert.equal(runtime.drivers.get('wrapvm-arm64-v1').imageArchive, options.localImageArchive);
  assert.equal(runtime.drivers.get('wrapvm-v1').imageArchive, '/fixture/installed/v1/wrapvm-stock-amd64.tar');
  for (const localImageArchive of ['', 'relative.tar', null, 1, {}])
    assert.throws(() => create({ ...options, localImageArchive }), /absolute host path/);
  const legacy = create({ localImageArchive: options.localImageArchive });
  assert.equal(legacy.drivers.get('wrapvm-v1').imageArchive, '/fixture/project/vendor/wrapvm-desktop.tar');
});

test('unknown or misbound explicit images fail before any service is constructed', () => {
  for (const patch of [{ imageId: 'unknown' }, { imageId: null }, { imageId: 'local-arm64' },
    { imageId: 'stock-amd64', kind: 'lima' }]) {
    const { create, constructions } = runtimeFactory();
    assert.throws(() => create({ definitions: [{ ...ENVIRONMENTS[1], ...patch }] }), /desktop image|does not match/);
    assert.equal(constructions.length, 0);
  }
});

test('definitions without imageId retain legacy default and stock variant configurations', () => {
  for (const wrapvmVariant of ['legacy', 'stock-amd64']) {
    const { create } = runtimeFactory();
    const runtime = create({ wrapvmVariant });
    assert.equal(runtime.drivers.size, 2);
    const driver = runtime.drivers.get('wrapvm-v1');
    assert.equal(driver.definition, ENVIRONMENTS[1]);
    if (wrapvmVariant === 'legacy') {
      assert.equal(driver.imageSha256, undefined); // SmolDriver retains its existing default.
      assert.equal(driver.rosetta, undefined);
      assert.equal(driver.provisioner, runtime.drivers.get('lima-v1').provisioner);
      assert.equal(driver.provisioner.configureDesktop, undefined);
    } else {
      assert.equal(driver.imageSha256, desktopImage('stock-amd64').sha256);
      assert.equal(driver.rosetta, true);
      assert.equal(driver.provisioner.architecture, 'x64');
      assert.equal(driver.provisioner.configureDesktop, true);
    }
  }
  const { create } = runtimeFactory();
  assert.throws(() => create({ wrapvmVariant: 'local-arm64' }), /Unsupported desktop image variant/);
});

test('missing or wrong local bytes fail without substituting the official image or creating a VM', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-image-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = path.join(root, 'local.tar');
  const { create } = runtimeFactory();
  const options = create({ definitions: PERSONAL_ENVIRONMENTS, localImageArchive: archive }).drivers.get('wrapvm-arm64-v1');
  const { SmolDriver } = require('../src/runtime/smol-driver.cjs');
  const driver = new SmolDriver({ ...options, runtimeRoot: root, provisioner: {
    verifyArtifacts: async () => {}, prepare: () => assert.fail('must not provision the guest'),
  } });
  driver.inspect = async () => ({ state: 'missing' });
  driver.command = () => assert.fail('must not create a VM or import another image');
  const prepareOptions = { ownershipToken: randomUUID(), network: { healthy: () => true, mediator: { healthy: () => true } } };
  await assert.rejects(driver.prepare(prepareOptions), { code: 'ENOENT' });
  fs.writeFileSync(archive, 'wrong bytes');
  await assert.rejects(driver.prepare(prepareOptions), /Desktop image digest mismatch/);
  assert.equal(driver.imageArchive, archive);
  assert.equal(driver.expectedImage, 'local:' + desktopImage('local-arm64').sha256);
});

test('guest proxy allowlist contains only the two fixed endpoints and sandbox disabling stays x64 only', () => {
  const script = fs.readFileSync(path.resolve(__dirname, '../guest/v1/configure-desktop.sh'), 'utf8');
  const proxyCase = script.match(/case "\$proxy" in (.+?)\) ;; \*\) exit 1 ;; esac/);
  assert(proxyCase);
  assert.deepEqual(proxyCase[1].split('|'), ['http://192.0.2.1:43983', 'http://192.0.2.1:43989']);
  assert.match(script, /case "\$architecture" in x64\) printf '%s\\n' '--no-sandbox'[^\n]+;; arm64\) ;; \*\) exit 1 ;; esac/);
  assert.equal(script.match(/--no-sandbox/g).length, 1);
});
