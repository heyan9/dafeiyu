const { contextBridge, ipcRenderer, webUtils } = require('electron');

// 聊天窗口里的网页只能通过这些受限接口使用电脑功能；修改文件、运行命令等都会在电脑上弹窗让你确认
contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  folders: () => ipcRenderer.invoke('folders'),
  pickFolder: () => ipcRenderer.invoke('pick'),
  readRecent: (folder, hours) => ipcRenderer.invoke('read', folder, hours || 24),
  screenshot: () => ipcRenderer.invoke('shot'),
  act: (a) => ipcRenderer.invoke('act', a),
  tools: (list) => ipcRenderer.invoke('tools', list),
  info: () => ipcRenderer.invoke('info'),
  hide: () => ipcRenderer.send('hide'),
  ping: () => ipcRenderer.send('ping'),
  avatar: (a) => ipcRenderer.send('avatar', a),
});

// 拖进来 / 粘贴进来的文件：拿到真实路径后通知网页（没有路径的剪贴板图片会先存进工作区）
async function report(files) {
  const out = [], real = [];
  for (const f of files) {
    let p = '';
    try { p = webUtils.getPathForFile(f); } catch {}
    if (p) real.push(p);
    else if (f.size < 8e6) {
      try { p = await ipcRenderer.invoke('saveblob', f.name || '粘贴的图片.png', Buffer.from(await f.arrayBuffer()).toString('base64')); } catch {}
    }
    if (p) out.push({ name: f.name || p.split(/[\\/]/).pop(), path: p, img: /^image\//.test(f.type) });
  }
  if (real.length) ipcRenderer.send('grant', real);
  if (out.length) window.dispatchEvent(new CustomEvent('desktop-files', { detail: JSON.stringify(out) }));
}
document.addEventListener('drop', (e) => { const fs = [...((e.dataTransfer && e.dataTransfer.files) || [])]; if (fs.length) report(fs); }, true);
document.addEventListener('paste', (e) => { const fs = [...((e.clipboardData && e.clipboardData.files) || [])]; if (fs.length) report(fs); }, true);
