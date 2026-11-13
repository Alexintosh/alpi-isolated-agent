const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {createHash}=require('node:crypto'),{createRequire}=require('node:module');
const file=path.resolve(__dirname,'../src/runtime/desktop-image-store.cjs');
function fixture(t,{acquire}={}) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'image-store-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const bytes=Buffer.from('synthetic image fixture'),source=path.join(root,'source.tar');fs.writeFileSync(source,bytes);
 const catalog=require('../src/runtime/desktop-images.cjs');
 const profiles=catalog.DESKTOP_IMAGES.map(item=>item.id==='local-arm64'?{...item,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}:item);
 const native=createRequire(file),mocks={
  './desktop-images.cjs':{DESKTOP_IMAGES:profiles,desktopImage:id=>{const item=profiles.find(x=>x.id===id);if(!item)throw Error('Unknown desktop image.');return item}},
  ...(acquire?{'./artifact-download.cjs':{acquireLocalArtifact:acquire}}:{}),
 };
 const context={require:id=>mocks[id]??native(id),module:{exports:{}},AbortController};
 vm.runInNewContext(fs.readFileSync(file,'utf8'),context,{filename:file});
 const store=new context.module.exports.DesktopImageStore({stateRoot:path.join(root,'state'),artifactRoot:path.join(root,'artifacts')});
 return {root,source,bytes,store};
}
test('optional image import verifies bytes, reports progress and stays outside runtime releases',async t=>{
 const {root,source,bytes,store}=fixture(t);const events=[];store.on('change',()=>events.push({...store.state}));
 assert.equal(store.available('local-arm64'),false);assert.equal(await store.importLocal(source),true);
 assert.deepEqual(fs.readFileSync(store.localArchive),bytes);assert.equal(fs.statSync(store.localArchive).mode&0o777,0o600);
 assert.equal(store.state.busy,false);assert.equal(store.state.phase,'ready');assert(events.some(x=>x.phase==='copying'));
 store.artifactRoot=path.join(root,'new-release');assert.equal(store.available('local-arm64'),true);
 const snapshot=JSON.stringify(store.snapshot('stock-amd64'));assert(!snapshot.includes(root));
});
test('invalid existing image is preserved and a failed import cannot claim success',async t=>{
 const {source,store}=fixture(t);fs.mkdirSync(path.dirname(store.localArchive),{recursive:true});
 fs.writeFileSync(store.localArchive,'preserve wrong bytes');assert.equal(await store.importLocal(source),false);
 assert.equal(fs.readFileSync(store.localArchive,'utf8'),'preserve wrong bytes');assert.equal(store.state.phase,'error');assert.equal(store.state.busy,false);
 assert.throws(()=>store.archive('http://untrusted.invalid/image'),/Unknown desktop image/);
});
test('cancellation aborts the importer and overlapping acquisition is rejected',async t=>{
 let started;const began=new Promise(resolve=>started=resolve);
 const {source,store}=fixture(t,{acquire:({signal,sha256,maxBytes,destination})=>new Promise((resolve,reject)=>{
  assert.match(sha256,/^[a-f0-9]{64}$/);assert(maxBytes>0);assert(destination.endsWith('wrapvm-local-arm64.tar'));
  signal.addEventListener('abort',()=>reject(Error('abort')),{once:true});started();
 })});
 const importing=store.importLocal(source);await began;
 await assert.rejects(store.importLocal(source),/already in progress/);store.cancel();await importing;
 assert.equal(store.state.busy,false);assert.equal(store.state.phase,'idle');assert.equal(store.state.error,null);assert.equal(store.available('local-arm64'),false);
});
