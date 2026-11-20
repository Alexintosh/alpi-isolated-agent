'use strict';

/**
 * Small, explicit engine registry.
 *
 * Production installs only verified adapter factories. Test adapters must be
 * marked `testOnly` and can only be installed when the registry was created
 * with `allowTestAdapters: true`. Selection never falls back to a default
 * engine: the caller names one engine and the capabilities it requires.
 */

const ENGINE_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

class EngineRegistryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EngineRegistryError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new EngineRegistryError(code, message);
}

function normalizeEngineId(value) {
  if (typeof value !== 'string' || !ENGINE_ID_PATTERN.test(value)) {
    fail('invalid_input', 'Invalid engine id.');
  }
  return value;
}

function normalizeCapabilities(value) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    fail('invalid_input', 'Capabilities must be an array.');
  }
  const seen = new Set();
  for (const capability of value) {
    if (typeof capability !== 'string' || !CAPABILITY_PATTERN.test(capability)) {
      fail('invalid_input', 'Invalid capability name.');
    }
    if (seen.has(capability)) {
      fail('invalid_input', 'Duplicate capability name.');
    }
    seen.add(capability);
  }
  return [...seen];
}

function normalizeProbe(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid_engine_probe', 'Engine probe returned an invalid result.');
  }
  if (typeof value.available !== 'boolean') {
    fail('invalid_engine_probe', 'Engine probe did not report availability.');
  }
  if (value.version !== null && typeof value.version !== 'string') {
    fail('invalid_engine_probe', 'Engine probe returned an invalid version.');
  }
  const capabilities = normalizeCapabilities(value.capabilities);
  let reason;
  if (value.reason !== undefined) {
    if (typeof value.reason !== 'string' || value.reason.length === 0) {
      fail('invalid_engine_probe', 'Engine probe returned an invalid reason.');
    }
    reason = value.reason;
  }
  return {
    available: value.available,
    version: value.version,
    capabilities,
    ...(reason === undefined ? {} : { reason }),
  };
}

function validateAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object' || typeof adapter.probe !== 'function') {
    fail('invalid_engine_adapter', 'Engine factory did not return a probe-capable adapter.');
  }
  return adapter;
}

/**
 * Create a registry.
 *
 * @param {{ allowTestAdapters?: boolean }} [options]
 * @returns {{
 *   install(spec: { id: string, factory: Function, testOnly?: boolean }): { id: string, testOnly: boolean },
 *   has(id: string): boolean,
 *   list(): Array<{ id: string, testOnly: boolean }>,
 *   probe(id: string, adapterOptions?: unknown): Promise<{ engineId: string, available: boolean, version: string|null, capabilities: string[], reason?: string }>,
 *   select(spec: { engineId: string, capabilities?: string[], options?: unknown }): Promise<{ engineId: string, version: string|null, capabilities: string[], adapter: object }>,
 *   close(): void
 * }}
 */
function createEngineRegistry(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    fail('invalid_input', 'Registry options must be an object.');
  }
  const allowTestAdapters = options.allowTestAdapters === true;
  const entries = new Map();
  let closed = false;

  function requireOpen() {
    if (closed) {
      fail('registry_closed', 'Engine registry is closed.');
    }
  }

  function entryFor(id) {
    requireOpen();
    const engineId = normalizeEngineId(id);
    const entry = entries.get(engineId);
    if (!entry) {
      fail('unknown_engine', `Unknown engine: ${engineId}.`);
    }
    if (entry.testOnly && !allowTestAdapters) {
      fail('test_adapter_forbidden', 'Test-only engine adapters are disabled.');
    }
    return entry;
  }

  async function createAdapter(entry, adapterOptions) {
    const adapter = await entry.factory(adapterOptions);
    return validateAdapter(adapter);
  }

  return {
    install(spec) {
      requireOpen();
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        fail('invalid_input', 'Engine install specification must be an object.');
      }
      const id = normalizeEngineId(spec.id);
      if (typeof spec.factory !== 'function') {
        fail('invalid_input', 'Engine factory must be a function.');
      }
      if (spec.testOnly !== undefined && typeof spec.testOnly !== 'boolean') {
        fail('invalid_input', 'testOnly must be a boolean.');
      }
      const testOnly = spec.testOnly === true;
      if (testOnly && !allowTestAdapters) {
        fail('test_adapter_forbidden', 'Test-only engine adapters are disabled.');
      }
      if (entries.has(id)) {
        fail('engine_already_installed', `Engine already installed: ${id}.`);
      }
      entries.set(id, { id, testOnly, factory: spec.factory });
      return { id, testOnly };
    },

    has(id) {
      requireOpen();
      return entries.has(normalizeEngineId(id));
    },

    list() {
      requireOpen();
      return [...entries.values()]
        .map((entry) => ({ id: entry.id, testOnly: entry.testOnly }))
        .sort((left, right) => left.id.localeCompare(right.id));
    },

    async probe(id, adapterOptions) {
      const entry = entryFor(id);
      const adapter = await createAdapter(entry, adapterOptions);
      try {
        const result = normalizeProbe(await adapter.probe());
        return Object.freeze({
          engineId: entry.id,
          available: result.available,
          version: result.version,
          capabilities: Object.freeze(result.capabilities),
          ...(result.reason === undefined ? {} : { reason: result.reason }),
        });
      } finally {
        await adapter.close?.();
      }
    },

    async select(spec) {
      requireOpen();
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        fail('invalid_input', 'Engine selection must be an object.');
      }
      if (typeof spec.engineId !== 'string' || spec.engineId.length === 0) {
        fail('invalid_input', 'An explicit engine id is required.');
      }
      const requested = normalizeCapabilities(spec.capabilities);
      const entry = entryFor(spec.engineId);
      const adapter = await createAdapter(entry, spec.options);
      try {
        const result = normalizeProbe(await adapter.probe());
        if (!result.available) {
          fail(
            'unavailable_engine',
            `Engine ${entry.id} is unavailable${result.reason === undefined ? '.' : `: ${result.reason}.`}`
          );
        }
        const supported = new Set(result.capabilities);
        const missing = requested.filter((capability) => !supported.has(capability));
        if (missing.length > 0) {
          fail(
            'unsupported_capability',
            `Engine ${entry.id} does not support: ${missing.join(', ')}.`
          );
        }
        return Object.freeze({
          engineId: entry.id,
          version: result.version,
          capabilities: Object.freeze([...result.capabilities]),
          adapter,
        });
      } catch (error) {
        await adapter.close?.();
        throw error;
      }
    },

    close() {
      if (closed) {
        return;
      }
      closed = true;
      entries.clear();
    },
  };
}

module.exports = {
  EngineRegistryError,
  createEngineRegistry,
};
