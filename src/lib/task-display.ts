import type { Task, TaskStatus } from "@/server/tasks";
import type { QueueSnapshot } from "@/server/runner";
import { STATUS_LABEL } from "@/lib/task-status";

/** 任务状态在列表里的单色样式；文案统一沿用 STATUS_LABEL */
export const STATUS_META: Record<TaskStatus, { label: string; cls: string; dot: string }> = {
  queued: { label: STATUS_LABEL.queued, cls: "text-paper-faint", dot: "bg-paper-faint" },
  downloading: { label: STATUS_LABEL.downloading, cls: "text-gold", dot: "bg-gold animate-pulse" },
  extracting: { label: STATUS_LABEL.extracting, cls: "text-gold", dot: "bg-gold animate-pulse" },
  "fetching-subtitles": {
    label: STATUS_LABEL["fetching-subtitles"],
    cls: "text-gold",
    dot: "bg-gold animate-pulse",
  },
  transcribing: { label: STATUS_LABEL.transcribing, cls: "text-gold", dot: "bg-gold animate-pulse" },
  "extracting-frames": {
    label: STATUS_LABEL["extracting-frames"],
    cls: "text-gold",
    dot: "bg-gold animate-pulse",
  },
  ready: { label: STATUS_LABEL.ready, cls: "text-positive/90", dot: "bg-positive/90" },
  failed: { label: STATUS_LABEL.failed, cls: "text-danger/90", dot: "bg-danger/90" },
  canceled: { label: STATUS_LABEL.canceled, cls: "text-paper-faint", dot: "bg-paper-faint" },
};

export function timeAgo(iso: string) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return new Date(iso).toLocaleDateString("zh-CN");
}

export function fmtSize(n: number) {
  if (n > 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n > 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/**
 * 排队位次以服务端队列快照为准（它才是真正的取任务顺序）；
 * 刚上传的任务可能比 4 秒一次的轮询更新得早，快照里还没有它就按列表先后
 * （旧任务在前）补在快照已有位次之后，至少能显示"排队中（第 N 位）"。
 */
export function queuedPositions(
  tasks: Task[],
  queue: QueueSnapshot | null,
): Map<string, number> {
  const positions = new Map<string, number>();
  if (queue) queue.queued.forEach((task, i) => positions.set(task.id, i + 1));
  let next = positions.size;
  for (let i = tasks.length - 1; i >= 0; i -= 1) {
    const task = tasks[i];
    if (task.status === "queued" && !positions.has(task.id)) {
      positions.set(task.id, (next += 1));
    }
  }
  return positions;
}
