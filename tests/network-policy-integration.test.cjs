const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { once } = require('node:events');
const { Network } = require('../src/runtime/network.cjs');
const { NetworkPolicy } = require('../src/runtime/network-policy.cjs');
const binary = path.resolve(__dirname,'../vendor/m0/iron-bin/iron-proxy');
const address = Object.values(os.networkInterfaces()).flat().find(x=>x.family==='IPv4' && !x.internal && /^192\.168\./.test(x.address))?.address;
const available = process.platform==='darwin' && process.arch==='arm64' && fs.existsSync(binary) && address;
function waitPending(policy) {
 const ready=()=>policy.snapshot().events.find(x=>x.status==='pending');
 if(ready()) return Promise.resolve(ready());
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{policy.removeListener('change',check);reject(new Error('No pending request'))},3000);
  function check(){const found=ready();if(found){clearTimeout(timer);policy.removeListener('change',check);resolve(found)}}
  policy.on('change',check);
 });
}
test('stock Iron plus persistent policy holds and releases POST once; revocation closes an open stream', {skip:!available}, async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'iron-policy-live-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let hits=0;
 const upstream=http.createServer((req,res)=>{hits++;req.resume();if(req.url==='/stream'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: canary\n\n')}else res.end('fixture-ok')});
 upstream.listen(0,address);await once(upstream,'listening');
 t.after(async()=>{upstream.closeAllConnections();await new Promise(r=>upstream.close(r))});
 const origin=`http://${address}:${upstream.address().port}`;
 const reservation=net.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(r=>reservation.close(r));
 const policy=new NetworkPolicy({stateRoot:root,environmentIds:['fixture-v1'],timeoutMs:1000});t.after(()=>policy.close());
 const network=new Network({stateRoot:root,ironBinary:binary,decide:policy.decide});
 const guard=await network.open({id:'fixture-v1',kind:'smolvm',proxyPort:port});t.after(()=>guard.close());
 function request(route='/post'){
  let req;
  const result=new Promise((resolve,reject)=>{
   req=http.request({host:'127.0.0.1',port,path:origin+route,method:'POST',headers:{Host:new URL(origin).host}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode))});
   req.on('error',reject);req.setTimeout(5000,()=>req.destroy(new Error('Request timeout')));req.end('canary');
  });return {req,result};
 }
 let work=request();let event=await waitPending(policy);assert.equal(hits,0);policy.respond(event.id,'once');
 assert.equal(await work.result,200);assert.equal(hits,1);assert.equal(policy.respond(event.id,'once'),false);
 work=request();event=await waitPending(policy);policy.respond(event.id,'deny');assert.equal(await work.result,403);assert.equal(hits,1);
 work=request();await waitPending(policy);assert.equal(await work.result,403);assert.equal(hits,1);
 work=request();const cancelled=work.result.catch(()=>{});await waitPending(policy);work.req.destroy();await cancelled;
 // Stock gRPC cancellation propagates asynchronously; wait for its actual event.
 while(policy.pending.size) await once(policy,'change');assert.equal(hits,1);
 // Raw request targets go through stock Iron; do not normalize them in the client.
 const pathRule=policy.addRule({environmentId:'fixture-v1',scheme:'http',host:address,port:upstream.address().port,method:'POST',pathname:'/post'});
 assert.equal(await request('/b/../post').result,400); // stock rejects before callback
 assert.equal(await request('/b/%2e%2e/post').result,400);
 assert.equal(await request(`//${new URL(origin).host}/post`).result,403);
 assert.equal(hits,1);policy.revoke(pathRule);
 const ruleId=policy.addRule({environmentId:'fixture-v1',scheme:'http',host:address,port:upstream.address().port});
 let stream, response;
 const data=new Promise((resolve,reject)=>{
  stream=http.get({host:'127.0.0.1',port,path:origin+'/stream',headers:{Host:new URL(origin).host}},res=>{response=res;res.once('data',resolve);res.on('error',()=>{})});stream.on('error',reject);
 });
 await data;assert.equal(hits,2);const closed=new Promise(resolve=>response.once('close',resolve));
 policy.revoke(ruleId);await network.quarantine('fixture-v1');await closed;
 assert(guard.healthy());assert.equal(policy.snapshot().rules.length,0);
 assert.equal(await request().result,403);
 assert.equal(hits,2);
});
