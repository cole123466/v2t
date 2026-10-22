#!/usr/bin/env bash
# V2T 一键环境搭建：校验依赖 → 安装 npm 依赖 → 准备 .env
# 用法：bash scripts/setup.sh
set -euo pipefail

cd "$(dirname "$0")/.."

info() { printf '\033[36m[v2t]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[v2t]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[v2t]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 1. Node.js / npm
# ---------------------------------------------------------------------------
command -v node >/dev/null 2>&1 || fail "未找到 node，请先安装 Node.js 22.5+：https://nodejs.org"
command -v npm >/dev/null 2>&1 || fail "未找到 npm，请重新安装 Node.js（含 npm）"

NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
NODE_MINOR="$(node -v | sed 's/^v//' | cut -d. -f2)"
# node:sqlite 需要 Node 22.5+（内置 SQLite，免原生编译）
if [ "${NODE_MAJOR:-0}" -lt 22 ] || { [ "${NODE_MAJOR:-0}" -eq 22 ] && [ "${NODE_MINOR:-0}" -lt 5 ]; }; then
  fail "Node.js 版本过低（当前 $(node -v)），需要 22.5 或更高"
fi
info "Node.js $(node -v) · npm $(npm -v)"

# ---------------------------------------------------------------------------
# 2. ffmpeg / ffprobe（运行时硬依赖：抽取音频、探测时长）
# ---------------------------------------------------------------------------
MISSING=""
for tool in ffmpeg ffprobe; do
  command -v "$tool" >/dev/null 2>&1 || MISSING="$MISSING $tool"
done
if [ -n "$MISSING" ]; then
  warn "缺少依赖：$MISSING"
  warn "安装方式："
  warn "  Windows  https://www.gyan.dev/ffmpeg/builds/ 下载后把 bin 目录加入 PATH"
  warn "  macOS    brew install ffmpeg"
  warn "  Ubuntu   sudo apt install ffmpeg"
  fail "请安装 ffmpeg 后重新执行本脚本"
fi
info "ffmpeg / ffprobe 就绪"

# ---------------------------------------------------------------------------
# 2b. yt-dlp（可选：链接导入功能；缺失不影响本地上传与转写）
# ---------------------------------------------------------------------------
if command -v yt-dlp >/dev/null 2>&1; then
  info "yt-dlp 就绪（$(yt-dlp --version 2>/dev/null || echo '版本未知')）"
else
  warn "未找到 yt-dlp —— 链接导入（B 站 / YouTube）不可用，其余功能不受影响"
  warn "安装方式："
  warn "  Windows  winget install yt-dlp.yt-dlp   或  pip install -U yt-dlp"
  warn "  macOS    brew install yt-dlp"
  warn "  Ubuntu   pipx install yt-dlp"
  warn "安装后重新执行本脚本即可启用链接导入"
fi

# ---------------------------------------------------------------------------
# 3. 安装 npm 依赖
# ---------------------------------------------------------------------------
if [ -f package-lock.json ]; then
  info "安装依赖（npm ci）…"
  if ! npm ci --no-audit --no-fund; then
    # 兜底：锁定文件与 package.json 不一致时 npm ci 会失败，回退到 install
    warn "npm ci 失败，改用 npm install 重试…"
    npm install --no-audit --no-fund || fail "依赖安装失败，请检查网络、代理或 npm 配置"
  fi
else
  info "安装依赖（npm install）…"
  npm install --no-audit --no-fund || fail "依赖安装失败，请检查网络、代理或 npm 配置"
fi

# ---------------------------------------------------------------------------
# 4. 准备 .env
# ---------------------------------------------------------------------------
if [ ! -f .env ]; then
  cp .env.example .env
  warn "已从 .env.example 生成 .env —— 请填入真实 API Key 后再启动"
else
  info ".env 已存在，保留现有配置"
fi

if grep -qE 'sk-your-siliconflow-key|your-bigmodel-key' .env 2>/dev/null; then
  warn ".env 中仍有占位 API Key（SILICONFLOW_API_KEY / LLM_API_KEY），启动后转写与生成会失败"
fi

info "环境搭建完成。启动方式："
info "  开发模式  bash scripts/start.sh --dev"
info "  生产模式  bash scripts/start.sh"
