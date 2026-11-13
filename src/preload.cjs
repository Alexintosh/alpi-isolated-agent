const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld(
  "poc",
  Object.freeze({
    connect: () => ipcRenderer.invoke("poc:connect"),
    disconnect: () => ipcRenderer.invoke("poc:disconnect"),
    status: () => ipcRenderer.invoke("poc:status"),
    selectEnvironment: (id) => ipcRenderer.invoke("poc:select", id),
    stopEnvironment: () => ipcRenderer.invoke("poc:stop"),
    onStatus: (callback) => {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on("poc:status", listener);
      return () => ipcRenderer.removeListener("poc:status", listener);
    },
  }),
);
