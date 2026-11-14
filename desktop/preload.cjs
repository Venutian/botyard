const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('studio', {
  select: (name) => ipcRenderer.send('select', name),
  reload: () => ipcRenderer.send('reload'),
  start: () => ipcRenderer.send('start'),
  logs: () => ipcRenderer.send('logs'),
  onState: (handler) => ipcRenderer.on('state', (_event, state) => handler(state)),
})
