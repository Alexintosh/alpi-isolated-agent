const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { GitCatalog, repositoryName } = require('../src/runtime/git-catalog.cjs');
const FILE = 'git-repositories.json';
function fixture(t) {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'git-catalog-'));
  t.after(() => fs.rmSync(stateRoot,{recursive:true,force:true}));
  const secrets = new Map(), lookups=[];
  const options = { stateRoot, vault: { has:ref=>secrets.has(ref), put:async(ref,value)=>secrets.set(ref,value), remove:async ref=>secrets.delete(ref) },
    credentialReader:async repo=>{lookups.push(repo);return JSON.stringify({username:'fixture',password:'synthetic-private-token'});} };
  return { catalog:new GitCatalog(options), options, secrets, lookups, stateRoot };
}
const metadata = stateRoot => JSON.parse(fs.readFileSync(path.join(stateRoot,FILE),'utf8'));
const safe = error => error.code==='GIT_CATALOG' && error instanceof Error;
test('repository input is a GitHub owner/name only, canonical and not a URL or credential',()=>{
  assert.equal(repositoryName('Owner/My.Repo.git'),'owner/my.repo');
  for(const value of ['owner/project','OWNER/Project.git','owner/project.git-feature']) assert.equal(repositoryName(repositoryName(value)),repositoryName(value));
  for(const value of ['https://github.com/owner/repo','owner/repo/extra','owner/..','../repo','owner/repo?x','owner/repo\n','user:token@github.com/repo','owner/.git',
    'owner/project.git.git','owner/project.GIT.git','owner/project.git.git.git'])
    assert.throws(()=>repositoryName(value),{code:'GIT_CATALOG'});
});
test('manual save never touches the credential helper; rotation keeps a stable id and retires the old ref',async t=>{
  const {catalog,options,secrets,lookups,stateRoot}=fixture(t);
  const snapshot=await catalog.save({repository:'Owner/Project',username:'octocat',value:'ghp_synthetic_manual_token'});
  assert.deepEqual(lookups,[]);assert.equal(secrets.size,1);
  assert([...secrets.values()].includes(JSON.stringify({username:'octocat',password:'ghp_synthetic_manual_token'})));
  const first=snapshot.repositories[0];assert.equal(first.repository,'owner/project');
  assert.equal(first.baseURL,'https://github.com/owner/project.git');assert(first.credentialAvailable);
  assert.equal(snapshot.fault,false);assert.equal(snapshot.cleanupPending,false);
  assert(!JSON.stringify(snapshot).includes('ghp_synthetic_manual_token'));
  assert(!JSON.stringify(snapshot).includes('octocat'));
  assert(!JSON.stringify(snapshot).includes('git/repository/'));
  const disk=fs.readFileSync(path.join(stateRoot,FILE),'utf8');
  assert(!disk.includes('ghp_synthetic_manual_token'));assert(!disk.includes('octocat'));
  assert.deepEqual(new GitCatalog(options).snapshot(),snapshot);
  // Rotation: same id, fresh vault reference, old ciphertext retired only after publication.
  const oldRef=[...secrets.keys()][0];
  const rotated=await catalog.save({repository:'owner/project',username:'octocat',value:'ghp_replacement_token'});
  assert.equal(rotated.repositories[0].id,first.id);assert.equal(secrets.size,1);assert(!secrets.has(oldRef));
  assert([...secrets.values()].includes(JSON.stringify({username:'octocat',password:'ghp_replacement_token'})));
  const published=metadata(stateRoot).repositories[0].credentialRef;
  assert.match(published,/^git\/repository\/[0-9a-f-]{36}$/);assert.notEqual(published,oldRef);
  // A new repository gets its own id without any helper lookup.
  await catalog.save({repository:'other/project',username:'octocat',value:'ghp_other_token'});
  assert.deepEqual(lookups,[]);assert.equal(catalog.snapshot().repositories.length,2);
});
test('invalid manual input fails before any vault or helper access with fixed safe errors',async t=>{
  const {catalog,secrets,lookups,stateRoot}=fixture(t);
  const cases=[
    {repository:'owner/project',username:'octocat'},
    {repository:'owner/project',value:'ghp_x'},
    {username:'octocat',value:'ghp_x'},
    'not-an-object',
    {repository:'https://github.com/owner/repo',username:'octocat',value:'ghp_x'},
    {repository:'owner/project',username:'',value:'ghp_x'},
    {repository:'owner/project',username:'user:token',value:'ghp_x'},
    {repository:'owner/project',username:'a\nb',value:'ghp_x'},
    {repository:'owner/project',username:'a'.repeat(257),value:'ghp_x'},
    {repository:'owner/project',username:'octocat',value:''},
    {repository:'owner/project',username:'octocat',value:'tok\nen'},
    {repository:'owner/project',username:'octocat',value:'a\x00token'},
    {repository:'owner/project',username:'octocat',value:'a'.repeat(65537)},
  ];
  for(const input of cases){
    await assert.rejects(catalog.save(input),safe);
    assert.deepEqual(lookups,[]);assert.equal(secrets.size,0);
  }
  assert(!fs.existsSync(path.join(stateRoot,FILE)));
  // A whitespace-padded token is a token, never silently trimmed into another value.
  await catalog.save({repository:'owner/project',username:'octocat',value:' ghp_padded '});
  assert([...secrets.values()].includes(JSON.stringify({username:'octocat',password:' ghp_padded '})));
});
test('only explicit repository is looked up; snapshots and metadata never contain the credential',async t=>{
  const {catalog,options,secrets,lookups,stateRoot}=fixture(t);
  assert.equal(secrets.size,0);assert.deepEqual(lookups,[]);
  await catalog.importRepository('Owner/Project');assert.deepEqual(lookups,['owner/project']);assert.equal(secrets.size,1);
  const first=catalog.snapshot().repositories[0];assert.equal(first.baseURL,'https://github.com/owner/project.git');assert(first.credentialAvailable);
  assert(!JSON.stringify(catalog.snapshot()).includes('synthetic-private-token'));
  assert(!fs.readFileSync(path.join(stateRoot,FILE),'utf8').includes('synthetic-private-token'));
  assert.deepEqual(new GitCatalog(options).snapshot(),catalog.snapshot());
  const oldRef=[...secrets.keys()][0];await catalog.importRepository('owner/project');
  assert.equal(catalog.snapshot().repositories[0].id,first.id);assert.equal(secrets.size,1);assert(!secrets.has(oldRef));
  await catalog.remove(first.id);assert.equal(secrets.size,0);assert.equal(new GitCatalog(options).repositories.length,0);
});
test('failed credential lookup is sanitized; failed publication retains both records and faults until restart',async t=>{
  const {catalog,options,secrets,lookups,stateRoot}=fixture(t);await catalog.importRepository('owner/project');
  const before=catalog.snapshot(), previousKeys=[...secrets.keys()];
  catalog.credentialReader=async()=>{throw new Error('synthetic-private-token');};
  await assert.rejects(catalog.importRepository('owner/project'),error=>safe(error)&&!error.message.includes('synthetic-private-token'));
  assert.deepEqual(catalog.snapshot(),before);assert.equal(catalog.fault,false);
  catalog.credentialReader=async()=>JSON.stringify({username:'fixture',password:'next-canary'});
  catalog.persist=()=>{throw new Error('disk failure');};
  await assert.rejects(catalog.importRepository('owner/project'),{code:'GIT_CATALOG',message:'The Git catalog is unavailable. Saved data was preserved.'});
  // Conservative retention: neither the new nor the old ciphertext is removed on an ambiguous persist failure.
  assert.deepEqual(catalog.snapshot(),{repositories:[],fault:true,cleanupPending:false});
  assert.throws(()=>catalog.repositories,{code:'GIT_CATALOG'});
  assert.throws(()=>catalog.prepareSave({repository:'owner/other',username:'u',value:'v'}),{code:'GIT_CATALOG'});
  assert.throws(()=>catalog.prepareImport('owner/other'),{code:'GIT_CATALOG'});
  assert.throws(()=>catalog.prepareRemove(previousKeys[0]),{code:'GIT_CATALOG'});
  await assert.rejects(catalog.importRepository('owner/other'),{code:'GIT_CATALOG'});
  await assert.rejects(catalog.save({repository:'owner/other',username:'u',value:'v'}),{code:'GIT_CATALOG'});
  await assert.rejects(catalog.remove(previousKeys[0]),{code:'GIT_CATALOG'});
  // No helper lookup ran after the fault and no queued revalidation leaked past it.
  assert.deepEqual(lookups,['owner/project']);
  const newRef=[...secrets.keys()].find(ref=>!previousKeys.includes(ref));
  assert(newRef&&UUID_REF(newRef));assert(secrets.has(previousKeys[0]));assert.equal(secrets.size,2);
  assert(!fs.readFileSync(path.join(stateRoot,FILE),'utf8').includes('next-canary'));
  // A restart revalidates the still-valid disk metadata and leases resume.
  const restarted=new GitCatalog(options);
  assert.deepEqual(restarted.snapshot(),before);assert.equal(restarted.repositories.length,1);
});
const UUID_REF=ref=>/^git\/repository\/[0-9a-f-]{36}$/.test(ref);
test('writer failure after the atomic rename retains both refs and blocks leases until restart',async t=>{
  const {catalog,options,secrets,stateRoot}=fixture(t);await catalog.importRepository('owner/project');
  const oldRef=[...secrets.keys()][0], before=catalog.snapshot();
  const real=catalog.persist.bind(catalog);
  catalog.persist=repos=>{real(repos);throw new Error('directory fsync failed');};
  catalog.credentialReader=async()=>JSON.stringify({username:'fixture',password:'rotated-canary'});
  await assert.rejects(catalog.importRepository('owner/project'),{code:'GIT_CATALOG',message:'The Git catalog is unavailable. Saved data was preserved.'});
  assert.equal(catalog.fault,true);assert.deepEqual(catalog.snapshot(),{repositories:[],fault:true,cleanupPending:false});
  assert.throws(()=>catalog.repositories,{code:'GIT_CATALOG'});
  // The rename succeeded, so the disk now names the new ref; both ciphertexts remain.
  const published=metadata(stateRoot).repositories[0].credentialRef;
  assert.match(published,/^git\/repository\/[0-9a-f-]{36}$/);assert.notEqual(published,oldRef);
  assert(secrets.has(oldRef));assert(secrets.has(published));assert.equal(secrets.size,2);
  // Restart loads the published metadata; the orphaned old ciphertext is retained, not deleted.
  const restarted=new GitCatalog(options);
  assert.equal(restarted.snapshot().repositories[0].credentialAvailable,true);
  assert.equal(restarted.snapshot().repositories[0].id,before.repositories[0].id);
  assert(secrets.has(oldRef));
});
test('abort during helper lookup or encryption publishes no metadata and cleans the fresh ref',async t=>{
  const {catalog,secrets,lookups,stateRoot}=fixture(t);
  const realPut=catalog.vault.put.bind(catalog.vault);
  // Abort while the helper lookup is pending: the check after the await stops the task.
  const helper=new AbortController();
  catalog.credentialReader=async repo=>{lookups.push(repo);helper.abort();
    return JSON.stringify({username:'fixture',password:'never-published'});};
  await assert.rejects(catalog.importRepository('owner/project',{signal:helper.signal}),{name:'AbortError'});
  assert.deepEqual(lookups,['owner/project']);assert.equal(secrets.size,0);
  assert(!fs.existsSync(path.join(stateRoot,FILE)));
  // Abort during encryption: the unused fresh ref is retired, nothing is published.
  const encryption=new AbortController();
  catalog.vault.put=async(ref,value)=>{await realPut(ref,value);encryption.abort();};
  await assert.rejects(catalog.importRepository('owner/project',{signal:encryption.signal}),{name:'AbortError'});
  assert.equal(secrets.size,0);assert.equal(catalog.cleanupPending,false);
  assert(!fs.existsSync(path.join(stateRoot,FILE)));
  // Manual save aborts the same way before publication.
  const manual=new AbortController();
  catalog.vault.put=async(ref,value)=>{await realPut(ref,value);manual.abort();};
  await assert.rejects(catalog.save({repository:'owner/project',username:'octocat',value:'ghp_aborted'},{signal:manual.signal}),{name:'AbortError'});
  assert.equal(secrets.size,0);assert(!fs.existsSync(path.join(stateRoot,FILE)));
  // An abort whose cleanup fails flags the warning without publishing.
  const messy=new AbortController();
  catalog.vault.put=async(ref,value)=>{await realPut(ref,value);messy.abort();};
  catalog.vault.remove=async()=>{throw new Error('Keychain unavailable');};
  await assert.rejects(catalog.importRepository('owner/project',{signal:messy.signal}),{name:'AbortError'});
  assert.equal(catalog.cleanupPending,true);assert.equal(secrets.size,1);
  assert(!fs.existsSync(path.join(stateRoot,FILE)));
});
test('queued save captures its input before the caller can mutate it',async t=>{
  const {catalog,secrets,stateRoot}=fixture(t);
  let release;const gate=new Promise(resolve=>{release=resolve;});
  catalog.credentialReader=async()=>{await gate;return JSON.stringify({username:'fixture',password:'first-canary'});};
  const queued=catalog.importRepository('owner/first');
  const input={repository:'owner/second',username:'octocat',value:'ghp_captured'};
  const saved=catalog.save(input);
  input.repository='evil/repo';input.username='mallory';input.value='ghp_replaced';
  release();
  await queued;const snapshot=await saved;
  assert.deepEqual(snapshot.repositories.map(item=>item.repository),['owner/first','owner/second']);
  assert([...secrets.values()].includes(JSON.stringify({username:'octocat',password:'ghp_captured'})));
  assert(!JSON.stringify([...secrets.values()]).includes('ghp_replaced'));
  assert.deepEqual(metadata(stateRoot).repositories.map(item=>item.repository),['owner/first','owner/second']);
});
test('catalog mutations serialize and never interleave publication',async t=>{
  const {catalog,secrets}=fixture(t);
  let active=0,concurrent=0;
  const realPut=catalog.vault.put.bind(catalog.vault);
  catalog.vault.put=async(ref,value)=>{active++;concurrent=Math.max(concurrent,active);
    await new Promise(resolve=>setImmediate(resolve));await realPut(ref,value);active--;};
  const results=await Promise.all([
    catalog.save({repository:'owner/one',username:'a',value:'ghp_one'}),
    catalog.importRepository('owner/two'),
    catalog.save({repository:'owner/three',username:'c',value:'ghp_three'}),
  ]);
  assert.equal(concurrent,1);assert.equal(secrets.size,3);
  assert.deepEqual(results.at(-1).repositories.map(item=>item.repository),['owner/one','owner/two','owner/three']);
});
test('cleanup failure after publication is a warning, never a failed save or removal',async t=>{
  const {catalog,secrets}=fixture(t);
  await catalog.save({repository:'owner/project',username:'octocat',value:'ghp_first'});
  const first=catalog.snapshot().repositories[0];
  catalog.vault.remove=async()=>{throw new Error('Keychain unavailable');};
  const rotated=await catalog.save({repository:'owner/project',username:'octocat',value:'ghp_second'});
  assert.equal(rotated.repositories[0].id,first.id);assert.equal(rotated.cleanupPending,true);
  assert.equal(rotated.repositories[0].credentialAvailable,true);assert.equal(secrets.size,2);
  const removed=await catalog.remove(first.id);
  assert.equal(removed.repositories.length,0);assert.equal(removed.cleanupPending,true);
  assert.equal(catalog.fault,false);
});
test('the limit of 32 repositories is enforced for saves and imports',async t=>{
  const stateRoot=fs.mkdtempSync(path.join(os.tmpdir(),'git-catalog-'));
  t.after(()=>fs.rmSync(stateRoot,{recursive:true,force:true}));
  const entries=Array.from({length:32},(_,index)=>({id:crypto.randomUUID(),repository:`owner/repo${index}`,credentialRef:'git/repository/'+crypto.randomUUID()}));
  fs.writeFileSync(path.join(stateRoot,FILE),JSON.stringify({version:1,repositories:entries}));
  const full=new GitCatalog({stateRoot,vault:{has:()=>true,put:async()=>{},remove:async()=>{}},credentialReader:async()=>'{}'});
  assert.equal(full.snapshot().repositories.length,32);
  await assert.rejects(full.save({repository:'owner/extra',username:'u',value:'v'}),/limit of 32 repositories/);
  await assert.rejects(full.importRepository('owner/extra'),/limit of 32 repositories/);
  assert.throws(()=>full.prepareImport('owner/extra'),/limit of 32 repositories/);
  assert.throws(()=>full.prepareSave({repository:'owner/extra',username:'u',value:'v'}),/limit of 32 repositories/);
  // Replacing an existing repository stays allowed at the limit.
  assert.deepEqual(full.prepareImport('owner/repo0'),{repository:'owner/repo0'});
  assert.deepEqual(full.prepareSave({repository:'owner/repo0',username:'u',value:'v'}),{repository:'owner/repo0',username:'u',value:'v'});
});
test('malformed stored catalogs fail closed without resetting the file',async t=>{
  const stateRoot=fs.mkdtempSync(path.join(os.tmpdir(),'git-catalog-'));
  t.after(()=>fs.rmSync(stateRoot,{recursive:true,force:true}));
  const ref='git/repository/'+crypto.randomUUID();
  const cases=[
    '{not json',
    JSON.stringify({version:2,repositories:[]}),
    JSON.stringify({version:1,repositories:'nope'}),
    JSON.stringify({version:1,repositories:[{id:'not-a-uuid',repository:'owner/repo',credentialRef:ref}]}),
    JSON.stringify({version:1,repositories:[{id:crypto.randomUUID(),repository:'Owner/Repo',credentialRef:ref}]}),
    JSON.stringify({version:1,repositories:[{id:crypto.randomUUID(),repository:'owner/repo',credentialRef:'secrets/credential/'+crypto.randomUUID()}]}),
    JSON.stringify({version:1,repositories:[{id:crypto.randomUUID(),repository:'owner/repo',credentialRef:'git/repository/not-a-uuid'}]}),
    JSON.stringify({version:1,repositories:[{id:crypto.randomUUID(),repository:'owner/repo',credentialRef:ref},{id:crypto.randomUUID(),repository:'owner/repo',credentialRef:'git/repository/'+crypto.randomUUID()}]}),
    JSON.stringify({version:1,repositories:[{id:crypto.randomUUID(),repository:'owner/a',credentialRef:ref},{id:crypto.randomUUID(),repository:'owner/b',credentialRef:ref}]}),
    JSON.stringify({version:1,repositories:[{id:crypto.randomUUID(),repository:'owner/repo'}]}),
  ];
  for(const raw of cases){
    fs.writeFileSync(path.join(stateRoot,FILE),raw);
    assert.throws(()=>new GitCatalog({stateRoot,vault:{has:()=>false,put:async()=>{},remove:async()=>{}},credentialReader:async()=>'{}'}),
      {code:'GIT_CATALOG',message:'Invalid Git catalog. Saved data was preserved and will not be rewritten.'});
    assert.equal(fs.readFileSync(path.join(stateRoot,FILE),'utf8'),raw);
  }
});
test('a vault record that disappears shows unavailable without faulting',async t=>{
  const {catalog,secrets}=fixture(t);
  await catalog.save({repository:'owner/project',username:'octocat',value:'ghp_x'});
  const ref=[...secrets.keys()][0];secrets.delete(ref);
  const snapshot=catalog.snapshot();
  assert.equal(snapshot.repositories[0].credentialAvailable,false);
  assert.equal(snapshot.fault,false);
});