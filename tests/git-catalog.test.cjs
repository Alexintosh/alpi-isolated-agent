const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { GitCatalog, repositoryName } = require('../src/runtime/git-catalog.cjs');
function fixture(t) {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'git-catalog-'));
  t.after(() => fs.rmSync(stateRoot,{recursive:true,force:true}));
  const secrets = new Map(), lookups=[];
  const options = { stateRoot, vault: { has:ref=>secrets.has(ref), put:async(ref,value)=>secrets.set(ref,value), remove:async ref=>secrets.delete(ref) },
    credentialReader:async repo=>{lookups.push(repo);return JSON.stringify({username:'fixture',password:'synthetic-private-token'});} };
  return { catalog:new GitCatalog(options), options, secrets, lookups, stateRoot };
}
test('repository input is a GitHub owner/name only, canonical and not a URL or credential',()=>{
  assert.equal(repositoryName('Owner/My.Repo.git'),'owner/my.repo');
  for(const value of ['owner/project','OWNER/Project.git','owner/project.git-feature']) assert.equal(repositoryName(repositoryName(value)),repositoryName(value));
  for(const value of ['https://github.com/owner/repo','owner/repo/extra','owner/..','../repo','owner/repo?x','owner/repo\n','user:token@github.com/repo','owner/.git',
    'owner/project.git.git','owner/project.GIT.git','owner/project.git.git.git'])
    assert.throws(()=>repositoryName(value));
});
test('only explicit repository is looked up; snapshots and metadata never contain the credential',async t=>{
  const {catalog,options,secrets,lookups,stateRoot}=fixture(t);
  assert.equal(secrets.size,0);assert.deepEqual(lookups,[]);
  await catalog.importRepository('Owner/Project');assert.deepEqual(lookups,['owner/project']);assert.equal(secrets.size,1);
  const first=catalog.snapshot().repositories[0];assert.equal(first.baseURL,'https://github.com/owner/project.git');assert(first.credentialAvailable);
  assert(!JSON.stringify(catalog.snapshot()).includes('synthetic-private-token'));
  assert(!fs.readFileSync(path.join(stateRoot,'git-repositories.json'),'utf8').includes('synthetic-private-token'));
  assert.deepEqual(new GitCatalog(options).snapshot(),catalog.snapshot());
  const oldRef=[...secrets.keys()][0];await catalog.importRepository('owner/project');
  assert.equal(catalog.snapshot().repositories[0].id,first.id);assert.equal(secrets.size,1);assert(!secrets.has(oldRef));
  await catalog.remove(first.id);assert.equal(secrets.size,0);assert.equal(new GitCatalog(options).repositories.length,0);
});
test('failed credential lookup or metadata commit preserves the previous grant and scrubs errors',async t=>{
  const {catalog,secrets}=fixture(t);await catalog.importRepository('owner/project');
  const before=catalog.snapshot(), previousKeys=[...secrets.keys()];
  catalog.credentialReader=async()=>{throw new Error('synthetic-private-token');};
  await assert.rejects(catalog.importRepository('owner/project'),error=>!error.message.includes('synthetic-private-token'));
  assert.deepEqual(catalog.snapshot(),before);
  catalog.credentialReader=async()=>JSON.stringify({username:'fixture',password:'next-canary'});
  catalog.persist=()=>{throw new Error('disk failure');};
  await assert.rejects(catalog.importRepository('owner/project'),/could not be saved/);
  assert.deepEqual(catalog.snapshot(),before);assert.deepEqual([...secrets.keys()],previousKeys);
});
