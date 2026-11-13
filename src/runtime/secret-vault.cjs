const path = require('node:path');
const { readJson, writeJson } = require('./atomic-json.cjs');
const validRef = ref => typeof ref === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(ref);
const unavailable = () => Object.assign(new Error('The credential vault is unavailable.'), { code: 'VAULT_UNAVAILABLE' });

// Main-process only. macOS Keychain holds safeStorage's encryption key; this
// file contains only ciphertext. No renderer/API returns a decrypted value.
class SecretVault {
  constructor({ stateRoot, safeStorage, platform = process.platform }) {
    if (platform !== 'darwin') throw new Error('The v1 credential vault requires macOS Keychain.');
    this.file = path.join(stateRoot, 'credentials.encrypted.json');
    this.storage = safeStorage; this.queue = Promise.resolve();
    const saved = readJson(this.file, { version: 1, entries: {} });
    if (saved.version !== 1 || !saved.entries || typeof saved.entries !== 'object' || Array.isArray(saved.entries) ||
      Object.keys(saved.entries).length > 1000 || !Object.entries(saved.entries).every(([ref, value]) => validRef(ref) &&
        typeof value === 'string' && value.length > 0 && value.length <= 100000 && Buffer.from(value, 'base64').toString('base64') === value))
      throw new Error('The encrypted vault is invalid. It will not be reset automatically.');
    this.entries = { ...saved.entries };
  }
  serial(work) {
    const task = this.queue.then(work); this.queue = task.catch(() => {}); return task;
  }
  async available() {
    try { return await this.storage.isAsyncEncryptionAvailable() === true; } catch { return false; }
  }
  has(ref) { return validRef(ref) && Object.hasOwn(this.entries, ref); }
  refs() { return Object.keys(this.entries); }
  persist(next) { writeJson(this.file, { version: 1, entries: next }); this.entries = next; }
  async encrypt(value) {
    if (!await this.available()) throw unavailable();
    try {
      const encrypted = await this.storage.encryptStringAsync(value);
      if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.equals(Buffer.from(value))) throw unavailable();
      return encrypted.toString('base64');
    } catch { throw unavailable(); }
  }
  put(ref, value) {
    if (!validRef(ref)) return Promise.reject(new Error('Invalid reference.'));
    return this.putMany({ [ref]: value });
  }
  putMany(values) {
    if (!values || typeof values !== 'object' || Array.isArray(values) || !Object.entries(values).every(([ref, value]) =>
      validRef(ref) && typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 65536))
      return Promise.reject(new Error('Invalid reference or credential.'));
    const pending = { ...values };
    return this.serial(async () => {
      if (new Set([...this.refs(), ...Object.keys(pending)]).size > 1000) throw new Error('The credential limit has been reached.');
      const next = { ...this.entries };
      for (const [ref, value] of Object.entries(pending)) next[ref] = await this.encrypt(value);
      // Encrypt the entire batch before replacing the single ciphertext file.
      this.persist(next);
    });
  }
  get(ref) {
    if (!validRef(ref)) return Promise.reject(new Error('Invalid reference.'));
    return this.serial(async () => {
      if (!this.has(ref)) return undefined;
      if (!await this.available()) throw unavailable();
      let decrypted;
      try { decrypted = await this.storage.decryptStringAsync(Buffer.from(this.entries[ref], 'base64')); }
      catch { throw unavailable(); }
      if (!decrypted || typeof decrypted.result !== 'string' || !decrypted.result.length || decrypted.isTemporarilyUnavailable)
        throw unavailable();
      if (decrypted.shouldReEncrypt) this.persist({ ...this.entries, [ref]: await this.encrypt(decrypted.result) });
      return decrypted.result;
    });
  }
  remove(ref) {
    if (!validRef(ref)) return Promise.reject(new Error('Invalid reference.'));
    return this.serial(() => { const next = { ...this.entries }; delete next[ref]; this.persist(next); });
  }
}
module.exports = { SecretVault };
