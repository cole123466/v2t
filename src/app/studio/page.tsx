"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Link2, ListOrdered, Loader, SlidersHorizontal, Upload, X } from "lucide-react";
import type { Task } from "@/server/tasks";
import type { TaskDetailLevel } from "@/server/tasks";
import { DETAIL_OPTIONS } from "@/lib/article-options";
import {
  addUploads,
  createUploadId,
  removeUpload,
  setUploadProgress,
  startNext,
  uploadSummary,
  type UploadItem,
} from "@/lib/upload-queue";
import { QueuePanel } from "@/components/studio/queue-panel";
import { useQueueSnapshot } from "@/hooks/use-tasks";
import { petFlow } from "@/components/pet/pet-flow";

/** 导入页：拖拽上传、链接导入与当前队列；任务列表见 /studio/tasks */
export default function StudioPage() {
  const router = useRouter();
  const { queue, refresh: refreshQueue } = useQueueSnapshot();
  const [dragging, setDragging] = useState(false);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const { active: activeUpload, waiting: waitingUploads } = uploadSummary(uploads);
  const [error, setError] = useState<string | null>(null);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkMeta, setLinkMeta] = useState<{ title: string; durationSec: number | null } | null>(
    null,
  );
  // 12 号票 I1：深度与关注点前移到导入页，作为任务的默认值落库（任务页仍可改）
  const [detail, setDetail] = useState<TaskDetailLevel>("standard");
  const [purpose, setPurpose] = useState("");
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);

  const probeLink = useCallback(async () => {
    const url = linkUrl.trim();
    if (!url || linkBusy) return;
    setError(null);
    setLinkMeta(null);
    setLinkBusy(true);
    // 解析是一次明确的“在跑”动作：先切奔跑，结束后收回待机
    petFlow.parsing();
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
      petFlow.idle();
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
        body: JSON.stringify({ url, detailLevel: detail, purpose }),
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
  }, [linkUrl, linkBusy, detail, purpose, router]);

  /**
   * 本地上传队列：ref 是唯一真源，state 只负责渲染。
   * 一次只发一个请求（浏览器端串行），传完自动接上下一个；
   * 第一个文件还在传时再拖进来的文件会排在后面，不会像以前那样被静默丢掉。
   */
  const uploadQueue = useRef<UploadItem[]>([]);
  const uploadFiles = useRef(new Map<string, File>());
  const pumping = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const syncUploads = useCallback(() => {
    if (!mounted.current) return;
    setUploads([...uploadQueue.current]);
  }, []);

  /** 发一个文件；成功后刷新队列快照，留在导入页看排队，不跳转 */
  const sendUpload = useCallback(
    (item: UploadItem, file: File) =>
      new Promise<boolean>((resolve) => {
        const xhr = new XMLHttpRequest();
        const query = new URLSearchParams({
          name: file.name,
          detailLevel: detail,
          ...(purpose.trim() ? { purpose: purpose.trim() } : {}),
        });
        xhr.open("POST", `/api/upload?${query.toString()}`);
        xhr.setRequestHeader("content-type", "application/octet-stream");
        xhr.timeout = 30 * 60 * 1000;
        xhr.upload.onprogress = (e) => {
          if (!e.lengthComputable) return;
          uploadQueue.current = setUploadProgress(
            uploadQueue.current,
            item.id,
            (e.loaded / e.total) * 100,
          );
          syncUploads();
        };
        xhr.onload = () => {
          if (xhr.status === 201) {
            // 服务端已落库为 queued：拉一次权威队列快照，让新任务立刻出现在队列面板
            void refreshQueue();
            resolve(true);
            return;
          }
          try {
            setError((JSON.parse(xhr.responseText) as { error: string }).error);
          } catch {
            setError(`上传失败（${xhr.status}）`);
          }
          resolve(false);
        };
        xhr.onerror = () => {
          setError("网络中断，上传失败");
          resolve(false);
        };
        xhr.ontimeout = () => {
          setError("上传超时，请检查网络后重试");
          resolve(false);
        };
        try {
          xhr.send(file);
        } catch (error) {
          setError(error instanceof Error ? error.message : "上传失败");
          resolve(false);
        }
      }),
    [refreshQueue, syncUploads, detail, purpose],
  );

  const pumpUploads = useCallback(async () => {
    if (pumping.current) return;
    pumping.current = true;
    let failed = 0;
    try {
      petFlow.importStart();
      for (;;) {
        const started = startNext(uploadQueue.current);
        if (!started.next) break;
        uploadQueue.current = started.list;
        syncUploads();
        const item = started.next;
        const file = uploadFiles.current.get(item.id);
        if (!file) {
          uploadQueue.current = removeUpload(uploadQueue.current, item.id);
          syncUploads();
          continue;
        }
        let ok = false;
        try {
          ok = await sendUpload(item, file);
        } catch (error) {
          setError(error instanceof Error ? error.message : "上传失败");
        }
        if (!ok) failed += 1;
        uploadFiles.current.delete(item.id);
        uploadQueue.current = removeUpload(uploadQueue.current, item.id);
        syncUploads();
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : "上传队列异常");
    } finally {
      pumping.current = false;
      try {
        if (failed === 0) petFlow.importDone();
        else petFlow.importFailed();
      } catch {
        // 桌宠动画失败不影响上传队列
      }
    }
  }, [sendUpload, syncUploads]);

  const startUpload = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      setError(null);
      const fresh: UploadItem[] = files.map((file) => {
        const id = createUploadId();
        uploadFiles.current.set(id, file);
        return { id, name: file.name, sizeBytes: file.size, pct: 0, state: "waiting" };
      });
      uploadQueue.current = addUploads(uploadQueue.current, fresh);
      syncUploads();
      void pumpUploads();
    },
    [pumpUploads, syncUploads],
  );

  // 12 号票 I5：取消排队中的任务，出队后刷新队列快照释放队列位
  const cancelQueued = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/tasks/${id}/cancel`, { method: "POST" });
        if (!res.ok) {
          const detail = (await res.json().catch(() => null)) as { error?: string } | null;
          setError(detail?.error ?? `取消失败（${res.status}）`);
        }
      } catch {
        setError("网络中断，取消失败");
      }
      await refreshQueue();
    },
    [refreshQueue],
  );

  // 上传是页面内 XHR 直传：页面一走上传就断，服务端会把任务标成
  // 「上传中断，文件不完整」。传输中关页/刷新前让浏览器确认一次。
  useEffect(() => {
    if (!activeUpload && waitingUploads.length === 0) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [activeUpload, waitingUploads]);

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
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length > 0) {
        startUpload(files);
        return;
      }
      // 有拖入动作但没有文件：多半是文件夹（dataTransfer.files 不含目录）
      const items = e.dataTransfer?.items;
      if (items && items.length > 0) {
        setError("暂不支持文件夹，请拖入视频或音频文件");
      }
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
    <>
      <div className="grid gap-5 md:grid-cols-[1fr_260px]">
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          className="glass group flex min-h-64 flex-col items-center justify-center gap-4 rounded-3xl border-dashed p-10 transition-all hover:border-gold/50 hover:bg-gold/5"
        >
          {activeUpload ? (
            <>
              <Loader className="size-9 animate-spin text-gold" strokeWidth={1.5} />
              <div className="text-center">
                <p className="max-w-sm truncate text-sm text-paper">{activeUpload.name}</p>
                <div className="mx-auto mt-4 h-1 w-64 overflow-hidden rounded-full bg-tint/10">
                  <div
                    className="h-full rounded-full bg-gold transition-all"
                    style={{ width: `${activeUpload.pct}%` }}
                  />
                </div>
                <p className="mt-2 font-mono text-xs text-paper-faint">{activeUpload.pct}%</p>
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
          {waitingUploads.length > 0 ? (
            <div className="text-center">
              <p className="font-mono text-[11px] tracking-wider text-gold/80">
                待上传 {waitingUploads.length} 个
              </p>
              <p className="mt-1 max-w-sm truncate text-xs text-paper-dim">
                {waitingUploads.map((item) => item.name).join(" · ")}
              </p>
            </div>
          ) : null}
          <input
            ref={fileInput}
            type="file"
            multiple
            accept="video/*,audio/*,.mkv"
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length > 0) startUpload(files);
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

      <section className="glass mt-5 rounded-2xl px-5 py-4">
        <p className="flex items-center gap-2 font-mono text-[10px] tracking-widest text-paper-faint">
          <SlidersHorizontal className="size-3.5" strokeWidth={1.5} />
          文章默认值 / ARTICLE DEFAULTS
        </p>
        <div className="mt-3 flex flex-col gap-3 md:flex-row md:items-center">
          <div className="flex gap-1.5">
            {DETAIL_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setDetail(opt.value)}
                title={opt.hint}
                className={`rounded-lg border px-3 py-1.5 font-mono text-[11px] transition-colors ${
                  detail === opt.value
                    ? "border-gold/40 bg-gold/10 text-gold"
                    : "border-tint/10 text-paper-faint hover:text-paper-dim"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <input
            value={purpose}
            onChange={(e) => setPurpose(e.target.value.slice(0, 500))}
            placeholder="本次关注点（可选，≤500 字），对之后导入的任务生效"
            className="min-w-0 flex-1 rounded-xl border border-tint/10 bg-ink-950/60 px-3 py-2 text-xs text-paper outline-none transition-colors placeholder:text-paper-faint focus:border-gold/50"
          />
        </div>
        <p className="mt-2 text-xs text-paper-faint">
          上传或链接导入的任务都会带上这里的深度与关注点，生成文章时作为默认值，任务页里仍可修改。
        </p>
      </section>

      {error ? (
        <div className="mt-5 flex items-center gap-3 rounded-2xl border border-danger/30 bg-danger/10 px-5 py-3 text-sm text-danger/90">
          <X className="size-4 shrink-0" strokeWidth={1.5} />
          {error}
        </div>
      ) : null}

      <QueuePanel queue={queue} onCancel={cancelQueued} />

      <Link
        href="/studio/tasks"
        className="mt-5 inline-flex items-center gap-2 self-start font-mono text-[11px] tracking-widest text-paper-faint transition-colors hover:text-gold"
      >
        <ListOrdered className="size-3.5" strokeWidth={1.5} />
        查看全部任务
      </Link>

      {dragging ? (
        <div className="pointer-events-none fixed inset-4 z-50 flex items-center justify-center rounded-3xl border-2 border-dashed border-gold/60 bg-ink-950/80 backdrop-blur-sm">
          <p className="font-display text-4xl font-semibold text-gold">松手开始上传</p>
        </div>
      ) : null}
    </>
  );
}
