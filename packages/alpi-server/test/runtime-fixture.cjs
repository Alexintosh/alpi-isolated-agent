'use strict';

// Synthetic runtime fixtures shared by installer and CLI orchestration tests.
// These are ordinary local artifacts; no upstream download or network is used.

const crypto = require('node:crypto');
const zlib = require('node:zlib');

const COMPONENTS = ['iron-proxy', 'boxlite-sdk', 'boxlite-native'];
const TEST_ORIGIN = 'https://example.test';

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
    const content = carriesContent ? Buffer.from(entry.content ?? '') : Buffer.alloc(0);
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
      content: Buffer.from(JSON.stringify({ name: '@boxlite-ai/boxlite-linux-x64-gnu', version })),
    },
    { name: 'package/README.md', mode: 0o644, content: Buffer.from(`native-readme-${version}`) },
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

function makeRelease({ version = '0.1.0', archiveEntries = {} } = {}) {
  const manifests = {};
  const archives = {};
  for (const component of COMPONENTS) {
    const expected = entriesFor(component, version);
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
    };
    archives[url] = archive;
  }
  return { manifests, archives, version };
}

function makeFetch(archives) {
  const requests = [];
  return {
    requests,
    fetch: async (url) => {
      requests.push(url);
      const body = archives[url];
      if (!body) throw new Error(`Unexpected synthetic fetch ${url}`);
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

function statfsWithAvailable(bytes) {
  return async () => ({ bavail: BigInt(bytes), bsize: 1n });
}

function pinnedProfile(name = 'pi-dev', diskMiB = 8192) {
  return {
    name,
    engine: 'boxlite',
    image: 'registry.example/alpi/pi@sha256:' + 'a'.repeat(64),
    projects: ['demo'],
    harnesses: ['pi'],
    providers: [],
    limits: { vcpus: 2, memoryMiB: 2048, diskMiB },
  };
}

module.exports = {
  COMPONENTS,
  TEST_ORIGIN,
  sha256,
  tarArchive,
  entriesFor,
  manifestFiles,
  makeRelease,
  makeFetch,
  failingFetch,
  statfsWithAvailable,
  pinnedProfile,
};
