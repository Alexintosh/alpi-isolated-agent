const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Provisioner}=require('../src/runtime/provisioner.cjs');
const {SmolDriver,WRAP_IMAGE}=require('../src/runtime/smol-driver.cjs');
const {environment}=require('../src/runtime/environments.cjs');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
function fixture(t){const root=fs.mkdtempSync('/tmp/guest-artifact-');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
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
