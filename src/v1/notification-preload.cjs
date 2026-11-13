const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('networkNotice', Object.freeze({
  status:()=>ipcRenderer.invoke('isolated:network-notice-state'),
  decide:async(key,decision)=>{await ipcRenderer.invoke('isolated:network-group-decision',key,decision)},
  dismiss:async key=>{await ipcRenderer.invoke('isolated:network-notice-dismiss',key)},
  review:async()=>{await ipcRenderer.invoke('isolated:network-notice-review')},
  onChange:callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on('isolated:notice',listener);return()=>ipcRenderer.removeListener('isolated:notice',listener)},
}));
