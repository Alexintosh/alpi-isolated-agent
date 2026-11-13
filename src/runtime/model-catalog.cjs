const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');
const { readJson, writeJson } = require('./atomic-json.cjs');

const MAX_PROVIDERS = 32;
const text = (value, limit = 256) => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const safeId = id => text(id, 64) && /^[a-z0-9][a-z0-9-]*$/.test(id) && !['__proto__', 'prototype', 'constructor'].includes(id);
const exactKeys = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
function endpoint(value) {
  if (!text(value, 2048) || !/^https?:\/\//i.test(value) || /[\s\\?#]/.test(value)) throw new Error('Invalid model authorization.');
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid model authorization.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password ||
      value.split('/')[2].includes('@') || !/\/v1\/?$/.test(url.pathname)) throw new Error('Invalid model authorization.');
  return url.href.replace(/\/$/, '');
}
function authorizations(value) {
  if (!exactKeys(value, ['version', 'providers']) || value.version !== 1 || !record(value.providers) ||
      Object.keys(value.providers).length > MAX_PROVIDERS) throw new Error('Invalid model authorization.');
  const result = Object.create(null);
  for (const [id, provider] of Object.entries(value.providers)) {
    if (!safeId(id) || !exactKeys(provider, ['endpoint', 'model']) || !text(provider.model)) throw new Error('Invalid model authorization.');
    result[id] = { endpoint: endpoint(provider.endpoint), model: provider.model };
  }
  return result;
}
function readState(file, fallback, message) {
  try { return readJson(file, fallback); } catch { throw new Error(message); }
}
function legacyAuthorizations(providers) {
  const result = Object.create(null);
  for (const provider of providers) {
    if (!record(provider) || !safeId(provider.id) || Object.hasOwn(result, provider.id) ||
        !Array.isArray(provider.models) || provider.models.length !== 1 || !record(provider.models[0]) || !text(provider.models[0].id))
      throw new Error('Invalid saved catalog.');
    result[provider.id] = { endpoint: endpoint(provider.baseURL), model: provider.models[0].id };
  }
  return result;
}
function readYaml(file) {
  try { return yaml.load(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('DSH configuration is unreadable or invalid.'); }
}
function normalizeProvider(id, input, authorization = Object.create(null)) {
  const authorized = safeId(id) && Object.hasOwn(authorization, id) ? authorization[id] : null;
  if (!authorized || !record(input) || input.api !== 'openai-completions' || typeof input.baseURL !== 'string' ||
      endpoint(input.baseURL) !== authorized.endpoint ||
      !Array.isArray(input.models)) throw new Error('The local provider does not match the authorization.');
  const models = input.models.filter(model => record(model) && model.id === authorized.model).map(model => {
    if (!text(model.id) || !text(model.name ?? model.id) || !Number.isSafeInteger(model.contextWindow) || model.contextWindow < 1 ||
        !Number.isSafeInteger(model.maxTokens) || model.maxTokens < 1 || model.maxTokens > model.contextWindow) throw new Error('Invalid model definition.');
    const result = { id: model.id, name: model.name ?? model.id, contextWindow: model.contextWindow, maxTokens: model.maxTokens };
    if (model.input !== undefined) {
      if (!Array.isArray(model.input) || !model.input.length || !model.input.every(value => ['text', 'image'].includes(value))) throw new Error('Invalid model input modes.');
      result.input = [...new Set(model.input)];
    }
    if (model.reasoningEfforts !== undefined) {
      if (!model.reasoningEfforts || typeof model.reasoningEfforts !== 'object' || Array.isArray(model.reasoningEfforts)) throw new Error('Invalid reasoning settings.');
      const efforts = {};
      for (const [name, value] of Object.entries(model.reasoningEfforts)) {
        if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(name) || (value !== null && !text(value, 64))) throw new Error('Invalid reasoning settings.');
        efforts[name] = value;
      }
      result.reasoningEfforts = efforts;
    }
    return result;
  });
  if (models.length !== 1 || (input.displayName !== undefined && !text(input.displayName, 200))) throw new Error('The model catalog is incomplete.');
  return { id, displayName: input.displayName ?? id, api: input.api, baseURL: authorized.endpoint, models, credentialRef: `model/provider/${id}` };
}
function desktopConfiguration(dshRoot, authorization = Object.create(null)) {
  if (!Object.keys(authorization).length) throw new Error('Configure model-authorizations.json before importing desktop models.');
  const patches = readYaml(path.join(dshRoot, 'profiles/desktop/cordis.patch.yml'));
  if (!Array.isArray(patches)) throw new Error('Invalid desktop profile.');
  const plugins = patches.filter(patch => patch?.id === 'llm-pi-ai');
  const defaults = patches.filter(patch => patch?.id === 'agent-default-model');
  if (plugins.length !== 1 || defaults.length !== 1) throw new Error('Ambiguous desktop configuration.');
  const source = plugins[0].config?.providers;
  const providers = Object.keys(authorization).map(id => normalizeProvider(id, record(source) && Object.hasOwn(source, id) ? source[id] : null, authorization));
  const selected = defaults[0].config;
  if (!providers.some(provider => provider.id === selected?.provider && provider.models.some(model => model.id === selected.model)))
    throw new Error('The default model is not authorized.');
  return { providers, selected: { provider: selected.provider, model: selected.model }, source };
}
class ModelCatalog {
  constructor({ stateRoot, vault, dshRoot = path.join(os.homedir(), '.dsh'), fetcher = fetch }) {
    this.file = path.join(stateRoot, 'models.json'); this.vault = vault; this.dshRoot = dshRoot;
    const explicit = readState(path.join(stateRoot, 'model-authorizations.json'), undefined, 'Invalid model authorization.');
    // Invalid explicit authorization never falls back to saved or desktop data.
    this.authorization = explicit === undefined ? null : authorizations(explicit);
    const stored = readState(this.file, { version: 1, providers: [], selected: null }, 'Invalid saved catalog.');
    if (!record(stored) || stored.version !== 1 || !Array.isArray(stored.providers) || stored.providers.length > MAX_PROVIDERS) throw new Error('Invalid saved catalog.');
    try {
      // Only already-saved host providers grant legacy authority, never the desktop profile.
      this.authorization ??= legacyAuthorizations(stored.providers);
      this.providers = stored.providers.map(provider => {
        if (!record(provider) || !Array.isArray(provider.models) || provider.models.length !== 1) throw new Error('Invalid saved catalog.');
        const normalized = normalizeProvider(provider.id, provider, this.authorization);
        if (normalized.baseURL !== provider.baseURL || normalized.credentialRef !== provider.credentialRef) throw new Error('Invalid saved catalog.');
        return normalized;
      });
    } catch { throw new Error('Invalid saved catalog.'); }
    if (new Set(this.providers.map(provider => provider.id)).size !== this.providers.length ||
        (stored.selected !== null && !this.providers.some(provider => provider.id === stored.selected?.provider && provider.models.some(model => model.id === stored.selected.model))))
      throw new Error('Invalid saved model selection.');
    this.selected = stored.selected ? { provider: stored.selected.provider, model: stored.selected.model } : null;
    this.queue = Promise.resolve(); this.fetcher = fetcher; this.probes = new Map();
  }
  snapshot() {
    return { selected: this.selected && { ...this.selected }, providers: this.providers.map(provider => ({
      id: provider.id, displayName: provider.displayName, api: provider.api, baseURL: provider.baseURL,
      models: JSON.parse(JSON.stringify(provider.models)), credentialAvailable: this.vault.has(provider.credentialRef),
      ...(this.probes.get(provider.id) ?? { availability: 'not-checked' }),
    })) };
  }
  async probe() {
    await Promise.all(this.providers.map(async provider => {
      let availability = 'unreachable';
      try {
        const secret = await this.vault.get(provider.credentialRef);
        if (!secret) availability = 'missing-credential';
        else {
          const response = await this.fetcher(provider.baseURL + '/models', { method: 'GET', redirect: 'manual',
            signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json' } });
          if (response.status === 401 || response.status === 403) { availability = 'unauthorized'; await response.body?.cancel(); }
          else if (response.status !== 200) { availability = 'upstream-error'; await response.body?.cancel(); }
          else {
            const chunks = []; let size = 0;
            for await (const chunk of response.body) { size += chunk.length; if (size > 1024 * 1024) throw new Error('Response limit'); chunks.push(chunk); }
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            availability = Array.isArray(body.data) && provider.models.every(model => body.data.some(item => item?.id === model.id)) ? 'available' : 'model-not-loaded';
          }
        }
      } catch (error) { if (error.code === 'VAULT_UNAVAILABLE') availability = 'vault-unavailable'; }
      // Never return upstream payloads, headers, arbitrary model IDs or errors.
      this.probes.set(provider.id, { availability, checkedAt: new Date().toISOString() });
    }));
    return this.snapshot();
  }
  importDesktop() {
    const work = this.queue.then(async () => {
      const config = desktopConfiguration(this.dshRoot, this.authorization);
      const credentials = readYaml(path.join(this.dshRoot, '.credentials.yaml'));
      // Validate every authorized reference before any persistent mutation.
      for (const provider of config.providers) {
        const ref = config.source[provider.id].apiKeyEnv;
        if (typeof ref !== 'string' || typeof credentials?.refs?.[ref] !== 'string' || !credentials.refs[ref].length)
          throw new Error('The authorized local credential is unavailable.');
      }
      await this.vault.putMany(Object.fromEntries(config.providers.map(provider =>
        [provider.credentialRef, credentials.refs[config.source[provider.id].apiKeyEnv]])));
      writeJson(this.file, { version: 1, providers: config.providers, selected: config.selected });
      this.providers = config.providers; this.selected = config.selected; this.probes.clear();
      return this.snapshot();
    });
    this.queue = work.catch(() => {}); return work;
  }
}
module.exports = { ModelCatalog, normalizeProvider, desktopConfiguration };
