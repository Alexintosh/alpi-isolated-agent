'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const zlib = require('node:zlib');

const {
  RuntimeInstallerError,
  installRuntime,
  verifyRuntime,
  listRuntimes,
  rollbackRuntime,
} = require('../src/runtime-installer.cjs');
const { acquireProcessGuard } = require('../src/process-lock.cjs');

const WORKSPACE = process.cwd();
const INSTALLER_PATH = path.resolve(__dirname, '../src/runtime-installer.cjs');
const COMPONENTS = ['iron-proxy', 'boxlite-sdk', 'boxlite-native'];
const TEST_ORIGIN = 'https://example.test';

function tempDirectory(t, label) {
  const directory = fs.mkdtempSync(
    path.join(WORKSPACE, `.runtime-test-${label}-`)
  );
  fs.chmodSync(directory, 0o700);
  t.after(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function formatMode(mode) {
  return `0${mode.toString(8).padStart(3, '0')}`;
}

function writeTarString(block, value, offset, length) {
  const bytes = Buffer.from(value, 'utf8');
  bytes.copy(block, offset, 0, Math.min(bytes.length, length));
}

function writeTarOctal(block, value, offset, length) {
  const text = value.toString(8).padStart(length - 1, '0');
  block.write(text, offset, length - 1, 'ascii');
  block[offset + length - 1] = 0;
}

function tarHeader({ name, mode = 0o644, size = 0, type = '0', linkname = '' }) {
  const block = Buffer.alloc(512);
  writeTarString(block, name, 0, 100);
  writeTarOctal(block, mode, 100, 8);
  writeTarOctal(block, 0, 108, 8);
  writeTarOctal(block, 0, 116, 8);
  writeTarOctal(block, size, 124, 12);
  writeTarOctal(block, 0, 136, 12);
  block.fill(0x20, 148, 156);
  block.write(type, 156, 1, 'ascii');
  writeTarString(block, linkname, 157, 100);
  block.write('ustar\0', 257, 6, 'binary');
  block.write('00', 263, 2, 'ascii');
  let checksum = 0;
  for (const byte of block) checksum += byte;
  block.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
  block[154] = 0;
  block[155] = 0x20;
  return block;
}

function tarArchive(entries) {
  const blocks = [];
  for (const entry of entries) {
    const type = entry.type ?? '0';
    const carriesContent = ['0', 'x', 'g', 'L'].includes(type);
    const content = carriesContent
      ? Buffer.from(entry.content ?? '')
      : Buffer.alloc(0);
    blocks.push(
      tarHeader({
        name: entry.name,
        mode: entry.mode ?? 0o644,
        size: content.length,
        type,
        linkname: entry.linkname ?? '',
      })
    );
    if (content.length > 0) {
      blocks.push(content);
      const padding = (512 - (content.length % 512)) % 512;
      if (padding > 0) blocks.push(Buffer.alloc(padding));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

function entriesFor(component, version) {
  if (component === 'iron-proxy') {
    return [
      { name: 'iron-proxy', mode: 0o755, content: Buffer.from(`iron-${version}`) },
      { name: 'LICENSE', mode: 0o644, content: Buffer.from(`license-${version}`) },
      { name: 'README.md', mode: 0o644, content: Buffer.from(`readme-${version}`) },
    ];
  }
  if (component === 'boxlite-sdk') {
    return [
      {
        name: 'package/package.json',
        mode: 0o644,
        content: Buffer.from(JSON.stringify({ name: '@boxlite-ai/boxlite', version })),
      },
      { name: 'package/dist/index.js', mode: 0o644, content: Buffer.from(`sdk-index-${version}`) },
      { name: 'package/dist/agents.js', mode: 0o644, content: Buffer.from(`sdk-agents-${version}`) },
      { name: 'package/native/boxlite.js', mode: 0o644, content: Buffer.from(`sdk-native-${version}`) },
    ];
  }
  return [
    {
      name: 'package/package.json',
      mode: 0o644,
      content: Buffer.from(
        JSON.stringify({ name: '@boxlite-ai/boxlite-linux-x64-gnu', version })
      ),
    },
    {
      name: 'package/README.md',
      mode: 0o644,
      content: Buffer.from(`native-readme-${version}`),
    },
    {
      name: 'package/boxlite.linux-x64-gnu.node',
      mode: 0o644,
      content: Buffer.alloc(2048, version.length),
    },
  ];
}

function manifestFiles(entries) {
  return entries
    .filter((entry) => (entry.type ?? '0') === '0')
    .map((entry) => {
      const content = Buffer.from(entry.content ?? '');
      return {
        path: entry.name,
        bytes: content.length,
        mode: formatMode(entry.mode ?? 0o644),
        sha256: sha256(content),
      };
    });
}

function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  const bodyLength = Buffer.byteLength(body);
  let length = bodyLength + 1;
  while (String(length).length + bodyLength !== length) {
    length = String(length).length + bodyLength;
  }
  return `${length}${body}`;
}

function makeRelease({
  version,
  archiveEntries = {},
  manifestEntries = {},
  manifestOverrides = {},
} = {}) {
  const manifests = {};
  const archives = {};
  for (const component of COMPONENTS) {
    const expected = manifestEntries[component] ?? entriesFor(component, version);
    const actual = archiveEntries[component] ?? expected;
    const archive = tarArchive(actual);
    const url = `${TEST_ORIGIN}/releases/${component}-${version}.tgz`;
    manifests[component] = {
      component,
      version,
      platform: 'linux',
      architecture: 'x64',
      publisher: 'synthetic-test',
      license: 'Apache-2.0',
      url,
      allowedHosts: ['example.test'],
      bytes: archive.length,
      sha256: sha256(archive),
      files: manifestFiles(expected),
      ...(manifestOverrides[component] ?? {}),
    };
    archives[url] = archive;
  }
  return { manifests, archives, version };
}

function makeFetch(archives, options = {}) {
  const redirects = options.redirects ?? {};
  const requests = [];
  const delayMs = options.delayMs ?? 0;
  return {
    requests,
    fetch: async (url) => {
      requests.push(url);
      if (redirects[url]) {
        return new Response(null, {
          status: 302,
          headers: { location: redirects[url] },
        });
      }
      const body = archives[url];
      if (!body) throw new Error(`Unexpected synthetic fetch ${url}`);
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return new Response(body, {
        status: 200,
        headers: { 'content-length': String(body.length) },
      });
    },
  };
}

function failingFetch() {
  let calls = 0;
  return {
    calls: () => calls,
    fetch: async () => {
      calls += 1;
      throw new Error('network must not be used');
    },
  };
}

function releaseDirectories(stateDir) {
  const directory = path.join(stateDir, 'runtimes', 'releases');
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function stagingEntries(stateDir) {
  const directory = path.join(stateDir, 'runtimes', 'staging');
  try {
    return fs.readdirSync(directory);
  } catch {
    return [];
  }
}

function runNode(script, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function assertInstalledPaths(result, stateDir) {
  assert.equal(result.engine, 'boxlite');
  assert.equal(result.qualified, undefined);
  assert.equal(result.capabilities, undefined);
  assert.equal(result.sandbox, undefined);
  assert.match(result.set, /^boxlite-\d+\.\d+\.\d+-[a-f0-9]{16}$/);
  assert.equal(result.paths.root, path.join(stateDir, 'runtimes', 'releases', result.set));
  assert.ok(fs.statSync(result.paths.root).isDirectory());
  assert.ok(fs.statSync(result.paths.ironProxy).isFile());
  assert.equal(fs.statSync(result.paths.ironProxy).mode & 0o777, 0o755);
  assert.ok(fs.statSync(result.paths.sdk).isDirectory());
  assert.ok(fs.statSync(result.paths.native).isDirectory());
  assert.ok(
    fs
      .statSync(path.join(result.paths.sdk, 'dist', 'index.js'))
      .isFile()
  );
  assert.ok(
    fs
      .statSync(
        path.join(result.paths.native, 'boxlite.linux-x64-gnu.node')
      )
      .isFile()
  );
}

test('installs a synthetic BoxLite runtime set and exposes bounded records', async (t) => {
  const stateDir = path.join(tempDirectory(t, 'install'), 'state');
  const release = makeRelease({ version: '0.1.0' });
  const fixture = makeFetch(release.archives);

  const result = await installRuntime({
    stateDir,
    engine: 'boxlite',
    platform: 'linux',
    arch: 'x64',
    manifests: release.manifests,
    fetch: fixture.fetch,
  });

  assertInstalledPaths(result, stateDir);
  assert.equal(result.version, '0.1.0');
  assert.deepEqual(await verifyRuntime({ stateDir, manifests: release.manifests }), result);
  await assert.rejects(verifyRuntime({ stateDir }), { code: 'runtime_untrusted' });
  assert.deepEqual(
    result.components.map((component) => component.component),
    COMPONENTS
  );
  assert.equal(fixture.requests.length, 3);
  assert.equal(fs.statSync(stateDir).mode & 0o777, 0o700);
  assert.deepEqual(stagingEntries(stateDir), []);
  assert.equal(releaseDirectories(stateDir).length, 1);

  const inventory = await listRuntimes({ stateDir });
  assert.equal(inventory.active.id, result.set);
  assert.equal(inventory.active.engine, 'boxlite');
  assert.equal(inventory.active.version, '0.1.0');
  assert.equal(inventory.previous, null);
  assert.equal(inventory.runtimes.length, 1);
  assert.equal(inventory.runtimes[0].active, true);
  assert.equal(inventory.runtimes[0].previous, false);
  assert.deepEqual(
    Object.keys(inventory.active).sort(),
    ['active', 'components', 'engine', 'id', 'installedAt', 'previous', 'version']
  );
  for (const record of inventory.runtimes) {
    assert.equal(record.paths, undefined);
    assert.equal(record.capabilities, undefined);
    assert.equal(record.qualified, undefined);
    assert.equal(record.sandbox, undefined);
    assert.equal(record.kvm, undefined);
    assert.equal(record.network, undefined);
  }
  assert.ok(!JSON.stringify(inventory).includes(stateDir));
});

test('accepts archives with explicit directory members', async (t) => {
  const stateDir = path.join(tempDirectory(t, 'dirs'), 'state');
  const version = '0.1.0';
  const sdkEntries = [
    { name: 'package/', type: '5', mode: 0o755 },
    { name: 'package/dist/', type: '5', mode: 0o755 },
    { name: 'package/native/', type: '5', mode: 0o755 },
    ...entriesFor('boxlite-sdk', version),
  ];
  const release = makeRelease({
    version,
    archiveEntries: { 'boxlite-sdk': sdkEntries },
  });
  const fixture = makeFetch(release.archives);

  const result = await installRuntime({
    stateDir,
    manifests: release.manifests,
    fetch: fixture.fetch,
  });

  assertInstalledPaths(result, stateDir);
});

test('accepts pax path and size overrides', async (t) => {
  const stateDir = path.join(tempDirectory(t, 'pax'), 'state');
  const version = '0.1.0';
  const expected = entriesFor('boxlite-sdk', version);
  const target = expected[1];
  const pax = [
    paxRecord('path', target.name),
    paxRecord('size', String(target.content.length)),
  ].join('');
  const sdkEntries = [
    expected[0],
    { name: 'PaxHeader', type: 'x', content: Buffer.from(pax) },
    { name: 'truncated-name', mode: target.mode, content: target.content },
    ...expected.slice(2),
  ];
  const release = makeRelease({
    version,
    archiveEntries: { 'boxlite-sdk': sdkEntries },
  });

  const result = await installRuntime({
    stateDir,
    manifests: release.manifests,
    fetch: makeFetch(release.archives).fetch,
  });

  assertInstalledPaths(result, stateDir);
  assert.equal(
    fs.readFileSync(path.join(result.paths.sdk, 'dist', 'index.js'), 'utf8'),
    target.content.toString('utf8')
  );
});

test('rejects a non-gzip archive without leaving partial state', async (t) => {
  const stateDir = path.join(tempDirectory(t, 'gzip'), 'state');
  const release = makeRelease({ version: '0.1.0' });
  const sdkUrl = release.manifests['boxlite-sdk'].url;
  const bad = Buffer.from('this is not a gzip archive');
  release.archives[sdkUrl] = bad;
  release.manifests['boxlite-sdk'].bytes = bad.length;
  release.manifests['boxlite-sdk'].sha256 = sha256(bad);

  await assert.rejects(
    installRuntime({
      stateDir,
      manifests: release.manifests,
      fetch: makeFetch(release.archives).fetch,
    })
  );

  assert.deepEqual(releaseDirectories(stateDir), []);
  assert.deepEqual(stagingEntries(stateDir), []);
  assert.deepEqual(await listRuntimes({ stateDir }), {
    active: null,
    previous: null,
    runtimes: [],
  });
});

test('accepts GNU long name headers', async (t) => {
  const stateDir = path.join(tempDirectory(t, 'longname'), 'state');
  const version = '0.1.0';
  const expected = entriesFor('boxlite-sdk', version);
  const target = expected[1];
  const sdkEntries = [
    expected[0],
    {
      name: 'LongLink',
      type: 'L',
      content: Buffer.from(`${target.name}\0`),
    },
    { name: 'truncated-name', mode: target.mode, content: target.content },
    ...expected.slice(2),
  ];
  const release = makeRelease({
    version,
    archiveEntries: { 'boxlite-sdk': sdkEntries },
  });

  const result = await installRuntime({
    stateDir,
    manifests: release.manifests,
    fetch: makeFetch(release.archives).fetch,
  });

  assertInstalledPaths(result, stateDir);
  assert.equal(
    fs.readFileSync(path.join(result.paths.sdk, 'dist', 'index.js'), 'utf8'),
    target.content.toString('utf8')
  );
});

test('rejects unsupported host profiles and untrusted manifests', async (t) => {
  const stateDir = path.join(tempDirectory(t, 'validation'), 'state');
  const release = makeRelease({ version: '0.1.0' });
  const fixture = makeFetch(release.archives);

  await assert.rejects(
    installRuntime({
      stateDir,
      platform: 'darwin',
      arch: 'arm64',
      manifests: release.manifests,
      fetch: fixture.fetch,
    }),
    (error) => error instanceof RuntimeInstallerError && error.code === 'unsupported_platform'
  );
  await assert.rejects(
    installRuntime({
      stateDir,
      platform: 'linux',
      arch: 'arm64',
      manifests: release.manifests,
      fetch: fixture.fetch,
    }),
    (error) => error instanceof RuntimeInstallerError && error.code === 'unsupported_arch'
  );
  await assert.rejects(
    installRuntime({
      stateDir,
      engine: 'other',
      manifests: release.manifests,
      fetch: fixture.fetch,
    }),
    (error) => error instanceof RuntimeInstallerError && error.code === 'unsupported_engine'
  );
  const insecure = JSON.parse(JSON.stringify(release.manifests));
  insecure['iron-proxy'].url = 'http://example.test/releases/iron-proxy-0.1.0.tgz';
  await assert.rejects(
    installRuntime({ stateDir, manifests: insecure, fetch: fixture.fetch }),
    (error) => error instanceof RuntimeInstallerError && error.code === 'manifest_invalid'
  );

  const wrongHost = JSON.parse(JSON.stringify(release.manifests));
  wrongHost['iron-proxy'].allowedHosts = ['other.test'];
  await assert.rejects(
    installRuntime({ stateDir, manifests: wrongHost, fetch: fixture.fetch }),
    (error) => error instanceof RuntimeInstallerError && error.code === 'manifest_invalid'
  );

  const flatSdk = JSON.parse(JSON.stringify(release.manifests));
  flatSdk['boxlite-sdk'].files = flatSdk['boxlite-sdk'].files.map((file) => ({
    ...file,
    path: file.path.slice('package/'.length),
  }));
  await assert.rejects(
    installRuntime({ stateDir, manifests: flatSdk, fetch: fixture.fetch }),
    (error) => error instanceof RuntimeInstallerError && error.code === 'manifest_invalid'
  );

  assert.equal(fixture.requests.length, 0);
  assert.equal(fs.existsSync(stateDir), false);
});

test('follows a redirect to another allowed HTTPS host', async (t) => {
  const stateDir = path.join(tempDirectory(t, 'redirect-ok'), 'state');
  const release = makeRelease({ version: '0.1.0' });
  const ironUrl = release.manifests['iron-proxy'].url;
  const cdnUrl = 'https://cdn.example.test/releases/iron-proxy-0.1.0.tgz';
  release.manifests['iron-proxy'].allowedHosts = ['example.test', 'cdn.example.test'];
  const archives = {
    ...release.archives,
    [cdnUrl]: release.archives[ironUrl],
  };
  const fixture = makeFetch(archives, {
    redirects: { [ironUrl]: cdnUrl },
  });

  const result = await installRuntime({
    stateDir,
    manifests: release.manifests,
    fetch: fixture.fetch,
  });

  assertInstalledPaths(result, stateDir);
  assert.ok(fixture.requests.includes(ironUrl));
  assert.ok(fixture.requests.includes(cdnUrl));
});

test('rejects a redirect to a disallowed host before any request to it', async (t) => {
  const stateDir = path.join(tempDirectory(t, 'redirect'), 'state');
  const release = makeRelease({ version: '0.1.0' });
  const ironUrl = release.manifests['iron-proxy'].url;
  const fixture = makeFetch(release.archives, {
    redirects: { [ironUrl]: 'https://evil.test/steal' },
  });

  await assert.rejects(
    installRuntime({
      stateDir,
      manifests: release.manifests,
      fetch: fixture.fetch,
    }),
    (error) =>
      error instanceof RuntimeInstallerError &&
      error.code === 'artifact_url' &&
      /evil\.test/.test(error.message)
  );

  assert.deepEqual(fixture.requests, [ironUrl]);
  assert.deepEqual(releaseDirectories(stateDir), []);
});

test('reinstalls offline from the verified active set and then from cache', async (t) => {
  const stateDir = path.join(tempDirectory(t, 'offline'), 'state');
  const release = makeRelease({ version: '0.1.0' });
  const fixture = makeFetch(release.archives);
  const first = await installRuntime({
    stateDir,
    manifests: release.manifests,
    fetch: fixture.fetch,
  });
  assertInstalledPaths(first, stateDir);

  const offline = failingFetch();
  const second = await installRuntime({
    stateDir,
    manifests: release.manifests,
    fetch: offline.fetch,
  });
  assert.equal(second.set, first.set);
  assert.equal(offline.calls(), 0);

  fs.rmSync(first.paths.root, { recursive: true, force: true });
  const third = await installRuntime({
    stateDir,
    manifests: release.manifests,
    fetch: offline.fetch,
  });
  assert.equal(third.set, first.set);
  assert.equal(offline.calls(), 0);
  assertInstalledPaths(third, stateDir);
  assert.equal(
    fs.readFileSync(path.join(third.paths.sdk, 'dist', 'index.js'), 'utf8'),
    'sdk-index-0.1.0'
  );
});

test('rejects a corrupt cache entry and refetches only the bad artifact', async (t) => {
  const stateDir = path.join(tempDirectory(t, 'cache'), 'state');
  const release = makeRelease({ version: '0.1.0' });
  const fixture = makeFetch(release.archives);
  const first = await installRuntime({
    stateDir,
    manifests: release.manifests,
    fetch: fixture.fetch,
  });
  const ironUrl = release.manifests['iron-proxy'].url;
  const cachePath = path.join(
    stateDir,
    'runtimes',
    'cache',
    release.manifests['iron-proxy'].sha256
  );
  const original = fs.readFileSync(cachePath);

  fs.writeFileSync(cachePath, Buffer.alloc(original.length, 0x58));
  fs.rmSync(first.paths.root, { recursive: true, force: true });
  const hashRepair = makeFetch(release.archives);
  const second = await installRuntime({
    stateDir,
    manifests: release.manifests,
    fetch: hashRepair.fetch,
  });
  assert.ok(hashRepair.requests.includes(ironUrl));
  assert.equal(sha256(fs.readFileSync(cachePath)), release.manifests['iron-proxy'].sha256);
  assertInstalledPaths(second, stateDir);

  fs.writeFileSync(cachePath, Buffer.concat([original, Buffer.from('extra')]));
  fs.rmSync(second.paths.root, { recursive: true, force: true });
  const sizeRepair = makeFetch(release.archives);
  const third = await installRuntime({
    stateDir,
    manifests: release.manifests,
    fetch: sizeRepair.fetch,
  });
  assert.ok(sizeRepair.requests.includes(ironUrl));
  assert.equal(sha256(fs.readFileSync(cachePath)), release.manifests['iron-proxy'].sha256);
  assertInstalledPaths(third, stateDir);
});

test('bad archive digest leaves the previous set active', async (t) => {
  const stateDir = path.join(tempDirectory(t, 'badhash'), 'state');
  const firstRelease = makeRelease({ version: '0.1.0' });
  const first = await installRuntime({
    stateDir,
    manifests: firstRelease.manifests,
    fetch: makeFetch(firstRelease.archives).fetch,
  });

  const secondRelease = makeRelease({
    version: '0.2.0',
    manifestOverrides: {
      'iron-proxy': { sha256: '0'.repeat(64) },
    },
  });
  await assert.rejects(
    installRuntime({
      stateDir,
      manifests: secondRelease.manifests,
      fetch: makeFetch(secondRelease.archives).fetch,
    }),
    /SHA-256 mismatch/
  );

  const inventory = await listRuntimes({ stateDir });
  assert.equal(inventory.active.id, first.set);
  assert.equal(inventory.previous, null);
  assert.equal(releaseDirectories(stateDir).length, 1);
  assert.equal(
    fs.readFileSync(first.paths.ironProxy, 'utf8'),
    'iron-0.1.0'
  );
});

test('wrong inner archive layout leaves the previous set active', async (t) => {
  const stateDir = path.join(tempDirectory(t, 'layout'), 'state');
  const firstRelease = makeRelease({ version: '0.1.0' });
  const first = await installRuntime({
    stateDir,
    manifests: firstRelease.manifests,
    fetch: makeFetch(firstRelease.archives).fetch,
  });

  const sdkVersion = '0.2.0';
  const expected = entriesFor('boxlite-sdk', sdkVersion);
  const badLayouts = [
    {
      label: 'extra file',
      entries: [...expected, { name: 'package/dist/extra.js', content: Buffer.from('extra') }],
    },
    {
      label: 'unexpected directory',
      entries: [{ name: 'package/extra/', type: '5', mode: 0o755 }, ...expected],
    },
    {
      label: 'symlink',
      entries: expected.map((entry) =>
        entry.name === 'package/dist/index.js'
          ? { name: entry.name, mode: 0o644, type: '2', linkname: '/etc/passwd' }
          : entry
      ),
    },
    {
      label: 'hardlink',
      entries: expected.map((entry) =>
        entry.name === 'package/dist/index.js'
          ? { name: entry.name, mode: 0o644, type: '1', linkname: 'package/dist/agents.js' }
          : entry
      ),
    },
    {
      label: 'device',
      entries: expected.map((entry) =>
        entry.name === 'package/dist/index.js'
          ? { name: entry.name, mode: 0o644, type: '3', linkname: '1,3' }
          : entry
      ),
    },
    {
      label: 'traversal',
      entries: [...expected, { name: '../evil', content: Buffer.from('evil') }],
    },
    {
      label: 'duplicate',
      entries: [...expected, expected[1]],
    },
    {
      label: 'missing file',
      entries: expected.filter((entry) => entry.name !== 'package/dist/agents.js'),
    },
    {
      label: 'size mismatch',
      entries: expected.map((entry) =>
        entry.name === 'package/dist/index.js'
          ? { ...entry, content: Buffer.from('different-length') }
          : entry
      ),
    },
    {
      label: 'mode mismatch',
      entries: expected.map((entry) =>
        entry.name === 'package/dist/index.js'
          ? { ...entry, mode: 0o600 }
          : entry
      ),
    },
  ];

  for (let index = 0; index < badLayouts.length; index += 1) {
    const layout = badLayouts[index];
    const version = `0.2.${index + 1}`;
    const badRelease = makeRelease({
      version,
      archiveEntries: { 'boxlite-sdk': layout.entries },
    });
    await assert.rejects(
      installRuntime({
        stateDir,
        manifests: badRelease.manifests,
        fetch: makeFetch(badRelease.archives).fetch,
      }),
      (error) =>
        error instanceof RuntimeInstallerError &&
        error.code === 'archive_invalid',
      `layout ${layout.label} should be rejected`
    );

    const inventory = await listRuntimes({ stateDir });
    assert.equal(inventory.active.id, first.set, `layout ${layout.label} kept previous active`);
    assert.equal(inventory.previous, null, `layout ${layout.label} kept previous previous`);
    assert.equal(
      releaseDirectories(stateDir).length,
      1,
      `layout ${layout.label} published no release`
    );
    assert.deepEqual(stagingEntries(stateDir), [], `layout ${layout.label} cleaned staging`);
  }
});

test('rollback atomically restores the previous verified set', async (t) => {
  const stateDir = path.join(tempDirectory(t, 'rollback'), 'state');
  const firstRelease = makeRelease({ version: '0.1.0' });
  const secondRelease = makeRelease({ version: '0.2.0' });
  const first = await installRuntime({
    stateDir,
    manifests: firstRelease.manifests,
    fetch: makeFetch(firstRelease.archives).fetch,
  });
  const second = await installRuntime({
    stateDir,
    manifests: secondRelease.manifests,
    fetch: makeFetch(secondRelease.archives).fetch,
  });

  let inventory = await listRuntimes({ stateDir });
  assert.equal(inventory.active.id, second.set);
  assert.equal(inventory.previous.id, first.set);
  assert.equal(inventory.runtimes.length, 2);

  const restored = await rollbackRuntime({ stateDir });
  assert.equal(restored.set, first.set);
  assertInstalledPaths(restored, stateDir);
  assert.ok(fs.statSync(second.paths.root).isDirectory());

  inventory = await listRuntimes({ stateDir });
  assert.equal(inventory.active.id, first.set);
  assert.equal(inventory.previous.id, second.set);

  const toggled = await rollbackRuntime({ stateDir });
  assert.equal(toggled.set, second.set);
  inventory = await listRuntimes({ stateDir });
  assert.equal(inventory.active.id, second.set);
  assert.equal(inventory.previous.id, first.set);
});

test('rollback refuses when no previous set exists', async (t) => {
  const stateDir = path.join(tempDirectory(t, 'noprev'), 'state');
  await assert.rejects(
    rollbackRuntime({ stateDir }),
    (error) => error instanceof RuntimeInstallerError && error.code === 'no_previous'
  );
  assert.deepEqual(await listRuntimes({ stateDir }), {
    active: null,
    previous: null,
    runtimes: [],
  });
});

test('concurrent installs in one process serialize and converge', async (t) => {
  const stateDir = path.join(tempDirectory(t, 'concurrent'), 'state');
  const release = makeRelease({ version: '0.1.0' });
  const fixture = makeFetch(release.archives, { delayMs: 100 });

  const results = await Promise.all([
    installRuntime({
      stateDir,
      manifests: release.manifests,
      fetch: fixture.fetch,
      lockTimeoutMs: 20_000,
    }),
    installRuntime({
      stateDir,
      manifests: release.manifests,
      fetch: fixture.fetch,
      lockTimeoutMs: 20_000,
    }),
  ]);

  assert.equal(results[0].set, results[1].set);
  const inventory = await listRuntimes({ stateDir });
  assert.equal(inventory.active.id, results[0].set);
  assert.equal(inventory.previous, null);
  assert.equal(releaseDirectories(stateDir).length, 1);
  assertInstalledPaths(results[0], stateDir);
});

test('concurrent installs across processes serialize and converge', async (t) => {
  const directory = tempDirectory(t, 'crossproc');
  const stateDir = path.join(directory, 'state');
  const release = makeRelease({ version: '0.1.0' });
  const archiveDirectory = path.join(directory, 'archives');
  fs.mkdirSync(archiveDirectory, { recursive: true, mode: 0o700 });
  const archiveFiles = {};
  for (const [url, archive] of Object.entries(release.archives)) {
    const file = path.join(archiveDirectory, `${sha256(Buffer.from(url))}.tgz`);
    fs.writeFileSync(file, archive, { mode: 0o600 });
    archiveFiles[url] = file;
  }

  const configPath = path.join(directory, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      stateDir,
      manifests: release.manifests,
      archives: archiveFiles,
      delayMs: 150,
    }),
    { mode: 0o600 }
  );

  const childScript = path.join(directory, 'child-install.cjs');
  fs.writeFileSync(
    childScript,
    `'use strict';
const fs = require('node:fs');
const { installRuntime } = require(process.env.INSTALLER);
const config = JSON.parse(fs.readFileSync(process.env.CFG, 'utf8'));
const fetchImpl = async (url) => {
  const file = config.archives[url];
  if (!file) throw new Error('Unexpected URL ' + url);
  await new Promise((resolve) => setTimeout(resolve, config.delayMs));
  const body = fs.readFileSync(file);
  return new Response(body, {
    status: 200,
    headers: { 'content-length': String(body.length) },
  });
};
installRuntime({
  stateDir: config.stateDir,
  platform: 'linux',
  arch: 'x64',
  manifests: config.manifests,
  fetch: fetchImpl,
  lockTimeoutMs: 20000,
}).then((result) => {
  console.log(JSON.stringify({ set: result.set }));
}).catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
`,
    { mode: 0o600 }
  );

  const environment = {
    INSTALLER: INSTALLER_PATH,
    CFG: configPath,
  };
  const [left, right] = await Promise.all([
    runNode(childScript, environment),
    runNode(childScript, environment),
  ]);

  assert.equal(left.code, 0, left.stderr);
  assert.equal(right.code, 0, right.stderr);
  const leftSet = JSON.parse(left.stdout.trim()).set;
  const rightSet = JSON.parse(right.stdout.trim()).set;
  assert.equal(leftSet, rightSet);

  const inventory = await listRuntimes({ stateDir });
  assert.equal(inventory.active.id, leftSet);
  assert.equal(inventory.previous, null);
  assert.equal(releaseDirectories(stateDir).length, 1);
  assert.deepEqual(stagingEntries(stateDir), []);
});

test('busy lock produces an actionable diagnostic without touching active files', async (t) => {
  const stateDir = path.join(tempDirectory(t, 'busy'), 'state');
  const firstRelease = makeRelease({ version: '0.1.0' });
  const first = await installRuntime({
    stateDir,
    manifests: firstRelease.manifests,
    fetch: makeFetch(firstRelease.archives).fetch,
  });

  fs.mkdirSync(path.join(stateDir, 'runtimes'), { recursive: true, mode: 0o700 });
  const guard = acquireProcessGuard(
    path.join(stateDir, 'runtimes', 'install.lock'),
    { failFast: true }
  );
  try {
    await assert.rejects(
      installRuntime({
        stateDir,
        manifests: makeRelease({ version: '0.2.0' }).manifests,
        fetch: makeFetch({}).fetch,
        lockTimeoutMs: 200,
      }),
      (error) =>
        error instanceof RuntimeInstallerError &&
        error.code === 'busy' &&
        /busy/.test(error.message) &&
        /do not delete runtime files/.test(error.message)
    );
    assert.equal(
      fs.readFileSync(first.paths.ironProxy, 'utf8'),
      'iron-0.1.0'
    );
    assert.equal(releaseDirectories(stateDir).length, 1);
  } finally {
    guard.release();
  }

  const secondRelease = makeRelease({ version: '0.2.0' });
  const second = await installRuntime({
    stateDir,
    manifests: secondRelease.manifests,
    fetch: makeFetch(secondRelease.archives).fetch,
  });
  assertInstalledPaths(second, stateDir);
});

test('rejects an insecure state directory and creates a private one', async (t) => {
  const directory = tempDirectory(t, 'privacy');
  const writable = path.join(directory, 'writable');
  fs.mkdirSync(writable, { mode: 0o777 });
  fs.chmodSync(writable, 0o777);
  const release = makeRelease({ version: '0.1.0' });
  await assert.rejects(
    installRuntime({
      stateDir: writable,
      manifests: release.manifests,
      fetch: makeFetch(release.archives).fetch,
    }),
    (error) => error instanceof RuntimeInstallerError && error.code === 'state_dir_insecure'
  );

  const target = path.join(directory, 'target');
  fs.mkdirSync(target, { mode: 0o700 });
  const link = path.join(directory, 'link');
  fs.symlinkSync(target, link);
  await assert.rejects(
    installRuntime({
      stateDir: link,
      manifests: release.manifests,
      fetch: makeFetch(release.archives).fetch,
    }),
    (error) => error instanceof RuntimeInstallerError && error.code === 'state_dir_insecure'
  );

  const fresh = path.join(directory, 'fresh');
  const result = await installRuntime({
    stateDir: fresh,
    manifests: release.manifests,
    fetch: makeFetch(release.archives).fetch,
  });
  assertInstalledPaths(result, fresh);
  assert.equal(fs.statSync(fresh).mode & 0o777, 0o700);
});

test('listRuntimes is empty and read-only for a missing state directory', async (t) => {
  const stateDir = path.join(tempDirectory(t, 'missing'), 'state');
  assert.deepEqual(await listRuntimes({ stateDir }), {
    active: null,
    previous: null,
    runtimes: [],
  });
  assert.equal(fs.existsSync(stateDir), false);
});

test('aborted install performs no request and publishes nothing', async (t) => {
  const stateDir = path.join(tempDirectory(t, 'abort'), 'state');
  const release = makeRelease({ version: '0.1.0' });
  const fixture = makeFetch(release.archives);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    installRuntime({
      stateDir,
      manifests: release.manifests,
      fetch: fixture.fetch,
      signal: controller.signal,
    }),
    (error) => error && error.name === 'AbortError'
  );

  assert.deepEqual(fixture.requests, []);
  assert.deepEqual(releaseDirectories(stateDir), []);
  assert.deepEqual(stagingEntries(stateDir), []);
});

test('cleans interrupted staging and preserves the previous selection', async (t) => {
  const stateDir = path.join(tempDirectory(t, 'staging'), 'state');
  fs.mkdirSync(path.join(stateDir, 'runtimes', 'staging', 'leftover'), {
    recursive: true,
    mode: 0o700,
  });
  fs.writeFileSync(
    path.join(stateDir, 'runtimes', 'staging', 'leftover', 'partial.bin'),
    'partial'
  );

  const release = makeRelease({ version: '0.1.0' });
  const result = await installRuntime({
    stateDir,
    manifests: release.manifests,
    fetch: makeFetch(release.archives).fetch,
  });

  assertInstalledPaths(result, stateDir);
  assert.deepEqual(stagingEntries(stateDir), []);
});

test('requiring the installer never fetches assets', () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => {
    calls += 1;
    throw new Error('fetch during startup');
  };
  try {
    const resolved = require.resolve('../src/runtime-installer.cjs');
    delete require.cache[resolved];
    require(resolved);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls, 0);
});

test('reports a broken active selection to inventory and the doctor CLI', async (t) => {
  const stateDir = tempDirectory(t, 'broken-selection');
  const release = makeRelease({ version: '0.1.0' });
  const installed = await installRuntime({
    stateDir, manifests: release.manifests, fetch: makeFetch(release.archives).fetch,
  });
  fs.unlinkSync(path.join(installed.paths.root, 'metadata.json'));
  await assert.rejects(listRuntimes({ stateDir }), { code: 'runtime_corrupt' });
  const doctor = spawnSync(process.execPath, [
    path.resolve(__dirname, '../bin/alpi-server.cjs'), 'doctor', '--runtime', '--state-dir', stateDir,
  ], { encoding: 'utf8' });
  assert.equal(doctor.status, 1);
  assert.match(doctor.stderr, /runtime_corrupt/);
  assert.equal(doctor.stdout, '');
});
