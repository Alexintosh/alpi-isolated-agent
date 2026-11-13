const { randomBytes } = require('node:crypto');

function gitEntries(repositories, { allowFixtureHttp = false } = {}) {
  const entries = new Map();
  for (const repository of repositories) {
    if (!repository || !/^[a-z0-9-]{1,80}$/.test(repository.id) || entries.has(repository.id) ||
        typeof repository.credentialRef !== 'string') throw new Error('Invalid Git repository');
    const base = new URL(repository.baseURL);
    if ((base.protocol !== 'https:' && !(allowFixtureHttp && base.protocol === 'http:')) ||
        base.username || base.password || base.search || base.hash ||
        !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(base.pathname) || base.pathname.split('/').some(value => value === '.' || value === '..'))
      throw new Error('Invalid Git endpoint');
    const token = 'isolated-' + randomBytes(32).toString('hex');
    entries.set(repository.id, { repository: { ...repository }, base, token,
      authorization: 'Basic ' + Buffer.from('isolated:' + token).toString('base64') });
  }
  return entries;
}
function gitRoute(request, entries) {
  const match = /^\/git\/([a-z0-9-]+)\/repo\.git\/(info\/refs\?service=(git-upload-pack|git-receive-pack)|git-upload-pack|git-receive-pack)$/.exec(request.url ?? '');
  if (!match) return;
  const entry = entries.get(match[1]); if (!entry) return;
  const discovery = Boolean(match[3]), service = match[3] ?? match[2];
  if (request.method !== (discovery ? 'GET' : 'POST') || request.headers['content-encoding'] ||
      (!discovery && request.headers['content-type'] !== `application/x-${service}-request`) ||
      (request.headers['git-protocol'] !== undefined && request.headers['git-protocol'] !== 'version=2')) return;
  const upstream = new URL(entry.base.href + '/' + match[2]);
  return { entry, upstream, contentType: discovery ? undefined : `application/x-${service}-request`,
    responseType: `application/x-${service}-${discovery ? 'advertisement' : 'result'}`,
    protocol: request.headers['git-protocol'] };
}
function gitCredential(value) {
  let credential;
  try { credential = JSON.parse(value); } catch { throw new Error('Git credential unavailable'); }
  if (!credential || typeof credential.username !== 'string' || !credential.username.length || /[:\x00-\x1f\x7f]/.test(credential.username) ||
      typeof credential.password !== 'string' || !credential.password.length || /[\x00-\x1f\x7f]/.test(credential.password) ||
      Buffer.byteLength(value) > 65536) throw new Error('Git credential unavailable');
  const encoded = Buffer.from(credential.username + ':' + credential.password).toString('base64');
  return { authorization: 'Basic ' + encoded, redact: [credential.password, encoded, value] };
}
function guestGitConfig(entries, endpoint) {
  const base = new URL(endpoint);
  if (base.protocol !== 'http:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash)
    throw new Error('Invalid guest Git endpoint');
  return [...entries.values()].map(entry => {
    const replacement = `${base.origin}/git/${entry.repository.id}/repo.git`;
    // Prefix rewrites cannot broaden the route: any suffix other than the three
    // exact smart-HTTP operations is rejected before looking up credentials.
    return `[url ${JSON.stringify(replacement)}]\n\tinsteadOf = ${entry.base.href}\n\tinsteadOf = ${entry.base.href.slice(0, -4)}\n` +
      `[http ${JSON.stringify(replacement)}]\n\textraHeader = Authorization: ${entry.authorization}\n\tfollowRedirects = false\n`;
  }).join('\n');
}
module.exports = { gitEntries, gitRoute, gitCredential, guestGitConfig };
