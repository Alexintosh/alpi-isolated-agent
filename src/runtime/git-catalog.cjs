const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { readJson, writeJson } = require('./atomic-json.cjs');
const { streamCommand, cleanEnvironment } = require('./driver-common.cjs');
const { gitCredential } = require('./git-bridge.cjs');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function repositoryName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(value))
    throw new Error('Enter a GitHub owner/repository, without a URL or credentials.');
  const canonical = value.replace(/\.git$/i, '').toLowerCase();
  if (!canonical.split('/')[1] || ['.', '..'].includes(canonical.split('/')[1]) || /\.git$/i.test(canonical)) throw new Error('Invalid repository.');
  return canonical;
}
async function readHostCredential(repository) {
  repository = repositoryName(repository);
  const channel = streamCommand('/Library/Developer/CommandLineTools/usr/bin/git',
    ['-c', 'credential.interactive=false', '-c', 'credential.useHttpPath=true', 'credential', 'fill'], {
      env: cleanEnvironment(os.homedir(), { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never',
        GIT_ASKPASS: '/usr/bin/false', SSH_ASKPASS: '/usr/bin/false' }), timeout: 10000,
    });
  channel.input.end(`protocol=https\nhost=github.com\npath=${repository}.git\n\n`);
  try {
    const chunks = []; let bytes = 0;
    for await (const chunk of channel.output) {
      bytes += chunk.length; if (bytes > 65536) throw new Error('Credential limit'); chunks.push(chunk);
    }
    await channel.done;
    const output = Buffer.concat(chunks).toString('utf8');
    const fields = new Map();
    for (const line of output.split('\n')) {
      if (!line) continue;
      const separator = line.indexOf('='); if (separator <= 0) throw new Error('Invalid credential');
      const key = line.slice(0, separator), value = line.slice(separator + 1);
      if (fields.has(key)) throw new Error('Duplicate credential field'); fields.set(key, value);
    }
    if (fields.get('protocol') !== 'https' || fields.get('host') !== 'github.com' ||
        (fields.has('path') && fields.get('path') !== repository + '.git')) throw new Error('Credential scope mismatch');
    const username = fields.get('username'), password = fields.get('password');
    if (!username || !password || /[:\x00-\x1f\x7f]/.test(username) || /[\x00-\x1f\x7f]/.test(password)) throw new Error('Invalid credential');
    return JSON.stringify({ username, password });
  } catch {
    channel.stop(); await channel.done.catch(() => {});
    throw new Error('The GitHub credential is unavailable on this Mac. No automatic login or prompt is attempted.');
  }
}
class GitCatalog {
  constructor({ stateRoot, vault, credentialReader = readHostCredential }) {
    this.file = path.join(stateRoot, 'git-repositories.json'); this.vault = vault; this.credentialReader = credentialReader;
    this.queue = Promise.resolve();
    const stored = readJson(this.file, { version: 1, repositories: [] });
    if (stored?.version !== 1 || !Array.isArray(stored.repositories) || stored.repositories.length > 32)
      throw new Error('Invalid Git catalog.');
    this.repositories = stored.repositories.map(item => {
      if (!item || !UUID.test(item.id) || typeof item.credentialRef !== 'string' || !item.credentialRef.startsWith('git/repository/') ||
          !UUID.test(item.credentialRef.slice('git/repository/'.length)) || repositoryName(item.repository) !== item.repository)
        throw new Error('Invalid Git catalog.');
      return { id: item.id, repository: item.repository, credentialRef: item.credentialRef,
        baseURL: `https://github.com/${item.repository}.git` };
    });
    if (new Set(this.repositories.map(item => item.id)).size !== this.repositories.length ||
        new Set(this.repositories.map(item => item.repository)).size !== this.repositories.length) throw new Error('Duplicate Git catalog entry.');
  }
  snapshot() { return { repositories: this.repositories.map(({ id, repository, baseURL, credentialRef }) =>
    ({ id, repository, baseURL, credentialAvailable: this.vault.has(credentialRef) })) }; }
  serialize(operation) { const task = this.queue.then(operation); this.queue = task.catch(() => {}); return task; }
  persist(repositories) {
    writeJson(this.file, { version: 1, repositories: repositories.map(({ id, repository, credentialRef }) => ({ id, repository, credentialRef })) });
    this.repositories = repositories;
  }
  importRepository(value) {
    return this.serialize(async () => {
      const repository = repositoryName(value), previous = this.repositories.find(item => item.repository === repository);
      if (!previous && this.repositories.length >= 32) throw new Error('The limit of 32 repositories has been reached.');
      // The only host credential lookup is for the repository explicitly chosen
      // in the trusted UI. No scan/import of unrelated GitHub credentials.
      let credential;
      try { credential = await this.credentialReader(repository); gitCredential(credential); }
      catch { throw new Error('The GitHub credential is unavailable for the selected repository.'); }
      const item = { id: previous?.id ?? randomUUID(), repository, baseURL: `https://github.com/${repository}.git`,
        credentialRef: 'git/repository/' + randomUUID() };
      await this.vault.put(item.credentialRef, credential);
      try { this.persist([...this.repositories.filter(entry => entry.repository !== repository), item]); }
      catch { await this.vault.remove(item.credentialRef).catch(() => {}); throw new Error('The repository could not be saved.'); }
      if (previous) await this.vault.remove(previous.credentialRef);
      return this.snapshot();
    });
  }
  remove(id) {
    return this.serialize(async () => {
      const item = this.repositories.find(entry => entry.id === id);
      if (!item) throw new Error('Unknown repository.');
      this.persist(this.repositories.filter(entry => entry.id !== id));
      await this.vault.remove(item.credentialRef); return this.snapshot();
    });
  }
}
module.exports = { GitCatalog, repositoryName, readHostCredential };
