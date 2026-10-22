#!/usr/bin/env bash
# 本地最小 CI：安装依赖（首次）→ lint → 类型检查 → 测试 → 生产构建
# 只产出可部署构建，不配置远端、不自动部署。
set -euo pipefail

cd "$(dirname "$0")/.."
export CI=1
export NEXT_TELEMETRY_DISABLED=1
export NODE_OPTIONS=--max-old-space-size=1024

step() {
  local name="$1"
  shift
  printf '\n== %s ==\n' "$name"
  local started=$SECONDS
  "$@"
  printf -- '-- %s %ss\n' "$name" "$((SECONDS - started))"
}

[ -d node_modules ] || step "npm ci" npm ci --no-audit --no-fund
step "lint" npm run lint
step "typecheck" npm run typecheck
step "test" npx vitest run
step "build" npm run build

printf '\n本地 CI 全部通过。\n'
