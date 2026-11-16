const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SecretCatalog } = require('../src/runtime/secret-catalog.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-catalog-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const values = new Map(), calls = [];
  const vault = {
    has: ref => values.has(ref),
    async put(ref, value) { calls.push(['put', ref]); values.set(ref, value); },
    async remove(ref) { calls.push(['remove', ref]); values.delete(ref); },
  };
  const options = { stateRoot: root, vault, environmentIds: ['vm-a', 'vm-b'] };
  return { root, values, calls, vault, options, catalog: new SecretCatalog(options) };
}
const input = (overrides = {}) => ({ name: 'Example API', environmentId: 'vm-a', authType: 'bearer',
  origin: 'https://api.example.com', pathPrefix: '/v1/', methods: ['GET'], headerName: '', username: '',
  value: 'synthetic-secret-canary', ...overrides });

test('catalog persists only metadata, roundtrips and never returns values or vault references', async t => {
  const f = fixture(t); const saved = await f.catalog.save(input());
  const raw = fs.readFileSync(f.catalog.file, 'utf8');
  assert(!raw.includes('synthetic-secret-canary'));
  assert(!JSON.stringify(saved).includes('credentialRef'));
  assert(!JSON.stringify(saved).includes('synthetic-secret-canary'));
  assert.equal(saved.entries[0].credentialAvailable, true);
  assert.equal(fs.statSync(f.catalog.file).mode & 0o777, 0o600);
  const restored = new SecretCatalog(f.options);
  assert.deepEqual(restored.snapshot(), saved);
  saved.entries[0].methods.push('DELETE');
  assert.deepEqual(restored.entriesFor('vm-a')[0].methods, ['GET']);
  const entries = restored.entriesFor('vm-a'); entries[0].name = 'changed';
  assert.equal(restored.snapshot().entries[0].name, 'Example API');
  assert.deepEqual(restored.entriesFor('vm-b'), []);
});

test('metadata edit retains a credential; rotation uses a fresh ref and retires only the previous ref', async t => {
  const f = fixture(t); const { entries: [entry] } = await f.catalog.save(input());
  const firstRef = f.catalog.entriesFor('vm-a')[0].credentialRef;
  await f.catalog.save(input({ id: entry.id, name: 'Renamed', value: undefined }));
  assert.equal(f.catalog.entriesFor('vm-a')[0].credentialRef, firstRef);
  assert.equal(f.calls.length, 1);
  await f.catalog.save(input({ id: entry.id, value: 'rotated-canary' }));
  const nextRef = f.catalog.entriesFor('vm-a')[0].credentialRef;
  assert.notEqual(nextRef, firstRef); assert(!f.values.has(firstRef));
  assert.equal(f.values.get(nextRef), 'rotated-canary');
  assert.deepEqual(f.calls.map(call => call[0]), ['put', 'put', 'remove']);
  await f.catalog.remove(entry.id); assert.equal(f.values.size, 0);
  assert.deepEqual(new SecretCatalog(f.options).snapshot().entries, []);
});

test('encryption failure preserves the published entry and conceals underlying errors', async t => {
  const f = fixture(t); const { entries: [entry] } = await f.catalog.save(input());
  const before = fs.readFileSync(f.catalog.file, 'utf8');
  f.vault.put = async () => { throw new Error('synthetic-secret-canary'); };
  await assert.rejects(f.catalog.save(input({ id: entry.id, value: 'new' })), error =>
    /encrypted/.test(error.message) && !error.message.includes('canary'));
  assert.equal(fs.readFileSync(f.catalog.file, 'utf8'), before);
  assert.equal(f.catalog.snapshot().entries[0].credentialAvailable, true);
});

test('a persistence error after publication preserves the new ciphertext and blocks new leases until reload', async t => {
  const f = fixture(t); const { entries: [entry] } = await f.catalog.save(input());
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => { rename(from, to); throw new Error('synthetic-secret-canary'); });
  await assert.rejects(f.catalog.save(input({ id: entry.id, value: 'rotation' })), /catalog is unavailable/);
  assert.equal(f.catalog.snapshot().fault, true);
  assert.throws(() => f.catalog.entriesFor('vm-a'), /unavailable/);
  assert.equal(f.values.size, 2);
  assert(!f.calls.some(call => call[0] === 'remove'));
  const restored = new SecretCatalog(f.options);
  const current = restored.entriesFor('vm-a')[0];
  assert.equal(f.values.get(current.credentialRef), 'rotation');
});

test('failed removal persistence never deletes a potentially active vault record', async t => {
  const f = fixture(t); const { entries: [entry] } = await f.catalog.save(input());
  t.mock.method(fs, 'renameSync', () => { throw new Error('disk failure'); });
  await assert.rejects(f.catalog.remove(entry.id), /unavailable/);
  assert.equal(f.values.size, 1);
  assert.equal(new SecretCatalog(f.options).snapshot().entries.length, 1);
});

test('cleanup failure leaves the new metadata authoritative and reports encrypted cleanup pending', async t => {
  const f = fixture(t); const { entries: [entry] } = await f.catalog.save(input());
  f.vault.remove = async () => { throw new Error('synthetic-secret-canary'); };
  const result = await f.catalog.save(input({ id: entry.id, value: 'rotation' }));
  assert.equal(result.cleanupPending, true); assert.equal(result.entries.length, 1);
  assert.equal(f.values.get(f.catalog.entriesFor('vm-a')[0].credentialRef), 'rotation');
  await f.catalog.remove(entry.id);
  assert.equal(f.catalog.snapshot().entries.length, 0);
});

test('saved environment is immutable and type or username changes require a new secret', async t => {
  const f = fixture(t); const { entries: [entry] } = await f.catalog.save(input());
  await assert.rejects(f.catalog.save(input({ id: entry.id, environmentId: 'vm-b' })), /another environment/);
  await assert.rejects(f.catalog.save(input({ id: entry.id, value: '', authType: 'basic', username: 'user' })), /new secret/);
  await f.catalog.save(input({ id: entry.id, authType: 'basic', username: 'user', value: 'password' }));
  await assert.rejects(f.catalog.save(input({ id: entry.id, authType: 'basic', username: 'other', value: undefined })), /new secret/);
  f.values.clear();
  await assert.rejects(f.catalog.save(input({ id: entry.id, authType: 'basic', username: 'user', value: undefined })), /new secret/);
});

test('queued inputs are captured and concurrent saves do not overwrite each other', async t => {
  const f = fixture(t); const draft = input();
  const first = f.catalog.save(draft);
  draft.name = 'mutated'; draft.methods.push('DELETE'); draft.value = 'changed';
  await Promise.all([first, f.catalog.save(input({ name: 'Second', environmentId: 'vm-b' }))]);
  const entries = f.catalog.snapshot().entries;
  assert.equal(entries.length, 2); assert.equal(entries[0].name, 'Example API');
  assert.deepEqual(entries[0].methods, ['GET']);
  assert.equal(f.values.get(f.catalog.entriesFor('vm-a')[0].credentialRef), 'synthetic-secret-canary');
});

test('unknown ids, missing values and invalid scope cannot publish records', async t => {
  const f = fixture(t);
  for (const draft of [input({ value: undefined }), input({ value: null }), input({ environmentId: 'unknown' }),
    input({ id: 'not-an-id' }), input({ id: '00000000-0000-0000-0000-000000000000' })])
    await assert.rejects(f.catalog.save(draft));
  await assert.rejects(f.catalog.remove('unknown'));
  assert.equal(f.values.size, 0); assert(!fs.existsSync(f.catalog.file));
});

test('cancellation during encryption cannot publish a late credential after shutdown', async t => {
  const f = fixture(t); let release;
  const encrypt = f.vault.put;
  f.vault.put = async (ref, value) => { await new Promise(resolve => { release = resolve; }); await encrypt(ref, value); };
  const controller = new AbortController();
  const saving = f.catalog.save(input(), { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve)); controller.abort(); release();
  await assert.rejects(saving, { name: 'AbortError' });
  assert.equal(f.values.size, 0); assert.equal(f.catalog.snapshot().entries.length, 0);
  assert(!fs.existsSync(f.catalog.file));
});

test('malformed persisted catalogs fail closed without overwriting the original', async t => {
  const f = fixture(t); await f.catalog.save(input());
  const original = JSON.parse(fs.readFileSync(f.catalog.file, 'utf8'));
  for (const mutate of [data => data.entries.push(data.entries[0]), data => { data.entries[0].credentialRef = 'models/a'; },
    data => { data.entries[0].environmentId = 'unknown'; }, data => { data.entries[0].value = 'canary'; },
    data => { data.entries[0].origin = 'https://api.example.com/'; }]) {
    const bad = JSON.parse(JSON.stringify(original)); mutate(bad);
    const raw = JSON.stringify(bad); fs.writeFileSync(f.catalog.file, raw);
    assert.throws(() => new SecretCatalog(f.options), /catalog is unavailable/);
    assert.equal(fs.readFileSync(f.catalog.file, 'utf8'), raw);
  }
});
