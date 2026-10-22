#!/usr/bin/env bash
# 生产模式（默认先构建）：bash scripts/start-prod.sh [--skip-build] [--port 8080]
# 对外提供服务用这个：没有开发期跨域限制，无需配置 allowedDevOrigins
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
exec bash "$here/start.sh" "$@"
