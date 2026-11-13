const path = require('node:path');
const {readJson, writeJson} = require('./atomic-json.cjs');
const TOKEN = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9-]{36}$/;
class TransferJournal {
  constructor(stateRoot) {
    this.file = path.join(stateRoot, 'file-transfers.json');
    const stored = readJson(this.file, {version: 1, operations: []});
    if (stored.version !== 1 || !Array.isArray(stored.operations) || stored.operations.length > 100 ||
        stored.operations.some(item => !valid(item)) || new Set(stored.operations.map(item=>item.id)).size !== stored.operations.length)
      throw new Error('Transfer recovery journal is invalid.');
    this.operations = stored.operations;
  }
  save(operations) {
    writeJson(this.file, {version: 1, operations});
    this.operations = operations;
  }
  begin(record) {
    if (!valid(record) || this.operations.some(item=>item.id===record.id) || this.operations.length >= 100)
      throw new Error('Resolve interrupted transfers before starting another transfer.');
    this.save([...this.operations, record]);
  }
  committing(id) {
    if (!this.operations.some(item=>item.id===id)) throw new Error('Transfer recovery record is missing.');
    this.save(this.operations.map(item=>item.id===id ? {...item, phase:'committing'} : item));
  }
  remove(id) { this.save(this.operations.filter(item=>item.id!==id)); }
  get(id) { return this.operations.find(item=>item.id===id); }
  snapshot() {
    return this.operations.map(({id, environmentId, direction, destination, phase, createdAt})=>
      ({id, environmentId, direction, destination, phase, createdAt}));
  }
}
function valid(item) {
  return item && UUID.test(item.id ?? '') && TOKEN.test(item.transaction ?? '') &&
    UUID.test(item.ownershipToken ?? '') && /^[a-z0-9-]+$/.test(item.environmentId ?? '') &&
    ['import','export'].includes(item.direction) && ['receiving','committing'].includes(item.phase) &&
    typeof item.destination === 'string' && path.isAbsolute(item.destination) &&
    path.normalize(item.destination) === item.destination && !/[\x00-\x1f\x7f]/.test(item.destination) &&
    Number.isSafeInteger(item.createdAt) && item.createdAt > 0 &&
    (item.direction === 'import' || /^\d+:\d+$/.test(item.parentIdentity ?? ''));
}
module.exports = {TransferJournal};
