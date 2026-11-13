'use strict';
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {EventEmitter}=require('node:events');
const {readJson,writeJson}=require('./atomic-json.cjs');
const {privateDirectory}=require('./iron-ca.cjs');
const {hashFile,installArchive,verifyInstalled}=require('./archive-install.cjs');
const manifest=require('./artifact-manifest.cjs');

const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const relative=value=>typeof value==='string'&&!path.isAbsolute(value)&&path.normalize(value)===value&&!value.split(path.sep).some(x=>['','..','.'].includes(x));
function validateManifest(value){
 if(value.version!==1||!/^[-a-z0-9]+$/.test(value.id)||!Array.isArray(value.files)||!value.files.length||!Array.isArray(value.archives))throw Error('Invalid application artifact manifest.');
 const paths=new Set();
 for(const f of value.files){
  if(!relative(f.path)||paths.has(f.path)||!Number.isSafeInteger(f.bytes)||f.bytes<0||!/^[a-f0-9]{64}$/.test(f.sha256)||![0o600,0o755].includes(f.mode))throw Error('Invalid application artifact entry.');
  paths.add(f.path);
 }
 for(const a of value.archives)if(!paths.has(a.file)||!relative(a.destination)||!/^[-a-zA-Z0-9_.]+$/.test(a.root))throw Error('Invalid application archive entry.');
}

class ArtifactInstaller extends EventEmitter{
 constructor({stateRoot,manifests=[manifest],copyArtifact,unpack=installArchive}={}){
  super();this.root=path.join(stateRoot,'artifacts');privateDirectory(this.root);
  this.manifests=new Map();
  for(const spec of manifests){validateManifest(spec);if(this.manifests.has(spec.id))throw Error('Duplicate artifact release.');this.manifests.set(spec.id,spec);}
  this.currentId=manifests[0].id;this.copyArtifact=copyArtifact??require('./artifact-download.cjs').acquireLocalArtifact;this.unpack=unpack;
  this.stateFile=path.join(this.root,'selection.json');this.state={active:null,previous:null};this.status={phase:'idle',received:0,total:0};
  try{
   const state=readJson(this.stateFile,this.state);
   if(!state||Object.keys(state).some(k=>!['active','previous'].includes(k))||!['active','previous'].every(k=>state[k]===null||this.manifests.has(state[k])))throw Error('Unknown installed release.');
   this.state=state;
  }catch{this.fault=true;}
  this.recoveryFile=path.join(this.root,'last-active.json');
  try{const value=readJson(this.recoveryFile,null);if(value&&Object.keys(value).length===1&&this.manifests.has(value.active))this.recoveryId=value.active;}catch{}
  if(!this.state.active&&this.recoveryId)this.fault=true;
 }
 snapshot(){return {...this.status,active:this.state.active,previous:this.state.previous,release:this.currentId,fault:Boolean(this.fault),recoverable:Boolean(this.recoveryId),busy:Boolean(this.operation)};}
 publish(next){this.status={...this.status,...next};this.emit('change',this.snapshot());}
 spec(id){const value=this.manifests.get(id);if(!value)throw Error('This application does not support that artifact release.');return value;}
 releasePath(id){this.spec(id);return path.join(this.root,'releases',id);}
 cancel(){this.operation?.abort();}
 async exclusive(operation,{allowFault=false}={}){
  if(this.fault&&!allowFault)throw Error('Artifact selection is invalid. The stored file was preserved.');
  if(this.operation)throw Error('An artifact operation is already running.');
  const controller=new AbortController();this.operation=controller;
  try{return await operation(controller.signal);}
  catch(error){this.publish({phase:controller.signal.aborted?'cancelled':'error'});throw error;}
  finally{this.operation=undefined;this.emit('change',this.snapshot());}
 }
 async verifyRelease(id,signal){
  const spec=this.spec(id),root=this.releasePath(id),stat=await fsp.lstat(root);
  if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Invalid artifact release directory.');
  const receipt=readJson(path.join(root,'ready.json'),null);
  if(receipt?.manifest!==digest(spec))throw Error('Artifact release is incomplete or belongs to another application version.');
  for(const file of spec.files){
   signal?.throwIfAborted();const location=path.join(root,file.path);
   const stat=await fsp.lstat(location);
   if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==file.bytes||(stat.mode&0o777)!==file.mode||await hashFile(location,signal)!==file.sha256)throw Error('Installed artifact failed verification.');
  }
  for(const item of spec.archives){const source=spec.files.find(f=>f.path===item.file);await verifyInstalled(path.join(root,item.destination),{root:item.root,sha256:source.sha256},signal);}
  return root;
 }
 async prepare(source,id=this.currentId){return this.exclusive(async signal=>{
  if(!path.isAbsolute(source))throw Error('Choose an artifact package directory.');
  const sourceStat=await fsp.lstat(source);if(!sourceStat.isDirectory()||sourceStat.isSymbolicLink())throw Error('Choose a regular artifact package directory.');
  const spec=this.spec(id),final=this.releasePath(id),total=spec.files.reduce((n,f)=>n+f.bytes,0);
  this.publish({phase:'verifying',received:0,total,file:null});
  let exists=false;try{await fsp.lstat(final);exists=true;}catch(e){if(e.code!=='ENOENT')throw e;}
  if(exists){await this.verifyRelease(id,signal);this.publish({phase:'ready',received:total});return id;}
  privateDirectory(path.dirname(final));
  const staging=path.join(this.root,`pending-${id}`);privateDirectory(staging);
  const reservation=path.join(staging,'pending.json'),expected=digest(spec);
  const previous=readJson(reservation,undefined);
  if(previous!==undefined&&(!previous||typeof previous!=='object'||Array.isArray(previous)||Object.keys(previous).some(k=>!['manifest','pid'].includes(k))||previous.manifest!==expected||
    (previous.pid!==undefined&&(!Number.isSafeInteger(previous.pid)||previous.pid<1))))throw Error('Incomplete artifact metadata is invalid and was preserved.');
  if(previous?.pid&&previous.pid!==process.pid){
   let alive=true;try{process.kill(previous.pid,0);}catch(error){if(error.code==='ESRCH')alive=false;else throw error;}
   if(alive)throw Error('Another process is preparing this release.');
  }
  writeJson(reservation,{manifest:expected,pid:process.pid});
  let received=0;
  for(const file of spec.files){
   signal.throwIfAborted();this.publish({phase:'copying',file:file.path,received});
   const destination=path.join(staging,file.path);
   // A killed copier cannot run finally. Only its exact private temporary-file
   // namespace is eligible for cleanup; never sweep arbitrary selected files.
   let siblings=[];try{siblings=await fsp.readdir(path.dirname(destination));}catch(error){if(error.code!=='ENOENT')throw error;}
   const prefix='.'+path.basename(destination)+'.';
   for(const name of siblings)if(name.startsWith(prefix)&&/^[a-f0-9]{32}\.tmp$/.test(name.slice(prefix.length))){
    const temporary=path.join(path.dirname(destination),name),stat=await fsp.lstat(temporary);
    if(!stat.isFile()||stat.isSymbolicLink())throw Error('Artifact copy recovery file changed; files were preserved.');
    await fsp.unlink(temporary);
   }
   await this.copyArtifact({source:path.join(source,file.path),destination,sha256:file.sha256,maxBytes:file.bytes,signal,
    onProgress:progress=>this.publish({received:received+(progress.received??progress.bytes??0)})});
   if((await fsp.stat(destination)).size!==file.bytes)throw Error('Artifact size does not match the release.');
   await fsp.chmod(destination,file.mode);received+=file.bytes;this.publish({received});
  }
  this.publish({phase:'extracting',file:null});
  for(const item of spec.archives){const file=spec.files.find(f=>f.path===item.file);await this.unpack({archive:path.join(staging,item.file),destination:path.join(staging,item.destination),spec:{root:item.root,sha256:file.sha256},signal});}
  signal.throwIfAborted();writeJson(path.join(staging,'ready.json'),{manifest:expected});
  await fsp.rename(staging,final);
  const directory=await fsp.open(path.dirname(final),'r');try{await directory.sync();}finally{await directory.close();}
  this.publish({phase:'ready',file:null,received:total});return id;
 });}
 async activate(id,{stopEnvironments}={}){return this.exclusive(async signal=>{
  if(typeof stopEnvironments!=='function')throw Error('Environment shutdown is required before changing runtimes.');
  this.publish({phase:'verifying',file:null});await this.verifyRelease(id,signal);
  this.publish({phase:'stopping'});await stopEnvironments();signal.throwIfAborted();
  const next={active:id,previous:this.state.active===id?this.state.previous:this.state.active};
  writeJson(this.recoveryFile,{active:id});this.recoveryId=id;
  writeJson(this.stateFile,next);this.state=next;this.publish({phase:'active'});return this.runtimeOptions();
 });}
 recoveryOptions(){
  const id=this.state.active??this.recoveryId;
  return id?this.optionsFor(id):undefined;
 }
 async restore({stopEnvironments}={}){return this.exclusive(async signal=>{
  if(!this.recoveryId||typeof stopEnvironments!=='function')throw Error('No verified runtime recovery is available.');
  await this.verifyRelease(this.recoveryId,signal);await stopEnvironments();signal.throwIfAborted();
  let present=false;try{const stat=await fsp.lstat(this.stateFile);if(!stat.isFile()||stat.isSymbolicLink())throw Error('Runtime selection is not a regular file.');present=true;}catch(e){if(e.code!=='ENOENT')throw e;}
  if(present)await fsp.rename(this.stateFile,path.join(this.root,`selection-invalid-${crypto.randomUUID()}.json`));
  const next={active:this.recoveryId,previous:null};writeJson(this.stateFile,next);this.state=next;this.fault=false;this.publish({phase:'active'});return this.runtimeOptions();
 },{allowFault:true});}
 runtimeOptions(){
  if(this.fault||!this.state.active)throw Error('A verified artifact release must be installed first.');
  return this.optionsFor(this.state.active);
 }
 optionsFor(id){
  const artifactRoot=this.releasePath(id);
  return {artifactRoot,smolRuntime:path.join(artifactRoot,'smol-runtime/smolvm-1.34.1-darwin-arm64'),wrapvmVariant:'stock-amd64',limaVariant:'bundled'};
 }
}
module.exports={ArtifactInstaller};
