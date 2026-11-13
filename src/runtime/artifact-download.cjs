'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

function checkedUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Artifact URL must be HTTPS and contain no credentials');
  }
  return url;
}

function checkAbort(signal) {
  if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
}

async function verifyExisting(destination, expected, signal, maxBytes = Infinity) {
  let handle;
  try {
    handle = await fsp.open(destination, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  try {
    const stat=await handle.stat();
    if (!stat.isFile()) throw new Error('Artifact destination is not a regular file');
    if(stat.size>maxBytes)throw new Error('Artifact exceeds maxBytes');
    const hash = crypto.createHash('sha256');
    let bytes=0;
    for await (const chunk of handle.createReadStream({ autoClose: false, signal })) {
      checkAbort(signal);
      bytes+=chunk.length;if(bytes>maxBytes)throw new Error('Artifact exceeds maxBytes');
      hash.update(chunk);
    }
    if (hash.digest('hex') !== expected) throw new Error('Existing artifact SHA-256 mismatch');
    return true;
  } finally {
    await handle.close();
  }
}

/** Download and verify a trusted manifest artifact without replacing an existing file. */
async function acquireArtifact({ url, destination, sha256, maxBytes, signal, onProgress, fetch: fetchImpl = globalThis.fetch }) {
  if (typeof destination !== 'string' || !destination) throw new TypeError('destination is required');
  if (typeof sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(sha256)) throw new TypeError('sha256 must be a hex SHA-256 digest');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError('maxBytes must be a nonnegative safe integer');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required');
  if (onProgress !== undefined && typeof onProgress !== 'function') throw new TypeError('onProgress must be a function');
  let current = checkedUrl(url);
  const expected = sha256.toLowerCase();
  checkAbort(signal);
  if (await verifyExisting(destination, expected, signal)) return destination;
  await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  checkAbort(signal);
  let response;
  for (let redirects = 0; ; redirects++) {
    response = await fetchImpl(current.href, { method: 'GET', redirect: 'manual', signal });
    checkAbort(signal);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (redirects >= 3 || !location) throw new Error('Invalid or excessive artifact redirect');
      current = checkedUrl(new URL(location, current));
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Artifact download failed with HTTP ${response.status}`);
    }
    break;
  }
  const length = response.headers.get('content-length');
  const total = length !== null && /^\d+$/.test(length) && Number.isSafeInteger(Number(length)) ? Number(length) : undefined;
  if (total !== undefined && total > maxBytes) {
    await response.body?.cancel();
    throw new Error('Artifact exceeds maxBytes');
  }
  const temp = path.join(path.dirname(destination), `.${path.basename(destination)}.${crypto.randomBytes(16).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await fsp.open(temp, 'wx', 0o600);
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    let lastProgress = -Infinity;
    const reader = response.body?.getReader();
    const cancelRead = () => { void reader?.cancel().catch(() => {}); };
    signal?.addEventListener('abort', cancelRead, { once: true });
    try {
    while (reader) {
      checkAbort(signal);
      const { value: chunk, done } = await reader.read();
      checkAbort(signal);
      if (done) break;
      bytes += chunk.byteLength;
      if (bytes > maxBytes) throw new Error('Artifact exceeds maxBytes');
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.byteLength) {
        const result = await handle.write(chunk, offset, chunk.byteLength - offset);
        offset += result.bytesWritten;
      }
      const now = Date.now();
      if (onProgress && now - lastProgress >= 100) {
        onProgress({ bytes, ...(total === undefined ? {} : { total }) });
        lastProgress = now;
      }
    }
    } finally {
      signal?.removeEventListener('abort', cancelRead);
      if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
    checkAbort(signal);
    if (hash.digest('hex') !== expected) throw new Error('Artifact SHA-256 mismatch');
    await handle.sync();
    await handle.close();
    handle = undefined;
    checkAbort(signal);
    // link is an atomic, no-replace publication; rename would overwrite a racing file.
    await fsp.link(temp, destination);
    const directory = await fsp.open(path.dirname(destination), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    return destination;
  } finally {
    await handle?.close();
    await fsp.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

/** Copy a trusted local artifact into place with the same verification and atomic publication as acquireArtifact. */
async function acquireLocalArtifact({ source, destination, sha256, maxBytes, signal, onProgress }) {
  if (typeof source !== 'string' || !source || !path.isAbsolute(source)) throw new TypeError('source must be an absolute path');
  if (typeof destination !== 'string' || !destination || !path.isAbsolute(destination)) throw new TypeError('destination must be an absolute path');
  if (typeof sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(sha256)) throw new TypeError('sha256 must be a hex SHA-256 digest');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError('maxBytes must be a nonnegative safe integer');
  if (onProgress !== undefined && typeof onProgress !== 'function') throw new TypeError('onProgress must be a function');
  const expected = sha256.toLowerCase();
  checkAbort(signal);
  if (await verifyExisting(destination, expected, signal, maxBytes)) return destination;
  await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  checkAbort(signal);
  const temp = path.join(path.dirname(destination), `.${path.basename(destination)}.${crypto.randomBytes(16).toString('hex')}.tmp`);
  const sourceFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
  let sourceHandle;
  let handle;
  try {
    sourceHandle = await fsp.open(source, sourceFlags);
    const sourceStat = await sourceHandle.stat();
    if (!sourceStat.isFile()) throw new Error('Artifact source is not a regular file');
    if (sourceStat.size > maxBytes) throw new Error('Artifact exceeds maxBytes');
    handle = await fsp.open(temp, 'wx', 0o600);
    const hash = crypto.createHash('sha256');
    const chunk = Buffer.allocUnsafe(1 << 16);
    let received = 0;
    let lastProgress = -Infinity;
    while (true) {
      checkAbort(signal);
      const { bytesRead } = await sourceHandle.read(chunk, 0, chunk.length);
      if (bytesRead === 0) break;
      received += bytesRead;
      if (received > maxBytes) throw new Error('Artifact exceeds maxBytes');
      hash.update(chunk.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await handle.write(chunk, written, bytesRead - written);
        written += result.bytesWritten;
      }
      const now = Date.now();
      if (onProgress && now - lastProgress >= 100) {
        onProgress({ received, total: sourceStat.size });
        lastProgress = now;
      }
    }
    checkAbort(signal);
    if (hash.digest('hex') !== expected) throw new Error('Artifact SHA-256 mismatch');
    await handle.sync();
    await handle.close();
    handle = undefined;
    checkAbort(signal);
    // link is an atomic, no-replace publication; rename would overwrite a racing file.
    await fsp.link(temp, destination);
    const directory = await fsp.open(path.dirname(destination), 'r');
    try {
      await directory.sync();
    } catch (error) {
      // Ignore only an explicit unsupported-directory-fsync result, never disk errors.
      if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) throw error;
    } finally {
      await directory.close();
    }
    return destination;
  } finally {
    await sourceHandle?.close();
    await handle?.close();
    await fsp.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

module.exports = { acquireArtifact, acquireLocalArtifact };
