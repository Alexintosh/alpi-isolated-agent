const {
  app,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  session,
} = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createRegistry } = require("./engines/index.cjs");
const CONTROL = pathToFileURL(path.join(__dirname, "control.html")).href;
const stateRoot = path.join(app.getPath("appData"), "Harness Native VM PoC");
fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
app.setPath("userData", path.join(stateRoot, "electron"));
app.setName("Harness VM PoC");
const registry = createRegistry({ stateRoot });
const selectionFile = path.join(stateRoot, "environment.json");
let selectedId = "lima-poc",
  selectionError = "";
try {
  const stored = JSON.parse(fs.readFileSync(selectionFile, "utf8"));
  registry.get(stored.id);
  selectedId = stored.id;
} catch (error) {
  if (error.code !== "ENOENT") {
    selectedId = "";
    selectionError =
      "Selezione salvata non valida: scegli esplicitamente un ambiente.";
  }
}
let window, view, lease, monitor, remoteSession, abortController;
let environments = [],
  activeId = null;
let state = { phase: "disconnected", label: "Disconnesso", busy: false };
let quitting = false,
  operation = 0;
const configuredSessions = new Set();
function snapshot() {
  return { ...state, selectedId, activeId, environments };
}
function publish(phase, label, detail = "", busy = false) {
  state = { phase, label, detail, busy };
  if (window && !window.isDestroyed())
    window.webContents.send("poc:status", snapshot());
}
async function refresh() {
  environments = await registry.list();
  return snapshot();
}
async function closeTransport() {
  clearInterval(monitor);
  monitor = undefined;
  const oldView = view;
  view = undefined;
  if (oldView) {
    if (window && !window.isDestroyed())
      window.contentView.removeChildView(oldView);
    if (!oldView.webContents.isDestroyed()) oldView.webContents.close();
  }
  const oldLease = lease;
  lease = undefined;
  activeId = null;
  await oldLease?.close();
}
function layout() {
  if (view && window && !window.isDestroyed()) {
    const [width, height] = window.getContentSize();
    view.setBounds({ x: 0, y: 132, width, height: Math.max(1, height - 132) });
  }
}
function acceptedNavigation(url, origin = lease?.origin) {
  try {
    return !!origin && new URL(url).origin === origin;
  } catch {
    return false;
  }
}
function secureRemote(contents, origin) {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  for (const name of ["will-navigate", "will-redirect"])
    contents.on(name, (event, url) => {
      if (!acceptedNavigation(url, origin)) event.preventDefault();
    });
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.on("render-process-gone", () => {
    if (view?.webContents === contents)
      publish(
        "error",
        "Errore",
        "Il renderer Harness si è arrestato. Premi Riprova.",
      );
  });
}
function getSession(engine) {
  const target = session.fromPartition(engine.partition);
  if (!configuredSessions.has(engine.partition)) {
    configuredSessions.add(engine.partition);
    target.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    target.setPermissionCheckHandler(() => false);
    target.on("will-download", (event, item, contents) => {
      if (
        !view ||
        contents !== view.webContents ||
        !acceptedNavigation(item.getURL())
      ) {
        event.preventDefault();
        return;
      }
      item.setSaveDialogOptions({
        title: "Esporta file dal guest",
        defaultPath: path.basename(item.getFilename()),
        properties: ["showOverwriteConfirmation"],
      });
      item.once("done", (_event, result) => {
        if (result === "interrupted" && view?.webContents === contents)
          publish("error", "Errore", "Trasferimento dal guest interrotto.");
      });
    });
  }
  return target;
}
function errorText(error) {
  // Never expose raw CLI stdout/stderr: it may contain a launch credential.
  if (error.cmd || String(error.message).includes("Command failed"))
    return "Engine o backend non disponibili. Controlla la preparazione dell’ambiente selezionato.";
  return String(error.message ?? "Collegamento non riuscito.").replace(
    /([?&]token=)[^\s]+/g,
    "$1[REDACTED]",
  );
}
async function connect() {
  if (state.busy || quitting) return snapshot();
  if (selectionError) {
    publish("error", "Seleziona un ambiente", selectionError);
    return snapshot();
  }
  const engine = registry.get(selectedId);
  const current = ++operation;
  abortController?.abort();
  const controller = new AbortController();
  abortController = controller;
  const isCurrent = () => current === operation && !quitting;
  publish("starting", "Avvio · " + engine.name, "", true);
  try {
    await closeTransport();
    if (!isCurrent()) return snapshot();
    await engine.start({ signal: controller.signal });
    if (!isCurrent()) return snapshot();
    publish("connecting", "Connessione · " + engine.name, "", true);
    const opened = await engine.connect({
      signal: controller.signal,
      onDisconnect: () => {
        if (isCurrent())
          publish(
            "disconnected",
            "Collegamento interrotto",
            "Premi Riprova per ricollegare " + engine.name + ".",
          );
      },
    });
    if (!isCurrent()) {
      await opened.close();
      return snapshot();
    }
    lease = opened;
    activeId = engine.id;
    remoteSession = getSession(engine);
    const contentsView = new WebContentsView({
      webPreferences: {
        session: remoteSession,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        webviewTag: false,
        navigateOnDragDrop: false,
      },
    });
    view = contentsView;
    secureRemote(view.webContents, opened.origin);
    window.contentView.addChildView(view);
    layout();
    await view.webContents.loadURL(opened.launchUrl);
    if (!isCurrent()) return snapshot();
    if (new URL(view.webContents.getURL()).searchParams.has("token"))
      throw new Error(
        "Il backend non ha completato lo scambio di autenticazione.",
      );
    const targetSession = remoteSession;
    const response = await targetSession.fetch(opened.origin + "/", {
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });
    await response.body?.cancel();
    if (!isCurrent()) return snapshot();
    if (response.status !== 200)
      throw new Error("Autenticazione guest non riuscita.");
    await refresh();
    if (!isCurrent()) return snapshot();
    publish("connected", "Connesso · " + engine.name);
    let checking = false;
    monitor = setInterval(async () => {
      if (checking || !isCurrent()) return;
      checking = true;
      try {
        const r = await targetSession.fetch(opened.origin + "/", {
          signal: AbortSignal.timeout(3000),
          redirect: "error",
        });
        await r.body?.cancel();
        if (r.status !== 200) throw new Error("auth");
        if (isCurrent() && lease === opened)
          publish("connected", "Connesso · " + engine.name);
      } catch {
        if (isCurrent())
          publish(
            "disconnected",
            "Disconnesso · " + engine.name,
            "Backend non raggiungibile. Premi Riprova.",
          );
      } finally {
        checking = false;
      }
    }, 5000);
  } catch (error) {
    if (!isCurrent()) return snapshot();
    await closeTransport();
    if (isCurrent())
      publish("error", "Errore · " + engine.name, errorText(error));
  }
  return snapshot();
}
async function disconnect() {
  const current = ++operation;
  abortController?.abort();
  abortController = undefined;
  publish("disconnecting", "Disconnessione", "", true);
  await closeTransport();
  if (current === operation) publish("disconnected", "Disconnesso");
  return snapshot();
}
async function selectEnvironment(id) {
  registry.get(id); // Validate before releasing a working connection.
  if (state.busy)
    throw new Error(
      "Attendi il completamento dell’operazione o premi Disconnetti.",
    );
  await disconnect();
  selectedId = id;
  selectionError = "";
  publish("selecting", "Selezione ambiente", "", true);
  const temporary = selectionFile + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify({ version: 1, id }) + "\n", {
    mode: 0o600,
  });
  fs.renameSync(temporary, selectionFile);
  await refresh();
  publish("disconnected", "Disconnesso");
  return snapshot();
}
async function stopEnvironment() {
  if (state.busy) return snapshot();
  const engine = registry.get(selectedId);
  await disconnect();
  const current = ++operation;
  const controller = new AbortController();
  abortController = controller;
  publish("stopping", "Arresto · " + engine.name, "", true);
  try {
    await engine.stop({ signal: controller.signal });
    await refresh();
    if (current === operation) publish("disconnected", "Ambiente arrestato");
  } catch (error) {
    if (current === operation)
      publish("error", "Arresto non riuscito", errorText(error));
  }
  return snapshot();
}
function authorize(event) {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame ||
    event.senderFrame.url !== CONTROL
  )
    throw new Error("IPC denied");
}
if (!app.requestSingleInstanceLock()) app.quit();
else
  app.whenReady().then(async () => {
    window = new BrowserWindow({
      width: 1380,
      height: 960,
      minWidth: 1000,
      minHeight: 650,
      title: "Harness VM PoC",
      backgroundColor: "#161719",
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        webviewTag: false,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.on("will-attach-webview", (event) =>
      event.preventDefault(),
    );
    for (const [channel, handler] of [
      ["connect", connect],
      ["disconnect", disconnect],
      ["status", refresh],
      ["select", selectEnvironment],
      ["stop", stopEnvironment],
    ])
      ipcMain.handle("poc:" + channel, (event, ...args) => {
        authorize(event);
        return handler(...args);
      });
    window.on("resize", layout);
    if (selectionError)
      publish("error", "Seleziona un ambiente", selectionError);
    await window.loadFile(path.join(__dirname, "control.html"));
  });
app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  disconnect().finally(() => app.quit());
});
