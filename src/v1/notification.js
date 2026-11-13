const $ = id => document.getElementById(id);
let group = null, deciding = false, revision = 0, groupVersion = 0, openMenu = null;
// Keys identify destinations; request IDs distinguish replacement batches at that destination.
function identity(value) {
  return value ? JSON.stringify([value.key, [...value.ids].sort(), value.expiresAt]) : null;
}
function closeMenu(restoreFocus = false) {
  if (!openMenu) return;
  const { kind } = openMenu;
  openMenu = null;
  $(`${kind}-menu`).hidden = true;
  $(`${kind}-options`).setAttribute("aria-expanded", "false");
  if (restoreFocus) $(`${kind}-options`).focus();
}
function render(next) {
  revision += 1;
  const changed = identity(next) !== identity(group);
  if (changed) { groupVersion += 1; closeMenu(Boolean(next)); }
  group = next;
  $("notice").hidden = !group;
  if (!group) return;
  const destination = `${group.scheme === "connect" ? "tcp" : group.scheme}://${group.host}:${group.port}`;
  $("notice-destination").textContent = destination;
  $("notice-destination").title = destination;
  $("notice-count").textContent = `${group.method || "Any method"} · ${group.count} pending ${group.count === 1 ? "request" : "requests"} · ${group.environmentId}`;
  $("notice-count").title = $("notice-count").textContent;
  const inference = group.inference ?? [];
  $("notice-context").textContent = inference.length
    ? `${inference.map(item => item.name).join(", ")} is waiting for network approval. Importing a model does not authorize traffic.`
    : "This destination is waiting for approval through Iron. Once decisions cover this current group only.";
  $("notice-context").title = $("notice-context").textContent;
  $("notice-context").classList.toggle("inference", Boolean(inference.length));
  if (changed) $("notice-result").hidden = true;
  updateActions();
}
function updateActions() {
  const expired = group && Date.now() >= group.expiresAt;
  if (!group || expired || deciding) {
    const expiredMenu = expired && openMenu;
    closeMenu();
    if (expiredMenu && !deciding) $("notice-review").focus();
  }
  for (const id of ["notice-allow", "notice-deny", "allow-options", "deny-options", "allow-once", "allow-always", "deny-once", "deny-always"])
    $(id).disabled = Boolean(!group || deciding || expired);
  $("notice-review").disabled = deciding;
  $("notice-close").disabled = deciding;
  $("notice-allow").textContent = deciding ? "Deciding…" : "Allow";
  $("notice").setAttribute("aria-busy", String(deciding));
  if (expired && !deciding) {
    $("notice-result").hidden = false;
    $("notice-result").textContent = "Request expired. Review recent activity for details.";
  }
}
async function perform(action) {
  if (deciding || !group) return;
  const version = groupVersion;
  deciding = true; updateActions();
  try { await action(); }
  catch (error) {
    if (version !== groupVersion) return;
    $("notice-result").textContent = typeof error?.message === "string" ? error.message : "Decision not completed. Open Review to retry.";
    $("notice-result").title = $("notice-result").textContent;
    $("notice-result").hidden = false;
  } finally { deciding = false; updateActions(); }
}
async function decide(decision, version = groupVersion) {
  if (!group || version !== groupVersion || Date.now() >= group.expiresAt) return;
  const key = group.key;
  await window.networkNotice.decide(key, decision);
  // A new arrival may reuse this destination key. Ask the trusted parent for the remaining group.
  const publishedRevision = revision;
  const current = await window.networkNotice.status();
  if (publishedRevision === revision) render(current);
}
function showMenu(kind, last = false) {
  if (deciding || !group || Date.now() >= group.expiresAt) { updateActions(); return; }
  closeMenu();
  const menu = { kind, version: groupVersion };
  openMenu = menu;
  $(`${kind}-menu`).hidden = false;
  $(`${kind}-options`).setAttribute("aria-expanded", "true");
  for (const [suffix, decision] of [["once", kind === "allow" ? "once" : "deny"], ["always", kind === "allow" ? "save" : "deny-save"]]) {
    // Each opening captures its batch and token. Even a retained click closure is inert after invalidation.
    $(`${kind}-${suffix}`).onclick = () => {
      if (openMenu !== menu || menu.version !== groupVersion) return;
      closeMenu(true);
      void perform(() => decide(decision, menu.version));
    };
  }
  $(`${kind}-${last ? "always" : "once"}`).focus();
}
for (const kind of ["allow", "deny"]) {
  $(`${kind}-options`).addEventListener("click", () => {
    if (openMenu?.kind === kind) closeMenu(true); else showMenu(kind);
  });
  $(`${kind}-options`).addEventListener("keydown", event => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); event.stopPropagation(); showMenu(kind, event.key === "ArrowUp");
    }
  });
}
$("notice-allow").addEventListener("click", () => perform(() => decide("once")));
$("notice-deny").addEventListener("click", () => perform(() => decide("deny")));
$("notice-review").addEventListener("click", () => perform(() => window.networkNotice.review()));
$("notice-close").addEventListener("click", () => {
  if (!group || deciding) return;
  closeMenu();
  const key = group.key, version = groupVersion;
  // Dismissal never authorizes or denies a request.
  void window.networkNotice.dismiss(key).catch(() => {
    if (version !== groupVersion) return;
    $("notice-result").textContent = "Could not dismiss notification. Review the pending request.";
    $("notice-result").hidden = false;
  });
});
document.addEventListener("pointerdown", event => {
  if (openMenu && !$(`${openMenu.kind}-split`).contains(event.target)) closeMenu();
});
document.addEventListener("focusin", event => {
  if (openMenu && !$(`${openMenu.kind}-split`).contains(event.target)) closeMenu();
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    event.preventDefault();
    if (openMenu) closeMenu(true); else $("notice-close").click();
  } else if (openMenu && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    const kind = openMenu.kind, atFirst = document.activeElement === $(`${kind}-once`);
    const last = event.key === "End" || (event.key !== "Home" && atFirst);
    $(`${kind}-${last ? "always" : "once"}`).focus();
  }
});
window.networkNotice.onChange(render);
const initialRevision = revision;
window.networkNotice.status().then(current => {
  if (revision === initialRevision) render(current);
}).catch(() => { $("notice").hidden = true; });
setInterval(updateActions, 1000);
