# 把大肥鱼后端放到香港服务器（国内不开 VPN 也能用）

## 为什么
国内连不上的是两个地方：网页（github.io）和后端（workers.dev）。App 已经把网页装进了安装包，
所以只要后端也放在国内能直连的地方，就不用开 VPN 了。香港服务器不需要备案，国内访问通常很稳。

## 步骤（约 20 分钟）
1. 买一台香港的云服务器：腾讯云轻量、阿里云 ECS 都行，最低配（1 核 1G）够用，系统选 Ubuntu 22.04。
2. 登录服务器，安装 Node 20 和 Caddy：
   ```
   curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt install -y nodejs
   apt install -y caddy
   ```
3. 把本文件夹里的 `server.js`、`worker.js`、`package.json` 上传到 `/opt/fatfish/`。
4. 复制 `fatfish.env.example` 为 `/opt/fatfish/fatfish.env`，填好各项密钥。
5. 上传 `fatfish.service` 到 `/etc/systemd/system/`，然后：
   ```
   systemctl daemon-reload && systemctl enable --now fatfish
   ```
6. 配 HTTPS：编辑 `/etc/caddy/Caddyfile`，内容参考 `Caddyfile.example`，然后 `systemctl reload caddy`。
   没有域名的话，用 `你的IP（点换成短横线）.sslip.io`，比如服务器 IP 是 43.129.1.2，就写 `43-129-1-2.sslip.io`，Caddy 会自动申请证书。
   记得在云服务器的防火墙里放行 80 和 443 端口。
7. 在浏览器打开 `https://你的域名/config`，看到一段 JSON 就成功了。
8. 把这个地址填到 App 里（安卓：设置向导里的“服务器地址”；电脑版：`desktop/config.json` 的 `api` 后重新打包；网页：设置 → 高级）。

## 注意
- 语音识别没有 Cloudflare 的 AI 可用，所以要填 `CF_ACCOUNT_ID` 和 `CF_API_TOKEN`（在 Cloudflare 后台创建一个有 Workers AI 权限的令牌），或者开通豆包的识别服务。
- 原来 Cloudflare 上的 Worker 可以继续留着当备用。
