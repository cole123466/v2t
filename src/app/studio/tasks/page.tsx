"use client";

import Link from "next/link";
import { X } from "lucide-react";
import { TaskListItem } from "@/components/studio/task-list-item";
import { useTasks } from "@/hooks/use-tasks";
import { fmtSize, queuedPositions } from "@/lib/task-display";

export default function StudioTasksPage() {
  const { tasks, stats, queue, confirmDelete, error, removeTask } = useTasks();
  const positions = queuedPositions(tasks, queue);

  return (
    <section>
      <div className="flex items-center justify-between gap-4">
        <h2 className="font-mono text-[11px] tracking-widest text-paper-faint">任务 / TASKS</h2>
        {stats ? (
          <p className="font-mono text-[11px] tracking-wider text-paper-faint">
            {stats.taskCount} 任务 · 媒体 {fmtSize(stats.mediaBytes)} · 共 {fmtSize(stats.totalBytes)}
          </p>
        ) : null}
      </div>

      {error ? (
        <div className="mt-5 flex items-center gap-3 rounded-2xl border border-danger/30 bg-danger/10 px-5 py-3 text-sm text-danger/90">
          <X className="size-4 shrink-0" strokeWidth={1.5} />
          {error}
        </div>
      ) : null}

      {tasks.length === 0 ? (
        <p className="mt-6 text-sm text-paper-faint">
          还没有任务——
          <Link href="/studio" className="text-paper-dim transition-colors hover:text-gold">
            去导入一个视频
          </Link>
          。
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-tint/5">
          {tasks.map((task) => (
            <TaskListItem
              key={task.id}
              task={task}
              queuePosition={positions.get(task.id)}
              confirming={confirmDelete === task.id}
              onRemove={() => void removeTask(task.id)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
