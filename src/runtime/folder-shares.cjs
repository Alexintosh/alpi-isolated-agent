const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { readJson, writeJson } = require('./atomic-json.cjs');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const comparable = value => process.platform === 'darwin' ? value.normalize('NFC').toLowerCase() : value;
const contains = (a, b) => comparable(b).startsWith(comparable(a) + path.sep);
function assertIdentity(share) {
  const info = fs.lstatSync(share.source);
  if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync(share.source) !== share.source ||
      `${info.dev}:${info.ino}` !== share.identity) throw new Error('The shared folder changed. Remove it and select it again.');
}

// Changes stop the VM first, including revocation of open file descriptors.
// A saved choice is reapplied only after checking its exact host directory.
class FolderShares extends EventEmitter {
  constructor({ stateRoot, definitions, coordinator, transfers }) {
    super(); this.file = path.join(stateRoot, 'folder-shares.json');
    this.ids = new Set(definitions.map(item => item.id)); this.coordinator = coordinator; this.transfers = transfers;
    this.data = {version:1,shares:[]}; this.preview = undefined;
    try { this.load(); } catch { this.fault=true; this.data={version:1,shares:[]}; }
  }
  load() {
    this.data = readJson(this.file, { version: 1, shares: [] });
    if (this.data?.version !== 1 || !Array.isArray(this.data.shares) || this.data.shares.length > 16)
      throw new Error('Invalid folder sharing registry.');
    const seen = new Set();
    for (const item of this.data.shares) {
      if (!item || !UUID.test(item.id) || seen.has(item.id) || !this.ids.has(item.environmentId) ||
          !['ro', 'rw'].includes(item.mode) || typeof item.source !== 'string' || !path.isAbsolute(item.source) ||
          path.normalize(item.source) !== item.source || /[:\x00-\x1f\x7f]/.test(item.source) ||
          item.target !== '/mnt/harness-shares/' + item.id || !/^\d+:\d+$/.test(item.identity))
        throw new Error('Invalid folder sharing registry.');
      seen.add(item.id);
    }
    this.validateOverlaps(this.data.shares);
  }
  requireValid() { if(this.fault)throw new Error('Folder sharing settings are invalid and were preserved. VM stop remains available.'); }
  snapshot() { return { fault:Boolean(this.fault), shares: this.data.shares.map(({ identity, ...item }) => item), preview: this.preview && { ...this.preview, identity: undefined } }; }
  changed() { this.emit('change', this.snapshot()); }
  validateOverlaps(shares) {
    for (let a = 0; a < shares.length; a++) for (let b = a + 1; b < shares.length; b++) {
      if (contains(shares[a].source, shares[b].source) || contains(shares[b].source, shares[a].source))
        throw new Error('Shared folders cannot overlap. Choose a single root folder.');
    }
  }
  validateSource(item) {
    assertIdentity(item);
    if (this.transfers.hostPath(item.source, { importing: true }) !== item.source)
      throw new Error('Invalid shared folder path.');
  }
  forEnvironment(id) {
    this.requireValid();
    if (!this.ids.has(id)) throw new Error('Unknown environment.');
    const shares = this.data.shares.filter(item => item.environmentId === id);
    for (const item of shares) this.validateSource(item);
    return shares.map(item => ({ ...item }));
  }
  prepare(environmentId, source, mode = 'ro') {
    this.requireValid();
    this.cancel();
    if (!this.ids.has(environmentId) || !['ro', 'rw'].includes(mode)) throw new Error('Invalid folder share.');
    source = this.transfers.hostPath(source, { importing: true });
    if (/[:\x00-\x1f\x7f]/.test(source)) throw new Error('The runtime does not support this folder name.');
    const info = fs.lstatSync(source);
    if (!info.isDirectory()) throw new Error('Select a folder.');
    if (this.data.shares.length >= 16 || this.data.shares.some(item => item.environmentId === environmentId && comparable(item.source) === comparable(source)))
      throw new Error('The folder is already shared or the limit of 16 shares has been reached.');
    const id = randomUUID();
    const item = { id, environmentId, source, target: '/mnt/harness-shares/' + id, mode, identity: `${info.dev}:${info.ino}` };
    this.validateOverlaps([...this.data.shares, item]);
    this.preview = { ...item, expiresAt: Date.now() + 600000 }; this.changed(); return this.snapshot().preview;
  }
  cancel() { this.preview = undefined; this.changed(); }
  async confirm(id) {
    this.requireValid();
    const preview = this.preview; this.cancel();
    if (!preview || preview.id !== id || preview.expiresAt <= Date.now()) throw new Error('The folder sharing preview expired.');
    const { expiresAt, ...item } = preview;
    return this.coordinator.withStopped(item.environmentId, async () => {
      this.validateSource(item); this.validateOverlaps([...this.data.shares, item]);
      this.persist([...this.data.shares, item]);
    });
  }
  async remove(id) {
    this.requireValid();
    this.cancel();
    const item = this.data.shares.find(value => value.id === id);
    if (!item) throw new Error('Unknown folder share.');
    return this.coordinator.withStopped(item.environmentId, async () => this.persist(this.data.shares.filter(value => value.id !== id)));
  }
  persist(shares) {
    this.requireValid();
    const data = { version: 1, shares }; writeJson(this.file, data); this.data = data; this.changed();
  }
}
module.exports = { FolderShares, assertIdentity };
