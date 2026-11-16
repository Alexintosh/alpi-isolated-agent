const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { readJson, writeJson } = require('./atomic-json.cjs');
const { streamCommand, cleanEnvironment } = require('./driver-common.cjs');
const { gitCredential } = require('./git-bridge.cjs');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const CREDENTIAL_PREFIX = 'git/repository/';
const MAX_REPOSITORIES = 32;
const clone = value => JSON.parse(JSON.stringify(value));
// Fixed actionable English messages only. Helper, vault and filesystem details
// never escape, so no token, parser snippet or upstream body can leak.
const fixed = message => Object.assign(new Error(message), { code: 'GIT_CATALOG' });
const failure = () => fixed('The Git catalog is unavailable. Saved data was preserved.');
const invalidCatalog = () => fixed('Invalid Git catalog. Saved data was preserved and will not be rewritten.');
const guard = error => error && error.code === 'GIT_CATALOG' ? error : failure();
function repositoryName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(value))
    throw fixed('Enter a GitHub owner/repository, without a URL or credentials.');
  const canonical = value.replace(/\.git$/i, '').toLowerCase();
  if (!canonical.split('/')[1] || ['.', '..'].includes(canonical.split('/')[1]) || /\.git$/i.test(canonical))
    throw fixed('Invalid repository.');
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
// Host only. Tokens belong exclusively to SecretVault under fresh
// git/repository/<uuid> references; snapshots and metadata carry no secrets.
class GitCatalog {
  constructor({ stateRoot, vault, credentialReader = readHostCredential }) {
    this.file = path.join(stateRoot, 'git-repositories.json'); this.vault = vault; this.credentialReader = credentialReader;
    this.queue = Promise.resolve();
    this.fault = false;
    this.cleanupPending = false;
    // Fail closed on malformed state: the file is never reset or rewritten.
    try {
      const stored = readJson(this.file, { version: 1, repositories: [] });
      if (stored?.version !== 1 || !Array.isArray(stored.repositories) || stored.repositories.length > MAX_REPOSITORIES)
        throw invalidCatalog();
      this._repositories = stored.repositories.map(item => {
        if (!item || !UUID.test(item.id) || typeof item.credentialRef !== 'string' || !item.credentialRef.startsWith(CREDENTIAL_PREFIX) ||
            !UUID.test(item.credentialRef.slice(CREDENTIAL_PREFIX.length)) || repositoryName(item.repository) !== item.repository)
          throw invalidCatalog();
        return { id: item.id, repository: item.repository, credentialRef: item.credentialRef,
          baseURL: `https://github.com/${item.repository}.git` };
      });
      const unique = key => new Set(this._repositories.map(item => item[key])).size === this._repositories.length;
      if (!unique('id') || !unique('repository') || !unique('credentialRef')) throw invalidCatalog();
    } catch { throw invalidCatalog(); }
  }
  // Runtime grants. When disk state is uncertain no stale repository list may be
  // leased, so the accessor refuses instead of returning it.
  get repositories() {
    if (this.fault) throw failure();
    return clone(this._repositories);
  }
  snapshot() {
    return { repositories: this.fault ? [] : this._repositories.map(({ id, repository, baseURL, credentialRef }) =>
      ({ id, repository, baseURL, credentialAvailable: this.vault.has(credentialRef) })),
      fault: this.fault, cleanupPending: this.cleanupPending };
  }
  serialize(operation) { const task = this.queue.then(operation); this.queue = task.catch(() => {}); return task; }
  persist(repositories) {
    try {
      writeJson(this.file, { version: 1, repositories: repositories.map(({ id, repository, credentialRef }) => ({ id, repository, credentialRef })) });
    } catch {
      // Metadata publication is uncertain: a rename may have succeeded before
      // directory fsync failed. Retain every new and old ciphertext and block
      // further leases until a restart revalidates disk.
      this.fault = true;
      throw failure();
    }
    this._repositories = repositories;
  }
  // Publication is the point of no return. Any writer exception, including one
  // from an injected seam, faults the catalog: ciphertext is never removed on
  // an ambiguous persist failure.
  publish(repositories) {
    try { this.persist(repositories); }
    catch (error) { this.fault = true; throw error?.code === 'GIT_CATALOG' ? error : failure(); }
  }
  async retire(ref) {
    try { await this.vault.remove(ref); }
    catch {
      // An unreferenced encrypted record grants no access. Do not report a
      // completed save as failed, which could cause a duplicate on retry.
      this.cleanupPending = true;
    }
  }
  prepareSave(input) {
    if (this.fault) throw failure();
    if (!input || typeof input !== 'object') throw fixed('Enter a GitHub owner/repository and token.');
    const repository = repositoryName(input.repository);
    const username = input.username;
    if (typeof username !== 'string' || !username.length || username.length > 256 || /[:\x00-\x1f\x7f]/.test(username))
      throw fixed('Enter the GitHub username for this token. It must not contain a colon or control characters.');
    // No trimming: whitespace is part of a secret. Each save supplies a new value.
    const value = input.value;
    if (typeof value !== 'string' || !value.length || Buffer.byteLength(value, 'utf8') > 65536 || /[\x00-\x1f\x7f]/.test(value))
      throw fixed('Enter a GitHub token. It must be non-empty and contain no control characters.');
    try { gitCredential(JSON.stringify({ username, password: value })); }
    catch { throw fixed('The GitHub token could not be accepted. Enter a current token from your GitHub account settings.'); }
    if (!this._repositories.some(item => item.repository === repository) && this._repositories.length >= MAX_REPOSITORIES)
      throw fixed('The limit of 32 repositories has been reached.');
    return { repository, username, value };
  }
  prepareImport(value) {
    if (this.fault) throw failure();
    const repository = repositoryName(value);
    if (!this._repositories.some(item => item.repository === repository) && this._repositories.length >= MAX_REPOSITORIES)
      throw fixed('The limit of 32 repositories has been reached.');
    return { repository };
  }
  prepareRemove(id) {
    if (this.fault) throw failure();
    const item = typeof id === 'string' && this._repositories.find(entry => entry.id === id);
    if (!item) throw fixed('Unknown repository.');
    return { id: item.id };
  }
  save(input, { signal } = {}) {
    // Capture before queuing: later mutation of the caller's object cannot change this task.
    let captured;
    try { captured = this.prepareSave(input); } catch (error) { return Promise.reject(guard(error)); }
    return this.serialize(async () => {
      signal?.throwIfAborted();
      const plan = this.prepareSave(captured);
      const previous = this._repositories.find(item => item.repository === plan.repository);
      const credential = JSON.stringify({ username: plan.username, password: plan.value });
      const item = { id: previous?.id ?? randomUUID(), repository: plan.repository,
        baseURL: `https://github.com/${plan.repository}.git`, credentialRef: CREDENTIAL_PREFIX + randomUUID() };
      try { await this.vault.put(item.credentialRef, credential); }
      catch { throw fixed('The GitHub token could not be encrypted. Check Keychain availability.'); }
      if (signal?.aborted) { await this.retire(item.credentialRef); signal.throwIfAborted(); }
      signal?.throwIfAborted();
      this.publish([...this._repositories.filter(entry => entry.repository !== plan.repository), item]);
      if (previous) await this.retire(previous.credentialRef);
      return this.snapshot();
    });
  }
  importRepository(value, { signal } = {}) {
    let captured;
    try { captured = this.prepareImport(value); } catch (error) { return Promise.reject(guard(error)); }
    return this.serialize(async () => {
      signal?.throwIfAborted();
      const { repository } = this.prepareImport(captured.repository);
      const previous = this._repositories.find(item => item.repository === repository);
      // The only host credential lookup is for the repository explicitly chosen
      // in the trusted UI. No scan/import of unrelated GitHub credentials.
      let credential;
      try { credential = await this.credentialReader(repository); gitCredential(credential); }
      catch { throw fixed('The GitHub credential is unavailable for the selected repository.'); }
      signal?.throwIfAborted();
      const item = { id: previous?.id ?? randomUUID(), repository, baseURL: `https://github.com/${repository}.git`,
        credentialRef: CREDENTIAL_PREFIX + randomUUID() };
      try { await this.vault.put(item.credentialRef, credential); }
      catch { throw fixed('The GitHub credential could not be encrypted. Check Keychain availability.'); }
      if (signal?.aborted) { await this.retire(item.credentialRef); signal.throwIfAborted(); }
      signal?.throwIfAborted();
      this.publish([...this._repositories.filter(entry => entry.repository !== repository), item]);
      if (previous) await this.retire(previous.credentialRef);
      return this.snapshot();
    });
  }
  remove(id, { signal } = {}) {
    let captured;
    try { captured = this.prepareRemove(id); } catch (error) { return Promise.reject(guard(error)); }
    return this.serialize(async () => {
      signal?.throwIfAborted();
      this.prepareRemove(captured.id);
      const item = this._repositories.find(entry => entry.id === captured.id);
      signal?.throwIfAborted();
      this.publish(this._repositories.filter(entry => entry.id !== captured.id));
      await this.retire(item.credentialRef);
      return this.snapshot();
    });
  }
}
module.exports = { GitCatalog, repositoryName, readHostCredential };