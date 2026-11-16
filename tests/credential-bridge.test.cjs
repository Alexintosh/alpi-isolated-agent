const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),net=require('node:net');
const {once}=require('node:events');
const {Network}=require('../src/runtime/network.cjs');
const {createCredentialBridge}=require('../src/runtime/credential-bridge.cjs');
const {NetworkPolicy}=require('../src/runtime/network-policy.cjs');
const binary=path.resolve(__dirname,'../vendor/m0/iron-bin/iron-proxy');
const address=Object.values(os.networkInterfaces()).flat().find(x=>x.family==='IPv4'&&!x.internal&&/^192\.168\./.test(x.address))?.address;
const available=process.platform==='darwin'&&process.arch==='arm64'&&fs.existsSync(binary)&&address;
async function freePort(){const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p}
async function response(url,options={}){const result=await fetch(url,options);return {status:result.status,headers:Object.fromEntries(result.headers),body:await result.text()}}

test('real Iron injects only bridge-owned requests; reflected keys filtered without buffering the whole SSE', {skip:!available}, async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'credential-bridge-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const secret='canary-key-only-on-host-61f7aa';let hits=0,mode='json',received,reads=0;
 const upstream=http.createServer((req,res)=>{
  hits++;received={authorization:req.headers.authorization,privateHeaders:Object.keys(req.headers).filter(x=>x.startsWith('x-isolated-'))};req.resume();
  if(req.url==='/gateway/models'){res.writeHead(200,{'content-type':'application/json'});res.end('{"noAuth":true}');return}
  if(mode==='compressed'){res.writeHead(200,{'content-type':'application/json','content-encoding':'gzip'});res.end(secret);return}
  if(mode==='redirect'){res.writeHead(307,{location:'http://example.invalid/'+secret});res.end(secret);return}
  if(mode==='stream'){
   res.writeHead(200,{'content-type':'text/event-stream','x-reflected-secret':secret,'set-cookie':'secret='+secret});
   res.write('data: {"text":"first"}\n\n');
   setTimeout(()=>res.write('data: {"text":"'+secret.slice(0,8)),30);
   setTimeout(()=>res.end(secret.slice(8)+'"}\n\ndata: [DONE]\n\n'),250);return;
  }
  res.writeHead(mode==='error'?401:200,{'content-type':'application/json','x-reflected-secret':secret,'set-cookie':'secret='+secret});
  res.end(JSON.stringify({echo:secret,data:[{id:'fixture-model'}]}));
 });
 upstream.listen(0,address);await once(upstream,'listening');t.after(async()=>{upstream.closeAllConnections();await new Promise(r=>upstream.close(r))});
 const proxyPort=await freePort();
 const provider={id:'fixture',api:'openai-completions',baseURL:`http://${address}:${upstream.address().port}/v1`,models:[{id:'fixture-model'}],credentialRef:'fixture/key'};
 const unauthenticated={...provider,id:'no-auth',authMode:'none',baseURL:`http://${address}:${upstream.address().port}/gateway`};delete unauthenticated.credentialRef;
 let bridge;
 const network=new Network({stateRoot:root,ironBinary:binary,decide:async()=>true,credentialBridge:async({caFile})=>bridge=await createCredentialBridge({environmentId:'fixture-v1',providers:[provider,unauthenticated],vault:{get:async()=>{reads++;return secret}},proxyPort,caFile,decide:async()=>true})});
 const guard=await network.open({id:'fixture-v1',kind:'smolvm',proxyPort});t.after(()=>guard.close());
 const guest=bridge.guestProviders(`http://127.0.0.1:${bridge.port}`)[0];
 const base=guest.provider.baseURL,options={headers:{Authorization:`Bearer ${guest.token}`}};
 let result=await response(base+'/models',options);
 assert.equal(result.status,200,JSON.stringify(result));assert.equal(received.authorization,'Bearer '+secret);assert.deepEqual(received.privateHeaders,[]);
 assert(!JSON.stringify(result).includes(secret));assert(result.body.includes('[redacted]'));assert(!result.headers['set-cookie']);
 const noAuth=bridge.guestProviders(`http://127.0.0.1:${bridge.port}`)[1],beforeNoAuth=reads;
 const noAuthResult=await response(noAuth.provider.baseURL+'/models',{headers:{Authorization:`Bearer ${noAuth.token}`}});
 assert.equal(noAuthResult.status,200);assert.deepEqual(JSON.parse(noAuthResult.body),{noAuth:true});
 assert.equal(reads,beforeNoAuth);assert.equal(received.authorization,undefined);assert.deepEqual(received.privateHeaders,[]);
 const before=hits;
 assert.equal((await response(base+'/models',{headers:{Authorization:'Bearer another-environment-token'}})).status,401);
 assert.equal((await response(base+'/../../arbitrary',options)).status,404);assert.equal(hits,before);
 // A guest knows its substitute but not the per-request host capability. Iron
 // must never turn that direct request into real credentials.
 const direct=await new Promise((resolve,reject)=>{const req=http.get({host:'127.0.0.1',port:proxyPort,path:provider.baseURL+'/models',headers:{Host:new URL(provider.baseURL).host,Authorization:`Bearer ${guest.token}`,'x-isolated-request':'guessed'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode))});req.on('error',reject)});
 assert.equal(direct,403);assert.equal(hits,before);
 mode='error';result=await response(base+'/models',options);assert.equal(result.status,401);assert(!JSON.stringify(result).includes(secret));
 mode='redirect';result=await response(base+'/models',options);assert.equal(result.status,502);assert(!JSON.stringify(result).includes(secret));
 mode='compressed';result=await response(base+'/models',options);assert.equal(result.status,502);assert(!JSON.stringify(result).includes(secret));
 mode='stream';const started=Date.now();const stream=await fetch(base+'/chat/completions',{method:'POST',headers:{...options.headers,'Content-Type':'application/json'},body:JSON.stringify({model:'fixture-model',messages:[],stream:true})});
 const reader=stream.body.getReader();const first=await reader.read();assert(Date.now()-started<200);assert(Buffer.from(first.value).toString().includes('first'));
 let text=Buffer.from(first.value).toString();while(true){const item=await reader.read();if(item.done)break;text+=Buffer.from(item.value).toString()}
 assert(Date.now()-started>=200);assert(!text.includes(secret));assert(text.includes('[redacted]'));assert(text.includes('[DONE]'));
 const beforeBad=hits;
 result=await response(base+'/chat/completions',{method:'POST',headers:{...options.headers,'Content-Type':'application/json'},body:JSON.stringify({model:'not-authorized',messages:[]})});assert.equal(result.status,400);assert.equal(hits,beforeBad);
 const mediatorAddress=guard.mediator.address, mediatorToken=guard.mediator.token;
 const resetting=network.quarantine('fixture-v1');assert(!guard.healthy());await resetting;
 assert(guard.healthy());assert.equal(guard.mediator.address,mediatorAddress);assert.equal(guard.mediator.token,mediatorToken);
 assert.equal((await response(base+'/models',options)).status,200,'same guest substitute survives a proxy-only reset');
 await guard.close();await assert.rejects(response(base+'/models',options));assert(!guard.healthy());
 const restarted=await network.open({id:'fixture-v1',kind:'smolvm',proxyPort});t.after(()=>restarted.close());
 const renewed=bridge.guestProviders(`http://127.0.0.1:${bridge.port}`)[0];assert.notEqual(renewed.token,guest.token);
 assert.equal((await response(renewed.provider.baseURL+'/models',options)).status,401);
});

test('bridge uses the product policy before injection and revocation interrupts an unfinished SSE', {skip:!available}, async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-policy-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const secret='synthetic-policy-canary';let hits=0,authenticated=0,upstreamClosed;
 const upstream=http.createServer((req,res)=>{
  hits++;if(req.headers.authorization==='Bearer '+secret)authenticated++;req.resume();
  if(req.url==='/v1/chat/completions'){
   upstreamClosed=once(res,'close');res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: first\n\n');
   // Deliberately never finishes: revocation must close this active stream.
  }else res.end('{"data":[]}');
 });
 upstream.listen(0,address);await once(upstream,'listening');t.after(async()=>{upstream.closeAllConnections();await new Promise(r=>upstream.close(r))});
 const policy=new NetworkPolicy({stateRoot:root,environmentIds:['fixture-v1'],timeoutMs:5000});t.after(()=>policy.close());
 const proxyPort=await freePort(),provider={id:'fixture',api:'openai-completions',baseURL:`http://${address}:${upstream.address().port}/v1`,models:[{id:'fixture-model'}],credentialRef:'fixture/key'};
 let bridge;
 const network=new Network({stateRoot:root,ironBinary:binary,decide:policy.decide,credentialBridge:async({caFile})=>bridge=await createCredentialBridge({environmentId:'fixture-v1',providers:[provider],vault:{get:async()=>secret},proxyPort,caFile,decide:policy.decide})});
 const guard=await network.open({id:'fixture-v1',kind:'smolvm',proxyPort});t.after(()=>guard.close());
 const guest=bridge.guestProviders(`http://127.0.0.1:${bridge.port}`)[0];
 const options={headers:{Authorization:`Bearer ${guest.token}`},signal:AbortSignal.timeout(10000)};
 async function pending(){
  const current=()=>policy.snapshot().events.find(item=>item.status==='pending');
  if(current())return current();
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{policy.removeListener('change',check);reject(new Error('Missing pending policy request'))},3000);
   function check(){const event=current();if(event){clearTimeout(timer);policy.removeListener('change',check);resolve(event)}}
   policy.on('change',check);
  });
 }
 const allowed=response(guest.provider.baseURL+'/models',options);const first=await pending();
 assert.equal(hits,0);assert.equal(authenticated,0);
 assert(!JSON.stringify(policy.snapshot()).includes(secret));assert(!JSON.stringify(policy.snapshot()).includes(guest.token));
 assert(policy.respond(first.id,'once'));assert.equal((await allowed).status,200);assert.equal(hits,1);assert.equal(authenticated,1);
 const denied=response(guest.provider.baseURL+'/models',options);const second=await pending();
 policy.respond(second.id,'deny');const deniedResult=await denied;assert.equal(deniedResult.status,424);
 assert.match(deniedResult.body,/network_policy_denied/);assert.equal(hits,1);
 const streamRequest=fetch(guest.provider.baseURL+'/chat/completions',{method:'POST',headers:{...options.headers,'Content-Type':'application/json'},body:JSON.stringify({model:'fixture-model',messages:[],stream:true}),signal:AbortSignal.timeout(10000)});
 await pending();assert.equal(hits,1);
 const ruleId=policy.addRule({environmentId:'fixture-v1',scheme:'http',host:address,port:upstream.address().port,method:'POST',pathname:'/v1/chat/completions'});
 const stream=await streamRequest;assert.equal(stream.status,200);const reader=stream.body.getReader();
 assert(Buffer.from((await reader.read()).value).toString().includes('first'));assert.equal(hits,2);assert.equal(authenticated,2);
 const interrupted=assert.rejects(reader.read());
 let revoked;policy.on('revoke-environment',id=>{revoked=network.quarantine(id)});
 policy.revoke(ruleId);await revoked;await interrupted;await upstreamClosed;
 assert(guard.healthy());assert(bridge.healthy());
 assert.equal(guard.status().reason,'policy-changed');
 const afterRevocation=response(guest.provider.baseURL+'/models',options);const third=await pending();
 assert.equal(hits,2,'old permission never leaks through recovery');policy.respond(third.id,'deny');
 assert.equal((await afterRevocation).status,424);assert.equal(hits,2);
});
