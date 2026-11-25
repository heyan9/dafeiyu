const { contextBridge, ipcRenderer } = require('electron');

// 聊天窗口里的网页只能通过这些受限接口使用电脑功能，每一项都会在电脑上弹窗让你确认
contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  folders: () => ipcRenderer.invoke('folders'),
  pickFolder: () => ipcRenderer.invoke('pick'),
  readRecent: (folder, hours) => ipcRenderer.invoke('read', folder, hours || 24),
  screenshot: () => ipcRenderer.invoke('shot'),
  act: (a) => ipcRenderer.invoke('act', a),
  ping: () => ipcRenderer.send('ping'),
});
