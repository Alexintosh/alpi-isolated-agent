'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { makeProfileCatalog, readProfileCatalog } = require('../src/profile-catalog.cjs');

function config() {
  return { version: 1, providers: [{ name: 'gpu', models: ['coder/model'], upstream: {
    scheme: 'http', host: '127.0.0.1', port: 11434 }, credentialName: 'local-key', concurrency: 2 }],
    profiles: [{ name: 'pi-dev', engine: 'boxlite', image: 'registry.example/alpi/pi@sha256:' + 'a'.repeat(64),
      projects: ['demo'], harnesses: ['pi'], providers: ['gpu'], limits: { vcpus: 2, memoryMiB: 2048, diskMiB: 8192 } }] };
}

test('project discovery excludes private inference destinations and limits model selection', () => {
  const catalog = makeProfileCatalog(config());
  assert.deepEqual(catalog.forProject('other'), []);
  const exposed = catalog.forProject('demo');
  assert.deepEqual(exposed[0].providers, [{ name: 'gpu', models: ['coder/model'] }]);
  assert.doesNotMatch(JSON.stringify(exposed), /11434|127\.0\.0\.1|local-key/);
  assert.equal(catalog.modelRoute('demo', 'boxlite', 'pi-dev', 'pi', 'gpu', 'coder/model').concurrency, 2);
  assert.throws(() => catalog.modelRoute('demo', 'boxlite', 'pi-dev', 'pi', 'gpu', 'other'), { code: 'model_unavailable' });
  assert.throws(() => catalog.resolve('other', 'boxlite', 'pi-dev'), { code: 'profile_unavailable' });
});

test('operator configuration must pin its image and name exact inference authorities', () => {
  for (const edit of [
    c => { c.profiles[0].image = 'registry.example/alpi/pi:latest'; },
    c => { c.providers[0].upstream.host = 'arbitrary.example'; },
    c => { c.providers[0].token = 'do-not-store'; },
    c => { c.profiles[0].providers = ['unknown']; },
  ]) {
    const c = config(); edit(c);
    assert.throws(() => makeProfileCatalog(c), { code: 'invalid_host_config' });
  }
});

test('operator file is bounded and read only from a trusted regular file', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'alpi-catalog-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'profiles.json');
  await fs.writeFile(file, JSON.stringify(config()), { mode: 0o600 });
  assert.equal((await readProfileCatalog(file)).forProject('demo').length, 1);
  await fs.symlink(file, path.join(dir, 'link'));
  await assert.rejects(readProfileCatalog(path.join(dir, 'link')));
  await fs.chmod(file, 0o666);
  await assert.rejects(readProfileCatalog(file), { code: 'invalid_host_config' });
  await fs.chmod(file, 0o600);
  await fs.writeFile(file, Buffer.alloc(65537));
  await assert.rejects(readProfileCatalog(file), { code: 'invalid_host_config' });
});
