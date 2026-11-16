const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSecretMetadata, validateSecretValue } = require('../src/runtime/secret-scope.cjs');
const metadata = overrides => ({ name: ' Example ', environmentId: 'test', authType: 'bearer',
  origin: 'https://API.example.com:443/', pathPrefix: '/v1/', methods: ['GET', 'POST'], ...overrides });
const validate = input => validateSecretMetadata(input, ['test']);

test('scope output is canonical, detached and strips values and references', () => {
  const input = metadata({ value: 'synthetic-sensitive', credentialRef: 'private/ref', id: 'untrusted' });
  const result = validate(input);
  assert.deepEqual(result, { name: 'Example', environmentId: 'test', authType: 'bearer',
    origin: 'https://api.example.com', pathPrefix: '/v1/', methods: ['GET', 'POST'], headerName: '', username: '' });
  input.methods.push('DELETE');
  assert.deepEqual(result.methods, ['GET', 'POST']);
  assert.equal(validate(metadata({ authType: 'api-key', headerName: 'X-API-Key' })).headerName, 'x-api-key');
  assert.equal(validate(metadata({ authType: 'basic', username: 'service-user' })).username, 'service-user');
  assert.equal(validate(metadata({ origin: 'https://[::1]:8443', pathPrefix: '/' })).origin, 'https://[::1]:8443');
});

test('invalid records, names, environments, auth types and methods fail safely', () => {
  for (const input of [null, [], new Date(), Object.create({ name: 'inherited' })]) assert.throws(() => validate(input));
  for (const patch of [{ name: '' }, { name: 'a'.repeat(81) }, { name: '\nExample' },
    { environmentId: 'other' }, { authType: 'cookie' }, { methods: [] }, { methods: ['GET', 'GET'] },
    { methods: ['TRACE'] }, { methods: ['get'] }, { methods: 'GET' }]) assert.throws(() => validate(metadata(patch)));
});

test('origin validation rejects raw parser normalization tricks and invalid authorities', () => {
  for (const origin of ['http://api.example.com', 'https://user:synthetic-sensitive@api.example.com',
    'https://api.example.com?', 'https://api.example.com#', 'https://api.example.com/a/..',
    'https://api.example.com/%2e/', 'https://api.example.com\\evil', ' https://api.example.com',
    'https://api.example.com\n', 'https://*.example.com', 'https://%61pi.example.com',
    'https://api.example.com:99999', 'https://-invalid.example.com', 'https://' + 'a'.repeat(64) + '.com']) {
    assert.throws(() => validate(metadata({ origin })), error => {
      assert.equal(error.message, 'Invalid secret origin.'); return true;
    });
  }
});

test('path scope requires complete literal segments', () => {
  for (const pathPrefix of ['', 'v1/', '/v1', '//', '/a//b/', '/./', '/a/../', '/%2e/', '/a?/', '/a#/', '/a\\/', '/' + 'a'.repeat(1024) + '/'])
    assert.throws(() => validate(metadata({ pathPrefix })));
  assert.equal(validate(metadata({ pathPrefix: '/a-b_c.~1/' })).pathPrefix, '/a-b_c.~1/');
});

test('credential header and username grammars reject injection and reserved namespaces', () => {
  for (const headerName of ['Authorization', 'x-isolated-request', 'X-ALPI-Token', 'x-api key', 'x-a\r\nInjected', 'x-' + 'a'.repeat(63)])
    assert.throws(() => validate(metadata({ authType: 'api-key', headerName })));
  for (const username of ['', 'a:b', 'a\nb', 'é', 'a'.repeat(257)])
    assert.throws(() => validate(metadata({ authType: 'basic', username })));
});

test('secret values preserve printable whitespace and errors never echo credentials', () => {
  assert.equal(validateSecretValue(' synthetic-sensitive '), ' synthetic-sensitive ');
  assert.equal(validateSecretValue('a'.repeat(8192)).length, 8192);
  for (const value of [undefined, null, 123, '', 'synthetic-sensitive\n', '\0synthetic-sensitive', 'é', 'a'.repeat(8193)])
    assert.throws(() => validateSecretValue(value), error => {
      assert.equal(error.message, 'Invalid secret value.'); return true;
    });
});
