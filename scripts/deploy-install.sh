#!/usr/bin/env bash
# 安装 v2t 的 systemd 单元与每 2 分钟一次的自动部署 timer。
#
# 只安装单元，不会停掉当前用 nohup 跑着的 dev server；接管步骤见结尾输出。
# 用法：sudo scripts/deploy-install.sh
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
unit_dir=/etc/systemd/system

[ "$(id -u)" = "0" ] || { echo "需要 root 运行"; exit 1; }

for f in v2t-dev.service v2t-deploy.service v2t-deploy.timer; do
  sed "s#@REPO@#$here#g" "$here/deploy/$f" > "$unit_dir/$f"
  chmod 644 "$unit_dir/$f"
done

mkdir -p /var/lib/v2t-deploy
systemctl daemon-reload
systemctl enable v2t-dev.service >/dev/null
systemctl enable --now v2t-deploy.timer >/dev/null

echo "已安装：v2t-dev.service / v2t-deploy.service / v2t-deploy.timer"
echo "timer 已启动，每 2 分钟检查一次 origin/main（有任务时只记日志、不部署）。"
echo

pid=$(ss -ltnp "sport = :4317" 2>/dev/null | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | head -1)
if [ -n "$pid" ]; then
  sid=$(ps -o sid= -p "$pid" | tr -d ' ')
  echo "当前 4317 仍由旧进程（PID $pid，会话 $sid）占用，所以自动部署会一直延后。"
  echo "接管步骤（必须等空闲时手动做）："
  echo "  1) scripts/deploy-sync.sh --dry-run     # 只应剩「4317 被旧进程占用」这一个延后项"
  echo "  2) kill -TERM -- -$sid                  # 结束后确认 4317 已释放"
  echo "  3) systemctl start v2t-dev"
  echo "  4) scripts/deploy-sync.sh --dry-run     # 应输出 DRY-RUN ready（下一次 timer 会补一次重启）"
else
  echo "4317 空闲。"
  echo "  1) scripts/deploy-sync.sh --dry-run"
  echo "  2) systemctl start v2t-dev"
fi
echo
echo "可选配置：/etc/v2t-deploy.conf（DEPLOY_* 变量，见 scripts/deploy-sync.sh 顶部）。"
