'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { CANONICAL_FILES, assertCallbackProfileInstalled, installCallbackProfile } = require('./iron.cjs');

const root = path.resolve(__dirname, '../..');
const recipe = path.join(root, 'profiles/iron-callback');
const manifests = ['package.json', 'npm-shrinkwrap.json', 'callback-runtime.cjs'];
// Conservative advisory admission for a first callback installation: pinned
// gRPC dependencies, the staged vendor files, npm's temporary cache and the
// final directory. The exact dependency tree is not available before npm ci.
const CALLBACK_ADMISSION_BYTES = 64 * 1024 * 1024;

async function recipeDigest(files) {
  const digest = createHash('sha256');
  for (const { file, name } of files) {
    const bytes = await fs.readFile(file);
    digest.update(name + '\0' + bytes.length + '\0').update(bytes);
  }
  return digest.digest('hex');
}

async function callbackRecipeFiles() {
  const sourceFile = await fs.realpath(path.join(root, CANONICAL_FILES[0].source));
  const sourceRoot = path.resolve(path.dirname(sourceFile), '../..');
  return {
    sourceRoot,
    files: [
      ...manifests.map(name => ({ name, file: path.join(recipe, name) })),
      ...CANONICAL_FILES.map(({ source, destination }) => ({ name: destination, file: path.join(sourceRoot, source) })),
    ],
  };
}

// Advisory estimate for callback preparation before the CLI fetches or writes.
// An already complete callback directory is not charged again.
async function callbackAdmissionBytes(stateDir) {
  try {
    const { files } = await callbackRecipeFiles();
    const digest = await recipeDigest(files);
    const stat = await fs.lstat(path.join(stateDir, 'runtimes', 'callbacks', digest));
    if (stat.isDirectory() && stat.uid === process.geteuid() && !(stat.mode & 0o077)) {
      return 0;
    }
  } catch {
    // A missing or unreadable callback store needs the conservative estimate.
  }
  return CALLBACK_ADMISSION_BYTES;
}

// Called after the runtime installer has verified the private state tree.
// Publish only a fully installed callback. Concurrent installs may prepare
// identical stages, but the completed, nonempty directory is never replaced.
async function ensureIronCallback(stateDir, { signal } = {}) {
  signal?.throwIfAborted();
  const { sourceRoot, files } = await callbackRecipeFiles();
  const digest = await recipeDigest(files);
  const parent = path.join(stateDir, 'runtimes', 'callbacks');
  await fs.mkdir(parent, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const entry = await fs.lstat(parent);
  if (!entry.isDirectory() || entry.uid !== process.geteuid() || (entry.mode & 0o077)) {
    throw new Error('Unsafe Iron callback storage.');
  }
  const final = path.join(parent, digest);
  const verify = async () => {
    signal?.throwIfAborted();
    const stat = await fs.lstat(final);
    if (!stat.isDirectory() || stat.uid !== process.geteuid() || (stat.mode & 0o077)) throw new Error('Invalid callback profile.');
    const installed = await recipeDigest(files.map(({ name }) => ({ name, file: path.join(final, name) })));
    if (installed !== digest) throw new Error('Installed callback does not match its recipe.');
    assertCallbackProfileInstalled({ profileDir: final });
  };
  const result = { digest, profileDir: final };
  try {
    await fs.lstat(final);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const stage = await fs.mkdtemp(path.join(parent, '.prepare-'));
    try {
      for (const name of manifests) await fs.copyFile(path.join(recipe, name), path.join(stage, name));
      await installCallbackProfile({ sourceRoot, profileDir: stage, signal });
      await fs.rm(path.join(stage, '.npm-cache'), { recursive: true, force: true });
      signal?.throwIfAborted();
      await fs.rename(stage, final).catch(error => {
        if (!['ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
      });
    } finally {
      await fs.rm(stage, { recursive: true, force: true });
    }
  }
  await verify();
  return result;
}

module.exports = { ensureIronCallback, callbackAdmissionBytes, CALLBACK_ADMISSION_BYTES };
