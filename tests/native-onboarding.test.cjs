const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {createRequire}=require('node:module'),{EventEmitter}=require('node:events');
const main=path.resolve(__dirname,'../src/v1-main.cjs');
function harness({messageChoice=0,deferMessage=false,reconcileFailure=false,saveDestination,deferSave=false,viewerNavigation,harnessNavigation,storedSelection,imageAvailable=true,manualHealth=false,healthFetch,catalogMutation,modelCatalogFactory}={}){
 const calls={quit:0,shutdown:0,prepare:0,policy:0,models:0,git:0,savePickers:0,starts:0,networkRestores:0,viewerClose:0,viewerFocus:0,stops:[],selections:[],imageImports:[],imageCancelled:0,secrets:[],catalogChanges:[]};let resolvePicker,resolveSave,resolveMessage;
 const messages=[],messagePicker=new Promise(resolve=>resolveMessage=resolve);
 let networkState, healthCheck, runtimeOptions;
 const handlers=new Map(),savePicker=new Promise(resolve=>resolveSave=resolve);
 const picker=new Promise(resolve=>resolvePicker=resolve);
 const emitter=()=>Object.assign(new EventEmitter(),{snapshot:()=>({}),cancel(){}});
 const coordinator=Object.assign(emitter(),{snapshot:()=>networkState?[networkState]:[],definitions:new Map(),leases:new Map(),
  stop:async id=>{calls.stops.push(id)},start:async()=>{calls.starts++},connect:async()=>({origin:'http://127.0.0.1:43981',launchUrl:'http://127.0.0.1:43981/?token=fixture',close:async()=>{}}),
  reconcile:async()=>{if(reconcileFailure){reconcileFailure=false;throw Error('stop failed')}},shutdown:async()=>{calls.shutdown++}});
 const network={restore:async()=>{calls.networkRestores++;networkState={...networkState,network:'ready'}}};
 coordinator.restoreNetwork=async id=>network.restore(id);
 coordinator.drivers=new Map([['wrapvm-v1',{openViewer:async()=>({origin:'http://127.0.0.1:42911',password:'ab'.repeat(16),isClosed:()=>false,
   focusBrowser:async()=>{calls.viewerFocus++},close:async()=>{calls.viewerClose++}})}]]);
 coordinator.guards=new Map([['wrapvm-v1',{}]]);coordinator.journal={environments:{'wrapvm-v1':{ownershipToken:'fixture'}}};
 coordinator.serialized=async(_id,work,{signal})=>work(signal);
 const runtime={coordinator,network,transfers:Object.assign(emitter(),{hostPath:p=>fs.realpathSync(p)}),shares:emitter(),resources:emitter()};
 coordinator.checkRecreate=()=>{};coordinator.restart=async id=>calls.stops.push('restart:'+id);coordinator.recreate=async id=>calls.stops.push('recreate:'+id);
 class Window extends EventEmitter {constructor(){super();this.size=[1200,800];this.contentView={children:[],addChildView(view){this.children.push(view)},removeChildView(view){this.children=this.children.filter(x=>x!==view)}}}isDestroyed(){return false}getContentSize(){return this.size}show(){}focus(){}}
 class View {
  constructor(options){this.options=options;this.visible=true;let url='',destroyed=false;
   this.webContents=Object.assign(new EventEmitter(),{mainFrame:{url:require('node:url').pathToFileURL(path.join(path.dirname(main),'v1/control.html')).href},
    send(){},loadFile:async value=>{this.webContents.mainFrame.url=require('node:url').pathToFileURL(value).href},loadURL:async value=>{url=value;if(value==='http://127.0.0.1:42911/')return viewerNavigation?.();if(value==='http://127.0.0.1:43981/')return harnessNavigation?.()},getURL:()=>url,setWebRTCIPHandlingPolicy(){},
    setWindowOpenHandler(){},isDestroyed:()=>destroyed,close(){destroyed=true},getLastWebPreferences:()=>options.webPreferences});
  }
  setBackgroundColor(){}
  setBounds(value){this.bounds=value}getBounds(){return this.bounds}setVisible(value){this.visible=value}getVisible(){return this.visible}
 }
 class Tray extends EventEmitter {setContextMenu(){}setToolTip(){}}
 class Installer extends EventEmitter {snapshot(){return {active:'fixture',recoverable:true}}recoveryOptions(){return {}}async verifyRelease(){}cancel(){}async restore({stopEnvironments}){await stopEnvironments();return {}}async prepare(){calls.prepare++;return 'fixture'}async activate(){return {}}}
 class Policy extends EventEmitter {constructor(){super();calls.policy++}snapshot(){return {events:[]}}close(){}}
 class CatalogFixture {
  snapshot(){return {}}
  prepareSave(input){if(!input?.id&&!input?.repository)throw Object.assign(Error('Invalid catalog input.'),{code:'MODEL_CATALOG'});return {...input}}
  prepareRemove(id){if(typeof id!=='string')throw Error('Invalid id');return {id}}
  prepareSelect(input){return this.prepareSave({id:input?.provider,...input})}
  prepareImport(repository){return {repository}}
  async change(kind,input,options={}){await catalogMutation?.(options.signal);options.signal?.throwIfAborted();calls.catalogChanges.push([kind,input,Boolean(options.signal)])}
  save(input,options){return this.change('save',input,options)}
  remove(id,options){return this.change('remove',id,options)}
  select(input,options){return this.change('select',input,options)}
  importDesktop(options){return this.change('model-import',options.prepared,options)}
  importRepository(repository,options){return this.change('git-import',repository,options)}
 }
 class Models extends CatalogFixture {constructor(options){super();calls.models++;if(modelCatalogFactory)return modelCatalogFactory(options)}}
 class Git extends CatalogFixture {constructor(){super();calls.git++}}
 class Secrets {
  constructor(){this.entries=[]}
  snapshot(){return {entries:this.entries.map(({value,...entry})=>({...entry,credentialAvailable:true}))}}
  entriesFor(id){return this.entries.filter(entry=>entry.environmentId===id)}
  prepareSave(input){
   const metadata=realRequire('./runtime/secret-scope.cjs').validateSecretMetadata(input,['lima-v1','wrapvm-v1','wrapvm-arm64-v1']);
   if(input.id&&!this.entries.some(entry=>entry.id===input.id&&entry.environmentId===input.environmentId))throw Error('Unknown credential');
   return {...metadata,...(input.id?{id:input.id}:{}),value:input.value};
  }
  prepareRemove(id){const entry=this.entries.find(entry=>entry.id===id);if(!entry)throw Error('Unknown credential');return {id,environmentId:entry.environmentId}}
  async save(input,{signal}={}){signal?.throwIfAborted();calls.secrets.push(['save',input.environmentId]);const entry={...input,id:input.id??'fixture-secret'};this.entries=[...this.entries.filter(x=>x.id!==entry.id),entry]}
  async remove(id){calls.secrets.push(['remove',id]);this.entries=this.entries.filter(entry=>entry.id!==id)}
 }

 class Images extends EventEmitter {
  constructor(){super();this.localArchive='/fixture/desktop-images/local.tar';this.state={busy:false}}
  available(){return imageAvailable}
  snapshot(selected){return {selected,items:[],...this.state}}
  cancel(){calls.imageCancelled++}
  update(value){Object.assign(this.state,value);this.emit('change')}
  async importLocal(source){calls.imageImports.push(source);return true}
 }
 const app=Object.assign(new EventEmitter(),{isPackaged:true,getVersion:()=>'1.0.0',getPath:()=>'/fixture',setPath(){},setName(){},commandLine:{appendSwitch(){}},requestSingleInstanceLock:()=>true,whenReady:async()=>{},quit(){calls.quit++},exit(){calls.quit++}});
 const realRequire=createRequire(main),mocks={electron:{app,BaseWindow:Window,WebContentsView:View,Tray,session:{fromPartition:()=>({fetch:healthFetch??(async()=>({status:200,body:{cancel:async()=>{}}})),cookies:{get:async()=>[]},clearStorageData:async()=>{},clearCache:async()=>{}})},Menu:{buildFromTemplate:x=>x},nativeImage:{createFromBitmap:()=>({setTemplateImage(){}})},ipcMain:{handle:(name,handler)=>handlers.set(name,handler)},dialog:{showMessageBox:(_window,options)=>{messages.push(options);return deferMessage?messagePicker:Promise.resolve({response:messageChoice})},showOpenDialog:()=>picker,showSaveDialog:async()=>{calls.savePickers++;return deferSave?savePicker:{canceled:!saveDestination,filePath:saveDestination}}}},
  './runtime/viewer-boundary.cjs':{createViewerBoundary:async()=>({revoke(){},close:async()=>{}})},
  './runtime/renderer-boundary.cjs':{createRendererBoundary:async()=>({setOrigin:async()=>{},revoke(){},close:async()=>{}})},
  'node:fs':{openSync:fs.openSync,writeFileSync:fs.writeFileSync,fsyncSync:fs.fsyncSync,closeSync:fs.closeSync,mkdirSync(){}},'./runtime/index.cjs':{createRuntime:options=>{runtimeOptions=options;return runtime}},'./runtime/atomic-json.cjs':{readJson:(file,fallback)=>file.endsWith('selection.json')&&storedSelection?storedSelection:fallback,writeJson(file,value){if(file.endsWith('selection.json'))calls.selections.push(value)}},
  './runtime/desktop-image-store.cjs':{DesktopImageStore:Images},
  './runtime/artifact-installer.cjs':{ArtifactInstaller:Installer},'./runtime/network-policy.cjs':{NetworkPolicy:Policy},'./runtime/model-catalog.cjs':{ModelCatalog:Models},'./runtime/git-catalog.cjs':{GitCatalog:Git},'./runtime/secret-catalog.cjs':{SecretCatalog:Secrets},'./runtime/secret-vault.cjs':{SecretVault:class{}}};
 const context={require:n=>mocks[n]??realRequire(n),module:{exports:{}},__dirname:path.dirname(main),Buffer,clearInterval,setInterval:manualHealth?(fn=>{healthCheck=fn;return 1}):setInterval,process,AbortController,AbortSignal,URL};
 vm.runInNewContext(fs.readFileSync(main,'utf8'),context,{filename:main});
 return {credentialBridge:settings=>runtimeOptions.credentialBridge(settings),messages,resolveMessage,checkHealth:()=>healthCheck(),ui:context.module.exports,calls,resolvePicker,coordinator,handlers,resolveSave,network,setNetwork:value=>networkState=value};
}
const secretInput = () => ({name:'Test API',environmentId:'wrapvm-v1',authType:'bearer',origin:'https://api.example.com',
 pathPrefix:'/v1/',methods:['GET'],headerName:'',username:'',value:'synthetic-canary'});
function localEvent(ui){const sender=ui.getControls();return {sender,senderFrame:sender.mainFrame}}
test('secret IPC rejects guest, notification and child frames before any stop or vault mutation',async()=>{
 const {ui,calls,handlers}=harness();await ui.ready;
 const controls=ui.getControls(),notice=ui.getNotice();
 for(const channel of ['secret-save','secret-remove'])for(const event of [
  {sender:notice,senderFrame:notice.mainFrame},{sender:controls,senderFrame:{url:controls.mainFrame.url}},
  {sender:{},senderFrame:controls.mainFrame}])
  assert.throws(()=>handlers.get('isolated:'+channel)(event,secretInput()),/IPC denied/);
 assert.equal(calls.stops.length,0);assert.equal(calls.secrets.length,0);await ui.quit();
});
test('secret save stops only its environment and rejects failed stops without mutation',async()=>{
 const {ui,calls,handlers,coordinator}=harness();await ui.ready;
 const save=input=>handlers.get('isolated:secret-save')(localEvent(ui),input);
 await assert.rejects(save({...secretInput(),origin:'https://api.example.com/?canary'}));
 assert.equal(calls.stops.length,0);
 const stop=coordinator.stop;coordinator.stop=async()=>{throw Error('unowned')};
 await assert.rejects(save(secretInput()),/did not complete/);assert.equal(calls.secrets.length,0);
 coordinator.stop=stop;await save(secretInput());
 assert.deepEqual(calls.stops,['wrapvm-v1']);assert.deepEqual(calls.secrets,[['save','wrapvm-v1']]);
 assert(!JSON.stringify(ui.snapshot().secrets).includes('synthetic-canary'));
 await handlers.get('isolated:secret-remove')(localEvent(ui),'fixture-secret');
 assert.deepEqual(calls.stops,['wrapvm-v1','wrapvm-v1']);assert.equal(ui.snapshot().secrets.entries.length,0);
 await ui.quit();
});
test('quit during credential stop prevents late publication',async()=>{
 const {ui,calls,handlers,coordinator}=harness();await ui.ready;
 let release;coordinator.stop=()=>new Promise(resolve=>release=resolve);
 const saving=handlers.get('isolated:secret-save')(localEvent(ui),secretInput());
 const rejected=assert.rejects(saving,/did not complete/);
 await new Promise(resolve=>setImmediate(resolve));const quitting=ui.quit();
 release();await rejected;await quitting;assert.equal(calls.secrets.length,0);
});
test('secret mutations serialize locally and duplicate clicks cannot publish twice',async()=>{
 const {ui,calls,handlers,coordinator}=harness();await ui.ready;
 let release;coordinator.stop=()=>new Promise(resolve=>release=resolve);
 const save=()=>handlers.get('isolated:secret-save')(localEvent(ui),secretInput());
 const first=save();await assert.rejects(save(),/operation is in progress/);
 release();await first;assert.equal(calls.secrets.length,1);await ui.quit();
});
test('image switch persists only after owned WrapVM stops; failed stop retains selection',async()=>{
 const {ui,calls,coordinator}=harness();await ui.ready;
 const stop=coordinator.stop;coordinator.stop=async()=>{throw Error('still running')};
 await ui.switchDesktopImage('local-arm64');
 assert.equal(ui.snapshot().images.selected,'stock-amd64');assert.equal(ui.snapshot().selectedId,'wrapvm-v1');
 assert.equal(calls.selections.length,0);assert.equal(calls.starts,0);
 coordinator.stop=stop;await ui.switchDesktopImage('local-arm64');
 assert.deepEqual(calls.stops,['wrapvm-v1']);assert.equal(calls.starts,0);
 assert.equal(ui.snapshot().selectedId,'wrapvm-arm64-v1');assert.equal(ui.snapshot().images.selected,'local-arm64');
 assert.equal(calls.selections[0].id,'wrapvm-arm64-v1');assert.equal(calls.selections[0].imageId,'local-arm64');
 await ui.quit();
});
test('missing or unknown image never changes selection or silently falls back',async()=>{
 const {ui,calls}=harness({imageAvailable:false});await ui.ready;
 assert.throws(()=>ui.switchDesktopImage('external-url'),/Unknown desktop image/);
 await ui.switchDesktopImage('local-arm64');
 assert.equal(ui.snapshot().images.selected,'stock-amd64');assert.equal(calls.stops.length,0);assert.equal(calls.selections.length,0);
 await ui.quit();
});
test('image preference survives selecting Lima and startup never starts a guest',async()=>{
 const {ui,calls}=harness({storedSelection:{version:1,id:'lima-v1',imageId:'local-arm64'}});await ui.ready;
 assert.equal(ui.snapshot().selectedId,'lima-v1');assert.equal(ui.snapshot().images.selected,'local-arm64');assert.equal(calls.starts,0);
 await ui.select('wrapvm-arm64-v1');assert.equal(calls.selections.at(-1).imageId,'local-arm64');
 await ui.select('lima-v1');assert.equal(calls.selections.at(-1).imageId,'local-arm64');
 await ui.quit();
});
test('image IPC is local-main-frame only and a picker cannot import after quit',async()=>{
 const {ui,calls,handlers,resolvePicker}=harness();await ui.ready;
 const sender=ui.getNotice();
 for(const name of ['desktop-image-switch','desktop-image-import','desktop-image-cancel'])
  assert.throws(()=>handlers.get('isolated:'+name)({sender,senderFrame:sender.mainFrame},'local-arm64'),/IPC denied/);
 const importing=ui.importDesktopImage();await new Promise(resolve=>setImmediate(resolve));
 await ui.quit();assert.equal(calls.shutdown,1);assert.equal(calls.quit,1);assert(calls.imageCancelled>0);
 resolvePicker({canceled:false,filePaths:['/fixture/image.tar']});await importing;
 assert.equal(calls.imageImports.length,0);assert.equal(calls.selections.length,0);
});
test('connecting a selected WrapVM profile stops another retained profile before start',async()=>{
 const {ui,calls,coordinator}=harness({storedSelection:{version:1,id:'wrapvm-arm64-v1',imageId:'local-arm64'}});await ui.ready;
 const order=[];coordinator.stop=async id=>order.push('stop:'+id);coordinator.start=async id=>order.push('start:'+id);
 await ui.connect();assert.deepEqual(order,['stop:wrapvm-v1','start:wrapvm-arm64-v1']);
 await ui.quit();
});

test('successful recovery initializes services skipped by failed startup reconciliation',async()=>{
 const {ui,calls}=harness({reconcileFailure:true});await ui.ready;
 assert.equal(calls.policy,0);assert.equal(ui.snapshot().installation.ready,false);
 await ui.artifactAction('restore');assert.equal(ui.snapshot().installation.ready,true);
 assert.equal(calls.policy,1);assert.equal(calls.models,1);assert.equal(calls.git,1);
 await ui.artifactAction('restore');assert.equal(calls.policy,1);assert.equal(calls.models,1);
});
test('quit verifies guest shutdown without waiting for the picker; late selection cannot install',async()=>{
 const {ui,calls,resolvePicker}=harness();await ui.ready;const action=ui.artifactAction('install');
 await new Promise(resolve=>setImmediate(resolve));await ui.quit();
 assert.equal(calls.shutdown,1);assert.equal(calls.quit,1);
 resolvePicker({canceled:false,filePaths:['/fixture/package']});await action;assert.equal(calls.prepare,0);
});
test('failed shutdown preserves the process and permanently invalidates the pending picker',async()=>{
 const {ui,calls,resolvePicker,coordinator}=harness();await ui.ready;const action=ui.artifactAction('install');
 await new Promise(resolve=>setImmediate(resolve));coordinator.shutdown=async()=>{throw Error('still running')};
 await ui.quit();assert.equal(calls.quit,0);assert.equal(ui.snapshot().quitting,false);
 resolvePicker({canceled:false,filePaths:['/fixture/package']});await action;assert.equal(calls.prepare,0);
});
test('packaged runtime protects all legacy siblings and their canonical aliases',t=>{
 const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'private-runtime-')));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const parent=path.join(home,'.harness-isolated');fs.mkdirSync(path.join(parent,'s'),{recursive:true});
 fs.mkdirSync(path.join(parent,'l'));const alias=path.join(home,'alias');fs.symlinkSync(path.join(parent,'s'),alias);
 const file=path.resolve(__dirname,'../src/runtime/index.cjs'),realRequire=createRequire(file),context={module:{exports:{}},__dirname:path.dirname(file),require:n=>n==='node:os'?{...os,homedir:()=>home}:realRequire(n)};
 vm.runInNewContext(fs.readFileSync(file,'utf8'),context,{filename:file});
 const runtime=context.module.exports.createRuntime({stateRoot:path.join(home,'state'),runtimeRoot:path.join(parent,'v1'),definitions:[]});
 for(const selected of [path.join(parent,'s'),path.join(parent,'l'),alias,home])assert.throws(()=>runtime.transfers.hostPath(selected,{importing:true}));
});

test('native diagnostics export writes a private report and refuses existing files and links',async t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'diagnostic-export-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=path.join(root,'report.json');const {ui}=harness({saveDestination:file});await ui.ready;await ui.exportDiagnostics();
 const original=fs.readFileSync(file,'utf8'),report=JSON.parse(original);assert.equal(report.version,1);assert.equal(report.metadata.appVersion,'1.0.0');
 assert.equal(fs.statSync(file).mode&0o777,0o600);assert(!original.includes('/fixture'));assert(!original.includes('label'));
 fs.writeFileSync(file,'preserve existing report');await ui.exportDiagnostics();assert.equal(fs.readFileSync(file,'utf8'),'preserve existing report');
 const alias=path.join(root,'alias.json');fs.symlinkSync(file,alias);const linked=harness({saveDestination:alias});await linked.ui.ready;await linked.ui.exportDiagnostics();
 assert.equal(fs.readFileSync(file,'utf8'),'preserve existing report');assert(fs.lstatSync(alias).isSymbolicLink());
});

test('diagnostic IPC rejects guest senders, subframes and navigated local frames before opening a picker',async()=>{
 const {ui,calls,handlers}=harness();await ui.ready;
 const invoke=handlers.get('isolated:diagnostics-export'),controls=ui.getControls(),frame=controls.mainFrame;
 for(const event of [{sender:{},senderFrame:frame},{sender:controls,senderFrame:{url:frame.url}}])assert.throws(()=>invoke(event),/IPC denied/);
 const original=frame.url;frame.url='https://untrusted.invalid/';assert.throws(()=>invoke({sender:controls,senderFrame:frame}),/IPC denied/);
 assert.equal(calls.savePickers,0);frame.url=original;
 await invoke({sender:controls,senderFrame:frame});assert.equal(calls.savePickers,1);
});
test('a deferred diagnostic save is revoked by both successful and failed shutdown',async t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'diagnostic-shutdown-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 for(const fail of [false,true]){
  const file=path.join(root,fail?'failed-stop.json':'stopped.json');
  const {ui,calls,coordinator,resolveSave}=harness({deferSave:true});await ui.ready;
  const exporting=ui.exportDiagnostics();assert.equal(calls.savePickers,1);
  if(fail)coordinator.shutdown=async()=>{throw Error('stop failed')};
  await ui.quit();assert.equal(calls.quit,fail?0:1);
  resolveSave({canceled:false,filePath:file});await exporting;assert.equal(fs.existsSync(file),false);
 }
});

test('native guest view preserves the bottom toolbar and yields to trusted panels at both window sizes',async()=>{
 const {ui,handlers}=harness();await ui.ready;
 try{
  await ui.connect();assert.match(ui.snapshot().label,/^Connected/);
  const preferences=ui.getRemote().getLastWebPreferences();assert.equal(preferences.sandbox,true);assert.equal(preferences.contextIsolation,true);
  assert.equal(preferences.nodeIntegration,false);assert.equal(preferences.nodeIntegrationInSubFrames,false);assert.equal(preferences.preload,undefined);
  const controls=ui.getControls(),event={sender:controls,senderFrame:controls.mainFrame};
  for(const size of [[1380,960],[1000,650]]){
   const window=ui.getWindow();window.size=size;window.emit('resize');
   for(const panel of ['network','models','files','resources','harness']){
    handlers.get('isolated:panel')(event,panel);const state=ui.getDiagnostic();
    assert.equal(state.viewVisible,panel==='harness');assert.equal(state.children,3);
    assert.equal(state.viewBounds.x,0);assert.equal(state.viewBounds.y,0);assert.equal(state.viewBounds.width,size[0]);assert.equal(state.viewBounds.height,size[1]-48);
   }
  }
 }finally{await ui.quit();}
});


test('proxy-only retry preserves the guest view and does not restart the VM, including failed recovery',async()=>{
 const {ui,calls,network,setNetwork}=harness();await ui.ready;
 try{
  await ui.connect();const original=ui.getRemote();assert.equal(calls.starts,1);
  setNetwork({id:'wrapvm-v1',network:'offline',networkStatus:{phase:'offline',reason:'proxy-exited'}});
  await ui.connect();assert.equal(calls.networkRestores,1);assert.equal(calls.starts,1);assert.equal(ui.getRemote(),original);
  assert.match(ui.snapshot().label,/^Connected/);
  setNetwork({id:'wrapvm-v1',network:'offline',networkStatus:{phase:'offline',reason:'recovery-failed'}});
  network.restore=async()=>{throw Error('fixture failure')};
  await ui.connect();assert.equal(ui.getRemote(),original);assert.equal(calls.starts,1);
  assert.equal(ui.snapshot().label,'Harness connected · Network offline');assert.equal(ui.snapshot().busy,false);
 }finally{await ui.quit()}
});


test('notification renderer can review requests but cannot control VMs or grant unrestricted network access',async()=>{
 const {ui,handlers}=harness();await ui.ready;
 const sender=ui.getNotice(),event={sender,senderFrame:sender.mainFrame};
 assert.equal(handlers.get('isolated:network-notice-state')(event),null);
 for(const name of ['connect','stop','viewer-open','network-add','network-mode','model-import','file-export','share-confirm','diagnostics-export'])
  assert.throws(()=>handlers.get('isolated:'+name)(event),/IPC denied/);
 assert.throws(()=>handlers.get('isolated:network-notice-state')({...event,senderFrame:{url:sender.mainFrame.url}}),/IPC denied/);
 handlers.get('isolated:network-notice-review')(event);assert.equal(ui.snapshot().panel,'network');
 sender.mainFrame.url='http://127.0.0.1:43981/';
 assert.throws(()=>handlers.get('isolated:network-notice-state')(event),/IPC denied/);
 await ui.quit();
});


test('guest desktop/browser reuse Harness and keep viewer credentials outside renderer snapshots',async()=>{
 const {ui,calls,handlers}=harness();await ui.ready;
 try{
  await ui.connect();const harnessView=ui.getRemote();
  await ui.showViewer('desktop');assert.equal(ui.snapshot().panel,'desktop');assert(ui.getViewer());
  assert.equal(calls.starts,1);assert.equal(ui.getRemote(),harnessView);
  assert.equal(ui.getViewer().getURL(),'http://127.0.0.1:42911/');
  assert(!JSON.stringify(ui.snapshot()).includes('ab'.repeat(16)));assert(!JSON.stringify(ui.snapshot()).includes('42911'));
  await ui.showViewer('browser');assert.equal(calls.viewerFocus,1);assert.equal(ui.snapshot().panel,'browser');
  const controls=ui.getControls();handlers.get('isolated:panel')({sender:controls,senderFrame:controls.mainFrame},'harness');
  assert.equal(ui.snapshot().panel,'harness');assert.equal(ui.getRemote(),harnessView);
  await ui.disconnect();assert.equal(calls.viewerClose,1);assert.equal(ui.getViewer(),undefined);assert.equal(ui.snapshot().viewer.available,false);
 }finally{await ui.quit()}
});
test('disconnect during late viewer creation closes it without attaching or exposing credentials',async()=>{
 const {ui,coordinator,calls}=harness();await ui.ready;
 let resolve,entered;const pending=new Promise(r=>resolve=r),started=new Promise(r=>entered=r);
 coordinator.drivers.get('wrapvm-v1').openViewer=async()=>{entered();return pending};
 try{
  await ui.connect();const opening=ui.showViewer('desktop');await started;
  const disconnecting=ui.disconnect();
  resolve({origin:'http://127.0.0.1:42911',password:'ab'.repeat(16),close:async()=>calls.viewerClose++});
  await opening;await disconnecting;
  assert.equal(ui.getViewer(),undefined);assert.equal(calls.viewerClose,1);assert.equal(ui.snapshot().activeId,undefined);
 }finally{await ui.quit()}
});


for(const action of ['disconnect','quit'])test(action+' cancels a guest navigation that never completes',{timeout:2000},async()=>{
 let entered;const started=new Promise(resolve=>entered=resolve);
 const {ui,calls}=harness({viewerNavigation:()=>{entered();return new Promise(()=>{})}});await ui.ready;
 await ui.connect();const opening=ui.showViewer('desktop');await started;
 const pendingRenderer=ui.getViewer();assert(pendingRenderer);assert.equal(pendingRenderer.isDestroyed(),false);
 await ui[action]();await opening;
 assert.equal(pendingRenderer.isDestroyed(),true);assert.equal(ui.getViewer(),undefined);assert.equal(calls.viewerClose,1);
 if(action==='quit'){assert.equal(calls.shutdown,1);assert.equal(calls.quit,1)}else await ui.quit();
});


test('quit also cancels an unfinished Harness navigation',{timeout:2000},async()=>{
 let entered;const started=new Promise(resolve=>entered=resolve);
 const {ui,calls}=harness({harnessNavigation:()=>{entered();return new Promise(()=>{})}});await ui.ready;
 const opening=ui.connect();await started;const pending=ui.getRemote();
 await ui.quit();await opening;assert(pending.isDestroyed());assert.equal(calls.shutdown,1);assert.equal(calls.quit,1);
});


test('connection issues distinguish Harness failure from a healthy running VM',async()=>{
 let fail=false;
 const f=harness({manualHealth:true,healthFetch:async()=>{if(fail)throw Error('synthetic unavailable');return{status:200,body:{cancel:async()=>{}}}}});
 await f.ui.ready;
 try{
  await f.ui.connect();assert.equal(f.ui.snapshot().connection.issue,null);
  fail=true;await f.checkHealth();assert.equal(f.ui.snapshot().connection.issue,'control-channel-unavailable');
  fail=false;await f.checkHealth();assert.equal(f.ui.snapshot().connection.issue,null);
  f.ui.getRemote().emit('render-process-gone');assert.equal(f.ui.snapshot().connection.issue,'renderer-stopped');
  await f.checkHealth();assert.equal(f.ui.snapshot().connection.issue,'renderer-stopped');assert.equal(f.ui.snapshot().label,'Renderer stopped');
  await f.ui.disconnect();assert.equal(f.ui.snapshot().connection.issue,null);
 }finally{await f.ui.quit()}
});


test('environment verification remains pending until reconcile succeeds and records failures',async()=>{
 let entered,finish;const started=new Promise(r=>entered=r),gate=new Promise(r=>finish=r);
 const f=harness();f.setNetwork({id:'wrapvm-v1',phase:'running',network:'ready'});
 f.coordinator.reconcile=async()=>{entered();await gate};
 await started;assert.equal(f.ui.snapshot().environmentVerification,'pending');
 finish();await f.ui.ready;assert.equal(f.ui.snapshot().environmentVerification,'verified');await f.ui.quit();
 const failed=harness({reconcileFailure:true});await failed.ui.ready;
 assert.equal(failed.ui.snapshot().environmentVerification,'failed');
 await failed.ui.artifactAction('restore');assert.equal(failed.ui.snapshot().environmentVerification,'verified');await failed.ui.quit();
});


test('environment management rejects untrusted IPC and unknown operations',async()=>{
 const {ui,handlers}=harness();await ui.ready;
 const sender=ui.getNotice();assert.throws(()=>handlers.get('isolated:environment-manage')({sender,senderFrame:sender.mainFrame},'recreate'),/IPC denied/);
 assert.throws(()=>ui.manageEnvironment('delete-all'),/Unknown/);await ui.quit();
});
test('recreate cancellation and export-first never stop or remove the VM',async()=>{
 for(const messageChoice of [0,1]){
  const {ui,calls,messages,setNetwork}=harness({messageChoice});await ui.ready;
  setNetwork({id:'wrapvm-v1',phase:'running'});await ui.manageEnvironment('recreate');
  assert.equal(messages.length,1);assert.equal(messages[0].defaultId,0);assert.match(messages[0].detail,/Other environments are unchanged/);
  assert.equal(calls.stops.length,0);if(messageChoice===1)assert.equal(ui.snapshot().panel,'files');await ui.quit();
 }
});
test('confirmed restart/recreate dispatch only to the selected environment, without autoconnection',async()=>{
 for(const [operation,messageChoice] of [['restart',1],['recreate',2]]){
  const {ui,calls,setNetwork}=harness({messageChoice});await ui.ready;setNetwork({id:'wrapvm-v1',phase:'running'});
  await ui.manageEnvironment(operation);assert.deepEqual(calls.stops,[operation+':wrapvm-v1']);assert.equal(calls.starts,0);
  await ui.quit();
 }
});
test('quit cancels a pending management confirmation and late approval cannot delete',async()=>{
 const {ui,calls,setNetwork,resolveMessage}=harness({deferMessage:true});await ui.ready;setNetwork({id:'wrapvm-v1',phase:'running'});
 const managing=ui.manageEnvironment('recreate');await new Promise(resolve=>setImmediate(resolve));
 await ui.quit();await managing;assert.equal(calls.quit,1);resolveMessage({response:2});await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.stops.length,0);
});
test('ownership replacement during confirmation invalidates destructive intent',async()=>{
 const {ui,calls,coordinator,setNetwork,resolveMessage}=harness({deferMessage:true});await ui.ready;setNetwork({id:'wrapvm-v1',phase:'running'});
 const managing=ui.manageEnvironment('recreate');await new Promise(resolve=>setImmediate(resolve));
 coordinator.journal.environments['wrapvm-v1'].ownershipToken='replacement';resolveMessage({response:2});await managing;
 assert.equal(calls.stops.length,0);await ui.quit();
});
test('recreation preflight and unfinished recreation block inappropriate actions',async()=>{
 const {ui,calls,messages,coordinator,setNetwork}=harness({messageChoice:2});await ui.ready;setNetwork({id:'wrapvm-v1',phase:'error',resetPending:true});
 await ui.manageEnvironment('restart');assert.equal(messages.length,0);
 coordinator.checkRecreate=()=>{throw Error('pending transfers')};await ui.manageEnvironment('recreate');assert.equal(messages.length,0);assert.equal(calls.stops.length,0);await ui.quit();
});

test('cancel and export-first preserve monitoring and crash detection for the retained Harness view',async()=>{
 for(const [operation,messageChoice] of [['restart',0],['recreate',0],['recreate',1]]){
  let fail=false,fetches=0;
  const f=harness({messageChoice,manualHealth:true,healthFetch:async()=>{fetches++;if(fail)throw Error('offline');return {status:200,body:{cancel:async()=>{}}}}});
  await f.ui.ready;f.setNetwork({id:'wrapvm-v1',phase:'running',network:'ready'});
  await f.ui.connect();const remote=f.ui.getRemote();await f.ui.manageEnvironment(operation);
  assert.equal(f.ui.getRemote(),remote);assert.equal(f.calls.stops.length,0);
  const previous=fetches;fail=true;await f.checkHealth();assert.equal(fetches,previous+1);
  assert.equal(f.ui.snapshot().connection.issue,'control-channel-unavailable');
  fail=false;await f.checkHealth();assert.equal(f.ui.snapshot().connection.issue,null);
  remote.emit('render-process-gone');assert.equal(f.ui.snapshot().connection.issue,'renderer-stopped');
  await f.ui.quit();
 }
});
test('released view callbacks and late health results cannot mark a replacement connection unhealthy',async()=>{
 let resolveHealth,pending=false;
 const f=harness({manualHealth:true,healthFetch:()=>pending?new Promise(resolve=>resolveHealth=resolve):Promise.resolve({status:200,body:{cancel:async()=>{}}})});
 await f.ui.ready;f.setNetwork({id:'wrapvm-v1',phase:'running',network:'ready'});
 await f.ui.connect();const old=f.ui.getRemote();pending=true;const health=f.checkHealth();
 await f.ui.disconnect();pending=false;await f.ui.connect();assert.notEqual(f.ui.getRemote(),old);
 old.emit('render-process-gone');resolveHealth({status:503,body:{cancel:async()=>{}}});await health;
 assert.equal(f.ui.snapshot().connection.issue,null);await f.ui.quit();
});

for (const channel of ['model-save','model-remove','model-select','git-save','git-import','git-remove']) {
 test(`${channel} rejects untrusted IPC senders before any lifecycle work`,async()=>{
  const {ui,calls,handlers}=harness();await ui.ready;
  const controls=ui.getControls(),notice=ui.getNotice();
  for(const event of [{sender:notice,senderFrame:notice.mainFrame},{sender:controls,senderFrame:{url:controls.mainFrame.url}},{sender:{},senderFrame:controls.mainFrame}])
   assert.throws(()=>handlers.get('isolated:'+channel)(event,{}),/IPC denied/);
  assert.equal(calls.stops.length,0);assert.equal(calls.catalogChanges.length,0);await ui.quit();
 });
}
for (const channel of ['model-save','git-save']) {
 test(`${channel} validates before stopping and publishes only after all shared leases close`,async()=>{
  const {ui,calls,handlers,coordinator}=harness();await ui.ready;
  const save=input=>handlers.get('isolated:'+channel)(localEvent(ui),input);
  await assert.rejects(save({}),/Invalid catalog input/);assert.equal(calls.stops.length,0);
  const stop=coordinator.stop;coordinator.stop=async()=>{throw Error('synthetic-secret-must-not-escape')};
  await assert.rejects(save({id:'provider',repository:'owner/repo'}),error=>/did not complete/.test(error.message)&&!error.message.includes('synthetic-secret'));
  assert.equal(calls.catalogChanges.length,0);
  coordinator.stop=stop;await save({id:'provider',repository:'owner/repo'});
  assert.equal(calls.stops.length,3);assert.equal(new Set(calls.stops).size,3);
  assert.equal(calls.catalogChanges.length,1);assert.equal(calls.catalogChanges[0][2],true);await ui.quit();
 });
 test(`${channel} forwards shutdown cancellation through an unfinished catalog write`,async()=>{
  let release,signal;const pending=new Promise(resolve=>release=resolve);
  const {ui,calls,handlers}=harness({catalogMutation:async value=>{signal=value;await pending}});await ui.ready;
  const invoke=()=>handlers.get('isolated:'+channel)(localEvent(ui),{id:'provider',repository:'owner/repo'});
  const saving=invoke();const rejected=assert.rejects(saving,/did not complete/);
  await new Promise(resolve=>setImmediate(resolve));assert(signal);
  await assert.rejects(invoke(),/another operation/);
  const quitting=ui.quit();assert(signal.aborted);release();await rejected;await quitting;
  assert.equal(calls.catalogChanges.length,0);
 });
}


test('real model publication failure reaches status UI while runtime grants still fail closed',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-model-fault-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const {ModelCatalog}=require('../src/runtime/model-catalog.cjs');
 let catalog;
 const f=harness({modelCatalogFactory:()=>catalog=new ModelCatalog({stateRoot:root,vault:{has:()=>false}})});
 await f.ui.ready;t.after(()=>f.ui.quit());
 const published=[];
 f.ui.getControls().send=(channel,value)=>{if(channel==='isolated:status')published.push(value)};
 // The real atomic writer rejects a non-file metadata destination before writing.
 fs.mkdirSync(catalog.file);
 const input={id:'fixture',displayName:'Fixture',api:'openai-completions',baseURL:'https://example.test/v1',
  authMode:'none',models:[{id:'fixture-model',name:'Fixture',contextWindow:1000,maxTokens:100}]};
 await assert.rejects(f.handlers.get('isolated:model-save')(localEvent(f.ui),input),{message:'The model catalog is unavailable. Saved data was preserved.'});
 assert.equal(catalog.fault,true);
 assert.equal(f.calls.stops.length,3);
 assert(published.some(value=>value.models.fault===true));
 const status=f.handlers.get('isolated:status')(localEvent(f.ui));
 assert.equal(status.models.fault,true);assert.equal(status.models.providers.length,0);
 assert.equal(status.networkPresentation.groups.length,0);
 const panel=await f.handlers.get('isolated:panel')(localEvent(f.ui),'secrets');
 assert.equal(panel.panel,'secrets');assert.equal(panel.models.fault,true);
 assert.throws(()=>f.credentialBridge({definition:{id:'wrapvm-v1'}}),{code:'MODEL_CATALOG'});
 assert.throws(()=>catalog.providers,{code:'MODEL_CATALOG'});
 await f.ui.quit();assert.equal(f.ui.snapshot().quitting,true);
});
