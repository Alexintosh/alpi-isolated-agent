const { randomBytes } = require('node:crypto');
const { validateSecretMetadata, validateSecretValue } = require('./secret-scope.cjs');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function secretEntries(secrets, environmentId) {
  if (!Array.isArray(secrets) || secrets.length > 64) throw new Error('Invalid credential scope.');
  const entries = new Map();
  for (const item of secrets) {
    const metadata = validateSecretMetadata(item, [environmentId]);
    if (typeof item.id !== 'string' || !UUID.test(item.id) || entries.has(item.id) || typeof item.credentialRef !== 'string' ||
        !item.credentialRef.startsWith('secrets/credential/') || !UUID.test(item.credentialRef.slice('secrets/credential/'.length)))
      throw new Error('Invalid credential scope.');
    const token = 'isolated-' + randomBytes(32).toString('hex');
    entries.set(item.id, { secret: { ...metadata, id: item.id, credentialRef: item.credentialRef },
      base: new URL(metadata.origin), token, authorization: 'Bearer ' + token });
  }
  return entries;
}

// Deliberately narrow URL grammar: validate the raw path before WHATWG URL can
// remove dot segments or interpret an authority. Query data never changes scope.
function secretRoute(request, entries) {
  const raw = request.url;
  if (typeof raw !== 'string' || raw.length > 16384 || /[\s\x00-\x1f\x7f\\#]/.test(raw)) return;
  const match = /^\/secrets\/([a-f0-9-]{36})(\/[^?]*)(\?.*)?$/.exec(raw);
  if (!match) return;
  const entry = entries.get(match[1]), pathname = match[2];
  if (!entry || !entry.secret.methods.includes(request.method) || request.headers['content-encoding'] ||
      !/^\/[A-Za-z0-9_.~/-]*$/.test(pathname) || pathname.includes('//') ||
      pathname.split('/').some(part => part === '.' || part === '..') ||
      !pathname.startsWith(entry.secret.pathPrefix)) return;
  const upstream = new URL(entry.secret.origin + pathname + (match[3] ?? ''));
  if (upstream.origin !== entry.secret.origin || upstream.pathname !== pathname) return;
  return { entry, upstream };
}

function secretCredential(entry, value) {
  validateSecretValue(value);
  const { authType, username, headerName } = entry.secret;
  const encoded = authType === 'basic' ? Buffer.from(username + ':' + value).toString('base64') : null;
  const authorization = authType === 'bearer' ? 'Bearer ' + value : authType === 'basic' ? 'Basic ' + encoded : value;
  return { headers: { [authType === 'api-key' ? headerName : 'Authorization']: { values: [authorization] } },
    redact: [value, authorization, ...(encoded ? [encoded] : [])] };
}

function secretRequestHeaders(request) {
  const headers = { Accept: { values: ['application/json, text/plain, text/event-stream'] }, 'Accept-Encoding': { values: ['identity'] } };
  // No cookies, proxy headers, arbitrary authorization or forwarding headers.
  for (const name of ['accept', 'content-type', 'anthropic-version', 'openai-beta', 'x-github-api-version', 'idempotency-key']) {
    const value = request.headers[name];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length > 1024 || /[^\x20-\x7e]/.test(value)) throw new Error('Invalid request headers.');
    if (name === 'accept') headers.Accept = { values: [value] };
    else headers[name] = { values: [value] };
  }
  return headers;
}

function guestSecrets(entries, endpoint) {
  const base = new URL(endpoint);
  if (base.protocol !== 'http:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash)
    throw new Error('Invalid guest credential endpoint.');
  return { version: 1, entries: [...entries.values()].map(({ secret, authorization }) => ({
    id: secret.id, name: secret.name, origin: secret.origin, pathPrefix: secret.pathPrefix, methods: [...secret.methods],
    baseURL: `${base.origin}/secrets/${secret.id}`, authorization,
  })) };
}

module.exports = { secretEntries, secretRoute, secretCredential, secretRequestHeaders, guestSecrets };
