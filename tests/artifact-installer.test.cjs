const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {ArtifactInstaller}=require('../src/runtime/artifact-installer.cjs');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'artifact-installer-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source=path.join(root,'payload');fs.mkdirSync(source);fs.writeFileSync(path.join(source,'tool'),'stock fixture');
 const spec={version:1,id:'release-a',files:[{path:'tool',bytes:13,sha256:sha('stock fixture'),mode:0o755}],archives:[]};
 const manifests=[spec,{...spec,id:'release-b'}];let copies=0;
 // Inject only the copy primitive to isolate installer transaction/recovery
 // behavior. Real copy integrity/cancellation is covered in its own suite.
 const copyArtifact=async({source,destination,signal,onProgress})=>{
  signal?.throwIfAborted();if(fs.existsSync(destination))return destination;
  await fsp.mkdir(path.dirname(destination),{recursive:true});await fsp.copyFile(source,destination,fs.constants.COPYFILE_EXCL);copies++;onProgress?.({received:13,total:13});signal?.throwIfAborted();return destination;
 };
 const options={stateRoot:path.join(root,'state'),manifests,copyArtifact};
 return {root,source,options,get copies(){return copies;}};
}
test('preparation is separate from activation; stop failure preserves active release and rollback is explicit',async t=>{
 const f=fixture(t),installer=new ArtifactInstaller(f.options);
 await installer.prepare(f.source,'release-a');assert.equal(installer.snapshot().active,null);
 await assert.rejects(installer.activate('release-a'),/shutdown/);
 let stops=0;await installer.activate('release-a',{stopEnvironments:async()=>{stops++;}});
 await installer.prepare(f.source,'release-b');assert.equal(installer.snapshot().active,'release-a');
 await assert.rejects(installer.activate('release-b',{stopEnvironments:async()=>{throw Error('guest still running');}}),/still running/);
 assert.equal(installer.snapshot().active,'release-a');assert.equal(installer.snapshot().previous,null);
 await installer.activate('release-b',{stopEnvironments:async()=>{stops++;}});assert.equal(installer.snapshot().previous,'release-a');
 const reopened=new ArtifactInstaller(f.options);assert.equal(reopened.snapshot().active,'release-b');
 await reopened.activate('release-a',{stopEnvironments:async()=>{stops++;}});assert.equal(reopened.snapshot().previous,'release-b');assert.equal(stops,3);
 assert(fs.existsSync(path.join(reopened.releasePath('release-b'),'tool')));
});
test('cancelled preparation keeps verified completed files for retry and never changes active selection',async t=>{
 const f=fixture(t),installer=new ArtifactInstaller(f.options);
 const cancel=s=>{if(s.phase==='copying'&&s.received===13)installer.cancel();};installer.on('change',cancel);
 await assert.rejects(installer.prepare(f.source));assert.equal(installer.snapshot().phase,'cancelled');assert.equal(installer.snapshot().active,null);
 installer.off('change',cancel);const reopened=new ArtifactInstaller(f.options);await reopened.prepare(f.source);
 assert.equal(f.copies,1);assert.equal(reopened.snapshot().phase,'ready');assert.equal(reopened.snapshot().busy,false);
});
test('corrupt selection and tampered release fail closed without overwriting existing state',async t=>{
 const f=fixture(t),installer=new ArtifactInstaller(f.options);await installer.prepare(f.source);
 fs.writeFileSync(path.join(installer.releasePath('release-a'),'tool'),'modified');let stopped=false;
 await assert.rejects(installer.activate('release-a',{stopEnvironments:async()=>{stopped=true;}}),/verification/);assert.equal(stopped,false);
 fs.writeFileSync(installer.stateFile,'broken');const reopened=new ArtifactInstaller(f.options);assert.equal(reopened.snapshot().fault,true);
 await assert.rejects(reopened.prepare(f.source),/selection/);assert.equal(fs.readFileSync(installer.stateFile,'utf8'),'broken');
});
test('simultaneous installer actions are rejected while the first copy is suspended',async t=>{
 const f=fixture(t);let release,started;const start=new Promise(r=>{started=r;});const wait=new Promise(r=>{release=r;});
 const installer=new ArtifactInstaller({...f.options,copyArtifact:async args=>{started();await wait;return f.options.copyArtifact(args);}});
 const pending=installer.prepare(f.source);await start;
 await assert.rejects(installer.prepare(f.source),/already running/);release();await pending;
});
test('existing invalid falsy reservation values are preserved',async t=>{
 const f=fixture(t),installer=new ArtifactInstaller(f.options),staging=path.join(installer.root,'pending-release-a');fs.mkdirSync(staging);
 const record=path.join(staging,'pending.json');
 for(const value of ['null','false','0','""']){
  fs.writeFileSync(record,value);await assert.rejects(installer.prepare(f.source),/preserved/);assert.equal(fs.readFileSync(record,'utf8'),value);
 }
});
test('a corrupt active selection retains stop-only runtime coordinates and explicit restore preserves its bytes',async t=>{
 const f=fixture(t),installer=new ArtifactInstaller(f.options);await installer.prepare(f.source);await installer.activate('release-a',{stopEnvironments:async()=>{}});
 fs.writeFileSync(installer.stateFile,'{invalid');const reopened=new ArtifactInstaller(f.options);
 assert(reopened.snapshot().fault);assert(reopened.snapshot().recoverable);assert(reopened.recoveryOptions().artifactRoot.endsWith('release-a'));
 assert.throws(()=>reopened.runtimeOptions());
 await assert.rejects(reopened.restore({stopEnvironments:async()=>{throw Error('stop failed');}}),/stop failed/);
 assert.equal(fs.readFileSync(installer.stateFile,'utf8'),'{invalid');
 await reopened.restore({stopEnvironments:async()=>{}});assert.equal(reopened.snapshot().fault,false);assert.equal(reopened.snapshot().active,'release-a');
 const backup=fs.readdirSync(reopened.root).find(x=>x.startsWith('selection-invalid-'));assert.equal(fs.readFileSync(path.join(reopened.root,backup),'utf8'),'{invalid');
});
