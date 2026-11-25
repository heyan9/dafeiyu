const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, dialog, desktopCapturer, session, nativeImage, screen, shell, clipboard, net } = require('electron');
const fs = require('fs');
const path = require('path');

const CFG = require('./config.json');
const API = (CFG.api || '').replace(/\/$/, '');
const SITE = CFG.url || '';
const ORIGIN = (() => { try { return new URL(SITE).origin; } catch { return ''; } })();
const U = (f) => path.join(app.getPath('userData'), f);
const rd = (f, d) => { try { return JSON.parse(fs.readFileSync(U(f), 'utf8')); } catch { return d; } };
const wr = (f, v) => { try { fs.writeFileSync(U(f), JSON.stringify(v)); } catch {} };
const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));

let acct = rd('account.json', null);                       // 登录信息 {uid, token, acct}
let prefs = { w: 420, h: 680, top: true, orb: null, guest: false, ...rd('prefs.json', {}) };
const savePrefs = () => wr('prefs.json', prefs);
let ORB = Math.max(36, Math.min(160, prefs.orbSize || 64));
let loginWin, orb, chat, tray, quitting = false;

if (!app.requestSingleInstanceLock()) app.quit();
const fromSite = (e) => { try { return new URL(e.senderFrame.url).origin === ORIGIN; } catch { return false; } };
const fromLocal = (e) => { try { return e.senderFrame.url.startsWith('file:'); } catch { return false; } };
const tools = require('./tools')({ getChat: () => chat, fromSite, rd, wr });

// ---------------- 登录窗口 ----------------
function createLogin() {
  loginWin = new BrowserWindow({
    width: 380, height: 600, resizable: false, maximizable: false, title: '登录 · 大肥鱼', icon, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'ui.js'), contextIsolation: true, sandbox: true },
  });
  loginWin.setMenu(null);
  loginWin.loadFile('login.html');
  loginWin.on('closed', () => { loginWin = null; if (!orb) app.quit(); });
}
ipcMain.handle('cfg', async (e) => {
  if (!fromLocal(e)) return {};
  // 用 Chromium 的网络栈（会走系统代理），并缓存一份，断网时登录页和悬浮球也能显示头像
  try { const r = await net.fetch(API + '/config'); const j = await r.json(); if (r.ok) { wr('cfg.json', j); return j; } } catch {}
  return rd('cfg.json', {});
});
ipcMain.handle('login', async (e, kind, name, pw) => {
  if (!fromLocal(e)) return { error: '被拒绝' };
  try {
    const r = await net.fetch(`${API}/auth/${kind === 'register' ? 'register' : 'login'}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, pw }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { error: j.error || '失败 ' + r.status };
    acct = { uid: j.uid, token: j.token, acct: j.name };
    wr('account.json', acct);
    startMain();
    loginWin && loginWin.close();
    return { ok: 1 };
  } catch (err) { return { error: '连不上服务器：' + err.message }; }
});
ipcMain.handle('guest', (e) => {
  if (!fromLocal(e)) return;
  acct = null; wr('account.json', null); prefs.guest = true; savePrefs();
  startMain();
  loginWin && loginWin.close();
});

// ---------------- 悬浮球 + 聊天窗口 ----------------
function startMain() {
  if (orb) return;
  createOrb(); createChat(); makeTray();
  globalShortcut.register('CommandOrControl+Shift+F', toggleChat);
  if (process.platform === 'darwin' && app.dock) app.dock.hide();
}
function createOrb() {
  const wa = screen.getPrimaryDisplay().workArea;
  const pos = prefs.orb || { x: wa.x + wa.width - ORB - 30, y: wa.y + wa.height - ORB - 90 };
  orb = new BrowserWindow({
    x: pos.x, y: pos.y, width: ORB, height: ORB, minWidth: 36, minHeight: 36, frame: false, transparent: true, resizable: false, hasShadow: false,
    alwaysOnTop: true, skipTaskbar: true, show: false, title: '大肥鱼',
    webPreferences: { preload: path.join(__dirname, 'ui.js'), contextIsolation: true, sandbox: true },
  });
  orb.setAlwaysOnTop(true, 'screen-saver');
  orb.loadFile('orb.html');
  orb.once('ready-to-show', () => orb.show());
}
function createChat() {
  chat = new BrowserWindow({
    width: prefs.w, height: prefs.h, minWidth: 320, minHeight: 420, show: false, title: '大肥鱼', icon,
    frame: false, maximizable: false, minimizable: false, fullscreenable: false, backgroundColor: '#ffffff', alwaysOnTop: prefs.top,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  chat.setMenu(null);
  chat.webContents.setVisualZoomLevelLimits(1, 1);              // 不要缩放
  chat.webContents.on('zoom-changed', () => chat.webContents.setZoomLevel(0));
  chat.webContents.on('before-input-event', (e, i) => { if ((i.control || i.meta) && ['+', '-', '=', '0'].includes(i.key)) e.preventDefault(); });
  chat.loadURL(SITE);
  chat.webContents.on('did-finish-load', applyCreds);
  // 只允许停留在你的网站，其他链接交给系统浏览器
  chat.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  chat.webContents.on('will-navigate', (e, url) => { try { if (new URL(url).origin !== ORIGIN) { e.preventDefault(); shell.openExternal(url); } } catch {} });
  chat.on('close', (e) => { if (!quitting) { e.preventDefault(); chat.hide(); } });
  let t;
  chat.on('resize', () => { clearTimeout(t); t = setTimeout(() => { if (chat && !chat.isDestroyed()) { const [w, h] = chat.getSize(); prefs.w = w; prefs.h = h; savePrefs(); } }, 400); });
}
// 把登录信息写进聊天页面（网页版的账号就是同一个）
function applyCreds() {
  if (!chat || chat.isDestroyed()) return Promise.resolve();
  const c = JSON.stringify(acct);
  return chat.webContents.executeJavaScript(`(()=>{try{const c=${c},s=JSON.parse(localStorage.getItem('ff_s')||'{}');if((s.token||'')===(c?c.token:''))return;
if(c){s.uid=c.uid;s.token=c.token;s.acct=c.acct}else{delete s.token;delete s.acct;s.uid=''}
localStorage.setItem('ff_s',JSON.stringify(s));['ff_chat','ff_mem','ff_dia','ff_dirty'].forEach(k=>localStorage.removeItem(k));location.reload()}catch(e){}})()`).catch(() => {});
}
function placeChat() {
  const ob = orb.getBounds(), wa = screen.getDisplayMatching(ob).workArea;
  const w = Math.min(prefs.w, wa.width), h = Math.min(prefs.h, wa.height);
  const x = Math.max(wa.x, Math.min(ob.x + ORB - w, wa.x + wa.width - w));
  let y = ob.y - h - 10; if (y < wa.y) y = ob.y + ORB + 10;
  y = Math.max(wa.y, Math.min(y, wa.y + wa.height - h));
  chat.setBounds({ x, y, width: w, height: h });
}
function toggleChat() {
  if (!chat || chat.isDestroyed()) return;
  if (chat.isVisible()) chat.hide();
  else { placeChat(); chat.show(); chat.focus(); orb && orb.webContents.send('badge', false); }
}
const press = (sel) => {
  if (!chat) return;
  if (!chat.isVisible()) { placeChat(); chat.show(); }
  chat.focus();
  chat.webContents.executeJavaScript(`(document.querySelector('${sel}')||{click(){}}).click()`).catch(() => {});
  orb && orb.webContents.send('badge', false);
};
// 拖动悬浮球：左键按住拖动，不动就是点击
let dr = null;
ipcMain.handle('drag', (e, st) => {
  if (!orb || !fromLocal(e)) return false;
  const c = screen.getCursorScreenPoint();
  if (st === 'start') { const b = orb.getBounds(); dr = { c, x: b.x, y: b.y, moved: false }; return false; }
  if (!dr) return false;
  const dx = c.x - dr.c.x, dy = c.y - dr.c.y;
  if (st === 'move') { if (Math.abs(dx) + Math.abs(dy) > 4) dr.moved = true; if (dr.moved) orb.setBounds({ x: dr.x + dx, y: dr.y + dy, width: ORB, height: ORB }); return false; }
  const moved = dr.moved; dr = null;
  if (moved) { const b = orb.getBounds(); prefs.orb = { x: b.x, y: b.y }; savePrefs(); } else toggleChat();
  return moved;
});
ipcMain.on('ping', (e) => { if (fromSite(e) && chat && !chat.isVisible() && orb) orb.webContents.send('badge', true); });
ipcMain.on('menu', (e) => { if (fromLocal(e)) buildMenu().popup({ window: orb }); });

function setOrbSize(n) {
  if (!orb) return;
  n = Math.max(36, Math.min(160, Math.round(n)));
  const b = orb.getBounds(), cx = b.x + b.width / 2, cy = b.y + b.height / 2;
  ORB = n; prefs.orbSize = n;
  const x = Math.round(cx - n / 2), y = Math.round(cy - n / 2);
  orb.setBounds({ x, y, width: n, height: n }); prefs.orb = { x, y }; savePrefs();
}
ipcMain.on('orbsize', (e, d) => { if (fromLocal(e)) setOrbSize(ORB + (d > 0 ? 4 : -4)); });   // 鼠标放在头像上滚轮调大小
ipcMain.on('hide', (e) => { if (fromSite(e) && chat) chat.hide(); });

function buildMenu() {
  const sizes = [['小', 360, 560], ['中', 420, 680], ['大', 520, 780], ['超大', 640, 880]];
  return Menu.buildFromTemplate([
    { label: chat && chat.isVisible() ? '收起聊天' : '打开聊天', click: toggleChat },
    { type: 'separator' },
    { label: '📞 语音通话', click: () => press('#bc') },
    { label: '📖 她的日记', click: () => press('#bd') },
    { label: '🧠 她的记忆', click: () => press('#bm') },
    { label: '👀 让她看看我的屏幕', click: () => press('#bsc') },
    { label: '⚙️ 设置', click: () => press('#bs') },
    { type: 'separator' },
    { label: '聊天窗口大小（也可以直接拖边缘）', submenu: sizes.map(([n, w, h]) => ({ label: `${n}  ${w}×${h}`, type: 'radio', checked: prefs.w === w && prefs.h === h, click: () => { prefs.w = w; prefs.h = h; savePrefs(); if (chat.isVisible()) placeChat(); } })) },
    { label: '始终置顶', type: 'checkbox', checked: prefs.top, click: (m) => { prefs.top = m.checked; savePrefs(); chat.setAlwaysOnTop(m.checked); } },
    { label: '悬浮头像大小（鼠标放在头像上滚轮也能调）', submenu: [['小', 44], ['中', 64], ['大', 88], ['特大', 120]].map(([n, v]) => ({ label: `${n}  ${v}px`, type: 'radio', checked: ORB === v, click: () => setOrbSize(v) })) },
    { label: '清除文件授权（她将只能访问工作区）', click: () => tools.clearRoots() },
    { label: '开机自启', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: (m) => app.setLoginItemSettings({ openAtLogin: m.checked }) },
    { type: 'separator' },
    { label: acct ? `账号：${acct.acct}` : '游客模式', enabled: false },
    { label: acct ? '退出登录' : '登录 / 注册', click: logout },
    { label: '退出大肥鱼', click: () => { quitting = true; app.quit(); } },
  ]);
}
function makeTray() {
  tray = new Tray(icon.resize({ width: 18, height: 18 }));
  tray.setToolTip('大肥鱼');
  tray.on('click', toggleChat);
  tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));
}
async function logout() {
  acct = null; wr('account.json', null); prefs.guest = false; savePrefs();
  await applyCreds();
  setTimeout(() => {
    globalShortcut.unregisterAll();
    [orb, chat].forEach((w) => w && !w.isDestroyed() && w.destroy());
    tray && tray.destroy();
    orb = chat = tray = null;
    createLogin();
  }, 400);
}

// ---------------- 读取文件（日记用） ----------------
const EXT = /\.(txt|md|markdown|log|csv|js|ts|py|html|css|java|c|cpp|go|rs|sh|yml|yaml|ini|tex)$/i;
const SECRET = /(\.env|secret|password|passwd|token|credential|id_rsa|\.pem|\.key)/i;
function walk(dir, depth, out) {
  if (depth > 3 || out.length > 400) return;
  let list; try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const d of list) {
    if (d.name.startsWith('.') || d.name === 'node_modules' || SECRET.test(d.name)) continue;
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p, depth + 1, out);
    else if (EXT.test(d.name)) { try { const st = fs.statSync(p); if (st.size < 2e6) out.push({ p, m: st.mtimeMs }); } catch {} }
  }
}
const approvedToday = {};
const loadFolders = () => rd('folders.json', []);
ipcMain.handle('folders', (e) => (fromSite(e) ? loadFolders() : []));
ipcMain.handle('pick', async (e) => {
  if (!fromSite(e)) return null;
  const r = await dialog.showOpenDialog(chat, { title: '选择允许大肥鱼读取的文件夹', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const l = loadFolders(); if (!l.includes(r.filePaths[0])) { l.push(r.filePaths[0]); wr('folders.json', l); }
  return r.filePaths[0];
});
ipcMain.handle('read', (e, folder, hours) => {
  if (!fromSite(e) || !loadFolders().includes(folder)) return [];
  const out = []; walk(folder, 0, out);
  const since = Date.now() - Math.min(+hours || 24, 168) * 36e5;
  const list = out.filter((f) => f.m >= since).sort((a, b) => b.m - a.m).slice(0, 12);
  if (!list.length) return [];
  const today = new Date().toDateString();
  if (approvedToday[folder] !== today) {
    const ok = dialog.showMessageBoxSync(chat, { type: 'question', buttons: ['允许', '拒绝'], defaultId: 1, cancelId: 1, title: '大肥鱼想读取文件', message: `允许大肥鱼读取「${path.basename(folder)}」里最近改动的 ${list.length} 个文件吗？`, detail: list.map((f) => path.relative(folder, f.p)).join('\n') + '\n\n内容会发送给 AI 模型。' });
    if (ok !== 0) return [];
    approvedToday[folder] = today;
  }
  return list.map((f) => { let text = ''; try { text = fs.readFileSync(f.p, 'utf8').slice(0, 3000); } catch {} return { rel: path.relative(folder, f.p), mtime: f.m, text }; });
});

// ---------------- 识屏 ----------------
let shotOk = 0;
ipcMain.handle('shot', async (e) => {
  if (!fromSite(e)) return null;
  if (Date.now() > shotOk) {
    const r = dialog.showMessageBoxSync(chat, { type: 'question', buttons: ['允许这一次', '10 分钟内都允许', '拒绝'], defaultId: 2, cancelId: 2, title: '大肥鱼想看你的屏幕', message: '允许她看一眼你现在的屏幕吗？', detail: '截图会发送给 AI 模型。' });
    if (r === 2) return null;
    if (r === 1) shotOk = Date.now() + 6e5;
  }
  chat.setOpacity(0); orb && orb.setOpacity(0);              // 截图时先把她自己藏起来
  await new Promise((r) => setTimeout(r, 280));
  try {
    const d = screen.getDisplayMatching(chat.getBounds()).size;
    const src = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.min(d.width, 1600), height: Math.min(d.height, 1000) } });
    if (!src[0]) return null;
    const img = src[0].thumbnail;
    return { full: 'data:image/jpeg;base64,' + img.toJPEG(75).toString('base64'), thumb: 'data:image/jpeg;base64,' + img.resize({ width: 420 }).toJPEG(60).toString('base64') };
  } finally { chat.setOpacity(1); orb && orb.setOpacity(1); }
});

// ---------------- agent：她能帮你做的小事（每次都要你点允许） ----------------
ipcMain.handle('act', async (e, a) => {
  if (!fromSite(e) || !a) return { error: '被拒绝' };
  const ask = (message, detail) => dialog.showMessageBoxSync(chat, { type: 'question', buttons: ['允许', '拒绝'], defaultId: 1, cancelId: 1, title: '大肥鱼想帮你做件事', message, detail: detail || '' }) === 0;
  const arg = String(a.arg || '');
  if (a.type === 'open') {
    let u; try { u = new URL(arg); } catch { return { error: '网址无效' }; }
    if (!/^https?:$/.test(u.protocol)) return { error: '只支持 http / https 网址' };
    if (!ask('在浏览器里打开这个网页？', u.href)) return { error: '你拒绝了' };
    await shell.openExternal(u.href); return { ok: 1, msg: '已打开 ' + u.host };
  }
  if (a.type === 'copy') {
    const t = arg.slice(0, 5000);
    if (!ask('把这段文字复制到剪贴板？', t.slice(0, 300))) return { error: '你拒绝了' };
    clipboard.writeText(t); return { ok: 1, msg: '已复制到剪贴板' };
  }
  if (a.type === 'clip') {
    if (!ask('让她读一下你剪贴板里的文字？', '内容会发送给 AI 模型。')) return { error: '你拒绝了' };
    return { text: clipboard.readText().slice(0, 3000) };
  }
  if (a.type === 'note') {
    const i = arg.indexOf('|'), name = (i < 0 ? '笔记' : arg.slice(0, i)).replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 40) || '笔记', body = i < 0 ? arg : arg.slice(i + 1);
    if (!ask(`保存一个笔记「${name}.txt」到 文档/大肥鱼 文件夹？`, body.slice(0, 300))) return { error: '你拒绝了' };
    const dir = path.join(app.getPath('documents'), '大肥鱼'); fs.mkdirSync(dir, { recursive: true });
    let f = path.join(dir, name + '.txt'), n = 1; while (fs.existsSync(f)) f = path.join(dir, `${name}(${n++}).txt`);
    fs.writeFileSync(f, body, 'utf8'); shell.showItemInFolder(f); return { ok: 1, msg: '已保存到 ' + path.basename(f) };
  }
  return { error: '不支持的操作' };
});

app.whenReady().then(() => {
  if (!ORIGIN || SITE.includes('你的')) { dialog.showErrorBox('还没设置网站地址', '请打开 config.json，把 url 改成你的大肥鱼网址（GitHub Pages 地址）'); app.quit(); return; }
  // 只给你的网站开放麦克风和通知（语音通话要用）
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb, d) => {
    let same = false; try { same = new URL(d.requestingUrl).origin === ORIGIN; } catch {}
    cb(same && (perm === 'media' || perm === 'notifications'));
  });
  if (acct || prefs.guest) startMain(); else createLogin();
});
app.on('second-instance', () => { if (chat && !chat.isDestroyed()) { placeChat(); chat.show(); chat.focus(); } else if (loginWin) loginWin.focus(); });
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => {});
app.on('will-quit', () => globalShortcut.unregisterAll());
