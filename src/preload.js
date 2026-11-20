const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state:get'),
  setConfig: patch => ipcRenderer.invoke('config:set', patch),
  resetConfig: () => ipcRenderer.invoke('config:reset'),
  resetStats: () => ipcRenderer.invoke('stats:reset'),
  clearLog: () => ipcRenderer.invoke('log:clear'),
  listApps: () => ipcRenderer.invoke('apps:list'),
  analyze: text => ipcRenderer.invoke('analyze', text),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  applyUpdate: () => ipcRenderer.invoke('update:apply'),
  openRelease: () => ipcRenderer.invoke('update:page'),
  openSupport: () => ipcRenderer.invoke('support:open'),
  onEvent: cb => ipcRenderer.on('event', (_e, msg) => cb(msg)),
});
