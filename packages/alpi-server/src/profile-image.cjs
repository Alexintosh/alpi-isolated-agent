'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { verifyRuntime } = require('./runtime-installer.cjs');
const { acquireProcessGuard } = require('./process-lock.cjs');

async function cachePinnedImage(native, image) {
  const [repository, manifestDigest] = image.split('@');
  const hasManifest = async () => {
    const detail = await native.images.get(repository);
    return detail.versions.some(version => version.digest === manifestDigest);
  };
  if (await hasManifest().catch(() => false)) return manifestDigest;
  await native.images.pull(image);
  if (!await hasManifest()) throw new Error('Profile image manifest verification failed.');
  return manifestDigest;
}

async function ensureImage({ stateDir, profile }) {
  const runtime = await verifyRuntime({ stateDir });
  const sdk = await import(pathToFileURL(path.join(runtime.paths.sdk, 'dist/index.js')).href);
  const cacheKey = createHash('sha256').update(runtime.set + '\n' + profile.image).digest('hex');
  const cache = path.join(stateDir, 'profile-images');
  for (const dir of [cache, path.join(cache, cacheKey)]) {
    await fs.mkdir(dir, { mode: 0o700 }).catch(err => { if (err.code !== 'EEXIST') throw err; });
    const stat = await fs.lstat(dir);
    if (!stat.isDirectory() || stat.uid !== process.geteuid() || (stat.mode & 0o077)) throw new Error('Invalid image store.');
  }
  const homeDir = path.join(cache, cacheKey);
  const guard = acquireProcessGuard(path.join(homeDir, 'profile-pull'), { timeoutMs: 30000 });
  let native;
  try {
    native = new sdk.JsBoxlite({ homeDir });
    const manifestDigest = await cachePinnedImage(native, profile.image);
    return { profile: profile.name, image: profile.image, runtime: runtime.set, manifestDigest };
  } finally {
    try { native?.close(); } finally { guard.release(); }
  }
}

module.exports = { ensureImage, cachePinnedImage };
