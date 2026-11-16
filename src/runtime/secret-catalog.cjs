const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { readJson, writeJson } = require('./atomic-json.cjs');
const { validateSecretMetadata, validateSecretValue } = require('./secret-scope.cjs');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const PREFIX = 'secrets/credential/';
const clone = value => JSON.parse(JSON.stringify(value));
const failure = () => new Error('The secret catalog is unavailable. Saved credentials were preserved.');

// Host only. Values belong exclusively to SecretVault; snapshots carry metadata.
class SecretCatalog {
  constructor({ stateRoot, vault, environmentIds }) {
    this.file = path.join(stateRoot, 'secrets.json');
    this.vault = vault;
    this.environmentIds = [...environmentIds];
    this.queue = Promise.resolve();
    this.fault = false;
    this.cleanupPending = false;
    try {
      const saved = readJson(this.file, { version: 1, entries: [] });
      if (saved?.version !== 1 || !Array.isArray(saved.entries) || saved.entries.length > 64) throw failure();
      this.entries = saved.entries.map(entry => {
        if (!entry || typeof entry.id !== 'string' || !UUID.test(entry.id) || typeof entry.credentialRef !== 'string' ||
            !entry.credentialRef.startsWith(PREFIX) || !UUID.test(entry.credentialRef.slice(PREFIX.length))) throw failure();
        const metadata = validateSecretMetadata(entry, this.environmentIds);
        const expected = { id: entry.id, ...metadata, credentialRef: entry.credentialRef };
        if (Object.keys(entry).length !== Object.keys(expected).length ||
            Object.keys(expected).some(key => JSON.stringify(entry[key]) !== JSON.stringify(expected[key]))) throw failure();
        return expected;
      });
      if (new Set(this.entries.map(entry => entry.id)).size !== this.entries.length ||
          new Set(this.entries.map(entry => entry.credentialRef)).size !== this.entries.length) throw failure();
    } catch { throw failure(); }
  }
  snapshot() {
    return { fault: this.fault, cleanupPending: this.cleanupPending, entries: this.fault ? [] : this.entries.map(({ credentialRef, ...entry }) =>
      ({ ...clone(entry), credentialAvailable: this.vault.has(credentialRef) })) };
  }
  entriesFor(environmentId) {
    if (this.fault || !this.environmentIds.includes(environmentId)) throw failure();
    return clone(this.entries.filter(entry => entry.environmentId === environmentId));
  }
  prepareSave(input) {
    if (this.fault) throw failure();
    const metadata = validateSecretMetadata(input, this.environmentIds);
    const id = input.id;
    if (id !== undefined && (typeof id !== 'string' || !UUID.test(id))) throw new Error('Unknown credential.');
    const previous = id === undefined ? undefined : this.entries.find(entry => entry.id === id);
    if (id !== undefined && !previous) throw new Error('Unknown credential.');
    if (previous && previous.environmentId !== metadata.environmentId)
      throw new Error('Create a separate credential to grant access to another environment.');
    if (!previous && this.entries.length >= 64) throw new Error('The limit of 64 credentials has been reached.');
    const value = input.value === undefined || input.value === '' ? undefined : validateSecretValue(input.value);
    if (value === undefined && (!previous || !this.vault.has(previous.credentialRef) ||
        previous.authType !== metadata.authType || previous.username !== metadata.username))
      throw new Error('Enter a new secret value for this credential.');
    return { ...metadata, ...(id === undefined ? {} : { id }), ...(value === undefined ? {} : { value }) };
  }
  prepareRemove(id) {
    if (this.fault) throw failure();
    const entry = typeof id === 'string' && this.entries.find(item => item.id === id);
    if (!entry) throw new Error('Unknown credential.');
    return { id: entry.id, environmentId: entry.environmentId };
  }
  serial(work) {
    const pending = this.queue.then(work);
    this.queue = pending.catch(() => {});
    return pending;
  }
  persist(entries) {
    try { writeJson(this.file, { version: 1, entries }); }
    catch {
      // A rename may have succeeded before directory fsync failed. Keep all
      // ciphertext and refuse further leases until startup revalidates disk.
      this.fault = true;
      throw failure();
    }
    this.entries = entries;
  }
  async retire(ref) {
    try { await this.vault.remove(ref); }
    catch {
      // An unreferenced encrypted record grants no access. Do not report a
      // completed save as failed, which could cause a duplicate on retry.
      this.cleanupPending = true;
    }
  }
  save(input, { signal } = {}) {
    let captured;
    try { captured = this.prepareSave(input); } catch (error) { return Promise.reject(error); }
    return this.serial(async () => {
      signal?.throwIfAborted();
      const { value, id, ...metadata } = this.prepareSave(captured);
      const previous = this.entries.find(entry => entry.id === id);
      const credentialRef = value === undefined ? previous.credentialRef : PREFIX + randomUUID();
      if (value !== undefined) {
        try { await this.vault.put(credentialRef, value); }
        catch { throw new Error('The credential could not be encrypted. Check Keychain availability.'); }
      }
      if (signal?.aborted) {
        if (value !== undefined) await this.retire(credentialRef);
        signal.throwIfAborted();
      }
      const entry = { id: id ?? randomUUID(), ...metadata, credentialRef };
      this.persist(previous ? this.entries.map(item => item.id === id ? entry : item) : [...this.entries, entry]);
      if (previous && previous.credentialRef !== credentialRef) await this.retire(previous.credentialRef);
      return this.snapshot();
    });
  }
  remove(id) {
    try { this.prepareRemove(id); } catch (error) { return Promise.reject(error); }
    return this.serial(async () => {
      this.prepareRemove(id);
      const entry = this.entries.find(item => item.id === id);
      this.persist(this.entries.filter(item => item.id !== id));
      await this.retire(entry.credentialRef);
      return this.snapshot();
    });
  }
}

module.exports = { SecretCatalog };
