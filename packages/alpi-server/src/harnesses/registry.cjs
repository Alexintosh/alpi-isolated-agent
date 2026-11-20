'use strict';

/**
 * Explicit harness registry.
 *
 * A harness is a session/agent runtime (Pi, OpenCode, a shell fixture). It is
 * deliberately separate from the model provider and model id: selection takes
 * a harness id and, at most, returns the caller's model choice unchanged. The
 * registry never derives a model from a harness and never passes a model to the
 * harness factory.
 *
 * Production installs only operator-approved factories. Test adapters must be
 * marked `testOnly` and can only be installed when the registry was created
 * with `allowTestHarnesses: true`. Selection never falls back to a default
 * harness: the caller names one harness and the capabilities it requires.
 */

const HARNESS_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const MODEL_PATTERN = /^[A-Za-z0-9._:/+-]{1,256}$/;

class HarnessRegistryError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'HarnessRegistryError';
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

function fail(code, message, details) {
  throw new HarnessRegistryError(code, message, details);
}

function normalizeHarnessId(value) {
  if (typeof value !== 'string' || !HARNESS_ID_PATTERN.test(value)) {
    fail('invalid_input', 'Invalid harness id.');
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
    fail('invalid_harness_probe', 'Harness probe returned an invalid result.');
  }
  if (typeof value.available !== 'boolean') {
    fail('invalid_harness_probe', 'Harness probe did not report availability.');
  }
  if (value.version !== null && typeof value.version !== 'string') {
    fail('invalid_harness_probe', 'Harness probe returned an invalid version.');
  }
  const capabilities = normalizeCapabilities(value.capabilities);
  let reason;
  if (value.reason !== undefined) {
    if (typeof value.reason !== 'string' || value.reason.length === 0) {
      fail('invalid_harness_probe', 'Harness probe returned an invalid reason.');
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

function validateAdapter(adapter, harnessId) {
  if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) {
    fail('invalid_harness_adapter', 'Harness factory did not return an adapter.');
  }
  if (adapter.id !== undefined && adapter.id !== harnessId) {
    fail('invalid_harness_adapter', 'Harness adapter id does not match its registration.');
  }
  if (typeof adapter.probe !== 'function') {
    fail('invalid_harness_adapter', 'Harness adapter is missing probe().');
  }
  for (const method of ['createSession', 'resumeSession']) {
    if (typeof adapter[method] !== 'function') {
      fail('invalid_harness_adapter', `Harness adapter is missing ${method}().`);
    }
  }
  return adapter;
}

/**
 * Create a harness registry.
 *
 * @param {{ allowTestHarnesses?: boolean }} [options]
 * @returns {{
 *   install(spec: { id: string, factory: Function, testOnly?: boolean }): { id: string, testOnly: boolean },
 *   has(id: string): boolean,
 *   list(): Array<{ id: string, testOnly: boolean }>,
 *   probe(id: string, adapterOptions?: unknown): Promise<{ harnessId: string, available: boolean, version: string|null, capabilities: string[], reason?: string }>,
 *   select(spec: { harnessId: string, capabilities?: string[], options?: unknown, model?: string }): Promise<{ harnessId: string, version: string|null, capabilities: string[], adapter: object, model: string|null }>,
 *   close(): void
 * }}
 */
function createHarnessRegistry(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    fail('invalid_input', 'Registry options must be an object.');
  }
  const allowTestHarnesses = options.allowTestHarnesses === true;
  const entries = new Map();
  let closed = false;

  function requireOpen() {
    if (closed) {
      fail('registry_closed', 'Harness registry is closed.');
    }
  }

  function entryFor(id) {
    requireOpen();
    const harnessId = normalizeHarnessId(id);
    const entry = entries.get(harnessId);
    if (!entry) {
      fail('unknown_harness', `Unknown harness: ${harnessId}.`);
    }
    if (entry.testOnly && !allowTestHarnesses) {
      fail('test_harness_forbidden', 'Test-only harness adapters are disabled.');
    }
    return entry;
  }

  async function createAdapter(entry, adapterOptions) {
    const adapter = await entry.factory(adapterOptions);
    return validateAdapter(adapter, entry.id);
  }

  return {
    install(spec) {
      requireOpen();
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        fail('invalid_input', 'Harness install specification must be an object.');
      }
      const id = normalizeHarnessId(spec.id);
      if (typeof spec.factory !== 'function') {
        fail('invalid_input', 'Harness factory must be a function.');
      }
      if (spec.testOnly !== undefined && typeof spec.testOnly !== 'boolean') {
        fail('invalid_input', 'testOnly must be a boolean.');
      }
      const testOnly = spec.testOnly === true;
      if (testOnly && !allowTestHarnesses) {
        fail('test_harness_forbidden', 'Test-only harness adapters are disabled.');
      }
      if (entries.has(id)) {
        fail('harness_already_installed', `Harness already installed: ${id}.`);
      }
      entries.set(id, { id, testOnly, factory: spec.factory });
      return { id, testOnly };
    },

    has(id) {
      requireOpen();
      return entries.has(normalizeHarnessId(id));
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
      const result = normalizeProbe(await adapter.probe());
      return Object.freeze({
        harnessId: entry.id,
        available: result.available,
        version: result.version,
        capabilities: Object.freeze(result.capabilities),
        ...(result.reason === undefined ? {} : { reason: result.reason }),
      });
    },

    async select(spec) {
      requireOpen();
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        fail('invalid_input', 'Harness selection must be an object.');
      }
      if (typeof spec.harnessId !== 'string' || spec.harnessId.length === 0) {
        fail('invalid_input', 'An explicit harness id is required.');
      }
      let model = null;
      if (spec.model !== undefined) {
        if (typeof spec.model !== 'string' || !MODEL_PATTERN.test(spec.model)) {
          fail('invalid_input', 'model must be a separate, valid model id.');
        }
        model = spec.model;
      }
      const requested = normalizeCapabilities(spec.capabilities);
      const entry = entryFor(spec.harnessId);
      const adapter = await createAdapter(entry, spec.options);
      const result = normalizeProbe(await adapter.probe());
      if (!result.available) {
        fail(
          'unavailable_harness',
          `Harness ${entry.id} is unavailable${result.reason === undefined ? '.' : `: ${result.reason}.`}`
        );
      }
      const supported = new Set(result.capabilities);
      const missing = requested.filter((capability) => !supported.has(capability));
      if (missing.length > 0) {
        fail(
          'unsupported_capability',
          `Harness ${entry.id} does not support: ${missing.join(', ')}.`,
          { harnessId: entry.id, missing }
        );
      }
      return Object.freeze({
        harnessId: entry.id,
        version: result.version,
        capabilities: Object.freeze([...result.capabilities]),
        adapter,
        // Model choice is preserved separately and was never passed to the
        // harness factory or inferred from the harness.
        model,
      });
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
  HarnessRegistryError,
  createHarnessRegistry,
};
