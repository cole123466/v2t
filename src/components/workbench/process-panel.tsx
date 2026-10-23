"use client";

import { useEffect, useState } from "react";
import { Activity, Check, Loader, X } from "lucide-react";
import type { Activity as ActivityRecord } from "@/server/activities";

const STAGE_LABEL: Record<string, string> = {
  article: "图文文章生成",
  qa: "证据问答",
};

function duration(a: ActivityRecord): string {
  const start = new Date(a.startedAt).getTime();
  const end = a.endedAt ? new Date(a.endedAt).getTime() : Date.now();
  const sec = Math.max(0, Math.round((end - start) / 1000));
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, "0")}s`;
}

export function ProcessPanel({ taskId }: { taskId: string }) {
  const [activities, setActivities] = useState<ActivityRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(`/api/tasks/${taskId}/activities`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data: { activities?: ActivityRecord[] } | null) => {
          if (alive && data?.activities) setActivities(data.activities);
        })
        .finally(() => alive && setLoading(false));
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [taskId]);

  const running = activities.filter((a) => a.endedAt === null).length;

  return (
    <div className="glass flex min-h-0 flex-1 flex-col rounded-2xl">
      <div className="flex shrink-0 items-center justify-between border-b border-tint/5 px-5 py-3">
        <p className="flex items-center gap-2 font-mono text-[10px] tracking-widest text-paper-faint">
          <Activity className="size-3.5" strokeWidth={1.5} />
          处理过程
        </p>
        <span className="font-mono text-[10px] text-paper-faint">
          {activities.length} 次调用{running > 0 ? ` · ${running} 进行中` : ""}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <Loader className="size-5 animate-spin text-paper-faint" strokeWidth={1.5} />
          </div>
        ) : activities.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <Activity className="size-7 text-paper-faint" strokeWidth={1.5} />
            <p className="text-sm text-paper-dim">还没有过程记录</p>
            <p className="max-w-[260px] text-xs leading-relaxed text-paper-faint">
              生成图文文章或发起问答后，这里会按时间列出每次模型调用及其结果，完成后仍可回看。
            </p>
          </div>
        ) : (
          <ol className="relative space-y-0.5 border-l border-tint/10 pl-4">
            {activities.map((a) => (
              <li key={a.id} className="relative py-2.5">
                <span
                  className={`absolute -left-[21px] top-3.5 flex size-3 items-center justify-center rounded-full border ${
                    a.endedAt === null
                      ? "border-gold/50 bg-ink-950"
                      : a.ok
                        ? "border-positive/50 bg-ink-950"
                        : "border-danger/50 bg-ink-950"
                  }`}
                >
                  {a.endedAt === null ? (
                    <Loader className="size-1.5 animate-spin text-gold" strokeWidth={2} />
                  ) : a.ok ? (
                    <Check className="size-2 text-positive/90" strokeWidth={2.5} />
                  ) : (
                    <X className="size-2 text-danger/90" strokeWidth={2.5} />
                  )}
                </span>
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-xs text-paper-dim">
                    {STAGE_LABEL[a.stage ?? ""] ?? a.stage ?? a.kind}
                  </p>
                  <span className="shrink-0 font-mono text-[10px] text-paper-faint">
                    {duration(a)}
                  </span>
                </div>
                {a.message ? (
                  <p className="mt-1 break-words text-[11px] leading-relaxed text-paper-faint">
                    {a.message}
                  </p>
                ) : null}
                <p className="mt-1 font-mono text-[9px] tracking-wider text-paper-faint/70">
                  {new Date(a.startedAt).toLocaleTimeString("zh-CN")}
                </p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
