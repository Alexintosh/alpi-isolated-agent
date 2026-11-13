const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Coordinator}=require('../src/runtime/coordinator.cjs');
function fixture(t) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'environment-management-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const calls=[];let state='missing',identity,guard,stopError,removeError;
 const driver={
  async inspect({ownershipToken}){return {state,owned:identity===ownershipToken,protected:state==='running'&&guard?.healthy()};},
  async prepare({ownershipToken}){calls.push('prepare');identity=ownershipToken;state='created';},
  async start({network}){calls.push('start');guard=network;state='running';},
  async stop(){calls.push('stop');if(stopError)throw Error('stop failed');state='stopped';},
  async remove({ownershipToken}){calls.push('remove');assert.equal(ownershipToken,identity);assert.equal(state,'stopped');if(removeError)throw Error('remove failed');state='missing';},
  async connect(){return {close:async()=>calls.push('lease-close')};}
 };
 const options={stateRoot:root,definitions:[{id:'test-v1',name:'Fixture'}],drivers:new Map([['test-v1',driver]]),network:{open:async()=>{let live=true;calls.push('guard-open');return {healthy:()=>live,close:async()=>{live=false;calls.push('guard-close');}};}}};
 const coordinator=new Coordinator(options);
 return {coordinator,driver,calls,options,get state(){return state},set foreign(v){identity=v},set stopError(v){stopError=v},set removeError(v){removeError=v}};
}
test('restart retains identity and data preparation, closes lease, stops before replacing protection',async t=>{
 const f=fixture(t),c=f.coordinator;await c.start('test-v1');await c.connect('test-v1');
 const token=c.journal.environments['test-v1'].ownershipToken;f.calls.length=0;
 await c.restart('test-v1');assert.equal(f.state,'running');assert.equal(c.journal.environments['test-v1'].ownershipToken,token);
 assert.deepEqual(f.calls,['lease-close','stop','guard-close','guard-open','start']);
});
test('restart refuses missing, foreign and failed stop without deleting or starting',async t=>{
 const f=fixture(t),c=f.coordinator;await assert.rejects(c.restart('test-v1'),/Create/);
 await c.start('test-v1');f.calls.length=0;f.stopError=true;await assert.rejects(c.restart('test-v1'),/stop failed/);
 assert.deepEqual(f.calls,['stop']);assert(c.guards.get('test-v1').healthy());
 f.foreign='foreign';await assert.rejects(c.recreate('test-v1'),/not owned/);assert(!f.calls.includes('remove'));
});
test('recreation orders stop, grant revocation and removal, rotates identity and waits for explicit Connect',async t=>{
 const f=fixture(t),c=f.coordinator;await c.start('test-v1');await c.connect('test-v1');
 const token=c.journal.environments['test-v1'].ownershipToken;c.beforeRecreate=()=>f.calls.push('revoke-shares');f.calls.length=0;
 await c.recreate('test-v1');assert.deepEqual(f.calls,['lease-close','stop','guard-close','revoke-shares','remove']);
 assert.equal(f.state,'missing');assert.notEqual(c.journal.environments['test-v1'].ownershipToken,token);
 assert.equal(c.snapshot()[0].phase,'new');assert.equal(c.snapshot()[0].prepared,false);assert.equal(c.snapshot()[0].resetPending,false);
 await c.start('test-v1');assert.equal(f.state,'running');assert.equal(f.calls.filter(v=>v==='prepare').length,1);
});
test('failed deletion remains pending across process restart; start/prepare/connect cannot bypass it',async t=>{
 const f=fixture(t),c=f.coordinator;await c.start('test-v1');const token=c.journal.environments['test-v1'].ownershipToken;
 f.removeError=true;await assert.rejects(c.recreate('test-v1'),/remove failed/);
 const recovered=new Coordinator(f.options);await recovered.reconcile();assert(recovered.snapshot()[0].resetPending);
 for(const method of ['start','prepare','connect','restart'])await assert.rejects(recovered[method]('test-v1'),/Recreation is incomplete/);
 assert.equal(recovered.journal.environments['test-v1'].ownershipToken,token);
 f.removeError=false;await recovered.recreate('test-v1');assert(!recovered.snapshot()[0].resetPending);
});
test('preflight refusal has no destructive intent or stop; cleanup failure prevents removal',async t=>{
 const f=fixture(t),c=f.coordinator;await c.start('test-v1');f.calls.length=0;
 c.checkRecreate=()=>{throw Error('transfers pending')};await assert.rejects(c.recreate('test-v1'),/transfers/);
 assert.equal(c.snapshot()[0].resetPending,false);assert.deepEqual(f.calls,[]);
 c.checkRecreate=undefined;c.beforeRecreate=()=>{throw Error('share persistence failed')};await assert.rejects(c.recreate('test-v1'),/share persistence/);
 assert(c.snapshot()[0].resetPending);assert(!f.calls.includes('remove'));
});
test('cancellation after removal retains old token and requires explicit recovery from verified absence',async t=>{
 const f=fixture(t),c=f.coordinator;await c.start('test-v1');const token=c.journal.environments['test-v1'].ownershipToken;
 const controller=new AbortController(),remove=f.driver.remove;
 f.driver.remove=async opts=>{await remove(opts);controller.abort();};
 await assert.rejects(c.recreate('test-v1',{signal:controller.signal}));
 assert.equal(f.state,'missing');assert.equal(c.journal.environments['test-v1'].ownershipToken,token);assert(c.snapshot()[0].resetPending);
 const recovered=new Coordinator(f.options);await recovered.reconcile();await assert.rejects(recovered.start('test-v1'),/Recreation/);
 f.driver.remove=async()=>{assert.equal(f.state,'missing')};await recovered.recreate('test-v1');assert(!recovered.snapshot()[0].resetPending);
});
test('late replacement after remove is not adopted and does not rotate ownership',async t=>{
 const f=fixture(t),c=f.coordinator;await c.start('test-v1');const token=c.journal.environments['test-v1'].ownershipToken;
 f.driver.remove=async()=>{f.foreign='someone-else'};await assert.rejects(c.recreate('test-v1'),/not owned/);
 assert.equal(c.journal.environments['test-v1'].ownershipToken,token);assert(c.snapshot()[0].resetPending);
});
