"use client";

import { useEffect, useState } from "react";
import { Check, ChevronDown, Loader, X } from "lucide-react";
import type { Activity } from "@/server/activities";

/**
 * 生成过程内嵌（对齐 vid-lens RunView 的「阅读路线 + 现场记录」）：
 * - 阅读路线：当次执行的步骤序列（提纲 → N 章预插入 → 核对 → 发布），实时点亮；
 * - 现场记录：按时间排列的活动，默认只显示最近几条，可展开全部。
 * 数据全部来自 /activities（07 号票章节级步骤），生成后台化后刷新也能续上（08 号票）。
 */

const KIND_LABEL: Record<Activity["kind"], string> = {
  model: "模型调用",
  stage: "阶段",
  section: "章节",
  qa: "问答",
  source: "来源",
  verify: "核对",
  review: "审稿",
};

const PHASE_LABEL: Record<string, string> = {
  outline: "提纲",
  write: "撰写",
  validate: "核对",
  publish: "发布",
  qa: "问答",
};

function StepIcon({ status }: { status: string | null }) {
  if (status === "running")
    return <Loader className="size-3 animate-spin text-gold" strokeWidth={2} />;
  if (status === "completed")
    return <Check className="size-3 text-positive/90" strokeWidth={2.5} />;
  if (status === "failed" || status === "canceled")
    return <X className="size-3 text-danger/90" strokeWidth={2.5} />;
  return <span className="size-1.5 rounded-full bg-tint/25" aria-hidden />;
}

function duration(a: Activity): string {
  const start = new Date(a.startedAt).getTime();
  const end = a.endedAt ? new Date(a.endedAt).getTime() : Date.now();
  const sec = Math.max(0, Math.round((end - start) / 1000));
  if (sec < 60) return sec + "s";
  return Math.floor(sec / 60) + "m" + String(sec % 60).padStart(2, "0") + "s";
}

function stepColor(a: Activity): string {
  if (a.status === "running") return "text-gold";
  if (a.status === "queued") return "text-paper-faint";
  return "text-paper-dim";
}

function dotColor(a: Activity): string {
  if (a.status === "running") return "bg-gold";
  if (a.status === "completed") return "bg-positive/70";
  if (a.status === "failed" || a.status === "canceled") return "bg-danger/70";
  return "bg-tint/25";
}

export function RunProgress({
  taskId,
  live,
  recent = 6,
}: {
  taskId: string;
  /** true = 生成进行中，持续轮询；false = 只拉一次用于回看 */
  live: boolean;
  recent?: number;
}) {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [runDone, setRunDone] = useState(0);
  const [runTotal, setRunTotal] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/tasks/" + taskId + "/activities")
        .then((r) => (r.ok ? r.json() : null))
        .then(
          (
            data: {
              activities?: Activity[];
              currentRun?: { done: number; total: number } | null;
            } | null,
          ) => {
            if (!alive || !data?.activities) return;
            setActivities(data.activities);
            if (data.currentRun) {
              setRunDone(data.currentRun.done);
              setRunTotal(data.currentRun.total);
            }
            setLoaded(true);
          },
        );
    void load();
    if (!live) {
      return () => {
        alive = false;
      };
    }
    const timer = setInterval(() => void load(), 2500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [taskId, live]);

  // 当次执行 = 最新一个带 runId 的活动所属 run；老数据没有 runId 时退化为全部记录。
  // 手动 useMemo 会被 React Compiler 拒绝优化，这里直接派生即可。
  let currentRunId: string | null = null;
  for (let i = activities.length - 1; i >= 0; i--) {
    if (activities[i].runId) {
      currentRunId = activities[i].runId;
      break;
    }
  }
  const routeSteps = currentRunId
    ? activities.filter((a) => a.runId === currentRunId && a.kind !== "model")
    : activities.filter((a) => a.kind !== "model");
  /** 现场记录：当次 run 的计划步骤之外的一切（模型调用、更早 run、老记录） */
  const journal = currentRunId
    ? activities.filter((a) => a.kind === "model" || a.runId !== currentRunId)
    : activities;

  if (!loaded || activities.length === 0) return null;

  const anyRunning = activities.some((a) => a.status === "running");
  const shown = expanded ? journal : journal.slice(-recent);
  const hiddenCount = journal.length - shown.length;

  return (
    <div className="glass min-h-0 flex-1 overflow-auto rounded-2xl p-5">
      {/* 阅读路线 */}
      <p className="flex items-center gap-2 font-mono text-[10px] tracking-widest text-paper-faint">
        阅读路线
        {runTotal > 0 ? " · 已完成 " + runDone + "/" + runTotal + " 章" : ""}
        {live ? (
          <span className="flex items-center gap-1 text-gold/80" aria-hidden>
            <i className="size-1 animate-pulse rounded-full bg-gold" />
            <i className="size-1 animate-pulse rounded-full bg-gold [animation-delay:150ms]" />
            <i className="size-1 animate-pulse rounded-full bg-gold [animation-delay:300ms]" />
          </span>
        ) : null}
      </p>
      {live ? (
        <p className="mt-0.5 font-mono text-[10px] text-paper-faint/80">
          生成在后台继续，离开页面不会中断。
        </p>
      ) : null}
      <ol className="mt-3 space-y-0.5 border-l border-tint/10 pl-4">
        {routeSteps.map((step) => (
          <li key={step.id} className="relative flex items-baseline justify-between gap-3 py-1.5">
            <span
              className={
                "absolute -left-[22px] top-[15px] flex size-3.5 items-center justify-center rounded-full bg-ink-950 border " +
                (step.status === "running" ? "border-gold/50" : "border-tint/15")
              }
              aria-hidden
            >
              <StepIcon status={step.status} />
            </span>
            <p className={"min-w-0 truncate text-xs " + stepColor(step)}>
              {step.title ?? KIND_LABEL[step.kind]}
              {step.attemptNo > 1 ? "（第 " + step.attemptNo + " 次）" : ""}
            </p>
            <span className="shrink-0 font-mono text-[10px] text-paper-faint/70">
              {step.phase ? PHASE_LABEL[step.phase] ?? step.phase : ""}
              {step.message ? " · " + step.message : ""}
              {step.endedAt || step.status === "running" ? " · " + duration(step) : ""}
            </span>
          </li>
        ))}
      </ol>

      {/* 现场记录 */}
      {journal.length > 0 ? (
        <div className="mt-5 border-t border-tint/5 pt-4">
          <div className="flex items-center justify-between">
            <p className="font-mono text-[10px] tracking-widest text-paper-faint">
              现场记录{anyRunning ? " · 进行中" : ""}
            </p>
            {journal.length > recent ? (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="inline-flex items-center gap-1 font-mono text-[10px] text-paper-faint transition-colors hover:text-gold"
                aria-expanded={expanded}
              >
                <ChevronDown
                  className={"size-3 transition-transform " + (expanded ? "rotate-180" : "")}
                  strokeWidth={1.5}
                />
                {expanded ? "收起" : "查看全部（" + journal.length + "）"}
              </button>
            ) : null}
          </div>
          <ol className="mt-2 space-y-1">
            {shown.map((a) => (
              <li key={a.id} className="flex items-baseline justify-between gap-3 py-1">
                <p className="min-w-0 truncate text-[11px] text-paper-faint">
                  <span
                    className={"mr-1.5 inline-block size-1.5 -translate-y-px rounded-full align-middle " + dotColor(a)}
                    aria-hidden
                  />
                  {a.title ?? a.message ?? KIND_LABEL[a.kind]}
                </p>
                <span className="shrink-0 font-mono text-[10px] text-paper-faint/60">
                  {new Date(a.startedAt).toLocaleTimeString("zh-CN", {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                  {" · "}
                  {duration(a)}
                </span>
              </li>
            ))}
          </ol>
          {hiddenCount > 0 && !expanded ? (
            <p className="mt-1 font-mono text-[10px] text-paper-faint/60">
              更早的 {hiddenCount} 条已收起
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
