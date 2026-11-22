'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { verifyRuntime } = require('./runtime-installer.cjs');
const { acquireProcessGuard } = require('./process-lock.cjs');

// Conservative advisory admission for an explicitly requested OCI image.
// Exact layer sizes are unavailable before the SDK pulls; the trusted profile's
// disk limit is the documented upper bound on the writable image/guest cache,
// plus fixed headroom. This is an estimate, not a hard quota.
const IMAGE_CACHE_OVERHEAD_BYTES = 64 * 1024 * 1024;

function imageAdmissionBytes(profile) {
  const diskMiB = profile && profile.limits && profile.limits.diskMiB;
  if (!Number.isSafeInteger(diskMiB) || diskMiB < 1) {
    throw new TypeError('A trusted profile disk limit is required for image admission.');
  }
  const required = diskMiB * 1024 * 1024 + IMAGE_CACHE_OVERHEAD_BYTES;
  if (!Number.isSafeInteger(required)) {
    throw new TypeError('Profile image admission requirement is too large.');
  }
  return required;
}

async function cachePinnedImage(native, image, signal) {
  const [repository, manifestDigest] = image.split('@');
  const hasManifest = async () => {
    const detail = await native.images.get(repository);
    return detail.versions.some(version => version.digest === manifestDigest);
  };
  signal?.throwIfAborted();
  if (await hasManifest().catch(() => false)) return manifestDigest;
  await native.images.pull(image);
  signal?.throwIfAborted();
  if (!await hasManifest()) throw new Error('Profile image manifest verification failed.');
  return manifestDigest;
}

async function ensureImage({ stateDir, profile, set, signal }) {
  // Bind preparation to the exact verified candidate. Never silently fall back
  // to whatever selection happens to be active when this work runs.
  if (typeof set !== 'string' || set.length === 0) {
    throw new TypeError('ensureImage requires the prepared runtime set.');
  }
  signal?.throwIfAborted();
  const runtime = await verifyRuntime({ stateDir, set });
  signal?.throwIfAborted();
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
    const manifestDigest = await cachePinnedImage(native, profile.image, signal);
    signal?.throwIfAborted();
    return { profile: profile.name, image: profile.image, runtime: runtime.set, manifestDigest };
  } finally {
    try { native?.close(); } finally { guard.release(); }
  }
}

module.exports = { ensureImage, cachePinnedImage, imageAdmissionBytes, IMAGE_CACHE_OVERHEAD_BYTES };
