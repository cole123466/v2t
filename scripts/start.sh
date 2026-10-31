#!/usr/bin/env bash
# V2T 启动脚本：默认先构建再以生产模式运行
# 用法：
#   bash scripts/start.sh                 构建 + 生产模式（默认 4317 端口）
#   bash scripts/start.sh --skip-build    跳过构建，直接运行已有产物
#   bash scripts/start.sh --dev           开发模式（热更新）
#   bash scripts/start.sh --port 8080     指定端口
# 端口也可用环境变量 V2T_PORT 覆盖
# 也可直接用 scripts/start-dev.sh / scripts/start-prod.sh（内部复用本脚本）
set -euo pipefail

cd "$(dirname "$0")/.."

info() { printf '\033[36m[v2t]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[v2t]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[v2t]\033[0m %s\n' "$*" >&2; exit 1; }

PORT="${V2T_PORT:-4317}"
MODE="prod"
SKIP_BUILD=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dev) MODE="dev"; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --port)
      [ $# -ge 2 ] || fail "--port 需要一个端口号"
      PORT="$2"; shift 2 ;;
    --port=*) PORT="${1#*=}"; shift ;;
    -h|--help)
      sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) fail "未知参数：$1（用 --help 查看用法）" ;;
  esac
done

case "$PORT" in
  ''|*[!0-9]*) fail "端口必须是数字：$PORT" ;;
esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  fail "端口超出范围（1-65535）：$PORT"
fi

[ -d node_modules ] || fail "依赖尚未安装，请先运行：bash scripts/setup.sh"
[ -f .env ] || warn ".env 不存在，转写与文案生成会因缺少 API Key 而失败"

command -v ffmpeg >/dev/null 2>&1 || warn "未找到 ffmpeg，抽取音频会失败"
command -v ffprobe >/dev/null 2>&1 || warn "未找到 ffprobe，探测视频时长会失败"

# 放宽 Node 请求体总时长限制：外网慢速上传大视频超过默认 5 分钟会被服务端掐断（见 patch-http-timeouts.cjs）
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require $PWD/scripts/patch-http-timeouts.cjs"

NEXT="./node_modules/.bin/next"
[ -x "$NEXT" ] || fail "未找到 Next.js 可执行文件，请重新运行 scripts/setup.sh"

if [ "$MODE" = "dev" ]; then
  info "开发模式启动：http://localhost:$PORT"
  exec "$NEXT" dev -p "$PORT"
fi

if [ "$SKIP_BUILD" -eq 0 ]; then
  info "构建生产包…"
  npm run build
else
  [ -d .next ] || fail ".next 不存在，无法跳过构建；请去掉 --skip-build"
  info "跳过构建，复用现有产物"
fi

info "生产模式启动：http://localhost:$PORT"
exec "$NEXT" start -p "$PORT"
