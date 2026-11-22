'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { RuntimeInstallerError, verifyRuntime } = require('./runtime-installer.cjs');
const { acquireProcessGuard } = require('./process-lock.cjs');

// Conservative advisory admission for an explicitly requested OCI image.
// The trusted profile declares an image-specific preparation bound covering
// the pulled layers, the expanded image and conversion/temporary files; the
// fixed overhead covers verification scratch and filesystem journal traffic.
// The guest disk limit limits the running sandbox and is never an admission
// bound for host-side image preparation. This is an estimate, not a quota.
const IMAGE_CACHE_OVERHEAD_BYTES = 64 * 1024 * 1024;

function imageCacheKey(set, image) {
  return createHash('sha256').update(set + '\n' + image).digest('hex');
}

// A cache entry is credited only when its private directory carries the
// marker that ensureImage writes after a fully verified acquisition for
// exactly this prepared candidate set and pinned image.
async function hasVerifiedImageCache(stateDir, set, image) {
  if (typeof stateDir !== 'string' || stateDir.length === 0 ||
      typeof set !== 'string' || set.length === 0) {
    throw new TypeError('Image cache reuse requires the state directory and prepared runtime set.');
  }
  const homeDir = path.join(stateDir, 'profile-images', imageCacheKey(set, image));
  let stat;
  try {
    stat = await fs.lstat(homeDir);
  } catch {
    return false;
  }
  if (!stat.isDirectory() || stat.uid !== process.geteuid() || (stat.mode & 0o077)) return false;
  let marker;
  try {
    marker = JSON.parse(await fs.readFile(path.join(homeDir, 'manifest.json'), 'utf8'));
  } catch {
    return false;
  }
  return marker !== null && typeof marker === 'object' &&
    marker.image === image && marker.runtime === set &&
    typeof marker.manifestDigest === 'string' && /^sha256:[a-f0-9]{64}$/.test(marker.manifestDigest);
}

// Advisory admission for pinned-image preparation. The estimate derives from
// the profile's declared preparation bound, never from the guest disk limit.
// When the caller supplies the state directory and prepared candidate set, a
// verified cache entry for that exact candidate is not charged as a fresh
// acquisition.
async function imageAdmissionBytes(profile, options = {}) {
  const preparationMiB = profile && profile.imagePreparationMiB;
  if (!Number.isSafeInteger(preparationMiB) || preparationMiB < 1) {
    throw new TypeError('A trusted profile image preparation bound is required for image admission.');
  }
  const required = preparationMiB * 1024 * 1024 + IMAGE_CACHE_OVERHEAD_BYTES;
  if (!Number.isSafeInteger(required)) {
    throw new TypeError('Profile image admission requirement is too large.');
  }
  if (options.stateDir !== undefined || options.set !== undefined) {
    if (await hasVerifiedImageCache(options.stateDir, options.set, profile.image)) return 0;
  }
  return required;
}

// Advisory capacity check for pinned-image preparation against the
// destination filesystem. Runs before verification, SDK import and pull.
async function assertImageAdmission({ stateDir, profile, set, signal, statfs } = {}) {
  signal?.throwIfAborted();
  const required = await imageAdmissionBytes(profile, { stateDir, set });
  let stat;
  try {
    stat = await (statfs ?? fs.statfs)(stateDir, { bigint: true });
  } catch (error) {
    throw new RuntimeInstallerError('disk_check_failed',
      'Unable to read destination filesystem capacity (' +
      (error && error.code ? error.code : 'unknown') + ').');
  }
  let available;
  try {
    const bavail = BigInt(stat.bavail);
    const bsize = BigInt(stat.bsize);
    if (bavail < 0n || bsize <= 0n) throw new RangeError('invalid statfs');
    available = bavail * bsize;
  } catch (error) {
    if (error instanceof RuntimeInstallerError) throw error;
    throw new RuntimeInstallerError('disk_check_failed', 'Destination filesystem capacity is invalid.');
  }
  if (available < BigInt(required)) {
    throw new RuntimeInstallerError('insufficient_disk_space',
      'Insufficient free space for pinned image preparation: about ' + required +
      ' bytes are required and ' + available +
      ' bytes are available to the service user. Capacity admission is advisory against unrelated writers.');
  }
  return { required, available };
}

async function cachePinnedImage(native, image, signal) {
  const [repository, manifestDigest] = image.split('@');
  const hasManifest = async () => {
    const detail = await native.images.get(repository);
    return detail.versions.some(version => version.digest === manifestDigest);
  };
  signal?.throwIfAborted();
  let present;
  try {
    present = await hasManifest();
  } catch (error) {
    // A failed lookup is not a cache miss. If the lookup itself was
    // cancelled, surface the cancellation; otherwise surface the error.
    signal?.throwIfAborted();
    throw error;
  }
  if (present) return manifestDigest;
  // The awaited lookup above may have consumed the whole cancellation window:
  // recheck immediately before dispatching a new acquisition.
  signal?.throwIfAborted();
  // Once dispatched, the pull is supervised rather than interruptible: this
  // SDK boundary exposes no cancellation contract, so the pull runs to
  // completion under the per-cache process guard and close() in the caller's
  // finally. Activation stays protected by the fresh cancellation checks
  // after the pull settles.
  await native.images.pull(image);
  signal?.throwIfAborted();
  if (!await hasManifest()) {
    signal?.throwIfAborted();
    throw new Error('Profile image manifest verification failed.');
  }
  return manifestDigest;
}

async function ensureImage({ stateDir, profile, set, signal, statfs }) {
  // Bind preparation to the exact verified candidate. Never silently fall back
  // to whatever selection happens to be active when this work runs.
  if (typeof set !== 'string' || set.length === 0) {
    throw new TypeError('ensureImage requires the prepared runtime set.');
  }
  signal?.throwIfAborted();
  // Image admission is image-specific and cache-aware: it needs the prepared
  // candidate set, so it runs here at the real call site, before any
  // verification, SDK import or pull is dispatched.
  await assertImageAdmission({ stateDir, profile, set, signal, statfs });
  signal?.throwIfAborted();
  const runtime = await verifyRuntime({ stateDir, set });
  signal?.throwIfAborted();
  const sdk = await import(pathToFileURL(path.join(runtime.paths.sdk, 'dist/index.js')).href);
  const cacheKey = imageCacheKey(runtime.set, profile.image);
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
    // Record the verified acquisition so a later admission for this exact
    // candidate credits the cache instead of charging a fresh pull. Best
    // effort: a missing marker only makes the next estimate conservative.
    await fs.writeFile(path.join(homeDir, 'manifest.json'),
      JSON.stringify({ image: profile.image, runtime: runtime.set, manifestDigest }) + '\n',
      { mode: 0o600 }).catch(() => {});
    return { profile: profile.name, image: profile.image, runtime: runtime.set, manifestDigest };
  } finally {
    try { native?.close(); } finally { guard.release(); }
  }
}

module.exports = {
  ensureImage,
  cachePinnedImage,
  imageAdmissionBytes,
  assertImageAdmission,
  IMAGE_CACHE_OVERHEAD_BYTES,
};
