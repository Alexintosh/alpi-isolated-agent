'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { createInferencePool, createModelRelay } = require('./network/model-relay.cjs');

class ProfileError extends Error {
  constructor(code) { super(code); this.name = 'ProfileError'; this.code = code; }
}
const invalid = () => { throw new ProfileError('invalid_host_config'); };
const id = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(value);
const positive = (n, max) => Number.isSafeInteger(n) && n >= 1 && n <= max;
const image = value => typeof value === 'string' && value.length <= 512 &&
  /^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[1-9][0-9]{0,4})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[a-f0-9]{64}$/.test(value);

function keys(value, required, optional = []) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid();
}

function members(values, check, limit) {
  if (!Array.isArray(values) || !values.length || values.length > limit ||
      !values.every(check) || new Set(values).size !== values.length) invalid();
  return Object.freeze([...values]);
}

function makeProfileCatalog(config) {
  keys(config, ['version', 'profiles', 'providers']);
  if (config.version !== 1 || !Array.isArray(config.profiles) || config.profiles.length > 32 ||
      !Array.isArray(config.providers) || config.providers.length > 32) invalid();
  const providers = new Map();
  for (const item of config.providers) {
    keys(item, ['name', 'models', 'upstream', 'concurrency'], ['credentialName']);
    keys(item.upstream, ['scheme', 'host', 'port']);
    if (!id(item.name) || providers.has(item.name) || !positive(item.concurrency, 64) ||
        !['http', 'https'].includes(item.upstream.scheme) ||
        typeof item.upstream.host !== 'string' || item.upstream.host.includes('%') || !net.isIP(item.upstream.host) ||
        !positive(item.upstream.port, 65535) || (item.credentialName !== undefined && !id(item.credentialName))) invalid();
    providers.set(item.name, Object.freeze({ ...item, models: members(item.models, text, 32),
      upstream: Object.freeze({ ...item.upstream }) }));
  }
  const profiles = new Map();
  for (const item of config.profiles) {
    keys(item, ['name', 'engine', 'image', 'projects', 'harnesses', 'limits', 'providers'], ['imagePreparationMiB']);
    keys(item.limits, ['vcpus', 'memoryMiB', 'diskMiB']);
    if (!id(item.name) || profiles.has(item.name) || !id(item.engine) || !image(item.image) ||
        !positive(item.limits.vcpus, 1024) || !positive(item.limits.memoryMiB, 0x7fffffff) ||
        !positive(item.limits.diskMiB, 0x7fffffff) ||
        (item.imagePreparationMiB !== undefined && !positive(item.imagePreparationMiB, 0x7fffffff)) ||
        !Array.isArray(item.providers)) invalid();
    profiles.set(item.name, Object.freeze({ name: item.name, engine: item.engine, image: item.image,
      imagePreparationMiB: item.imagePreparationMiB,
      projects: members(item.projects, text, 128), harnesses: members(item.harnesses, id, 16),
      limits: Object.freeze({ ...item.limits }), providers: item.providers.length
        ? members(item.providers, name => providers.has(name), 32) : Object.freeze([]) }));
  }
  function resolve(project, engine, name) {
    const profile = profiles.get(name);
    if (!profile || !profile.projects.includes(project) || profile.engine !== engine) throw new ProfileError('profile_unavailable');
    return profile;
  }
  const pools = new Map([...providers.values()].map(route => [
    route.name, createInferencePool({ maxConcurrent: route.concurrency }),
  ]));
  function modelRoute(project, engine, name, harness, provider, model) {
    const profile = resolve(project, engine, name);
    const route = providers.get(provider);
    if (!profile.harnesses.includes(harness) || !profile.providers.includes(provider) || !route?.models.includes(model)) {
      throw new ProfileError('model_unavailable');
    }
    return route;
  }
  return Object.freeze({
    resolve,
    installedProfile(engine, name) {
      const profile = profiles.get(name);
      if (!profile || profile.engine !== engine) throw new ProfileError('profile_unavailable');
      return profile;
    },
    modelRoute,
    openModelRelay({ project, engine, profile, harness, provider, model, sandboxId, generation, socketPath },
      { credentialsDirectory = process.env.CREDENTIALS_DIRECTORY } = {}) {
      const route = modelRoute(project, engine, profile, harness, provider, model);
      return createModelRelay({ projectId: project, sandboxId, generation, socketPath, model,
        upstream: route.upstream, pool: pools.get(route.name),
        credential: route.credentialName ? { directory: credentialsDirectory, name: route.credentialName } : null });
    },
    // Effective capabilities require separate worker, image and network qualification.
    forProject(project) {
      return [...profiles.values()].filter(p => p.projects.includes(project)).map(p => ({
        name: p.name, engine: p.engine, image: p.image, imagePreparationMiB: p.imagePreparationMiB,
        limits: p.limits, harnesses: p.harnesses,
        providers: p.providers.map(name => ({ name, models: providers.get(name).models })),
      }));
    },
  });
}

async function readProfileCatalog(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) invalid();
  // The operator chooses this path locally. O_NONBLOCK also prevents a FIFO from hanging startup.
  const fd = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || stat.nlink !== 1 || ![0, process.geteuid()].includes(stat.uid) ||
        (stat.mode & 0o022) || stat.size > 65536) invalid();
    const buffer = Buffer.alloc(65537);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await fd.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > 65536) invalid();
    let config;
    try { config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size))); } catch { invalid(); }
    return makeProfileCatalog(config);
  } finally { await fd.close(); }
}

async function loadHostProfiles(filename) {
  try {
    return await readProfileCatalog(filename ?? '/etc/alpi/profiles.json');
  } catch (error) {
    if (filename === undefined && error.code === 'ENOENT') {
      return makeProfileCatalog({ version: 1, profiles: [], providers: [] });
    }
    throw error;
  }
}

module.exports = { ProfileError, makeProfileCatalog, readProfileCatalog, loadHostProfiles };
