// 大肥鱼后端（Cloudflare Worker）
// 作用：把 ModelScope Token / GitHub Token 藏在服务器里，网页里不放任何密钥。
// 建议再加一个 Secret：SESSION_SECRET（随便一长串随机字符，用来给登录令牌签名；不加则用 ADMIN_PW）
// 联网搜索：到 tavily.com 免费注册，把 API Key 加成 Secret：TAVILY_KEY；备用：serper.dev 注册，Key 加成 Secret：SERPER_KEY
// 语音识别：Worker → Settings → Bindings → Add → Workers AI，变量名填 AI
// 需要的 Secrets：MS_KEY、GH_TOKEN、ADMIN_PW、TTS_APPID（豆包语音 APP ID）、TTS_TOKEN（豆包语音 Access Token）
// 可选 Variables：TTS_SPEAKER（音色，默认 ICL_uranus_zh_female_jinglingxiangdao_tob）、TTS_RESOURCE（默认 seed-icl-2.0，报权限错误可改 seed-icl-1.0）
// 需要的 Variables：GH_REPO（如 you/fatfish-memory）、GH_BRANCH（main）、MODEL、VISION
// 可选：绑定一个 KV 命名空间，变量名 RL，用来限制每个 IP 每分钟的请求数

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,PUT,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Admin,Authorization',
};
const json = (o, s = 200, extra = {}) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...CORS, 'Content-Type': 'application/json', ...extra } });

const gh = (env, path, init = {}) =>
  fetch(
    `https://api.github.com/repos/${env.GH_REPO}/contents/${path}` + (init.method === 'PUT' ? '' : `?ref=${env.GH_BRANCH}`),
    {
      ...init,
      headers: {
        Authorization: 'Bearer ' + env.GH_TOKEN,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'fatfish-worker',
      },
    }
  );

async function read(env, path) {
  const r = await gh(env, path);
  if (r.status === 404) return {};
  if (!r.ok) throw new Error('github ' + r.status);
  const j = await r.json();
  const bin = Uint8Array.from(atob(j.content.replace(/\n/g, '')), (c) => c.charCodeAt(0));
  return { sha: j.sha, data: JSON.parse(new TextDecoder().decode(bin)) };
}

async function write(env, path, obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = '';
  bytes.forEach((c) => (bin += String.fromCharCode(c)));
  const content = btoa(bin);
  for (let i = 0; i < 3; i++) {
    const { sha } = await read(env, path);
    const r = await gh(env, path, {
      method: 'PUT',
      body: JSON.stringify({ message: '🐟 ' + path, content, branch: env.GH_BRANCH, sha }),
    });
    if (r.ok) return true;
    if (r.status !== 409 && r.status !== 422) throw new Error('GitHub ' + r.status + ' ' + (await r.text()).slice(0, 160));
  }
  throw new Error('GitHub 写入冲突，请重试');
}

async function limited(env, req, perMin) {
  if (!env.RL) return false;
  const ip = req.headers.get('CF-Connecting-IP') || 'x';
  const key = `${ip}:${Math.floor(Date.now() / 60000)}`;
  const n = +((await env.RL.get(key)) || 0) + 1;
  await env.RL.put(key, String(n), { expirationTtl: 120 });
  return n > perMin;
}

// ---------- 账号 ----------
const enc = new TextEncoder();
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const b64u = (s) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
async function hmac(env, s) {
  const k = await crypto.subtle.importKey('raw', enc.encode(env.SESSION_SECRET || env.ADMIN_PW || 'fatfish'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(s)));
}
async function pbk(pw, salt) {
  const k = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  // 迭代次数取 10000：Worker 免费版单次请求 CPU 只有 10ms，太高会超时
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: 10000 }, k, 256));
}
async function mkToken(env, uid) {
  const p = b64u(JSON.stringify({ u: uid, e: Date.now() + 30 * 864e5 }));
  return p + '.' + (await hmac(env, p));
}
// 账号数据（id 以 acc 开头）必须带有效登录令牌；访客数据靠随机 ID
async function chk(env, req, uid) {
  if (!uid.startsWith('acc')) return true;
  const [p, s] = (req.headers.get('Authorization') || '').replace('Bearer ', '').split('.');
  if (!p || s !== (await hmac(env, p))) return false;
  try {
    const o = JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/')));
    return o.u === uid && o.e > Date.now();
  } catch { return false; }
}

const adminOk = (env, req) => {
  if (!env.ADMIN_PW) return false;
  let pw = '';
  try { pw = decodeURIComponent(req.headers.get('X-Admin') || ''); } catch {}
  return pw.trim() === env.ADMIN_PW.trim();
};

const isAdmin = (env, req) => {
  let pw = '';
  try { pw = decodeURIComponent(req.headers.get('X-Admin') || ''); } catch {}
  return !!env.ADMIN_PW && pw.trim() === env.ADMIN_PW.trim();
};
const MIME = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const rawFile = (env, path) =>
  fetch(`https://api.github.com/repos/${env.GH_REPO}/contents/${path}?ref=${env.GH_BRANCH}`, {
    headers: { Authorization: 'Bearer ' + env.GH_TOKEN, Accept: 'application/vnd.github.raw', 'User-Agent': 'fatfish-worker' },
  });

let okRes;
let volcBadUntil = 0; // 记住能用的语音资源 ID

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const p = new URL(req.url).pathname;

    try {
      // 1) 模型代理：网页不带 Token，由这里加上
      if (p === '/chat/completions' && req.method === 'POST') {
        if (await limited(env, req, 30)) return json({ error: '太快啦，稍等一下' }, 429);
        const b = await req.json();
        if (![env.MODEL, env.VISION].filter(Boolean).includes(b.model)) return json({ error: 'model not allowed' }, 400);
        b.max_tokens = Math.min(+b.max_tokens || 1500, 1500);
        const body = JSON.stringify(b);
        let r;
        for (let i = 0; i < 3; i++) {
          r = await fetch('https://api-inference.modelscope.cn/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.MS_KEY },
            body,
          });
          if (r.status !== 429 && r.status < 500) break; // 限流/上游抖动：自动重试
          await new Promise((ok) => setTimeout(ok, 700 * (i + 1)));
        }
        return new Response(r.body, {
          status: r.status,
          headers: { ...CORS, 'Content-Type': r.headers.get('Content-Type') || 'application/json' },
        });
      }

      // 语音识别：优先豆包语音（中文最准，要在火山控制台开通“录音文件识别极速版”），不可用时自动改用 Workers AI Whisper
      if (p === '/asr' && req.method === 'POST') {
        if (await limited(env, req, 40)) return json({ error: '太快啦，稍等一下' }, 429);
        const { audio } = await req.json();
        if (!audio || audio.length > 2000000) return json({ error: '音频为空或太长' }, 413);
        const errs = [];
        if (env.TTS_APPID && env.TTS_TOKEN && env.ASR_ENGINE !== 'whisper' && Date.now() > volcBadUntil) {
          try {
            const r = await fetch('https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Api-App-Key': env.TTS_APPID,
                'X-Api-Access-Key': env.TTS_TOKEN,
                'X-Api-Resource-Id': 'volc.bigasr.auc_turbo',
                'X-Api-Request-Id': crypto.randomUUID(),
                'X-Api-Sequence': '-1',
              },
              body: JSON.stringify({ user: { uid: env.TTS_APPID }, audio: { data: audio }, request: { model_name: 'bigmodel' } }),
            });
            const code = r.headers.get('X-Api-Status-Code');
            const raw = await r.text();
            if (!code || code === '20000000' || code === '20000003') {
              let j = {};
              try { j = JSON.parse(raw); } catch {}
              const text = (j.result && (j.result.text || (j.result[0] && j.result[0].text))) || '';
              return json({ text, engine: 'volc' });
            }
            errs.push('豆包 ' + code + ' ' + (r.headers.get('X-Api-Message') || raw.slice(0, 100)));
            volcBadUntil = Date.now() + 10 * 60 * 1000; // 没开通就 10 分钟内不再尝试，直接用 Whisper
          } catch (e) {
            errs.push('豆包 ' + e.message);
            volcBadUntil = Date.now() + 60000;
          }
        }
        if (!env.AI && env.CF_ACCOUNT_ID && env.CF_API_TOKEN) {
          // 在 Cloudflare 以外（比如香港服务器）运行时，通过 REST 接口调用同一个 Whisper
          try {
            const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/@cf/openai/whisper-large-v3-turbo`, {
              method: 'POST',
              headers: { Authorization: 'Bearer ' + env.CF_API_TOKEN, 'Content-Type': 'application/json' },
              body: JSON.stringify({ audio, language: 'zh' }),
            });
            const j = await r.json();
            if (r.ok && j.result) return json({ text: String(j.result.text || '').trim(), engine: 'whisper' });
            errs.push('Whisper(REST) ' + r.status + ' ' + JSON.stringify(j.errors || j).slice(0, 100));
          } catch (e) { errs.push('Whisper(REST) ' + e.message); }
        }
        if (env.AI) {
          try {
            let o;
            try {
              o = await env.AI.run('@cf/openai/whisper-large-v3-turbo', { audio, language: 'zh', vad_filter: true, initial_prompt: '以下是普通话的日常聊天对话，内容是中文。' });
            } catch {
              o = await env.AI.run('@cf/openai/whisper-large-v3-turbo', { audio, language: 'zh' });
            }
            return json({ text: String(o.text || '').trim(), engine: 'whisper' });
          } catch (e) {
            errs.push('Whisper ' + String(e.message || e).slice(0, 100));
          }
        }
        return json({ error: errs.length ? errs.join(' ｜ ') : '没有可用的语音识别：请给 Worker 绑定 Workers AI（变量名 AI）' }, 502);
      }

      // 语音合成：豆包语音 V3。资源 ID 会自动依次尝试，记住第一个成功的
      if (p === '/tts' && req.method === 'POST') {
        if (await limited(env, req, 20)) return json({ error: '太快啦，稍等一下' }, 429);
        const { text } = await req.json();
        const t = String(text || '').slice(0, 500);
        if (!t) return json({ error: 'empty' }, 400);
        const speaker = env.TTS_SPEAKER || 'ICL_uranus_zh_female_jinglingxiangdao_tob';
        const list = [...new Set([okRes, env.TTS_RESOURCE, 'seed-tts-2.0', 'seed-icl-2.0', 'seed-tts-1.0', 'seed-icl-1.0'].filter(Boolean))];
        const errs = [];
        for (const res of list) {
          const r = await fetch('https://openspeech.bytedance.com/api/v3/tts/unidirectional', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Api-App-Id': env.TTS_APPID,
              'X-Api-Access-Key': env.TTS_TOKEN,
              'X-Api-Resource-Id': res,
            },
            body: JSON.stringify({
              user: { uid: 'fatfish' },
              req_params: { text: t, speaker, audio_params: { format: 'mp3', sample_rate: 24000 } },
            }),
          });
          const raw = await r.text();
          const parts = [...raw.matchAll(/"data"\s*:\s*"([A-Za-z0-9+\/=]+)"/g)].map((m) => Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0)));
          if (parts.length) {
            okRes = res;
            const out = new Uint8Array(parts.reduce((n, a) => n + a.length, 0));
            let o = 0;
            parts.forEach((a) => { out.set(a, o); o += a.length; });
            return new Response(out, { headers: { ...CORS, 'Content-Type': 'audio/mpeg' } });
          }
          const msg = (raw.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/) || [])[1] || raw;
          errs.push(res + ' → ' + msg.slice(0, 90));
          if (r.status !== 403 && !/not granted|resource|speaker/i.test(raw)) break;
        }
        return json({ error: 'TTS 失败：' + errs.join(' ｜ ') }, 502);
      }

      // 全站默认配置：头像 / 名字 / 人格 / 表情包（所有人可读，仅站长可改）
      if (p === '/config') {
        if (req.method === 'GET') {
          const { data } = await read(env, 'fatfish/config.json');
          return json(data || {}, 200, { 'Cache-Control': 'no-store' });
        }
        if (req.method === 'PUT') {
          if (!env.ADMIN_PW) return json({ error: 'Worker 里没有设置 ADMIN_PW' }, 500);
          if (!adminOk(env, req)) return json({ error: 'forbidden' }, 403);
          const b = await req.json();
          const ok = await write(env, 'fatfish/config.json', {
            name: String(b.name || '').slice(0, 30),
            persona: String(b.persona || '').slice(0, 4000),
            avatar: String(b.avatar || '').slice(0, 200000),
            stk: (Array.isArray(b.stk) ? b.stk : []).slice(0, 60).map((x) => ({ id: String((x && x.id) || '').slice(0, 60), n: String((x && x.n) || '').slice(0, 12) })),
          });
          return json({ ok }, ok ? 200 : 500);
        }
      }

      // 联网搜索：优先 Tavily（tavily.com），失败或没配置时自动改用 Serper（serper.dev，注册送 2500 次）
      if (p === '/search') {
        const q = String((req.method === 'POST' ? (await req.json()).q : new URL(req.url).searchParams.get('q')) || '').slice(0, 200); // 也可以直接在浏览器打开 /search?q=湘阴天气 来测试
        if (!q) return json({ error: 'empty' }, 400);
        if (await limited(env, req, 15)) return json({ error: 'rate' }, 429);
        const errs = [];
        if (env.TAVILY_KEY) {
          const r = await fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.TAVILY_KEY },
            body: JSON.stringify({ query: q, max_results: 5, include_answer: true, search_depth: 'basic' }),
          });
          if (r.ok) {
            const j = await r.json();
            return json({
              answer: j.answer || '',
              results: (j.results || []).slice(0, 5).map((x) => ({ title: x.title, url: x.url, content: String(x.content || '').slice(0, 300) })),
            });
          }
          errs.push('Tavily ' + r.status + ' ' + (await r.text()).slice(0, 120));
        }
        if (env.SERPER_KEY) {
          const r = await fetch('https://google.serper.dev/search', {
            method: 'POST',
            headers: { 'X-API-KEY': env.SERPER_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ q, gl: 'cn', hl: 'zh-cn', num: 5 }),
          });
          if (r.ok) {
            const j = await r.json();
            const ab = j.answerBox || {};
            return json({
              answer: ab.answer || ab.snippet || '',
              results: (j.organic || []).slice(0, 5).map((x) => ({ title: x.title, url: x.link, content: String(x.snippet || '').slice(0, 300) })),
            });
          }
          errs.push('Serper ' + r.status + ' ' + (await r.text()).slice(0, 120));
        }
        return json({ error: errs.length ? errs.join(' ｜ ') : '没有配置 TAVILY_KEY 或 SERPER_KEY' }, 502);
      }

      // 账号：注册 / 登录
      if (p === '/auth/register' || p === '/auth/login') {
        if (req.method !== 'POST') return json({ error: 'method' }, 405);
        if (await limited(env, req, 12)) return json({ error: '尝试太频繁，请稍后再试' }, 429);
        const { name, pw } = await req.json();
        const n = String(name || '').trim().toLowerCase();
        if (!/^[\u4e00-\u9fa5a-z0-9_]{2,20}$/.test(n)) return json({ error: '用户名需 2-20 位，只能用中文、字母、数字、下划线' }, 400);
        if (String(pw || '').length < 6) return json({ error: '密码至少 6 位' }, 400);
        const id = (await sha(n)).slice(0, 24);
        const path = `fatfish/accounts/${id}.json`;
        const { data: acc } = await read(env, path);
        if (p === '/auth/register') {
          if (acc) return json({ error: '用户名已被占用' }, 409);
          const salt = crypto.randomUUID();
          await write(env, path, { name: n, salt, hash: await pbk(String(pw), salt), created: Date.now() });
        } else if (!acc || (await pbk(String(pw), acc.salt)) !== acc.hash) {
          return json({ error: '用户名或密码不对' }, 401);
        }
        const uid = 'acc' + id;
        return json({ uid, name: n, token: await mkToken(env, uid) });
      }

      // 聊天图片：存成 fatfish/img/<uid>/<imgid>.jpg，用不可猜的链接读取
      const im = p.match(/^\/img\/([a-z0-9]{8,40})\/([a-z0-9]{8,40})$/);
      if (im) {
        const path = `fatfish/img/${im[1]}/${im[2]}.jpg`;
        if (req.method === 'GET') {
          const rr = await fetch(`https://api.github.com/repos/${env.GH_REPO}/contents/${path}?ref=${env.GH_BRANCH}`, {
            headers: { Authorization: 'Bearer ' + env.GH_TOKEN, Accept: 'application/vnd.github.raw', 'User-Agent': 'fatfish-worker' },
          });
          if (!rr.ok) return json({ error: 'none' }, 404);
          const buf = await rr.arrayBuffer();
          const u = new Uint8Array(buf, 0, 4);
          const type = u[0] === 0x47 ? 'image/gif' : u[0] === 0x89 ? 'image/png' : u[0] === 0x52 ? 'image/webp' : u[0] === 0x3c ? 'image/svg+xml' : 'image/jpeg';
          return new Response(buf, {
            headers: { ...CORS, 'Content-Type': type, 'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" },
          });
        }
        if (req.method === 'PUT') {
          // siteassets 是全站共用素材（表情包），只有站长密码才能上传
          if (im[1] === 'siteassets' ? !adminOk(env, req) : !(await chk(env, req, im[1]))) return json({ error: 'unauthorized' }, 401);
          if (await limited(env, req, 30)) return json({ error: 'rate' }, 429);
          const { data } = await req.json();
          if (!data || data.length > 400000) return json({ error: 'too large' }, 413);
          for (let i = 0; i < 3; i++) {
            const r = await gh(env, path, { method: 'PUT', body: JSON.stringify({ message: '🐟 img', content: data, branch: env.GH_BRANCH }) });
            if (r.ok || r.status === 422) return json({ ok: true });
            if (r.status !== 409) return json({ error: 'GitHub ' + r.status }, 500);
            await new Promise((ok) => setTimeout(ok, 500 * (i + 1)));
          }
          return json({ error: 'GitHub 冲突' }, 500);
        }
      }

      // 3) 每个访客一个随机 ID，聊天记录和记忆存成 fatfish/users/<id>.json
      const m = p.match(/^\/mem\/([a-z0-9]{8,40})$/);
      if (m) {
        const path = `fatfish/users/${m[1]}.json`;
        if (!(await chk(env, req, m[1]))) return json({ error: 'unauthorized' }, 401);
        if (req.method === 'GET') {
          const { data } = await read(env, path);
          return data ? json(data) : json({ error: 'none' }, 404);
        }
        if (req.method === 'PUT') {
          if (await limited(env, req, 30)) return json({ error: 'rate' }, 429);
          const text = await req.text();
          if (text.length > 900000) return json({ error: 'too large' }, 413);
          const b = JSON.parse(text);
          const ok = await write(env, path, {
            updated: Date.now(),
            avatar: String(b.avatar || '').slice(0, 60000),
            diary: (b.diary || []).slice(0, 40).map((e) => ({ d: String(e.d || '').slice(0, 10), t: String(e.t || '').slice(0, 60), x: String(e.x || '').slice(0, 2500), dr: e.dr ? String(e.dr).slice(0, 80) : undefined })),
            memories: (b.memories || []).slice(0, 500),
            chat: (b.chat || []).slice(-100),
            diary: (b.diary || []).slice(-60),
          });
          return json({ ok }, ok ? 200 : 500);
        }
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  },
};
