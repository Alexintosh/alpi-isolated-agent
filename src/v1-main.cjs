const { app, BaseWindow, WebContentsView, ipcMain, session, Tray, Menu, nativeImage, safeStorage, dialog } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require('node:os');
const { pathToFileURL } = require("node:url");
const { createRuntime } = require("./runtime/index.cjs");
const {DESKTOP_IMAGES, desktopImage} = require("./runtime/desktop-images.cjs");
const {DesktopImageStore} = require("./runtime/desktop-image-store.cjs");
const { readJson, writeJson } = require("./runtime/atomic-json.cjs");
const {createViewerBoundary}=require('./runtime/viewer-boundary.cjs');
const { createRendererBoundary } = require("./runtime/renderer-boundary.cjs");
const { NetworkPolicy } = require("./runtime/network-policy.cjs");
const { PERSONAL_ENVIRONMENTS: ENVIRONMENTS } = require("./runtime/environments.cjs");
function environment(id) {
  const found=ENVIRONMENTS.find(item=>item.id===id);
  if(!found)throw Error("Unknown personal environment.");
  return found;
}
const { SecretVault } = require("./runtime/secret-vault.cjs");
const { ModelCatalog } = require("./runtime/model-catalog.cjs");
const { GitCatalog } = require('./runtime/git-catalog.cjs');
const { SecretCatalog } = require('./runtime/secret-catalog.cjs');
const { createCredentialBridge } = require("./runtime/credential-bridge.cjs");
const {ArtifactInstaller}=require('./runtime/artifact-installer.cjs');
const {diagnosticSnapshot}=require('./runtime/diagnostics.cjs');
const {FileTransfers}=require('./runtime/file-transfers.cjs');
const {pendingGroups}=require('./runtime/network-presentation.cjs');
const {startBroker}=require('./orchestration/broker.cjs');

const installedMode=app.isPackaged;
// The host orchestration broker is opt-in from the explicit native startup
// command line only. No renderer, guest or second-instance message can enable it.
const orchestrationEnabled=process.argv.includes('--enable-orchestration');
const stateRoot = path.join(app.getPath("appData"), "Harness Isolated",...(installedMode?['personal-v1']:[]));
fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
app.setPath("userData", path.join(stateRoot, "electron")); app.setName("Harness Isolated"); // Preserve existing safeStorage/Keychain identity; display branding is Alpi.
// Chromium never needs external name resolution: guest UI uses numeric loopback.
app.commandLine.appendSwitch("host-resolver-rules", "MAP * ~NOTFOUND, EXCLUDE 127.0.0.1");
app.commandLine.appendSwitch("force-webrtc-ip-handling-policy", "disable_non_proxied_udp");
app.commandLine.appendSwitch("disable-features", "WebRtcHideLocalIpsWithMdns");
const controlFile = path.join(__dirname, "v1/control.html"), controlURL = pathToFileURL(controlFile).href;
const noticeFile = path.join(__dirname, "v1/notification.html"), noticeURL = pathToFileURL(noticeFile).href;
const selectionFile = path.join(stateRoot, "selection.json");
let window, controls, view, notice, tray, runtime, policy, monitor, controller, task;
let panel = "harness";
let catalog, gitCatalog, secretCatalog, modelBusy = false, filesBusy = false;
const revocations = new Map();
let ready;
let installer,installationReady=!installedMode,installationBusy=false,artifactTask,artifactPicker,diagnosticExportBusy=false;
let diagnostic = {};
let environmentVerification = "pending";
let orchestrationState=orchestrationEnabled?'unavailable':'disabled';
let orchestrationSocket,orchestrationClose,orchestrationStarted=false,orchestrationStarting=false,orchestrationSealed=false,orchestrationBusy=false;
let selectedImage = "stock-amd64";
const imageStore = new DesktopImageStore({stateRoot,artifactRoot:path.join(__dirname,"../vendor")});
let imageTask, imagePicker;
let selectedId = "wrapvm-v1", activeId, activeBoundary, busy = true, quitting = false, allowQuit = false, generation = 0;
let label = "Checking environments…", detail = "", harnessIssue = null;
const boundaries = new Map();
const dismissedNotices = new Map();
let operationStartedAt;
let viewerView, viewerLease, viewerBoundary, viewerController, viewerTask, viewerOpening=false, viewerKind=null, viewerError=null;
let viewerGeneration=0, viewerClosing=Promise.resolve();

function networkPresentation() {
  const groups = pendingGroups(policy?.snapshot(), catalog?.snapshot().providers);
  const now = Date.now();
  for (const [key, until] of dismissedNotices) if (until <= now) dismissedNotices.delete(key);
  return { groups, notification: !quitting && panel !== 'network' ? groups.find(group => !dismissedNotices.has(group.key)) ?? null : null };
}
// Trusted local status only. Fixed English text; no socket path, token or raw
// error is exposed unless the broker reached a ready state.
function orchestrationSnapshot() {
  return {
    enabled: orchestrationEnabled,
    state: orchestrationState,
    ...(orchestrationState === 'ready' && orchestrationSocket ? { socketPath: orchestrationSocket } : {}),
    ...(orchestrationState === 'unavailable' ? { detail: 'The managed runtime is not verified.' } : {}),
    ...(orchestrationState === 'error' ? { detail: 'The orchestration broker could not be started.' } : {}),
  };
}
function snapshot() {
  const environments = runtime?.coordinator.snapshot() ?? [];
  const phase = diagnostic.step === 'start' ? environments.find(item => item.id === selectedId)?.phase ?? 'starting' : diagnostic.step ?? 'working';
  return { environmentVerification, connection:{issue:harnessIssue}, images:{...imageStore.snapshot(selectedImage),busy:Boolean(imageTask)||imageStore.state.busy}, viewer: {available: Boolean(activeId && activeId === selectedId && environment(activeId).desktop), opening: viewerOpening, kind: viewerKind, error: viewerError}, progress: busy && operationStartedAt ? { startedAt: operationStartedAt, phase } : null, networkPresentation: networkPresentation(), selectedId, activeId, busy, quitting, label, detail, panel, modelBusy, filesBusy, installation:installer?{...installer.snapshot(),ready:installationReady}:undefined, resources:runtime?.resources.snapshot(), transfers: runtime?.transfers.snapshot(), shares: runtime?.shares.snapshot(), models: catalog?.snapshot(), git: gitCatalog?.snapshot(), secrets: secretCatalog?.snapshot(), networkPolicy: policy?.snapshot(), environments: runtime?.coordinator.snapshot() ?? [], orchestration: orchestrationSnapshot() };
}
function publish(nextLabel, nextDetail = "") {
  if (nextLabel) { label = nextLabel; detail = nextDetail; }
  if (window && !window.isDestroyed()) controls.webContents.send("isolated:status", snapshot());
  if (notice && window && !window.isDestroyed()) {
    const notification = networkPresentation().notification;
    notice.webContents.send("isolated:notice", notification);
    notice.setVisible(Boolean(notification));
  }
  updateMenu(); return snapshot();
}
function showWindow() { if (window && !window.isDestroyed()) { window.show(); window.focus(); } }
function updateMenu() {
  if (!tray) return;
  const entries = runtime?.coordinator.snapshot() ?? [];
  const pending = policy?.snapshot().events.filter(event => event.status === "pending").length ?? 0;
  tray.setToolTip(`Alpi · ${entries.filter(item => item.phase === "running").length} active environments · ${pending} network requests`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Alpi", click: showWindow },
    { label: `Network requests (${pending})`, click: () => { setPanel("network"); showWindow(); } },
    ...(installedMode?[{label:'Install runtime package…',enabled:!busy&&!quitting,click:()=>{showWindow();void artifactAction('install');}},
      {label:'Restore previous runtime',enabled:!busy&&!quitting&&Boolean(installer?.snapshot().previous),click:()=>{void artifactAction('rollback');}},
      {label:'Recover runtime selection',enabled:!busy&&!quitting&&Boolean(installer?.snapshot().fault&&installer?.snapshot().recoverable),click:()=>{void artifactAction('restore');}}]:[]),
    {label:'Export diagnostics…',enabled:!quitting&&!diagnosticExportBusy,click:()=>{void exportDiagnostics();}},
    { type: "separator" },
    ...entries.map(item => ({ label: `${item.name} · ${item.phase}`, enabled: false })),
    { type: "separator" },
    { label: quitting ? "Shutting down…" : "Quit and stop environments", enabled: !quitting, click: () => { void quit(); } },
  ]));
}
function layout() {
  if (!window || window.isDestroyed()) return;
  const [width, height] = window.getContentSize();
  controls?.setBounds({ x: 0, y: 0, width, height });
  view?.setBounds({ x: 0, y: 0, width, height: Math.max(1, height - 48) });
  viewerView?.setBounds({ x: 0, y: 0, width, height: Math.max(1, height - 48) });
  notice?.setBounds({ x: Math.max(12, width - 396), y: 12, width: 384, height: 224 });
}
function clearViewer() {
  ++viewerGeneration; viewerController?.abort(); viewerController=undefined;
  viewerBoundary?.revoke();
  const lease=viewerLease, boundary=viewerBoundary;
  viewerLease=undefined;viewerBoundary=undefined;viewerKind=null;viewerOpening=false;
  if(['desktop','browser'].includes(panel))panel='harness';
  if(viewerView){
    if(window&&!window.isDestroyed())window.contentView.removeChildView(viewerView);
    if(!viewerView.webContents.isDestroyed())viewerView.webContents.close({waitForBeforeUnload:false});
    viewerView=undefined;
  }
  viewerClosing=viewerClosing.then(async()=>{await lease?.close();await boundary?.close()});
  return viewerClosing;
}
function removeView() {
  void clearViewer();
  clearInterval(monitor); monitor = undefined;
  activeBoundary?.revoke(); activeBoundary = undefined;
  if (view) {
    if (window && !window.isDestroyed()) window.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
    view = undefined;
  }
}
async function releaseView() {
  removeView();
  harnessIssue = null;
  await viewerTask; await viewerClosing;
  const previous = activeId; activeId = undefined;
  if (previous && runtime.coordinator.leases.has(previous)) await runtime.coordinator.disconnect(previous);
}
async function boundaryFor(definition) {
  const target = session.fromPartition(definition.partition);
  let boundary = boundaries.get(definition.id);
  if (!boundary) { boundary = await createRendererBoundary(target); boundaries.set(definition.id, boundary); }
  return { target, boundary };
}
async function action(work) {
  if (busy || filesBusy || imageTask || quitting || !runtime || runtime.coordinator.closing) return snapshot();
  busy = true; operationStartedAt = Date.now(); publish();
  controller = new AbortController();
  const current = ++generation, signal = controller.signal;
  const valid = () => current === generation && !quitting;
  task = (async () => {
    try { await work({ signal, valid }); }
    catch (error) {
      diagnostic.error = error.name;
      diagnostic.networkError = String(error.message).match(/\bERR_[A-Z_]+\b/)?.[0];
      if (valid()) { await releaseView(); publish("Operation not completed", "The environment remains isolated. Retry or stop it using the local controls."); }
    } finally { if (current === generation) { busy = false; publish(); } }
  })();
  await task; return snapshot();
}
function publishConnected(id) {
  if (harnessIssue === "renderer-stopped") return publish("Renderer stopped", "Select Retry to reopen Harness.");
  if (harnessIssue) return publish("Harness connection interrupted", "The local control channel is unavailable. Select Retry to reconnect.");
  const state = runtime?.coordinator.snapshot().find(item => item.id === id);
  if (state?.network === 'offline') {
    const restarting = state.networkStatus?.phase === 'restarting';
    return publish(restarting ? 'Updating network rules…' : 'Harness connected · Network offline',
      restarting ? 'Existing network requests were interrupted. The VM and its workspace remain open.' :
        'Guest traffic is blocked. Select Retry to restore the proxy without restarting the VM.');
  }
  return publish(`Connected · ${environment(id).name}`);
}
async function restoreNetwork() {
  if (busy || filesBusy || quitting || !activeId) return snapshot();
  const id = activeId, current = generation;
  busy = true; operationStartedAt = Date.now(); diagnostic.step = 'network-recovery'; publish('Restoring network…', 'The VM and Harness remain open. Interrupted requests are not replayed.');
  task = (async () => {
    try { await runtime.coordinator.restoreNetwork(id); }
    catch { /* fixed network status records the failure; never discard the view */ }
    finally {
      if (current === generation && !quitting) { busy = false; publishConnected(id); }
    }
  })();
  await task; return snapshot();
}
function connect() {
  if (activeId === selectedId && view && runtime?.coordinator.snapshot().find(item => item.id === activeId)?.network === 'offline')
    return restoreNetwork();
  return action(async ({ signal, valid }) => {
    if(!installationReady)throw new Error('Install and verify the runtime package first.');
    if (!policy || policy.fault || policy.closed) throw new Error("Network policy is unavailable.");
    const definition = environment(selectedId);
    publish(`Starting · ${definition.name}`);
    diagnostic = { step: "start" };
    await releaseView();
    await stopOtherDesktopImages(definition.id, signal);
    await runtime.coordinator.start(definition.id, { signal });
    if (!valid()) return;
    publish(`Connecting · ${definition.name}`);
    diagnostic.step = "connect";
    const opened = await runtime.coordinator.connect(definition.id, { signal });
    if (!valid()) { await opened.close(); return; }
    activeId = definition.id;
    const { target, boundary } = await boundaryFor(definition);
    diagnostic.step = "renderer-policy";
    await boundary.setOrigin(opened.origin);
    if (!valid()) { boundary.revoke(); return; }
    activeBoundary = boundary;
    diagnostic.step = "bootstrap";
    // Exchange the launch credential in the session's network stack, so a
    // renderer navigation warning/history entry can never contain that token.
    const bootstrap = await target.fetch(opened.launchUrl, { redirect: "follow", credentials: "include", signal });
    await bootstrap.body?.cancel();
    diagnostic.bootstrapStatus = bootstrap.status;
    diagnostic.cookieCount = (await target.cookies.get({ url: opened.origin })).length;
    if (![200, 302, 303].includes(bootstrap.status)) throw new Error("Authentication failed");
    if (!valid()) return;
    view = new WebContentsView({ webPreferences: { session: target, sandbox: true, contextIsolation: true,
      nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
      webSecurity: true, webviewTag: false, navigateOnDragDrop: false, disableDialogs: true,
      backgroundThrottling: false } });
    const contents = view.webContents;
    contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    for (const eventName of ["will-navigate", "will-redirect", "will-frame-navigate"])
      contents.on(eventName, (event, destination) => {
        const url = typeof destination === "string" ? destination : event.url;
        try { if (new URL(url).origin !== opened.origin) event.preventDefault(); }
        catch { event.preventDefault(); }
      });
    contents.on("will-attach-webview", event => event.preventDefault());
    // Confirmation-only actions advance the operation generation without
    // replacing this view. Monitoring follows the retained view identity.
    const currentView = () => view?.webContents === contents && activeId === definition.id &&
      !quitting && !contents.isDestroyed();
    contents.on("render-process-gone", () => { if (currentView()) { harnessIssue = "renderer-stopped"; publishConnected(definition.id); } });
    window.contentView.addChildView(view, 1); view.setVisible(panel === "harness"); layout();
    diagnostic.step = "load-ui";
    await navigationUntilAbort(contents.loadURL(opened.origin + "/"), signal);
    if (!valid()) return;
    if (new URL(contents.getURL()).searchParams.has("token")) throw new Error("Authentication incomplete");
    async function check() {
      const response = await target.fetch(opened.origin + "/", { redirect: "error", signal: AbortSignal.timeout(4000) });
      await response.body?.cancel();
      if (response.status !== 200) throw new Error("Guest unavailable");
    }
    diagnostic.step = "verify-auth";
    await check(); diagnostic.step = "connected"; publishConnected(definition.id);
    let checking = false;
    monitor = setInterval(async () => {
      if (checking || !currentView()) return;
      checking = true;
      try { await check(); if (currentView() && !busy) {
        if (harnessIssue !== "renderer-stopped") harnessIssue = null;
        publishConnected(definition.id);
      } }
      catch (error) {
        diagnostic.connectionFailure = error.name === 'TimeoutError' ? 'health-timeout' : 'control-channel-unavailable';
        if (currentView() && !busy) {
          if (harnessIssue !== "renderer-stopped") harnessIssue = "control-channel-unavailable";
          publishConnected(definition.id);
        }
      }
      finally { checking = false; }
    }, 5000);
  });
}
async function disconnect() {
  if (quitting || filesBusy || installationBusy || orchestrationBusy) return snapshot();
  const current = ++generation, previousTask = task;
  busy = true; publish(); controller?.abort(); removeView();
  task = (async () => {
    try {
      await previousTask;
      if (current !== generation || quitting) return;
      await releaseView();
      if (current === generation && !quitting)
        publish("Disconnected", "Running environments continue in the background.");
    } finally { if (current === generation && !quitting) { busy = false; publish(); } }
  })();
  await task; return snapshot();
}
function select(id) {
  const definition=environment(id);
  if(definition.imageId && definition.imageId!==selectedImage) return switchDesktopImage(definition.imageId);
  return action(async () => {
    if (selectedId !== id) { runtime.transfers.cancel(); runtime.shares.cancel(); }
    await releaseView(); selectedId = id; writeJson(selectionFile, { version: 1, id, imageId:selectedImage });
    publish("Environment selected");
  });
}
function stop() {
  return action(async () => {
    const id = selectedId;
    await releaseView(); publish(`Stopping · ${environment(id).name}`);
    await runtime.coordinator.stop(id); publish("Environment stopped");
  });
}
function manageEnvironment(operation) {
  if (!['restart', 'recreate'].includes(operation)) throw new Error('Unknown environment operation.');
  if (modelBusy || installationBusy) return Promise.resolve(snapshot());
  return action(async ({ signal, valid }) => {
    const id = selectedId, definition = environment(id);
    const token = runtime.coordinator.journal.environments[id]?.ownershipToken;
    const state = runtime.coordinator.snapshot().find(item => item.id === id);
    if (!token || !state || (state.phase === 'new' && !state.resetPending)) {
      publish('No environment to manage', 'Select Connect to create this environment first.'); return;
    }
    if (operation === 'restart' && state.resetPending) {
      publish('Recreation incomplete', 'Use Recreate environment in Settings to confirm recovery.'); return;
    }
    if (operation === 'recreate') {
      try { await runtime.coordinator.checkRecreate(id); }
      catch { publish('Recreation unavailable', 'Resolve interrupted transfers in Files and invalid sharing settings before trying again.'); return; }
    } else if (!installationReady || !policy || policy.fault || policy.closed) {
      publish('Restart unavailable', 'Restore the runtime and network policy before restarting. Stop remains available.'); return;
    }
    const image = definition.imageId ? desktopImage(definition.imageId).name : 'Ubuntu 24.04 ARM64';
    const recreate = operation === 'recreate';
    const choice = await navigationUntilAbort(dialog.showMessageBox(window, {
      type: 'warning', buttons: recreate ? ['Cancel', 'Export files first', 'Recreate environment'] : ['Cancel', 'Restart VM'],
      defaultId: 0, cancelId: 0, noLink: true, signal,
      message: recreate ? `Recreate ${definition.name}?` : `Restart ${definition.name}?`,
      detail: `Image: ${image}\n\n` + (recreate ?
        'Permanently deletes this VM’s workspace, Harness sessions, browser data and system changes. Running jobs stop. Shared-folder access is revoked; files on your Mac are not deleted.\n\nKeeps the selected image, resource limits, saved network rules and mode, model/Git settings and host-managed credentials. The fresh VM is created on the next Connect. Other environments are unchanged. This cannot be undone.' :
        'Running jobs stop. Workspace files, Harness sessions, browser data and folder-sharing settings are preserved. The VM restarts; select Connect afterward to reopen Harness.'),
    }), signal);
    signal.throwIfAborted();
    if (!valid() || selectedId !== id || runtime.coordinator.journal.environments[id]?.ownershipToken !== token) return;
    if (recreate && choice.response === 1) { setPanel('files'); publish('Export files before recreating', 'Export what you need, then return to Settings.'); return; }
    if (choice.response !== (recreate ? 2 : 1)) return;
    runtime.transfers.cancel(); runtime.shares.cancel();
    await releaseView(); signal.throwIfAborted();
    publish(recreate ? 'Recreating environment…' : 'Restarting VM…', `${definition.name} · ${image}`);
    if (recreate) {
      // Clear only this app's guest partition. Never the personal Harness app.
      // Do this before deletion so an interrupted reset cannot reuse old cookies.
      const { target, boundary } = await boundaryFor(definition);
      boundary.revoke();
      await target.clearStorageData(); await target.clearCache();
      signal.throwIfAborted();
      await runtime.coordinator.recreate(id, { signal });
    } else await runtime.coordinator.restart(id, { signal });
    if (valid()) publish(recreate ? 'Environment reset' : 'VM restarted', recreate ?
      'Select Connect to create a fresh VM from the same image. Host files and credentials are preserved; folder shares must be added again.' :
      'Your data is preserved. Select Connect to reopen Harness.');
  });
}
async function stopOtherDesktopImages(id, signal) {
  if(environment(id).kind!=='smolvm')return;
  for(const definition of ENVIRONMENTS) {
    if(definition.kind!=='smolvm'||definition.id===id)continue;
    if(runtime.coordinator.journal?.environments?.[definition.id])
      await runtime.coordinator.stop(definition.id,{signal});
  }
}
function switchDesktopImage(id) {
  const image=desktopImage(id);
  if(id===selectedImage)return Promise.resolve(snapshot());
  return action(async({signal,valid})=>{
    if(!imageStore.available(id))throw Error('The selected image is not installed.');
    publish('Switching WrapVM image','Stopping WrapVM jobs; each image keeps its own sessions and workspace.');
    // Do not disturb an attached Lima view until every WrapVM stop succeeded.
    if(activeId && environment(activeId).kind==='smolvm')await releaseView();
    for(const definition of ENVIRONMENTS)if(definition.kind==='smolvm' && runtime.coordinator.journal?.environments?.[definition.id])
      await runtime.coordinator.stop(definition.id,{signal});
    signal.throwIfAborted();if(!valid())return;
    // Commit selection only after all required stops. Failed persistence retains
    // the previous selection, with data intact and environments safely stopped.
    runtime.transfers.cancel();runtime.shares.cancel();await releaseView();
    signal.throwIfAborted();if(!valid())return;
    writeJson(selectionFile,{version:1,id:image.environmentId,imageId:id});
    selectedImage=id;selectedId=image.environmentId;
    publish('WrapVM image selected','Connect to open this image’s own persistent environment.');
  });
}
async function importDesktopImage() {
  if(busy||filesBusy||modelBusy||installationBusy||quitting||imageTask)return snapshot();
  const ticket={cancelled:false};imagePicker=ticket;
  imageTask=(async()=>{
    try {
      const chosen=await dialog.showOpenDialog(window,{title:'Choose the pinned local ARM64 WrapVM image',
        properties:['openFile'],filters:[{name:'WrapVM image archive',extensions:['tar']}]});
      if(imagePicker===ticket)imagePicker=undefined;
      if(ticket.cancelled||quitting||chosen.canceled)return;
      if(chosen.filePaths.length!==1)throw Error('Select one image archive.');
      await imageStore.importLocal(chosen.filePaths[0]);
    }catch{
      if(!ticket.cancelled&&!quitting)imageStore.update({phase:'error',error:'Image import could not be completed. Existing images and workspaces are preserved.'});
    }finally{
      if(imagePicker===ticket)imagePicker=undefined;
    }
  })();
  publish();
  try{await imageTask;}finally{imageTask=undefined;publish();}
  return snapshot();
}
async function quit(exitCode = 0) {
  if (quitting) return;
  quitting = true; ++generation; controller?.abort(); removeView();
  // No broker may be created after a quit attempt, even if verified shutdown
  // fails and the process stays alive with its network guards.
  orchestrationSealed = true;
  installer?.cancel(); imageStore.cancel();
  const pendingImagePicker=imagePicker;
  if(pendingImagePicker)pendingImagePicker.cancelled=true;
  const pendingPicker = artifactPicker;
  if (pendingPicker) pendingPicker.cancelled = true;
  runtime?.transfers.cancel();
  policy?.close();
  publish("Stopping environments…");
  // Abort admitted broker requests and close its listener before verified
  // runtime shutdown. A close failure is bounded and must not change VM
  // shutdown semantics; the closed state is reported either way.
  const brokerClose = orchestrationClose;
  orchestrationClose = undefined; orchestrationStarted = false;
  if (orchestrationEnabled) orchestrationState = 'closed';
  if (brokerClose) { try { await brokerClose(); } catch {} }
  try {
    // Native sheets close when the verified shutdown reaches app.quit().
    // Do not wait for user input; the cancelled ticket forbids later installation.
    if (!pendingPicker) await artifactTask;
    if (!pendingImagePicker) await imageTask;
    await viewerTask; await viewerClosing;
    await runtime?.coordinator.shutdown();
    await task;
    for (const boundary of boundaries.values()) await boundary.close();
    allowQuit = true;
    if (exitCode === 1) app.exit(1); else app.quit();
  } catch {
    // Keep the process/proxy boundary alive until the owned VMs really stop.
    quitting = false; busy = false; showWindow();
    publish("Shutdown incomplete", "Network services are kept running. Retry Quit from the menu bar.");
  }
}
function setPanel(next) {
  if (!["harness", "network", "models", "files", "resources", "secrets"].includes(next)) throw new Error("Invalid panel.");
  if(viewerOpening)void clearViewer();
  panel = next; view?.setVisible(panel === "harness"); viewerView?.setVisible(false); return publish();
}
function navigationUntilAbort(navigation, signal) {
  return new Promise((resolve, reject) => {
    const abort=()=>{signal.removeEventListener('abort',abort);reject(new Error('Guest navigation cancelled.'))};
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(navigation).then(
      value=>{signal.removeEventListener('abort',abort);resolve(value)},
      error=>{signal.removeEventListener('abort',abort);reject(error)});
    if(signal.aborted)abort();
  });
}
async function showViewer(kind) {
  if(!['desktop','browser'].includes(kind))throw Error('Invalid guest view.');
  if(quitting||busy||filesBusy||viewerOpening||!activeId||activeId!==selectedId||!environment(activeId).desktop)return snapshot();
  if(viewerLease?.isClosed()) { await clearViewer(); return showViewer(kind); }
  const id=activeId, current=++viewerGeneration;
  viewerController=new AbortController();const signal=viewerController.signal;
  const valid=()=>!quitting&&!signal.aborted&&current===viewerGeneration&&activeId===id;
  viewerOpening=true;viewerKind=kind;viewerError=null;publish();
  viewerTask=(async()=>{
    let opened,boundary,remote,registered=false;
    try{
      await viewerClosing;
      if(!valid())return;
      if(!viewerLease){
        opened=await runtime.coordinator.serialized(id,async combined=>{
          const coordinator=runtime.coordinator, driver=coordinator.drivers.get(id);
          return driver.openViewer({ownershipToken:coordinator.journal.environments[id]?.ownershipToken,
            network:coordinator.guards.get(id),signal:combined});
        },{signal,recordFailure:false});
        if(!valid()){await opened.close();return}
        // Nonpersistent viewer partition: auth and network boundary are exclusive.
        const target=session.fromPartition('isolated-viewer-'+id+'-'+current);
        boundary=await createViewerBoundary(target,opened.origin,opened.password);
        if(!valid()){await boundary.close();await opened.close();return}
        remote=new WebContentsView({webPreferences:{session:target,sandbox:true,contextIsolation:true,
          nodeIntegration:false,nodeIntegrationInWorker:false,nodeIntegrationInSubFrames:false,
          webSecurity:true,webviewTag:false,navigateOnDragDrop:false,disableDialogs:true,backgroundThrottling:false}});
        const contents=remote.webContents;
        contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
        contents.setWindowOpenHandler(()=>({action:'deny'}));
        for(const name of ['will-navigate','will-redirect','will-frame-navigate'])contents.on(name,(event,destination)=>{
          try{if(new URL(typeof destination==='string'?destination:event.url).origin!==opened.origin)event.preventDefault()}catch{event.preventDefault()}
        });
        contents.on('will-attach-webview',event=>event.preventDefault());
        remote.setVisible(false);window.contentView.addChildView(remote,2);
        // Register before guest JavaScript runs: a stalled navigation must not
        // prevent Disconnect/Quit from closing the renderer and its transport.
        viewerLease=opened;viewerBoundary=boundary;viewerView=remote;registered=true;layout();
        await navigationUntilAbort(contents.loadURL(opened.origin+'/'),signal);
        if(!valid())return;
      }
      if(kind==='browser')await viewerLease.focusBrowser();
      if(!valid())return;
      viewerKind=kind;panel=kind;view?.setVisible(false);viewerView.setVisible(true);
    }catch{
      if(!registered&&remote&&remote!==viewerView){window.contentView.removeChildView(remote);if(!remote.webContents.isDestroyed())remote.webContents.close({waitForBeforeUnload:false})}
      if(!registered&&boundary&&boundary!==viewerBoundary)await boundary.close();
      if(!registered&&opened&&opened!==viewerLease)await opened.close();
      if(valid()){
        await clearViewer();panel='harness';view?.setVisible(true);
        viewerError=kind==='browser'?'Chrome could not be focused. Open Desktop to inspect the guest.':'The guest desktop could not be opened. Retry when the desktop is ready.';
      }
    }finally{if(current===viewerGeneration)viewerOpening=false;publish()}
  })();
  await viewerTask;return snapshot();
}
function sharedCatalogReady(target) {
  if (busy || filesBusy || modelBusy || installationBusy || imageTask || quitting ||
      !runtime || runtime.coordinator.closing || !target)
    throw new Error('Catalog changes are unavailable while another operation is in progress.');
}
function catalogError(error) {
  return new Error(['MODEL_CATALOG', 'GIT_CATALOG'].includes(error?.code) ? error.message :
    'The catalog change did not complete. Check environment ownership, saved state and Keychain availability.');
}
async function sharedCatalogChange(target, prepare, mutate, title) {
  sharedCatalogReady(target);
  let prepared;
  try { prepared = prepare(); } catch (error) { throw catalogError(error); }
  let failure;
  await action(async ({ signal }) => {
    try {
      await releaseView();
      // All environments share these grants. No new catalog may be published
      // until every old lease has closed successfully.
      for (const definition of ENVIRONMENTS) {
        signal.throwIfAborted();
        await runtime.coordinator.stop(definition.id, { signal });
      }
      signal.throwIfAborted();
      await mutate(prepared, signal);
      publish(title, target.snapshot().cleanupPending
        ? 'Access was updated. An unused encrypted record could not be removed. Environments are stopped; select Connect to continue.'
        : 'Environments are stopped. Select Connect to apply the updated catalog.');
    } catch (error) { failure = catalogError(error); throw failure; }
  });
  if (failure) throw failure;
  return snapshot();
}
async function modelAction(operation, input) {
  if (operation === 'probe') {
    sharedCatalogReady(catalog);
    modelBusy = true; publish();
    try { await catalog.probe(); }
    catch { throw new Error('Model check failed. Check the endpoint and Keychain availability.'); }
    finally { modelBusy = false; publish(); }
    return snapshot();
  }
  const operations = {
    import: [() => catalog.prepareImport(), (prepared, signal) => catalog.importDesktop({ prepared, signal })],
    save: [() => catalog.prepareSave(input), (prepared, signal) => catalog.save(prepared, { signal })],
    remove: [() => catalog.prepareRemove(input), (prepared, signal) => catalog.remove(prepared.id, { signal })],
    select: [() => catalog.prepareSelect(input), (prepared, signal) => catalog.select(prepared, { signal })],
  };
  if (!Object.hasOwn(operations, operation)) throw new Error('Unknown model operation.');
  return sharedCatalogChange(catalog, ...operations[operation], 'Models updated');
}
function gitAction(operation, input) {
  const operations = {
    import: [() => gitCatalog.prepareImport(input), (prepared, signal) => gitCatalog.importRepository(prepared.repository, { signal })],
    save: [() => gitCatalog.prepareSave(input), (prepared, signal) => gitCatalog.save(prepared, { signal })],
    remove: [() => gitCatalog.prepareRemove(input), (prepared, signal) => gitCatalog.remove(prepared.id, { signal })],
  };
  if (!Object.hasOwn(operations, operation)) throw new Error('Unknown Git operation.');
  return sharedCatalogChange(gitCatalog, ...operations[operation], 'Git access updated');
}
async function secretAction(operation, input) {
  if (busy || filesBusy || modelBusy || installationBusy || imageTask || quitting ||
      !runtime || runtime.coordinator.closing || !secretCatalog)
    throw new Error('Credentials are unavailable while another operation is in progress.');
  // Capture and validate before stopping anything. Saved credentials cannot be
  // moved to another environment by changing a renderer-provided identifier.
  const prepared = operation === 'save' ? secretCatalog.prepareSave(input) : secretCatalog.prepareRemove(input);
  environment(prepared.environmentId);
  let failed = false;
  await action(async ({ signal }) => {
    try {
      if (activeId === prepared.environmentId) await releaseView();
      await runtime.coordinator.stop(prepared.environmentId, { signal });
      signal.throwIfAborted();
      if (operation === 'save') await secretCatalog.save(prepared, { signal });
      else await secretCatalog.remove(prepared.id);
      publish('Credential access updated', secretCatalog.snapshot().cleanupPending
        ? 'Access was updated. An unused encrypted record could not be removed. The environment is stopped; select Connect to continue.'
        : 'The affected environment is stopped. Select Connect to apply the updated credentials.');
    } catch {
      failed = true;
      throw new Error('Credential operation failed.');
    }
  });
  // Ordinary lifecycle actions return their error state. Credential forms need
  // an explicit rejection so they never present a failed write as a saved secret.
  if (failed) throw new Error('The credential change did not complete. Check environment ownership, saved state and Keychain availability.');
  return snapshot();
}
async function fileAction(operation, input = {}) {
  if (busy || filesBusy || quitting || !runtime) return snapshot();
  const id = selectedId;
  if (runtime.coordinator.snapshot().find(item => item.id === id)?.phase !== "running")
    throw new Error("Start the selected environment first.");
  filesBusy = true; publish();
  try {
    if (operation === "execute") {
      if (typeof input.id !== "string" || runtime.transfers.snapshot().environmentId !== id) throw new Error("Invalid preview.");
      await runtime.transfers.execute(input.id);
    } else {
      const exporting = operation === "export";
      if (!exporting && !["file", "folder"].includes(input.kind)) throw new Error("Invalid selection.");
      const chosen = await dialog.showOpenDialog(window, {
        title: exporting ? "Choose where to create the exported folder" : "Choose what to copy into the VM",
        properties: [exporting || input.kind === "folder" ? "openDirectory" : "openFile"],
      });
      if (chosen.canceled || quitting) return snapshot();
      if (chosen.filePaths.length !== 1) throw new Error("Choose one item.");
      if (exporting) await runtime.transfers.prepareExport(id, input.source, chosen.filePaths[0], input.name);
      else await runtime.transfers.prepareImport(id, chosen.filePaths[0], input.destination, input.name);
    }
  } catch { throw new Error("Transfer failed. Check the preview, paths and file types. Existing files are never overwritten automatically."); }
  finally { filesBusy = false; publish(); }
  return snapshot();
}
async function recoverTransfer(id, action) {
  if (busy || filesBusy || quitting || !runtime) return snapshot();
  const record=runtime.transfers.snapshot().interrupted.find(item=>item.id===id && item.environmentId===selectedId);
  if(!record || !['discard','forget'].includes(action)) throw new Error('Interrupted transfer not found.');
  filesBusy=true;publish();
  try {
    if(action==='discard') {
      const choice=await dialog.showMessageBox(window,{type:'warning',buttons:['Cancel','Delete partial output'],defaultId:0,cancelId:0,
        message:'Delete the interrupted transfer output?',
        detail:`${record.destination}\n\nDeletion requires the original transfer marker. Any files added inside this folder are also deleted. Completed or replaced output is preserved.`});
      if(choice.response!==1 || quitting)return snapshot();
    }
    await runtime.transfers.recover(id,action);
  }catch {throw new Error('Recovery was not confirmed. Files were preserved where ownership could not be verified. Start the original guest to clean up an import, or keep the files and dismiss this record.');}
  finally{filesBusy=false;publish();}
  return snapshot();
}
async function setResources(value) {
  if(busy||filesBusy||quitting||!runtime)return snapshot();
  const id=selectedId;filesBusy=true;publish();
  try {
    runtime.resources.validate(id,value);
    if(activeId===id)await releaseView();
    await runtime.resources.set(id,value);
    publish('Resource limits saved','The environment is stopped. Connect to apply the new limits; guest data is preserved.');
  }finally{filesBusy=false;publish();}
  return snapshot();
}
async function shareAction(operation, input = {}) {
  if (busy || filesBusy || quitting || !runtime) return snapshot();
  const id = selectedId;
  filesBusy = true; publish();
  try {
    if (operation === 'prepare') {
      if (!['ro', 'rw'].includes(input.mode)) throw new Error('Invalid mode');
      const chosen = await dialog.showOpenDialog(window, { title: 'Choose the exact folder to share', properties: ['openDirectory'] });
      if (chosen.canceled || quitting) return snapshot();
      if (chosen.filePaths.length !== 1) throw new Error('Invalid selection');
      runtime.shares.prepare(id, chosen.filePaths[0], input.mode);
    } else {
      const state = runtime.shares.snapshot();
      const item = operation === 'confirm' ? state.preview : state.shares.find(value => value.id === input.id);
      if (!item || item.id !== input.id || item.environmentId !== id) throw new Error('Invalid share');
      runtime.transfers.cancel(); await releaseView();
      if (operation === 'confirm') await runtime.shares.confirm(input.id); else await runtime.shares.remove(input.id);
      publish('Environment stopped', 'Folder shares saved. Select Connect to restart the VM.');
    }
  } catch { throw new Error('Folder sharing failed. Check that the folder does not contain private app data or overlap another shared folder.'); }
  finally { filesBusy = false; publish(); }
  return snapshot();
}
function dismissNetworkNotice(key) {
  if (typeof key !== 'string' || !networkPresentation().groups.some(group => group.key === key)) return snapshot();
  dismissedNotices.set(key, Date.now() + 60000); return publish();
}
function decideNetworkGroup(key, decision) {
  if (quitting || !policy) throw new Error("Network is unavailable.");
  const group = networkPresentation().groups.find(item => item.key === key);
  if (!group) return publish();
  dismissedNotices.set(key, Date.now() + 60000);
  // Capture the current batch: a once-only click never approves later arrivals.
  for (const id of group.ids) policy.respond(id, decision);
  return publish();
}
async function setNetworkMode(id, mode) {
  if (quitting || !policy) throw new Error("Network is unavailable.");
  environment(id); policy.setMode(id, mode);
  await revocations.get(id); return publish();
}
function decideNetwork(id, decision) {
  if (quitting || !policy) throw new Error("Network is unavailable.");
  policy.respond(id, decision); return publish();
}
async function revokeNetwork(id) {
  if (quitting || !policy) throw new Error("Network is unavailable.");
  const environmentId = policy.revoke(id);
  if (environmentId) await revocations.get(environmentId);
  return publish();
}
function addNetworkRule(input) {
  if (quitting || !policy || !input || typeof input.origin !== "string") throw new Error("Invalid rule.");
  const origin = new URL(input.origin);
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") throw new Error("Enter only the destination origin.");
  environment(input.environmentId);
  policy.addRule({ environmentId: input.environmentId, scheme: origin.protocol.slice(0, -1), host: origin.hostname,
    port: Number(origin.port || (origin.protocol === "https:" ? 443 : 80)), method: input.method || null, pathname: input.pathname || null, action: input.action ?? "allow" });
  return publish();
}
function authorize(event, name) {
  if (window && notice && event.sender === notice.webContents && event.senderFrame === notice.webContents.mainFrame &&
      event.senderFrame.url === noticeURL && ['network-group-decision', 'network-notice-dismiss', 'network-notice-state', 'network-notice-review'].includes(name)) return;
  if (!window || event.sender !== controls.webContents || event.senderFrame !== controls.webContents.mainFrame || event.senderFrame.url !== controlURL)
    throw new Error("IPC denied");
}
function trayImage() {
  const size = 18, pixels = Buffer.alloc(size * size * 4);
  for (let y = 3; y < 15; y++) for (let x = 3; x < 15; x++)
    if (x < 5 || x > 12 || y === 8 || y === 9) pixels[(y * size + x) * 4 + 3] = 255;
  const image = nativeImage.createFromBitmap(pixels, { width: size, height: size });
  image.setTemplateImage(true); return image;
}

function initializeRuntime(options={}) {
 environmentVerification = "pending";
 imageStore.artifactRoot=options.artifactRoot??path.join(__dirname,"../vendor");
 const next=createRuntime({stateRoot,...options,definitions:ENVIRONMENTS,localImageArchive:imageStore.localArchive,
  ...(installedMode?{runtimeRoot:path.join(os.homedir(),'.harness-isolated/v1')}:{}),
  decide:input=>policy?.decide(input)??false,
  credentialBridge: settings => {
   const secrets = secretCatalog?.entriesFor(settings.definition.id) ?? [];
   if (!catalog?.providers?.length && !gitCatalog?.repositories?.length && !secrets.length) return undefined;
   return createCredentialBridge({ environmentId: settings.definition.id, secrets,
    providers: catalog.providers, selected: catalog.selected, gitRepositories: gitCatalog?.repositories ?? [],
    vault: catalog.vault, proxyPort: settings.proxyPort, caFile: settings.caFile,
    port: settings.definition.credentialPort, decide: settings.decide });
  },
  onFault:(id)=>{ if (!busy && !quitting && activeId === id) publishConnected(id); }});
 for(const service of [runtime?.coordinator,runtime?.transfers,runtime?.shares,runtime?.resources])service?.removeAllListeners('change');
 runtime=next;
 for(const service of [runtime.coordinator,runtime.transfers,runtime.shares,runtime.resources])service.on('change',()=>publish());
}
async function reconcileRuntime() {
 environmentVerification = "pending";
 try { await runtime?.coordinator.reconcile(); environmentVerification = "verified"; }
 catch(error) { environmentVerification = "failed"; throw error; }
}
async function exportDiagnostics() {
  if (quitting || diagnosticExportBusy) return snapshot();
  diagnosticExportBusy = true;
  const expectedGeneration = generation;
  let descriptor;
  try {
    const chosen = await dialog.showSaveDialog(window, {title:'Export diagnostics',defaultPath:'harness-isolated-diagnostics.json',filters:[{name:'JSON document',extensions:['json']}]});
    if (chosen.canceled || quitting || generation !== expectedGeneration) return snapshot();
    if (!chosen.filePath || !path.isAbsolute(chosen.filePath)) throw Error('Invalid destination.');
    const guard = runtime?.transfers ?? new FileTransfers({stateRoot,runtimeRoot:path.join(os.homedir(),'.harness-isolated')});
    const parent = guard.hostPath(path.dirname(chosen.filePath));
    const destination = path.join(parent,path.basename(chosen.filePath));
    let build;
    try { build = readJson(path.join(__dirname,'../build.json'),{}); } catch { build = {}; }
    const document = diagnosticSnapshot({appVersion:app.getVersion(),electronVersion:process.versions.electron,nodeVersion:process.versions.node,
      platform:process.platform,arch:process.arch,osRelease:os.release(),commit:build.commit,snapshot:snapshot()});
    // Export contains only allowlisted metadata/counts. Never overwrite a file,
    // and never accept a renderer-supplied path or diagnostic payload.
    descriptor = fs.openSync(destination,'wx',0o600);
    fs.writeFileSync(descriptor,JSON.stringify(document,null,2)+'\n');fs.fsyncSync(descriptor);
    publish('Diagnostics exported','The report contains versions and status counts, without credentials, URLs or workspace paths.');
  } catch {
    if (!quitting) publish('Diagnostics not exported','Choose a new filename outside private application folders and retry. Existing files are preserved.');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    diagnosticExportBusy=false;updateMenu();
  }
  return snapshot();
}
function initializeServices() {
  if (!policy) {
    policy = new NetworkPolicy({ stateRoot, environmentIds: ENVIRONMENTS.map(item => item.id) });
    policy.on("change", () => publish());
    policy.on("revoke-environment", id => {
      const operation = runtime.network.quarantine(id).catch(() => {
        if (!quitting && activeId === id) publishConnected(id);
      });
      revocations.set(id, operation);
      void operation.finally(() => { if (revocations.get(id) === operation) revocations.delete(id); publish(); });
    });
  }
  if (!catalog) catalog = new ModelCatalog({ stateRoot, vault: new SecretVault({ stateRoot, safeStorage }) });
  if (!gitCatalog) gitCatalog = new GitCatalog({ stateRoot, vault: catalog.vault });
  if (!secretCatalog) secretCatalog = new SecretCatalog({ stateRoot, vault: catalog.vault, environmentIds: ENVIRONMENTS.map(item => item.id) });
}
// Broker operations share the native lifecycle exclusion. The service already
// admits one request at a time; this guard additionally refuses while a trusted
// UI mutation owns the runtime or the environment is not verified.
function orchestrationRefusal(code) {
  const messages = { busy: 'Another operation is in progress.',
    closing: 'Application shutdown is in progress.',
    runtime_unavailable: 'The managed runtime is unavailable.' };
  const error = new Error(messages[code]);
  error.code = code;
  return error;
}
async function orchestrationExclusive(work) {
  if (quitting) throw orchestrationRefusal('closing');
  if (!runtime || runtime.coordinator.closing) throw orchestrationRefusal('runtime_unavailable');
  if (!installationReady || environmentVerification !== 'verified') throw orchestrationRefusal('runtime_unavailable');
  if (orchestrationBusy || busy || filesBusy || modelBusy || installationBusy || imageTask || viewerOpening) throw orchestrationRefusal('busy');
  orchestrationBusy = true; busy = true; operationStartedAt = Date.now();
  try { publish(); return await work(); }
  finally {
    orchestrationBusy = false;
    // Quit owns the final busy state; never overwrite a failed-shutdown reset.
    if (!quitting) { busy = false; publish(); }
  }
}
async function startOrchestration() {
  if (!orchestrationEnabled || orchestrationSealed || orchestrationStarted || orchestrationStarting || quitting) return;
  if (!runtime || !installationReady || environmentVerification !== 'verified') { orchestrationState = 'unavailable'; return; }
  orchestrationStarting = true;
  try {
    const broker = await startBroker({ stateRoot, getRuntime: () => runtime,
      getModels: () => catalog?.snapshot(), runExclusive: orchestrationExclusive });
    if (quitting || orchestrationSealed) {
      try { await broker.close(); } catch {}
      orchestrationState = 'closed';
      return;
    }
    orchestrationClose = broker.close;
    orchestrationSocket = broker.socketPath;
    orchestrationStarted = true;
    orchestrationState = 'ready';
  } catch { orchestrationState = (quitting || orchestrationSealed) ? 'closed' : 'error'; }
  finally { orchestrationStarting = false; }
}
async function stopForArtifacts(){
 if(quitting)throw Error('Application shutdown is in progress.');
 await releaseView();
 if(runtime)for(const id of runtime.coordinator.definitions.keys())await runtime.coordinator.stop(id);
}
async function artifactAction(operation){
 if(!installer||busy||filesBusy||modelBusy||quitting||installationBusy)return snapshot();
 if(!['install','rollback','restore'].includes(operation))throw Error('Unknown runtime action.');
 busy=true;installationBusy=true;publish('Preparing runtime change','Managed environments will stop. Sessions and files are preserved.');
 artifactTask=(async()=>{
  try{
   await stopForArtifacts();
   if(quitting)return;
   let options;
   if(operation==='install'){
    const ticket={cancelled:false};artifactPicker=ticket;
    let chosen;
    try{chosen=await dialog.showOpenDialog(window,{title:'Choose the verified Alpi runtime package',properties:['openDirectory']});}
    finally{if(artifactPicker===ticket)artifactPicker=undefined;}
    if(ticket.cancelled||chosen.canceled||quitting)return;
    if(chosen.filePaths.length!==1)throw Error('Choose one runtime package.');
    const id=await installer.prepare(chosen.filePaths[0]);
    options=await installer.activate(id,{stopEnvironments:stopForArtifacts});
   }else if(operation==='restore')options=await installer.restore({stopEnvironments:stopForArtifacts});
   else options=await installer.activate(installer.snapshot().previous,{stopEnvironments:stopForArtifacts});
   if(quitting)return;
   installationReady=false;
   initializeRuntime(options);await reconcileRuntime();initializeServices();installationReady=true;
   await startOrchestration();
   publish('Runtime ready','Choose an environment and connect. Its workspace stays inside the VM.');
  }catch{
   if(environmentVerification === 'pending')environmentVerification = 'failed';
   if(!quitting)publish('Runtime change not completed','Check environment status and retry. Completed verified files are kept; invalid files are preserved.');
  }finally{installationBusy=false;busy=false;publish();}
 })();
 await artifactTask;artifactTask=undefined;return snapshot();
}

if (!app.requestSingleInstanceLock()) app.exit(0);
else {
  app.on("second-instance", showWindow); app.on("activate", showWindow);
  app.on("before-quit", event => { if (!allowQuit) { event.preventDefault(); void quit(); } });
  app.on("window-all-closed", () => {});
  ready = app.whenReady().then(async () => {
    tray = new Tray(trayImage()); tray.on("click", showWindow);
    window = new BaseWindow({ width: 1380, height: 960, minWidth: 1000, minHeight: 650,
      title: "Alpi", backgroundColor: "#161719" });
    controls = new WebContentsView({ webPreferences: {
        preload: path.join(__dirname, "v1/preload.cjs"), sandbox: true, contextIsolation: true,
        nodeIntegration: false, webSecurity: true, webviewTag: false,
      } });
    window.contentView.addChildView(controls);
    notice = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'v1/notification-preload.cjs'),
      sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false } });
    notice.setBackgroundColor('#00000000'); notice.setVisible(false);
    notice.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    notice.webContents.on('will-navigate', event => event.preventDefault());
    notice.webContents.on('will-attach-webview', event => event.preventDefault());
    window.contentView.addChildView(notice); layout();
    window.on("closed", () => {
      if (!controls.webContents.isDestroyed()) controls.webContents.close();
      if (!notice.webContents.isDestroyed()) notice.webContents.close();
    });
    window.on("close", event => { if (!allowQuit) { event.preventDefault(); window.hide(); } });
    window.on("resize", layout);
    controls.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    controls.webContents.on("will-navigate", event => event.preventDefault());
    controls.webContents.on("will-attach-webview", event => event.preventDefault());
    for (const [name, handler] of Object.entries({ connect, disconnect, 'viewer-open':showViewer, select, stop, quit, status: snapshot,
      'environment-manage':manageEnvironment, 'diagnostics-export':exportDiagnostics, 'desktop-image-switch':switchDesktopImage,
      'desktop-image-import':importDesktopImage, 'desktop-image-cancel':()=>{if(orchestrationBusy)return snapshot();if(imagePicker)imagePicker.cancelled=true;imageStore.cancel();return publish();}, panel: setPanel, "network-decision": decideNetwork, "network-revoke": revokeNetwork, "network-add": addNetworkRule, "network-mode": setNetworkMode,
      "network-group-decision": decideNetworkGroup, "network-notice-dismiss": dismissNetworkNotice,
      "network-notice-state": () => networkPresentation().notification,
      "network-notice-review": () => { setPanel('network'); showWindow(); return snapshot(); },
      "model-import": () => modelAction("import"), "model-probe": () => modelAction("probe"),
      'model-save': input => modelAction('save', input), 'model-remove': id => modelAction('remove', id),
      'model-select': selection => modelAction('select', selection),
      'git-import': repository => gitAction('import', repository), 'git-remove': id => gitAction('remove', id),
      'git-save': input => gitAction('save', input),
      'secret-save': input => secretAction('save', input), 'secret-remove': id => secretAction('remove', id),
      "file-import": input => fileAction("import", input), "file-export": input => fileAction("export", input),
      "file-execute": id => fileAction("execute", { id }), "file-cancel": () => { if(orchestrationBusy)return snapshot(); runtime?.transfers.cancel(); return publish(); },
      "file-recover": recoverTransfer,
      "resources-set": setResources,
      'runtime-install':()=>artifactAction('install'),'runtime-rollback':()=>artifactAction('rollback'),'runtime-restore':()=>artifactAction('restore'),
      'runtime-cancel':()=>{if(orchestrationBusy)return snapshot();installer?.cancel();return publish();},
      "share-prepare": input => shareAction('prepare', input), "share-confirm": id => shareAction('confirm', { id }),
      "share-remove": id => shareAction('remove', { id }), "share-cancel": () => { if(orchestrationBusy)return snapshot(); runtime?.shares.cancel(); return publish(); },
      "network-clear": () => { policy?.clearHistory(); return publish(); } }))
      ipcMain.handle(`isolated:${name}`, (event, ...args) => { authorize(event, name); return handler(...args); });
    imageStore.on('change',()=>publish());
    await controls.webContents.loadFile(controlFile);
    await notice.webContents.loadFile(noticeFile);
    try {
      try{
        const stored=readJson(selectionFile,{version:1,id:selectedId});
        const definition=environment(stored.id);
        const image=desktopImage(stored.imageId??definition.imageId??selectedImage);
        if(definition.imageId && definition.imageId!==image.id)throw Error('Inconsistent image selection.');
        selectedId=stored.id;selectedImage=image.id;
      }catch{diagnostic.selectionRecovery=true;}
      if(installedMode){
       installer=new ArtifactInstaller({stateRoot});
       installer.on('change',()=>{
        const state=installer.snapshot();
        if(installationBusy&&!quitting)publish(`Runtime · ${state.phase}`,`${Math.floor(state.received/1024/1024)} / ${Math.floor(state.total/1024/1024)} MiB${state.file?' · '+state.file:''}`);else publish();
       });
       const recovery=installer.recoveryOptions();if(recovery)initializeRuntime(recovery);
      }else initializeRuntime();
      // Recover owned guests even if a separate policy/catalog file is corrupt.
      // No new VM can start before a valid policy exists.
      await reconcileRuntime();
      initializeServices();
      if(installedMode){
       if(installer.snapshot().active&&!installer.snapshot().fault){await installer.verifyRelease(installer.snapshot().active);installationReady=true;}
       busy=false;await startOrchestration();
       publish(installationReady?'Disconnected':'Runtime setup required',installationReady?'':'Use the menu bar icon → Install runtime package. Previous PoC data remains separate.');
      }else{busy = false; await startOrchestration(); publish("Disconnected");}
    } catch { if(environmentVerification === "pending")environmentVerification = "failed"; busy = false; publish("Recovery required", "Saved state could not be verified. Unrecognized environments are never adopted."); }
    updateMenu();
  }).catch(() => { allowQuit = true; app.quit(); });
}

// Main-process test entry point only; none of this is exposed by the preload.
module.exports = { ready, snapshot, connect, disconnect, select, stop, quit, showWindow, manageEnvironment,
  artifactAction, exportDiagnostics, showViewer, switchDesktopImage, importDesktopImage,
  getRuntime: () => runtime,
  getViewer:()=>viewerView?.webContents, getNotice: () => notice?.webContents, getWindow: () => window, getControls: () => controls?.webContents, getRemote: () => view?.webContents, getDiagnostic: () => ({ ...diagnostic,
    viewBounds: view?.getBounds(), viewVisible: view?.getVisible(), children: window?.contentView.children.length }) };
