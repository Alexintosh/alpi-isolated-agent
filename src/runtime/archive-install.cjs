'use strict';
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {writeJson,readJson}=require('./atomic-json.cjs');

async function hashFile(file,signal){
 const handle=await fsp.open(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 try{
  if(!(await handle.stat()).isFile())throw Error('Artifact is not a regular file.');
  const hash=crypto.createHash('sha256');
  for await(const chunk of handle.createReadStream({autoClose:false,signal}))hash.update(chunk);
  return hash.digest('hex');
 }finally{await handle.close();}
}

// Record symlinks, including stock guest-rootfs absolute links, without following
// them on the host. Only pinned, trusted release archives reach the extractor.
async function inventory(root,signal,relative=''){
 const entries=[];
 for(const name of (await fsp.readdir(path.join(root,relative))).sort()){
  signal?.throwIfAborted();
  const entry=path.join(relative,name),file=path.join(root,entry),stat=await fsp.lstat(file);
  if(stat.isSymbolicLink())entries.push({path:entry,link:await fsp.readlink(file)});
  else if(stat.isDirectory())entries.push({path:entry,directory:true},...await inventory(root,signal,entry));
  else if(stat.isFile())entries.push({path:entry,sha256:await hashFile(file,signal),mode:stat.mode&0o777});
  else throw Error('Unsupported file in stock runtime archive.');
 }
 return entries;
}

async function verifyInstalled(destination,spec,signal){
 const stat=await fsp.lstat(destination);
 if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Installed runtime is not a private directory.');
 const receiptPath=path.join(destination,'.installed.json');
 if(!(await fsp.lstat(receiptPath)).isFile()||(await fsp.lstat(receiptPath)).isSymbolicLink())throw Error('Invalid runtime receipt.');
 const receipt=JSON.parse(await fsp.readFile(receiptPath,'utf8'));
 if(receipt.sha256!==spec.sha256||receipt.root!==spec.root||!Array.isArray(receipt.entries)||!receipt.entries.length)
  throw Error('Installed runtime does not match this release.');
 for(const entry of receipt.entries){
  signal?.throwIfAborted();
  if(typeof entry.path!=='string'||path.isAbsolute(entry.path)||path.normalize(entry.path)!==entry.path||entry.path.split(path.sep).includes('..'))throw Error('Invalid runtime receipt path.');
  const file=path.join(destination,entry.path),stat=await fsp.lstat(file);
  if(entry.link!==undefined){if(!stat.isSymbolicLink()||await fsp.readlink(file)!==entry.link)throw Error('Installed runtime link changed.');}
  else if(entry.directory){if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Installed runtime directory changed.');}
  else if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o777)!==entry.mode||await hashFile(file,signal)!==entry.sha256)
   throw Error('Installed runtime file changed.');
 }
 return destination;
}

async function extract(archive,directory,signal){
 signal?.throwIfAborted();
 const child=spawn('/usr/bin/tar',['-xzf',archive,'-C',directory],{stdio:'ignore',env:{PATH:'/usr/bin:/bin',COPYFILE_DISABLE:'1'}});
 let timer;
 const cancel=()=>{child.kill('SIGTERM');timer=setTimeout(()=>child.kill('SIGKILL'),1000);timer.unref();};
 signal?.addEventListener('abort',cancel,{once:true});
 if(signal?.aborted)cancel();
 try{await new Promise((resolve,reject)=>{child.once('error',()=>reject(Error('Stock archive extraction could not start.')));child.once('close',code=>code===0?resolve():reject(Error('Stock archive extraction failed.')));});signal?.throwIfAborted();}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
}

// spec comes from the application manifest, never from the selected payload.
async function installArchive({archive,destination,spec,signal}){
 if(!path.isAbsolute(archive)||!path.isAbsolute(destination)||!/^[-a-zA-Z0-9_.]+$/.test(spec.root)||['.','..'].includes(spec.root)||!/^[a-f0-9]{64}$/.test(spec.sha256))throw Error('Invalid stock archive specification.');
 signal?.throwIfAborted();
 if(await hashFile(archive,signal)!==spec.sha256)throw Error('Stock archive SHA-256 mismatch.');
 const parent=path.dirname(destination),journal=path.join(parent,`.extract-${path.basename(destination)}.json`);
 let pending;
 try{
  const stat=await fsp.lstat(journal);if(!stat.isFile()||stat.isSymbolicLink())throw Error('Invalid extraction recovery record.');
  pending=readJson(journal);
 }catch(error){if(error.code!=='ENOENT')throw error;}
 if(pending!==undefined){
  if(!pending||pending.version!==1||pending.sha256!==spec.sha256||pending.root!==spec.root||pending.destination!==path.basename(destination)||
    !/^\.extract-[a-f0-9]{32}$/.test(pending.temporary)||!Number.isSafeInteger(pending.pid)||pending.pid<1)
   throw Error('Invalid extraction recovery record; existing files were preserved.');
  let alive=true;try{process.kill(pending.pid,0);}catch(error){if(error.code==='ESRCH')alive=false;else throw error;}
  if(alive)throw Error('Another extraction is still running.');
  const stale=path.join(parent,pending.temporary);
  let stat;try{stat=await fsp.lstat(stale);}catch(error){if(error.code!=='ENOENT')throw error;}
  if(stat){if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Extraction recovery directory changed; files were preserved.');await fsp.rm(stale,{recursive:true});}
  await fsp.unlink(journal);
 }
 let exists=false;
 try{await fsp.lstat(destination);exists=true;}catch(error){if(error.code!=='ENOENT')throw error;}
 if(exists)return verifyInstalled(destination,spec,signal);
 await fsp.mkdir(parent,{recursive:true,mode:0o700});
 const temporaryName='.extract-'+crypto.randomBytes(16).toString('hex'),temporary=path.join(parent,temporaryName);
 // Persist intent before materializing the directory, so even a kill between
 // mkdir and tar can be attributed. A live owner is never cleaned by a retry.
 writeJson(journal,{version:1,sha256:spec.sha256,root:spec.root,destination:path.basename(destination),temporary:temporaryName,pid:process.pid});
 try{
  await fsp.mkdir(temporary,{mode:0o700});
  await extract(archive,temporary,signal);
  const roots=await fsp.readdir(temporary);
  if(roots.length!==1||roots[0]!==spec.root)throw Error('Unexpected stock archive layout.');
  const entries=await inventory(temporary,signal);
  writeJson(path.join(temporary,'.installed.json'),{sha256:spec.sha256,root:spec.root,entries});
  signal?.throwIfAborted();
  // A complete nonempty runtime is never replaced. Interrupted extraction stays
  // in a separate staging directory and cannot become the active runtime.
  await fsp.rename(temporary,destination);
  const parent=await fsp.open(path.dirname(destination),'r');try{await parent.sync();}finally{await parent.close();}
  return destination;
 }finally{
  await fsp.rm(temporary,{recursive:true,force:true});
  await fsp.unlink(journal);
 }
}
module.exports={installArchive,hashFile,verifyInstalled};
