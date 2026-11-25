// 电脑助手：她能做的所有文件 / 命令操作都在这里。
// 安全规则：只能访问「工作区」和你授权过的文件夹；修改文件、运行命令前会弹窗让你确认；
// 覆盖或修改文件前会自动备份到 文档/大肥鱼/.备份；删除只会放进回收站。
const { ipcMain, dialog, shell, clipboard, nativeImage, app } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

module.exports = function init({ getChat, fromSite, rd, wr }) {
  const WS = () => { const d = path.join(app.getPath('documents'), '大肥鱼'); fs.mkdirSync(d, { recursive: true }); return d; };
  const STD = () => ['desktop', 'documents', 'downloads', 'pictures'].map((k) => app.getPath(k));
  const session = new Set();                                  // 本次运行中临时授权（你拖进来的文件所在的文件夹）
  const saved = () => rd('roots.json', []);
  const roots = () => [WS(), ...saved(), ...session].map((p) => path.resolve(p));
  const BAD = /(^|[\\/])(\.ssh|\.gnupg|\.aws|AppData|Windows|Program Files( \(x86\))?|ProgramData|System32|\$Recycle\.Bin|node_modules)([\\/]|$)|(\.env|id_rsa|\.pem|\.key|secret|password|credential)/i;
  const ALIAS = { '桌面': 'desktop', '文档': 'documents', '下载': 'downloads', '图片': 'pictures' };
  const TEXT = /\.(txt|md|markdown|csv|tsv|json|js|ts|jsx|tsx|py|html?|css|java|c|cpp|h|go|rs|sh|bat|ps1|ya?ml|ini|toml|xml|log|tex|sql|vue)$/i;
  const IMG = /\.(png|jpe?g|gif|bmp|webp)$/i;
  const cut = (s, n = 8000) => (s.length > n ? s.slice(0, n) + `\n…（已截断，共 ${s.length} 字）` : s);
  const chat = () => getChat();

  function resolve(p) {
    p = String(p || '').trim().replace(/^["']|["']$/g, '');
    const m = p.match(/^(桌面|文档|下载|图片|工作区)([\\/].*)?$/);
    let abs;
    if (m) abs = path.join(m[1] === '工作区' ? WS() : app.getPath(ALIAS[m[1]]), m[2] || '');
    else if (path.isAbsolute(p)) abs = p;
    else abs = path.join(WS(), p);
    abs = path.resolve(abs);
    if (BAD.test(abs)) throw new Error('这是受保护的位置，不能访问：' + abs);
    return abs;
  }
  const inRoot = (a) => roots().some((r) => a === r || a.startsWith(r + path.sep));
  function ensure(abs) {
    if (inRoot(abs)) return;
    const std = STD().find((s) => abs === s || abs.startsWith(s + path.sep));
    const cand = std || path.dirname(abs);
    const r = dialog.showMessageBoxSync(chat(), { type: 'question', buttons: ['允许', '拒绝'], defaultId: 1, cancelId: 1, title: '大肥鱼想访问文件夹', message: `允许大肥鱼读取和修改「${cand}」里的文件吗？`, detail: '以后不会再问这个文件夹。修改文件前仍会单独让你确认。可以在右键菜单里“清除文件授权”撤销。' });
    if (r !== 0) throw new Error('你没有授权访问这个位置');
    const l = saved(); l.push(cand); wr('roots.json', l);
  }
  function backup(abs) {
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        const d = path.join(WS(), '.备份'); fs.mkdirSync(d, { recursive: true });
        fs.copyFileSync(abs, path.join(d, `${Date.now()}-${path.basename(abs)}`));
      }
    } catch {}
  }
  const strip = (x) => x.replace(/<a:br\/>|<\/a:p>|<\/w:p>/g, '\n').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  async function officeText(a) {
    const z = await require('jszip').loadAsync(fs.readFileSync(a)), ext = path.extname(a).toLowerCase(), num = (n) => parseInt(n.match(/\d+/)[0], 10);
    if (ext === '.docx') return strip(await z.file('word/document.xml').async('string'));
    if (ext === '.pptx') {
      let o = '';
      for (const n of Object.keys(z.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((x, y) => num(x) - num(y))) o += `--- 第${num(n)}页 ---\n` + strip(await z.file(n).async('string')) + '\n';
      return o;
    }
    const ss = z.file('xl/sharedStrings.xml'), strs = ss ? [...(await ss.async('string')).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => strip(m[1])) : [];
    let o = '';
    for (const n of Object.keys(z.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))) {
      o += `--- ${n.split('/').pop()} ---\n`;
      for (const row of (await z.file(n).async('string')).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g))
        o += [...row[1].matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map((c) => { const v = (c[2] || '').match(/<v>([\s\S]*?)<\/v>/); return !v ? '' : /t="s"/.test(c[1]) ? strs[+v[1]] || '' : v[1]; }).join('\t') + '\n';
    }
    return o;
  }

  const T = {
    async paths() { return { text: JSON.stringify({ platform: process.platform, desktop: app.getPath('desktop'), documents: app.getPath('documents'), downloads: app.getPath('downloads'), workspace: WS(), authorized: roots() }) }; },
    async ls(t) {
      const a = resolve(t.path); ensure(a);
      const l = fs.readdirSync(a, { withFileTypes: true }).filter((d) => !d.name.startsWith('.')).slice(0, 200).map((d) => {
        let s = ''; try { if (!d.isDirectory()) s = ` ${Math.max(1, Math.round(fs.statSync(path.join(a, d.name)).size / 1024))}KB`; } catch {}
        return (d.isDirectory() ? '[文件夹] ' : '') + d.name + s;
      });
      return { text: l.join('\n') || '（空文件夹）' };
    },
    async read(t) {
      const a = resolve(t.path); ensure(a);
      if (IMG.test(a)) {
        const img = nativeImage.createFromPath(a); if (img.isEmpty()) throw new Error('无法读取这张图片');
        const sz = img.getSize(), k = Math.min(1, 1280 / Math.max(sz.width, sz.height));
        const o = k < 1 ? img.resize({ width: Math.round(sz.width * k), height: Math.round(sz.height * k) }) : img;
        return { image: 'data:image/jpeg;base64,' + o.toJPEG(80).toString('base64'), text: `图片 ${sz.width}×${sz.height}，已发给你查看` };
      }
      if (/\.(docx|pptx|xlsx)$/i.test(a)) return { text: cut(await officeText(a)) };
      if (!TEXT.test(a) && fs.statSync(a).size > 2e6) throw new Error('这个文件类型不支持读取');
      return { text: cut(fs.readFileSync(a, 'utf8')) };
    },
    async write(t) {
      const a = resolve(t.path); ensure(a); backup(a); fs.mkdirSync(path.dirname(a), { recursive: true });
      fs.writeFileSync(a, String(t.content == null ? '' : t.content), 'utf8'); return { msg: '已写入', text: '已写入 ' + a };
    },
    async edit(t) {
      const a = resolve(t.path); ensure(a); const x = fs.readFileSync(a, 'utf8'), f = String(t.find), n = x.split(f).length - 1;
      if (!n) throw new Error('没找到要替换的文字');
      if (n > 1 && !t.all) throw new Error(`找到 ${n} 处，请给出更长的唯一片段，或设置 all:true`);
      backup(a); fs.writeFileSync(a, x.split(f).join(String(t.replace)), 'utf8'); return { msg: `已替换 ${n} 处`, text: `已替换 ${n} 处：${a}` };
    },
    async mkdir(t) { const a = resolve(t.path); ensure(a); fs.mkdirSync(a, { recursive: true }); return { text: '已创建 ' + a }; },
    async move(t) {
      const a = resolve(t.from), b = resolve(t.to); ensure(a); ensure(b); if (fs.existsSync(b)) throw new Error('目标已存在：' + b);
      fs.mkdirSync(path.dirname(b), { recursive: true });
      try { fs.renameSync(a, b); } catch { fs.cpSync(a, b, { recursive: true }); fs.rmSync(a, { recursive: true }); } return { text: `已移动到 ${b}` };
    },
    async copyfile(t) {
      const a = resolve(t.from), b = resolve(t.to); ensure(a); ensure(b); if (fs.existsSync(b)) throw new Error('目标已存在：' + b);
      fs.mkdirSync(path.dirname(b), { recursive: true }); fs.cpSync(a, b, { recursive: true }); return { text: `已复制到 ${b}` };
    },
    async trash(t) { const a = resolve(t.path); ensure(a); await shell.trashItem(a); return { text: '已放入回收站：' + a }; },
    async image(t) {
      const a = resolve(t.from), b = resolve(t.to); ensure(a); ensure(b);
      const img = nativeImage.createFromPath(a); if (img.isEmpty()) throw new Error('无法读取图片');
      const sz = img.getSize(); let w = +t.width || 0, h = +t.height || 0;
      if (w && !h) h = Math.round(sz.height * w / sz.width); if (h && !w) w = Math.round(sz.width * h / sz.height);
      const o = w || h ? img.resize({ width: w, height: h, quality: 'best' }) : img;
      backup(b); fs.mkdirSync(path.dirname(b), { recursive: true });
      fs.writeFileSync(b, /\.jpe?g$/i.test(b) ? o.toJPEG(+t.quality || 85) : o.toPNG());
      const s2 = o.getSize(); return { msg: '图片已处理', text: `已保存 ${b}（${s2.width}×${s2.height}）` };
    },
    async office(t) {
      const a = resolve(t.path); ensure(a); const out = t.out ? resolve(t.out) : a; ensure(out);
      const z = await require('jszip').loadAsync(fs.readFileSync(a)), esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const parts = Object.keys(z.files).filter((n) => /^(word\/(document|header\d*|footer\d*)|ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+)|xl\/sharedStrings)\.xml$/.test(n));
      let n = 0;
      for (const p of parts) {
        let x = await z.file(p).async('string');
        for (const [f, r] of t.pairs || []) { const ef = esc(f), c = x.split(ef).length - 1; if (c) { x = x.split(ef).join(esc(r)); n += c; } }
        z.file(p, x);
      }
      if (!n) throw new Error('没找到这些文字（可能被拆成了多段格式）。可以换一种说法，或改用重新生成文档');
      if (out === a) backup(a);
      fs.writeFileSync(out, await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
      return { msg: `替换了 ${n} 处`, text: `已替换 ${n} 处，保存到 ${out}` };
    },
    async pptx(t) {
      const a = resolve(/\.pptx$/i.test(t.path) ? t.path : t.path + '.pptx'); ensure(a); backup(a);
      const P = require('pptxgenjs'), p = new P(); p.layout = 'LAYOUT_16x9';
      (t.slides || []).forEach((s) => {
        const sl = p.addSlide();
        sl.addText(String(s.title || ''), { x: 0.6, y: 0.4, w: 8.8, h: 1, fontSize: 32, bold: true, color: '056DE8' });
        if (s.bullets && s.bullets.length) sl.addText(s.bullets.map((b) => ({ text: String(b), options: { bullet: true, breakLine: true } })), { x: 0.8, y: 1.6, w: 8.4, h: 3.6, fontSize: 20, color: '222222', valign: 'top' });
      });
      fs.mkdirSync(path.dirname(a), { recursive: true }); await p.writeFile({ fileName: a });
      return { msg: '已生成 PPT', text: `已生成 ${a}（${(t.slides || []).length} 页）` };
    },
    async docx(t) {
      const a = resolve(/\.docx$/i.test(t.path) ? t.path : t.path + '.docx'); ensure(a); backup(a);
      const D = require('docx'), kids = [];
      if (t.title) kids.push(new D.Paragraph({ text: String(t.title), heading: D.HeadingLevel.TITLE }));
      (t.paragraphs || []).forEach((x) => kids.push(new D.Paragraph({ children: [new D.TextRun(String(x))], spacing: { after: 160 } })));
      fs.mkdirSync(path.dirname(a), { recursive: true });
      fs.writeFileSync(a, await D.Packer.toBuffer(new D.Document({ sections: [{ children: kids }] })));
      return { msg: '已生成 Word 文档', text: '已生成 ' + a };
    },
    run(t) {
      const cwd = t.cwd ? resolve(t.cwd) : WS(); ensure(cwd);
      const win = process.platform === 'win32';
      const [bin, args] = win
        ? ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' + String(t.cmd)]]
        : ['/bin/bash', ['-lc', String(t.cmd)]];
      return new Promise((res) => execFile(bin, args, { cwd, timeout: 60000, maxBuffer: 2e6, windowsHide: true, encoding: 'utf8' }, (err, so, se) =>
        res({ text: cut(`${err ? '【出错：' + (err.killed ? '超时 60 秒' : err.code != null ? '退出码 ' + err.code : err.message) + '】\n' : ''}${so || ''}${se ? '\n[stderr]\n' + se : ''}`.trim() || '（没有输出）', 6000) })));
    },
    async open(t) {
      let u; try { u = new URL(String(t.url)); } catch { throw new Error('网址无效'); }
      if (!/^https?:$/.test(u.protocol)) throw new Error('只支持 http / https 网址');
      await shell.openExternal(u.href); return { msg: '已打开 ' + u.host, text: '已在浏览器打开 ' + u.href };
    },
    async copy(t) { clipboard.writeText(String(t.text || '').slice(0, 5000)); return { msg: '已复制到剪贴板', text: '已复制' }; },
    async clip() { return { text: clipboard.readText().slice(0, 3000) || '（剪贴板里没有文字）' }; },
  };

  const MUT = new Set(['write', 'edit', 'mkdir', 'move', 'copyfile', 'trash', 'image', 'office', 'pptx', 'docx', 'run', 'open', 'copy', 'clip']);
  const s80 = (x) => String(x == null ? '' : x).slice(0, 80);
  const describe = (t) => ({
    write: () => `📝 写入 ${s80(t.path)}（${String(t.content || '').length} 字）`,
    edit: () => `✏️ 修改 ${s80(t.path)}：「${s80(t.find)}」→「${s80(t.replace)}」`,
    mkdir: () => `📁 新建文件夹 ${s80(t.path)}`,
    move: () => `🚚 移动 ${s80(t.from)} → ${s80(t.to)}`,
    copyfile: () => `📋 复制 ${s80(t.from)} → ${s80(t.to)}`,
    trash: () => `🗑️ 移到回收站 ${s80(t.path)}`,
    image: () => `🖼️ 处理图片 ${s80(t.from)} → ${s80(t.to)}`,
    office: () => `📄 替换 Office 文档里的文字 ${s80(t.path)}（${(t.pairs || []).length} 处）`,
    pptx: () => `📊 生成 PPT ${s80(t.path)}（${(t.slides || []).length} 页）`,
    docx: () => `📄 生成 Word ${s80(t.path)}`,
    run: () => `⚙️ 运行命令（目录：${s80(t.cwd || '工作区')}）：\n    ${String(t.cmd || '').slice(0, 400)}`,
    open: () => `🌐 打开网页 ${s80(t.url)}`,
    copy: () => `📋 复制文字到剪贴板：${s80(t.text)}`,
    clip: () => '📋 读取你剪贴板里的文字',
  }[t.tool] || (() => t.tool))();

  let autoUntil = 0;
  ipcMain.handle('tools', async (e, list) => {
    if (!fromSite(e) || !Array.isArray(list)) return [];
    list = list.slice(0, 6);
    const mut = list.filter((t) => MUT.has(t.tool)), hasRun = mut.some((t) => t.tool === 'run');
    if (mut.length && (hasRun || Date.now() > autoUntil)) {
      const btn = hasRun ? ['允许', '拒绝'] : ['允许', '10 分钟内修改文件都允许', '拒绝'];
      const r = dialog.showMessageBoxSync(chat(), { type: 'question', buttons: btn, defaultId: btn.length - 1, cancelId: btn.length - 1, title: '大肥鱼想帮你做事', message: `她想执行 ${mut.length} 个操作：`, detail: mut.map(describe).join('\n') + '\n\n修改前会自动备份，删除只会放进回收站。' });
      if (r === btn.length - 1) return list.map(() => ({ error: '你拒绝了' }));
      if (!hasRun && r === 1) autoUntil = Date.now() + 6e5;
    }
    const out = [];
    for (const t of list) {
      try { const f = T[t && t.tool]; if (!f) throw new Error('不支持的工具：' + (t && t.tool)); out.push(await f(t)); }
      catch (err) { out.push({ error: err.message }); }
    }
    return out;
  });
  ipcMain.handle('saveblob', (e, name, b64) => {
    if (!fromSite(e)) return '';
    const dir = path.join(WS(), '收到的文件'); fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `${Date.now()}-${String(name || '粘贴的图片.png').replace(/[\\/:*?"<>|]/g, '_').slice(-60)}`);
    fs.writeFileSync(f, Buffer.from(String(b64), 'base64')); return f;
  });
  ipcMain.on('grant', (e, list) => {
    if (!fromSite(e) || !Array.isArray(list)) return;
    list.forEach((p) => { try { const a = path.resolve(String(p)); if (!BAD.test(a)) session.add(path.dirname(a)); } catch {} });
  });
  ipcMain.handle('info', (e) => (fromSite(e) ? { platform: process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux', desktop: app.getPath('desktop'), documents: app.getPath('documents'), downloads: app.getPath('downloads'), workspace: WS() } : null));
  return { clearRoots: () => { wr('roots.json', []); session.clear(); } };
};
