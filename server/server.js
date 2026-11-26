// 大肥鱼后端（Node 版）：把 worker.js 原样跑在任意服务器上，比如香港的云服务器。
// 所有密钥和变量都放在环境变量里（名字和 Cloudflare Worker 里的一样）。
import http from 'node:http';
import { Readable } from 'node:stream';
import worker from './worker.js';

const env = process.env;
const PORT = +env.PORT || 8787;

http
  .createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (v != null) headers.set(k, Array.isArray(v) ? v.join(',') : v);
      const url = `http://${req.headers.host || 'localhost'}${req.url}`;
      const hasBody = !['GET', 'HEAD'].includes(req.method) && chunks.length;
      const request = new Request(url, { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined });
      const out = await worker.fetch(request, env, {});
      res.writeHead(out.status, Object.fromEntries(out.headers));
      if (out.body) Readable.fromWeb(out.body).pipe(res);
      else res.end();
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String((e && e.message) || e) }));
    }
  })
  .listen(PORT, () => console.log('大肥鱼后端已启动，端口 ' + PORT));
