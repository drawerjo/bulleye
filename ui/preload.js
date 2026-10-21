const { ipcRenderer, webUtils } = require('electron')
window.bulleye = {
  pathOf: f => { try { return webUtils.getPathForFile(f) } catch { return '' } },
  read: p => ipcRenderer.invoke('read-file', p),
  takePending: () => ipcRenderer.invoke('take-pending'),
  onOpen: cb => ipcRenderer.on('open-path', (_e, p) => cb(p)),
  getInfo: () => ipcRenderer.invoke('app-info'),
  onUpdateReady: cb => ipcRenderer.on('update-ready', (_e, v) => cb(v)),
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  registerTypes: () => ipcRenderer.invoke('register-types'),
  openExternal: u => ipcRenderer.invoke('open-external', u),
  fetchJson: u => ipcRenderer.invoke('fetch-json', u),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
}
