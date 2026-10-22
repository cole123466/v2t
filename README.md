# V2T — 声画内容工作台

上传本地视频或粘贴 B 站 / YouTube 链接，自动转写、抽帧，并生成**带时间出处与真实画面**的图文文章；还可以围绕视频提问。播放器、波形、文稿三方联动。

```
本地上传 | 链接导入 → 字幕优先 / ffmpeg 抽音频 → ASR 转写（长音频自动分段）
→ 全景抽帧 → 文稿/画面联动浏览 → 图文文章 | AI 文案 | 证据问答
```

## 功能

- **两种来源**：本地上传（默认 ≤2GB）或 B 站（含分 P）/ YouTube 链接导入
- **转写**：优先使用容器字幕，覆盖率不足回退 ASR；句级时间戳，超 50 分钟自动分段合并
- **抽帧**：就绪后抽取覆盖全片的全景帧，作为文章配图与问答取证
- **图文文章**：提纲 → 逐章两步生成，支持段落 / 引用 / 列表 / 代码 / 表格 / 画面块与行内粗体、斜体、代码、链接；正文插入真实画面，带 `[[tNN]]` / `[[fNN]]` 出处与内容导图；三档深度，可导出 Markdown
- **证据问答**：回答标注转写稿出处，显式列出「未确认之处」，点击编号跳转视频时间
- **AI 文案**：4 个预设模板或自定义提示词，流式输出、多版本历史
- **存储治理**：源视频 / 音频 / 画面帧按天清理（默认 7 天），转录稿与文案永久保留

## 依赖

- **Node.js ≥ 22.5**（使用内置 `node:sqlite`，无需编译原生模块）
- **ffmpeg**（含 ffprobe），需在 PATH 中
- **yt-dlp**（可选），仅链接导入需要

```bash
ffmpeg -version    # 必须有输出
yt-dlp --version   # 可选
```

## 快速开始

```bash
bash scripts/setup.sh        # 校验依赖 → 安装 npm 包 → 生成 .env
bash scripts/start-prod.sh   # 构建 + 生产模式 → http://localhost:4317
```

Windows：

```bat
scripts\setup.bat
scripts\start-prod.bat
```

首次运行请在 `.env` 填好 `SILICONFLOW_API_KEY`（转写）和 `LLM_API_KEY`（文案 / 图文 / 问答）。

## 启动方式

| 命令 | 说明 |
| --- | --- |
| `scripts/start-prod.sh` / `.bat` | 对外提供服务：构建后以生产模式运行，零配置 |
| `scripts/start-dev.sh` / `.bat` | 本机开发：热更新，不构建，仅 localhost 默认放行 |
| `--port 8080` 或 `V2T_PORT=8080` | 改端口，默认 **4317** |
| `--skip-build` | 生产模式复用已有 `.next` 产物，快速重启 |
| `--help` | 查看全部参数 |

`scripts/start.sh` 仍可直接用，加 `--dev` 切换模式。

## 配置（.env）

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `SILICONFLOW_API_KEY` | 转写 API Key | 必填 |
| `ASR_MODEL` | 转写模型 | `XingChenAGI/XingChenASR-V3.2-Ultra` |
| `LLM_API_KEY` | 文案 / 图文 / 问答 API Key | 必填 |
| `LLM_BASE_URL` | LLM 的 OpenAI 兼容端点 | `https://open.bigmodel.cn/api/paas/v4` |
| `LLM_MODEL` / `LLM_VISION_MODEL` | 文本模型 / 视觉模型 | `glm-4.6` / `glm-4.6v` |
| `DOWNLOADER_COOKIES_FILE` | 链接导入的登录 Cookie（Netscape 格式） | 空 = 免登录 |
| `MAX_UPLOAD_GB` | 上传上限 | `2` |
| `MEDIA_RETENTION_DAYS` | 媒体保留天数 | `7` |
| `DATA_DIR` | 数据库与任务媒体目录 | `./data` |
| `ALLOWED_DEV_ORIGINS` | 仅开发模式：允许的远程 host（逗号分隔，不入库） | 空 |

### 关于 B 站下载

机房 IP 常被 B 站风控返回 412。程序会自动改走官方内容接口兜底，拿到 **720P 单文件**，足够抽帧与转写。想要更高清晰度或平台字幕，需导出登录态 Cookie：

1. 浏览器登录 B 站，用扩展导出 Netscape 格式的 cookies.txt；
2. `.env` 设置 `DOWNLOADER_COOKIES_FILE=/绝对路径/cookies.txt`；
3. 重启服务。

## 开发

```bash
npm run dev        # 开发服务器（4317）
npm run build      # 生产构建
npm run lint       # ESLint
npm run typecheck  # tsc --noEmit
npm test           # vitest（服务层）
```

远程访问开发服务器时，Next 16 会拦截非 localhost 的 `/_next` 资源（表现为热更新不生效）。本机开发无需处理；确需远程调试热更新，才在 `.env` 设 `ALLOWED_DEV_ORIGINS=<你的 host>`。对外提供服务请直接用 `start-prod`，不涉及该限制。

### 本地 CI

```bash
bash scripts/ci.sh   # 或 npm run ci
```

依次执行 lint → typecheck → test → build，任一步失败立即退出；首次运行会先 `npm ci`。只产出可部署构建，不配置远端、不自动部署。构建默认限制 1G 堆内存，构建期间建议停掉 `next dev` 以避开内存峰值。

## 技术栈

Next.js 16（App Router / Turbopack）· React 19 · Tailwind CSS v4 · motion · Lucide 图标；后端为 Next Route Handlers + 内置 `node:sqlite`，SSE 推送任务进度与生成流。

## 限制

- 引用校验只保证编号、帧与时间点真实存在，不保证论断语义正确
- 检索是词法的（无向量检索），长转写先检索、无命中再全片抽样
- 默认 12 张全景帧，覆盖稀疏，文章与问答会在 `limitations` 中说明
- 本地单人使用，无鉴权
