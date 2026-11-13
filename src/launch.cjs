const {app}=require('electron');
// Refuse a malformed bundle before it can select the development profile.
const ui=app.isPackaged?require('./v1-main.cjs'):undefined;
if(!ui){console.error('This entry point requires a packaged Alpi application.');app.exit(1);}

// Optional local startup diagnostic. It exercises the packaged app entry point
// and trusted renderer, then performs the normal managed shutdown. No VM start,
// model invocation, picker automation or credential value is requested here.
if(ui&&process.argv.includes('--check-startup')){
 (async()=>{
  await ui.ready;
  const controls=ui.getControls(),state=ui.snapshot();
  if(!controls||controls.isDestroyed())throw Error('Trusted controls unavailable.');
  const preferences=controls.getLastWebPreferences();
  const bridge=await controls.executeJavaScript('({install:typeof window.isolated.installRuntime,status:typeof window.isolated.status})');
  if(!app.isPackaged||!preferences.sandbox||!preferences.contextIsolation||preferences.nodeIntegration||bridge.install!=='function'||!state.installation)throw Error('Packaged startup check failed.');
  console.log('HARNESS_STARTUP_CHECK '+JSON.stringify({packaged:app.isPackaged,version:app.getVersion(),sandbox:true,contextIsolation:true,nodeIntegration:false,
   installBridge:true,installationReady:state.installation.ready,installationFault:state.installation.fault,environmentCount:state.environments.length,vmStartRequested:false}));
  await ui.quit();
 })().catch(async()=>{console.error('Packaged startup check failed.');await ui.quit(1);});
}
