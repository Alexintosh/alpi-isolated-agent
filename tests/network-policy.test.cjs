const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { NetworkPolicy, normalizeRequest, matches } = require('../src/runtime/network-policy.cjs');
function fixture(t, options = {}) {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'network-policy-'));
 const policy = new NetworkPolicy({stateRoot:root,environmentIds:['a','b'],...options});
 t.after(()=>{policy.close();fs.rmSync(root,{recursive:true,force:true})});return {policy,root};
}
const input = (environmentId='a', options={}) => ({environmentId,request:{method:'POST',host:'example.com',url:'http://example.com/path/private-token?q=secret',headers:{Authorization:{values:['key-canary']}}},...options});
const ruleInput = (options={}) => ({environmentId:'a',scheme:'http',host:'example.com',port:80,...options});
const savedState = policy => JSON.parse(fs.readFileSync(policy.file,'utf8'));
function reload(t, root) {
 const policy = new NetworkPolicy({stateRoot:root,environmentIds:['a','b']});
 t.after(()=>policy.close());return policy;
}

test('authority follows stock Host/TLS semantics, rejects ambiguous absolute URLs and never trusts headers',()=>{
 assert.equal(normalizeRequest(input().request).scheme,'http');
 assert.throws(()=>normalizeRequest({...input().request,url:'https://example.com/'}));
 assert.throws(()=>normalizeRequest({...input().request,host:'other.com'}));
 assert.throws(()=>normalizeRequest({...input().request,host:'user:password@example.com'}));
 assert.equal(normalizeRequest({method:'GET',host:'example.com',url:'/foo'}, {sni:'example.com'}).scheme,'https');
 assert.deepEqual(normalizeRequest({method:'CONNECT',host:'example.com:443',url:'//example.com:443'}),{scheme:'connect',host:'example.com',port:443,method:'CONNECT',pathname:''});
});
test('single approval resolves exactly one request; snapshots and journal exclude URL/headers/body',async t=>{
 const {policy,root}=fixture(t);
 const first=policy.decide(input());const second=policy.decide(input());
 const [one,two]=policy.snapshot().events;
 const serialized=JSON.stringify(policy.snapshot())+fs.readFileSync(policy.file,'utf8');
 for(const secret of ['private-token','q=secret','Authorization','key-canary']) assert(!serialized.includes(secret));
 assert.equal(policy.respond(one.id,'once'),true);assert.equal(await first,true);
 assert.equal(policy.respond(one.id,'once'),false);assert.equal(policy.pending.size,1);
 policy.respond(two.id,'deny');assert.equal(await second,false);assert.equal(policy.snapshot().rules.length,0);
 assert.equal(fs.statSync(policy.file).mode&0o777,0o600);
});
test('saved decisions release original matching requests but stay isolated by environment and origin',async t=>{
 const {policy}=fixture(t);
 const first=policy.decide(input());const second=policy.decide(input());const other=policy.decide(input('b'));
 policy.respond(policy.snapshot().events[0].id,'save');assert.equal(await first,true);assert.equal(await second,true);
 assert.equal(await policy.decide(input()),true);assert.equal(policy.pending.size,1);
 policy.respond(policy.snapshot().events.find(x=>x.environmentId==='b').id,'deny');assert.equal(await other,false);
 const rule=policy.snapshot().rules[0];let revoked;policy.on('revoke-environment',id=>revoked=id);
 policy.revoke(rule.id);assert.equal(revoked,'a');
 const after=policy.decide(input());policy.respond(policy.snapshot().events.at(-1).id,'deny');assert.equal(await after,false);
});
test('cancellation, expiry, queue limit and restart never replay or resurrect pending sends',async t=>{
 let now=1000;const {policy,root}=fixture(t,{now:()=>now,maxPending:1,historyLimit:2});
 const controller=new AbortController();const pending=policy.decide(input('a',{signal:controller.signal}));
 assert.equal(await policy.decide(input()),false);controller.abort();assert.equal(await pending,false);
 const next=policy.decide(input());const event=policy.snapshot().events.at(-1);now=event.expiresAt;
 assert.equal(policy.respond(event.id,'once'),false);assert.equal(await next,false);
 const interrupted=policy.decide(input());
 const restarted=new NetworkPolicy({stateRoot:root,environmentIds:['a','b'],now:()=>now});
 assert.equal(restarted.snapshot().events.at(-1).status,'interrupted');assert.equal(restarted.pending.size,0);
 restarted.close();policy.close();assert.equal(await interrupted,false);
});
test('method/path restricted HTTP rule permits handshake only and still checks inner requests',async t=>{
 const {policy}=fixture(t);
 policy.addRule({environmentId:'a',scheme:'https',host:'example.com',port:443,method:'GET',pathname:'/allowed'});
 assert.equal(await policy.decide({environmentId:'a',request:{method:'CONNECT',host:'example.com:443',url:'//example.com:443'}}),true);
 assert.equal(await policy.decide({environmentId:'a',request:{method:'GET',host:'example.com',url:'/allowed'},context:{sni:'example.com'}}),true);
 const denied=policy.decide({environmentId:'a',request:{method:'POST',host:'example.com',url:'/allowed'},context:{sni:'example.com'}});
 policy.respond(policy.snapshot().events.at(-1).id,'deny');assert.equal(await denied,false);
});
test('TTL expiry emits environment revocation and temporary permissions do not survive their deadline',async t=>{
 const {policy}=fixture(t);const revoke=once(policy,'revoke-environment');
 policy.addRule({environmentId:'a',scheme:'http',host:'example.com',port:80,expiresAt:Date.now()+25});
 // Keep the test alive: production expiry timers intentionally do not keep the app running.
 const keepAlive=setTimeout(()=>{},1000);t.after(()=>clearTimeout(keepAlive));
 assert.deepEqual(await revoke,['a']);assert.equal(policy.snapshot().rules.length,0);
});
test('corrupt saved state and failed persistence fail closed',async t=>{
 const {policy,root}=fixture(t);fs.unlinkSync(policy.file);fs.mkdirSync(policy.file);
 assert.equal(await policy.decide(input()),false);assert.equal(policy.fault,true);
 assert.throws(()=>policy.addRule({environmentId:'a',scheme:'http',host:'example.com',port:80}));
 // Closing cannot make the failed policy permissive.
 policy.close();fs.rmdirSync(policy.file);fs.writeFileSync(policy.file,'{"version":1,"rules":[{}],"events":[]}');
 assert.throws(()=>new NetworkPolicy({stateRoot:root,environmentIds:['a']}),/Invalid saved/);
});


test('path rules preserve stock decoded paths without resolving dot segments or double slashes', () => {
 const request = url => ({method:'GET',host:'example.com',url});
 const rule = {scheme:'http',host:'example.com',port:80,method:'GET',pathname:'/a'};
 for (const url of ['/b/../a', '/b/%2e%2e/a', '/b%2f..%2fa', '/./a', 'http://example.com/b/../a'])
   assert.throws(()=>normalizeRequest(request(url)), /Invalid path/);
 for (const url of ['//example.com/a', 'http://example.com//example.com/a', '//a'])
   assert.equal(matches(rule,normalizeRequest(request(url))),false);
 assert.equal(normalizeRequest(request('//example.com/a')).pathname,'//example.com/a');
 assert.equal(matches(rule,normalizeRequest(request('/%61?private=ignored'))),true);
 assert.equal(normalizeRequest(request('/a%2fb')).pathname,'/a/b');
 assert.equal(normalizeRequest(request('/%252e%252e/a')).pathname,'/%2e%2e/a');
 for (const url of ['/bad%zz', '/a#fragment', '/a%00', 'http://user@example.com/a', 'relative/a'])
   assert.throws(()=>normalizeRequest(request(url)));
});

test('legacy rules migrate to explicit allow and missing modes become ask on reload', async t=>{
 const {policy,root}=fixture(t);
 policy.addRule(ruleInput());policy.close();
 const legacy=savedState(policy);delete legacy.rules[0].action;delete legacy.modes;
 fs.writeFileSync(policy.file,JSON.stringify(legacy));
 const migrated=reload(t,root);
 assert.equal(migrated.snapshot().rules[0].action,'allow');
 assert.deepEqual(migrated.snapshot().modes,{a:'ask',b:'ask'});
 assert.equal(await migrated.decide(input()),true);
 assert.equal(migrated.snapshot().events.length,0);
 assert.equal(savedState(migrated).rules[0].action,'allow');
 migrated.close();
 const restarted=reload(t,root);
 assert.equal(await restarted.decide(input()),true);
 assert.deepEqual(restarted.snapshot().modes,{a:'ask',b:'ask'});
});

test('malformed saved actions and modes reject without altering the invalid bytes', t=>{
 const {policy,root}=fixture(t);
 policy.addRule(ruleInput());policy.close();
 const valid=savedState(policy);
 const invalidStates=[
  ...[null,false,1,'','permit',{},[]].map(action=>({...valid,rules:[{...valid.rules[0],action}]})),
  ...[null,false,1,'ask',[],{unknown:'ask'},{a:'invalid'},{a:null},{a:1},{a:{}},{a:[]}]
   .map(modes=>({...valid,modes})),
  {...valid,modes:JSON.parse('{"__proto__":"allow-all"}')},
 ];
 for(const state of invalidStates) {
  const bytes=JSON.stringify(state,null,3)+'\n';fs.writeFileSync(policy.file,bytes);
  assert.throws(()=>new NetworkPolicy({stateRoot:root,environmentIds:['a','b']}),/Invalid saved network policy/);
  assert.equal(fs.readFileSync(policy.file,'utf8'),bytes);
 }
});

test('rule actions and mode setters validate before persisting or emitting changes', t=>{
 const {policy}=fixture(t);const bytes=fs.readFileSync(policy.file,'utf8');let changes=0,revokes=0;
 policy.on('change',()=>changes++);policy.on('revoke-environment',()=>revokes++);
 for(const action of [undefined,null,false,1,'permit',{},[]])
  assert.throws(()=>policy.addRule(ruleInput({action})),/Invalid network rule/);
 for(const [id,mode] of [['unknown','ask'],['a',undefined],['a',null],['a','ALLOW-ALL'],['a',{}],['a',[]]])
  assert.throws(()=>policy.setMode(id,mode),/Invalid network mode/);
 assert.equal(policy.setMode('a','ask'),false);
 assert.equal(fs.readFileSync(policy.file,'utf8'),bytes);
 assert.equal(changes,0);assert.equal(revokes,0);
 const id=policy.addRule(ruleInput());assert.equal(policy.snapshot().rules.find(rule=>rule.id===id).action,'allow');
});

test('deny-save persists a permanent destination deny, resolves matching queues and revokes only its environment', async t=>{
 const {policy,root}=fixture(t);const revokes=[];
 policy.on('revoke-environment',id=>{
  revokes.push(id);
  assert.equal(savedState(policy).rules[0].action,'deny');
  assert.equal(policy.snapshot().events[0].status,'denied-rule');
 });
 const first=policy.decide(input());
 const second=policy.decide(input('a',{request:{method:'GET',host:'example.com',url:'/other'}}));
 const other=policy.decide(input('b'));
 const firstId=policy.snapshot().events[0].id;
 assert.equal(policy.respond(firstId,'deny-save'),true);
 assert.equal(await first,false);assert.equal(await second,false);assert.deepEqual(revokes,['a']);
 assert.equal(policy.pending.size,1);
 assert.deepEqual(policy.snapshot().events.map(event=>event.status),['denied-rule','denied-rule','pending']);
 const [rule]=policy.snapshot().rules;
 assert.equal(rule.action,'deny');assert.equal(rule.expiresAt,null);assert.equal(rule.method,null);assert.equal(rule.pathname,null);
 for(let i=0;i<3;i++) assert.equal(await policy.decide(input()),false);
 assert.equal(policy.snapshot().events.length,3);assert.equal(policy.respond(firstId,'once'),false);
 policy.respond(policy.snapshot().events[2].id,'deny');assert.equal(await other,false);policy.close();
 const restarted=reload(t,root);
 assert.equal(await restarted.decide(input()),false);
 assert.equal(restarted.snapshot().events[0].status,'denied-rule');
 assert.equal(restarted.snapshot().events.length,3);
 const otherAgain=restarted.decide(input('b'));assert.equal(restarted.pending.size,1);
 restarted.respond(restarted.snapshot().events.at(-1).id,'once');assert.equal(await otherAgain,true);
});

test('deny wins over conflicting allows in either insertion order and remains environment scoped', async t=>{
 for(const actions of [['allow','deny'],['deny','allow']]) {
  const {policy}=fixture(t);
  for(const action of actions) policy.addRule(ruleInput({action}));
  policy.addRule(ruleInput({environmentId:'b'}));
  assert.equal(await policy.decide(input()),false);
  assert.equal(await policy.decide(input('b')),true);
  assert.equal(policy.snapshot().events.length,0);
 }
});

test('restricted HTTPS denies check inner requests while broad denies block CONNECT', async t=>{
 const connect={environmentId:'a',request:{method:'CONNECT',host:'example.com:443',url:'//example.com:443'}};
 const inner=(method,url)=>({environmentId:'a',request:{method,host:'example.com',url},context:{sni:'example.com'}});
 for(const restriction of [{method:'POST'},{pathname:'/private'},{method:'POST',pathname:'/private'}]) {
  const {policy}=fixture(t);
  policy.addRule(ruleInput({scheme:'https',port:443,action:'deny',...restriction}));
  const handshake=policy.decide(connect);assert.equal(policy.pending.size,1);
  policy.respond(policy.snapshot().events[0].id,'once');assert.equal(await handshake,true);
  policy.addRule(ruleInput({scheme:'https',port:443}));
  assert.equal(await policy.decide(connect),true);
  assert.equal(await policy.decide(inner('POST','/private')),false);
  if(restriction.method) assert.equal(await policy.decide(inner('GET','/private')),true);
  if(restriction.pathname) assert.equal(await policy.decide(inner('POST','/public')),true);
  assert.equal(policy.snapshot().events.length,1);
 }
 const {policy}=fixture(t);
 policy.addRule(ruleInput({scheme:'https',port:443,method:'GET',pathname:'/public'}));
 policy.addRule(ruleInput({scheme:'https',port:443,action:'deny'}));
 assert.equal(await policy.decide(connect),false);assert.equal(await policy.decide(inner('GET','/public')),false);
 assert.equal(policy.snapshot().events.length,0);
});

test('allow-all and block-all persist independently without prompting or removing destination rules', async t=>{
 const {policy,root}=fixture(t);
 policy.addRule(ruleInput({action:'deny'}));policy.addRule(ruleInput({environmentId:'b'}));
 assert.equal(policy.setMode('a','allow-all'),true);assert.equal(policy.setMode('b','block-all'),true);
 assert.equal(await policy.decide(input()),true);assert.equal(await policy.decide(input('b')),false);
 assert.equal(policy.snapshot().events.length,0);assert.equal(policy.snapshot().rules.length,2);
 assert.deepEqual(savedState(policy).modes,{a:'allow-all',b:'block-all'});
 const snapshot=policy.snapshot();snapshot.modes.a='block-all';assert.equal(policy.snapshot().modes.a,'allow-all');
 policy.close();const restarted=reload(t,root);
 assert.equal(await restarted.decide(input()),true);assert.equal(await restarted.decide(input('b')),false);
 restarted.setMode('a','ask');restarted.setMode('b','ask');
 assert.equal(await restarted.decide(input()),false);assert.equal(await restarted.decide(input('b')),true);
 assert.equal(restarted.snapshot().events.length,0);
});

test('queued requests re-evaluate mode/rules, preserving unmatched ask requests and other environments', async t=>{
 const {policy}=fixture(t);
 const first=policy.decide(input());
 const second=policy.decide(input('a',{request:{method:'GET',host:'example.com',url:'/public'}}));
 const unmatched=policy.decide(input('a',{request:{method:'GET',host:'other.com',url:'/'}}));
 const other=policy.decide(input('b'));
 policy.addRule(ruleInput({action:'deny',method:'POST'}));assert.equal(await first,false);
 assert.equal(policy.pending.size,3);
 policy.addRule(ruleInput());assert.equal(await second,true);assert.equal(policy.pending.size,2);
 policy.setMode('a','block-all');assert.equal(await unmatched,false);assert.equal(policy.pending.size,1);
 assert.equal(await policy.decide(input()),false);
 policy.addRule(ruleInput({host:'other.com'}));assert.equal(await policy.decide(input('a',{request:{method:'GET',host:'other.com',url:'/'}})),false);
 policy.setMode('b','allow-all');assert.equal(await other,true);assert.equal(policy.pending.size,0);
 assert.deepEqual(policy.snapshot().events.map(event=>event.status),['denied-rule','allowed-rule','denied','allowed-rule']);
});

test('mode changes persist before queue release/revocation; every actual change revokes and identical values do nothing', async t=>{
 const {policy}=fixture(t);const revokes=[];
 policy.on('revoke-environment',id=>revokes.push([id,savedState(policy).modes[id]]));
 const pending=policy.decide(input());const id=policy.snapshot().events[0].id;
 policy.setMode('a','allow-all');assert.equal(await pending,true);
 assert.equal(policy.respond(id,'deny'),false);
 policy.setMode('a','ask');const denied=policy.decide(input());const deniedId=policy.snapshot().events.at(-1).id;
 assert.equal(policy.pending.size,1);policy.setMode('a','allow-all');assert.equal(await denied,true);
 policy.setMode('a','block-all');assert.equal(await policy.decide(input()),false);
 const bytes=fs.readFileSync(policy.file,'utf8');assert.equal(policy.setMode('a','block-all'),false);
 assert.equal(fs.readFileSync(policy.file,'utf8'),bytes);
 assert.deepEqual(revokes,[['a','allow-all'],['a','ask'],['a','allow-all'],['a','block-all']]);
 assert.equal(policy.respond(deniedId,'save'),false);
 policy.setMode('a','ask');const blocked=policy.decide(input());const blockedId=policy.snapshot().events.at(-1).id;
 policy.setMode('a','block-all');assert.equal(await blocked,false);
 for(const response of ['once','save','temporary','deny-save']) assert.equal(policy.respond(blockedId,response),false);
 assert.equal(policy.snapshot().rules.length,0);
});

test('expired and cancelled queued requests cannot be approved by mode or rule changes', async t=>{
 let now=1000;const {policy}=fixture(t,{now:()=>now});
 const expired=policy.decide(input());now=policy.snapshot().events[0].expiresAt;
 policy.setMode('a','allow-all');assert.equal(await expired,false);assert.equal(policy.snapshot().events[0].status,'expired');
 policy.setMode('a','ask');const controller=new AbortController();
 const cancelled=policy.decide(input('a',{signal:controller.signal}));const id=policy.snapshot().events.at(-1).id;
 controller.abort();policy.addRule(ruleInput());policy.setMode('a','allow-all');
 assert.equal(await cancelled,false);assert.equal(policy.respond(id,'once'),false);
 assert.equal(policy.snapshot().events.at(-1).status,'cancelled');
});

test('every mode fails closed for unknown environments, aborted signals and malformed requests', async t=>{
 const {policy}=fixture(t);const controller=new AbortController();controller.abort();
 const malformed=[null,{}, Object.assign([],{method:'POST',host:'example.com',url:'/'}), {method:['POST'],host:'example.com',url:'/'},
  {method:'GET',host:'user:pass@example.com',url:'/'}, {method:'GET',host:'example.com',url:'/bad%zz'},
  {method:'GET',host:'example.com:0',url:'/'}, {method:'CONNECT',host:'example.com:0'},
  {method:'GET',host:'example.com',url:'http://other.com/'}, {method:'GET',host:'example.com',url:'/a/../b'},
  {method:'GET',host:'example.com',url:null}];
 for(const mode of ['ask','allow-all','block-all']) {
  policy.setMode('a',mode);
  assert.equal(await policy.decide(input('unknown')),false);
  assert.equal(await policy.decide(input('a',{signal:controller.signal})),false);
  for(const request of malformed) assert.equal(await policy.decide(input('a',{request})),false);
 }
 assert.equal(policy.snapshot().events.length,0);
 policy.setMode('a','allow-all');policy.close();assert.equal(await policy.decide(input()),false);
 assert.throws(()=>policy.setMode('a','ask'),/offline/);
});

test('failed mode/rule persistence faults the policy before any queued request can be allowed', async t=>{
 for(const change of [policy=>policy.setMode('a','allow-all'),policy=>policy.addRule(ruleInput())]) {
  const {policy}=fixture(t);const pending=policy.decide(input());const revokes=[];
  policy.on('revoke-environment',id=>revokes.push(id));
  fs.unlinkSync(policy.file);fs.mkdirSync(policy.file);
  assert.throws(()=>change(policy));assert.equal(await pending,false);
  assert.equal(policy.fault,true);assert.deepEqual(revokes,['a','b']);
  assert.equal(policy.snapshot().events[0].status,'interrupted');
  assert.equal(await policy.decide(input()),false);assert.equal(await policy.decide(input('b')),false);
  assert.throws(()=>policy.respond(policy.snapshot().events[0].id,'once'),/offline/);
  assert.throws(()=>policy.setMode('a','allow-all'),/offline/);
 }
});
