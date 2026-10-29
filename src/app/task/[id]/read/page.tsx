"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Activity, ArrowLeft, Loader, X } from "lucide-react";
import type { Task } from "@/server/tasks";
import { ArticlePanel } from "@/components/workbench/article-panel";
import { ProcessPanel } from "@/components/workbench/process-panel";
import { SourceNotice } from "@/components/workbench/source-notice";
import { ThemeToggle } from "@/components/theme-toggle";
import { PetToggle } from "@/components/pet/pet-toggle";

/**
 * 阅读视图（票 B，vid-lens ReadView 对齐）：图文为主体，过程收进抽屉。
 * 工作台（播放器/文稿/问答/文案）在 /task/[id]；就绪后默认落在本页。
 * 时间出处点击经 onSeekOverride 跳回工作台定位，不在阅读页静音跳秒。
 */
export default function TaskReadPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [task, setTask] = useState<Task | null>(null);
  const [missing, setMissing] = useState(false);
  const [processOpen, setProcessOpen] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    void fetch("/api/tasks/" + id)
      .then((r) => (r.ok ? r.json() : null))
      .then((t) => (t ? setTask(t) : setMissing(true)))
      .catch(() => setMissing(true));
    const es = new EventSource("/api/tasks/" + id + "/events");
    es.onmessage = (e) => setTask(JSON.parse(e.data) as Task);
    return () => es.close();
  }, [id]);

  // 任务未就绪（或被清理/取消）时阅读页没有内容，回工作台视图看进度
  useEffect(() => {
    if (task && task.status !== "ready") router.replace("/task/" + id);
  }, [task, id, router]);

  if (missing) {
    return (
      <main className="flex min-h-svh flex-col items-center justify-center gap-6 px-6 text-center">
        <X className="size-10 text-danger/80" strokeWidth={1.5} />
        <h1 className="font-display text-3xl font-semibold">任务不存在</h1>
        <Link href="/studio/tasks" className="font-mono text-xs tracking-widest text-paper-faint hover:text-gold">
          返回任务列表
        </Link>
      </main>
    );
  }

  if (!task || task.status !== "ready") {
    return (
      <main className="flex min-h-svh items-center justify-center">
        <Loader className="size-6 animate-spin text-paper-faint" strokeWidth={1.5} />
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-4xl px-6 pb-10">
      <header className="flex flex-wrap items-center justify-between gap-4 py-6">
        <div className="min-w-0">
          <h1 className="truncate font-display text-2xl font-semibold">{task.originalName}</h1>
          <p className="mt-1 font-mono text-[11px] tracking-widest text-paper-faint">READ</p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {/* 视图切换：阅读（本页）| 工作台 */}
          <nav className="flex gap-1 rounded-2xl border border-tint/10 p-1">
            <span
              aria-current="page"
              className="rounded-xl bg-gold/10 px-3 py-1.5 font-mono text-[10px] tracking-wider text-gold"
            >
              阅读
            </span>
            <Link
              href={"/task/" + id + "?view=workbench"}
              className="rounded-xl px-3 py-1.5 font-mono text-[10px] tracking-wider text-paper-faint transition-colors hover:text-paper-dim"
            >
              工作台
            </Link>
          </nav>
          <button
            type="button"
            onClick={() => setProcessOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-xl border border-tint/10 px-3 py-1.5 font-mono text-[10px] tracking-wider text-paper-faint transition-colors hover:border-gold/40 hover:text-gold"
          >
            <Activity className="size-3" strokeWidth={1.5} />
            生成过程
          </button>
          <PetToggle />
          <ThemeToggle />
          <Link
            href="/studio/tasks"
            className="inline-flex shrink-0 items-center gap-2 font-mono text-xs tracking-widest text-paper-faint transition-colors hover:text-gold"
          >
            <ArrowLeft className="size-3.5" strokeWidth={1.5} />
            任务列表
          </Link>
        </div>
      </header>

      <SourceNotice text={task.sourceNotice} />

      <div className="h-[calc(100svh-190px)] min-h-[480px]">
        <ArticlePanel
          taskId={id}
          videoRef={videoRef}
          readerMode
          defaultDetail={task.detailLevel}
          defaultPurpose={task.purpose}
          onSeekOverride={(t) => router.push("/task/" + id + "?view=workbench&t=" + encodeURIComponent(String(t)))}
        />
      </div>

      {/* 生成过程抽屉：阅读页保持干净，过程按需展开 */}
      {processOpen ? (
        <div className="fixed inset-0 z-50 flex justify-end bg-ink-950/60" role="dialog" aria-label="生成过程">
          <button
            type="button"
            aria-label="关闭生成过程"
            className="min-w-0 flex-1 cursor-default"
            onClick={() => setProcessOpen(false)}
          />
          <div className="flex h-full w-full max-w-md flex-col border-l border-tint/10 bg-ink-950 p-4">
            <div className="flex items-center justify-between pb-3">
              <p className="font-mono text-[10px] tracking-widest text-paper-faint">生成信息与过程</p>
              <button
                type="button"
                onClick={() => setProcessOpen(false)}
                className="rounded-lg border border-tint/10 p-1.5 text-paper-faint transition-colors hover:text-gold"
                aria-label="关闭"
              >
                <X className="size-3.5" strokeWidth={1.5} />
              </button>
            </div>
            <ProcessPanel taskId={id} />
          </div>
        </div>
      ) : null}
    </main>
  );
}
