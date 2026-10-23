"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Check, Link2, ListOrdered, Loader, Trash2, Upload, X } from "lucide-react";
import type { Task, TaskStatus } from "@/server/tasks";
import type { StorageStats } from "@/server/maintenance";
import type { QueueSnapshot } from "@/server/runner";
import { isProcessing, STATUS_LABEL } from "@/lib/task-status";
import { ThemeToggle } from "@/components/theme-toggle";
import { PetToggle } from "@/components/pet/pet-toggle";
import { petFlow } from "@/components/pet/pet-flow";

const STATUS_META: Record<TaskStatus, { label: string; cls: string; dot: string }> = {
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
};

function timeAgo(iso: string) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return new Date(iso).toLocaleDateString("zh-CN");
}

function fmtSize(n: number) {
  if (n > 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n > 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** 处理队列面板：串行管线同一时刻只处理 1 个，其余按入队顺序展示 */
function QueuePanel({ queue }: { queue: QueueSnapshot | null }) {
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

/** 任务列表、存储占用与处理队列总是一起刷新，抽成一次请求组合供首屏轮询与手动刷新复用 */
async function fetchDashboard(): Promise<{
  tasks: Task[] | null;
  stats: StorageStats | null;
  queue: QueueSnapshot | null;
}> {
  const tasksRes = await fetch("/api/tasks");
  const tasks = tasksRes.ok ? ((await tasksRes.json()) as { tasks: Task[] }).tasks : null;
  const storageRes = await fetch("/api/storage");
  const stats = storageRes.ok ? ((await storageRes.json()) as StorageStats) : null;
  const queueRes = await fetch("/api/queue");
  const queue = queueRes.ok ? ((await queueRes.json()) as QueueSnapshot) : null;
  return { tasks, stats, queue };
}

export default function StudioPage() {
  const router = useRouter();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [queue, setQueue] = useState<QueueSnapshot | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState<{ name: string; pct: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkMeta, setLinkMeta] = useState<{ title: string; durationSec: number | null } | null>(
    null,
  );
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const { tasks, stats, queue } = await fetchDashboard();
    if (tasks) setTasks(tasks);
    if (stats) setStats(stats);
    if (queue) setQueue(queue);
  }, []);

  const removeTask = useCallback(
    async (id: string) => {
      if (confirmDelete !== id) {
        setConfirmDelete(id);
        setTimeout(() => setConfirmDelete((cur) => (cur === id ? null : cur)), 3000);
        return;
      }
      setConfirmDelete(null);
      const res = await fetch(`/api/tasks/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(detail?.error ?? "删除失败");
      }
      await refresh();
    },
    [confirmDelete, refresh],
  );

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const { tasks, stats, queue } = await fetchDashboard();
      if (cancelled) return;
      if (tasks) setTasks(tasks);
      if (stats) setStats(stats);
      if (queue) setQueue(queue);
    };
    void tick();
    const timer = setInterval(() => void tick(), 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const probeLink = useCallback(async () => {
    const url = linkUrl.trim();
    if (!url || linkBusy) return;
    setError(null);
    setLinkMeta(null);
    setLinkBusy(true);
    try {
      const res = await fetch(`/api/source/probe?url=${encodeURIComponent(url)}`);
      const data = (await res.json().catch(() => null)) as
        | { meta?: { title: string; durationSec: number | null }; error?: string }
        | null;
      if (!res.ok || !data?.meta) {
        setError(data?.error ?? `链接解析失败（${res.status}）`);
        return;
      }
      setLinkMeta(data.meta);
    } finally {
      setLinkBusy(false);
    }
  }, [linkUrl, linkBusy]);

  const startLinkTask = useCallback(async () => {
    const url = linkUrl.trim();
    if (!url || linkBusy) return;
    setError(null);
    setLinkBusy(true);
    petFlow.importStart();
    try {
      const res = await fetch("/api/tasks/link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = (await res.json().catch(() => null)) as
        | (Task & { error?: string })
        | null;
      if (!res.ok || !data || data.error) {
        setError(data?.error ?? `创建失败（${res.status}）`);
        petFlow.importFailed();
        return;
      }
      petFlow.importDone();
      router.push(`/task/${data.id}`);
    } finally {
      setLinkBusy(false);
    }
  }, [linkUrl, linkBusy, router]);

  const startUpload = useCallback(
    (file: File) => {
      if (uploading) return;
      setError(null);
      setUploading({ name: file.name, pct: 0 });
      petFlow.importStart();
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/tasks?name=${encodeURIComponent(file.name)}`);
      xhr.setRequestHeader("content-type", "application/octet-stream");
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          setUploading({ name: file.name, pct: Math.round((e.loaded / e.total) * 100) });
        }
      };
      xhr.onload = () => {
        if (xhr.status === 201) {
          const task = JSON.parse(xhr.responseText) as Task;
          petFlow.importDone();
          router.push(`/task/${task.id}`);
        } else {
          try {
            setError((JSON.parse(xhr.responseText) as { error: string }).error);
          } catch {
            setError(`上传失败（${xhr.status}）`);
          }
          petFlow.importFailed();
          setUploading(null);
        }
      };
      xhr.onerror = () => {
        setError("网络中断，上传失败");
        petFlow.importFailed();
        setUploading(null);
      };
      xhr.send(file);
    },
    [router, uploading],
  );

  useEffect(() => {
    const onDragEnter = (e: DragEvent) => {
      e.preventDefault();
      dragDepth.current += 1;
      setDragging(true);
    };
    const onDragOver = (e: DragEvent) => e.preventDefault();
    const onDragLeave = () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      const file = e.dataTransfer?.files?.[0];
      if (file) startUpload(file);
    };
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [startUpload]);

  return (
    <main className="mx-auto flex min-h-svh w-full max-w-5xl flex-col px-6 pb-16">
      <header className="flex items-center justify-between py-6">
        <div>
          <h1 className="font-display text-3xl font-semibold">工作台</h1>
          <p className="mt-1 font-mono text-[11px] tracking-widest text-paper-faint">
            UPLOAD / EXTRACT / TRANSCRIBE
          </p>
        </div>
        <div className="flex items-center gap-4">
          <PetToggle />
          <ThemeToggle />
          <Link
            href="/"
            className="inline-flex items-center gap-2 font-mono text-xs tracking-widest text-paper-faint transition-colors hover:text-gold"
          >
            <ArrowLeft className="size-3.5" strokeWidth={1.5} />
            V2T
          </Link>
        </div>
      </header>

      <div className="grid gap-5 md:grid-cols-[1fr_260px]">
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          disabled={uploading !== null}
          className="glass group flex min-h-64 flex-col items-center justify-center gap-4 rounded-3xl border-dashed p-10 transition-all hover:border-gold/50 hover:bg-gold/5 disabled:opacity-60"
        >
          {uploading ? (
            <>
              <Loader className="size-9 animate-spin text-gold" strokeWidth={1.5} />
              <div className="text-center">
                <p className="max-w-sm truncate text-sm text-paper">{uploading.name}</p>
                <div className="mx-auto mt-4 h-1 w-64 overflow-hidden rounded-full bg-tint/10">
                  <div
                    className="h-full rounded-full bg-gold transition-all"
                    style={{ width: `${uploading.pct}%` }}
                  />
                </div>
                <p className="mt-2 font-mono text-xs text-paper-faint">{uploading.pct}%</p>
              </div>
            </>
          ) : (
            <>
              <Upload className="size-9 text-paper-faint transition-colors group-hover:text-gold" strokeWidth={1.5} />
              <div className="text-center">
                <p className="text-sm text-paper">拖入视频或音频文件</p>
                <p className="mt-1 text-xs text-paper-faint">或点击选择 · 最大 2GB · mp4 / mov / mkv / webm / mp3 …</p>
              </div>
            </>
          )}
          <input
            ref={fileInput}
            type="file"
            accept="video/*,audio/*,.mkv"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) startUpload(file);
              e.target.value = "";
            }}
          />
        </button>

        <div className="glass flex flex-col gap-3 rounded-3xl p-6">
          <Link2 className="size-5 text-gold" strokeWidth={1.5} />
          <p className="text-sm text-paper">链接导入</p>
          <p className="text-xs leading-relaxed text-paper-faint">
            粘贴 B 站或 YouTube 视频链接，免登录下载后自动转写。
          </p>
          <div className="mt-1 flex flex-col gap-2">
            <input
              value={linkUrl}
              onChange={(e) => {
                setLinkUrl(e.target.value);
                setLinkMeta(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void probeLink();
              }}
              placeholder="https://www.bilibili.com/video/BV..."
              className="w-full rounded-xl border border-tint/10 bg-ink-950/60 px-3 py-2 font-mono text-xs text-paper outline-none transition-colors placeholder:text-paper-faint focus:border-gold/50"
            />
            {linkMeta ? (
              <div className="rounded-xl border border-tint/5 bg-tint/[0.03] px-3 py-2">
                <p className="line-clamp-2 text-xs text-paper-dim">{linkMeta.title}</p>
                {linkMeta.durationSec !== null ? (
                  <p className="mt-1 font-mono text-[10px] text-paper-faint">
                    {Math.floor(linkMeta.durationSec / 60)} 分{" "}
                    {Math.round(linkMeta.durationSec % 60)} 秒
                  </p>
                ) : null}
              </div>
            ) : null}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void probeLink()}
                disabled={linkBusy || !linkUrl.trim()}
                className="flex-1 rounded-xl border border-tint/10 px-3 py-2 font-mono text-[11px] tracking-wider text-paper-dim transition-colors hover:border-gold/40 hover:text-gold disabled:opacity-40"
              >
                {linkBusy ? "解析中" : "解析"}
              </button>
              <button
                type="button"
                onClick={() => void startLinkTask()}
                disabled={linkBusy || !linkUrl.trim()}
                className="flex-1 rounded-xl border border-gold/40 bg-gold/10 px-3 py-2 font-mono text-[11px] tracking-wider text-gold transition-colors hover:bg-gold/20 disabled:opacity-40"
              >
                开始导入
              </button>
            </div>
          </div>
        </div>
      </div>

      {error ? (
        <div className="mt-5 flex items-center gap-3 rounded-2xl border border-danger/30 bg-danger/10 px-5 py-3 text-sm text-danger/90">
          <X className="size-4 shrink-0" strokeWidth={1.5} />
          {error}
        </div>
      ) : null}

      <QueuePanel queue={queue} />

      <section className="mt-12">
        <div className="flex items-center justify-between gap-4">
          <h2 className="font-mono text-[11px] tracking-widest text-paper-faint">任务 / TASKS</h2>
          {stats ? (
            <p className="font-mono text-[11px] tracking-wider text-paper-faint">
              {stats.taskCount} 任务 · 媒体 {fmtSize(stats.mediaBytes)} · 共 {fmtSize(stats.totalBytes)}
            </p>
          ) : null}
        </div>
        {tasks.length === 0 ? (
          <p className="mt-6 text-sm text-paper-faint">还没有任务——从上传一个视频开始。</p>
        ) : (
          <ul className="mt-4 divide-y divide-tint/5">
            {tasks.map((task) => {
              const meta = STATUS_META[task.status];
              const processing = isProcessing(task.status);
              return (
                <li key={task.id} className="flex items-center gap-2">
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
                      {meta.label}
                    </span>
                  </Link>
                  <button
                    type="button"
                    onClick={() => void removeTask(task.id)}
                    disabled={processing}
                    title={processing ? "任务处理中，无法删除" : "删除任务"}
                    className={`flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 font-mono text-[10px] transition-colors disabled:opacity-30 ${
                      confirmDelete === task.id
                        ? "border-danger/50 text-danger"
                        : "border-transparent text-paper-faint hover:border-tint/15 hover:text-paper"
                    }`}
                  >
                    {confirmDelete === task.id ? (
                      "确认删除"
                    ) : (
                      <Trash2 className="size-3.5" strokeWidth={1.5} />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {dragging ? (
        <div className="pointer-events-none fixed inset-4 z-50 flex items-center justify-center rounded-3xl border-2 border-dashed border-gold/60 bg-ink-950/80 backdrop-blur-sm">
          <p className="font-display text-4xl font-semibold text-gold">松手开始上传</p>
        </div>
      ) : null}
    </main>
  );
}
