const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execFileSync,spawn}=require('node:child_process');
const {once}=require('node:events');
const {installArchive,hashFile}=require('../src/runtime/archive-install.cjs');
async function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'archive-install-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source=path.join(root,'source');fs.mkdirSync(path.join(source,'runtime/bin'),{recursive:true});
 fs.writeFileSync(path.join(source,'runtime/bin/tool'),'fixture',{mode:0o755});
 fs.symlinkSync('/usr/local/bin/guest-only',path.join(source,'runtime/guest-link'));
 const archive=path.join(root,'stock.tar.gz');execFileSync('/usr/bin/tar',['-czf',archive,'-C',source,'runtime'],{env:{PATH:'/usr/bin:/bin',COPYFILE_DISABLE:'1'}});
 return {root,archive,destination:path.join(root,'installed'),spec:{root:'runtime',sha256:await hashFile(archive)}};
}
test('pinned extraction preserves stock links, verifies reuse and refuses changed content',async t=>{
 const f=await fixture(t);await installArchive(f);
 assert.equal(fs.readlinkSync(path.join(f.destination,'runtime/guest-link')),'/usr/local/bin/guest-only');
 assert.equal(fs.statSync(f.destination).mode&0o777,0o700);
 await installArchive(f);
 const target=path.join(f.destination,'runtime/bin/tool');fs.writeFileSync(target,'changed');
 await assert.rejects(installArchive(f),/file changed/);assert.equal(fs.readFileSync(target,'utf8'),'changed');
});
test('hash, layout, cancellation and existing destination failures preserve files and remove staging',async t=>{
 const f=await fixture(t);
 await assert.rejects(installArchive({...f,spec:{...f.spec,sha256:'0'.repeat(64)}}),/SHA-256/);
 await assert.rejects(installArchive({...f,spec:{...f.spec,root:'other'}}),/layout/);
 await assert.rejects(installArchive({...f,signal:AbortSignal.abort()}));
 assert(!fs.existsSync(f.destination));assert(!fs.readdirSync(f.root).some(x=>x.startsWith('.extract-')));
 fs.mkdirSync(f.destination);fs.writeFileSync(path.join(f.destination,'keep'),'same');
 await assert.rejects(installArchive(f));assert.equal(fs.readFileSync(path.join(f.destination,'keep'),'utf8'),'same');
});
test('archive symlinks and installed-root symlinks are refused',async t=>{
 const f=await fixture(t),link=path.join(f.root,'alias');fs.symlinkSync(f.archive,link);
 await assert.rejects(installArchive({...f,archive:link}));
 fs.symlinkSync(path.join(f.root,'source'),f.destination);
 await assert.rejects(installArchive(f),/private directory/);
 assert.equal(fs.readFileSync(path.join(f.root,'source/runtime/bin/tool'),'utf8'),'fixture');
});
test('a killed extraction owner leaves attributed staging that retry removes before publication',async t=>{
 const f=await fixture(t),name='.extract-'+'a'.repeat(32),stale=path.join(f.root,name),journal=path.join(f.root,'.extract-installed.json');
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
 fs.mkdirSync(stale);fs.writeFileSync(path.join(stale,'partial'),'abandoned');
 fs.writeFileSync(journal,JSON.stringify({version:1,...f.spec,destination:'installed',temporary:name,pid:child.pid}));
 await assert.rejects(installArchive(f),/still running/);assert(fs.existsSync(stale));
 child.kill('SIGKILL');await once(child,'exit');
 await installArchive(f);assert(!fs.existsSync(stale));assert(!fs.existsSync(journal));assert(!fs.existsSync(path.join(f.destination,'partial')));
});
