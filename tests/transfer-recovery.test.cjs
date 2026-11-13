const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');const {once}=require('node:events');
const {randomUUID,randomBytes,createHash}=require('node:crypto');
const {TransferJournal}=require('../src/runtime/transfer-journal.cjs');
const {FileTransfers}=require('../src/runtime/file-transfers.cjs');
const python=process.platform==='darwin'?'/opt/homebrew/bin/python3':'/usr/bin/python3';
function fixture(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'transfer-recovery-'))),stateRoot=path.join(root,'private');
 fs.mkdirSync(stateRoot);const target=path.join(root,'output'),info=fs.statSync(root);
 const record={id:randomUUID(),transaction:randomBytes(32).toString('hex'),ownershipToken:randomUUID(),environmentId:'test-v1',
  direction:'export',destination:target,parentIdentity:`${info.dev}:${info.ino}`,phase:'receiving',createdAt:Date.now()};
 const settings={stateRoot,runtimeRoot:path.join(root,'runtime'),home:path.join(root,'home'),python,coordinator:{}};
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,stateRoot,target,record,settings};
}
test('SIGKILL leaves a recorded partial export that a fresh manager can explicitly remove',async t=>{
 const {target,record,settings,stateRoot}=fixture(t);new TransferJournal(stateRoot).begin(record);
 const helper=path.resolve(__dirname,'../src/runtime/file-stream.py');
 const child=spawn(python,['-I',helper,'receive',target,'1','1',record.transaction],{stdio:['pipe','pipe','pipe']});
 t.after(()=>child.kill('SIGKILL'));
 const progress=once(child.stdout,'data');
 const messages=[{type:'begin',version:1},{type:'file',path:['partial.txt'],size:1,executable:false},
  {type:'data',value:Buffer.from('x').toString('base64')},{type:'end-file',sha256:createHash('sha256').update('x').digest('hex')}];
 child.stdin.write(messages.map(x=>JSON.stringify(x)+'\n').join(''));
 await progress;const closed=once(child,'close');child.kill('SIGKILL');await closed;
 assert(fs.existsSync(target));const manager=new FileTransfers(settings);
 assert.equal(manager.snapshot().interrupted.length,1);
 assert(!JSON.stringify(manager.snapshot()).includes(record.transaction));
 assert(!JSON.stringify(manager.snapshot()).includes(record.ownershipToken));
 await manager.recover(record.id,'discard');assert(!fs.existsSync(target));
 assert.equal(new FileTransfers(settings).snapshot().interrupted.length,0);
});
test('uncertain commit and replaced outputs are preserved; dismissing only removes metadata',async t=>{
 const {target,record,settings,stateRoot}=fixture(t);const journal=new TransferJournal(stateRoot);journal.begin(record);journal.committing(record.id);
 fs.mkdirSync(target);fs.writeFileSync(path.join(target,'finished.txt'),'keep');
 const manager=new FileTransfers(settings);assert.equal(manager.snapshot().interrupted[0].phase,'committing');
 await assert.rejects(manager.recover(record.id,'discard'));assert.equal(fs.readFileSync(path.join(target,'finished.txt'),'utf8'),'keep');
 assert.equal(manager.snapshot().interrupted.length,1);
 fs.writeFileSync(path.join(target,'.harness-isolated-transfer'),'0'.repeat(64));
 await assert.rejects(manager.recover(record.id,'discard'));
 await manager.recover(record.id,'forget');assert(fs.existsSync(target));assert.equal(manager.snapshot().interrupted.length,0);
});
test('changed export parent and replaced guest identity never authorize deletion',async t=>{
 const {target,record,settings,stateRoot}=fixture(t);record.parentIdentity='0:0';new TransferJournal(stateRoot).begin(record);
 fs.mkdirSync(target);fs.writeFileSync(path.join(target,'.harness-isolated-transfer'),record.transaction);
 const manager=new FileTransfers(settings);await assert.rejects(manager.recover(record.id,'discard'),/parent changed/);assert(fs.existsSync(target));
 const imported={...record,id:randomUUID(),direction:'import',destination:'/home/user/workspace/import'};
 manager.journal.begin(imported);let writes=0;
 manager.coordinator={withRunning:async(_id,operation)=>operation({putFile:async()=>writes++},{ownershipToken:randomUUID()})};
 await assert.rejects(manager.recover(imported.id,'discard'),/original guest/);assert.equal(writes,0);
});
test('journal corruption is not hidden and failed persistence cannot erase the in-memory record',t=>{
 const {record,stateRoot}=fixture(t);const journal=new TransferJournal(stateRoot);journal.begin(record);
 fs.unlinkSync(journal.file);fs.mkdirSync(journal.file);
 assert.throws(()=>journal.remove(record.id));assert.equal(journal.snapshot().length,1);
 fs.rmdirSync(journal.file);fs.writeFileSync(journal.file,'{');assert.throws(()=>new TransferJournal(stateRoot));
});
test('a corrupt journal disables transfers but leaves the runtime coordinator accessible',async t=>{
 const {settings,stateRoot}=fixture(t),file=path.join(stateRoot,'file-transfers.json');fs.writeFileSync(file,'{invalid');
 let stopped=false;settings.coordinator={shutdown:async()=>{stopped=true}};
 const manager=new FileTransfers(settings);assert.equal(manager.snapshot().fault,true);
 await assert.rejects(manager.prepareImport('test-v1','/source','/home/user/workspace','new'),/journal was preserved/);
 await assert.rejects(manager.execute(randomUUID()),/journal was preserved/);
 await manager.coordinator.shutdown();assert(stopped);assert.equal(fs.readFileSync(file,'utf8'),'{invalid');
});
test('runtime construction and coordinator reconciliation survive a corrupt transfer journal',async t=>{
 const root=fs.realpathSync(fs.mkdtempSync('/tmp/transfer-runtime-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const stateRoot=path.join(root,'state');fs.mkdirSync(stateRoot);fs.writeFileSync(path.join(stateRoot,'file-transfers.json'),'{bad');
 const ownershipToken=randomUUID(),definition={id:'fixture-v1',kind:'smolvm',machine:'fixture',owner:'fixture',browser:false};
 fs.writeFileSync(path.join(stateRoot,'environments.json'),JSON.stringify({version:1,environments:{'fixture-v1':{ownershipToken,phase:'running',prepared:true}}}));
 fs.writeFileSync(path.join(stateRoot,'folder-shares.json'),'{bad-shares');
 const runtime=require('../src/runtime/index.cjs').createRuntime({stateRoot,runtimeRoot:path.join(root,'vm'),definitions:[definition]});
 let running=true,stops=0;
 runtime.drivers.set('fixture-v1',{inspect:async()=>({state:running?'running':'stopped',owned:true,protected:false}),stop:async()=>{running=false;stops++}});
 assert(runtime.transfers.snapshot().fault);assert(runtime.shares.snapshot().fault);await runtime.coordinator.reconcile();assert.equal(stops,1);
 await runtime.coordinator.shutdown();assert.equal(runtime.coordinator.snapshot()[0].phase,'stopped');
 assert.equal(fs.readFileSync(path.join(stateRoot,'file-transfers.json'),'utf8'),'{bad');
 assert.equal(fs.readFileSync(path.join(stateRoot,'folder-shares.json'),'utf8'),'{bad-shares');
});
