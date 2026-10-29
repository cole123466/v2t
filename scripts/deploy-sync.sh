#!/usr/bin/env bash
# v2t 自动部署（最小可行）
#
# 触发：systemd timer v2t-deploy.timer（每 2 分钟）
# 流程：origin/main 有新提交 → 空闲闸门 → 停 v2t-dev → ff 合并 → 必要时 npm ci
#       → 起服 → 健康检查 → 失败回滚
#
# 刻意不做的事：
#   - 不重启 v2t-agent：agent 的任务队列在内存里，重启会丢任务；agent/ 也不在 git 里
#   - 不在有任务/构建时部署：agent pending>0、有 claude 进程、应用队列非空、有构建/测试进程都延后
#   - 不用 reset --hard 覆盖现场：主工作区不干净就延后
#   - 不在同一个 sha 上反复重试：失败过一次就等下一个提交
#
# 配置：/etc/v2t-deploy.conf（可选，写 DEPLOY_* 变量），或直接给环境变量：
#   DEPLOY_REPO / DEPLOY_BRANCH / DEPLOY_SERVICE / DEPLOY_APP_PORT
#   DEPLOY_MIN_MEM_MB=250 / DEPLOY_HEALTH_TIMEOUT=90 / DEPLOY_NPM_TIMEOUT=900
#   DEPLOY_NOTIFY_WEBHOOK=<飞书自定义机器人 webhook，可选>
# 用法：
#   scripts/deploy-sync.sh            # 正常部署（systemd 调用）
#   scripts/deploy-sync.sh --dry-run  # 只检查，不写状态、不重启

set -euo pipefail

# resume 模式全局安全网：exec 重进的进程在配置/state 加载阶段就可能因 set -e
# 失败退出，而此时旧进程已停服——安全网必须先于任何加载逻辑注册。
# DRY_RUN（在 main 里置位）时不动服务；正常结束时 is-active 短路，等于 no-op。
if [ "${DEPLOY_RESUME:-0}" = "1" ]; then
  trap 'if [ "${DRY_RUN:-0}" != "1" ]; then systemctl is-active --quiet "${DEPLOY_SERVICE:-v2t-dev.service}" 2>/dev/null || systemctl start "${DEPLOY_SERVICE:-v2t-dev.service}" >/dev/null 2>&1 || true; fi' EXIT
fi

CONFIG=${DEPLOY_CONFIG:-/etc/v2t-deploy.conf}
if [ -r "$CONFIG" ]; then
  # shellcheck disable=SC1090
  . "$CONFIG"
fi

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=${DEPLOY_REPO:-$(cd "$SCRIPT_DIR/.." && pwd)}
BRANCH=${DEPLOY_BRANCH:-main}
REMOTE=${DEPLOY_REMOTE:-origin}
SERVICE=${DEPLOY_SERVICE:-v2t-dev.service}
APP_PORT=${DEPLOY_APP_PORT:-4317}
HEALTH_PATH=${DEPLOY_HEALTH_PATH:-/api/queue}
HEALTH_TIMEOUT=${DEPLOY_HEALTH_TIMEOUT:-90}
AGENT_HEALTH=${DEPLOY_AGENT_HEALTH:-http://127.0.0.1:4319/health}
MIN_MEM_MB=${DEPLOY_MIN_MEM_MB:-250}
STATE_DIR=${DEPLOY_STATE_DIR:-/var/lib/v2t-deploy}
DB_PATH=${DEPLOY_DB_PATH:-$REPO/data/v2t.db}
WEBHOOK=${DEPLOY_NOTIFY_WEBHOOK:-}
GIT_TIMEOUT=${DEPLOY_GIT_TIMEOUT:-60}
NPM_TIMEOUT=${DEPLOY_NPM_TIMEOUT:-900}

STATE_FILE=$STATE_DIR/state.env
LOCK_FILE=$STATE_DIR/deploy.lock

DEPLOYED_SHA=""
DEPLOYED_AT=""
FAILED_SHA=""
LAST_RESULT=""
LAST_REASON=""
UPDATED_AT=""
if [ -r "$STATE_FILE" ]; then
  # shellcheck disable=SC1090
  . "$STATE_FILE"
fi

DRY_RUN=0

log() {
  printf '%s [deploy] %s\n' "$(date '+%F %T')" "$*"
}

save_state() {
  [ "$DRY_RUN" = "1" ] && return 0
  mkdir -p "$STATE_DIR"
  local tmp="$STATE_FILE.tmp.$$"
  {
    printf 'DEPLOYED_SHA=%q\n' "$DEPLOYED_SHA"
    printf 'DEPLOYED_AT=%q\n' "$DEPLOYED_AT"
    printf 'FAILED_SHA=%q\n' "$FAILED_SHA"
    printf 'LAST_RESULT=%q\n' "$LAST_RESULT"
    printf 'LAST_REASON=%q\n' "$LAST_REASON"
    printf 'UPDATED_AT=%q\n' "$(date -Is)"
  } > "$tmp"
  mv -f "$tmp" "$STATE_FILE"
}

notify() {
  local text=$1
  log "通知：$text"
  [ -n "$WEBHOOK" ] || return 0
  local payload
  payload=$(node -e 'process.stdout.write(JSON.stringify({msg_type:"text",content:{text:process.argv[1]}}))' "$text")
  curl -fsS --max-time 10 -H 'Content-Type: application/json' -d "$payload" "$WEBHOOK" >/dev/null 2>&1 \
    || log "通知发送失败（不影响部署结果）"
}

defer() {
  LAST_RESULT=deferred
  LAST_REASON=$1
  save_state
  log "延后：$1"
  # dry-run 下把失败当非零退出，便于人工/脚本判断
  if [ "$DRY_RUN" = "1" ]; then exit 1; fi
  exit 0
}

rollback() {
  local prev=$1 target=$2 reason=$3 lock_changed=$4
  # 没有上一个健康版本（prev==target，如首次部署或上次已 broken）时，
  # reset 是空操作且「已回滚」通知是误导：显式报无法自动回滚，尽力拉起当前版本
  if [ "$prev" = "$target" ]; then
    log "CRITICAL 部署失败：$reason，且无上一个健康版本可回滚，尽力拉起当前版本"
    systemctl start "$SERVICE" >/dev/null 2>&1 || true
    if wait_health; then
      # 冷编译可能超过健康窗口但服务最终能起来：恢复健康就恢复正常轮转，
      # 不留 broken/FAILED_SHA 把后续部署挡在门外
      DEPLOYED_SHA=$target
      FAILED_SHA=""
      LAST_RESULT=deployed
      LAST_REASON="restart-only 失败后恢复健康（$reason）"
      save_state
      notify "v2t 部署失败后服务恢复健康（无更早基线可回滚）：$reason"
    else
      DEPLOYED_SHA=""
      FAILED_SHA=$target
      LAST_RESULT=broken
      LAST_REASON=$reason
      save_state
      notify "v2t 部署失败且无法自动回滚（无上一个健康版本），需人工处理：$reason"
    fi
    exit 1
  fi
  log "部署失败：$reason，回滚到 ${prev:0:7}"
  systemctl stop "$SERVICE" >/dev/null 2>&1 || true

  local dirty
  dirty=$(git -C "$REPO" status --porcelain --untracked-files=no 2>/dev/null | head -3)
  if [ -n "$dirty" ]; then
    log "工作区不干净，跳过自动 reset --hard：$(printf '%s' "$dirty" | tr '\n' ';')"
  else
    git -C "$REPO" reset --hard "$prev" >/dev/null 2>&1 || log "reset --hard 失败"
  fi

  if [ "$lock_changed" = "1" ]; then
    log "回滚后按旧锁文件重装依赖（npm ci）"
    if ! ( cd "$REPO" && timeout "$NPM_TIMEOUT" npm ci --no-audit --no-fund ); then
      log "CRITICAL 回滚后 npm ci 仍然失败，node_modules 可能不可用"
    fi
  fi

  # 回滚后代码变了，同样清 .next 防 HMR 整页刷新循环；失败不阻断回滚启动
  log "清除 .next（回滚后防 HMR 刷新循环）"
  rm -rf "$REPO/.next" || log "清除 .next 失败（忽略，继续启动）"

  systemctl start "$SERVICE" >/dev/null 2>&1 || log "CRITICAL 回滚后启动失败"

  if wait_health; then
    DEPLOYED_SHA=$prev
    DEPLOYED_AT=$(date -Is)
    FAILED_SHA=$target
    LAST_RESULT=rolled-back
    LAST_REASON=$reason
    save_state
    notify "v2t 部署失败，已回滚到 ${prev:0:7}：$reason"
  else
    DEPLOYED_SHA=""
    FAILED_SHA=$target
    LAST_RESULT=broken
    LAST_REASON=$reason
    save_state
    notify "v2t 部署失败，回滚后仍不健康，需要人工处理：$reason"
  fi
  exit 1
}

deploy() {
  local prev=$1 target=$2 restart_only=$3
  # 第 4 参：resume 重跑时透传外层已计算的 lock_changed（restart_only=1 不会重算）
  local lock_changed=${4:-0}

  if [ "$restart_only" = "1" ]; then
    log "代码已在目标提交，仅重启 $SERVICE"
    notify "v2t 开始部署 ${target:0:7}（代码已在目标提交，仅重启）"
  else
    log "开始部署 ${prev:0:7} -> ${target:0:7}"
    notify "v2t 开始部署 ${prev:0:7} -> ${target:0:7}"
    if git -C "$REPO" diff --name-only "$prev" "$target" | grep -qx 'package-lock.json'; then
      lock_changed=1
    fi
  fi

  systemctl stop "$SERVICE" >/dev/null 2>&1 || true

  # 停服后端口必须释放；否则是残留的 nohup 进程，继续部署会被旧进程的健康检查骗过
  local i
  for i in $(seq 1 20); do
    port_in_use || break
    sleep 0.5
  done
  if port_in_use; then
    systemctl start "$SERVICE" >/dev/null 2>&1 || true
    defer "$APP_PORT 端口仍被占用（旧 nohup 进程未接管？先按 deploy-install.sh 的提示 takeover）"
  fi

  # 极小的竞态：停服瞬间可能有新任务入库，重启会把它们标成孤儿失败
  local busy
  busy=$(app_busy)
  if [ "$busy" != "0" ]; then
    systemctl start "$SERVICE" >/dev/null 2>&1 || true
    defer "停服后发现应用队列有 $busy 个任务，已恢复服务"
  fi

  if [ "$restart_only" = "0" ]; then
    if ! git -C "$REPO" merge --ff-only "$target" >/dev/null 2>&1; then
      systemctl start "$SERVICE" >/dev/null 2>&1 || true
      defer "git merge --ff-only 失败（工作区被并发修改？）"
    fi
  fi

  if [ "$restart_only" = "0" ] && [ "$lock_changed" = "1" ]; then
    log "package-lock.json 有变化，执行 npm ci（可能耗时数分钟）"
    if ! ( cd "$REPO" && timeout "$NPM_TIMEOUT" npm ci --no-audit --no-fund ); then
      rollback "$prev" "$target" "npm ci 失败" "$lock_changed"
    fi
  fi

  # merge / npm ci 可能更新了本脚本自身，而当前进程还在跑旧代码
  # （2026-10-29 #48 合入那次，清 .next 因此未执行）。检测到脚本自身
  # 变更就以新版本重跑：服务已停，resume 路径只做清 .next + 起服。
  local self_rel=${BASH_SOURCE[0]#$REPO/}
  if [ "${DEPLOY_RESUME:-0}" != "1" ] && git -C "$REPO" diff --name-only "$prev" "$target" -- "$self_rel" | grep -q .; then
    # exec 后旧进程的 rollback/notify 全部消失，而此时服务是停着的：
    # 新脚本若有语法错误，服务会一直停着且无人通知。先做语法门禁，
    # 不过关就继续用当前版本走完本次部署（.next 清理以旧逻辑为准）。
    if bash -n "$BASH_SOURCE" 2>/dev/null; then
      log "部署脚本自身有更新，以新版本重新执行（新逻辑当次生效）"
      exec env DEPLOY_RESUME=1 bash "$BASH_SOURCE"
    else
      log "CRITICAL 更新后的 deploy-sync.sh 语法检查未通过，继续用当前版本重启服务，请人工排查新脚本"
      notify "v2t 部署脚本更新后 bash -n 失败，已跳过自更新重跑，服务按当前版本重启"
    fi
  fi

  # 清掉 .next：dev 模式下重启后浏览器 HMR 客户端状态与新 build 对不上，
  # 会让开着的标签页陷入整页 reload 循环（2026-10-27、10-29 两次确诊）。
  # 放在 merge/npm ci 之后：合并失败走 defer 时不清，避免旧服务白白全量重编译；
  # rm 失败（权限/只读挂载/磁盘异常）只记日志不阻断启动。
  log "清除 .next（防 HMR 整页刷新循环）"
  rm -rf "$REPO/.next" && log ".next 已清除" || log "清除 .next 失败（忽略，继续启动）"
  [ ! -d "$REPO/.next" ] || log "警告：.next 清除后仍存在，检查磁盘/权限"

  if ! systemctl start "$SERVICE" >/dev/null 2>&1; then
    rollback "$prev" "$target" "systemctl start 失败" "$lock_changed"
  fi

  if ! wait_health; then
    rollback "$prev" "$target" "健康检查超时（${HEALTH_TIMEOUT}s）" "$lock_changed"
  fi

  DEPLOYED_SHA=$target
  DEPLOYED_AT=$(date -Is)
  FAILED_SHA=""
  LAST_RESULT=deployed
  LAST_REASON=""
  save_state
  notify "v2t 已部署 ${target:0:7}：$(git -C "$REPO" log -1 --format=%s "$target")"
}

port_in_use() {
  ss -ltn 2>/dev/null | awk '{print $4}' | grep -q ":${APP_PORT}\$"
}

agent_pending() {
  local body
  body=$(curl -fsS --max-time 3 "$AGENT_HEALTH" 2>/dev/null) || return 0
  printf '%s' "$body" | sed -n 's/.*"pending":[[:space:]]*\([0-9][0-9]*\).*/\1/p' | head -1
}

claude_running() {
  pgrep -f '(^|/)claude(\.exe)? -p' >/dev/null 2>&1
}

heavy_running() {
  # 注意：claude 的 -p 提示词里常带 vitest/npm install 等字样，按 argv[0] 排除，避免误判
  local pids p cmd0
  pids=$(pgrep -f '(^|/)(ci\.sh( |$)|next build( |$)|vitest([./ ]|$)|tsc([./ ]|$))|^[^ ]*npm (ci|install)( |$)' 2>/dev/null || true)
  [ -n "$pids" ] || return 1
  for p in $pids; do
    cmd0=$(tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null | cut -d' ' -f1)
    case "$cmd0" in
      *claude*) continue ;;
    esac
    return 0
  done
  return 1
}

app_busy() {
  [ -f "$DB_PATH" ] || { printf '0'; return 0; }
  node --no-warnings -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1], { readOnly: true });
    const row = db.prepare(
      "select count(*) c from tasks where status in (?,?,?,?,?,?)"
    ).get("queued","downloading","extracting","fetching-subtitles","transcribing","extracting-frames");
    process.stdout.write(String(row.c));
    db.close();
  ' "$DB_PATH" 2>/dev/null || printf 'ERR'
}

mem_available_mb() {
  awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo
}

wait_health() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if curl -fsS --max-time 5 "http://127.0.0.1:${APP_PORT}${HEALTH_PATH}" >/dev/null 2>&1; then
      return 0
    fi
    systemctl is-active --quiet "$SERVICE" || return 1
    sleep 2
  done
  return 1
}

# 返回空串表示可以部署；否则返回原因
check_blockers() {
  local cur dirty pending busy mem
  systemctl cat "$SERVICE" >/dev/null 2>&1 || { echo "缺少 $SERVICE（先运行 scripts/deploy-install.sh）"; return 0; }

  cur=$(git -C "$REPO" symbolic-ref --short HEAD 2>/dev/null || true)
  [ "$cur" = "$BRANCH" ] || { echo "当前分支 ${cur:-detached}，不是 $BRANCH"; return 0; }

  # 本地领先（有未推送提交）时不能 ff；继续跑会每 2 分钟停一次服，必须延后
  local ahead
  ahead=$(git -C "$REPO" rev-list --count "$REMOTE/$BRANCH..HEAD" 2>/dev/null || echo 0)
  if [ "${ahead:-0}" -gt 0 ]; then
    echo "本地 $BRANCH 领先 $REMOTE/$BRANCH $ahead 个提交（先推送或 rebase；部署只做快进）"
    return 0
  fi

  local f
  for f in rebase-merge rebase-apply MERGE_HEAD CHERRY_PICK_HEAD; do
    if [ -e "$REPO/.git/$f" ]; then echo "git $f 进行中"; return 0; fi
  done

  dirty=$(git -C "$REPO" status --porcelain --untracked-files=no 2>/dev/null | head -3)
  if [ -n "$dirty" ]; then
    echo "工作区有未提交改动：$(printf '%s' "$dirty" | tr '\n' ';')"
    return 0
  fi

  pending=$(agent_pending)
  if [ -n "$pending" ] && [ "$pending" != "0" ]; then
    echo "agent 队列还有 $pending 个任务"
    return 0
  fi

  if claude_running; then echo "有 claude 实施/验证进程在跑"; return 0; fi
  if heavy_running; then echo "有构建/测试进程在跑"; return 0; fi

  busy=$(app_busy)
  case "$busy" in
    0) ;;
    ERR*) echo "应用任务库状态未知：$busy"; return 0 ;;
    *) echo "应用队列还有 $busy 个任务"; return 0 ;;
  esac

  mem=$(mem_available_mb)
  mem=${mem:-0}
  if [ "$mem" -lt "$MIN_MEM_MB" ]; then
    echo "可用内存 ${mem}MB < ${MIN_MEM_MB}MB"
    return 0
  fi

  # 放在最后：takeover 前 dry-run 会停在这里，前面的任务闸门已经都通过了
  if ! systemctl is-active --quiet "$SERVICE" && port_in_use; then
    echo "$APP_PORT 被非 systemd 的旧进程占用（先 takeover）"
    return 0
  fi
}

main() {
  case "${1:-}" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"
      exit 0
      ;;
    "") ;;
    *) echo "未知参数：$1"; exit 2 ;;
  esac

  [ -d "$REPO/.git" ] || { log "仓库不存在：$REPO"; exit 1; }
  mkdir -p "$STATE_DIR"

  if [ "$DRY_RUN" != "1" ]; then
    exec 9>"$LOCK_FILE"
    flock -n 9 || { log "已有部署在跑，跳过"; exit 0; }
  fi

  # 旧版脚本在部署中途把自己更新（merge 带入新版）后，用 DEPLOY_RESUME=1 重进：
  # 此时代码已在目标提交、闸门已在上一轮通过，直接走「仅重启」路径
  # 完成清 .next + 起服 + 健康检查，保证新版逻辑当次部署就生效
  if [ "${DEPLOY_RESUME:-0}" = "1" ]; then
    if [ "$DRY_RUN" = "1" ]; then log "DRY-RUN resume：仅检查，不重启"; exit 0; fi
    # resume 期间服务是停着的：任何未预期退出都先把服务拉起来
    # （正常结束时服务已在跑，is-active 短路，等于 no-op）
    # 注意：trap 必须在 DRY_RUN 早退之后注册，否则 dry-run 会真的启动服务
    trap 'systemctl is-active --quiet "$SERVICE" 2>/dev/null || systemctl start "$SERVICE" >/dev/null 2>&1 || true' EXIT
    # 握手一致性：运行中的脚本必须就是 HEAD 里的版本，否则环境变量可能
    # 来自已被覆盖的旧流程，resume 语义不可信
    local self_rel=${BASH_SOURCE[0]#$REPO/}
    if ! git -C "$REPO" show "HEAD:$self_rel" 2>/dev/null | cmp -s - "$BASH_SOURCE"; then
      log "警告：运行脚本与 HEAD 版本不一致，resume 语义存疑，仅继续本次重启"
    fi
    if [ "$DRY_RUN" = "1" ]; then log "DRY-RUN resume：仅检查，不重启"; exit 0; fi
    local resumed_sha prev_sha
    resumed_sha=$(git -C "$REPO" rev-parse HEAD) || {
      # resume 阶段服务是停着的：任何早退都必须先把服务拉起来
      systemctl start "$SERVICE" >/dev/null 2>&1 || true
      log "CRITICAL resume 读 HEAD 失败，已按当前工作区重启服务"
      exit 1
    }
    # prev 必须是上一个健康版本（state 的 DEPLOYED_SHA），否则健康检查失败时
    # rollback 会 reset 到与 target 相同的（可能已坏的）提交，无法自愈。
    # DEPLOYED_SHA 为空（首次部署 / 上次 broken）时没有可回滚基线：仍按当前
    # 提交重启，但 rollback 会显式报「无法自动回滚」而不是谎称已回滚。
    if [ -n "$DEPLOYED_SHA" ]; then
      prev_sha=$DEPLOYED_SHA
    else
      prev_sha=$resumed_sha
      log "警告：state 无上一个健康版本（DEPLOYED_SHA 为空），resume 失败时无法自动回滚"
    fi
    log "恢复执行（脚本已更新，基线 ${prev_sha:0:7} -> ${resumed_sha:0:7}）"
    # lock_changed 按真实回滚基线（prev_sha..resumed_sha）就地重算：
    # env 透传的值是外层按 head_sha..target 算的，state 与 HEAD 发散时范围
    # 不对齐，会漏判「旧代码配新 node_modules」的回滚场景
    local ro_lock=0
    if git -C "$REPO" diff --name-only "$prev_sha" "$resumed_sha" -- package-lock.json | grep -q .; then ro_lock=1; fi
    deploy "$prev_sha" "$resumed_sha" 1 "$ro_lock"
    return 0
  fi

  local fetch_out target head_sha cur blockers
  if ! fetch_out=$(cd "$REPO" && GIT_TERMINAL_PROMPT=0 timeout "$GIT_TIMEOUT" git fetch --no-write-fetch-head "$REMOTE" "$BRANCH" --quiet 2>&1); then
    defer "git fetch 失败：$(printf '%s' "$fetch_out" | head -1)"
  fi
  target=$(git -C "$REPO" rev-parse "refs/remotes/$REMOTE/$BRANCH")
  head_sha=$(git -C "$REPO" rev-parse HEAD)

  cur=$(git -C "$REPO" symbolic-ref --short HEAD 2>/dev/null || true)
  [ "$cur" = "$BRANCH" ] || defer "当前分支 ${cur:-detached}，不是 $BRANCH"

  if [ "$target" = "$DEPLOYED_SHA" ] && [ "$head_sha" = "$target" ]; then
    exit 0
  fi

  if [ "$target" = "$FAILED_SHA" ]; then
    defer "提交 ${target:0:7} 上次部署失败，等待新提交"
  fi

  blockers=$(check_blockers)
  if [ -n "$blockers" ]; then
    if [ "$DRY_RUN" = "1" ]; then
      log "DRY-RUN blocked：$blockers"
      exit 1
    fi
    defer "$blockers"
  fi

  if [ "$DRY_RUN" = "1" ]; then
    if [ "$head_sha" = "$target" ]; then
      log "DRY-RUN ready：仅重启 $SERVICE（HEAD 已是 ${target:0:7}）"
    else
      log "DRY-RUN ready：可部署 ${head_sha:0:7} -> ${target:0:7}"
    fi
    exit 0
  fi

  if [ "$head_sha" = "$target" ]; then
    # restart_only 也用 DEPLOYED_SHA 当回滚基线：它与 target 不同时（如上次
    # 部署 merge 后崩溃），健康检查失败应回到上一个健康版本而不是原地打转。
    # lock_changed 按基线差重算（仅影响 rollback 的重装决策，此路径不安装）。
    local ro_prev="${DEPLOYED_SHA:-$head_sha}" ro_lock=0
    if git -C "$REPO" diff --name-only "$ro_prev" "$target" -- package-lock.json | grep -q .; then ro_lock=1; fi
    deploy "$ro_prev" "$target" 1 "$ro_lock"
  else
    deploy "$head_sha" "$target" 0
  fi
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
