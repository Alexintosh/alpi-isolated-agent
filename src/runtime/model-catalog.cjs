const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Buffer } = require('node:buffer');
const yaml = require('js-yaml');
const { readJson, writeJson } = require('./atomic-json.cjs');

const MAX_PROVIDERS = 32;
const MAX_MODELS = 64;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const REASONING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const CREDENTIAL_PREFIX = 'model/credential/';
const MISSING_CATALOG = Symbol('missing-catalog');

// Fixed English errors. Never echo caller values (secrets, endpoints, YAML
// snippets) into a message. The MODEL_CATALOG code lets trusted main return
// these exact messages without inspecting arbitrary causes.
const fixed = message => Object.assign(new Error(message), { code: 'MODEL_CATALOG' });
const failure = () => fixed('The model catalog is unavailable. Saved data was preserved.');
const guard = error => error && error.code === 'MODEL_CATALOG' ? error : failure();
const text = (value, limit = 256) => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const safeId = id => text(id, 64) && /^[a-z0-9][a-z0-9-]*$/.test(id) && !['__proto__', 'prototype', 'constructor'].includes(id);
const exactKeys = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const clone = value => JSON.parse(JSON.stringify(value));

// Legacy endpoint rule for model-authorizations.json and v1 catalogs: an
// explicit /v1 path, no userinfo, query, fragment or backslash.
function legacyEndpoint(value) {
  if (!text(value, 2048) || !/^https?:\/\//i.test(value) || /[\s\\?#]/.test(value)) throw fixed('Invalid model authorization.');
  let url;
  try { url = new URL(value); } catch { throw fixed('Invalid model authorization.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password ||
      value.split('/')[2].includes('@') || !/\/v1\/?$/.test(url.pathname)) throw fixed('Invalid model authorization.');
  return url.href.replace(/\/$/, '');
}

// Explicit API base path for v2 catalogs and UI saves/imports. The raw input is
// checked for characters the URL parser would rewrite (backslash, percent
// escapes) and for ambiguous dot segments before any normalization. Only a
// canonical trailing slash is normalized away.
function endpoint(value) {
  if (!text(value, 2048) || !/^https?:\/\//i.test(value) || /[\s\\?#%]/.test(value)) throw fixed('Enter a valid model endpoint.');
  const authority = value.slice(value.indexOf('://') + 3);
  const slash = authority.indexOf('/');
  const rawPath = slash === -1 ? '' : authority.slice(slash);
  if (authority.includes('@') || rawPath.split('/').includes('.') || rawPath.split('/').includes('..'))
    throw fixed('Enter a valid model endpoint.');
  let url;
  try { url = new URL(value); } catch { throw fixed('Enter a valid model endpoint.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password ||
      url.search !== '' || url.hash !== '') throw fixed('Enter a valid model endpoint.');
  return url.origin + url.pathname.replace(/\/+$/, '');
}

function authorizations(value) {
  if (!exactKeys(value, ['version', 'providers']) || value.version !== 1 || !record(value.providers) ||
      Object.keys(value.providers).length > MAX_PROVIDERS) throw fixed('Invalid model authorization.');
  const result = Object.create(null);
  for (const [id, provider] of Object.entries(value.providers)) {
    if (!safeId(id) || !exactKeys(provider, ['endpoint', 'model']) || !text(provider.model)) throw fixed('Invalid model authorization.');
    result[id] = { endpoint: legacyEndpoint(provider.endpoint), model: provider.model };
  }
  return result;
}

function readState(file, fallback, message) {
  try { return readJson(file, fallback); } catch { throw fixed(message); }
}

function readYaml(file) {
  try { return yaml.load(fs.readFileSync(file, 'utf8')); }
  catch { throw fixed('DSH configuration is unreadable or invalid.'); }
}

// Legacy single-model authority derived from an already-saved v1 catalog. Only
// already-saved host providers grant legacy authority, never the desktop
// profile. Every error is remapped by the constructor to a fixed message.
function legacyAuthorizations(providers) {
  const result = Object.create(null);
  for (const provider of providers) {
    if (!record(provider) || !safeId(provider.id) || Object.hasOwn(result, provider.id) ||
        !Array.isArray(provider.models) || provider.models.length !== 1 || !record(provider.models[0]) || !text(provider.models[0].id))
      throw fixed('Invalid saved catalog.');
    result[provider.id] = { endpoint: legacyEndpoint(provider.baseURL), model: provider.models[0].id };
  }
  return result;
}

function normalizeProvider(id, input, authorization = Object.create(null)) {
  const authorized = safeId(id) && Object.hasOwn(authorization, id) ? authorization[id] : null;
  if (!authorized || !record(input) || input.api !== 'openai-completions' || typeof input.baseURL !== 'string' ||
      legacyEndpoint(input.baseURL) !== authorized.endpoint || !Array.isArray(input.models))
    throw fixed('Invalid saved catalog.');
  const models = input.models.filter(model => record(model) && model.id === authorized.model).map(model => {
    if (!text(model.id) || !text(model.name ?? model.id) || !Number.isSafeInteger(model.contextWindow) || model.contextWindow < 1 ||
        !Number.isSafeInteger(model.maxTokens) || model.maxTokens < 1 || model.maxTokens > model.contextWindow) throw fixed('Invalid saved catalog.');
    const result = { id: model.id, name: model.name ?? model.id, contextWindow: model.contextWindow, maxTokens: model.maxTokens };
    if (model.input !== undefined) {
      if (!Array.isArray(model.input) || !model.input.length || !model.input.every(value => ['text', 'image'].includes(value))) throw fixed('Invalid saved catalog.');
      result.input = [...new Set(model.input)];
    }
    if (model.reasoningEfforts !== undefined) {
      if (!model.reasoningEfforts || typeof model.reasoningEfforts !== 'object' || Array.isArray(model.reasoningEfforts)) throw fixed('Invalid saved catalog.');
      const efforts = {};
      for (const [name, value] of Object.entries(model.reasoningEfforts)) {
        if (!REASONING_LEVELS.has(name) || (value !== null && !text(value, 64))) throw fixed('Invalid saved catalog.');
        efforts[name] = value;
      }
      result.reasoningEfforts = efforts;
    }
    return result;
  });
  if (models.length !== 1 || (input.displayName !== undefined && !text(input.displayName, 200))) throw fixed('Invalid saved catalog.');
  const normalized = { id, displayName: input.displayName ?? id, api: input.api, baseURL: authorized.endpoint, models,
    credentialRef: `model/provider/${id}`, authMode: 'bearer' };
  return normalized;
}

function legacyLoad(stored, authorization) {
  if (!record(stored) || stored.version !== 1 || !Array.isArray(stored.providers) || stored.providers.length > MAX_PROVIDERS)
    throw fixed('Invalid saved catalog.');
  let providers;
  try {
    const auth = authorization === null ? legacyAuthorizations(stored.providers) : authorization;
    providers = stored.providers.map(provider => {
      if (!record(provider) || !Array.isArray(provider.models) || provider.models.length !== 1) throw fixed('Invalid saved catalog.');
      const normalized = normalizeProvider(provider.id, provider, auth);
      if (normalized.baseURL !== provider.baseURL || normalized.credentialRef !== provider.credentialRef) throw fixed('Invalid saved catalog.');
      return normalized;
    });
  } catch { throw fixed('Invalid saved catalog.'); }
  const selected = stored.selected === null || stored.selected === undefined ? null : stored.selected;
  if (new Set(providers.map(provider => provider.id)).size !== providers.length ||
      (selected !== null && (!record(selected) || !text(selected.provider, 64) || !text(selected.model, 256) ||
        !providers.some(provider => provider.id === selected.provider && provider.models.some(model => model.id === selected.model)))))
    throw fixed('Invalid saved model selection.');
  return { providers, selected: selected ? { provider: selected.provider, model: selected.model } : null };
}

function validateModels(models) {
  if (!Array.isArray(models) || models.length === 0 || models.length > MAX_MODELS) throw fixed('Enter between 1 and 64 models.');
  const seen = new Set();
  const result = [];
  for (const model of models) {
    if (!record(model) || !text(model.id, 256) || seen.has(model.id)) throw fixed('Invalid model definition.');
    seen.add(model.id);
    if (!text(model.name ?? model.id)) throw fixed('Invalid model definition.');
    if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow < 1) throw fixed('Invalid model definition.');
    if (!Number.isSafeInteger(model.maxTokens) || model.maxTokens < 1 || model.maxTokens > model.contextWindow) throw fixed('Invalid model definition.');
    const entry = { id: model.id, name: model.name ?? model.id, contextWindow: model.contextWindow, maxTokens: model.maxTokens };
    if (model.input !== undefined) {
      if (!Array.isArray(model.input) || !model.input.length || !model.input.every(value => ['text', 'image'].includes(value))) throw fixed('Invalid model input modes.');
      entry.input = [...new Set(model.input)];
    }
    if (model.reasoningEfforts !== undefined) {
      if (!model.reasoningEfforts || typeof model.reasoningEfforts !== 'object' || Array.isArray(model.reasoningEfforts)) throw fixed('Invalid reasoning settings.');
      const efforts = {};
      for (const [name, value] of Object.entries(model.reasoningEfforts)) {
        if (!REASONING_LEVELS.has(name) || (value !== null && !text(value, 64))) throw fixed('Invalid reasoning settings.');
        efforts[name] = value;
      }
      entry.reasoningEfforts = efforts;
    }
    result.push(entry);
  }
  return result;
}

function validateProviderInput(input) {
  if (!record(input)) throw fixed('Invalid provider details.');
  if (!safeId(input.id)) throw fixed('Enter a unique provider ID.');
  if (input.api !== 'openai-completions') throw fixed('Unsupported provider API.');
  const baseURL = endpoint(input.baseURL);
  const authMode = input.authMode === 'bearer' || input.authMode === 'none' ? input.authMode : null;
  if (!authMode) throw fixed('Invalid provider auth mode.');
  let displayName = input.displayName;
  if (displayName === undefined) displayName = input.id;
  else if (!text(displayName, 200)) throw fixed('Enter a provider display name.');
  return { id: input.id, displayName, api: 'openai-completions', baseURL, authMode, models: validateModels(input.models) };
}

function validateValue(value) {
  if (typeof value !== 'string' || !value.length || value !== value.trim() ||
      Buffer.byteLength(value, 'utf8') > 65536 || /[\x00-\x1f\x7f]/.test(value))
    throw fixed('Enter a valid API key.');
  return value;
}

// v2 catalog entries: validated metadata with an optional vault reference.
function validateV2Provider(provider) {
  if (!record(provider) || !safeId(provider.id) || provider.api !== 'openai-completions' ||
      !text(provider.displayName, 200)) throw fixed('Invalid saved catalog.');
  const baseURL = endpoint(provider.baseURL);
  const authMode = provider.authMode === 'bearer' || provider.authMode === 'none' ? provider.authMode : null;
  if (!authMode) throw fixed('Invalid saved catalog.');
  const models = validateModels(provider.models);
  const keys = authMode === 'bearer' ? ['id', 'displayName', 'api', 'baseURL', 'authMode', 'models', 'credentialRef']
                                     : ['id', 'displayName', 'api', 'baseURL', 'authMode', 'models'];
  if (!exactKeys(provider, keys)) throw fixed('Invalid saved catalog.');
  const result = { id: provider.id, displayName: provider.displayName, api: 'openai-completions', baseURL, authMode, models };
  if (authMode === 'bearer') {
    const ref = provider.credentialRef;
    if (typeof ref !== 'string') throw fixed('Invalid saved catalog.');
    // Legacy model/provider/<id> refs are accepted only when they name the
    // provider itself; v2 writes fresh UUID refs under model/credential/.
    if (ref === `model/provider/${provider.id}`) result.credentialRef = ref;
    else if (ref.startsWith(CREDENTIAL_PREFIX) && UUID.test(ref.slice(CREDENTIAL_PREFIX.length))) result.credentialRef = ref;
    else throw fixed('Invalid saved catalog.');
  }
  return result;
}

function v2Load(stored) {
  if (!record(stored) || stored.version !== 2 || !Array.isArray(stored.providers) || stored.providers.length > MAX_PROVIDERS ||
      !exactKeys(stored, ['version', 'providers', 'selected'])) throw fixed('Invalid saved catalog.');
  const providers = stored.providers.map(provider => {
    try { return validateV2Provider(provider); } catch { throw fixed('Invalid saved catalog.'); }
  });
  const refs = providers.map(provider => provider.credentialRef).filter(Boolean);
  if (new Set(providers.map(provider => provider.id)).size !== providers.length ||
      new Set(refs).size !== refs.length) throw fixed('Invalid saved catalog.');
  const selected = stored.selected === null ? null : stored.selected;
  if (selected !== null) {
    if (!exactKeys(selected, ['provider', 'model']) || !text(selected.provider, 64) || !text(selected.model, 256) ||
        !providers.some(provider => provider.id === selected.provider && provider.models.some(model => model.id === selected.model)))
      throw fixed('Invalid saved model selection.');
  }
  return { providers, selected };
}

function desktopConfiguration(dshRoot) {
  const patches = readYaml(path.join(dshRoot, 'profiles/desktop/cordis.patch.yml'));
  if (!Array.isArray(patches)) throw fixed('Invalid desktop profile.');
  const plugins = patches.filter(patch => patch?.id === 'llm-pi-ai');
  const defaults = patches.filter(patch => patch?.id === 'agent-default-model');
  if (plugins.length !== 1 || defaults.length !== 1) throw fixed('Ambiguous desktop configuration.');
  return { source: plugins[0].config?.providers, selected: defaults[0].config };
}

function importProvider(id, input) {
  if (!safeId(id) || !record(input) || input.api !== 'openai-completions') throw fixed('A desktop provider is not supported.');
  const baseURL = endpoint(input.baseURL);
  // A missing apiKeyEnv marks an explicitly unauthenticated endpoint. Any
  // configured-but-unusable reference (empty or non-string) fails rather than
  // silently downgrading a provider that needs a credential.
  const env = input.apiKeyEnv;
  let authMode = 'none';
  if (Object.hasOwn(input, 'apiKeyEnv')) {
    if (typeof env !== 'string' || env.length === 0) throw fixed('A desktop provider is not supported.');
    authMode = 'bearer';
  }
  let displayName = input.displayName;
  if (displayName !== undefined && !text(displayName, 200)) throw fixed('A desktop provider is not supported.');
  if (displayName === undefined) displayName = id;
  return { id, displayName, api: 'openai-completions', baseURL, authMode, models: validateModels(input.models) };
}

function validateImportPlan(plan) {
  if (!record(plan) || !Array.isArray(plan.providers) || !plan.providers.length || plan.providers.length > MAX_PROVIDERS) throw fixed('Invalid desktop import plan.');
  const providers = [];
  for (const input of plan.providers) {
    if (!record(input)) throw fixed('Invalid desktop import plan.');
    let provider;
    try { provider = validateProviderInput(input); } catch { throw fixed('Invalid desktop import plan.'); }
    if (provider.authMode === 'bearer') {
      let value;
      try { value = input.value === undefined ? undefined : validateValue(input.value); } catch { throw fixed('Invalid desktop import plan.'); }
      if (value === undefined) throw fixed('Invalid desktop import plan.');
      provider.value = value;
    } else if (input.value !== undefined) throw fixed('Invalid desktop import plan.');
    providers.push(provider);
  }
  if (new Set(providers.map(provider => provider.id)).size !== providers.length) throw fixed('Invalid desktop import plan.');
  const dshDefault = record(plan.dshDefault) && providers.some(provider => provider.id === plan.dshDefault.provider &&
    provider.models.some(model => model.id === plan.dshDefault.model))
    ? { provider: plan.dshDefault.provider, model: plan.dshDefault.model } : null;
  if (!dshDefault) throw fixed('Invalid desktop import plan.');
  return { providers, dshDefault };
}

class ModelCatalog {
  constructor({ stateRoot, vault, dshRoot = path.join(os.homedir(), '.dsh'), fetcher = fetch }) {
    this.file = path.join(stateRoot, 'models.json');
    this.vault = vault;
    this.dshRoot = dshRoot;
    this.fetcher = fetcher;
    this.queue = Promise.resolve();
    this.fault = false;
    this.cleanupPending = false;
    this.probes = new Map();
    this.generation = 0;
    this.authorization = null;
    const stored = readState(this.file, MISSING_CATALOG, 'Invalid saved catalog.');
    if (stored === MISSING_CATALOG) {
      this.version = 2; this._providers = []; this.selected = null;
    } else if (!record(stored)) {
      throw fixed('Invalid saved catalog.');
    } else if (stored.version === 1) {
      // Only legacy catalogs depend on legacy authorizations. New and migrated
      // UI catalogs must not read or rewrite this obsolete file.
      const explicitPath = path.join(stateRoot, 'model-authorizations.json');
      const explicit = readState(explicitPath, undefined, 'Invalid model authorization.');
      if (explicit !== undefined) this.authorization = authorizations(explicit);
      this.version = 1;
      const loaded = legacyLoad(stored, this.authorization);
      this._providers = loaded.providers; this.selected = loaded.selected;
    } else if (stored.version === 2) {
      this.version = 2;
      const loaded = v2Load(stored);
      this._providers = loaded.providers; this.selected = loaded.selected;
    } else {
      throw fixed('Invalid saved catalog.');
    }
  }
  // Runtime grants. When disk state is uncertain no stale provider list may be
  // leased, so the accessor refuses instead of returning it.
  get providers() {
    if (this.fault) throw failure();
    return clone(this._providers);
  }
  snapshot() {
    return {
      fault: this.fault,
      cleanupPending: this.cleanupPending,
      selected: this.fault ? null : this.selected && { ...this.selected },
      providers: this.fault ? [] : this._providers.map(provider => ({
        id: provider.id, displayName: provider.displayName, api: provider.api, baseURL: provider.baseURL,
        authMode: provider.authMode,
        models: clone(provider.models),
        credentialAvailable: provider.authMode === 'none' ? false : this.vault.has(provider.credentialRef),
        ...(this.probes.get(provider.id) ?? { availability: 'not-checked' }),
      })),
    };
  }
  serial(work) {
    const pending = this.queue.then(work);
    this.queue = pending.catch(() => {});
    return pending;
  }
  serializable(provider) {
    const entry = { id: provider.id, displayName: provider.displayName, api: provider.api, baseURL: provider.baseURL,
      authMode: provider.authMode, models: clone(provider.models) };
    if (provider.authMode === 'bearer') entry.credentialRef = provider.credentialRef;
    return entry;
  }
  persist(providers, selected) {
    try {
      writeJson(this.file, { version: 2, providers: providers.map(provider => this.serializable(provider)), selected });
    } catch {
      // Metadata publication is uncertain: a rename may have succeeded before
      // directory fsync failed. Retain every new and old ciphertext and block
      // further leases until a restart revalidates disk.
      this.fault = true;
      throw failure();
    }
    this._providers = providers;
    this.selected = selected;
    this.version = 2;
  }
  async retire(ref) {
    try { await this.vault.remove(ref); }
    catch { this.cleanupPending = true; }
  }
  prepareSave(input) {
    if (this.fault) throw failure();
    const plan = validateProviderInput(input);
    const previous = this._providers.find(provider => provider.id === plan.id);
    if (!previous && this._providers.length >= MAX_PROVIDERS) throw fixed('The limit of 32 providers has been reached.');
    if (previous && this.selected && this.selected.provider === plan.id &&
        !plan.models.some(model => model.id === this.selected.model))
      throw fixed('Choose another default model first, then save this provider.');
    const value = input.value === undefined || input.value === '' ? undefined : validateValue(input.value);
    if (plan.authMode === 'none') {
      if (value !== undefined) throw fixed('This endpoint does not use an API key.');
    } else if (value === undefined) {
      const sameEndpoint = previous && previous.baseURL === plan.baseURL;
      const keyPresent = previous && previous.authMode === 'bearer' && this.vault.has(previous.credentialRef);
      if (!sameEndpoint || !keyPresent) throw fixed('Enter an API key for this endpoint.');
    }
    return { ...plan, ...(value === undefined ? {} : { value }) };
  }
  save(input, { signal } = {}) {
    let captured;
    try { captured = this.prepareSave(input); } catch (error) { return Promise.reject(guard(error)); }
    return this.serial(async () => {
      signal?.throwIfAborted();
      const plan = this.prepareSave(captured);
      const previous = this._providers.find(provider => provider.id === plan.id);
      const rotate = plan.authMode === 'bearer' && plan.value !== undefined;
      const credentialRef = plan.authMode === 'bearer'
        ? (rotate ? `${CREDENTIAL_PREFIX}${randomUUID()}` : previous.credentialRef) : undefined;
      if (plan.value !== undefined) {
        try { await this.vault.put(credentialRef, plan.value); }
        catch { throw fixed('The API key could not be encrypted. Check Keychain availability.'); }
      }
      if (signal?.aborted) {
        if (rotate) await this.retire(credentialRef);
        signal.throwIfAborted();
      }
      const provider = { id: plan.id, displayName: plan.displayName, api: plan.api, baseURL: plan.baseURL,
        authMode: plan.authMode, models: plan.models, ...(plan.authMode === 'bearer' ? { credentialRef } : {}) };
      const next = previous ? this._providers.map(item => item.id === plan.id ? provider : item) : [...this._providers, provider];
      // The first manual save explicitly establishes the first model default.
      const selected = this.selected === null
        ? { provider: plan.id, model: plan.models[0].id } : this.selected;
      this.persist(next, selected);
      if (previous && previous.credentialRef && previous.credentialRef !== provider.credentialRef) await this.retire(previous.credentialRef);
      this.probes.clear(); this.generation++;
      return this.snapshot();
    });
  }
  prepareRemove(id) {
    if (this.fault) throw failure();
    const provider = typeof id === 'string' && this._providers.find(item => item.id === id);
    if (!provider) throw fixed('Unknown model provider.');
    if (this.selected && this.selected.provider === id && this._providers.length > 1)
      throw fixed('Choose another model first, then remove this provider.');
    return { id: provider.id };
  }
  remove(id, { signal } = {}) {
    let captured;
    try { captured = this.prepareRemove(id); } catch (error) { return Promise.reject(guard(error)); }
    return this.serial(async () => {
      signal?.throwIfAborted();
      this.prepareRemove(captured.id);
      const provider = this._providers.find(item => item.id === captured.id);
      const next = this._providers.filter(item => item.id !== captured.id);
      const selected = this.selected && this.selected.provider === captured.id ? null : this.selected;
      this.persist(next, selected);
      if (provider.credentialRef) await this.retire(provider.credentialRef);
      this.probes.clear(); this.generation++;
      return this.snapshot();
    });
  }
  prepareSelect(selection) {
    if (this.fault) throw failure();
    if (!record(selection) || !text(selection.provider, 64) || !text(selection.model, 256)) throw fixed('Invalid model selection.');
    const provider = this._providers.find(item => item.id === selection.provider);
    if (!provider) throw fixed('Unknown model provider.');
    if (!provider.models.some(model => model.id === selection.model)) throw fixed('Unknown model.');
    return { provider: selection.provider, model: selection.model };
  }
  select(selection, { signal } = {}) {
    let captured;
    try { captured = this.prepareSelect(selection); } catch (error) { return Promise.reject(guard(error)); }
    return this.serial(async () => {
      signal?.throwIfAborted();
      const selected = this.prepareSelect(captured);
      this.persist(this._providers, selected);
      this.probes.clear(); this.generation++;
      return this.snapshot();
    });
  }
  prepareImport() {
    if (this.fault) throw failure();
    const { source, selected } = desktopConfiguration(this.dshRoot);
    if (!record(source)) throw fixed('Invalid desktop provider configuration.');
    let credentials;
    const providers = [];
    for (const [id, input] of Object.entries(source)) {
      const provider = importProvider(id, input);
      if (provider.authMode === 'bearer') {
        credentials ??= readYaml(path.join(this.dshRoot, '.credentials.yaml'));
        const value = credentials?.refs?.[input.apiKeyEnv];
        if (typeof value !== 'string' || !value.length || Buffer.byteLength(value, 'utf8') > 65536 || /[\x00-\x1f\x7f]/.test(value))
          throw fixed('A desktop provider credential is unavailable.');
        provider.value = value;
      }
      providers.push(provider);
    }
    if (!record(selected) || !providers.some(provider => provider.id === selected.provider &&
        provider.models.some(model => model.id === selected.model)))
      throw fixed('The desktop default model is not configured.');
    const plan = validateImportPlan({ providers, dshDefault: { provider: selected.provider, model: selected.model } });
    this.checkImportSelection(plan);
    return plan;
  }
  checkImportSelection(plan) {
    const merged = [...this._providers.filter(current => !plan.providers.some(provider => provider.id === current.id)), ...plan.providers];
    if (merged.length > MAX_PROVIDERS) throw fixed('The limit of 32 providers has been reached.');
    if (this.selected && !merged.some(provider => provider.id === this.selected.provider &&
        provider.models.some(model => model.id === this.selected.model)))
      throw fixed('Choose a new model in the model list, then import again.');
  }
  importDesktop({ signal, prepared } = {}) {
    let captured;
    try { captured = prepared === undefined ? this.prepareImport() : validateImportPlan(prepared); }
    catch (error) { return Promise.reject(guard(error)); }
    return this.serial(async () => {
      signal?.throwIfAborted();
      if (this.fault) throw failure();
      const plan = validateImportPlan(captured);
      this.checkImportSelection(plan);
      const imported = plan.providers.map(provider => ({ ...provider,
        credentialRef: provider.authMode === 'bearer' ? `${CREDENTIAL_PREFIX}${randomUUID()}` : undefined }));
      const storedImported = imported.map(({ value, ...provider }) => provider);
      const merged = [...this._providers.filter(current => !imported.some(provider => provider.id === current.id)),
        ...storedImported.map(clone)];
      if (merged.length > MAX_PROVIDERS) throw fixed('The limit of 32 providers has been reached.');
      let selected;
      if (this.selected && merged.some(provider => provider.id === this.selected.provider &&
          provider.models.some(model => model.id === this.selected.model))) {
        selected = { ...this.selected };
      } else if (this.selected) {
        throw fixed('Choose a new model in the model list, then import again.');
      } else {
        selected = { provider: plan.dshDefault.provider, model: plan.dshDefault.model };
      }
      const bearer = imported.filter(provider => provider.authMode === 'bearer');
      if (bearer.length) {
        try {
          await this.vault.putMany(Object.fromEntries(bearer.map(provider => [provider.credentialRef, provider.value])));
        } catch { throw fixed('The imported API keys could not be encrypted. Check Keychain availability.'); }
      }
      if (signal?.aborted) {
        for (const provider of bearer) await this.retire(provider.credentialRef);
        signal.throwIfAborted();
      }
      const priorRefs = this._providers.map(provider => provider.credentialRef).filter(Boolean);
      this.persist(merged, selected);
      for (const ref of priorRefs) {
        if (!merged.some(provider => provider.credentialRef === ref)) await this.retire(ref);
      }
      this.probes.clear(); this.generation++;
      return this.snapshot();
    });
  }
  probe() {
    return this.serial(async () => {
      if (this.fault) throw failure();
      const providers = this._providers.slice();
      await Promise.all(providers.map(async provider => {
        let availability = 'unreachable';
        try {
          if (provider.authMode === 'bearer') {
            let secret;
            try { secret = await this.vault.get(provider.credentialRef); }
            catch (error) { if (error.code === 'VAULT_UNAVAILABLE') availability = 'vault-unavailable'; }
            if (availability === 'vault-unavailable') { this.probes.set(provider.id, { availability, checkedAt: new Date().toISOString() }); return; }
            if (!secret) availability = 'missing-credential';
            else availability = await this.checkProvider(provider, secret);
          } else {
            availability = await this.checkProvider(provider);
          }
        } catch { /* keep the current status on any other failure */ }
        this.probes.set(provider.id, { availability, checkedAt: new Date().toISOString() });
      }));
      return this.snapshot();
    });
  }
  // Bounded GET /models: manual redirects, a capped body, no Authorization
  // header and no vault access for authMode none, and no payload reflection.
  async checkProvider(provider, secret) {
    const headers = { Accept: 'application/json' };
    if (secret !== undefined) headers.Authorization = `Bearer ${secret}`;
    const response = await this.fetcher(provider.baseURL + '/models', {
      method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15000), headers,
    });
    if (response.status === 401 || response.status === 403) { await response.body?.cancel(); return 'unauthorized'; }
    if (response.status !== 200) { await response.body?.cancel(); return 'upstream-error'; }
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 1024 * 1024) throw new Error('Response limit'); chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return Array.isArray(body.data) && provider.models.every(model => body.data.some(item => item?.id === model.id))
      ? 'available' : 'model-not-loaded';
  }
}

module.exports = { ModelCatalog };
