"use client";

import { useEffect, useState } from "react";
import { Check, Loader, X } from "lucide-react";
import type { Activity as ActivityRecord } from "@/server/activities";

/**
 * 来源管线的阶段条 + 步骤列表（decision-input-ops I2）。
 * 数据来自 activities 中 kind='source' 的步骤，由 runner 状态流转写入；
 * 转写分段时步骤 message 会更新（如「转写 3/5 段」），5s 轮询足够可见。
 */
const PHASES: Array<{ key: "download" | "subtitles" | "asr" | "frames"; label: string }> = [
  { key: "download", label: "下载" },
  { key: "subtitles", label: "字幕" },
  { key: "asr", label: "转写" },
  { key: "frames", label: "抽帧" },
];

type PhaseState = "pending" | "running" | "done" | "failed";

function phaseState(steps: ActivityRecord[], key: string): PhaseState {
  const list = steps.filter((s) => s.phase === key);
  const last = list[list.length - 1];
  if (!last) return "pending";
  if (last.endedAt === null) return "running";
  return last.ok ? "done" : "failed";
}

function duration(a: ActivityRecord): string {
  const start = new Date(a.startedAt).getTime();
  const end = a.endedAt ? new Date(a.endedAt).getTime() : Date.now();
  const sec = Math.max(0, Math.round((end - start) / 1000));
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, "0")}s`;
}

const SEGMENT_CLASS: Record<PhaseState, string> = {
  done: "bg-gold",
  running: "bg-gold/60 animate-pulse",
  failed: "bg-danger/70",
  pending: "bg-tint/10",
};

export function SourceProgress({
  taskId,
  showDownload,
}: {
  taskId: string;
  showDownload: boolean;
}) {
  const [steps, setSteps] = useState<ActivityRecord[]>([]);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(`/api/tasks/${taskId}/activities`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data: { activities?: ActivityRecord[] } | null) => {
          if (alive && data?.activities) {
            setSteps(data.activities.filter((a) => a.kind === "source"));
          }
        })
        .catch(() => {});
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [taskId]);

  const phases = showDownload ? PHASES : PHASES.filter((p) => p.key !== "download");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex gap-1.5">
        {phases.map((p) => {
          const state = phaseState(steps, p.key);
          return (
            <div key={p.key} className="flex-1">
              <div className={`h-1.5 rounded-full ${SEGMENT_CLASS[state]}`} />
              <p
                className={`mt-1.5 text-center font-mono text-[10px] tracking-widest ${
                  state === "pending" ? "text-paper-faint/60" : "text-paper-dim"
                }`}
              >
                {p.label}
              </p>
            </div>
          );
        })}
      </div>

      {steps.length > 0 ? (
        <ol className="flex flex-col gap-3 border-t border-tint/5 pt-4">
          {steps.map((s) => (
            <li key={s.id} className="flex items-start gap-2.5">
              <span className="mt-0.5 shrink-0">
                {s.endedAt === null ? (
                  <Loader className="size-3.5 animate-spin text-gold" strokeWidth={1.5} />
                ) : s.ok ? (
                  <Check className="size-3.5 text-positive/90" strokeWidth={1.5} />
                ) : (
                  <X className="size-3.5 text-danger/90" strokeWidth={1.5} />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-3">
                  <p
                    className={`text-sm ${
                      s.endedAt === null ? "text-paper" : "text-paper-dim"
                    }`}
                  >
                    {s.title ?? s.stage ?? s.kind}
                  </p>
                  <span className="shrink-0 font-mono text-[10px] text-paper-faint">
                    {duration(s)}
                  </span>
                </div>
                {s.message ? (
                  <p className="mt-0.5 break-words text-xs leading-relaxed text-paper-faint">
                    {s.message}
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
