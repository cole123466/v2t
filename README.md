# V2T — 声画内容工作台

上传本地视频或粘贴 B 站 / YouTube 链接，自动完成转写、抽帧，并生成**带时间出处与真实画面**的图文文章；还可以围绕视频追问。播放器、波形与文稿三方联动，全程一站式完成。

```
（本地上传 | 链接导入）→ 字幕优先 / ffmpeg 抽音频 →（超 50 分钟自动分段）→ ASR 转写
→ 全景抽帧 → 工作台联动浏览 → 图文文章（提纲 → 逐章）| AI 文案 | 证据问答
```

## 功能

- **两种来源**：本地视频 / 音频直传（最大 2GB，可配）；或粘贴 B 站（含分 P）与 YouTube 链接，免登录下载后进入同一管线
- **字幕优先转写**：容器内字幕轨道可用时优先采用（覆盖率不足自动回退 ASR），任务详情展示转写来源
- **时间戳转写**：句级时间戳的中文转写；长音频自动按 50 分钟分段、时间戳偏移合并
- **全景抽帧**：就绪后自动抽取覆盖全片的画面帧，作为文章配图与问答取证依据；抽帧失败不影响文稿与文案
- **图文文章**：两步生成（提纲 → 逐章），产出带章节、真实画面、`[[tNN]]`/`[[fNN]]` 时间引用与内容导图的文章；引用经服务端白名单校验，模型无法编造出处；三档深度（速览/标准/深入）+ 可选关注点；可导出 Markdown
- **证据问答**：围绕视频提问，回答标出转写稿出处并显式列出「未确认之处」；点击引用芯片跳转视频对应时间；跨语言提问在词法检索无命中时自动改用全片抽样
- **过程回看**：每次模型调用的目的、耗时与结果持久化，任务完成后仍可查看
- **声画稿联动**：自定义播放器 + 客户端波形 + 转写稿三方联动，点击任意一句即定位画面
- **AI 文案生成**：4 个预设模板（全文精炼 / 小红书笔记 / 公众号长文 / 三句话速览）或自定义提示词，流式输出、多版本历史、复制与 Markdown 导出
- **存储治理**：源视频 / 音频 / 画面帧按保留天数自动清理（默认 7 天），转录稿、文章与文案永久保留；任务可整体删除；存储占用统计
- **健壮性**：服务重启时自动把"处理中"的孤儿任务标记为失败并给出原因

## 前置依赖

- **Node.js ≥ 22.5**（使用内置 `node:sqlite`，无需 VS C++ 工具链或 Python）
- **ffmpeg**（含 ffprobe）：需要在 PATH 中可用
- **yt-dlp**（可选）：仅链接导入需要；缺失时本地上传与转写不受影响

```bash
ffmpeg -version   # 验证安装
yt-dlp --version  # 验证下载器（可选）
```

Windows 上 ffmpeg 可从 [ffmpeg.org](https://ffmpeg.org/download.html) 下载后将 bin 目录加入 PATH；yt-dlp 用 `winget install yt-dlp.yt-dlp` 或 `pip install -U yt-dlp`。

**Linux 从零开始（Ubuntu / Debian 系）：**

```bash
# 1. Node.js 22.5+（NodeSource；发行版自带的 node 通常版本不足）
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs ffmpeg

# 2. yt-dlp（可选，仅链接导入需要）
sudo apt install -y pipx && pipx install yt-dlp

# 3. 在解压后的项目目录里搭建并启动
bash scripts/setup.sh
bash scripts/start.sh
```

RHEL / Fedora / Arch 用各自的包管理器装 `nodejs>=22.5` 与 `ffmpeg` 即可，其余步骤相同。项目不需要 C++ 工具链或 Python 编译原生模块（SQLite 走 Node 内置 `node:sqlite`）。

## 一键搭建与启动

提供跨平台脚本，新机器从零跑起来只需两步。

**Windows（cmd / PowerShell）：**

```bat
scripts\setup.bat              :: 校验 Node/ffmpeg -> 装依赖 -> 生成 .env
scripts\start.bat              :: 构建 + 生产模式，http://localhost:4317
scripts\start.bat --dev        :: 开发模式（热更新）
```

**macOS / Linux / Git Bash：**

```bash
bash scripts/setup.sh          # 同上
bash scripts/start.sh          # 构建 + 生产模式
bash scripts/start.sh --dev    # 开发模式
```

常用参数（两个 start 脚本一致）：

| 参数 | 说明 |
| --- | --- |
| `--dev` | 开发模式，热更新，不构建 |
| `--skip-build` | 生产模式但复用已有 `.next` 产物，快速重启 |
| `--port 8080` | 指定端口（亦可用环境变量 `V2T_PORT`） |
| `--help` | 查看用法 |

## 手动启动

```bash
npm install
cp .env.example .env   # 填入你自己的 API Key
npm run dev            # http://localhost:4317
```

生产运行：

```bash
npm run build
npm start              # 同样监听 4317
```

> 端口固定为 4317（避开 3000 这类常用端口）。如需临时改变，可用 `PORT=8080 npm run dev`。

测试（服务层 TDD 套件）：

```bash
npm test
```

## 配置项（.env）

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `SILICONFLOW_API_KEY` | 硅基流动 API Key（转写用） | 必填 |
| `SILICONFLOW_BASE_URL` | 硅基流动 OpenAI 兼容端点 | `https://api.siliconflow.cn/v1` |
| `ASR_MODEL` | 转写模型（需支持时间戳返回） | `XingChenAGI/XingChenASR-V3.2-Ultra` |
| `LLM_BASE_URL` | 文案与文章生成 LLM 的 OpenAI 兼容端点 | `https://open.bigmodel.cn/api/paas/v4` |
| `LLM_API_KEY` | LLM API Key（默认智谱 bigmodel） | 必填 |
| `LLM_MODEL` | 纯文本模型（文案模板、提纲与问答） | `glm-4.6` |
| `LLM_VISION_MODEL` | 视觉模型（图文文章的带图章节调用） | `glm-4.6v-flash` |
| `DOWNLOADER_COOKIES_FILE` | 链接导入的可选登录 Cookie 文件（Netscape 格式） | 空 = 免登录 |
| `MAX_UPLOAD_GB` | 上传大小上限（GB） | `2` |
| `MEDIA_RETENTION_DAYS` | 源媒体与画面帧保留天数（转录、文章、文案不受限） | `7` |
| `DATA_DIR` | 数据目录（SQLite + 任务媒体） | `./data` |

> 转写走硅基流动，单文件硬限制约 1 小时 / 50MB——因此超过 50 分钟的音频会自动分段转写再合并。
>
> 免登录 Cookie 时 B 站可下载免登录可达的清晰度（约 480P），足够全景帧使用；**平台字幕需要登录 Cookie**，未提供时字幕优先只对本地上传视频的容器内字幕轨生效。

## 技术栈

- **前端**：Next.js 16（App Router / Turbopack）、React 19、Tailwind CSS v4（`@theme` 设计 tokens）、motion、Lucide 图标（全站零表情符号）
- **后端**：Next.js Route Handlers（Node runtime）、内置 `node:sqlite`（WAL，零原生编译）、SSE 任务进度与生成流式输出、HTTP Range 视频拖动
- **服务抽象**：`ASRProvider` 与 `LLMProvider` 为注入接口，服务层测试全部使用假实现（`tests/server/`）
- **数据**：`data/v2t.db`（任务 + 文案版本）与 `data/tasks/<id>/`（source.* / audio.mp3 / transcript.json）

## 目录速览

```
src/
  app/                    # 页面与 API 路由
    page.tsx              # Landing 滚动叙事
    studio/               # 上传 / 链接导入工作台
    task/[id]/            # 三栏联动工作台（文稿 / 图文 / 问答 / 文案 / 过程）
    api/tasks/…           # 上传 / 链接导入 / 状态 / SSE / 转录稿 / 画面帧 / 文章 / 问答 / 过程
    api/source/probe/     # 链接元数据预检
    api/storage/          # 存储统计
  components/
    workbench/            # 播放器 / 波形 / 转写稿 / 文章 / 问答 / 过程 / 提示词面板
    landing/              # 波形条阵
  server/                 # ffmpeg / 字幕 / 抽帧 / 下载器 / 转写 / 文章 / 问答 / 任务队列 / 存储治理
scripts/                  # setup.sh|bat 一键搭建，start.sh|bat 启动（含端口/模式参数）
tests/server/             # 服务层 TDD（Seam A 管线 / B 文案 / C 来源 / D 问答 / 维护）
```

## 设计边界

- **引用可校验但不等同于语义正确**：服务端校验编号存在、帧文件存在、时间落在时长内；它保证出处不是编的，不保证每个论断都准确。
- **检索是词法的**：没有向量检索（SQLite 无原生支持）。短转写全量送入；长转写先词法检索，无命中时退化为全片均匀抽样。
- **抽帧是稀疏的**：默认 12 张全景帧覆盖全片，不能证明所有视觉事件都被看到。文章与问答的 `limitations` 会显式说明这一点。
- **审核不替代人工**：生成的文章与回答仍需自己过一遍再发布。

## 已知边界（范围外）

- 多用户 / 鉴权：本地单人使用，无鉴权
- 单条分享链接与公开示例页：本地工具无公网承载，未实现
- 运行时模型选择 UI：模型经 `.env` 配置
- E2E 测试：二期
