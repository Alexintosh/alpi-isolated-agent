const connect = document.querySelector("#connect");
const disconnect = document.querySelector("#disconnect");
const stop = document.querySelector("#stop");
const environment = document.querySelector("#environment");
let catalogKey = "";
function render(state) {
  document.querySelector("#status").textContent = state.label;
  document.querySelector("#detail").textContent = state.detail ?? "";
  const options = state.environments ?? [];
  const nextCatalogKey = JSON.stringify(
    options.map((item) => [item.id, item.name, item.available]),
  );
  if (catalogKey !== nextCatalogKey)
    environment.replaceChildren(
      ...options.map((item) => {
        const option = document.createElement("option");
        option.value = item.id;
        option.textContent =
          item.name + (item.available ? "" : " · da preparare");
        return option;
      }),
    );
  catalogKey = nextCatalogKey;
  environment.value = state.selectedId;
  environment.disabled = state.busy || options.length === 0;
  const selected = options.find((item) => item.id === state.selectedId);
  document.querySelector("#capabilities").textContent =
    selected?.detail ?? "Verifica ambienti…";
  connect.disabled = state.busy || !selected?.available;
  disconnect.disabled = !state.activeId && !state.busy;
  stop.disabled =
    state.busy ||
    !selected?.available ||
    ["stopped", "missing"].includes(selected?.state);
}
async function act(action) {
  try {
    render(await action());
  } catch (error) {
    document.querySelector("#detail").textContent = error.message;
  }
}
window.poc.onStatus(render);
act(() => window.poc.status());
connect.addEventListener("click", () => act(() => window.poc.connect()));
disconnect.addEventListener("click", () => act(() => window.poc.disconnect()));
stop.addEventListener("click", () => act(() => window.poc.stopEnvironment()));
environment.addEventListener("change", () =>
  act(() => window.poc.selectEnvironment(environment.value)),
);
