const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),yaml=require('js-yaml');
const {ModelCatalog}=require('../src/runtime/model-catalog.cjs');
const AUTHORIZATIONS={
 alpha:{endpoint:'https://models.example.test/v1',model:'example-model-a'},
 bravo:{endpoint:'http://localhost:8888/v1',model:'example-model-b'},
 charlie:{endpoint:'https://other.example.test/api/v1',model:'example-model-c'},
};
function fixture(t,{authorized=true}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'model-catalog-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const desktop=path.join(root,'dsh/profiles/desktop');fs.mkdirSync(desktop,{recursive:true});
 const providers=Object.fromEntries(Object.entries(AUTHORIZATIONS).map(([id,p])=>[id,{api:'openai-completions',baseURL:p.endpoint,apiKeyEnv:'ref-'+id,extraSecret:'must-not-copy',models:[{id:p.model,name:p.model,contextWindow:10000,maxTokens:1000,reasoningEfforts:{off:null,high:'high'},extraSecret:'must-not-copy'}]}]));
 const patches=[{id:'llm-pi-ai',config:{providers}},{id:'agent-default-model',config:{provider:'charlie',model:AUTHORIZATIONS['charlie'].model}}];
 const profile=path.join(desktop,'cordis.patch.yml');fs.writeFileSync(profile,yaml.dump(patches));
 fs.writeFileSync(path.join(root,'dsh/.credentials.yaml'),yaml.dump({refs:Object.fromEntries(Object.keys(AUTHORIZATIONS).map(id=>['ref-'+id,'canary-key-'+id]))}));
 const secrets=new Map(),vault={has:ref=>secrets.has(ref),putMany:async values=>{for(const [ref,value] of Object.entries(values))secrets.set(ref,value)}};
 const authorizationFile=path.join(root,'model-authorizations.json');
 if(authorized)fs.writeFileSync(authorizationFile,JSON.stringify({version:1,providers:AUTHORIZATIONS}));
 const catalog=new ModelCatalog({stateRoot:root,vault,dshRoot:path.join(root,'dsh')});
 return {root,profile,patches,providers,vault,secrets,catalog,authorizationFile};
}
test('imports exactly the authorized local catalog and stores credentials only in the host vault',async t=>{
 const f=fixture(t),before=fs.readFileSync(f.profile);const snapshot=await f.catalog.importDesktop();
 assert.equal(snapshot.providers.length,3);assert.equal(f.secrets.size,3);assert(snapshot.providers.every(p=>p.credentialAvailable));
 const saved=fs.readFileSync(f.catalog.file,'utf8'),publicValue=JSON.stringify(snapshot);
 for(const value of ['canary-key','must-not-copy','apiKeyEnv','ref-alpha']){assert(!saved.includes(value));assert(!publicValue.includes(value))}
 assert.deepEqual(fs.readFileSync(f.profile),before);assert.equal(fs.statSync(f.catalog.file).mode&0o777,0o600);
 const reopened=new ModelCatalog({stateRoot:f.root,vault:f.vault});assert.deepEqual(reopened.snapshot(),snapshot);
});
test('changed endpoint, missing reference or cloud fallback fails before importing any credential',async t=>{
 for(const mutation of [f=>f.providers.alpha.baseURL='https://paid.example.test/v1',f=>f.providers.charlie.apiKeyEnv='missing',f=>f.patches[1].config.provider='paid']){
  const f=fixture(t);mutation(f);fs.writeFileSync(f.profile,yaml.dump(f.patches));
  await assert.rejects(f.catalog.importDesktop());assert.equal(f.secrets.size,0);assert(!fs.existsSync(f.catalog.file));
 }
});
test('unknown desktop providers are not imported, while a failed vault write never publishes a usable catalog',async t=>{
 const f=fixture(t);f.providers.paid={api:'openai-completions',baseURL:'https://paid.example.test/v1',apiKeyEnv:'paid'};fs.writeFileSync(f.profile,yaml.dump(f.patches));
 f.vault.putMany=async()=>{throw new Error('vault unavailable')};await assert.rejects(f.catalog.importDesktop());
 assert.equal(f.catalog.snapshot().providers.length,0);assert(!fs.existsSync(f.catalog.file));
});
test('model probe uses fixed endpoints, rejects redirects and exposes status without upstream secret reflections',async t=>{
 const f=fixture(t);await f.catalog.importDesktop();f.vault.get=async()=> 'probe-canary-key';let calls=0;
 f.catalog.fetcher=async(url,options)=>{
  calls++;assert.equal(options.redirect,'manual');assert.equal(options.headers.Authorization,'Bearer probe-canary-key');
  assert(Object.values(AUTHORIZATIONS).some(p=>url===p.endpoint+'/models'));
  if(calls===1)return new Response(JSON.stringify({data:[{id:AUTHORIZATIONS.alpha.model},{id:'probe-canary-key'}]}),{status:200});
  if(calls===2)return new Response('probe-canary-key',{status:302,headers:{Location:'https://evil.example.test/probe-canary-key'}});
  return new Response(JSON.stringify({data:[{id:'other-loaded-model'}],secret:'probe-canary-key'}),{status:200});
 };
 const snapshot=await f.catalog.probe();assert.equal(calls,3);assert.deepEqual(snapshot.providers.map(p=>p.availability),['available','upstream-error','model-not-loaded']);
 assert(!JSON.stringify(snapshot).includes('probe-canary-key'));assert(!JSON.stringify(snapshot).includes('other-loaded-model'));
});

test('malformed YAML never sends parser snippets containing secrets to the caller',async t=>{
 for(const name of ['profile','credentials']){
  const f=fixture(t);const file=name==='profile'?f.profile:path.join(f.root,'dsh/.credentials.yaml');
  fs.writeFileSync(file,'refs: [secret-canary-value: [broken');
  await assert.rejects(f.catalog.importDesktop(),error=>!error.message.includes('secret-canary')&&!error.message.includes('broken')&&!error.mark&&!error.cause);
  assert.equal(f.secrets.size,0);
 }
});

test('a clean catalog requires authorization before reading any desktop configuration or credentials',async t=>{
 const f=fixture(t,{authorized:false});assert.deepEqual(f.catalog.snapshot(),{selected:null,providers:[]});
 const read=fs.readFileSync,reads=[];
 t.mock.method(fs,'readFileSync',function(file,...args){reads.push(file);return read.call(this,file,...args)});
 await assert.rejects(f.catalog.importDesktop(),{message:'Configure model-authorizations.json before importing desktop models.'});
 assert.deepEqual(reads,[]);assert.equal(f.secrets.size,0);assert(!fs.existsSync(f.catalog.file));
});

test('an explicit file imports only its exact provider, endpoint and model grants',async t=>{
 const f=fixture(t);
 fs.writeFileSync(f.authorizationFile,JSON.stringify({version:1,providers:{charlie:AUTHORIZATIONS.charlie}}));
 f.providers.charlie.models.push({id:'unapproved-model',contextWindow:10000,maxTokens:1000});
 fs.writeFileSync(f.profile,yaml.dump(f.patches));
 const catalog=new ModelCatalog({stateRoot:f.root,vault:f.vault,dshRoot:path.join(f.root,'dsh')});
 const snapshot=await catalog.importDesktop();
 assert.deepEqual(snapshot.providers.map(p=>p.id),['charlie']);
 assert.deepEqual(snapshot.providers[0].models.map(m=>m.id),[AUTHORIZATIONS.charlie.model]);
 assert.deepEqual([...f.secrets.keys()],['model/provider/charlie']);
 f.providers.charlie.models[0].id='unapproved-model';fs.writeFileSync(f.profile,yaml.dump(f.patches));
 const before=fs.readFileSync(catalog.file);let writes=0;f.vault.putMany=async()=>{writes++};
 await assert.rejects(catalog.importDesktop());assert.equal(writes,0);assert.deepEqual(fs.readFileSync(catalog.file),before);
});

test('legacy host catalogs reopen without a file and never authorize a new desktop provider',async t=>{
 const f=fixture(t);const original=await f.catalog.importDesktop(),saved=fs.readFileSync(f.catalog.file);
 fs.unlinkSync(f.authorizationFile);
 f.providers.newcomer={...f.providers.alpha,baseURL:'https://new.example.test/v1',apiKeyEnv:'new-reference'};
 fs.writeFileSync(f.profile,yaml.dump(f.patches));
 const catalog=new ModelCatalog({stateRoot:f.root,vault:f.vault,dshRoot:path.join(f.root,'dsh')});
 assert.deepEqual(catalog.snapshot(),original);assert.deepEqual(fs.readFileSync(catalog.file),saved);
 assert.deepEqual(await catalog.importDesktop(),original);assert.equal(f.secrets.size,3);
 f.patches[1].config={provider:'newcomer',model:AUTHORIZATIONS.alpha.model};fs.writeFileSync(f.profile,yaml.dump(f.patches));
 let writes=0;f.vault.putMany=async()=>{writes++};
 await assert.rejects(catalog.importDesktop(),{message:'The default model is not authorized.'});assert.equal(writes,0);
 assert.deepEqual(fs.readFileSync(catalog.file),saved);
});

test('invalid authorization never falls back to an otherwise valid saved host catalog',async t=>{
 const f=fixture(t);await f.catalog.importDesktop();const saved=fs.readFileSync(f.catalog.file);
 for(const invalid of ['{"secret-canary": [broken',JSON.stringify({version:2,providers:AUTHORIZATIONS}), 'null']){
  fs.writeFileSync(f.authorizationFile,invalid);
  assert.throws(()=>new ModelCatalog({stateRoot:f.root,vault:f.vault}),error=>
   error.message==='Invalid model authorization.'&&!error.cause&&!error.mark);
  assert.deepEqual(fs.readFileSync(f.catalog.file),saved);
 }
});

test('explicit authorization takes precedence and incompatible saved catalogs are never rewritten',async t=>{
 const f=fixture(t);await f.catalog.importDesktop();const original=JSON.parse(fs.readFileSync(f.catalog.file));
 for(const providers of [{}, {alpha:AUTHORIZATIONS.alpha}, {...AUTHORIZATIONS,alpha:{...AUTHORIZATIONS.alpha,endpoint:'https://changed.example.test/v1'}},
  {...AUTHORIZATIONS,alpha:{...AUTHORIZATIONS.alpha,model:'changed-model'}}]){
  fs.writeFileSync(f.authorizationFile,JSON.stringify({version:1,providers}));
  const before=fs.readFileSync(f.catalog.file);
  assert.throws(()=>new ModelCatalog({stateRoot:f.root,vault:f.vault}),{message:'Invalid saved catalog.'});
  assert.deepEqual(fs.readFileSync(f.catalog.file),before);
 }
 fs.unlinkSync(f.authorizationFile);
 for(const mutate of [s=>s.providers[0].models.push({...s.providers[0].models[0]}),s=>s.providers.push(s.providers[0]),
  s=>s.providers[0].models[0].maxTokens=Infinity,s=>s.providers[0].baseURL='https://user:secret-canary@example.test/v1',
  s=>s.providers[0].id='constructor',s=>s.providers[0].credentialRef='other-reference']){
  const stored=structuredClone(original);mutate(stored);fs.writeFileSync(f.catalog.file,JSON.stringify(stored));
  const before=fs.readFileSync(f.catalog.file);
  assert.throws(()=>new ModelCatalog({stateRoot:f.root,vault:f.vault}),{message:'Invalid saved catalog.'});
  assert.deepEqual(fs.readFileSync(f.catalog.file),before);
 }
 fs.writeFileSync(f.catalog.file,'{"secret-canary": [broken');
 assert.throws(()=>new ModelCatalog({stateRoot:f.root,vault:f.vault}),{message:'Invalid saved catalog.'});
});

test('authorization validates bounded metadata, safe provider ids and HTTP v1 endpoints with fixed errors',t=>{
 const f=fixture(t);
 const invalidEndpoints=['ftp://models.example.test/v1','https://user:secret-canary@models.example.test/v1',
  'https://@models.example.test/v1','https://models.example.test/v1?secret-canary=value','https://models.example.test/v1?',
  'https://models.example.test/v1#secret-canary','https://models.example.test/v1#','https://models.example.test/other',
  'https://models.example.test/v1\n',' https://models.example.test/v1','https://models.example.test/'+ 'x'.repeat(2048)+'/v1',null,42];
 const invalidProviders=[...invalidEndpoints.map(endpoint=>({alpha:{endpoint,model:'example-model'}})),
  ...['__proto__','constructor','prototype','*','bad/id','x'.repeat(65),''].map(id=>Object.fromEntries([[id,AUTHORIZATIONS.alpha]])),
  ...['','x'.repeat(257),'secret-canary\n',null,42].map(model=>({alpha:{...AUTHORIZATIONS.alpha,model}})),
  {alpha:{...AUTHORIZATIONS.alpha,extra:'secret-canary'}},{alpha:null},[],null,
  Object.fromEntries(Array.from({length:33},(_,i)=>['provider'+i,AUTHORIZATIONS.alpha]))];
 for(const providers of invalidProviders){
  fs.writeFileSync(f.authorizationFile,JSON.stringify({version:1,providers}));
  assert.throws(()=>new ModelCatalog({stateRoot:f.root,vault:f.vault}),error=>
   error.message==='Invalid model authorization.'&&!error.cause&&!error.mark);
 }
 for(const invalid of [{version:1,providers:{},extra:'secret-canary'},{providers:{}},[],null]){
  fs.writeFileSync(f.authorizationFile,JSON.stringify(invalid));
  assert.throws(()=>new ModelCatalog({stateRoot:f.root,vault:f.vault}),{message:'Invalid model authorization.'});
 }
 const providers=Object.fromEntries(Array.from({length:32},(_,i)=>['provider'+i,AUTHORIZATIONS.alpha]));
 fs.writeFileSync(f.authorizationFile,JSON.stringify({version:1,providers}));
 assert.deepEqual(new ModelCatalog({stateRoot:f.root,vault:f.vault}).snapshot().providers,[]);
});

test('authorization and imported endpoints are canonical without trailing slashes',async t=>{
 const f=fixture(t);
 fs.writeFileSync(f.authorizationFile,JSON.stringify({version:1,providers:{charlie:{...AUTHORIZATIONS.charlie,endpoint:AUTHORIZATIONS.charlie.endpoint+'/'}}}));
 f.providers.charlie.baseURL+='/';fs.writeFileSync(f.profile,yaml.dump(f.patches));
 const catalog=new ModelCatalog({stateRoot:f.root,vault:f.vault,dshRoot:path.join(f.root,'dsh')});
 const snapshot=await catalog.importDesktop();assert.equal(snapshot.providers[0].baseURL,AUTHORIZATIONS.charlie.endpoint);
 const saved=fs.readFileSync(catalog.file);fs.unlinkSync(f.authorizationFile);
 assert.deepEqual(new ModelCatalog({stateRoot:f.root,vault:f.vault}).snapshot(),snapshot);
 assert.deepEqual(fs.readFileSync(catalog.file),saved);
});

test('an explicitly empty authorization also requires configuration before import',async t=>{
 const f=fixture(t);fs.writeFileSync(f.authorizationFile,JSON.stringify({version:1,providers:{}}));
 const catalog=new ModelCatalog({stateRoot:f.root,vault:f.vault,dshRoot:path.join(f.root,'missing-dsh')});
 await assert.rejects(catalog.importDesktop(),{message:'Configure model-authorizations.json before importing desktop models.'});
 assert.equal(f.secrets.size,0);
});

test('invalid model metadata fails before any credential read or vault batch',async t=>{
 const cases=[
  [f=>f.providers.charlie.models[0].contextWindow=Infinity,'Invalid model definition.'],
  [f=>f.providers.charlie.models[0].maxTokens=10001,'Invalid model definition.'],
  [f=>f.providers.charlie.models[0].name='secret-canary\n','Invalid model definition.'],
  [f=>f.providers.charlie.models[0].input=['secret-canary'],'Invalid model input modes.'],
  [f=>f.providers.charlie.models[0].reasoningEfforts={high:'x'.repeat(65)},'Invalid reasoning settings.'],
  [f=>f.providers.charlie.models[0].reasoningEfforts={unknown:'secret-canary'},'Invalid reasoning settings.'],
  [f=>f.providers.charlie.displayName='x'.repeat(201),'The model catalog is incomplete.'],
  [f=>f.providers.charlie.models.push({...f.providers.charlie.models[0]}),'The model catalog is incomplete.'],
 ];
 for(const [mutate,message] of cases){
  const f=fixture(t);mutate(f);fs.writeFileSync(f.profile,yaml.dump(f.patches));
  fs.writeFileSync(path.join(f.root,'dsh/.credentials.yaml'),'refs: [secret-canary: [broken');
  let writes=0;f.vault.putMany=async()=>{writes++};
  await assert.rejects(f.catalog.importDesktop(),{message});assert.equal(writes,0);assert(!fs.existsSync(f.catalog.file));
 }
});

test('all credentials are validated and submitted in one vault batch before catalog publication',async t=>{
 const f=fixture(t),put=f.vault.putMany;let writes=0;
 f.vault.putMany=async values=>{
  writes++;assert(!fs.existsSync(f.catalog.file));assert.equal(f.catalog.snapshot().providers.length,0);
  assert.deepEqual(values,Object.fromEntries(Object.keys(AUTHORIZATIONS).map(id=>['model/provider/'+id,'canary-key-'+id])));
  await put(values);
 };
 await f.catalog.importDesktop();assert.equal(writes,1);assert.equal(f.catalog.snapshot().providers.length,3);
});

test('authorization rejects provider IDs unsupported by the credential bridge before importing credentials',async t=>{
 for(const id of ['local_model','LocalModel','UPPERCASE']){
  const f=fixture(t);
  fs.writeFileSync(f.authorizationFile,JSON.stringify({version:1,providers:{[id]:AUTHORIZATIONS.charlie}}));
  assert.throws(()=>new ModelCatalog({stateRoot:f.root,vault:f.vault,dshRoot:path.join(f.root,'dsh')}),/Invalid model authorization/);
  assert.equal(f.secrets.size,0);assert(!fs.existsSync(f.catalog.file));
 }
});
