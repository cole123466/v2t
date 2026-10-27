"use client";

import Link from "next/link";
import { ListOrdered } from "lucide-react";
import type { QueueSnapshot } from "@/server/runner";
import { STATUS_LABEL } from "@/lib/task-status";

/** 处理队列面板：串行管线同一时刻只处理 1 个，其余按入队顺序展示 */
export function QueuePanel({ queue }: { queue: QueueSnapshot | null }) {
  if (!queue) return null;
  const active = queue.active[0] ?? null;
  const queued = queue.queued;
  const full = queued.length >= queue.queuedLimit;

  return (
    <section className="glass mt-5 rounded-2xl px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 font-mono text-[10px] tracking-widest text-paper-faint">
          <ListOrdered className="size-3.5" strokeWidth={1.5} />
          处理队列 / QUEUE
        </p>
        <p className="font-mono text-[10px] tracking-wider text-paper-faint">
          {active ? "1 处理中" : "空闲"} · 排队{" "}
          <span className={full ? "text-danger" : "text-paper-dim"}>
            {queued.length}/{queue.queuedLimit}
          </span>
          {full ? " · 已满" : ""}
        </p>
      </div>

      {active === null && queued.length === 0 ? (
        <p className="mt-3 text-xs text-paper-faint">队列空闲——上传或粘贴链接后会在这里排队。</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {active ? (
            <li className="flex items-center gap-3">
              <span className="shrink-0 rounded-full border border-gold/40 bg-gold/10 px-2 py-0.5 font-mono text-[10px] tracking-wider text-gold">
                处理中
              </span>
              <Link
                href={`/task/${active.id}`}
                className="min-w-0 flex-1 truncate text-sm text-paper hover:text-gold"
              >
                {active.originalName}
              </Link>
              <span className="shrink-0 font-mono text-[10px] text-paper-faint">
                {STATUS_LABEL[active.status]} {active.progress}%
              </span>
            </li>
          ) : null}
          {queued.map((task, i) => (
            <li key={task.id} className="flex items-center gap-3">
              <span className="shrink-0 rounded-full border border-tint/10 px-2 py-0.5 font-mono text-[10px] tracking-wider text-paper-faint">
                第 {i + 1} 位
              </span>
              <Link
                href={`/task/${task.id}`}
                className="min-w-0 flex-1 truncate text-sm text-paper-dim hover:text-gold"
              >
                {task.originalName}
              </Link>
              <span className="shrink-0 font-mono text-[10px] text-paper-faint">
                {task.sourceKind === "link" ? "链接导入" : "本地上传"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
