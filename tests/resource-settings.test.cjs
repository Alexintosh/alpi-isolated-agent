const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {ResourceSettings}=require('../src/runtime/resource-settings.cjs');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'resource-settings-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {stateRoot:root,definitions:[{id:'lima-v1',kind:'lima'},{id:'wrapvm-v1',kind:'smolvm'}],cpus:8,memory:16*1024**3};}
test('resource choices persist only after confirmed stop and cannot mutate through caller references',async t=>{
 const settings=fixture(t);let stop,called=false;const waiting=new Promise(r=>stop=r);
 const manager=new ResourceSettings({...settings,coordinator:{withStopped:async(id,fn)=>{assert.equal(id,'lima-v1');called=true;await waiting;return fn({inspect:async()=>({state:'missing'})},{});}}});
 const input={cpus:3,memoryMiB:3072},pending=manager.set('lima-v1',input);input.cpus=8;
 assert(called);assert(!fs.existsSync(manager.file));stop();await pending;
 const restored=new ResourceSettings({...settings,coordinator:{}});
 assert.deepEqual(restored.forEnvironment('lima-v1'),{cpus:3,memoryMiB:3072,diskGiB:20});
 assert.deepEqual(restored.forEnvironment('wrapvm-v1'),{cpus:2,memoryMiB:4096,diskGiB:20,overlayGiB:10});
 const external=restored.forEnvironment('lima-v1');external.cpus=8;assert.equal(restored.forEnvironment('lima-v1').cpus,3);
});
test('Lima disk choice is initial-only; WrapVM only grows beyond both saved and observed sizes',async t=>{
 const settings=fixture(t);let observed={state:'missing'};
 const manager=new ResourceSettings({...settings,coordinator:{withStopped:async(_id,fn)=>fn({inspect:async()=>observed},{})}});
 await manager.set('lima-v1',{cpus:2,memoryMiB:4096,diskGiB:24});assert.equal(manager.forEnvironment('lima-v1').diskGiB,24);
 observed={state:'stopped',owned:true,resources:{diskGiB:24}};
 await assert.rejects(manager.set('lima-v1',{cpus:2,memoryMiB:4096,diskGiB:25}),/before the environment/);
 await manager.set('lima-v1',{cpus:3,memoryMiB:4096});assert.equal(manager.forEnvironment('lima-v1').diskGiB,24);
 observed={state:'stopped',owned:true,resources:{diskGiB:20,overlayGiB:10}};
 await manager.set('wrapvm-v1',{cpus:2,memoryMiB:4096,diskGiB:21,overlayGiB:11});
 await assert.rejects(manager.set('wrapvm-v1',{cpus:2,memoryMiB:4096,diskGiB:20,overlayGiB:10}),/only increase/);
 observed.resources={diskGiB:22,overlayGiB:11};await assert.rejects(manager.set('wrapvm-v1',{cpus:2,memoryMiB:4096}),/only increase/);
 assert.equal(manager.forEnvironment('wrapvm-v1').diskGiB,21);
 observed.owned=false;await assert.rejects(manager.set('wrapvm-v1',{cpus:2,memoryMiB:4096,diskGiB:23,overlayGiB:12}),/ownership/);
});
test('failed stop and invalid choices preserve existing settings',async t=>{
 const settings=fixture(t),manager=new ResourceSettings({...settings,coordinator:{withStopped:async()=>{throw Error('stop failed')}}});
 await assert.rejects(manager.set('lima-v1',{cpus:3,memoryMiB:3072}),/stop failed/);assert(!fs.existsSync(manager.file));
 for(const value of [{cpus:0,memoryMiB:4096},{cpus:9,memoryMiB:4096},{cpus:2,memoryMiB:1536},{cpus:2,memoryMiB:16384},{cpus:2,memoryMiB:3000},{cpus:2,memoryMiB:4096,mount:'/host'}])
  await assert.rejects(manager.set('lima-v1',value),/displayed limits/);
});
test('corrupt settings fail closed for starts while preserving the coordinator and bytes',async t=>{
 const settings=fixture(t);fs.writeFileSync(path.join(settings.stateRoot,'resources.json'),'{bad');
 let stopped=false;const manager=new ResourceSettings({...settings,coordinator:{shutdown:async()=>{stopped=true}}});
 assert.equal(manager.snapshot().fault,true);assert.throws(()=>manager.forEnvironment('lima-v1'),/VM stop/);
 await assert.rejects(manager.set('lima-v1',{cpus:2,memoryMiB:4096}),/preserved/);
 await manager.coordinator.shutdown();assert(stopped);assert.equal(fs.readFileSync(manager.file,'utf8'),'{bad');
});
