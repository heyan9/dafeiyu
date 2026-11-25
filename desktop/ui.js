const { contextBridge, ipcRenderer } = require('electron');

// 登录窗口和悬浮球（本地页面）用的接口
contextBridge.exposeInMainWorld('ui', {
  cfg: () => ipcRenderer.invoke('cfg'),
  login: (kind, name, pw) => ipcRenderer.invoke('login', kind, name, pw),
  guest: () => ipcRenderer.invoke('guest'),
  drag: (st) => ipcRenderer.invoke('drag', st),
  size: (d) => ipcRenderer.send('orbsize', d),
  menu: () => ipcRenderer.send('menu'),
  onBadge: (f) => ipcRenderer.on('badge', (_e, v) => f(v)),
});
