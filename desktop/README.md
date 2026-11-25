# 大肥鱼桌面版

桌面上悬浮一个圆形头像：
- **左键**点一下：弹出 / 收起聊天窗口（窗口可以拖边缘改大小，右键菜单里也有 小/中/大/超大）
- **按住拖动**：把她放到喜欢的位置
- **右键**：语音通话、日记、记忆、让她看屏幕、设置、窗口大小、置顶、开机自启、退出登录
- 快捷键 `Ctrl+Shift+F`（Mac 是 `Cmd+Shift+F`）：显示 / 隐藏聊天

## 她能帮你处理电脑里的文件（像 Codex 一样）
- 把文件**拖进聊天窗口**或 **Ctrl+V 粘贴**（图片、PPT、Word、Excel、文本都行），再告诉她想怎么处理。
- 也可以直接说：“把桌面上的 汇报.pptx 里的‘2025’全部改成‘2026’”“把下载文件夹里的图片都压缩到 800 宽”。
- 她会读取 txt/代码/csv/docx/pptx/xlsx 的文字、直接看图片、改文字、替换 Office 文档里的文字、新建 PPT/Word、缩放转换图片、整理文件、运行命令。
- **安全**：只能访问「文档/大肥鱼」工作区和你同意过的文件夹；改文件、运行命令前会弹窗列出要做的每一步，你点允许才执行；改动前自动备份到 `文档/大肥鱼/.备份`；删除只会放进回收站；运行命令每次都要你确认。
- 她不能控制你的鼠标和键盘，也不会静默做任何修改。

## 方法一：用 GitHub 自动打包（推荐，不用装任何东西）
1. 把本压缩包里的 `desktop` 文件夹和 `.github` 文件夹上传到你放网页的那个 GitHub 仓库根目录。
2. 打开仓库的 Actions 标签页，左边点「打包桌面版」，右边点 Run workflow。
3. 等 5~10 分钟，仓库右侧 Releases 里会出现安装包。网页版设置里也会出现下载按钮。

## 方法二：自己电脑上运行
1. 安装 Node.js（nodejs.org，选 LTS）。
2. 打开 `config.json`，把 `url` 改成你的网页地址。
3. 在本文件夹打开终端：`npm install`，然后 `npm start`。
   国内 npm 慢可先运行：`npm config set registry https://registry.npmmirror.com`
   Windows PowerShell 再运行：`$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"`
4. 想生成安装程序：`npm run dist`。

## 注意
- Windows 安装时可能提示“未知发布者”，点「更多信息 → 仍要运行」。
- Mac 第一次打开如果提示“已损坏”或无法验证，在终端运行：`xattr -cr /Applications/大肥鱼.app`，或右键 → 打开。
