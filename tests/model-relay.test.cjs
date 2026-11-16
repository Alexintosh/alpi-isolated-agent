const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createCredentialBridge } = require('../src/runtime/credential-bridge.cjs');

async function fixture(t, { authMode = 'none', allowed = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-relay-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const caFile = path.join(root, 'ca.crt');
  fs.writeFileSync(caFile, 'synthetic CA: no upstream TLS connection');
  const secret = 'synthetic-model-key', state = { reads: 0, policy: 0, forwarded: [] };
  const provider = { id: 'local', api: 'openai-completions', authMode,
    baseURL: 'https://inference.example/api/openai', models: [{ id: 'model-a' }, { id: 'model-b' }],
    ...(authMode === 'none' ? {} : { credentialRef: 'model/fixture' }) };
  let bridge;
  bridge = await createCredentialBridge({ environmentId: 'fixture', providers: [provider], proxyPort: 12345, caFile,
    vault: { get: async ref => { state.reads++; assert.equal(ref, 'model/fixture'); return secret; } },
    decide: async () => { state.policy++; return allowed; },
    // Exercise the real local HTTP relay and policy transform without inference or Iron.
    requestUpstream: async (upstream, options) => {
      const transformed = await bridge.transform({ environmentId: 'fixture', signal: options.signal,
        context: { sni: upstream.hostname }, request: { method: options.method, host: upstream.host, url: upstream.href,
          headers: Object.fromEntries(Object.entries(options.headers).map(([key, value]) => [key, { values: [value] }])) } });
      if (transformed.action !== 1) return { statusCode: transformed.response.statusCode, headers: {}, body: Readable.from(['denied']) };
      state.forwarded.push({ url: upstream.href, headers: transformed.modifiedRequest.headers });
      return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: Readable.from([JSON.stringify({ echo: authMode === 'none' ? 'ok' : secret })]) };
    } });
  t.after(() => bridge.close());
  const guest = bridge.guestProviders(`http://127.0.0.1:${bridge.port}`)[0];
  const request = (operation = 'models', options = {}) => fetch(guest.provider.baseURL + '/' + operation,
    { ...options, headers: { Authorization: `Bearer ${guest.token}`, ...options.headers } });
  return { state, request, guest, bridge };
}

test('no-auth models keep substitute authorization at the relay and never read the vault', async t => {
  const f = await fixture(t);
  const result = await f.request('chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: 'guest-cookie' },
    body: JSON.stringify({ model: 'model-b', messages: [] }) });
  assert.equal(result.status, 200); assert.deepEqual(await result.json(), { echo: 'ok' });
  assert.equal(f.state.reads, 0); assert.equal(f.state.policy, 1);
  assert.equal(f.state.forwarded[0].url, 'https://inference.example/api/openai/chat/completions');
  assert(!Object.keys(f.state.forwarded[0].headers).some(key => /authorization|cookie|x-isolated/i.test(key)));
  assert(!JSON.stringify(f.state.forwarded).includes(f.guest.token));
  assert.equal((await f.request('models', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal(f.state.policy, 1);
});

test('no-auth models still enforce network permission and the selected provider model list', async t => {
  const f = await fixture(t, { allowed: false });
  const denied = await f.request(); assert.equal(denied.status, 424); await denied.arrayBuffer();
  const invalid = await f.request('chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'other-provider-model', messages: [] }) });
  assert.equal(invalid.status, 400); await invalid.arrayBuffer();
  assert.equal(f.state.forwarded.length, 0); assert.equal(f.state.reads, 0); assert.equal(f.state.policy, 1);
});

test('bearer models continue host injection and reflected-secret filtering', async t => {
  const f = await fixture(t, { authMode: 'bearer' });
  const result = await f.request(); assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { echo: '[redacted]' });
  assert.deepEqual(f.state.forwarded[0].headers.Authorization.values, ['Bearer synthetic-model-key']);
  assert.equal(f.state.reads, 1);
});

test('invalid authentication mode fails before creating a listener', async () => {
  const provider = { id: 'test', api: 'openai-completions', baseURL: 'https://example.com/v1', models: [{ id: 'a' }] };
  for (const auth of [{ authMode: 'unknown' }, { authMode: 'none', credentialRef: 'stale/ref' }, { authMode: 'bearer' }]) {
    await assert.rejects(createCredentialBridge({ providers: [{ ...provider, ...auth }] }), /Invalid bridge authentication/);
  }
});
