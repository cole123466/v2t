#!/usr/bin/env bash
# 开发模式（热更新，不构建）：bash scripts/start-dev.sh [--port 8080]
# 仅本机开发使用；对外提供服务请用 scripts/start-prod.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
exec bash "$here/start.sh" --dev "$@"
