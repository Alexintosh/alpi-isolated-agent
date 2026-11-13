const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FolderShares } = require('../src/runtime/folder-shares.cjs');
const { FileTransfers } = require('../src/runtime/file-transfers.cjs');
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shares-')));
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const stateRoot = path.join(home, 'private'); fs.mkdirSync(stateRoot);
  const source = path.join(home, 'project'); fs.mkdirSync(source);
  const coordinator = { stopped: false, fail: false, async withStopped(_id, fn) {
    if (this.fail) throw new Error('Stop failed'); this.stopped = true; return fn();
  } };
  const options = { stateRoot, definitions: [{ id: 'a' }, { id: 'b' }], coordinator,
    transfers: new FileTransfers({ stateRoot, home, coordinator }) };
  const shares = new FolderShares(options);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, home, source, shares, coordinator, options };
}
test('only a picker preview grants an exact persistent folder; stop precedes grant and revoke', async t => {
  const { source, shares, coordinator, options } = fixture(t);
  const preview = shares.prepare('a', source);
  assert.equal(preview.mode, 'ro'); assert.equal(preview.identity, undefined);
  assert.equal(shares.forEnvironment('a').length, 0);
  await shares.confirm(preview.id);
  assert(coordinator.stopped);
  assert.equal(new FolderShares(options).forEnvironment('a')[0].source, source);
  await assert.rejects(shares.confirm(preview.id));
  coordinator.fail = true;
  await assert.rejects(shares.remove(preview.id), /Stop failed/);
  assert.equal(shares.forEnvironment('a').length, 1);
  coordinator.fail = false; await shares.remove(preview.id);
  assert.equal(new FolderShares(options).forEnvironment('a').length, 0);
});
test('private roots, ancestor trees, nested cross-engine roots and changed directories cannot mount', async t => {
  const { source, home, shares } = fixture(t);
  assert.throws(() => shares.prepare('a', home));
  const child = path.join(source, 'child'); fs.mkdirSync(child);
  await shares.confirm(shares.prepare('a', source, 'rw').id);
  assert.throws(() => shares.prepare('b', child), /cannot overlap/);
  assert.throws(() => shares.prepare('a', source), /already shared/);
  fs.renameSync(source, source + '-old'); fs.mkdirSync(source);
  assert.throws(() => shares.forEnvironment('a'), /folder changed/);
});
test('failed stop, cancellation and expired previews never add a grant', async t => {
  const { source, shares, coordinator } = fixture(t);
  let preview = shares.prepare('a', source); coordinator.fail = true;
  await assert.rejects(shares.confirm(preview.id)); assert.equal(shares.forEnvironment('a').length, 0);
  coordinator.fail = false; preview = shares.prepare('a', source); shares.cancel();
  await assert.rejects(shares.confirm(preview.id));
  preview = shares.prepare('a', source); shares.preview.expiresAt = 0;
  await assert.rejects(shares.confirm(preview.id));
  assert.equal(shares.forEnvironment('a').length, 0);
});
test('a corrupt sharing registry blocks grants and start configuration without blocking runtime stop',async t=>{
  const {options,source}=fixture(t),file=path.join(options.stateRoot,'folder-shares.json');fs.writeFileSync(file,'{broken');
  const shares=new FolderShares(options);assert.equal(shares.snapshot().fault,true);assert.deepEqual(shares.snapshot().shares,[]);
  assert.throws(()=>shares.forEnvironment('a'),/VM stop remains available/);
  assert.throws(()=>shares.prepare('a',source));await assert.rejects(shares.remove('invalid'));
  await options.coordinator.withStopped('a',async()=>{});assert(options.coordinator.stopped);
  assert.equal(fs.readFileSync(file,'utf8'),'{broken');
});
