const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../src/v1/control.js'),'utf8');
function fixture(){
 const nodes=new Map(),calls=[];const get=id=>{if(!nodes.has(id)){const events={},attributes={};nodes.set(id,{disabled:false,dataset:{},classList:{toggle(){}},setAttribute:(k,v)=>attributes[k]=v,getAttribute:k=>attributes[k],addEventListener:(k,v)=>events[k]=v,click(){if(!this.disabled)events.click?.()},textContent:''})}return nodes.get(id)};
 const context={document:{getElementById:get},window:{isolated:{onStatus(){},status:()=>new Promise(()=>{}),connect:async()=>{calls.push('connect')},disconnect:async()=>{calls.push('disconnect')},stopEnvironment:async()=>{calls.push('stop')}}},setInterval(){}};
 vm.createContext(context);vm.runInContext(source,context);
 return {get,calls,render(state){context.state=state;vm.runInContext('lastState = state; renderLifecycle(state, state.environments?.find(item => item.id === state.selectedId))',context)}};
}
const state=(overrides={})=>({selectedId:'vm',activeId:null,busy:false,networkPolicy:{},environments:[{id:'vm',phase:'stopped',network:'offline'}],...overrides});
test('single lifecycle button dispatches Connect, Disconnect, Cancel and Retry',async()=>{
 for(const [value,label,call] of [
  [state(),'Connect','connect'],[state({activeId:'vm',environments:[{id:'vm',phase:'running',network:'ready'}]}),'Disconnect','disconnect'],
  ...["renderer-stopped","control-channel-unavailable"].map(issue=>[state({activeId:'vm',connection:{issue},environments:[{id:'vm',phase:'running',network:'ready'}]}),'Retry','connect']),
  [state({busy:true}),'Cancel','disconnect'],[state({viewer:{opening:true}}),'Cancel','disconnect'],
  [state({environments:[{id:'vm',phase:'running',network:'ready'}]}),'Retry','connect'],
  [state({activeId:'vm',environments:[{id:'vm',phase:'running',network:'offline'}]}),'Retry','connect'],
  [state({environments:[{id:'vm',phase:'error',network:'offline'}]}),'Retry','connect']]){
   const f=fixture();f.render(value);assert.equal(f.get('connect-label').textContent,label);assert.equal(f.get('connect').disabled,false);f.get('connect').click();await Promise.resolve();assert.deepEqual(f.calls,[call]);
 }
});
test('connection prerequisites block connect/retry but do not strand disconnect/cancel',()=>{
 for(const blocked of [{modelBusy:true},{installation:{ready:false}},{networkPolicy:{fault:'invalid'}},{networkPolicy:{closed:true}},{networkPolicy:null}]){
  const f=fixture();f.render(state(blocked));assert.equal(f.get('connect').disabled,true);
  f.render(state({...blocked,busy:true}));assert.equal(f.get('connect').disabled,false);
  f.render(state({...blocked,activeId:'vm',environments:[{id:'vm',phase:'running',network:'ready'}]}));assert.equal(f.get('connect-label').textContent,'Disconnect');assert.equal(f.get('connect').disabled,false);
 }
 for(const guard of [{filesBusy:true},{quitting:true},{installation:{ready:true,busy:true}},{images:{busy:true}}])for(const busy of [false,true]){
  const f=fixture();f.render(state({...guard,busy}));assert.equal(f.get('connect').disabled,true);f.get('connect').click();assert.deepEqual(f.calls,[]);
 }
});
test('toolbar has one lifecycle control, explicit Stop VM and accessible inline utility labels without title tooltips',()=>{
 const html=fs.readFileSync(path.join(__dirname,'../src/v1/control.html'),'utf8');
 assert(!html.includes('id="disconnect"'));assert.match(html,/id="stop"[^>]+aria-label="Stop VM/);assert.match(html,/<span>Stop VM<\/span>/);
 for(const [id,label] of [['network','Network'],['files','Files'],['models','Models'],['resources','Settings']]){
  const button=html.match(new RegExp('<button id="'+id+'"[\\s\\S]*?<\\/button>'))[0];assert(!button.includes('title='));assert.match(button,new RegExp('aria-label="'+label+'"'));assert.match(button,new RegExp('aria-hidden="true">'+label));
 }
 assert(!source.includes('$("network").title'));
 const css=fs.readFileSync(path.join(__dirname,'../src/v1/control.css'),'utf8');assert.match(css,/:focus-visible \.action-label/);assert.match(css,/prefers-reduced-motion/);
});
