const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { secretEntries, secretRoute, secretCredential, guestSecrets } = require('../src/runtime/secret-bridge.cjs');
const { createCredentialBridge } = require('../src/runtime/credential-bridge.cjs');
const id = '00000000-0000-0000-0000-000000000001';
const record = (overrides = {}) => ({ id, name: 'Example', environmentId: 'vm-a', authType: 'bearer',
  origin: 'https://api.example.com', pathPrefix: '/v1/', methods: ['GET','POST'], username: '', headerName: '',
  credentialRef: 'secrets/credential/' + id, ...overrides });

async function fixture(t, { entry = record(), decide = async () => true, response, mutateRequest, ...limits } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-relay-'));
  const caFile = path.join(root, 'ca.crt'); fs.writeFileSync(caFile, 'synthetic CA, never used for a TLS connection');
  const state = { reads: 0, forwards: [], transports: [], callbacks: [], bodies: [] };
  const value = 'synthetic-canary-secret';
  let bridge;
  bridge = await createCredentialBridge({ environmentId: 'vm-a', secrets: [entry], caFile, proxyPort: 12345,
    vault: { get: async ref => { state.reads++; assert.equal(ref, entry.credentialRef); return value; } }, decide, ...limits,
    // Synthetic transport exercises real relay HTTP and ticket/policy transforms;
    // it makes no upstream connection and is not live Iron or VM acceptance.
    requestUpstream: async (upstream, options) => {
      state.transports.push(options.headers);
      assert(!JSON.stringify(options.headers).includes(value));
      const chunks = [];
      if (options.body) for await (const chunk of options.body) chunks.push(Buffer.from(chunk));
      state.bodies.push(Buffer.concat(chunks).toString());
      const input = { environmentId: 'vm-a', signal: options.signal, context: { sni: upstream.hostname },
        request: { method: options.method, host: upstream.host, url: upstream.href,
          headers: Object.fromEntries(Object.entries(options.headers).map(([name, item]) => [name, { values: [item] }])) } };
      mutateRequest?.(input);
      state.callbacks.push(input);
      const transformed = await bridge.transform(input);
      if (transformed.action !== 1) return { statusCode: transformed.response.statusCode, headers: {}, body: Readable.from(['denied']) };
      state.forwards.push(transformed.modifiedRequest);
      return response?.(transformed) ?? { statusCode: 200, headers: { 'content-type': 'application/json', 'set-cookie': value, location: value },
        body: Readable.from(['{"echo":"synthetic-can', 'ary-secret","ok":true}']) };
    } });
  t.after(async () => { await bridge.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${bridge.port}`;
  const guest = bridge.guestSecrets(base).entries[0];
  const request = (suffix = '/v1/items', options = {}) => fetch(guest.baseURL + suffix,
    { ...options, headers: { authorization: guest.authorization, ...options.headers } });
  return { state, value, bridge, guest, request };
}

test('scope matching rejects other methods, raw traversal, encoded paths and alternate authorities', () => {
  const entries = secretEntries([record()], 'vm-a');
  const route = (suffix, method = 'GET') => secretRoute({ url: `/secrets/${id}${suffix}`, method, headers: {} }, entries);
  assert.equal(route('/v1/items?q=hello%20world').upstream.href, 'https://api.example.com/v1/items?q=hello%20world');
  for (const suffix of ['/v1', '/v10/items', '/v1/../admin', '/v1/%2e%2e/admin', '/v1/%252e/admin',
    '/v1//items', '//other.example/v1/', '/v1/items#fragment', '/v1/\\admin', '/v1/items\r\n']) assert.equal(route(suffix), undefined);
  assert.equal(route('/v1/items', 'DELETE'), undefined);
  assert.throws(() => secretEntries([record()], 'vm-b'));
  assert.throws(() => secretEntries([record(),record()], 'vm-a'));
});

test('guest manifest contains per-lease substitutes, no refs, and isolated environments reject foreign entries', () => {
  const first = secretEntries([record()], 'vm-a'), second = secretEntries([record()], 'vm-a');
  const one = guestSecrets(first, 'http://192.0.2.1:1234');
  const two = guestSecrets(second, 'http://192.0.2.1:1234');
  assert.notEqual(one.entries[0].authorization, two.entries[0].authorization);
  assert(!JSON.stringify(one).includes('credentialRef'));
  one.entries[0].methods.push('DELETE'); assert.deepEqual(first.get(id).secret.methods, ['GET','POST']);
  assert.throws(() => guestSecrets(first, 'https://example.com'));
});

test('only approved one-use tickets inject Bearer and reflected response bytes are redacted', async t => {
  const f = await fixture(t); const response = await f.request('/v1/items', { headers: { cookie: 'guest-cookie', 'x-forwarded-host': 'evil.example' } });
  assert.equal(response.status, 200); assert.equal(response.headers.get('set-cookie'), null); assert.equal(response.headers.get('location'), null);
  assert.deepEqual(await response.json(), { echo: '[redacted]', ok: true });
  const headers = f.state.forwards[0].headers;
  assert.deepEqual(headers.Authorization.values, ['Bearer ' + f.value]);
  assert(!Object.keys(headers).some(name => /^(cookie|x-forwarded|x-isolated)/i.test(name)));
  assert.equal((await f.bridge.transform(f.state.callbacks[0])).action, 2);
});

for (const authType of ['api-key','basic']) test(`${authType} injects the expected header and filters reflected credentials`, async t => {
  const entry = record({ authType, headerName: authType === 'api-key' ? 'x-api-key' : '', username: authType === 'basic' ? 'service-user' : '' });
  const credential = secretCredential(secretEntries([entry], 'vm-a').get(id), 'synthetic-canary-secret');
  const f = await fixture(t, { entry, response: () => ({ statusCode: 200, headers: { 'content-type': 'text/plain' },
    body: Readable.from([Object.values(credential.headers)[0].values[0]]) }) });
  const response = await f.request(); assert.equal(response.status, 200);
  assert.equal(await response.text(), '[redacted]');
  const headers = f.state.forwards[0].headers;
  assert.deepEqual(headers[authType === 'api-key' ? 'x-api-key' : 'Authorization'], Object.values(credential.headers)[0]);
  if (authType === 'api-key') assert.equal(headers.Authorization, undefined);
});

test('wrong substitutes and out-of-scope routes never read the vault', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/v1/items', { headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await f.request('/admin')).status, 404);
  assert.equal((await f.request('/v1/items', { method: 'DELETE' })).status, 404);
  assert.equal(f.state.reads, 0);
});

test('policy refusal is terminal and does not inject credentials', async t => {
  const f = await fixture(t, { decide: async () => false }); const response = await f.request();
  assert.equal(response.status, 424); assert.equal(f.state.forwards.length, 0);
  assert(!JSON.stringify(await response.json()).includes(f.value));
});

test('ticket destination mismatch fails closed even with an authorized token', async t => {
  const f = await fixture(t, { mutateRequest: input => { input.request.host = 'other.example'; } });
  assert.equal((await f.request()).status, 403); assert.equal(f.state.forwards.length, 0);
});

test('redirects and encoded upstream responses cannot expose arbitrary headers or response bytes', async t => {
  for (const result of [{ statusCode: 302, headers: { location: 'https://elsewhere.example' } },
    { statusCode: 200, headers: { 'content-encoding': 'gzip' } }]) {
    const f = await fixture(t, { response: () => ({ ...result, body: Readable.from(['synthetic-canary-secret']) }) });
    const response = await f.request(); assert.equal(response.status, 502);
    assert(! (await response.text()).includes(f.value));
  }
});

test('paused bridges reject new calls; resumption retains scoped substitutes; close revokes access', async t => {
  const f = await fixture(t); f.bridge.pause();
  assert.equal((await f.request()).status, 503); assert.equal(f.state.reads, 0);
  f.bridge.resume(); const response = await f.request(); assert.equal(response.status, 200); await response.text();
  await f.bridge.close(); await assert.rejects(f.request());
  assert.equal((await f.bridge.transform(f.state.callbacks[0])).action, 2);
});

test('pause during an approval wait prevents late credential injection', async t => {
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { decide: async () => { entered(); return new Promise(resolve => { release = resolve; }); } });
  const request = f.request(); const rejected = assert.rejects(request);
  await waiting; f.bridge.pause(); release(true); await rejected;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.forwards.length, 0);
});

test('oversized uploads reject before reading the vault or creating a ticket', async t => {
  const f = await fixture(t, { maxRequestBytes: 3 });
  const response = await f.request('/v1/items', { method: 'POST', body: 'four', headers: { 'content-type': 'text/plain' } });
  assert.equal(response.status, 413); assert.equal(f.state.reads, 0); assert.equal(f.state.forwards.length, 0);
});

test('explicit API write methods preserve bounded bodies and selected application headers', async t => {
  const f = await fixture(t, { entry: record({ methods: ['GET','HEAD','POST','PUT','PATCH','DELETE'] }) });
  for (const method of ['POST','PUT','PATCH','DELETE']) {
    const response = await f.request('/v1/items?dryRun=true', { method, body: '{"value":1}',
      headers: { 'content-type': 'application/json', 'anthropic-version': 'fixture', 'x-arbitrary': 'drop-me' } });
    assert.equal(response.status, 200); await response.text();
    const forwarded = f.state.forwards.at(-1).headers;
    assert.deepEqual(forwarded['content-type'].values, ['application/json']);
    assert.deepEqual(forwarded['anthropic-version'].values, ['fixture']);
    assert.equal(forwarded['x-arbitrary'], undefined);
    assert.equal(f.state.callbacks.at(-1).request.method, method);
    assert.equal(f.state.bodies.at(-1), '{"value":1}');
  }
  const head = await f.request('/v1/items', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
});
