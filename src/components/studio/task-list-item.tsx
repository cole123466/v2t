"use client";

import Link from "next/link";
import { Check, Link2, Trash2 } from "lucide-react";
import type { Task } from "@/server/tasks";
import { isProcessing } from "@/lib/task-status";
import { fmtSize, STATUS_META, timeAgo } from "@/lib/task-display";

/** 任务列表单项：状态、来源、排队位次与删除（处理中的任务不可删除） */
export function TaskListItem({
  task,
  queuePosition,
  confirming,
  onRemove,
}: {
  task: Task;
  queuePosition?: number;
  confirming: boolean;
  onRemove: () => void;
}) {
  const meta = STATUS_META[task.status];
  const processing = isProcessing(task.status);

  return (
    <li className="flex items-center gap-2">
      <Link
        href={`/task/${task.id}`}
        className="group flex min-w-0 flex-1 items-center gap-4 py-4 transition-colors hover:bg-tint/[0.02]"
      >
        <span className={`size-1.5 shrink-0 rounded-full ${meta.dot}`} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-paper group-hover:text-gold">
            {task.sourceKind === "link" ? (
              <Link2 className="mr-1.5 inline size-3 text-paper-faint" strokeWidth={1.5} />
            ) : null}
            {task.originalName}
            {task.mediaPurgedAt ? (
              <span className="ml-2 font-mono text-[10px] tracking-wider text-paper-faint">
                媒体已清理
              </span>
            ) : null}
          </p>
          <p className="mt-0.5 font-mono text-[11px] text-paper-faint">
            {task.sizeBytes > 0 ? `${fmtSize(task.sizeBytes)} · ` : ""}
            {task.sourceKind === "link" && task.status === "downloading"
              ? `下载 ${task.downloadPct ?? 0}% · `
              : ""}
            {timeAgo(task.createdAt)}
            {task.transcriptOrigin === "subtitle" ? " · 平台字幕" : ""}
            {task.transcriptOrigin === "asr" ? " · ASR" : ""}
          </p>
        </div>
        <span className={`shrink-0 font-mono text-[11px] tracking-wider ${meta.cls}`}>
          {task.status === "ready" ? (
            <Check className="mr-1 inline size-3.5" strokeWidth={1.5} />
          ) : null}
          {task.status === "queued" && queuePosition ? `排队中（第 ${queuePosition} 位）` : meta.label}
        </span>
      </Link>
      <button
        type="button"
        onClick={onRemove}
        disabled={processing}
        title={processing ? "任务处理中，无法删除" : "删除任务"}
        className={`flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 font-mono text-[10px] transition-colors disabled:opacity-30 ${
          confirming
            ? "border-danger/50 text-danger"
            : "border-transparent text-paper-faint hover:border-tint/15 hover:text-paper"
        }`}
      >
        {confirming ? "确认删除" : <Trash2 className="size-3.5" strokeWidth={1.5} />}
      </button>
    </li>
  );
}
