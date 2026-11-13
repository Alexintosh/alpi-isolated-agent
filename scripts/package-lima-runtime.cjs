// Build-time packaging from the already verified stock installation. Runtime
// use needs only these copied files and macOS binaries/frameworks, not Homebrew.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const manifest=require('../src/runtime/lima-artifacts.cjs');
const target=path.resolve(__dirname,'../vendor/v1/lima/bin');
const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
fs.mkdirSync(target,{recursive:true,mode:0o700});
for(const artifact of manifest.files){
 if(digest(artifact.source)!==artifact.sha256)throw Error('Installed Lima artifact does not match the pinned stock bytes.');
 const destination=path.join(target,artifact.name);
 if(fs.existsSync(destination)){
  if(!fs.lstatSync(destination).isFile()||fs.lstatSync(destination).isSymbolicLink()||digest(destination)!==artifact.sha256)
   throw Error('Packaged Lima artifact differs; no overwrite.');
  continue;
 }
 const temporary=path.join(target,'.copy-'+crypto.randomBytes(12).toString('hex'));
 try{
  fs.copyFileSync(artifact.source,temporary,fs.constants.COPYFILE_EXCL);fs.chmodSync(temporary,0o755);
  if(digest(temporary)!==artifact.sha256)throw Error('Copied Lima artifact differs.');
  const fd=fs.openSync(temporary,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.linkSync(temporary,destination);
 }finally{fs.rmSync(temporary,{force:true});}
}
const fd=fs.openSync(target,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
console.log('Pinned stock Lima runtime packaged without changing its bytes.');
