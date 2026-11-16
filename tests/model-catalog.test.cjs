const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),yaml=require('js-yaml');
const {ModelCatalog}=require('../src/runtime/model-catalog.cjs');

const DESKTOP={
 alpha:{api:'openai-completions',baseURL:'https://models.example.test/v1',apiKeyEnv:'ref-alpha',displayName:'Alpha',extra:'must-not-copy',models:[
  {id:'example-model-a',name:'Example A',contextWindow:10000,maxTokens:1000,reasoningEfforts:{off:null,high:'high'},extra:'must-not-copy'},
  {id:'example-model-b',name:'Example B',contextWindow:20000,maxTokens:2000,input:['text','image'],extra:'must-not-copy'}]},
 bravo:{api:'openai-completions',baseURL:'http://localhost:8888/v1/',apiKeyEnv:'ref-bravo',models:[{id:'example-model-b',name:'Example B',contextWindow:10000,maxTokens:1000}]},
 charlie:{api:'openai-completions',baseURL:'https://other.example.test/api/v1',apiKeyEnv:'ref-charlie',models:[{id:'example-model-c',name:'Example C',contextWindow:5000,maxTokens:500}]},
 local:{api:'openai-completions',baseURL:'https://local.example.test/gateway',models:[{id:'local-model',name:'Local',contextWindow:8000,maxTokens:800}]},
};
const DSH_DEFAULT={provider:'charlie',model:'example-model-c'};
const MODEL_A={id:'example-model-a',name:'Example A',contextWindow:10000,maxTokens:1000};

function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'model-catalog-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const desktop=path.join(root,'dsh/profiles/desktop');fs.mkdirSync(desktop,{recursive:true});
 const patches=[{id:'llm-pi-ai',config:{providers:structuredClone(DESKTOP)}},{id:'agent-default-model',config:structuredClone(DSH_DEFAULT)}];
 const profile=path.join(desktop,'cordis.patch.yml');fs.writeFileSync(profile,yaml.dump(patches));
 fs.writeFileSync(path.join(root,'dsh/.credentials.yaml'),yaml.dump({refs:{'ref-alpha':'canary-key-alpha','ref-bravo':'canary-key-bravo','ref-charlie':'canary-key-charlie'}}));
 const secrets=new Map();
 const vault={
  has:ref=>secrets.has(ref),get:async ref=>secrets.get(ref),put:async(ref,value)=>{secrets.set(ref,value)},
  putMany:async values=>{for(const [ref,value] of Object.entries(values))secrets.set(ref,value)},remove:async ref=>{secrets.delete(ref)},
 };
 const catalog=new ModelCatalog({stateRoot:root,vault,dshRoot:path.join(root,'dsh')});
 return {root,desktop,profile,patches,vault,secrets,catalog};
}

function manualSave(catalog,{id='manual',displayName='Manual',baseURL='https://manual.example.test/gateway',authMode='none',models=[{id:'manual-model',name:'Manual Model',contextWindow:4096,maxTokens:1024}],value}={}){
 return catalog.save({id,displayName,api:'openai-completions',baseURL,authMode,models,...(value===undefined?{}:{value})});
}

// A hand-crafted v1 catalog written by the former implementation.
function legacyFixture(t){
 const f=fixture(t);
 fs.writeFileSync(f.catalog.file,JSON.stringify({version:1,providers:[{id:'alpha',displayName:'Alpha',api:'openai-completions',baseURL:DESKTOP.alpha.baseURL,models:[MODEL_A],credentialRef:'model/provider/alpha'}],selected:{provider:'alpha',model:'example-model-a'}}));
 return f;
}

test('explicit UI import brings every DSH provider and model, selects the DSH default and keeps values host-only',async t=>{
 const f=fixture(t),profile=fs.readFileSync(f.profile);
 const snapshot=await f.catalog.importDesktop();
 assert.deepEqual(snapshot.providers.map(p=>p.id),['alpha','bravo','charlie','local']);
 assert.deepEqual(snapshot.providers[0].models.map(m=>m.id),['example-model-a','example-model-b']);
 assert.equal(snapshot.providers[1].baseURL,'http://localhost:8888/v1');
 assert.deepEqual(snapshot.providers.map(p=>p.authMode),['bearer','bearer','bearer','none']);
 assert.deepEqual(snapshot.selected,{provider:'charlie',model:'example-model-c'});
 assert(snapshot.providers.slice(0,3).every(p=>p.credentialAvailable));
 assert.equal(snapshot.providers[3].credentialAvailable,false);
 const saved=fs.readFileSync(f.catalog.file,'utf8'),publicValue=JSON.stringify(snapshot);
 for(const token of ['canary-key','must-not-copy','apiKeyEnv','ref-alpha']){
  assert(!saved.includes(token));assert(!publicValue.includes(token));
 }
 assert(!publicValue.includes('credentialRef'));
 const refs=[...f.secrets.keys()];
 assert.equal(refs.length,3);assert(refs.every(ref=>/^model\/credential\/[0-9a-f-]{36}$/.test(ref)));
 assert.deepEqual(fs.readFileSync(f.profile),profile);
 assert.equal(fs.statSync(f.catalog.file).mode&0o777,0o600);
 const reopened=new ModelCatalog({stateRoot:f.root,vault:f.vault});
 assert.deepEqual(reopened.snapshot(),snapshot);
});

test('import merges matching IDs, retains unrelated saved providers and preserves the current selection',async t=>{
 const f=fixture(t);
 await manualSave(f.catalog);
 await f.catalog.save({id:'alpha',displayName:'Custom Alpha',api:'openai-completions',baseURL:DESKTOP.alpha.baseURL,authMode:'none',models:[MODEL_A]});
 const snapshot=await f.catalog.importDesktop();
 assert.deepEqual(snapshot.providers.map(p=>p.id),['manual','alpha','bravo','charlie','local']);
 assert.deepEqual(snapshot.selected,{provider:'manual',model:'manual-model'});
 const alpha=snapshot.providers.find(p=>p.id==='alpha');
 assert.equal(alpha.displayName,'Alpha');assert.equal(alpha.authMode,'bearer');
 assert.deepEqual(alpha.models.map(m=>m.id),['example-model-a','example-model-b']);
 assert.equal(f.secrets.size,3);
});

test('manual CRUD, selection guards and the first-save default',async t=>{
 const f=fixture(t);
 assert.deepEqual(f.catalog.snapshot(),{selected:null,providers:[],fault:false,cleanupPending:false});
 let snap=await f.catalog.save({id:'first',displayName:'First',api:'openai-completions',baseURL:'https://first.example.test/api',authMode:'none',models:[
  {id:'m1',name:'M1',contextWindow:100,maxTokens:10},{id:'m2',name:'M2',contextWindow:200,maxTokens:20}]});
 assert.deepEqual(snap.selected,{provider:'first',model:'m1'});
 snap=await manualSave(f.catalog,{id:'second',displayName:'Second',baseURL:'https://second.example.test/'});
 assert.equal(snap.providers[1].baseURL,'https://second.example.test');
 assert.deepEqual(snap.selected,{provider:'first',model:'m1'});
 snap=await f.catalog.select({provider:'second',model:'manual-model'});
 assert.deepEqual(snap.selected,{provider:'second',model:'manual-model'});
 await assert.rejects(f.catalog.select({provider:'second',model:'nope'}),{message:'Unknown model.'});
 snap=await manualSave(f.catalog,{id:'second',displayName:'Second updated'});
 assert.equal(snap.providers.find(p=>p.id==='second').displayName,'Second updated');
 await assert.rejects(f.catalog.save({id:'second',displayName:'Second',api:'openai-completions',baseURL:'https://second.example.test',authMode:'none',models:[{id:'m4',name:'M4',contextWindow:100,maxTokens:10}]}),
  {message:'Choose another default model first, then save this provider.'});
 snap=await f.catalog.remove('first');
 assert.deepEqual(snap.providers.map(p=>p.id),['second']);
 assert.deepEqual(snap.selected,{provider:'second',model:'manual-model'});
 await manualSave(f.catalog,{id:'third'});
 await assert.rejects(f.catalog.remove('second'),{message:'Choose another model first, then remove this provider.'});
 await f.catalog.remove('third');
 snap=await f.catalog.remove('second');
 assert.deepEqual(snap,{selected:null,providers:[],fault:false,cleanupPending:false});
 await assert.rejects(f.catalog.select({provider:'nope',model:'m1'}),{message:'Unknown model provider.'});
 await assert.rejects(f.catalog.remove('nope'),{message:'Unknown model provider.'});
});

test('manual save validates ids, model bounds and provider limits with fixed errors',async t=>{
 const f=fixture(t);
 const base={displayName:'X',api:'openai-completions',baseURL:'https://x.example.test/v1',authMode:'none',models:[{id:'m',name:'M',contextWindow:100,maxTokens:10}]};
 for(const badId of ['__proto__','constructor','prototype','Upper','bad/id','x'.repeat(65),'',null,42]){
  await assert.rejects(f.catalog.save({...base,id:badId}),{message:'Enter a unique provider ID.'});
 }
 await assert.rejects(f.catalog.save({...base,id:'a',models:[]}),{message:'Enter between 1 and 64 models.'});
 await assert.rejects(f.catalog.save({...base,id:'a',models:Array.from({length:65},(_,i)=>({id:'m'+i,name:'M'+i,contextWindow:100,maxTokens:10}))}),{message:'Enter between 1 and 64 models.'});
 await assert.rejects(f.catalog.save({...base,id:'a',models:[{...base.models[0]},{...base.models[0]}]}),{message:'Invalid model definition.'});
 await assert.rejects(f.catalog.save({...base,id:'a',models:[{id:'m',name:'M',contextWindow:Infinity,maxTokens:10}]}),{message:'Invalid model definition.'});
 await assert.rejects(f.catalog.save({...base,id:'a',models:[{id:'m',name:'M',contextWindow:100,maxTokens:101}]}),{message:'Invalid model definition.'});
 await assert.rejects(f.catalog.save({...base,id:'a',models:[{id:'m',name:'M',contextWindow:100,maxTokens:10,input:['video']}]}),{message:'Invalid model input modes.'});
 await assert.rejects(f.catalog.save({...base,id:'a',models:[{id:'m',name:'M',contextWindow:100,maxTokens:10,reasoningEfforts:{huge:'x'.repeat(65)}}]}),{message:'Invalid reasoning settings.'});
 await assert.rejects(f.catalog.save({...base,id:'a',api:'anthropic'}),{message:'Unsupported provider API.'});
 await assert.rejects(f.catalog.save({...base,id:'a',authMode:'cookie'}),{message:'Invalid provider auth mode.'});
 await assert.rejects(f.catalog.save({...base,id:'a',displayName:'x'.repeat(201)}),{message:'Enter a provider display name.'});
 for(let i=0;i<32;i++)await manualSave(f.catalog,{id:'p'+i});
 await assert.rejects(f.catalog.save({...base,id:'overflow'}),{message:'The limit of 32 providers has been reached.'});
});

test('bearer keys are retained only at the same canonical endpoint while present',async t=>{
 const f=fixture(t);
 const base={id:'openai',displayName:'OpenAI',api:'openai-completions',baseURL:'https://api.example.test/v1',authMode:'bearer',models:[{id:'gpt',name:'GPT',contextWindow:10000,maxTokens:1000}]};
 let snap=await f.catalog.save({...base,value:'key-one'});
 const firstRef=[...f.secrets.keys()][0];
 snap=await f.catalog.save(base);
 assert.equal(f.secrets.size,1);assert(f.secrets.has(firstRef));assert.equal(snap.providers[0].credentialAvailable,true);
 await assert.rejects(f.catalog.save({...base,baseURL:'https://api.example.test/other'}),{message:'Enter an API key for this endpoint.'});
 await assert.rejects(f.catalog.save({...base,baseURL:'https://api.example.test/v1beta'}),{message:'Enter an API key for this endpoint.'});
 snap=await f.catalog.save({...base,value:'key-two'});
 assert.equal(f.secrets.size,1);assert(!f.secrets.has(firstRef));
 const saved=JSON.parse(fs.readFileSync(f.catalog.file));
 assert(/^model\/credential\/[0-9a-f-]{36}$/.test(saved.providers[0].credentialRef));
 f.secrets.clear();
 await assert.rejects(f.catalog.save(base),{message:'Enter an API key for this endpoint.'});
});

test('none mode rejects keys and bearer switches require or drop values',async t=>{
 const f=fixture(t);
 const base={id:'x',displayName:'X',api:'openai-completions',baseURL:'https://x.example.test/v1',models:[{id:'m',name:'M',contextWindow:100,maxTokens:10}]};
 await assert.rejects(f.catalog.save({...base,authMode:'none',value:'key-x'}),{message:'This endpoint does not use an API key.'});
 await f.catalog.save({...base,authMode:'none'});
 await assert.rejects(f.catalog.save({...base,authMode:'bearer'}),{message:'Enter an API key for this endpoint.'});
 let snap=await f.catalog.save({...base,authMode:'bearer',value:'key-x'});
 assert.equal(snap.providers[0].authMode,'bearer');assert.equal(f.secrets.size,1);
 await assert.rejects(f.catalog.save({...base,authMode:'none',value:'key-x'}),{message:'This endpoint does not use an API key.'});
 snap=await f.catalog.save({...base,authMode:'none'});
 assert.equal(snap.providers[0].authMode,'none');assert.equal(snap.providers[0].credentialAvailable,false);
 assert.equal(f.secrets.size,0);
});

test('probe is bounded, redirect-free, supports none mode without vault access and never echoes payloads',async t=>{
 const f=fixture(t);await f.catalog.importDesktop();
 let vaultReads=0;const originalGet=f.vault.get;f.vault.get=async ref=>{vaultReads++;return originalGet(ref)};
 let calls=0,noneCalls=0,authCalls=0;
 f.catalog.fetcher=async(url,options)=>{
  calls++;
  assert.equal(options.redirect,'manual');
  if(options.headers.Authorization)authCalls++;else noneCalls++;
  if(url==='https://models.example.test/v1/models')return new Response(JSON.stringify({data:[{id:'example-model-a'},{id:'example-model-b'},{id:'secret-canary'}]}),{status:200});
  if(url==='http://localhost:8888/v1/models')return new Response('secret-canary',{status:302,headers:{Location:'https://evil.example.test/secret-canary'}});
  if(url==='https://other.example.test/api/v1/models')return new Response(JSON.stringify({data:[{id:'other-loaded-model'}],secret:'secret-canary'}),{status:200});
  assert.equal(url,'https://local.example.test/gateway/models');assert(!options.headers.Authorization);
  return new Response(JSON.stringify({data:[{id:'local-model'}]}),{status:200});
 };
 const snapshot=await f.catalog.probe();
 assert.equal(calls,4);assert.equal(vaultReads,3);assert.equal(authCalls,3);assert.equal(noneCalls,1);
 assert.deepEqual(snapshot.providers.map(p=>p.availability),['available','upstream-error','model-not-loaded','available']);
 assert(!JSON.stringify(snapshot).includes('secret-canary'));assert(!JSON.stringify(snapshot).includes('other-loaded-model'));
});

test('probe reports missing credentials and vault unavailability without throwing',async t=>{
 const f=fixture(t);
 await f.catalog.save({id:'x',displayName:'X',api:'openai-completions',baseURL:'https://x.example.test/v1',authMode:'bearer',models:[{id:'m',name:'M',contextWindow:100,maxTokens:10}],value:'key-x'});
 f.secrets.clear();
 let snap=await f.catalog.probe();
 assert.equal(snap.providers[0].availability,'missing-credential');
 const originalGet=f.vault.get;f.vault.get=async()=>{throw Object.assign(new Error('vault unavailable'),{code:'VAULT_UNAVAILABLE'})};
 snap=await f.catalog.probe();
 assert.equal(snap.providers[0].availability,'vault-unavailable');
 f.vault.get=originalGet;
});

test('credential batch failure publishes nothing and leaves the vault untouched',async t=>{
 const f=fixture(t);
 f.vault.putMany=async()=>{throw new Error('keychain exploded')};
 await assert.rejects(f.catalog.importDesktop(),error=>error.code==='MODEL_CATALOG'&&error.message==='The imported API keys could not be encrypted. Check Keychain availability.');
 assert.equal(f.secrets.size,0);assert.equal(f.catalog.snapshot().providers.length,0);assert(!fs.existsSync(f.catalog.file));
});

test('cancellation before or after the vault write prevents publication and cleans fresh keys best effort',async t=>{
 const f=fixture(t);
 const controller=new AbortController();controller.abort();
 await assert.rejects(f.catalog.importDesktop({signal:controller.signal}));
 assert.equal(f.secrets.size,0);assert(!fs.existsSync(f.catalog.file));
 const g=fixture(t);
 const after=new AbortController();
 g.vault.putMany=async values=>{for(const [ref,value] of Object.entries(values))g.secrets.set(ref,value);after.abort()};
 await assert.rejects(g.catalog.importDesktop({signal:after.signal}));
 assert.equal(g.secrets.size,0);assert(!fs.existsSync(g.catalog.file));
 const h=fixture(t);
 const saveAbort=new AbortController();
 h.vault.put=async(ref,value)=>{h.secrets.set(ref,value);saveAbort.abort()};
 await assert.rejects(h.catalog.save({id:'x',displayName:'X',api:'openai-completions',baseURL:'https://x.example.test/v1',authMode:'bearer',models:[{id:'m',name:'M',contextWindow:100,maxTokens:10}],value:'key-x'},{signal:saveAbort.signal}));
 assert.equal(h.secrets.size,0);assert(!fs.existsSync(h.catalog.file));assert.equal(h.catalog.snapshot().providers.length,0);
});

test('metadata publication failure marks fault, retains all ciphertext, blocks leases and restart revalidates disk',async t=>{
 const f=fixture(t);
 await f.catalog.save({id:'alpha',displayName:'Alpha',api:'openai-completions',baseURL:DESKTOP.alpha.baseURL,authMode:'bearer',models:[MODEL_A],value:'key-old'});
 const before=JSON.parse(fs.readFileSync(f.catalog.file));
 fs.chmodSync(f.root,0o500);
 try{
  await assert.rejects(f.catalog.save({id:'alpha',displayName:'Alpha',api:'openai-completions',baseURL:DESKTOP.alpha.baseURL,authMode:'bearer',models:[MODEL_A],value:'key-new'}),{message:'The model catalog is unavailable. Saved data was preserved.'});
 }finally{fs.chmodSync(f.root,0o700)}
 const state=f.catalog.snapshot();
 assert.equal(state.fault,true);assert.equal(state.cleanupPending,false);assert.equal(state.providers.length,0);assert.equal(state.selected,null);
 assert.equal(f.secrets.size,2);
 assert.throws(()=>f.catalog.providers,{message:'The model catalog is unavailable. Saved data was preserved.'});
 await assert.rejects(f.catalog.save({id:'alpha',displayName:'Alpha',api:'openai-completions',baseURL:DESKTOP.alpha.baseURL,authMode:'bearer',models:[MODEL_A],value:'key-three'}),{message:'The model catalog is unavailable. Saved data was preserved.'});
 await assert.rejects(f.catalog.remove('alpha'),{message:'The model catalog is unavailable. Saved data was preserved.'});
 assert.throws(()=>f.catalog.prepareSave({id:'other',displayName:'O',api:'openai-completions',baseURL:'https://o.example.test/v1',authMode:'none',models:[{id:'m',name:'M',contextWindow:1,maxTokens:1}]}),{message:'The model catalog is unavailable. Saved data was preserved.'});
 await assert.rejects(f.catalog.importDesktop(),{message:'The model catalog is unavailable. Saved data was preserved.'});
 assert.deepEqual(JSON.parse(fs.readFileSync(f.catalog.file)),before);
 const reopened=new ModelCatalog({stateRoot:f.root,vault:f.vault});
 assert.equal(reopened.snapshot().fault,false);
 assert.equal(reopened.snapshot().providers.length,1);
 assert.equal(reopened.snapshot().providers[0].credentialAvailable,true);
 assert.deepEqual(reopened.snapshot().selected,{provider:'alpha',model:'example-model-a'});
});

test('cleanup failure is a warning after a successful publication, not a failed save',async t=>{
 const f=fixture(t);
 const base={id:'x',displayName:'X',api:'openai-completions',baseURL:'https://x.example.test/v1',authMode:'bearer',models:[{id:'m',name:'M',contextWindow:100,maxTokens:10}]};
 await f.catalog.save({...base,value:'key-one'});
 const firstRef=[...f.secrets.keys()][0];
 const remove=f.vault.remove;f.vault.remove=async ref=>{if(ref===firstRef)throw new Error('remove failed');return remove(ref)};
 const snapshot=await f.catalog.save({...base,value:'key-two'});
 assert.equal(snapshot.cleanupPending,true);assert.equal(snapshot.fault,false);
 assert.equal(f.secrets.size,2);
 assert.equal(f.catalog.snapshot().providers.length,1);
});

test('malformed YAML never surfaces parser snippets or secrets',async t=>{
 for(const name of ['profile','credentials']){
  const f=fixture(t);
  const file=name==='profile'?f.profile:path.join(f.root,'dsh/.credentials.yaml');
  fs.writeFileSync(file,'refs: [secret-canary-value: [broken');
  await assert.rejects(f.catalog.importDesktop(),error=>error.code==='MODEL_CATALOG'&&!error.message.includes('secret-canary')&&!error.message.includes('broken')&&!error.mark&&!error.cause);
  assert.equal(f.secrets.size,0);assert(!fs.existsSync(f.catalog.file));
 }
});

test('import rejects unsupported APIs, missing or unavailable references atomically and never downgrades',async t=>{
 const cases=[
  f=>{f.patches[0].config.providers.bravo.api='anthropic'},
  f=>{f.patches[0].config.providers.bravo.apiKeyEnv=''},
  f=>{delete f.patches[0].config.providers.charlie.models},
 ];
 for(const mutate of cases){
  const f=fixture(t);mutate(f);fs.writeFileSync(f.profile,yaml.dump(f.patches));
  await assert.rejects(f.catalog.importDesktop());
  assert.equal(f.secrets.size,0);assert(!fs.existsSync(f.catalog.file));
 }
 const f=fixture(t);
 fs.writeFileSync(path.join(f.root,'dsh/.credentials.yaml'),yaml.dump({refs:{'ref-bravo':'x','ref-charlie':'y'}}));
 await assert.rejects(f.catalog.importDesktop(),{message:'A desktop provider credential is unavailable.'});
 assert.equal(f.secrets.size,0);assert(!fs.existsSync(f.catalog.file));
 const g=fixture(t);
 fs.writeFileSync(path.join(g.root,'dsh/.credentials.yaml'),yaml.dump({refs:{'ref-alpha':'','ref-bravo':'x','ref-charlie':'y'}}));
 await assert.rejects(g.catalog.importDesktop(),{message:'A desktop provider credential is unavailable.'});
 assert.equal(g.secrets.size,0);
 const h=fixture(t);
 h.patches[1].config={provider:'missing',model:'nope'};fs.writeFileSync(h.profile,yaml.dump(h.patches));
 await assert.rejects(h.catalog.importDesktop(),{message:'The desktop default model is not configured.'});
 assert.equal(h.secrets.size,0);
});

test('import preserves the current selection, rejects when it removes it and uses the DSH default only when none',async t=>{
 const f=fixture(t);
 await f.catalog.save({id:'alpha',displayName:'Alpha',api:'openai-completions',baseURL:DESKTOP.alpha.baseURL,authMode:'none',models:[{id:'custom-model',name:'C',contextWindow:100,maxTokens:10}]});
 await assert.rejects(f.catalog.importDesktop(),{message:'Choose a new model in the model list, then import again.'});
 assert.equal(f.secrets.size,0);
 assert.deepEqual(JSON.parse(fs.readFileSync(f.catalog.file)).providers[0].models.map(m=>m.id),['custom-model']);
 const g=fixture(t);
 await manualSave(g.catalog);
 const snap=await g.catalog.importDesktop();
 assert.deepEqual(snap.selected,{provider:'manual',model:'manual-model'});
 const h=fixture(t);
 const plan=h.catalog.prepareImport();
 const snap2=await h.catalog.importDesktop({prepared:plan});
 assert.deepEqual(snap2.selected,{provider:'charlie',model:'example-model-c'});
});

test('prepareImport captures a plan that importDesktop revalidates; mutation is rejected',async t=>{
 const f=fixture(t);
 const plan=f.catalog.prepareImport();
 assert.equal(plan.providers.length,4);
 assert(plan.providers.filter(p=>p.authMode==='bearer').every(p=>typeof p.value==='string'&&p.value.length>0));
 assert(plan.providers.filter(p=>p.authMode==='none').every(p=>!('value' in p)));
 const snapshot=await f.catalog.importDesktop({prepared:plan});
 assert.equal(snapshot.providers.length,4);
 const g=fixture(t);
 const mutated=g.catalog.prepareImport();
 mutated.providers[0].models=[];
 await assert.rejects(g.catalog.importDesktop({prepared:mutated}),{message:'Invalid desktop import plan.'});
 assert.equal(g.secrets.size,0);assert(!fs.existsSync(g.catalog.file));
 const h=fixture(t);
 const stripped=h.catalog.prepareImport();
 stripped.providers[0].value=undefined;
 await assert.rejects(h.catalog.importDesktop({prepared:stripped}),{message:'Invalid desktop import plan.'});
});

test('import never copies arbitrary fields and snapshots hide refs, values and availability state cleanly',async t=>{
 const f=fixture(t);
 await f.catalog.importDesktop();
 const saved=fs.readFileSync(f.catalog.file,'utf8');
 assert(!saved.includes('extra'));assert(!saved.includes('must-not-copy'));
 const provider=f.catalog.snapshot().providers[0];
 assert(!('credentialRef' in provider));assert(!('value' in provider));
 assert(!('apiKeyEnv' in provider));
 await f.catalog.save({id:'clean',displayName:'Clean',api:'openai-completions',baseURL:'https://clean.example.test/v1',authMode:'none',models:[{id:'m',name:'M',contextWindow:1,maxTokens:1}],junk:'dropped'});
 const saved2=fs.readFileSync(f.catalog.file,'utf8');
 assert(!saved2.includes('dropped'));
});

test('v2 endpoints allow arbitrary HTTP(S) base paths but reject userinfo, delimiters and dot segments',async t=>{
 const f=fixture(t);
 const base={displayName:'X',api:'openai-completions',authMode:'none',models:[{id:'m',name:'M',contextWindow:100,maxTokens:10}]};
 let snap=await f.catalog.save({...base,id:'a',baseURL:'https://api.example.test/gateway'});
 assert.equal(snap.providers[0].baseURL,'https://api.example.test/gateway');
 snap=await f.catalog.save({...base,id:'b',baseURL:'https://api.example.test/v1/'});
 assert.equal(snap.providers[1].baseURL,'https://api.example.test/v1');
 snap=await f.catalog.save({...base,id:'c',baseURL:'http://localhost:8080/api'});
 assert.equal(snap.providers[2].baseURL,'http://localhost:8080/api');
 const invalid=['https://user:pass@example.test/v1','https://@example.test/v1','https://example.test/v1?x=1','https://example.test/v1#frag',
  'https://example.test/v1\\path','https://example.test/a/../b','https://example.test/a/./b','https://example.test/%2e%2e/v1',
  'https://example.test/v1%2f','ftp://example.test/v1','https://example.test/v1\n',' x.example.test','https://example.test/'+'x'.repeat(2048)+'/v1',null,42,''];
 for(const bad of invalid){
  await assert.rejects(f.catalog.save({...base,id:'x',baseURL:bad}),error=>error.code==='MODEL_CATALOG'&&error.message==='Enter a valid model endpoint.');
 }
});

test('v1 legacy catalogs reopen without mutation and migrate to v2 only on an explicit mutation',async t=>{
 const f=legacyFixture(t);
 const before=fs.readFileSync(f.catalog.file);
 const catalog=new ModelCatalog({stateRoot:f.root,vault:f.vault});
 assert.deepEqual(catalog.snapshot().selected,{provider:'alpha',model:'example-model-a'});
 assert.equal(catalog.snapshot().providers[0].authMode,'bearer');
 assert.equal(catalog.snapshot().providers[0].credentialAvailable,false);
 assert.deepEqual(fs.readFileSync(f.catalog.file),before);
 const g=legacyFixture(t);
 const migrated=new ModelCatalog({stateRoot:g.root,vault:g.vault});
 await migrated.select({provider:'alpha',model:'example-model-a'});
 const saved=JSON.parse(fs.readFileSync(g.catalog.file));
 assert.equal(saved.version,2);
 assert.equal(saved.providers[0].credentialRef,'model/provider/alpha');
 const reopened=new ModelCatalog({stateRoot:g.root,vault:g.vault});
 assert.equal(reopened.snapshot().providers[0].authMode,'bearer');
});

test('legacy provider refs are retained on no-key edits and rotated on key changes',async t=>{
 const f=legacyFixture(t);
 f.secrets.set('model/provider/alpha','canary-key-alpha');
 const catalog=new ModelCatalog({stateRoot:f.root,vault:f.vault});
 let snap=await catalog.save({id:'alpha',displayName:'Alpha',api:'openai-completions',baseURL:DESKTOP.alpha.baseURL,authMode:'bearer',models:[MODEL_A]});
 assert.equal(snap.providers[0].credentialAvailable,true);
 assert.equal(f.secrets.size,1);assert(f.secrets.has('model/provider/alpha'));
 assert.equal(JSON.parse(fs.readFileSync(f.catalog.file)).providers[0].credentialRef,'model/provider/alpha');
 snap=await catalog.save({id:'alpha',displayName:'Alpha',api:'openai-completions',baseURL:DESKTOP.alpha.baseURL,authMode:'bearer',models:[MODEL_A],value:'key-new'});
 assert.equal(f.secrets.size,1);assert(!f.secrets.has('model/provider/alpha'));
 const ref=JSON.parse(fs.readFileSync(f.catalog.file)).providers[0].credentialRef;
 assert(/^model\/credential\/[0-9a-f-]{36}$/.test(ref));
 assert.equal(snap.providers[0].credentialAvailable,true);
 const reopened=new ModelCatalog({stateRoot:f.root,vault:f.vault});
 assert.equal(reopened.snapshot().providers[0].credentialAvailable,true);
});

test('legacy invalid authorization never falls back to a saved v1 catalog',async t=>{
 const f=legacyFixture(t);const saved=fs.readFileSync(f.catalog.file);
 for(const invalid of ['{"secret-canary": [broken',JSON.stringify({version:2,providers:{}}),'null']){
  fs.writeFileSync(path.join(f.root,'model-authorizations.json'),invalid);
  assert.throws(()=>new ModelCatalog({stateRoot:f.root,vault:f.vault}),error=>error.message==='Invalid model authorization.'&&!error.cause&&!error.mark);
  assert.deepEqual(fs.readFileSync(f.catalog.file),saved);
 }
});

test('explicit legacy authorization takes precedence and incompatible saved v1 catalogs are never rewritten',async t=>{
 const f=legacyFixture(t);const original=JSON.parse(fs.readFileSync(f.catalog.file));const before=fs.readFileSync(f.catalog.file);
 const match={version:1,providers:{alpha:{endpoint:DESKTOP.alpha.baseURL,model:'example-model-a'}}};
 fs.writeFileSync(path.join(f.root,'model-authorizations.json'),JSON.stringify(match));
 assert.equal(new ModelCatalog({stateRoot:f.root,vault:f.vault}).snapshot().providers.length,1);
 fs.writeFileSync(path.join(f.root,'model-authorizations.json'),JSON.stringify({version:1,providers:{alpha:match.providers.alpha,bravo:{endpoint:'https://other.example.test/api/v1',model:'example-model-c'}}}));
 assert.equal(new ModelCatalog({stateRoot:f.root,vault:f.vault}).snapshot().providers.length,1);
 for(const providers of [{},{alpha:{...match.providers.alpha,endpoint:'https://changed.example.test/v1'}},{alpha:{...match.providers.alpha,model:'changed-model'}}]){
  fs.writeFileSync(path.join(f.root,'model-authorizations.json'),JSON.stringify({version:1,providers}));
  assert.throws(()=>new ModelCatalog({stateRoot:f.root,vault:f.vault}),{message:'Invalid saved catalog.'});
  assert.deepEqual(fs.readFileSync(f.catalog.file),before);
 }
 fs.unlinkSync(path.join(f.root,'model-authorizations.json'));
 for(const mutate of [s=>s.providers[0].models.push({...s.providers[0].models[0]}),s=>s.providers.push(s.providers[0]),
  s=>s.providers[0].models[0].maxTokens=Infinity,s=>s.providers[0].baseURL='https://user:secret-canary@example.test/v1',
  s=>s.providers[0].id='constructor',s=>s.providers[0].credentialRef='other-reference']){
  const stored=structuredClone(original);mutate(stored);fs.writeFileSync(f.catalog.file,JSON.stringify(stored));
  const untouched=fs.readFileSync(f.catalog.file);
  assert.throws(()=>new ModelCatalog({stateRoot:f.root,vault:f.vault}),{message:'Invalid saved catalog.'});
  assert.deepEqual(fs.readFileSync(f.catalog.file),untouched);
 }
 fs.writeFileSync(f.catalog.file,'{"secret-canary": [broken');
 assert.throws(()=>new ModelCatalog({stateRoot:f.root,vault:f.vault}),{message:'Invalid saved catalog.'});
});

test('the legacy authorization file validates bounded metadata, safe ids and HTTP v1 endpoints with fixed errors',t=>{
 const f=legacyFixture(t);const authFile=path.join(f.root,'model-authorizations.json');
 const v1={endpoint:DESKTOP.alpha.baseURL,model:'example-model-a'};
 const invalidEndpoints=['ftp://models.example.test/v1','https://user:secret-canary@models.example.test/v1','https://@models.example.test/v1',
  'https://models.example.test/v1?secret-canary=value','https://models.example.test/v1?','https://models.example.test/v1#secret-canary','https://models.example.test/v1#',
  'https://models.example.test/other','https://models.example.test/v1\n',' https://models.example.test/v1','https://models.example.test/'+'x'.repeat(2048)+'/v1',null,42];
 const invalidProviders=[...invalidEndpoints.map(endpoint=>({alpha:{endpoint,model:'example-model'}})),
  ...['__proto__','constructor','prototype','*','bad/id','x'.repeat(65),''].map(id=>Object.fromEntries([[id,v1]])),
  ...['','x'.repeat(257),'secret-canary\n',null,42].map(model=>({alpha:{...v1,model}})),
  {alpha:{...v1,extra:'secret-canary'}},{alpha:null},[],null,
  Object.fromEntries(Array.from({length:33},(_,i)=>[i===0?'alpha':'provider'+i,v1]))];
 for(const providers of invalidProviders){
  fs.writeFileSync(authFile,JSON.stringify({version:1,providers}));
  assert.throws(()=>new ModelCatalog({stateRoot:f.root,vault:f.vault}),error=>error.message==='Invalid model authorization.'&&!error.cause&&!error.mark);
 }
 for(const invalid of [{version:1,providers:{},extra:'secret-canary'},{providers:{}},[],null]){
  fs.writeFileSync(authFile,JSON.stringify(invalid));
  assert.throws(()=>new ModelCatalog({stateRoot:f.root,vault:f.vault}),{message:'Invalid model authorization.'});
 }
 const providers=Object.fromEntries(Array.from({length:32},(_,i)=>[i===0?'alpha':'provider'+i,v1]));
 fs.writeFileSync(authFile,JSON.stringify({version:1,providers}));
 assert.equal(new ModelCatalog({stateRoot:f.root,vault:f.vault}).snapshot().providers[0].id,'alpha');
});

test('a legacy authorization file does not constrain explicit UI import and is left untouched',async t=>{
 const f=fixture(t);
 const authFile=path.join(f.root,'model-authorizations.json');
 const before={version:1,providers:{alpha:{endpoint:DESKTOP.alpha.baseURL,model:'example-model-a'}}};
 fs.writeFileSync(authFile,JSON.stringify(before));
 const catalog=new ModelCatalog({stateRoot:f.root,vault:f.vault,dshRoot:path.join(f.root,'dsh')});
 const snapshot=await catalog.importDesktop();
 assert.equal(snapshot.providers.length,4);
 assert.equal(snapshot.providers[0].models.length,2);
 assert.deepEqual(JSON.parse(fs.readFileSync(authFile)),before);
 const changed=await manualSave(catalog,{id:'granted',displayName:'Granted'});
 assert(changed.providers.some(p=>p.id==='granted'));
 fs.writeFileSync(authFile,JSON.stringify({version:1,providers:{}}));
 const reopened=new ModelCatalog({stateRoot:f.root,vault:f.vault});
 assert.equal(reopened.snapshot().providers.length,5);
});

test('corrupt v2 files are rejected without mutation and invalid refs never load',async t=>{
 const f=fixture(t);await f.catalog.importDesktop();
 fs.writeFileSync(f.catalog.file,'{"secret-canary": [broken');
 assert.throws(()=>new ModelCatalog({stateRoot:f.root,vault:f.vault}),{message:'Invalid saved catalog.'});
 const g=fixture(t);await g.catalog.importDesktop();
 const stored=JSON.parse(fs.readFileSync(g.catalog.file));
 stored.providers[3].credentialRef='model/credential/not-a-uuid';
 fs.writeFileSync(g.catalog.file,JSON.stringify(stored));
 assert.throws(()=>new ModelCatalog({stateRoot:g.root,vault:g.vault}),{message:'Invalid saved catalog.'});
 const h=fixture(t);await h.catalog.importDesktop();
 const legacy=JSON.parse(fs.readFileSync(h.catalog.file));
 legacy.providers[0].credentialRef='model/provider/other';
 fs.writeFileSync(h.catalog.file,JSON.stringify(legacy));
 assert.throws(()=>new ModelCatalog({stateRoot:h.root,vault:h.vault}),{message:'Invalid saved catalog.'});
});

test('ambiguous desktop configuration fails with fixed errors before any credential read',async t=>{
 const f=fixture(t);
 const read=fs.readFileSync,reads=[];
 t.mock.method(fs,'readFileSync',function(file,...args){reads.push(file);return read.call(this,file,...args)});
 f.patches.push({id:'llm-pi-ai',config:{providers:structuredClone(DESKTOP)}});
 fs.writeFileSync(f.profile,yaml.dump(f.patches));
 await assert.rejects(f.catalog.importDesktop(),{message:'Ambiguous desktop configuration.'});
 assert.equal(reads.filter(file=>file.endsWith('.credentials.yaml')).length,0);
 assert.equal(f.secrets.size,0);assert(!fs.existsSync(f.catalog.file));
});

test('unauthenticated-only DSH import does not require a credentials file',async t=>{
 const f=fixture(t);
 f.patches[0].config.providers={local:structuredClone(DESKTOP.local)};
 f.patches[1].config={provider:'local',model:'local-model'};
 fs.writeFileSync(f.profile,yaml.dump(f.patches));fs.unlinkSync(path.join(f.root,'dsh/.credentials.yaml'));
 const result=await f.catalog.importDesktop();
 assert.equal(result.providers[0].authMode,'none');assert.equal(f.secrets.size,0);
});

test('explicit null credential reference cannot silently disable authentication',async t=>{
 const f=fixture(t);f.patches[0].config.providers.alpha.apiKeyEnv=null;
 fs.writeFileSync(f.profile,yaml.dump(f.patches));
 assert.throws(()=>f.catalog.prepareImport(),/not supported/);
 assert.equal(f.secrets.size,0);
});

test('prepared import rejects invalid merged selection before lifecycle work and captures queued values',async t=>{
 const f=fixture(t);await f.catalog.importDesktop();
 f.patches[0].config.providers.charlie.models=[{...MODEL_A,id:'replacement'}];
 f.patches[1].config={provider:'charlie',model:'replacement'};
 fs.writeFileSync(f.profile,yaml.dump(f.patches));
 assert.throws(()=>f.catalog.prepareImport(),/Choose a new model/);
 const g=fixture(t),plan=g.catalog.prepareImport();
 let release;g.catalog.queue=new Promise(resolve=>release=resolve);
 const imported=g.catalog.importDesktop({prepared:plan});
 plan.providers[0].value='changed-after-queue';plan.providers[0].baseURL='https://other.example/v1';
 release();await imported;
 assert.equal(g.catalog.providers[0].baseURL,DESKTOP.alpha.baseURL);
 assert(![...g.secrets.values()].includes('changed-after-queue'));
 const duplicate=g.catalog.prepareImport();duplicate.providers.push(duplicate.providers[0]);
 await assert.rejects(g.catalog.importDesktop({prepared:duplicate}),/Invalid desktop import plan/);
});

test('long model identifiers survive save, selection and reload; runtime lists cannot mutate stored grants',async t=>{
 const f=fixture(t),id='organization/'+ 'model-version-'.repeat(8);
 await manualSave(f.catalog,{models:[{...MODEL_A,id}]});
 await f.catalog.select({provider:'manual',model:id});
 const list=f.catalog.providers;list[0].models[0].id='tampered';list[0].baseURL='https://other.example';
 assert.equal(f.catalog.providers[0].models[0].id,id);
 assert.equal(new ModelCatalog({stateRoot:f.root,vault:f.vault}).snapshot().selected.model,id);
});

test('post-rename metadata failure preserves ciphertext required by the published catalog',async t=>{
 const f=fixture(t);await manualSave(f.catalog,{authMode:'bearer',value:'old-key'});
 const rename=fs.renameSync;
 fs.renameSync=(from,to)=>{rename(from,to);if(to===f.catalog.file)throw Error('synthetic failure after rename')};
 try {await assert.rejects(manualSave(f.catalog,{authMode:'bearer',value:'new-key'}),/Saved data was preserved/);}
 finally {fs.renameSync=rename;}
 assert.equal(f.secrets.size,2);assert.equal(f.catalog.snapshot().fault,true);
 assert.throws(()=>f.catalog.providers,/unavailable/);
 const reopened=new ModelCatalog({stateRoot:f.root,vault:f.vault});
 assert.equal(f.secrets.get(reopened.providers[0].credentialRef),'new-key');
});

test('saved providers cannot alias the same mutable credential reference',async t=>{
 const f=fixture(t);await manualSave(f.catalog,{authMode:'bearer',value:'first-key'});
 await manualSave(f.catalog,{id:'second',authMode:'bearer',value:'second-key'});
 const stored=JSON.parse(fs.readFileSync(f.catalog.file));
 stored.providers[1].credentialRef=stored.providers[0].credentialRef;
 fs.writeFileSync(f.catalog.file,JSON.stringify(stored));
 assert.throws(()=>new ModelCatalog({stateRoot:f.root,vault:f.vault}),/Invalid saved catalog/);
});


test('new and migrated catalogs ignore broken legacy authorization without touching it',async t=>{
 for(const migrated of [false,true]){
  const f=fixture(t);
  if(migrated)await manualSave(f.catalog);
  const expected=f.catalog.snapshot();
  const catalogBytes=migrated?fs.readFileSync(f.catalog.file):null;
  const legacy=path.join(f.root,'model-authorizations.json');
  for(const content of ['broken-json',{version:2,providers:{}},{version:1,providers:{alpha:null}}]){
   const bytes=typeof content==='string'?content:JSON.stringify(content);
   fs.writeFileSync(legacy,bytes);
   assert.deepEqual(new ModelCatalog({stateRoot:f.root,vault:f.vault}).snapshot(),expected);
   assert.equal(fs.readFileSync(legacy,'utf8'),bytes);
   if(migrated)assert.deepEqual(fs.readFileSync(f.catalog.file),catalogBytes);
   else assert.equal(fs.existsSync(f.catalog.file),false);
  }
  fs.unlinkSync(legacy);fs.mkdirSync(legacy);
  const reopened=new ModelCatalog({stateRoot:f.root,vault:f.vault});
  assert.deepEqual(reopened.snapshot(),expected);
  await manualSave(reopened,{id:'another'});
  assert.equal(fs.statSync(legacy).isDirectory(),true);
 }
});


test('existing null or scalar catalog is malformed, never missing state or overwritten',t=>{
 const f=fixture(t);
 assert.equal(fs.existsSync(f.catalog.file),false);
 assert.equal(new ModelCatalog({stateRoot:f.root,vault:f.vault}).snapshot().providers.length,0);
 for(const bytes of ['null\n','false','42','"catalog"','[]']){
  fs.writeFileSync(f.catalog.file,bytes);
  assert.throws(()=>new ModelCatalog({stateRoot:f.root,vault:f.vault}),
   {code:'MODEL_CATALOG',message:'Invalid saved catalog.'});
  assert.equal(fs.readFileSync(f.catalog.file,'utf8'),bytes);
 }
});
