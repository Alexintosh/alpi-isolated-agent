const $ = id => document.getElementById(id);
let optionsKey, lastState, actionError = "", dismissedMessage = "";
const operationPhases = {
  start: "Starting environment", preparing: "Preparing environment", starting: "Starting VM",
  running: "VM ready", connect: "Connecting", "renderer-policy": "Securing guest UI",
  bootstrap: "Preparing Harness", "load-ui": "Loading Harness", "verify-auth": "Checking access",
  "network-recovery": "Restoring network", working: "Working",
};
function render(state) {
  lastState = state;
  $("diagnostics-export").disabled = Boolean(state.quitting);
  renderInstallation(state); renderNetwork(state); renderModels(state); renderFiles(state);
  renderShares(state); renderGit(state); renderResources(state); renderDesktopImages(state); renderEnvironmentManagement(state); renderSecrets(state);
  const guestVisible = ["desktop", "browser"].includes(state.panel) || (state.panel === "harness" && Boolean(state.activeId));
  $("content").hidden = guestVisible;
  const environments = state.environments ?? [];
  // Image profiles remain in the snapshot for policy, transfers and running-job status.
  // The toolbar represents engines: Lima and the explicitly selected WrapVM image.
  const imageEnvironment = state.images?.items?.find(item => item.id === state.images.selected)?.environmentId;
  const entries = state.images
    ? environments.filter(item => item.id === "lima-v1" || item.id === imageEnvironment)
    : environments;
  const key = JSON.stringify(entries.map(item => [item.id, item.name]));
  if (key !== optionsKey) {
    $("environment").replaceChildren(...entries.map(item => {
      const option = document.createElement("option"); option.value = item.id;
      option.textContent = item.name; return option;
    }));
    optionsKey = key;
  }
  $("environment").value = state.selectedId;
  $("environment").disabled = state.busy || state.filesBusy || state.quitting || !entries.length;
  const selected = environments.find(item => item.id === state.selectedId);
  $("capabilities").textContent = selected ?
    `${selected.kind === "smolvm" ? "Browser and desktop" : "Shell and terminal"} · Files in the VM · ${selected.network === "ready" ? "Network controlled by Iron" : "Network offline"}` : "";
  renderLifecycle(state, selected);
  $("stop").disabled = state.busy || state.filesBusy || state.quitting || !selected || ["new", "stopped"].includes(selected.phase);
  for (const [id, panel] of [["harness", "harness"], ["network", "network"], ["files", "files"], ["models", "models"], ["secrets", "secrets"], ["resources", "resources"]])
    $(id).setAttribute("aria-pressed", String(state.panel === panel));
  const viewerBlocked = !state.viewer?.available || state.viewer?.opening || state.busy || state.filesBusy || state.quitting;
  for (const kind of ["desktop", "browser"]) {
    $(kind).disabled = viewerBlocked;
    $(kind).setAttribute("aria-pressed", String(state.panel === kind));
    $(kind).setAttribute("aria-busy", String(Boolean(state.viewer?.opening && state.viewer?.kind === kind)));
  }
  $("desktop").title = !state.viewer?.available ? "Desktop is available when connected to an owned WrapVM environment" : "Show the full VM desktop";
  $("browser").title = !state.viewer?.available ? "Browser focus is available when connected to an owned WrapVM environment" : "Focus an existing Chrome window in the full VM desktop; does not open a new browser, profile or tab";
  renderFeedback();
}
// One lifecycle control; release/cancel never depends on connection prerequisites.
function lifecycleAction(state, selected) {
  if (state.busy || state.viewer?.opening) return "cancel";
  // Interrupted deletion needs native reconfirmation. An active connection can
  // still be released without attempting another start or network recovery.
  if (selected?.resetPending) return state.activeId === selected.id ? "disconnect" : "settings";
  if (state.connection?.issue) return "retry";
  if (selected && state.activeId === state.selectedId && selected.phase === "running" &&
      selected.network === "ready" && !selected.issue && !state.viewer?.error) return "disconnect";
  return selected && (selected.phase === "error" || selected.phase === "running" ||
    state.activeId === state.selectedId) ? "retry" : "connect";
}
function lifecycleControl(state, selected) {
  const action = lifecycleAction(state, selected);
  const releasing = action === "cancel" || action === "disconnect";
  const runtimeBlocked = Boolean(state.installation && !state.installation.ready);
  const blocked = state.filesBusy || state.quitting || state.installation?.busy || state.images?.busy;
  const disabled = Boolean(blocked || (action !== "settings" && !releasing && (state.modelBusy || !selected || runtimeBlocked ||
    !state.networkPolicy || state.networkPolicy.fault || state.networkPolicy.closed)));
  return { action, releasing, runtimeBlocked, disabled };
}
function renderLifecycle(state, selected) {
  const { action, releasing, runtimeBlocked, disabled } = lifecycleControl(state, selected);
  $("connect").disabled = disabled;
  $("connect-label").textContent = { cancel: "Cancel", disconnect: "Disconnect", retry: "Retry", connect: "Connect", settings: "Settings" }[action];
  $("connect").dataset.action = action;
  $("connect").classList.toggle("primary", !releasing);
  $("connect").setAttribute("aria-label", {
    cancel: "Cancel current operation", disconnect: "Disconnect and keep VM and jobs running",
    retry: "Retry connection to selected environment", connect: "Connect to selected environment",
    settings: "Review incomplete environment recreation in Settings",
  }[action]);
  $("connect").title = releasing
    ? action === "cancel" ? "Cancel the current connection or startup operation" : "Disconnect; the VM and its jobs keep running"
    : action === "settings" ? "Recreation incomplete. Confirm Recreate environment again in Settings."
      : runtimeBlocked ? "Install the runtime package in Settings first."
      : action === "retry" && state.activeId === state.selectedId
        ? "Restore the connection without restarting the VM. Interrupted requests are not replayed."
        : "Connect to the selected environment";
}
function feedbackText() {
  return actionError || lastState?.viewer?.error || lastState?.detail || "";
}
function renderFeedback() {
  if (!lastState) return;
  const state = lastState, message = feedbackText();
  $("detail").textContent = message;
  // Guest surfaces are separate trusted views. Their persistent status lives in the bottom bar.
  const messagePanel = { resources: "resources-panel", network: "network-panel", models: "models-panel", files: "files-panel", secrets: "secrets-panel" }[state.panel];
  const messageHost = messagePanel ? $(messagePanel).querySelector(".page-body") : null;
  if (messageHost && $("local-message").parentNode !== messageHost) messageHost.prepend($("local-message"));
  $("local-message").hidden = !message || dismissedMessage === message || !messageHost || $("content").hidden;
  const selected = state.environments?.find(item => item.id === state.selectedId);
  const status = [selected?.name, state.label, message, $("capabilities").textContent].filter(Boolean).join(" · ");
  $("status").title = status;
  $("status").setAttribute("aria-label", status || "Environment status unavailable");
  $("status").dataset.state = actionError || state.viewer?.error || selected?.resetPending || selected?.phase === "error" || state.networkPolicy?.fault || state.environmentVerification === "failed"
    ? "error" : state.busy || state.viewer?.opening || state.environmentVerification === "pending" ? "busy"
      : selected?.phase === "running" && state.activeId === state.selectedId ? "ready" : "idle";
  $("environment").title = status;
  $("environment").setAttribute("aria-describedby", "capabilities");
  renderWelcome(state);
  renderProgress();
}
function renderProgress() {
  if (!lastState) return;
  const state = lastState, progress = state.progress;
  const busy = Boolean(state.busy || state.viewer?.opening || state.modelBusy || state.filesBusy || state.quitting);
  let phase = state.viewer?.opening ? `Opening ${state.viewer.kind === "browser" ? "Chrome" : "desktop"}`
    : state.quitting ? "Stopping environments" : /^(Restarting VM|Recreating environment)/.test(state.label ?? "") ? state.label
      : progress ? operationPhases[progress.phase] ?? state.label ?? "Working"
      : state.modelBusy ? "Checking models" : state.filesBusy ? "Working with files" : state.label || "Working";
  const startedAt = Number(progress?.startedAt);
  const elapsed = Number.isFinite(startedAt) && startedAt > 0 ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : null;
  const elapsedText = elapsed === null ? "" : ` · ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;
  $("operation-status").hidden = !busy && !feedbackText();
  $("operation-status").classList.toggle("has-message", !busy);
  $("operation-status").querySelector(".spinner").hidden = !busy;
  $("operation-text").textContent = busy ? phase + elapsedText : feedbackText();
  const slow = Boolean(state.busy && elapsed !== null && elapsed >= 30);
  const explanation = slow ? " Startup can take longer while the environment is prepared. You can cancel from the bottom bar." : "";
  $("operation-status").title = [phase + elapsedText, state.label, feedbackText()].filter(Boolean).join(" · ") + explanation;
  const announcement = [busy ? phase : state.label, feedbackText()].filter(Boolean).join(" · ");
  if ($("status-announcement").textContent !== announcement) $("status-announcement").textContent = announcement;
  $("slow-start").hidden = !slow;
  $("welcome-state").textContent = busy ? [phase + elapsedText, state.detail].filter(Boolean).join(" · ") : [state.label, feedbackText()].filter(Boolean).join(" · ");
  $("welcome-state").dataset.state = actionError || state.viewer?.error || state.connection?.issue || selectedWelcomeError(state) || state.label === "Recovery required" ? "error" : busy ? "busy" : "idle";
}
async function act(action) {
  actionError = "";
  try { const result = await action(); if (result && typeof result === "object") render(result); }
  catch (error) {
    actionError = typeof error?.message === "string" ? error.message
      : "Operation not completed. Retry, or stop the environment from the bottom bar.";
    dismissedMessage = "";
    renderFeedback();
  }
}
$("message-dismiss").addEventListener("click", () => { dismissedMessage = feedbackText(); renderFeedback(); });
function runLifecycleAction() {
  if (!lastState || $("connect").disabled) return;
  const { action, disabled } = lifecycleControl(lastState, lastState.environments?.find(item => item.id === lastState.selectedId));
  if (disabled) return;
  void act(() => action === "settings" ? window.isolated.showPanel("resources")
    : action === "cancel" || action === "disconnect" ? window.isolated.disconnect() : window.isolated.connect());
}
$("connect").addEventListener("click", runLifecycleAction);
$("stop").addEventListener("click", () => act(() => window.isolated.stopEnvironment()));
$("environment").addEventListener("change", () => act(() => window.isolated.selectEnvironment($("environment").value)));
$("harness").addEventListener("click", () => act(() => window.isolated.showPanel("harness")));
for (const kind of ["desktop", "browser"])
  $(kind).addEventListener("click", () => act(() => window.isolated.showViewer(kind)));

function selectedWelcomeError(state) {
  const selected = state.environments?.find(item => item.id === state.selectedId);
  return selected?.resetPending || selected?.phase === "error" || selected?.issue || state.installation?.fault || state.installation?.phase === "error" || state.networkPolicy?.fault || state.networkPolicy?.closed ||
    ["Operation not completed", "Runtime change not completed"].includes(state.label);
}
function runtimeChangePending(state) {
  // The public snapshot has no installationBusy flag. During the native package
  // picker, installer.busy is false; the main-process operation label identifies it.
  return Boolean(state.installation?.busy || (state.busy && /^(Preparing runtime change|Runtime ·)/.test(state.label ?? "")));
}
function welcomeRuntime(state) {
  const inst = state.installation;
  if (runtimeChangePending(state)) return { text: "Runtime change in progress", tone: "busy", action: "Review runtime" };
  if (inst?.fault || inst?.phase === "error" || state.label === "Runtime change not completed" || (!inst?.ready && state.label === "Recovery required"))
    return { text: "Verification or recovery required", tone: "error", action: "Review runtime" };
  if (!inst) return { text: state.busy ? "Checking runtime" : "Development mode", tone: state.busy ? "busy" : "unknown" };
  if (inst.active && inst.ready) return { text: "Installed and verified", tone: "ready" };
  if (inst.active) return { text: state.busy ? "Checking runtime" : "Verification required", tone: state.busy ? "busy" : "error", action: "Review runtime" };
  return { text: "Not installed", tone: "idle", action: "Set up runtime" };
}
function welcomeAction(state, selected) {
  if (selected?.resetPending && !runtimeChangePending(state)) {
    const control = lifecycleControl(state, selected);
    return { ...control, label: { cancel: "Cancel", disconnect: "Disconnect", settings: "Review environment" }[control.action] };
  }
  const runtime = welcomeRuntime(state);
  if (runtime.action) return { action: "settings", label: runtime.action,
    disabled: Boolean(state.quitting || state.filesBusy || runtimeChangePending(state) || state.images?.busy) };
  const control = lifecycleControl(state, selected);
  return { ...control, label: { connect: "Connect", retry: "Retry", cancel: "Cancel", disconnect: "Disconnect" }[control.action] };
}
function welcomeStatus(name, text, tone = "unknown", title = text) {
  const value = $("welcome-" + name + "-value");
  value.textContent = text; value.dataset.state = tone; value.title = title;
  $("welcome-" + name + "-dot").dataset.state = tone;
}
function renderWelcome(state) {
  const selected = state.environments?.find(item => item.id === state.selectedId);
  // Match the image to the selected environment, never the global image preference
  // (which remains set when the user selects Lima).
  const image = selected && state.images?.items?.find(item => item.environmentId === selected.id);
  const architecture = image?.architecture ?? selected?.architecture;
  const architectureLabel = { arm64: "ARM64", aarch64: "ARM64", x64: "AMD64", amd64: "AMD64", x86_64: "AMD64" }[architecture];
  const capability = selected?.kind === "smolvm" ? "Browser & desktop" : selected?.kind === "lima" ? "Shell & terminal" : "";
  $("welcome-environment").textContent = selected?.name ?? "No environment selected";
  $("welcome-capabilities").textContent = [architectureLabel, capability, selected ? "Selected environment" : ""].filter(Boolean).join(" · ");
  const runtime = welcomeRuntime(state);
  welcomeStatus("runtime", runtime.text, runtime.tone);
  const vmPhases = { new: ["Not started", "idle"], preparing: ["Preparing", "busy"], ready: ["Prepared · not running", "idle"],
    starting: ["Starting", "busy"], running: ["Running", "ready"], stopping: ["Stopping", "busy"], stopped: ["Stopped", "idle"],
    error: ["State unconfirmed · operation failed", "error"] };
  const pendingVerification = state.environmentVerification === "pending";
  const failedVerification = state.environmentVerification === "failed";
  const vm = selected?.resetPending ? ["Recreation incomplete", "error"] : pendingVerification ? ["Checking saved state", "busy"] : failedVerification ? ["State unverified · recovery required", "error"] : actionError ? ["State unconfirmed · action failed", "error"] : selected?.issue
    ? [selected.phase === "running" ? "Running · needs attention" : "State unconfirmed · needs attention", "error"]
    : vmPhases[selected?.phase] ?? ["Unknown", "unknown"];
  welcomeStatus("vm", ...vm);
  const policy = state.networkPolicy;
  const mode = policy?.modes?.[state.selectedId] ?? "ask";
  const modes = { ask: "rules & approvals", "allow-all": "all destinations allowed", "block-all": "all traffic blocked" };
  const networkDetail = "No direct egress. In Ask mode, saved rules apply and new destinations need approval. Imported model endpoints do not grant network permission.";
  if (selected?.resetPending) welcomeStatus("network", "Recreation incomplete · Iron", "error", networkDetail);
  else if (pendingVerification || failedVerification)
    welcomeStatus("network", pendingVerification ? "Checking environment · Iron" : "Environment unverified · Iron", pendingVerification ? "busy" : "error", networkDetail);
  else if (!policy || policy.fault || policy.closed)
    welcomeStatus("network", policy?.fault ? "Offline · rules unavailable" : policy?.closed ? "Offline · policy closed" : "Offline · policy unavailable", policy?.fault || policy?.closed ? "error" : "unknown", networkDetail);
  else if (selected?.network === "ready")
    welcomeStatus("network", `Through Iron · ${modes[mode] ?? "mode unknown"}`, mode === "block-all" ? "idle" : modes[mode] ? "ready" : "unknown", networkDetail);
  else welcomeStatus("network", `${selected?.network === "offline" ? "Offline" : "Unknown"} · Iron · ${modes[mode] ?? "mode unknown"}`, "unknown", networkDetail);
  const connected = Boolean(selected && state.activeId === state.selectedId);
  if (selected?.resetPending) welcomeStatus("harness", "Recreation incomplete · review Settings", "error");
  else if (pendingVerification || failedVerification) welcomeStatus("harness", pendingVerification ? "Waiting for environment verification" : "Environment unverified · recovery required", pendingVerification ? "busy" : "error");
  else if (state.connection?.issue) welcomeStatus("harness", "Connection issue · retry required", "error");
  else if (state.busy || state.viewer?.opening) welcomeStatus("harness", "Not ready · operation in progress", "busy");
  else if (!connected && (actionError || state.label === "Operation not completed")) welcomeStatus("harness", "Not connected · operation failed", "error");
  else if (connected && selected.phase === "running" && !selected.issue && !state.viewer?.error)
    welcomeStatus("harness", "Connected", "ready");
  else welcomeStatus("harness", connected ? "Not ready · review status" : "Disconnected", connected ? "error" : "unknown");
  const action = welcomeAction(state, selected), button = $("welcome-action");
  button.textContent = action.label; button.disabled = action.disabled; button.dataset.action = action.action;
  button.setAttribute("aria-label", action.action === "settings" ? `${action.label} in Settings`
    : { cancel: "Cancel current operation", disconnect: "Disconnect and keep VM and jobs running", retry: "Retry connection to selected environment", connect: "Connect to selected environment" }[action.action]);
  button.classList.toggle("primary", action.action !== "cancel" && action.action !== "disconnect");
  const el = $("welcome-runtime");
  el.hidden = !runtime.action && !selected?.resetPending;
  el.textContent = selected?.resetPending ? "Recreation incomplete. Retry Recreate environment in Settings and confirm recovery."
    : runtime.action ? runtimeChangePending(state) ? "Review progress in Settings."
    : runtime.action === "Set up runtime" ? "Choose a verified runtime package in Settings."
      : "Review runtime verification and recovery in Settings." : "";
  for (const id of ["welcome-files", "welcome-network", "welcome-settings"]) $(id).disabled = Boolean(state.quitting);
  $("welcome").hidden = state.panel !== "harness" || Boolean(state.activeId);
}
$("welcome-action").addEventListener("click", () => {
  if (!lastState || $("welcome-action").disabled) return;
  const action = welcomeAction(lastState, lastState.environments?.find(item => item.id === lastState.selectedId));
  if (action.disabled) return;
  if (action.action === "settings") void act(() => window.isolated.showPanel("resources"));
  else runLifecycleAction();
});
for (const [id, panel] of [["welcome-files", "files"], ["welcome-network", "network"], ["welcome-settings", "resources"]])
  $(id).addEventListener("click", () => {
    if (!lastState || lastState.quitting || $(id).disabled) return;
    void act(() => window.isolated.showPanel(panel));
  });

let environmentManagementPending = false;
function environmentManagementBlock(state, operation) {
  if (!state) return "Environment status is unavailable.";
  const selected = state.environments?.find(item => item.id === state.selectedId);
  if (environmentManagementPending || state.busy || state.filesBusy || state.modelBusy || state.quitting ||
      selected?.busy || state.viewer?.opening || runtimeChangePending(state) || state.images?.busy || desktopImageAction)
    return "Wait for the current operation to finish before managing this environment.";
  if (!selected) return "Select an environment to manage.";
  // Resource snapshots exist only after the main process has a runtime. A
  // missing installation can still leave that runtime available for recreation.
  if (!state.resources?.environments?.some(item => item.id === selected.id) || state.resources.fault ||
      typeof window.isolated.manageEnvironment !== "function")
    return "Environment management is unavailable. Review runtime and resource settings.";
  if (selected.phase === "new" && !selected.resetPending)
    return "Connect to create this environment before using these actions.";
  if (operation === "restart") {
    if (selected.resetPending) return "Recreation incomplete. Confirm Recreate environment again to recover.";
    if ((state.installation && (!state.installation.ready || state.installation.fault || state.installation.phase === "error")) ||
        !state.networkPolicy || state.networkPolicy.fault || state.networkPolicy.closed)
      return "Restore the runtime and network policy before restarting. Stop remains available.";
  }
  return "";
}
function renderEnvironmentManagement(state) {
  const selected = state.environments?.find(item => item.id === state.selectedId);
  const image = selected && state.images?.items?.find(item => item.environmentId === selected.id);
  $("management-environment").textContent = selected?.name ?? "No environment selected";
  $("management-image").hidden = !image?.name;
  $("management-image").textContent = image?.name ? `Image: ${image.name}` : "";
  $("management-recovery").hidden = !selected?.resetPending;
  const restartBlock = environmentManagementBlock(state, "restart");
  const recreateBlock = environmentManagementBlock(state, "recreate");
  $("environment-restart").disabled = Boolean(restartBlock);
  $("environment-recreate").disabled = Boolean(recreateBlock);
  $("environment-restart").title = restartBlock;
  $("environment-recreate").title = recreateBlock;
  $("management-availability").textContent = state.busy
    ? [state.label, state.detail].filter(Boolean).join(" · ")
    : recreateBlock || (selected?.resetPending ? "" : restartBlock);
  $("environment-export").disabled = Boolean(state.quitting || environmentManagementPending);
}
for (const operation of ["restart", "recreate"])
  $("environment-" + operation).addEventListener("click", async () => {
    // Recheck the authoritative snapshot even for synthetic or queued clicks.
    if (environmentManagementBlock(lastState, operation)) return;
    environmentManagementPending = true;
    renderEnvironmentManagement(lastState);
    try { await act(() => window.isolated.manageEnvironment(operation)); }
    finally { environmentManagementPending = false; renderEnvironmentManagement(lastState); }
  });
$("environment-export").addEventListener("click", () => {
  if (!lastState || lastState.quitting || environmentManagementPending) return;
  selectFilesSection("export");
  void act(() => window.isolated.showPanel("files"));
});

let resourceKey, resourceEnvironment;
const resourceDrafts = new Map();
function renderResources(state) {
  $("resources-panel").hidden = state.panel !== "resources";
  const data = state.resources, item = data?.environments?.find(value => value.id === state.selectedId);
  const blocked = state.busy || state.filesBusy || state.modelBusy || state.quitting || !item || data?.fault;
  for (const id of ["resource-cpus", "resource-memory", "resource-disk-gib", "resource-overlay-gib", "resource-save"])
    $(id).disabled = blocked;
  $("resource-environment").textContent = (state.environments ?? []).find(value => value.id === state.selectedId)?.name ?? "";
  if (data?.fault) {
    $("resource-budget").textContent = "Resource settings are invalid and were preserved. VM stop remains available from the toolbar.";
    $("resource-disk").textContent = "";
    return;
  }
  if (!item) return;
  const key = JSON.stringify(item), draft = resourceDrafts.get(state.selectedId);
  if (resourceEnvironment !== state.selectedId || (!draft && key !== resourceKey)) {
    $("resource-cpus").value = draft?.cpus ?? item.cpus;
    $("resource-memory").value = draft?.memoryMiB ?? item.memoryMiB;
    $("resource-disk-gib").value = draft?.diskGiB ?? item.diskGiB;
    $("resource-overlay-gib").value = draft?.overlayGiB ?? item.overlayGiB ?? 10;
    resourceKey = key; resourceEnvironment = state.selectedId;
  }
  $("resource-cpus").max = data.limits.cpus;
  $("resource-memory").max = data.limits.memoryMiB;
  const wrap = item.diskChange === "grow-only";
  const env = state.environments?.find(value => value.id === state.selectedId);
  const limaLocked = item.diskChange === "before-create" && Boolean(env?.prepared);
  const disk = $("resource-disk-gib");
  disk.max = data.limits.diskGiB;
  disk.min = wrap ? Math.max(20, item.diskGiB) : 20;
  disk.disabled = blocked || limaLocked;
  disk.title = limaLocked ? "Disk capacity for this environment is fixed after its first creation." : "";
  const overlayRow = $("resource-overlay-row");
  overlayRow.hidden = item.overlayGiB === undefined;
  if (!overlayRow.hidden) {
    const overlay = $("resource-overlay-gib");
    overlay.max = data.limits.overlayGiB;
    overlay.min = Math.max(10, item.overlayGiB);
    overlay.title = "WrapVM disk capacity can only grow; it never shrinks below the current value.";
  }
  let text = `Disk capacity: ${item.diskGiB} GiB${item.overlayGiB ? `, plus ${item.overlayGiB} GiB system overlay` : ""}. Capacity is the virtual disk size, not a per-workspace quota or reserved host space.`;
  if (limaLocked) text += " Disk capacity is fixed for this environment after its first creation.";
  if (wrap) text += " WrapVM disk and overlay can only grow, never shrink below their current sizes.";
  $("resource-disk").textContent = text;
  const total = data.environments.reduce((sum, value) => sum + value.memoryMiB, 0);
  $("resource-budget").textContent =
    `Combined configured memory: ${total} MiB; host memory: ${data.limits.hostMemoryMiB} MiB. ` +
    (total > data.limits.hostMemoryMiB ? "Running environments at these limits can exhaust host memory." : "Leave room for macOS and other apps when running environments.");
}
$("resources").addEventListener("click", () => act(() => window.isolated.showPanel("resources")));
$("resources-back").addEventListener("click", () => act(() => window.isolated.showPanel("harness")));
$("resource-form").addEventListener("submit", event => {
  event.preventDefault();
  const value = { cpus: Number($("resource-cpus").value), memoryMiB: Number($("resource-memory").value) };
  const diskGiB = Number($("resource-disk-gib").value);
  if (Number.isFinite(diskGiB) && diskGiB > 0) value.diskGiB = diskGiB;
  const overlayGiB = Number($("resource-overlay-gib").value);
  // Overlay is a WrapVM-only setting; never send it for Lima environments.
  if (!($("resource-overlay-row").hidden) && Number.isFinite(overlayGiB) && overlayGiB > 0) value.overlayGiB = overlayGiB;
  act(async () => {
    const result = await window.isolated.setResources(value);
    resourceDrafts.delete(resourceEnvironment); resourceKey = undefined;
    return result;
  });
});

for (const id of ["resource-cpus", "resource-memory", "resource-disk-gib", "resource-overlay-gib"])
  $(id).addEventListener("input", () => {
    if (resourceEnvironment) resourceDrafts.set(resourceEnvironment, {
      cpus: $("resource-cpus").value, memoryMiB: $("resource-memory").value,
      diskGiB: $("resource-disk-gib").value, overlayGiB: $("resource-overlay-gib").value,
    });
  });

const desktopImageControls = [
  ["local-arm64", "desktop-image-local"], ["stock-amd64", "desktop-image-official"],
];
let desktopImageDraft, desktopImageSelected, desktopImageAction = null, desktopImageCancelling = false;
function renderDesktopImages(state) {
  const images = state.images;
  $("desktop-image-section").hidden = !images;
  if (!images) return;
  // Ordinary refreshes preserve a draft; only an authoritative image change resets it.
  if (desktopImageSelected !== images.selected || desktopImageDraft === undefined) {
    desktopImageSelected = images.selected;
    desktopImageDraft = images.selected;
  }
  const blocked = Boolean(state.busy || state.filesBusy || state.modelBusy || state.quitting ||
    state.installation?.busy || images.busy || desktopImageAction);
  for (const [id, controlId] of desktopImageControls) {
    const item = images.items?.find(value => value.id === id);
    $(controlId).checked = desktopImageDraft === id;
    $(controlId).disabled = blocked;
    const provenance = item?.provenance || "Provenance not supplied";
    const origin = id === "local-arm64" ? "Local adapted image" : "Official image · Uses Rosetta";
    $(controlId + "-details").textContent = [origin, `Provenance: ${provenance}`,
      item?.available ? "Available" : "Unavailable", images.selected === id ? "Current image" : ""].filter(Boolean).join(" · ");
  }
  const choice = images.items?.find(item => item.id === desktopImageDraft);
  const changed = desktopImageDraft !== images.selected;
  $("desktop-image-switch").disabled = blocked || !changed || !choice?.available ||
    typeof window.isolated.switchDesktopImage !== "function";
  const missingLocal = desktopImageDraft === "local-arm64" && !choice?.available;
  const canImport = typeof window.isolated.importDesktopImage === "function";
  $("desktop-image-import").hidden = !missingLocal;
  $("desktop-image-import").disabled = blocked || !canImport;
  $("desktop-image-import-help").hidden = !missingLocal;
  $("desktop-image-error").hidden = !images.error;
  $("desktop-image-error").textContent = images.error || "";
  const phases = { copying: "Copying local ARM64 image…", verifying: "Verifying local ARM64 image…" };
  $("desktop-image-summary").textContent = desktopImageAction === "switch"
    ? "Stopping the current WrapVM and switching image…"
    : images.busy ? phases[images.phase] ?? "Importing local ARM64 image…"
      : desktopImageAction === "import" ? "Choose the local image archive on your Mac…"
        : !choice?.available ? missingLocal
          ? canImport ? "Import the local ARM64 image before switching." : "Local ARM64 image import is unavailable in this app version."
          : "This image is unavailable. It must be available before switching."
          : changed ? "Choice not applied. Use the switch button to stop WrapVM and select this image."
            : "Current image selected. Choosing another image does not switch it automatically.";
  $("desktop-image-progress-wrap").hidden = !images.busy;
  if (images.busy) {
    const received = Math.max(0, Number(images.received) || 0), total = Number(images.total) || 0;
    const progress = $("desktop-image-progress");
    if (total > 0) { progress.max = total; progress.value = Math.min(received, total); }
    else progress.removeAttribute("value");
    const miB = value => (value / 1024 / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 });
    $("desktop-image-progress-text").textContent = `${phases[images.phase] ?? "Importing local ARM64 image…"} ${miB(received)}${total > 0 ? ` / ${miB(total)}` : ""} MiB`;
  }
  $("desktop-image-cancel").hidden = !images.busy;
  $("desktop-image-cancel").disabled = Boolean(state.quitting || desktopImageCancelling ||
    typeof window.isolated.cancelDesktopImageImport !== "function");
}
for (const [id, controlId] of desktopImageControls)
  $(controlId).addEventListener("change", () => {
    if (!$(controlId).checked || !lastState?.images) return;
    desktopImageDraft = id;
    renderDesktopImages(lastState);
  });
async function desktopImageOperation(kind, action) {
  if (desktopImageAction) return;
  desktopImageAction = kind;
  renderDesktopImages(lastState);
  try { await act(action); }
  finally { desktopImageAction = null; renderDesktopImages(lastState); }
}
$("desktop-image-switch").addEventListener("click", () => {
  if ($("desktop-image-switch").disabled) return;
  const id = desktopImageDraft;
  void desktopImageOperation("switch", () => window.isolated.switchDesktopImage(id));
});
$("desktop-image-import").addEventListener("click", () => {
  if (!$("desktop-image-import").disabled)
    void desktopImageOperation("import", () => window.isolated.importDesktopImage());
});
$("desktop-image-cancel").addEventListener("click", async () => {
  if ($("desktop-image-cancel").disabled) return;
  desktopImageCancelling = true;
  renderDesktopImages(lastState);
  try { await act(() => window.isolated.cancelDesktopImageImport()); }
  finally { desktopImageCancelling = false; renderDesktopImages(lastState); }
});

function renderInstallation(state) {
  const inst = state.installation;
  $("runtime-section").hidden = !inst;
  if (!inst) return;
  const blocked = state.busy || state.filesBusy || state.modelBusy || state.quitting || inst.busy;
  const phasesText = {
    verifying: "Verifying the runtime package…",
    copying: "Copying runtime files…",
    extracting: "Extracting archives…",
    stopping: "Stopping managed environments…",
    ready: "Runtime package ready.",
    active: "Runtime active.",
    cancelled: "Runtime change cancelled.",
    error: "Runtime change not completed.",
  };
  const fault = $("runtime-fault");
  fault.hidden = !(inst.fault && !inst.recoverable);
  if (!fault.hidden) fault.textContent =
    "The saved runtime selection is invalid and was preserved. No verified recovery release is available. Keep the private app data and consult the recovery instructions before continuing.";
  const summary = $("runtime-summary");
  if (inst.busy) summary.textContent = phasesText[inst.phase] ?? "Working…";
  else if (inst.active && inst.ready) summary.textContent = "Runtime installed and verified.";
  else if (inst.active) summary.textContent = "Runtime installed; verification pending.";
  else if (inst.fault && inst.recoverable) summary.textContent = "The runtime selection needs recovery.";
  else summary.textContent = "No runtime package installed yet.";
  const progressWrap = $("runtime-progress-wrap");
  progressWrap.hidden = !inst.busy;
  if (inst.busy) {
    const total = Math.max(1, inst.total || 1);
    $("runtime-progress").max = total;
    $("runtime-progress").value = inst.received ?? 0;
    const miB = value => Math.floor((value ?? 0) / 1024 / 1024);
    $("runtime-progress-text").textContent = `${miB(inst.received)} / ${miB(inst.total)} MiB${inst.file ? " · " + inst.file : ""}`;
  }
  const install = $("runtime-install");
  install.hidden = inst.active && inst.ready;
  install.disabled = blocked;
  const rollback = $("runtime-rollback");
  rollback.hidden = !inst.previous;
  rollback.disabled = blocked;
  const restore = $("runtime-restore");
  restore.hidden = !(inst.fault && inst.recoverable);
  restore.disabled = blocked;
  const cancel = $("runtime-cancel");
  cancel.hidden = !inst.busy;
  cancel.disabled = state.quitting;
}
$("runtime-install").addEventListener("click", () => act(() => window.isolated.installRuntime()));
$("runtime-rollback").addEventListener("click", () => act(() => window.isolated.rollbackRuntime()));
$("runtime-restore").addEventListener("click", () => act(() => window.isolated.restoreRuntime()));
$("runtime-cancel").addEventListener("click", () => act(() => window.isolated.cancelRuntimeInstall()));
$("diagnostics-export").addEventListener("click", () => act(() => window.isolated.exportDiagnostics()));

let networkKey, ruleEnvironmentKey, ruleSelectedEnvironment;
const statuses = {
  pending: "Pending", "allowed-once": "Allowed once", "allowed-rule": "Allowed by rule", "denied-rule": "Denied by rule", denied: "Denied",
  expired: "Expired — repeat from the agent if needed", cancelled: "Cancelled by client",
  interrupted: "Interrupted — not retried",
};
function element(tag, text, className) {
  const node = document.createElement(tag); if (text !== undefined) node.textContent = text;
  if (className) node.className = className; return node;
}
const ICON_PATHS = {
  x: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>',
  check: '<path d="M3.5 8.2l3 3 6-6.4"/>',
  clock: '<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.6 1.6"/>',
  bookmark: '<path d="M5.2 2.8h5.6v10.4L8 11.2l-2.8 2z"/>',
  trash: '<path d="M3 4.5h10M6.2 4.5l.6-1h2.4l.6 1M5.4 4.5V12.5h5.2V4.5"/><path d="M7 6.8v3.8M9 6.8v3.8"/>',
};
function actionButton(label, run, className, icon = "check") {
  const button = element("button", undefined, className); button.type = "button";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "ic"); svg.setAttribute("viewBox", "0 0 16 16"); svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = ICON_PATHS[icon] ?? ICON_PATHS.check;
  button.append(svg, element("span", label));
  button.addEventListener("click", () => act(run)); return button;
}
function networkRow(item, environments) {
  const row = element("div", undefined, "network-item"), identity = element("div", undefined, "identity");
  const name = environments.find(env => env.id === item.environmentId)?.name ?? item.environmentId;
  identity.append(element("code", `${item.scheme === "connect" ? "tcp" : item.scheme}://${item.host}:${item.port}`),
    element("small", `${name} · ${item.method || "any method"}${item.pathname ? ` · ${item.pathname}` : ""}`));
  row.append(identity); return { row, identity };
}
function renderNetwork(state) {
  $("network-panel").hidden = state.panel !== "network";
  const policy = state.networkPolicy, environments = state.environments ?? [];
  const groups = state.networkPresentation?.groups ?? [];
  const pendingCount = groups.reduce((count, group) => count + group.count, 0);
  $("pending-count").textContent = pendingCount > 99 ? "99+" : String(pendingCount);
  $("pending-count").hidden = pendingCount === 0;
  $("network").setAttribute("aria-label", `Network${pendingCount ? `, ${pendingCount} pending requests` : ""}`);
  const fault = !policy || policy.fault || policy.closed;
  $("network-fault").hidden = !fault;
  const selected = environments.find(item => item.id === state.selectedId);
  $("network-environment").textContent = selected?.name ?? "No environment selected";
  const blocked = Boolean(state.busy || state.filesBusy || state.modelBusy || state.quitting || fault);
  const mode = policy?.modes?.[state.selectedId] ?? "ask";
  $("network-mode").value = mode;
  $("network-mode").disabled = blocked || !selected || networkModePending.has(state.selectedId);
  const modeHelp = {
    ask: "All traffic stays through Iron. New destinations wait for approval; saved allow and deny rules are active.",
    "allow-all": "All destinations are allowed through Iron. Saved rules are retained and will apply again in Ask for approval.",
    "block-all": "All traffic is blocked through Iron. Saved rules are retained and will apply again in Ask for approval.",
  };
  $("network-mode-help").textContent = modeHelp[mode] ?? modeHelp.ask;
  const envKey = JSON.stringify(environments.map(item => [item.id, item.name]));
  if (envKey !== ruleEnvironmentKey) {
    const previous = $("rule-environment").value;
    $("rule-environment").replaceChildren(...environments.map(item => { const option = element("option", item.name); option.value = item.id; return option; }));
    ruleEnvironmentKey = envKey;
    if (environments.some(item => item.id === previous)) $("rule-environment").value = previous;
  }
  if (ruleSelectedEnvironment !== state.selectedId) {
    $("rule-environment").value = state.selectedId;
    ruleSelectedEnvironment = state.selectedId;
  }
  for (const control of $("network-rule-form").elements) control.disabled = blocked || !environments.length;
  $("network-clear").disabled = blocked;
  const key = JSON.stringify([policy, groups, state.selectedId, blocked, Boolean(state.quitting), [...networkDecisions]]);
  if (key === networkKey) return;
  networkKey = key;
  const focused = document.activeElement;
  const focusedKey = focused?.dataset?.groupKey, focusedDecision = focused?.dataset?.decision;
  $("network-pending").replaceChildren(...groups.map(group => {
    const { row, identity } = networkRow(group, environments);
    identity.append(element("small", `${group.count} ${group.count === 1 ? "request" : "requests"} · First expiry ${new Date(group.expiresAt).toLocaleTimeString()}`));
    if (group.inference?.length) identity.append(element("p",
      `${group.inference.map(item => item.name).join(", ")} — imported model endpoint. The model is waiting for network approval; importing it does not authorize traffic.`, "inference-context"));
    const actions = element("div", undefined, "actions");
    for (const [decision, label, icon] of [["deny", "Deny once", "x"], ["deny-save", "Always deny", "x"], ["once", "Allow once", "check"], ["save", "Always allow", "bookmark"], ["temporary", "Allow 10 min", "clock"]]) {
      const button = actionButton(label, () => decideGroup(group.key, decision), decision === "once" ? "primary" : decision.startsWith("deny") ? "deny" : "", icon);
      // An ongoing connection, import or startup may itself be waiting on this approval.
      button.disabled = Boolean(state.quitting || fault || networkDecisions.has(group.key));
      button.dataset.groupKey = group.key; button.dataset.decision = decision;
      button.title = decision === "once" || decision === "deny" ? `${label} for this current group only; future arrivals need another decision` : label;
      actions.append(button);
    }
    row.append(actions); return row;
  }));
  if (!groups.length) $("network-pending").append(element("p", "No requests waiting for approval. New requests appear here when an environment needs a destination.", "empty"));
  const rules = (policy?.rules ?? []).filter(item => item.environmentId === state.selectedId);
  $("network-rules").replaceChildren(...rules.map(item => {
    const { row, identity } = networkRow(item, environments);
    const action = item.action === "deny" ? "deny" : "allow";
    identity.prepend(element("small", action === "deny" ? "Deny rule" : "Allow rule", `rule-decision ${action}`));
    identity.append(element("small", item.expiresAt ? `Temporary until ${new Date(item.expiresAt).toLocaleTimeString()}` : "Saved until revoked"));
    const revoke = actionButton("Revoke rule", () => window.isolated.revokeNetwork(item.id), "revoke", "x");
    revoke.disabled = blocked;
    revoke.title = "Remove this rule and apply updated network policy. Active requests may be interrupted; the VM stays running.";
    row.append(revoke); return row;
  }));
  if (!rules.length) $("network-rules").append(element("p", "No saved rules for this environment. Approve a destination above or add a precise allow or deny rule.", "empty"));
  const history = (policy?.events ?? []).filter(item => item.status !== "pending" && item.environmentId === state.selectedId).slice().reverse();
  $("network-history").replaceChildren(...history.map(item => {
    const { row, identity } = networkRow(item, environments);
    identity.append(element("small", `${new Date(item.createdAt).toLocaleString()} · ${statuses[item.status] ?? item.status}`)); return row;
  }));
  if (!history.length) $("network-history").append(element("p", "No recent activity for this environment.", "empty"));
  if (focusedKey && focusedDecision) {
    const replacement = [...$("network-pending").querySelectorAll("button")].find(button => button.dataset.groupKey === focusedKey && button.dataset.decision === focusedDecision);
    if (replacement && !replacement.disabled) replacement.focus({ preventScroll: true });
  }
}
const networkDecisions = new Set(), networkModePending = new Set();
async function decideGroup(key, decision) {
  if (networkDecisions.has(key)) return;
  networkDecisions.add(key); if (lastState) renderNetwork(lastState);
  try { return await window.isolated.decideNetworkGroup(key, decision); }
  finally { networkDecisions.delete(key); if (lastState) renderNetwork(lastState); }
}
$("network-mode").addEventListener("change", () => {
  const environmentId = lastState?.selectedId, mode = $("network-mode").value;
  if (!environmentId) return;
  networkModePending.add(environmentId); $("network-mode").disabled = true;
  void act(async () => {
    try { return await window.isolated.setNetworkMode(environmentId, mode); }
    finally { networkModePending.delete(environmentId); if (lastState) renderNetwork(lastState); }
  });
});
$("network").addEventListener("click", () => act(() => window.isolated.showPanel("network")));
$("back-harness").addEventListener("click", () => act(() => window.isolated.showPanel("harness")));
$("network-clear").addEventListener("click", () => act(() => window.isolated.clearNetworkHistory()));
$("network-rule-form").addEventListener("submit", event => {
  event.preventDefault();
  void act(() => window.isolated.addNetworkRule({
    environmentId: $("rule-environment").value, origin: $("rule-origin").value,
    method: $("rule-method").value, pathname: $("rule-path").value, action: $("rule-action").value,
  }));
});

const modelStatuses = {
  "not-checked": "Not checked yet", available: "Model available",
  "model-not-loaded": "Server reached; requested model not loaded", "missing-credential": "Credential missing",
  "vault-unavailable": "Keychain unavailable", unauthorized: "Credential rejected by server",
  "upstream-error": "Server error", unreachable: "Server not reachable",
};
let modelKey;
function renderModels(state) {
  $("models-panel").hidden = state.panel !== "models";
  $("models-import").disabled = state.busy || state.filesBusy || state.modelBusy || state.quitting;
  $("models-probe").disabled = state.busy || state.filesBusy || state.modelBusy || state.quitting || !state.models?.providers.length;
  const key = JSON.stringify(state.models); if (key === modelKey) return; modelKey = key;
  $("model-list").replaceChildren(...(state.models?.providers ?? []).map(provider => {
    const row = element("div", undefined, "network-item"), details = element("div", undefined, "identity");
    details.append(element("strong", provider.displayName), element("p", provider.models.map(model => model.name).join(", ")),
      element("code", provider.baseURL),
      element("small", `${provider.credentialAvailable ? "Credential saved on Mac" : "Credential missing"} · ${modelStatuses[provider.availability] ?? "Not checked yet"}`));
    row.append(details); return row;
  }));
  if (!state.models?.providers.length) $("model-list").append(element("p", "No models imported. Import from DSH on your Mac to add your local providers.", "empty"));
}
$("models").addEventListener("click", () => act(() => window.isolated.showPanel("models")));
$("models-back").addEventListener("click", () => act(() => window.isolated.showPanel("harness")));
$("models-import").addEventListener("click", () => act(() => window.isolated.importModels()));
$("models-probe").addEventListener("click", () => act(() => window.isolated.probeModels()));

let filePlanId, fileEnvironment, filePlanKey, transferScopeEnvironment;
const fileDrafts = new Map();
const fileFieldIds = ["import-destination", "import-name", "export-source", "export-name"];
function selectFilesSection(section, focus = false) {
  for (const name of ["import", "export", "shared"]) {
    const tab = $("files-tab-" + name), active = name === section;
    tab.setAttribute("aria-selected", String(active)); tab.tabIndex = active ? 0 : -1;
    $("files-" + name).hidden = !active;
    if (active && focus) tab.focus();
  }
  updateTransferReview();
}
function updateTransferReview() {
  const transfer = lastState?.transfers;
  const current = (transfer?.environmentId ?? transferScopeEnvironment) === lastState?.selectedId;
  const active = current && ["preparing", "preview", "running"].includes(transfer?.state);
  // Keep review and cancellation reachable even if the user opens Shared folders mid-transfer.
  $("transfer-review").hidden = $("files-tab-shared").getAttribute("aria-selected") === "true" && !active;
}
for (const [index, name] of ["import", "export", "shared"].entries()) {
  const tab = $("files-tab-" + name);
  tab.addEventListener("click", () => selectFilesSection(name));
  tab.addEventListener("keydown", event => {
    const names = ["import", "export", "shared"];
    const next = event.key === "ArrowRight" ? (index + 1) % 3 : event.key === "ArrowLeft" ? (index + 2) % 3 : event.key === "Home" ? 0 : event.key === "End" ? 2 : null;
    if (next !== null) { event.preventDefault(); selectFilesSection(names[next], true); }
  });
}
function renderFiles(state) {
  $("files-panel").hidden = state.panel !== "files";
  const environment = state.environments?.find(item => item.id === state.selectedId);
  const transfer = state.transfers ?? { state: "idle" };
  if (fileEnvironment !== state.selectedId) {
    if (fileEnvironment) fileDrafts.set(fileEnvironment, fileFieldIds.map(id => $(id).value));
    const draft = fileDrafts.get(state.selectedId) ?? ["/home/user/workspace", "import", "/home/user/workspace", "harness-export"];
    fileFieldIds.forEach((id, index) => { $(id).value = draft[index]; });
    fileEnvironment = state.selectedId;
  }
  // Bring a newly prepared preview into view without changing tabs on every status tick.
  if (transfer.id && transfer.id !== filePlanKey && transfer.environmentId === state.selectedId) {
    if (["import", "export"].includes(transfer.direction)) selectFilesSection(transfer.direction);
    filePlanKey = transfer.id;
  }
  $("files-environment").textContent = `${environment?.name ?? "Environment"} · ${environment?.phase === "running" ? "Ready for transfers" : "Start the environment to transfer files"}`;
  const blocked = state.busy || state.filesBusy || state.quitting || transfer.fault || environment?.phase !== "running";
  for (const id of ["import-file", "import-folder", "export-files", "import-destination", "import-name", "export-source", "export-name"])
    $(id).disabled = blocked;
  const preview = $("file-preview"); preview.replaceChildren();
  filePlanId = transfer.environmentId === state.selectedId ? transfer.id : undefined;
  if (transfer.environmentId) transferScopeEnvironment = transfer.environmentId;
  else if (transfer.state === "preparing" || transferScopeEnvironment === undefined) transferScopeEnvironment = state.selectedId;
  const currentTransfer = transferScopeEnvironment === state.selectedId;
  updateTransferReview();
  if (currentTransfer && transfer.source) {
    preview.append(element("h2", transfer.direction === "import" ? "Import into VM" : "Export to Mac"),
      element("p", `${transfer.environmentId} · ${transfer.entries} entries · ${(transfer.bytes ?? 0).toLocaleString()} bytes`),
      element("p", `From: ${transfer.source}`), element("p", `To: ${transfer.destination}`));
    if (transfer.collision) preview.append(element("p", "The destination already exists. Choose another name and repeat the preview.", "warn-note"));
  }
  $("file-confirm").hidden = !currentTransfer || transfer.state !== "preview";
  $("file-cancel").hidden = !currentTransfer || !["preparing", "preview", "running"].includes(transfer.state);
  $("file-confirm").disabled = blocked || transfer.state !== "preview" || transfer.collision || transfer.environmentId !== state.selectedId;
  $("file-cancel").disabled = state.quitting || !currentTransfer || !["preparing", "preview", "running"].includes(transfer.state);
  $("file-progress").hidden = !currentTransfer || !["running", "complete"].includes(transfer.state);
  $("file-progress").max = Math.max(1, transfer.bytes ?? 0);
  $("file-progress").value = transfer.state === "complete" ? Math.max(1, transfer.bytes ?? 0) : (transfer.transferredBytes ?? 0);
  const messages = {
    idle: "", preparing: "Checking files and collisions…", preview: "Review the source and destination, then confirm.",
    running: `Transferring · ${(transfer.transferredBytes ?? 0).toLocaleString()} bytes verified`,
    complete: "Transfer complete and verified.",
    cancelled: "Transfer cancelled. It will not resume automatically.",
    error: "Transfer rejected or interrupted. Check files, links, sizes and destinations before retrying.",
  };
  $("file-result").textContent = (currentTransfer ? messages[transfer.state] ?? "" : "") +
    (currentTransfer && transfer.cleanupPending ? " Cleanup not confirmed: the destination may contain partial files. Check it before retrying." : "");
  const recovery = $("file-recovery"); recovery.replaceChildren();
  if (transfer.fault) recovery.append(element("p", "The transfer journal is invalid. Transfers are disabled; the journal and existing files were preserved. VM stop and recovery remain available.", "alert"));
  const interrupted = (transfer.interrupted ?? []).filter(item => item.environmentId === state.selectedId);
  if (interrupted.length) recovery.append(element("h2", "Interrupted transfers"), element("p", "Transfers never resume automatically. Review the destination before deleting partial output. Completed or replaced output is preserved."));
  for (const item of interrupted) {
    const row = element("div", undefined, "network-item");
    const identity = element("div", undefined, "identity");
    identity.append(element("p", `${item.direction === "import" ? "Import" : "Export"} · ${item.destination} · ${item.phase === "committing" ? "Completion uncertain" : "Interrupted"}`));
    const actions = element("div", undefined, "actions");
    const discard = actionButton("Delete partial output…", () => window.isolated.recoverTransfer(item.id, "discard"), "danger", "trash");
    const keep = actionButton("Keep files and dismiss", () => window.isolated.recoverTransfer(item.id, "forget"), "", "check");
    discard.disabled = state.busy || state.filesBusy || state.quitting || (item.direction === "import" && environment?.phase !== "running");
    keep.disabled = state.busy || state.filesBusy || state.quitting;
    actions.append(discard, keep);
    row.append(identity, actions); recovery.append(row);
  }
}
$("files").addEventListener("click", () => act(() => window.isolated.showPanel("files")));
$("files-back").addEventListener("click", () => act(() => window.isolated.showPanel("harness")));
for (const kind of ["file", "folder"]) $("import-" + kind).addEventListener("click", () => act(() => window.isolated.importFiles({
  kind, destination: $("import-destination").value, name: $("import-name").value,
})));
$("export-files").addEventListener("click", () => act(() => window.isolated.exportFiles({
  source: $("export-source").value, name: $("export-name").value,
})));
$("file-confirm").addEventListener("click", () => act(() => window.isolated.executeTransfer(filePlanId)));
$("file-cancel").addEventListener("click", () => act(() => window.isolated.cancelTransfer()));
for (const id of ["import-destination", "import-name", "export-source", "export-name"])
  $(id).addEventListener("input", () => act(() => window.isolated.cancelTransfer()));

let sharePreviewId;
function renderShares(state) {
  const fault = Boolean(state.shares?.fault);
  $("share-fault").hidden = !fault;
  const blocked = state.busy || state.filesBusy || state.quitting || !state.shares || fault;
  $("share-mode").disabled = blocked; $("share-choose").disabled = blocked;
  const preview = state.shares?.preview?.environmentId === state.selectedId ? state.shares.preview : null;
  sharePreviewId = preview?.id;
  $("share-preview").replaceChildren();
  if (preview) {
    $("share-preview").append(element("p", `${preview.environmentId} · ${preview.mode === "ro" ? "Read only" : "Read and write"}`),
      element("p", `Mac folder: ${preview.source}`), element("p", `Guest path: ${preview.target}`));
  }
  $("share-confirm").hidden = !preview; $("share-cancel").hidden = !preview;
  $("share-confirm").disabled = blocked || !preview || preview.environmentId !== state.selectedId;
  $("share-cancel").disabled = blocked || !preview;
  const selected = state.environments?.find(item => item.id === state.selectedId);
  const shares = state.shares?.shares.filter(item => item.environmentId === state.selectedId) ?? [];
  $("share-list").replaceChildren(...shares.map(item => {
    const row = element("div", undefined, "network-item"), details = element("div", undefined, "identity");
    details.append(element("strong", item.source), element("code", item.target),
      element("small", `${item.mode === "ro" ? "Read only" : "Read and write"} · ${selected?.phase === "running" ? "Shared with the VM" : "Saved for the next start"}`));
    const remove = actionButton("Remove and stop the VM", () => window.isolated.removeShare(item.id), "revoke", "x");
    remove.disabled = blocked;
    row.append(details, remove); return row;
  }));
  if (!shares.length) $("share-list").append(element("p", "No folders shared. Choose a Mac folder above, review its access level, then confirm.", "empty"));
}
$("share-choose").addEventListener("click", () => act(() => window.isolated.prepareShare($("share-mode").value)));
$("share-confirm").addEventListener("click", () => act(() => window.isolated.confirmShare(sharePreviewId)));
$("share-cancel").addEventListener("click", () => act(() => window.isolated.cancelShare()));
$("share-mode").addEventListener("change", () => act(() => window.isolated.cancelShare()));

function renderGit(state) {
  const blocked = state.busy || state.filesBusy || state.modelBusy || state.quitting || !state.git;
  $("git-repository").disabled = blocked; $("git-import").disabled = blocked;
  $("git-list").replaceChildren(...(state.git?.repositories ?? []).map(item => {
    const row = element("div", undefined, "network-item"), details = element("div", undefined, "identity");
    details.append(element("strong", item.repository), element("code", item.baseURL),
      element("small", item.credentialAvailable ? "Credential kept on Mac" : "Credential missing: repeat the import"));
    const remove = actionButton("Remove access and stop environments", () => window.isolated.removeGit(item.id), "revoke", "x");
    remove.disabled = blocked;
    row.append(details, remove); return row;
  }));
  if (!state.git?.repositories.length) $("git-list").append(element("p", "No private repository authorized. Enter owner/repository above to import access from your Mac.", "empty"));
}
$("git-form").addEventListener("submit", event => {
  event.preventDefault();
  void act(() => window.isolated.importGit($("git-repository").value));
});

const secretMethods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];
const secretAuthLabels = { bearer: "Bearer token", "api-key": "API key", basic: "Basic auth" };
ICON_PATHS.key = '<circle cx="5.4" cy="8" r="3.2"/><path d="M8.6 8H14M11.4 8v2.4M13.6 8v1.8"/>';
const secretMetadataInputs = ["secret-name", "secret-header", "secret-username", "secret-origin", "secret-path"];
const secretDrafts = new Map();
let secretsSelection, secretsEditorSelection, secretsEnvironmentKey, secretsListKey;
let secretsSearch = "", secretsPending = null, secretsReplace = false;
function secretsUnavailable(state) { return !state?.secrets || Boolean(state.secrets.fault); }
function secretsBlocked(state) {
  return Boolean(!state || secretsUnavailable(state) || state.busy || state.filesBusy || state.modelBusy ||
    state.quitting || state.installation?.busy || state.images?.busy || secretsPending ||
    typeof window.isolated.saveSecret !== "function");
}
function selectedSecretEntry(state) {
  return (state?.secrets?.entries ?? []).find(item => item.id === secretsSelection);
}
// Only metadata is drafted. Secret values are sent only in the save payload.
function captureSecretDraft() {
  if (!secretsSelection) return;
  secretDrafts.set(secretsSelection, {
    name: $("secret-name").value, authType: $("secret-auth").value,
    headerName: $("secret-header").value, username: $("secret-username").value,
    origin: $("secret-origin").value, pathPrefix: $("secret-path").value,
    environmentId: $("secret-environment").value,
    methods: secretMethods.filter(method => $("secret-method-" + method).checked),
  });
}
function clearSecretValue() {
  $("secret-value").value = "";
  secretsReplace = false;
}
function applySecretEditor(state) {
  const entry = selectedSecretEntry(state);
  const draft = secretDrafts.get(secretsSelection);
  const value = draft ?? (entry ? {
    name: entry.name, authType: entry.authType, headerName: entry.headerName ?? "",
    username: entry.username ?? "", origin: entry.origin ?? "", pathPrefix: entry.pathPrefix ?? "",
    environmentId: entry.environmentId, methods: entry.methods ?? [],
  } : { name: "", authType: "bearer", headerName: "", username: "", origin: "", pathPrefix: "",
    environmentId: state.selectedId ?? "", methods: ["GET"] });
  $("secret-name").value = value.name;
  $("secret-auth").value = value.authType;
  $("secret-header").value = value.headerName;
  $("secret-username").value = value.username;
  $("secret-origin").value = value.origin;
  $("secret-path").value = value.pathPrefix;
  $("secret-environment").value = value.environmentId;
  for (const method of secretMethods) $("secret-method-" + method).checked = value.methods.includes(method);
  clearSecretValue();
}
function syncSecretEditor(state) {
  const entry = selectedSecretEntry(state);
  const authType = $("secret-auth").value;
  $("secret-header-row").hidden = authType !== "api-key";
  $("secret-username-row").hidden = authType !== "basic";
  $("secret-value-label").textContent = authType === "basic" ? "Password" : "Secret value";
  const blocked = secretsBlocked(state);
  const hasSaved = Boolean(entry?.credentialAvailable);
  const value = $("secret-value");
  value.disabled = blocked;
  // A saved secret is never revealed: the field stays empty and locked until Replace.
  value.readOnly = blocked || (hasSaved && !secretsReplace);
  value.placeholder = hasSaved ? secretsReplace ? "Enter the replacement secret" : "Saved value is kept" : "Enter the secret value";
  $("secret-replace").hidden = !hasSaved || secretsReplace;
  $("secret-replace").disabled = blocked;
  const preview = $("secret-preview");
  preview.replaceChildren();
  const header = authType === "api-key" ? $("secret-header").value.trim() || "API key header" : "Authorization";
  const scheme = authType === "bearer" ? "Bearer ••••••••" : authType === "basic" ? "Basic ••••••••" : "••••••••";
  preview.append(element("p", `${header}: ${scheme}`), element("p", "Injected by Iron after network approval"));
}
function renderSecretList(state, entries) {
  const environments = state.environments ?? [];
  const query = secretsSearch.trim().toLowerCase();
  const visible = query ? entries.filter(item => [item.name, secretAuthLabels[item.authType] ?? item.authType,
    environments.find(env => env.id === item.environmentId)?.name ?? item.environmentId]
    .join(" ").toLowerCase().includes(query)) : entries;
  const key = JSON.stringify([visible.map(item => [item.id, item.name, item.environmentId, item.authType,
    item.credentialAvailable]), secretsSelection, secretsBlocked(state), Boolean(secretsPending)]);
  if (key === secretsListKey) return;
  secretsListKey = key;
  const list = $("secret-list");
  list.replaceChildren(...visible.map(item => {
    const row = element("button", undefined, "secret-row");
    row.type = "button";
    row.setAttribute("aria-pressed", String(item.id === secretsSelection));
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "ic"); svg.setAttribute("viewBox", "0 0 16 16"); svg.setAttribute("aria-hidden", "true");
    svg.innerHTML = ICON_PATHS.key;
    const identity = element("span", undefined, "identity");
    identity.append(element("strong", item.name),
      element("small", `${secretAuthLabels[item.authType] ?? item.authType} · ${environments.find(env => env.id === item.environmentId)?.name ?? item.environmentId}`));
    const status = element("span", item.credentialAvailable ? "Configured" : "Needs setup", "secret-status");
    status.dataset.state = item.credentialAvailable ? "ready" : "missing";
    row.append(svg, identity, status);
    row.addEventListener("click", () => selectSecret(item.id));
    return row;
  }));
  if (!visible.length) list.append(element("p", query
    ? "No credentials match this search."
    : "No credentials saved yet. Add a secret to keep a credential encrypted on your Mac and grant it scoped access.", "empty"));
}
function renderSecrets(state) {
  const open = state.panel === "secrets";
  $("secrets-panel").hidden = !open;
  if (!open) { clearSecretValue(); secretsEditorSelection = undefined; return; }
  const unavailable = secretsUnavailable(state);
  $("secrets-fault").hidden = !unavailable;
  const entries = state.secrets?.entries ?? [];
  if (secretsSelection !== "new" && !entries.some(item => item.id === secretsSelection)) {
    secretsSelection = entries.length ? entries[0].id : "new";
  }
  const blocked = secretsBlocked(state);
  const environments = state.environments ?? [];
  const envKey = JSON.stringify(environments.map(item => [item.id, item.name]));
  if (envKey !== secretsEnvironmentKey) {
    const previous = $("secret-environment").value;
    $("secret-environment").replaceChildren(...environments.map(item => {
      const option = element("option", item.name); option.value = item.id; return option;
    }));
    secretsEnvironmentKey = envKey;
    if (environments.some(item => item.id === previous)) $("secret-environment").value = previous;
  }
  if (secretsEditorSelection !== secretsSelection) {
    applySecretEditor(state);
    secretsEditorSelection = secretsSelection;
  }
  const entry = selectedSecretEntry(state);
  const isNew = !entry;
  $("secret-editor-title").textContent = entry?.name ?? "New credential";
  $("secret-environment").disabled = blocked || !isNew || !environments.length;
  $("secret-environment").title = isNew ? "" : "The environment of a saved credential cannot change.";
  $("secret-environment-help").textContent = isNew
    ? "New credentials default to the selected environment. Choose another before saving if needed."
    : "The environment of a saved credential cannot change. Add another secret for a different environment.";
  for (const id of secretMetadataInputs) $(id).disabled = blocked;
  $("secret-auth").disabled = blocked;
  for (const method of secretMethods) $("secret-method-" + method).disabled = blocked;
  $("secret-add").disabled = blocked || secretsSelection === "new";
  $("secret-cancel").disabled = Boolean(state.quitting || secretsPending);
  $("secret-save").disabled = blocked;
  $("secret-remove").hidden = isNew;
  $("secret-remove").disabled = blocked || typeof window.isolated.removeSecret !== "function";
  syncSecretEditor(state);
  renderSecretList(state, entries);
}
function selectSecret(id) {
  if (!lastState || secretsSelection === id) return;
  captureSecretDraft();
  secretsSelection = id;
  clearSecretValue();
  renderSecrets(lastState);
}
$("secrets").addEventListener("click", () => act(() => window.isolated.showPanel("secrets")));
$("secrets-back").addEventListener("click", () => act(() => window.isolated.showPanel("harness")));
$("secret-add").addEventListener("click", () => {
  if (!lastState || $("secret-add").disabled) return;
  captureSecretDraft();
  secretsSelection = "new";
  clearSecretValue();
  renderSecrets(lastState);
});
$("secret-cancel").addEventListener("click", () => {
  if (!lastState || secretsPending) return;
  secretDrafts.delete(secretsSelection);
  secretsEditorSelection = undefined;
  clearSecretValue();
  renderSecrets(lastState);
});
$("secret-search").addEventListener("input", () => {
  secretsSearch = $("secret-search").value;
  if (lastState) renderSecrets(lastState);
});
for (const id of secretMetadataInputs)
  $(id).addEventListener("input", () => {
    captureSecretDraft();
    if (lastState) syncSecretEditor(lastState);
  });
$("secret-auth").addEventListener("change", () => {
  if (!lastState) return;
  captureSecretDraft();
  clearSecretValue();
  syncSecretEditor(lastState);
});
$("secret-environment").addEventListener("change", () => {
  if (!lastState) return;
  captureSecretDraft();
  clearSecretValue();
});
for (const method of secretMethods)
  $("secret-method-" + method).addEventListener("change", () => { if (lastState) captureSecretDraft(); });
$("secret-replace").addEventListener("click", () => {
  if (!lastState || $("secret-replace").disabled) return;
  secretsReplace = true;
  syncSecretEditor(lastState);
  $("secret-value").focus();
});
$("secret-form").addEventListener("submit", event => {
  event.preventDefault();
  void saveSecretEntry();
});
async function saveSecretEntry() {
  const state = lastState;
  if (!state || secretsPending || secretsBlocked(state)) return;
  const entry = selectedSecretEntry(state);
  const authType = $("secret-auth").value;
  const payload = {
    name: $("secret-name").value, environmentId: $("secret-environment").value, authType,
    origin: $("secret-origin").value, pathPrefix: $("secret-path").value,
    methods: secretMethods.filter(method => $("secret-method-" + method).checked),
    headerName: authType === "api-key" ? $("secret-header").value : "",
    username: authType === "basic" ? $("secret-username").value : "",
  };
  if (entry) payload.id = entry.id;
  const value = $("secret-value").value;
  if (value) payload.value = value;
  else if (!entry) {
    await act(async () => { throw Error("Enter a secret value before saving."); });
    return;
  } else if (entry.authType !== authType || (entry.username ?? "") !== payload.username) {
    await act(async () => { throw Error("Changing the authentication type or username requires a new secret value."); });
    return;
  }
  const selectionAtSubmit = secretsSelection;
  // Copy the payload, then clear the password before awaiting IPC, including failures.
  clearSecretValue();
  secretsPending = "save";
  renderSecrets(state);
  try {
    await act(async () => {
      const result = await window.isolated.saveSecret(payload);
      // A stale completion must not wipe a draft the user started on another entry.
      if (secretsSelection === selectionAtSubmit) {
        secretDrafts.delete(selectionAtSubmit);
        secretsEditorSelection = undefined;
      }
      return result;
    });
  } finally {
    secretsPending = null;
    if (lastState) renderSecrets(lastState);
  }
}
$("secret-remove").addEventListener("click", () => {
  void removeSecretEntry();
});
async function removeSecretEntry() {
  const state = lastState;
  if (!state || secretsPending || secretsBlocked(state) || typeof window.isolated.removeSecret !== "function") return;
  const entry = selectedSecretEntry(state);
  if (!entry) return;
  const selectionAtSubmit = secretsSelection;
  clearSecretValue();
  secretsPending = "remove";
  renderSecrets(state);
  try {
    await act(async () => {
      const result = await window.isolated.removeSecret(entry.id);
      secretDrafts.delete(entry.id);
      if (secretsSelection === selectionAtSubmit) secretsEditorSelection = undefined;
      return result;
    });
  } finally {
    secretsPending = null;
    if (lastState) renderSecrets(lastState);
  }
}

window.isolated.onStatus(render);
act(() => window.isolated.status());
setInterval(renderProgress, 1000);
