const http = require('node:http');
const fs = require('node:fs');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { ProxyAgent, request: proxyRequest } = require('undici');
const { SecretRedactor } = require('./secret-redactor.cjs');
const { normalizeRequest } = require('./network-policy.cjs');
const { gitEntries, gitRoute, gitCredential, guestGitConfig } = require('./git-bridge.cjs');
const { secretEntries, secretRoute, secretCredential, secretRequestHeaders, guestSecrets } = require('./secret-bridge.cjs');
const clone = value => JSON.parse(JSON.stringify(value));
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
function header(headers, name) {
  const entries = Object.entries(headers ?? {}).filter(([key]) => key.toLowerCase() === name);
  return entries.length === 1 && entries[0][1]?.values?.length === 1 ? entries[0][1].values[0] : undefined;
}
const reject = code => ({ action: 2, response: { statusCode: code } });

async function createCredentialBridge({ environmentId, providers = [], selected, gitRepositories = [], secrets = [], allowGitFixtureHttp = false,
  vault, proxyPort, caFile, port = 0, decide = async () => false, requestUpstream = proxyRequest,
  maxRequests = 16, maxRequestBytes = 8 * 1024 * 1024, maxResponseBytes = 64 * 1024 * 1024,
  maxGitRequestBytes = 256 * 1024 * 1024, maxGitResponseBytes = 512 * 1024 * 1024 }) {
  const repositories = gitEntries(gitRepositories, { allowFixtureHttp: allowGitFixtureHttp });
  const scopedSecrets = secretEntries(secrets, environmentId);
  const entries = new Map();
  for (const provider of providers) {
    if (!/^[a-z0-9-]+$/.test(provider.id) || entries.has(provider.id) || provider.api !== 'openai-completions') throw new Error('Invalid bridge provider');
    const base = new URL(provider.baseURL);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || !provider.models?.length) throw new Error('Invalid bridge endpoint');
    entries.set(provider.id, { provider: clone(provider), base, token: 'isolated-' + randomBytes(32).toString('hex') });
  }
  const first = [...entries.values()][0]?.provider;
  const defaultModel = selected ?? (first ? { provider: first.id, model: first.models[0].id } : null);
  if (defaultModel && !entries.get(defaultModel.provider)?.provider.models.some(model => model.id === defaultModel.model)) throw new Error('Invalid default model');
  const transportCapability = randomBytes(32).toString('hex');
  const dispatcher = new ProxyAgent({ uri: `http://127.0.0.1:${proxyPort}`, proxyTunnel: false,
    headers: { 'x-isolated-transport': transportCapability }, requestTls: { ca: fs.readFileSync(caFile), rejectUnauthorized: true },
    connections: maxRequests, pipelining: 1, headersTimeout: 30 * 60 * 1000, bodyTimeout: 30 * 60 * 1000 });
  const tickets = new Map(), active = new Set(), sockets = new Set();
  let closed = false, paused = false, closePromise;
  const server = http.createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 30 * 60 * 1000, headersTimeout: 10000 }, (req, res) => {
    void serve(req, res).catch(() => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' }).end('{"error":"Credential relay unavailable"}'); else res.destroy(); });
  });
  server.maxConnections = 64;
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); });
  server.on('connect', (_req, socket) => socket.destroy()); server.on('upgrade', (_req, socket) => socket.destroy());
  server.on('clientError', (_error, socket) => socket.destroy());
  async function serve(req, res) {
    const fail = code => { req.resume(); res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end('{"error":"Request rejected by credential boundary"}'); };
    if (closed || paused || active.size >= maxRequests) return fail(503);
    const git = gitRoute(req, repositories);
    const scoped = secretRoute(req, scopedSecrets);
    const model = typeof req.url === 'string' && req.url.match(/^\/models\/([a-z0-9-]+)\/v1\/(models|chat\/completions)$/);
    if (!git && !model && !scoped) return fail(404);
    const entry = git?.entry ?? scoped?.entry ?? entries.get(model[1]), operation = model?.[2];
    const fakeAuthorization = git || scoped ? entry.authorization : entry && `Bearer ${entry.token}`;
    if (!entry || !equal(req.headers.authorization, fakeAuthorization)) return fail(401);
    if (!git && !scoped && ((operation === 'models' && req.method !== 'GET') || (operation === 'chat/completions' && req.method !== 'POST') || req.headers['content-encoding'])) return fail(405);
    const controller = new AbortController(); active.add(controller);
    const disconnect = () => { if (!res.writableFinished) controller.abort(); };
    res.once('close', disconnect); req.once('aborted', () => controller.abort());
    const timer = setTimeout(() => controller.abort(), 30 * 60 * 1000); timer.unref?.();
    let ticket;
    try {
      let body;
      if ((req.method === 'POST' && git) || (scoped && !['GET', 'HEAD'].includes(req.method))) {
        const limit = git ? maxGitRequestBytes : maxRequestBytes;
        if (Number(req.headers['content-length'] || 0) > limit) return fail(413);
        // Bound uploads without buffering arbitrary API bodies or Git packs.
        body = (async function* () {
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > limit) { controller.abort(); throw new Error('Request size limit'); }
            yield chunk;
          }
        })();
      } else if (req.method === 'POST') {
        if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) return fail(415);
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > maxRequestBytes) return fail(413); chunks.push(chunk); }
        body = Buffer.concat(chunks);
        let parsed; try { parsed = JSON.parse(body.toString('utf8')); } catch { return fail(400); }
        if (!parsed || !entry.provider.models.some(model => model.id === parsed.model) || !Array.isArray(parsed.messages) ||
            (parsed.stream !== undefined && typeof parsed.stream !== 'boolean')) return fail(400);
      } else if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] || 0) !== 0) return fail(400);
      controller.signal.throwIfAborted();
      const secret = await vault.get((git ? entry.repository : scoped ? entry.secret : entry.provider).credentialRef);
      if (typeof secret !== 'string' || !secret.length || /[\r\n\x00]/.test(secret)) return fail(503);
      const credential = git ? gitCredential(secret) : scoped ? secretCredential(entry, secret) : { authorization: `Bearer ${secret}`, redact: [secret] };
      const upstream = git?.upstream ?? scoped?.upstream ?? new URL(entry.base.href.replace(/\/$/, '') + '/' + operation);
      const applicationHeaders = scoped ? secretRequestHeaders(req) : { Accept: { values: [git ? '*/*' : 'application/json, text/event-stream'] },
        'Accept-Encoding': { values: ['identity'] } };
      if (!scoped && req.method === 'POST') applicationHeaders['Content-Type'] = { values: [git ? git.contentType : 'application/json'] };
      if (git?.protocol) applicationHeaders['Git-Protocol'] = { values: [git.protocol] };
      ticket = randomBytes(32).toString('hex');
      const permit = { fakeAuthorization, credentialHeaders: credential.headers ?? { Authorization: { values: [credential.authorization] } }, applicationHeaders,
        method: req.method, upstream, signal: controller.signal, policyDenied: false };
      tickets.set(ticket, permit);
      const result = await requestUpstream(upstream, { dispatcher, method: req.method, body, maxRedirections: 0, signal: controller.signal,
        headers: { ...Object.fromEntries(Object.entries(applicationHeaders).map(([name, value]) => [name, value.values[0]])),
          authorization: fakeAuthorization, 'x-isolated-request': ticket } });
      result.body.on('error', () => {});
      if (permit.policyDenied) {
        result.body.destroy();
        // A host policy refusal is not an upstream credential failure. In
        // particular, Harness classifies upstream 401/403 as an invalid key.
        // 424 is terminal for the client, avoiding automatic request replay.
        res.writeHead(424, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({error:{type:'network_policy_denied',code:'network_policy_denied',
          message:'Host network approval was denied or expired. Check the Network panel, then retry explicitly.'}}));
        return;
      }
      if (result.statusCode >= 300 && result.statusCode < 400) { result.body.destroy(); return fail(502); }
      const type = result.headers['content-type'];
      if (result.headers['content-encoding'] && result.headers['content-encoding'] !== 'identity') { result.body.destroy(); return fail(502); }
      // Copy no arbitrary upstream headers (including Location/Set-Cookie).
      if (git && result.statusCode === 200 && type !== git.responseType) { result.body.destroy(); return fail(502); }
      const contentType = git ? (result.statusCode === 200 ? git.responseType : 'text/plain') :
        typeof type === 'string' && /^text\/event-stream(?:;|$)/i.test(type) ? 'text/event-stream' :
        scoped && typeof type === 'string' && /^text\/plain(?:;|$)/i.test(type) ? 'text/plain' : 'application/json';
      res.writeHead(result.statusCode, { 'content-type': contentType, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.flushHeaders();
      await pipeline(result.body, new SecretRedactor(credential.redact, { maxBytes: git ? maxGitResponseBytes : maxResponseBytes }), res, { signal: controller.signal });
    } finally {
      if (ticket) tickets.delete(ticket);
      clearTimeout(timer); active.delete(controller); res.removeListener('close', disconnect);
    }
  }
  try { await new Promise((resolve, rejectListen) => { server.once('error', rejectListen); server.listen(port, '127.0.0.1', resolve); }); }
  catch { await dispatcher.destroy(); throw new Error('Credential listener unavailable'); }
  server.on('error', () => { void close(); });
  async function transform(input) {
    if (closed || paused || input.environmentId !== environmentId) return reject(503);
    const transport = header(input.request?.headers, 'x-isolated-transport');
    if (input.request?.method === 'CONNECT' && equal(transport, transportCapability)) {
      let destination; try { destination = normalizeRequest(input.request, input.context); } catch { return reject(403); }
      const allowed = [...entries.values(), ...repositories.values(), ...scopedSecrets.values()].some(entry => entry.base.hostname === destination.host && Number(entry.base.port || (entry.base.protocol === 'https:' ? 443 : 80)) === destination.port);
      return allowed ? { action: 1 } : reject(403);
    }
    const ticket = header(input.request?.headers, 'x-isolated-request');
    const permit = tickets.get(ticket);
    if (!permit) {
      // Guest-provided lookalike private headers never leave this boundary.
      if (Object.keys(input.request?.headers ?? {}).some(name => name.toLowerCase().startsWith('x-isolated-'))) return reject(403);
      return undefined;
    }
    tickets.delete(ticket); // one host-owned request, never replayable
    let destination; try { destination = normalizeRequest(input.request, input.context); } catch { return reject(403); }
    const { upstream } = permit;
    let query;
    try { query = new URL(input.request.url, upstream.origin).search; } catch { return reject(403); }
    if (permit.signal.aborted || input.signal.aborted || input.request.method !== permit.method ||
      destination.scheme !== upstream.protocol.slice(0, -1) || destination.host !== upstream.hostname ||
      destination.port !== Number(upstream.port || (upstream.protocol === 'https:' ? 443 : 80)) || destination.pathname !== upstream.pathname ||
      query !== upstream.search || !equal(header(input.request.headers, 'authorization'), permit.fakeAuthorization)) return reject(403);
    if (await decide(input) !== true) { permit.policyDenied = true; return reject(403); }
    if (permit.signal.aborted || input.signal.aborted || closed || paused) return reject(403);
    // Keep only bridge-owned application headers. Strip both private capabilities
    // and the guest's substitute before the real upstream sees the request.
    const headers = { ...permit.applicationHeaders, ...permit.credentialHeaders };
    return { action: 1, modifiedRequest: { headers } };
  }
  function close() {
    if (closePromise) return closePromise;
    closed = true; tickets.clear();
    for (const controller of active) controller.abort();
    for (const socket of sockets) socket.destroy();
    closePromise = Promise.all([dispatcher.destroy(), new Promise(resolve => server.close(resolve))]).then(() => {});
    return closePromise;
  }
  return { port: server.address().port, defaultModel: defaultModel && clone(defaultModel), transform, close, healthy: () => !closed && !paused && server.listening,
    pause() {
      paused = true; tickets.clear();
      for (const controller of active) controller.abort();
      for (const socket of sockets) socket.destroy();
    },
    resume() { if (closed) throw new Error('Credential listener is closed.'); paused = false; },
    guestGitConfig: endpoint => guestGitConfig(repositories, endpoint),
    guestSecrets: endpoint => guestSecrets(scopedSecrets, endpoint),
    guestProviders(endpoint) {
      const base = new URL(endpoint);
      if (base.protocol !== 'http:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('Invalid guest bridge endpoint');
      return [...entries.values()].map(({ provider, token }) => ({ provider: { ...clone(provider), baseURL: `${base.origin}/models/${provider.id}/v1` }, token }));
    } };
}
module.exports = { createCredentialBridge };
