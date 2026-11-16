const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Provisioner}=require('../src/runtime/provisioner.cjs');
const {SmolDriver,WRAP_IMAGE}=require('../src/runtime/smol-driver.cjs');
const {environment}=require('../src/runtime/environments.cjs');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
function fixture(t){const root=fs.mkdtempSync('/tmp/guest-artifact-');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
test('each guest start replaces the scoped substitute manifest, including after the last grant is removed',async t=>{
 const root=fixture(t),manifests=[];
 const provisioner=new Provisioner({stateRoot:root,serviceFile:'/fixture/service.cjs'});
 const driver={definition:{id:'fixture',kind:'lima'},exec:async()=>'http://127.0.0.1:3080/?token=synthetic',
  putFile:async(source,target)=>{if(target.endsWith('/secrets.json'))manifests.push(JSON.parse(fs.readFileSync(source,'utf8')))}};
 const bridge={port:12345,defaultModel:null,guestProviders:()=>[],guestSecrets:endpoint=>{
  assert.equal(endpoint,'http://192.168.5.2:12345');return {version:1,entries:[{id:'fixture',authorization:'substitute-only'}]}}};
 await provisioner.start(driver,{network:{proxyPort:12346,bridge}});
 await provisioner.start(driver,{network:{proxyPort:12346}});
 assert.deepEqual(manifests,[{version:1,entries:[{id:'fixture',authorization:'substitute-only'}]},{version:1,entries:[]}]);
});
test('provisioner refuses the wrong architecture or modified bundle before guest writes',async t=>{
 const root=fixture(t),lockFile=path.join(root,'lock.json');fs.writeFileSync(lockFile,'lock');fs.writeFileSync(path.join(root,'guest-runtime.tar.gz'),'bundle');
 const manifest={version:1,platform:'linux-x64-glibc',node:'24.13.0',harness:'0.2.2-rc.2',npmLifecycleScripts:false,lockSha256:sha('lock'),bundleSha256:sha('bundle')};
 fs.writeFileSync(path.join(root,'guest-runtime.json'),JSON.stringify(manifest));
 const wrong=new Provisioner({artifacts:root,lockFile,architecture:'arm64'});
 await assert.rejects(wrong.prepare({exec:()=>assert.fail('guest must not be touched')},{}),/guest bundle/);
 const right=new Provisioner({artifacts:root,lockFile,architecture:'x64'});assert.deepEqual(await right.verifyArtifacts(),manifest);
 fs.writeFileSync(path.join(root,'guest-runtime.tar.gz'),'tampered');await assert.rejects(right.verifyArtifacts(),/guest bundle/);
 assert.throws(()=>new Provisioner({architecture:'../../x64'}),/architecture/);
});
test('smol checks image bytes before creating a VM and binds inspection to the selected image',async t=>{
 const root=fixture(t),imageArchive=path.join(root,'image.tar');fs.writeFileSync(imageArchive,'modified');
 const driver=new SmolDriver({definition:environment('wrapvm-v1'),runtimeRoot:root,binary:'/fixture/smolvm',imageArchive,
   imageSha256:sha('stock'),provisioner:{verifyArtifacts:async()=>{},prepare:()=>assert.fail('guest must not be touched')}});
 driver.verifyRuntime=()=>{};let calls=[];
 driver.command=async args=>{calls.push(args);return{stdout:'[]'}};
 await assert.rejects(driver.prepare({ownershipToken:crypto.randomUUID(),network:{healthy:()=>true,mediator:{healthy:()=>true}}}),/digest mismatch/);
 assert(calls.every(args=>args[1]==='ls'));
 const token=crypto.randomUUID(),record={name:driver.definition.machine,labels:{owner:driver.definition.owner,identity:token},
  state:'stopped',network:true,mounts:0,ports:0,image:WRAP_IMAGE,restart_policy:'never',allowed_hosts:['=host.smolvm.internal'],allowed_cidrs:['192.0.2.1/32']};
 driver.command=async()=>({stdout:JSON.stringify([record])});
 assert.equal((await driver.inspect({ownershipToken:token})).configurationValid,false);
 record.image='local:'+sha('stock');assert.equal((await driver.inspect({ownershipToken:token})).configurationValid,true);
});


test('last model removal clears the projected guest provider, default and substitute on reconnect',async t=>{
 const root=fixture(t),guestHome=path.join(root,'guest'),guestRoot=path.join(guestHome,'.harness-isolated');
 const yaml=require('js-yaml'),vm=require('node:vm');
 const {ModelCatalog}=require('../src/runtime/model-catalog.cjs');
 const catalog=new ModelCatalog({stateRoot:path.join(root,'host'),vault:{has:()=>false}});
 await catalog.save({id:'only',displayName:'Only',api:'openai-completions',baseURL:'https://example.test/v1',
  authMode:'none',models:[{id:'model',name:'Model',contextWindow:1000,maxTokens:100}]});
 const provisioner=new Provisioner({stateRoot:root,serviceFile:'/fixture/service.cjs'});
 const writes=[];
 const driver={definition:{id:'fixture',kind:'lima'},exec:async()=>'http://127.0.0.1:3080/?token=synthetic',
  putFile:async(source,target)=>{
   if(!target.endsWith('/model-providers.json'))return;
   fs.mkdirSync(guestRoot,{recursive:true});
   fs.copyFileSync(source,path.join(guestRoot,'model-providers.json'));
   writes.push(JSON.parse(fs.readFileSync(source,'utf8')));
  }};
 const substitute='isolated-'+'a'.repeat(64);
 const bridge={port:12345,defaultModel:catalog.selected,guestProviders:()=>catalog.providers.map(provider=>({
  provider:{...provider,baseURL:'http://192.168.5.2:12345/models/only/v1'},token:substitute}))};
 await provisioner.start(driver,{network:{proxyPort:12346,bridge}});
 assert.deepEqual(writes[0].selected,{provider:'only',model:'model'});
 assert.equal(writes[0].providers.only.models[0].id,'model');
 assert.equal(writes[0].credentials.ISOLATED_MODEL_ONLY,substitute);
 // Run only the shipped guest's configuration projection, before service/socket startup.
 const service=fs.readFileSync(path.join(__dirname,'../guest/v1/service.cjs'),'utf8');
 const boundary=service.indexOf('const socket =');assert(boundary>0);
 const project=()=>vm.runInNewContext(service.slice(0,boundary),{require:name=>{
  if(name==='node:os')return{homedir:()=>guestHome};
  if(name===path.join(guestRoot,'runtime/node_modules/js-yaml'))return yaml;
  return require(name);
 }});
 fs.writeFileSync(path.join(guestRoot,'network.json'),JSON.stringify({proxy:'http://192.168.5.2:12346'}));
 project();
 const patchFile=path.join(guestRoot,'data/profiles/web/cordis.patch.yml');
 const credentialFile=path.join(guestRoot,'data/.credentials.yaml');
 assert(yaml.load(fs.readFileSync(patchFile,'utf8')).some(item=>item.id==='agent-default-model'));
 const credentials=yaml.load(fs.readFileSync(credentialFile,'utf8'));
 credentials.refs.UNRELATED='synthetic-unrelated';fs.writeFileSync(credentialFile,yaml.dump(credentials));
 await catalog.remove('only');assert.equal(catalog.providers.length,0);assert.equal(catalog.selected,null);
 await provisioner.start(driver,{network:{proxyPort:12346}});
 assert.equal(writes.length,2);
 assert.deepEqual(writes[1],{providers:{},credentials:{},selected:null});
 project();
 const patches=yaml.load(fs.readFileSync(patchFile,'utf8'));
 assert.equal(patches.some(item=>item.id==='agent-default-model'),false);
 assert.deepEqual(patches.find(item=>item.id==='llm-pi-ai').config.providers,{});
 assert.deepEqual(yaml.load(fs.readFileSync(credentialFile,'utf8')).refs,{UNRELATED:'synthetic-unrelated'});
});
