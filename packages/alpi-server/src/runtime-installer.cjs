'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const { acquireArtifact } = require('./shared/artifact-download.cjs');
const {
  ProcessLockError,
  acquireProcessGuard,
} = require('./process-lock.cjs');

const ENGINE = 'boxlite';
const PLATFORM = 'linux';
const ARCH = 'x64';
const COMPONENT_ORDER = ['iron-proxy', 'boxlite-sdk', 'boxlite-native'];
const MANIFEST_FILES = {
  'iron-proxy': 'iron-linux-x64.json',
  'boxlite-sdk': 'boxlite-sdk-linux-x64.json',
  'boxlite-native': 'boxlite-native-linux-x64.json',
};
const INSTALL_DIRS = {
  'iron-proxy': 'iron-proxy',
  'boxlite-sdk': 'node_modules/@boxlite-ai/boxlite',
  'boxlite-native': 'node_modules/@boxlite-ai/boxlite-linux-x64-gnu',
};
const ARCHIVE_PREFIXES = {
  'iron-proxy': '',
  'boxlite-sdk': 'package/',
  'boxlite-native': 'package/',
};
const MAX_STATE_DIR_LENGTH = 4096;
const MAX_PATH_LENGTH = 4096;
const MAX_PAX_BYTES = 1024 * 1024;
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const LOCK_POLL_MS = 100;
const LIST_LIMIT = 32;
const HOST_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const SET_ID_PATTERN = /^[a-z0-9][a-z0-9.-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

class RuntimeInstallerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RuntimeInstallerError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new RuntimeInstallerError(code, message);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function checkAbort(signal) {
  if (signal && signal.aborted) {
    throw signal.reason || new DOMException('Aborted', 'AbortError');
  }
}

function currentUid() {
  if (typeof process.geteuid === 'function') return process.geteuid();
  if (typeof process.getuid === 'function') return process.getuid();
  return null;
}

async function lstatOrNull(target) {
  try {
    return await fsp.lstat(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function assertStateDirPath(stateDir) {
  if (
    typeof stateDir !== 'string' ||
    stateDir.length === 0 ||
    stateDir.length > MAX_STATE_DIR_LENGTH ||
    stateDir.includes('\u0000')
  ) {
    throw new TypeError('stateDir must be a non-empty filesystem path.');
  }
  if (!path.isAbsolute(stateDir)) {
    throw new TypeError('stateDir must be an absolute path.');
  }
}

function assertTrustedStateDir(stat, label) {
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    fail('state_dir_insecure', `${label} must be a real directory, not a symlink.`);
  }
  const uid = currentUid();
  if (uid !== null && stat.uid !== uid) {
    fail('state_dir_insecure', `${label} must be owned by the service user.`);
  }
  if ((stat.mode & 0o022) !== 0) {
    fail('state_dir_insecure', `${label} must not be writable by group or others.`);
  }
}

function assertPrivateDirStat(stat, label) {
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    fail('state_dir_insecure', `${label} must be a real directory, not a symlink.`);
  }
  const uid = currentUid();
  if (uid !== null && stat.uid !== uid) {
    fail('state_dir_insecure', `${label} must be owned by the service user.`);
  }
  if ((stat.mode & 0o077) !== 0 || (stat.mode & 0o700) !== 0o700) {
    fail('state_dir_insecure', `${label} must be a private owner-only directory.`);
  }
}

async function ensurePrivateDir(directory, mode) {
  const existing = await lstatOrNull(directory);
  if (existing) {
    assertPrivateDirStat(existing, directory);
    return;
  }
  await fsp.mkdir(directory, { recursive: true, mode });
  await fsp.chmod(directory, mode);
  assertPrivateDirStat(await fsp.lstat(directory), directory);
}

async function prepareStateDir(stateDir) {
  assertStateDirPath(stateDir);
  const root = path.resolve(stateDir);
  let stat = await lstatOrNull(root);
  if (!stat) {
    await fsp.mkdir(root, { recursive: true, mode: 0o700 });
    await fsp.chmod(root, 0o700);
    stat = await fsp.lstat(root);
  }
  assertTrustedStateDir(stat, root);

  const runtimes = path.join(root, 'runtimes');
  await ensurePrivateDir(runtimes, 0o700);
  for (const name of ['cache', 'releases', 'staging']) {
    await ensurePrivateDir(path.join(runtimes, name), 0o700);
  }
  return { root, runtimes };
}

function assertSafeRelative(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_PATH_LENGTH ||
    value.includes('\u0000') ||
    value.includes('\\') ||
    value.startsWith('/')
  ) {
    fail('manifest_invalid', 'Runtime paths must be safe relative paths.');
  }
  const parts = value.split('/');
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') {
      fail('manifest_invalid', 'Runtime paths must not contain empty, dot, or parent segments.');
    }
  }
  return value;
}

function assertSafeMemberPath(name, isDirectory) {
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name.length > MAX_PATH_LENGTH ||
    name.includes('\u0000') ||
    name.includes('\\')
  ) {
    fail('archive_invalid', 'Archive member name is unsafe.');
  }
  let value = name;
  if (isDirectory && value.endsWith('/')) value = value.slice(0, -1);
  if (value === '' || value.startsWith('/')) {
    fail('archive_invalid', 'Archive member name must be a relative path.');
  }
  const parts = value.split('/');
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') {
      fail('archive_invalid', 'Archive member name contains an empty, dot, or parent segment.');
    }
  }
}

function parseMode(value) {
  if (typeof value !== 'string' || !/^0[0-7]{3,4}$/.test(value)) {
    fail('manifest_invalid', 'Runtime file mode must be an octal string such as 0644.');
  }
  const mode = parseInt(value, 8);
  if (mode < 0 || mode > 0o7777 || (mode & 0o7000) !== 0 || (mode & 0o022) !== 0) {
    fail('manifest_invalid', 'Runtime file mode is not safe.');
  }
  return mode;
}

function formatMode(mode) {
  return `0${mode.toString(8).padStart(3, '0')}`;
}

function parseTrustedUrl(value) {
  if (typeof value !== 'string' || value.length === 0) {
    fail('manifest_invalid', 'Runtime artifact URL is required.');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('manifest_invalid', 'Runtime artifact URL is invalid.');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    fail('manifest_invalid', 'Runtime artifact URL must be HTTPS without credentials.');
  }
  if (url.port !== '' && url.port !== '443') {
    fail('manifest_invalid', 'Runtime artifact URL must use the default HTTPS port.');
  }
  return url;
}

function validateManifest(input, component) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('manifest_invalid', `Trusted manifest for ${component} is required.`);
  }
  if (input.component !== component) {
    fail('manifest_invalid', `Trusted manifest component must be ${component}.`);
  }
  if (typeof input.version !== 'string' || !VERSION_PATTERN.test(input.version)) {
    fail('manifest_invalid', `Trusted manifest version for ${component} is invalid.`);
  }
  if (input.platform !== PLATFORM || input.architecture !== ARCH) {
    fail('unsupported_platform', `Trusted manifest for ${component} must target Linux x64.`);
  }
  if (typeof input.publisher !== 'string' || input.publisher.length === 0) {
    fail('manifest_invalid', `Trusted manifest publisher for ${component} is required.`);
  }
  if (typeof input.license !== 'string' || input.license.length === 0) {
    fail('manifest_invalid', `Trusted manifest license for ${component} is required.`);
  }

  const url = parseTrustedUrl(input.url);
  if (!Array.isArray(input.allowedHosts) || input.allowedHosts.length === 0 || input.allowedHosts.length > 16) {
    fail('manifest_invalid', `Trusted manifest allowedHosts for ${component} is invalid.`);
  }
  const allowedHosts = [];
  for (const host of input.allowedHosts) {
    if (typeof host !== 'string' || host !== host.toLowerCase() || !HOST_PATTERN.test(host)) {
      fail('manifest_invalid', `Trusted manifest allowed host ${String(host)} is invalid.`);
    }
    allowedHosts.push(host);
  }
  if (!allowedHosts.includes(url.hostname.toLowerCase())) {
    fail('manifest_invalid', `Trusted manifest URL host for ${component} is not allowed.`);
  }

  if (!Number.isSafeInteger(input.bytes) || input.bytes <= 0) {
    fail('manifest_invalid', `Trusted manifest archive size for ${component} is invalid.`);
  }
  if (typeof input.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(input.sha256)) {
    fail('manifest_invalid', `Trusted manifest archive digest for ${component} is invalid.`);
  }

  if (!Array.isArray(input.files) || input.files.length === 0) {
    fail('manifest_invalid', `Trusted manifest file list for ${component} is required.`);
  }
  const seen = new Set();
  let totalBytes = 0;
  const files = input.files.map((file) => {
    if (!file || typeof file !== 'object' || Array.isArray(file)) {
      fail('manifest_invalid', `Trusted manifest file entry for ${component} is invalid.`);
    }
    const filePath = assertSafeRelative(file.path);
    if (seen.has(filePath)) {
      fail('manifest_invalid', `Trusted manifest for ${component} contains duplicate file ${filePath}.`);
    }
    seen.add(filePath);
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) {
      fail('manifest_invalid', `Trusted manifest size for ${filePath} is invalid.`);
    }
    totalBytes += file.bytes;
    if (!Number.isSafeInteger(totalBytes)) {
      fail('manifest_invalid', `Trusted manifest size total for ${component} is invalid.`);
    }
    const mode = parseMode(file.mode);
    if (typeof file.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(file.sha256)) {
      fail('manifest_invalid', `Trusted manifest digest for ${filePath} is invalid.`);
    }
    return {
      path: filePath,
      bytes: file.bytes,
      mode: formatMode(mode),
      sha256: file.sha256.toLowerCase(),
    };
  });

  const prefix = ARCHIVE_PREFIXES[component];
  for (const file of files) {
    if (prefix) {
      if (!file.path.startsWith(prefix) || file.path.length === prefix.length) {
        fail('manifest_invalid', `Trusted manifest for ${component} must use the ${prefix} archive prefix.`);
      }
    } else if (file.path.startsWith('package/')) {
      fail('manifest_invalid', `Trusted manifest for ${component} must be a flat archive.`);
    }
  }

  return {
    component,
    version: input.version,
    platform: PLATFORM,
    architecture: ARCH,
    publisher: input.publisher,
    license: input.license,
    url: url.href,
    allowedHosts,
    bytes: input.bytes,
    sha256: input.sha256.toLowerCase(),
    files,
  };
}

async function loadBuiltinManifests() {
  const directory = path.resolve(__dirname, '..', 'manifests');
  const manifests = {};
  for (const component of COMPONENT_ORDER) {
    const file = path.join(directory, MANIFEST_FILES[component]);
    let parsed;
    try {
      parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch (error) {
      fail('manifest_invalid', `Unable to load trusted manifest ${file}: ${error.message}`);
    }
    manifests[component] = validateManifest(parsed, component);
  }
  return manifests;
}

async function resolveManifests(override) {
  if (override === undefined) return loadBuiltinManifests();
  if (!override || typeof override !== 'object' || Array.isArray(override)) {
    throw new TypeError('manifests must be a trusted manifest object.');
  }
  const keys = Object.keys(override);
  if (keys.length !== COMPONENT_ORDER.length) {
    fail('manifest_invalid', 'A trusted manifest is required for every runtime component.');
  }
  for (const key of keys) {
    if (!COMPONENT_ORDER.includes(key)) {
      fail('manifest_invalid', `Unexpected trusted manifest component ${key}.`);
    }
  }
  const manifests = {};
  for (const component of COMPONENT_ORDER) {
    if (!Object.prototype.hasOwnProperty.call(override, component)) {
      fail('manifest_invalid', `Trusted manifest for ${component} is required.`);
    }
    manifests[component] = validateManifest(override[component], component);
  }
  return manifests;
}

function computeSetId(manifests) {
  const hash = crypto.createHash('sha256');
  for (const component of COMPONENT_ORDER) {
    hash.update(`${component}:${manifests[component].sha256}\n`);
  }
  const digest = hash.digest('hex').slice(0, 16);
  const version = manifests['boxlite-sdk'].version.replace(/[^0-9A-Za-z.-]/g, '-');
  return `${ENGINE}-${version}-${digest}`;
}

function isSafeSetId(value) {
  return typeof value === 'string' && SET_ID_PATTERN.test(value);
}

function releaseDirFor(root, setId) {
  if (!isSafeSetId(setId)) {
    fail('runtime_corrupt', 'Runtime set identifier is invalid.');
  }
  return path.join(root, 'runtimes', 'releases', setId);
}

function installDirFor(component) {
  return INSTALL_DIRS[component];
}

function archivePrefixFor(component) {
  return ARCHIVE_PREFIXES[component];
}

function stripArchivePrefix(component, archivePath) {
  const prefix = archivePrefixFor(component);
  if (!prefix) return archivePath;
  if (!archivePath.startsWith(prefix)) {
    fail('archive_invalid', `Archive member ${archivePath} does not use the ${prefix} prefix.`);
  }
  const relative = archivePath.slice(prefix.length);
  if (!relative) {
    fail('archive_invalid', `Archive member ${archivePath} has no package-relative path.`);
  }
  return relative;
}

function installedPathFor(component, archivePath) {
  const relative = stripArchivePrefix(component, archivePath);
  return assertSafeRelative(`${installDirFor(component)}/${relative}`);
}

function buildComponents(manifests) {
  return COMPONENT_ORDER.map((component) => {
    const manifest = manifests[component];
    const installDir = installDirFor(component);
    const files = manifest.files.map((file) => ({
      path: installedPathFor(component, file.path),
      bytes: file.bytes,
      mode: file.mode,
      sha256: file.sha256,
    }));
    return {
      component,
      version: manifest.version,
      archiveSha256: manifest.sha256,
      archiveBytes: manifest.bytes,
      installDir,
      files,
    };
  });
}

function buildMetadata(setId, manifests) {
  return {
    format: 1,
    id: setId,
    engine: ENGINE,
    version: manifests['boxlite-sdk'].version,
    installedAt: new Date().toISOString(),
    components: buildComponents(manifests),
  };
}

function validateMetadata(meta, setId) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    fail('runtime_corrupt', `Runtime metadata for ${setId} is invalid.`);
  }
  if (meta.format !== 1 || meta.id !== setId || meta.engine !== ENGINE) {
    fail('runtime_corrupt', `Runtime metadata for ${setId} has an unsupported format.`);
  }
  if (typeof meta.version !== 'string' || !VERSION_PATTERN.test(meta.version)) {
    fail('runtime_corrupt', `Runtime metadata for ${setId} has an invalid version.`);
  }
  if (typeof meta.installedAt !== 'string' || Number.isNaN(Date.parse(meta.installedAt))) {
    fail('runtime_corrupt', `Runtime metadata for ${setId} has an invalid install time.`);
  }
  if (!Array.isArray(meta.components) || meta.components.length !== COMPONENT_ORDER.length) {
    fail('runtime_corrupt', `Runtime metadata for ${setId} has an invalid component list.`);
  }

  const seenComponents = new Set();
  const seenFiles = new Set();
  for (const component of meta.components) {
    if (!component || typeof component !== 'object' || Array.isArray(component)) {
      fail('runtime_corrupt', `Runtime metadata for ${setId} has an invalid component.`);
    }
    if (!COMPONENT_ORDER.includes(component.component) || seenComponents.has(component.component)) {
      fail('runtime_corrupt', `Runtime metadata for ${setId} has an unexpected component.`);
    }
    seenComponents.add(component.component);
    if (typeof component.version !== 'string' || !VERSION_PATTERN.test(component.version)) {
      fail('runtime_corrupt', `Runtime metadata for ${setId} has an invalid component version.`);
    }
    if (typeof component.archiveSha256 !== 'string' || !SHA256_PATTERN.test(component.archiveSha256)) {
      fail('runtime_corrupt', `Runtime metadata for ${setId} has an invalid archive digest.`);
    }
    if (!Number.isSafeInteger(component.archiveBytes) || component.archiveBytes <= 0) {
      fail('runtime_corrupt', `Runtime metadata for ${setId} has an invalid archive size.`);
    }
    if (component.installDir !== installDirFor(component.component)) {
      fail('runtime_corrupt', `Runtime metadata for ${setId} has an unexpected install directory.`);
    }
    if (!Array.isArray(component.files) || component.files.length === 0) {
      fail('runtime_corrupt', `Runtime metadata for ${setId} has an invalid file list.`);
    }
    for (const file of component.files) {
      if (!file || typeof file !== 'object' || Array.isArray(file)) {
        fail('runtime_corrupt', `Runtime metadata for ${setId} has an invalid file entry.`);
      }
      const filePath = assertSafeRelative(file.path);
      if (!filePath.startsWith(`${component.installDir}/`) || seenFiles.has(filePath)) {
        fail('runtime_corrupt', `Runtime metadata for ${setId} has an unexpected installed file.`);
      }
      seenFiles.add(filePath);
      if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) {
        fail('runtime_corrupt', `Runtime metadata for ${setId} has an invalid file size.`);
      }
      parseMode(file.mode);
      if (typeof file.sha256 !== 'string' || !SHA256_PATTERN.test(file.sha256)) {
        fail('runtime_corrupt', `Runtime metadata for ${setId} has an invalid file digest.`);
      }
    }
  }
  if (seenComponents.size !== COMPONENT_ORDER.length) {
    fail('runtime_corrupt', `Runtime metadata for ${setId} is missing a component.`);
  }
}

function assertMetadataMatchesManifests(meta, manifests) {
  const expected = buildComponents(manifests);
  for (const expectedComponent of expected) {
    const actual = meta.components.find((component) => component.component === expectedComponent.component);
    if (
      !actual ||
      actual.version !== expectedComponent.version ||
      actual.archiveSha256 !== expectedComponent.archiveSha256 ||
      actual.archiveBytes !== expectedComponent.archiveBytes ||
      actual.installDir !== expectedComponent.installDir
    ) {
      fail('runtime_corrupt', `Installed runtime set does not match the trusted manifest for ${expectedComponent.component}.`);
    }
    if (actual.files.length !== expectedComponent.files.length) {
      fail('runtime_corrupt', `Installed runtime set has an unexpected file count for ${expectedComponent.component}.`);
    }
    const actualFiles = new Map(actual.files.map((file) => [file.path, file]));
    for (const expectedFile of expectedComponent.files) {
      const actualFile = actualFiles.get(expectedFile.path);
      if (
        !actualFile ||
        actualFile.bytes !== expectedFile.bytes ||
        actualFile.mode !== expectedFile.mode ||
        actualFile.sha256 !== expectedFile.sha256
      ) {
        fail('runtime_corrupt', `Installed runtime set does not match the trusted manifest for ${expectedFile.path}.`);
      }
    }
  }
}

async function readTextNoFollow(file) {
  const handle = await fsp.open(
    file,
    fs.constants.O_RDONLY |
      (fs.constants.O_NOFOLLOW || 0) |
      (fs.constants.O_NONBLOCK || 0)
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      fail('runtime_corrupt', `${file} is not a regular file.`);
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

async function readSelection(root) {
  const file = path.join(root, 'runtimes', 'current.json');
  let raw;
  try {
    raw = await readTextNoFollow(file);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { format: 1, active: null, previous: null, updatedAt: null };
    }
    if (error && error.code === 'ELOOP') {
      fail('state_dir_insecure', 'Runtime selection must not be a symlink.');
    }
    throw error;
  }
  let selection;
  try {
    selection = JSON.parse(raw);
  } catch {
    fail('runtime_corrupt', 'Runtime selection is not valid JSON.');
  }
  if (!selection || typeof selection !== 'object' || selection.format !== 1) {
    fail('runtime_corrupt', 'Runtime selection has an unsupported format.');
  }
  if (selection.active !== null && !isSafeSetId(selection.active)) {
    fail('runtime_corrupt', 'Runtime selection has an invalid active set.');
  }
  if (selection.previous !== null && !isSafeSetId(selection.previous)) {
    fail('runtime_corrupt', 'Runtime selection has an invalid previous set.');
  }
  if (selection.active !== null && selection.active === selection.previous) {
    fail('runtime_corrupt', 'Runtime selection active and previous sets must differ.');
  }
  return {
    format: 1,
    active: selection.active ?? null,
    previous: selection.previous ?? null,
    updatedAt: typeof selection.updatedAt === 'string' ? selection.updatedAt : null,
  };
}

async function fsyncDirectory(directory) {
  const handle = await fsp.open(directory, 'r');
  try {
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EBADF'].includes(error.code)) {
      throw error;
    }
  } finally {
    await handle.close();
  }
}

async function writeSelection(root, selection) {
  const directory = path.join(root, 'runtimes');
  const destination = path.join(directory, 'current.json');
  const temporary = path.join(
    directory,
    `.current.${crypto.randomBytes(16).toString('hex')}.tmp`
  );
  const handle = await fsp.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(selection, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fsp.rename(temporary, destination);
    await fsyncDirectory(directory);
  } finally {
    await fsp.unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

async function syncTree(directory) {
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await syncTree(path.join(directory, entry.name));
    }
  }
  await fsyncDirectory(directory);
}

async function walkInstalledTree(root) {
  const results = [];
  async function walk(directory, relative) {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
      const stat = await fsp.lstat(fullPath);
      if (stat.isSymbolicLink()) {
        fail('runtime_corrupt', `Runtime set contains a symlink: ${relativePath}`);
      }
      if (stat.isDirectory()) {
        await walk(fullPath, relativePath);
      } else if (stat.isFile()) {
        results.push({ path: relativePath, fullPath, stat });
      } else {
        fail('runtime_corrupt', `Runtime set contains a non-regular file: ${relativePath}`);
      }
    }
  }
  await walk(root, '');
  return results;
}

async function verifyInstalledFile(fullPath, expected) {
  const handle = await fsp.open(
    fullPath,
    fs.constants.O_RDONLY |
      (fs.constants.O_NOFOLLOW || 0) |
      (fs.constants.O_NONBLOCK || 0)
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== expected.bytes) {
      fail('runtime_corrupt', `Installed file ${expected.path} has an unexpected size.`);
    }
    if ((stat.mode & 0o7777) !== parseMode(expected.mode)) {
      fail('runtime_corrupt', `Installed file ${expected.path} has an unexpected mode.`);
    }
    const hash = crypto.createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
    }
    if (hash.digest('hex') !== expected.sha256) {
      fail('runtime_corrupt', `Installed file ${expected.path} failed its SHA-256 check.`);
    }
  } finally {
    await handle.close();
  }
}

async function verifyInstalledTree(directory, meta) {
  const expected = new Map();
  expected.set('metadata.json', null);
  for (const component of meta.components) {
    for (const file of component.files) {
      if (expected.has(file.path)) {
        fail('runtime_corrupt', `Runtime metadata contains duplicate file ${file.path}.`);
      }
      expected.set(file.path, file);
    }
  }

  const actual = new Map();
  for (const entry of await walkInstalledTree(directory)) {
    actual.set(entry.path, entry);
  }
  for (const [filePath, expectedFile] of expected) {
    const entry = actual.get(filePath);
    if (!entry) {
      fail('runtime_corrupt', `Installed runtime set is missing ${filePath}.`);
    }
    if (filePath === 'metadata.json') {
      if (!entry.stat.isFile()) {
        fail('runtime_corrupt', 'Runtime metadata is not a regular file.');
      }
    } else {
      await verifyInstalledFile(entry.fullPath, expectedFile);
    }
    actual.delete(filePath);
  }
  if (actual.size > 0) {
    fail('runtime_corrupt', `Installed runtime set has unexpected file ${[...actual.keys()][0]}.`);
  }
}

async function verifyReleaseSet(root, setId, manifests) {
  const directory = releaseDirFor(root, setId);
  const raw = await readTextNoFollow(path.join(directory, 'metadata.json'));
  let meta;
  try {
    meta = JSON.parse(raw);
  } catch {
    fail('runtime_corrupt', `Runtime metadata for ${setId} is not valid JSON.`);
  }
  validateMetadata(meta, setId);
  if (manifests) assertMetadataMatchesManifests(meta, manifests);
  await verifyInstalledTree(directory, meta);
  return meta;
}

async function inspectRelease(root, setId, manifests) {
  const directory = releaseDirFor(root, setId);
  const stat = await lstatOrNull(directory);
  if (!stat) {
    return { exists: false, valid: false, meta: null, error: null };
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    return {
      exists: true,
      valid: false,
      meta: null,
      error: new RuntimeInstallerError(
        'runtime_corrupt',
        `Runtime release ${setId} is not a real directory.`
      ),
    };
  }
  try {
    const meta = await verifyReleaseSet(root, setId, manifests);
    return { exists: true, valid: true, meta, error: null };
  } catch (error) {
    return { exists: true, valid: false, meta: null, error };
  }
}

async function selectSet(root, current, setId) {
  let previous = current.previous;
  if (current.active && current.active !== setId) previous = current.active;
  if (previous === setId) previous = null;
  if (previous) {
    const inspected = await inspectRelease(root, previous, null);
    if (!inspected.valid) previous = null;
  }
  await writeSelection(root, {
    format: 1,
    active: setId,
    previous,
    updatedAt: new Date().toISOString(),
  });
}

function buildResult(root, meta) {
  const directory = releaseDirFor(root, meta.id);
  return {
    engine: meta.engine,
    version: meta.version,
    set: meta.id,
    installedAt: meta.installedAt,
    paths: {
      root: directory,
      ironProxy: path.join(directory, 'iron-proxy', 'iron-proxy'),
      sdk: path.join(directory, 'node_modules', '@boxlite-ai', 'boxlite'),
      native: path.join(directory, 'node_modules', '@boxlite-ai', 'boxlite-linux-x64-gnu'),
    },
    components: meta.components.map((component) => ({
      component: component.component,
      version: component.version,
      bytes: component.archiveBytes,
    })),
  };
}

function paddingFor(size) {
  return (512 - (size % 512)) % 512;
}

function parseTarNumber(field) {
  if ((field[0] & 0x80) !== 0) {
    if ((field[0] & 0x40) !== 0) {
      fail('archive_invalid', 'Tar numeric field is negative.');
    }
    let value = 0n;
    for (let index = 0; index < field.length; index += 1) {
      let byte = BigInt(field[index]);
      if (index === 0) byte &= 0x7fn;
      value = (value << 8n) | byte;
    }
    const number = Number(value);
    if (!Number.isSafeInteger(number)) {
      fail('archive_invalid', 'Tar numeric field is too large.');
    }
    return number;
  }
  const text = field.toString('ascii').replace(/\0.*$/, '').trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) {
    fail('archive_invalid', 'Tar numeric field is not octal.');
  }
  const number = parseInt(text, 8);
  if (!Number.isSafeInteger(number)) {
    fail('archive_invalid', 'Tar numeric field is too large.');
  }
  return number;
}

function readCString(block, offset, length) {
  const slice = block.subarray(offset, offset + length);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? slice.length : nul).toString('utf8');
}

function parseTarHeader(block) {
  const stored = parseTarNumber(block.subarray(148, 156));
  let unsigned = 0;
  let signed = 0;
  for (let index = 0; index < 512; index += 1) {
    const value = index >= 148 && index < 156 ? 0x20 : block[index];
    unsigned += value;
    signed += value > 127 ? value - 256 : value;
  }
  if (stored !== unsigned && stored !== signed) {
    fail('archive_invalid', 'Tar header checksum is invalid.');
  }

  const name = readCString(block, 0, 100);
  const mode = parseTarNumber(block.subarray(100, 108));
  const size = parseTarNumber(block.subarray(124, 136));
  const type = block[156] === 0 ? '0' : String.fromCharCode(block[156]);
  const magic = block.subarray(257, 263).toString('latin1');
  const prefix = readCString(block, 345, 155);
  const fullName = magic.startsWith('ustar') && prefix ? `${prefix}/${name}` : name;
  return { name: fullName, mode, size, type };
}

function parsePax(data) {
  const records = {};
  let position = 0;
  while (position < data.length) {
    const space = data.indexOf(0x20, position);
    if (space === -1) {
      fail('archive_invalid', 'Pax header is malformed.');
    }
    const lengthText = data.toString('ascii', position, space);
    if (!/^\d+$/.test(lengthText)) {
      fail('archive_invalid', 'Pax header record length is invalid.');
    }
    const length = Number(lengthText);
    if (
      !Number.isSafeInteger(length) ||
      length <= 0 ||
      position + length > data.length
    ) {
      fail('archive_invalid', 'Pax header record length is invalid.');
    }
    const record = data.toString('utf8', space + 1, position + length);
    if (!record.endsWith('\n')) {
      fail('archive_invalid', 'Pax header record is malformed.');
    }
    const equals = record.indexOf('=');
    if (equals <= 0) {
      fail('archive_invalid', 'Pax header record is malformed.');
    }
    records[record.slice(0, equals)] = record.slice(equals + 1, -1);
    position += length;
  }
  return records;
}

class TarGzReader {
  constructor(archiveHandle, signal) {
    this.handle = archiveHandle;
    this.signal = signal;
    this.stream = archiveHandle.createReadStream({ autoClose: false });
    this.gunzip = zlib.createGunzip();
    this.stream.on('error', (error) => this.gunzip.destroy(error));
    this.gunzip.on('error', () => {});
    this.stream.pipe(this.gunzip);
    this.iterator = this.gunzip[Symbol.asyncIterator]();
    this.chunks = [];
    this.length = 0;
    this.ended = false;
    this.closed = false;
  }

  checkAbort() {
    checkAbort(this.signal);
  }

  async pull() {
    this.checkAbort();
    if (this.ended) return false;
    let result;
    try {
      result = await this.iterator.next();
    } catch (error) {
      await this.close();
      throw error;
    }
    if (result.done) {
      this.ended = true;
      return false;
    }
    const chunk = Buffer.isBuffer(result.value)
      ? result.value
      : Buffer.from(result.value);
    if (chunk.length === 0) return true;
    this.chunks.push(chunk);
    this.length += chunk.length;
    return true;
  }

  async ensure(length) {
    while (this.length < length) {
      if (!(await this.pull())) {
        fail('archive_invalid', 'Tar archive ended unexpectedly.');
      }
    }
  }

  async readExact(length) {
    await this.ensure(length);
    const output = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const head = this.chunks[0];
      const take = Math.min(head.length, length - offset);
      head.copy(output, offset, 0, take);
      if (take === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
      this.length -= take;
      offset += take;
    }
    return output;
  }

  async readUpTo(length) {
    while (this.length === 0) {
      if (!(await this.pull())) return null;
    }
    const head = this.chunks[0];
    const take = Math.min(head.length, length);
    let output;
    if (take === head.length) {
      output = head;
      this.chunks.shift();
    } else {
      output = head.subarray(0, take);
      this.chunks[0] = head.subarray(take);
    }
    this.length -= take;
    return output;
  }

  async discard(length) {
    let remaining = length;
    while (remaining > 0) {
      const chunk = await this.readUpTo(Math.min(remaining, 64 * 1024));
      if (!chunk) {
        fail('archive_invalid', 'Tar archive ended unexpectedly.');
      }
      remaining -= chunk.length;
    }
  }

  async readZero(length) {
    let remaining = length;
    while (remaining > 0) {
      const chunk = await this.readUpTo(Math.min(remaining, 64 * 1024));
      if (!chunk) {
        fail('archive_invalid', 'Tar archive ended unexpectedly.');
      }
      if (chunk.some((byte) => byte !== 0)) {
        fail('archive_invalid', 'Tar padding is not zero.');
      }
      remaining -= chunk.length;
    }
  }

  async assertZeroTail() {
    for (;;) {
      const chunk = await this.readUpTo(64 * 1024);
      if (!chunk) return;
      if (chunk.some((byte) => byte !== 0)) {
        fail('archive_invalid', 'Tar archive has non-zero trailing data.');
      }
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.gunzip.destroy();
    this.stream.destroy();
    await this.handle.close().catch(() => {});
  }
}

function isAllowedDirectory(name, allowed) {
  for (const filePath of allowed.keys()) {
    if (filePath === name || filePath.startsWith(`${name}/`)) return true;
  }
  return false;
}

function assertInside(root, destination) {
  const resolvedRoot = path.resolve(root);
  const resolvedDestination = path.resolve(destination);
  if (
    resolvedDestination !== resolvedRoot &&
    !resolvedDestination.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    fail('archive_invalid', 'Archive member resolves outside its install directory.');
  }
}

async function ensureDirectory(directory) {
  const stat = await lstatOrNull(directory);
  if (stat) {
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail('archive_invalid', `${directory} is not a real directory.`);
    }
    return;
  }
  await fsp.mkdir(directory, { recursive: true, mode: 0o755 });
}

async function writeExtractedFile(reader, destination, expected, signal) {
  const mode = parseMode(expected.mode);
  let handle;
  let success = false;
  try {
    handle = await fsp.open(destination, 'wx', mode);
    const hash = crypto.createHash('sha256');
    let remaining = expected.bytes;
    while (remaining > 0) {
      checkAbort(signal);
      const chunk = await reader.readUpTo(Math.min(remaining, 1024 * 1024));
      if (!chunk) {
        fail('archive_invalid', `Tar archive ended before ${expected.path}.`);
      }
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const result = await handle.write(chunk, offset, chunk.length - offset);
        offset += result.bytesWritten;
      }
      remaining -= chunk.length;
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (hash.digest('hex') !== expected.sha256) {
      fail('archive_invalid', `Archive member ${expected.path} failed its SHA-256 check.`);
    }
    await fsp.chmod(destination, mode);
    success = true;
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (!success) await fsp.unlink(destination).catch(() => {});
  }
}

async function extractTarGz({ archivePath, manifest, destinationRoot, signal }) {
  const allowed = new Map();
  for (const file of manifest.files) allowed.set(file.path, file);
  const seen = new Set();
  const extracted = new Set();
  const maxBytes = manifest.files.reduce((total, file) => total + file.bytes, 0);
  let receivedBytes = 0;
  const archiveHandle = await fsp.open(
    archivePath,
    fs.constants.O_RDONLY |
      (fs.constants.O_NOFOLLOW || 0) |
      (fs.constants.O_NONBLOCK || 0)
  );
  let reader;
  let pendingPax = {};
  let pendingLongName = null;

  try {
    const archiveStat = await archiveHandle.stat();
    if (!archiveStat.isFile()) {
      fail('archive_invalid', `Archive ${archivePath} is not a regular file.`);
    }
    reader = new TarGzReader(archiveHandle, signal);
    for (;;) {
      const block = await reader.readExact(512);
      if (block.every((byte) => byte === 0)) break;

      const header = parseTarHeader(block);
      if (header.type === 'x' || header.type === 'g') {
        if (header.size > MAX_PAX_BYTES) {
          fail('archive_invalid', 'Pax header is too large.');
        }
        const data = await reader.readExact(header.size);
        await reader.readZero(paddingFor(header.size));
        if (header.type === 'x') {
          pendingPax = { ...pendingPax, ...parsePax(data) };
        }
        continue;
      }
      if (header.type === 'L') {
        if (header.size > MAX_PAX_BYTES) {
          fail('archive_invalid', 'GNU long name header is too large.');
        }
        const data = await reader.readExact(header.size);
        await reader.readZero(paddingFor(header.size));
        pendingLongName = readCString(data, 0, data.length);
        continue;
      }
      if (header.type === 'K') {
        fail('archive_invalid', 'Tar archive contains a GNU long link.');
      }

      let name = header.name;
      let size = header.size;
      if (pendingPax.path !== undefined) name = pendingPax.path;
      else if (pendingLongName !== null) name = pendingLongName;
      if (pendingPax.size !== undefined) {
        if (!/^\d+$/.test(pendingPax.size)) {
          fail('archive_invalid', 'Pax size is invalid.');
        }
        size = Number(pendingPax.size);
        if (!Number.isSafeInteger(size)) {
          fail('archive_invalid', 'Pax size is too large.');
        }
      }
      const pax = pendingPax;
      pendingPax = {};
      pendingLongName = null;
      if (pax.linkpath !== undefined) {
        fail('archive_invalid', 'Tar archive contains a link.');
      }

      if (header.type === '5') {
        assertSafeMemberPath(name, true);
        const directoryName = name.endsWith('/') ? name.slice(0, -1) : name;
        assertSafeMemberPath(directoryName, false);
        if (seen.has(directoryName)) {
          fail('archive_invalid', `Tar archive contains duplicate member ${directoryName}.`);
        }
        seen.add(directoryName);
        if (size !== 0) {
          fail('archive_invalid', 'Tar directory member has data.');
        }
        if (!isAllowedDirectory(directoryName, allowed)) {
          fail('archive_invalid', `Tar archive contains unexpected directory ${directoryName}.`);
        }
        continue;
      }
      if (header.type !== '0' && header.type !== '\0') {
        fail('archive_invalid', `Tar archive contains unsupported member type ${header.type}.`);
      }

      assertSafeMemberPath(name, false);
      if (seen.has(name)) {
        fail('archive_invalid', `Tar archive contains duplicate member ${name}.`);
      }
      seen.add(name);

      const expected = allowed.get(name);
      if (!expected) {
        fail('archive_invalid', `Tar archive contains unexpected file ${name}.`);
      }
      if (size !== expected.bytes) {
        fail('archive_invalid', `Tar member ${name} has an unexpected size.`);
      }
      if ((header.mode & 0o7777) !== parseMode(expected.mode)) {
        fail('archive_invalid', `Tar member ${name} has an unexpected mode.`);
      }

      const relative = stripArchivePrefix(manifest.component, name);
      assertSafeRelative(relative);
      const destination = path.join(destinationRoot, relative);
      assertInside(destinationRoot, destination);
      await ensureDirectory(path.dirname(destination));
      await writeExtractedFile(reader, destination, expected, signal);
      await reader.readZero(paddingFor(size));
      receivedBytes += size;
      if (receivedBytes > maxBytes) {
        fail('archive_invalid', 'Tar archive exceeds the trusted manifest byte total.');
      }
      extracted.add(name);
    }
    await reader.assertZeroTail();
  } catch (error) {
    if (!reader) await archiveHandle.close().catch(() => {});
    throw error;
  } finally {
    if (reader) await reader.close();
  }

  for (const name of allowed.keys()) {
    if (!extracted.has(name)) {
      fail('archive_invalid', `Tar archive is missing ${name}.`);
    }
  }
  if (extracted.size !== allowed.size) {
    fail('archive_invalid', 'Tar archive does not match the trusted manifest file set.');
  }
}

async function cachedArtifactIsValid(cachePath, manifest, signal) {
  let handle;
  try {
    handle = await fsp.open(
      cachePath,
      fs.constants.O_RDONLY |
        (fs.constants.O_NOFOLLOW || 0) |
        (fs.constants.O_NONBLOCK || 0)
    );
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    if (error && error.code === 'ELOOP') {
      fail('state_dir_insecure', `Cache entry ${cachePath} is a symlink.`);
    }
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      fail('cache_invalid', `Cache entry ${cachePath} is not a regular file.`);
    }
    if (stat.size !== manifest.bytes) return false;
    const hash = crypto.createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false, signal })) {
      hash.update(chunk);
    }
    return hash.digest('hex') === manifest.sha256;
  } finally {
    await handle.close();
  }
}

async function removeInvalidCacheEntry(cachePath) {
  const stat = await lstatOrNull(cachePath);
  if (!stat) return;
  if (stat.isSymbolicLink()) {
    fail('state_dir_insecure', `Cache entry ${cachePath} is a symlink.`);
  }
  if (!stat.isFile()) {
    fail('cache_invalid', `Cache entry ${cachePath} is not a regular file.`);
  }
  await fsp.unlink(cachePath);
}

function makeGuardedFetch(manifest, fetchImpl) {
  const implementation = fetchImpl ?? globalThis.fetch;
  if (typeof implementation !== 'function') {
    fail('invalid_options', 'A fetch implementation is required to install a runtime.');
  }
  const allowedHosts = new Set(manifest.allowedHosts);
  const initialUrl = new URL(manifest.url).href;
  let firstRequest = true;
  return async (input, init) => {
    let url;
    try {
      url = new URL(String(input));
    } catch {
      fail('artifact_url', 'Runtime artifact URL is invalid.');
    }
    if (url.protocol !== 'https:' || url.username || url.password) {
      fail('artifact_url', 'Runtime artifact URL must be HTTPS without credentials.');
    }
    if (url.port !== '' && url.port !== '443') {
      fail('artifact_url', 'Runtime artifact URL must use the default HTTPS port.');
    }
    const host = url.hostname.toLowerCase();
    if (!allowedHosts.has(host)) {
      fail('artifact_url', `Runtime artifact host ${host} is not allowed by the trusted manifest.`);
    }
    if (firstRequest) {
      if (url.href !== initialUrl) {
        fail('artifact_url', 'Runtime artifact URL does not match the trusted manifest.');
      }
      firstRequest = false;
    }
    return implementation(url.href, init);
  };
}

async function ensureCachedArtifact({ cachePath, manifest, fetchImpl, signal }) {
  await ensurePrivateDir(path.dirname(cachePath), 0o700);
  const valid = await cachedArtifactIsValid(cachePath, manifest, signal);
  if (!valid) {
    await removeInvalidCacheEntry(cachePath);
    await acquireArtifact({
      url: manifest.url,
      destination: cachePath,
      sha256: manifest.sha256,
      maxBytes: manifest.bytes,
      signal,
      fetch: makeGuardedFetch(manifest, fetchImpl),
    });
  }
  if (!(await cachedArtifactIsValid(cachePath, manifest, signal))) {
    fail('cache_invalid', `Cached artifact ${cachePath} failed verification.`);
  }
}

async function cleanStaging(runtimes) {
  const directory = path.join(runtimes, 'staging');
  let entries;
  try {
    entries = await fsp.readdir(directory);
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }
  for (const name of entries) {
    const target = path.join(directory, name);
    const stat = await lstatOrNull(target);
    if (!stat) continue;
    if (stat.isSymbolicLink()) await fsp.unlink(target);
    else await fsp.rm(target, { recursive: true, force: true });
  }
}

async function cleanCacheTemps(runtimes) {
  const directory = path.join(runtimes, 'cache');
  let entries;
  try {
    entries = await fsp.readdir(directory);
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }
  for (const name of entries) {
    if (!name.startsWith('.') || !name.endsWith('.tmp')) continue;
    const target = path.join(directory, name);
    const stat = await lstatOrNull(target);
    if (!stat) continue;
    if (stat.isSymbolicLink() || stat.isFile()) await fsp.unlink(target);
  }
}

async function cleanSelectionTemps(runtimes) {
  let entries;
  try {
    entries = await fsp.readdir(runtimes);
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }
  for (const name of entries) {
    if (!name.startsWith('.current.') || !name.endsWith('.tmp')) continue;
    const target = path.join(runtimes, name);
    const stat = await lstatOrNull(target);
    if (!stat) continue;
    if (stat.isSymbolicLink() || stat.isFile()) await fsp.unlink(target);
  }
}

async function discardRelease(root, setId) {
  const directory = releaseDirFor(root, setId);
  const trash = path.join(
    root,
    'runtimes',
    'staging',
    `discard-${setId}-${crypto.randomBytes(8).toString('hex')}`
  );
  try {
    await fsp.rename(directory, trash);
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }
  await fsp.rm(trash, { recursive: true, force: true });
}

async function writeMetadata(stagingDirectory, meta) {
  const file = path.join(stagingDirectory, 'metadata.json');
  const handle = await fsp.open(file, 'wx', 0o644);
  try {
    await handle.writeFile(`${JSON.stringify(meta, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.chmod(file, 0o644);
}

async function publishStaging(stagingDirectory, releaseDirectory, runtimes) {
  if (await lstatOrNull(releaseDirectory)) {
    fail('runtime_corrupt', `Runtime release directory ${releaseDirectory} already exists.`);
  }
  try {
    await fsp.rename(stagingDirectory, releaseDirectory);
  } catch (error) {
    if (error && (error.code === 'EEXIST' || error.code === 'ENOTEMPTY')) {
      fail('runtime_corrupt', `Runtime release directory ${releaseDirectory} already exists.`);
    }
    throw error;
  }
  await fsyncDirectory(path.join(runtimes, 'releases'));
  await fsyncDirectory(path.join(runtimes, 'staging'));
}

async function withInstallLock(root, timeoutMs, signal, fn) {
  const lockPath = path.join(root, 'runtimes', 'install.lock');
  const deadline = Date.now() + timeoutMs;
  let guard;
  for (;;) {
    try {
      guard = acquireProcessGuard(lockPath, { failFast: true });
      break;
    } catch (error) {
      if (error instanceof ProcessLockError && error.code === 'lock_busy') {
        checkAbort(signal);
        if (Date.now() >= deadline) {
          fail(
            'busy',
            `Runtime installation is busy: another install holds ${lockPath}.sqlite. ` +
              'Wait for it to finish or stop the other process; do not delete runtime files.'
          );
        }
        await delay(LOCK_POLL_MS);
        continue;
      }
      if (error instanceof ProcessLockError) {
        fail('lock_unavailable', `Runtime installation lock is unavailable: ${error.message}`);
      }
      throw error;
    }
  }
  try {
    return await fn();
  } finally {
    guard.release();
  }
}

/**
 * Install the pinned BoxLite runtime (Iron proxy, Node SDK, and native addon)
 * beneath stateDir/runtimes. The only accepted artifacts are the trusted
 * manifests shipped with this package, or a trusted manifest object supplied
 * by an embedding caller. The function never accepts a URL or path from an
 * untrusted CLI caller.
 *
 * @param {object} options
 * @param {string} options.stateDir absolute private service state directory
 * @param {'boxlite'} [options.engine]
 * @param {'linux'} [options.platform]
 * @param {'x64'} [options.arch]
 * @param {AbortSignal} [options.signal]
 * @param {typeof fetch} [options.fetch] trusted fetch implementation
 * @param {object} [options.manifests] trusted manifest override for embedders/tests
 * @param {number} [options.lockTimeoutMs] trusted lock wait override for tests
 * @returns {Promise<object>} installed metadata with engine, versions, and paths
 */
async function installRuntime(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('installRuntime options are required.');
  }
  assertStateDirPath(options.stateDir);
  const engine = options.engine ?? ENGINE;
  const platform = options.platform ?? PLATFORM;
  const arch = options.arch ?? ARCH;
  if (engine !== ENGINE) {
    fail('unsupported_engine', `Unsupported runtime engine: ${engine}.`);
  }
  if (platform !== PLATFORM) {
    fail('unsupported_platform', 'Only the built-in Linux runtime is supported.');
  }
  if (arch !== ARCH) {
    fail('unsupported_arch', 'Only the built-in Linux x64 runtime is supported.');
  }
  if (options.signal !== undefined) {
    if (
      typeof options.signal !== 'object' ||
      options.signal === null ||
      typeof options.signal.aborted !== 'boolean'
    ) {
      throw new TypeError('signal must be an AbortSignal.');
    }
  }
  if (options.fetch !== undefined && typeof options.fetch !== 'function') {
    throw new TypeError('fetch must be a function.');
  }
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 0) {
    throw new TypeError('lockTimeoutMs must be a nonnegative integer.');
  }

  const manifests = await resolveManifests(options.manifests);
  const setId = computeSetId(manifests);
  const { root, runtimes } = await prepareStateDir(options.stateDir);
  checkAbort(options.signal);

  return withInstallLock(root, lockTimeoutMs, options.signal, async () => {
    await cleanStaging(runtimes);
    await cleanCacheTemps(runtimes);
    await cleanSelectionTemps(runtimes);
    const current = await readSelection(root);
    const existing = await inspectRelease(root, setId, manifests);
    if (existing.valid) {
      checkAbort(options.signal);
      await selectSet(root, current, setId);
      return buildResult(root, existing.meta);
    }
    if (existing.exists) {
      if (current.active === setId || current.previous === setId) {
        fail(
          'runtime_corrupt',
          `Installed runtime set ${setId} failed verification and is currently active or previous; refusing to overwrite it.`
        );
      }
      await discardRelease(root, setId);
    }

    const cachePaths = new Map();
    for (const component of COMPONENT_ORDER) {
      const manifest = manifests[component];
      const cachePath = path.join(runtimes, 'cache', manifest.sha256);
      await ensureCachedArtifact({
        cachePath,
        manifest,
        fetchImpl: options.fetch,
        signal: options.signal,
      });
      cachePaths.set(component, cachePath);
    }

    const stagingDirectory = path.join(
      runtimes,
      'staging',
      `${setId}.${crypto.randomBytes(8).toString('hex')}`
    );
    await fsp.mkdir(stagingDirectory, { mode: 0o700 });
    try {
      for (const component of COMPONENT_ORDER) {
        const manifest = manifests[component];
        const destinationRoot = path.join(stagingDirectory, installDirFor(component));
        await ensureDirectory(destinationRoot);
        await extractTarGz({
          archivePath: cachePaths.get(component),
          manifest,
          destinationRoot,
          signal: options.signal,
        });
      }
      const meta = buildMetadata(setId, manifests);
      await writeMetadata(stagingDirectory, meta);
      await syncTree(stagingDirectory);
      const releaseDirectory = releaseDirFor(root, setId);
      await publishStaging(stagingDirectory, releaseDirectory, runtimes);
      const verified = await inspectRelease(root, setId, manifests);
      if (!verified.valid) {
        fail('runtime_corrupt', `Published runtime set ${setId} failed verification.`);
      }
      checkAbort(options.signal);
      await selectSet(root, current, setId);
      return buildResult(root, verified.meta);
    } finally {
      await fsp.rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
    }
  });
}

/**
 * List installed runtime sets as bounded, safe public records. The result
 * intentionally omits filesystem paths and never advertises qualified engine,
 * sandbox, KVM, or network capabilities.
 *
 * @param {object} options
 * @param {string} options.stateDir
 * @returns {Promise<{active: object|null, previous: object|null, runtimes: object[]}>}
 */
async function listRuntimes(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('listRuntimes options are required.');
  }
  assertStateDirPath(options.stateDir);
  const root = path.resolve(options.stateDir);
  const rootStat = await lstatOrNull(root);
  if (!rootStat) return { active: null, previous: null, runtimes: [] };
  assertTrustedStateDir(rootStat, root);

  const runtimesDirectory = path.join(root, 'runtimes');
  const runtimesStat = await lstatOrNull(runtimesDirectory);
  if (!runtimesStat) return { active: null, previous: null, runtimes: [] };
  assertPrivateDirStat(runtimesStat, runtimesDirectory);

  const current = await readSelection(root);
  const releasesDirectory = path.join(runtimesDirectory, 'releases');
  let entries = [];
  try {
    entries = await fsp.readdir(releasesDirectory, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') entries = [];
    else throw error;
  }

  const records = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !isSafeSetId(entry.name)) {
      continue;
    }
    let raw;
    try {
      raw = await readTextNoFollow(path.join(releasesDirectory, entry.name, 'metadata.json'));
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ELOOP')) continue;
      throw error;
    }
    let meta;
    try {
      meta = JSON.parse(raw);
      validateMetadata(meta, entry.name);
    } catch {
      continue;
    }
    records.push({
      id: entry.name,
      engine: meta.engine,
      version: meta.version,
      components: meta.components.map((component) => ({
        component: component.component,
        version: component.version,
      })),
      installedAt: meta.installedAt,
    });
  }

  records.sort(
    (left, right) => {
      if (left.id === current.active) return -1;
      if (right.id === current.active) return 1;
      if (left.id === current.previous) return -1;
      if (right.id === current.previous) return 1;
      return (
        (right.installedAt || '').localeCompare(left.installedAt || '') ||
        left.id.localeCompare(right.id)
      );
    }
  );
  const limited = records.slice(0, LIST_LIMIT);
  const activeRecord = limited.find((record) => record.id === current.active) || null;
  const previousRecord = limited.find((record) => record.id === current.previous) || null;
  return {
    active: activeRecord
      ? { ...activeRecord, active: true, previous: false }
      : null,
    previous: previousRecord
      ? { ...previousRecord, active: false, previous: true }
      : null,
    runtimes: limited.map((record) => ({
      ...record,
      active: record.id === current.active,
      previous: record.id === current.previous,
    })),
  };
}

/**
 * Atomically switch the active runtime set back to the previously verified set.
 * The current active set becomes the new previous set when it still verifies.
 * Installed files are never removed by rollback.
 *
 * @param {object} options
 * @param {string} options.stateDir
 * @returns {Promise<object>} installed metadata for the restored set
 */
async function rollbackRuntime(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('rollbackRuntime options are required.');
  }
  assertStateDirPath(options.stateDir);
  const { root } = await prepareStateDir(options.stateDir);
  return withInstallLock(root, DEFAULT_LOCK_TIMEOUT_MS, undefined, async () => {
    await cleanSelectionTemps(path.join(root, 'runtimes'));
    const current = await readSelection(root);
    if (!current.previous) {
      fail('no_previous', 'No previous runtime is available to roll back to.');
    }
    const previous = await inspectRelease(root, current.previous, null);
    if (!previous.valid) {
      fail(
        'runtime_corrupt',
        `Previous runtime set ${current.previous} failed verification; refusing to roll back.`
      );
    }
    let newPrevious = current.active;
    if (newPrevious) {
      const active = await inspectRelease(root, newPrevious, null);
      if (!active.valid) newPrevious = null;
    }
    if (newPrevious === current.previous) newPrevious = null;
    await writeSelection(root, {
      format: 1,
      active: current.previous,
      previous: newPrevious,
      updatedAt: new Date().toISOString(),
    });
    return buildResult(root, previous.meta);
  });
}

// Resolve executable paths for host-side adapters only. Public inventory is metadata;
// code loading also checks every installed file against the trusted release manifests.
async function verifyRuntime({ stateDir, set, manifests: suppliedManifests }) {
  assertStateDirPath(stateDir);
  const root = path.resolve(stateDir);
  const manifests = await resolveManifests(suppliedManifests);
  for (const dir of [root, path.join(root, 'runtimes'), path.join(root, 'runtimes', 'releases')]) {
    const info = await lstatOrNull(dir);
    if (!info) fail('runtime_unavailable', 'No verified runtime is installed.');
    assertPrivateDirStat(info, dir);
  }
  const id = set ?? (await readSelection(root)).active;
  if (!id) fail('runtime_unavailable', 'No runtime is selected.');
  if (id !== computeSetId(manifests)) fail('runtime_untrusted', 'Missing trusted release manifests for this runtime.');
  const inspected = await inspectRelease(root, id, manifests);
  if (!inspected.valid) fail('runtime_corrupt', 'Installed runtime verification failed.');
  return buildResult(root, inspected.meta);
}

module.exports = {
  RuntimeInstallerError,
  installRuntime,
  listRuntimes,
  rollbackRuntime,
  verifyRuntime,
};
