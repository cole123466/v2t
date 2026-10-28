"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  Archive,
  ChevronRight,
  Download,
  FileDown,
  FileText,
  Link2,
  Loader,
  Printer,
  RotateCcw,
  X,
} from "lucide-react";
import type { MindMapNode } from "@/server/article";
import type { ArticleDetailLevel, ArticleRecord } from "@/server/articles";
import type { TaskDetailLevel } from "@/server/tasks";
import { DETAIL_OPTIONS } from "@/lib/article-options";
import { ArticleBlockView, InlineText } from "./article-block";
import { SelectionPopover } from "./selection-popover";
import { RequestIdLine } from "./request-id";
import { ShareDialog } from "./share-dialog";
import { petFlow } from "@/components/pet/pet-flow";

function MindMapTree({
  nodes,
  activeSection,
  onJump,
}: {
  nodes: MindMapNode[];
  activeSection: string | null;
  onJump: (sectionId: string) => void;
}) {
  return (
    <ul className="space-y-1.5">
      {nodes.map((node, i) => (
        <li key={i}>
          <button
            type="button"
            disabled={!node.sectionId}
            onClick={() => node.sectionId && onJump(node.sectionId)}
            className={`flex w-full items-start gap-1.5 rounded-lg px-2 py-1 text-left text-xs transition-colors ${
              node.sectionId
                ? activeSection === node.sectionId
                  ? "bg-gold/10 text-gold"
                  : "text-paper-dim hover:bg-tint/5 hover:text-paper"
                : "text-paper-faint"
            }`}
          >
            {node.sectionId ? (
              <ChevronRight className="mt-0.5 size-3 shrink-0" strokeWidth={1.5} />
            ) : (
              <span className="mt-1.5 size-1 shrink-0 rounded-full bg-tint/20" />
            )}
            <span>{node.label}</span>
          </button>
          {node.children?.length ? (
            <div className="ml-3 border-l border-tint/5 pl-1">
              <MindMapTree
                nodes={node.children}
                activeSection={activeSection}
                onJump={onJump}
              />
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}


export function ArticlePanel({
  taskId,
  videoRef,
  onAskSection,
  onAskFrame,
  defaultDetail,
  defaultPurpose,
}: {
  taskId: string;
  videoRef: RefObject<HTMLVideoElement | null>;
  /** 文章选段追问（09 号票 P1）：quote 已由 SelectionPopover 捕获 */
  onAskSection?: (sectionId: string, blockIndex: number, quote: string) => void;
  /** figure「问这张画面」（P2） */
  onAskFrame?: (frameId: string) => void;
  /** 导入页选定的默认值（12 号票 I1）：面板预填，仍可修改 */
  defaultDetail?: TaskDetailLevel | null;
  defaultPurpose?: string | null;
}) {
  const [articles, setArticles] = useState<ArticleRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ArticleDetailLevel>(defaultDetail ?? "standard");
  const [purpose, setPurpose] = useState(defaultPurpose ?? "");
  const [citationTimes, setCitationTimes] = useState<Map<string, number>>(new Map());
  const [exporting, setExporting] = useState<"md" | "zip" | "html" | "pdf" | null>(null);
  // 选区浮层的定位容器：文章正文滚动区
  const contentRef = useRef<HTMLDivElement>(null);
  const [shareOpen, setShareOpen] = useState(false);
  // 生成流的取消句柄：离开页面即中止，避免卸载后仍触发桌宠信号
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  // 刷新恢复：挂载时若有进行中的文章，重新订阅其事件流（08 号票）
  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/tasks/${taskId}/articles`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { articles?: ArticleRecord[] } | null) => {
        if (cancelled || !data?.articles) return;
        setArticles(data.articles);
        const streaming = data.articles.find((a) => a.status === "streaming");
        if (streaming && !busy) {
          setBusy(true);
          setStage("继续接收生成进度");
          petFlow.working();
          const ctrl = new AbortController();
          abortRef.current = ctrl;
          void subscribe(streaming.id, ctrl)
            .catch(() => {})
            .finally(() => {
              if (abortRef.current === ctrl) abortRef.current = null;
              setBusy(false);
              setStage(null);
            });
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  useEffect(() => {
    void fetch(`/api/tasks/${taskId}/citations`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { timeCitations?: Array<{ id: string; start: number }>; frames?: Array<{ id: string; tSec: number }> } | null) => {
        if (!data) return;
        const map = new Map<string, number>();
        for (const t of data.timeCitations ?? []) map.set(t.id, t.start);
        for (const f of data.frames ?? []) map.set(f.id, f.tSec);
        setCitationTimes(map);
      });
  }, [taskId]);

  const load = useMemo(
    () => async () => {
      const res = await fetch(`/api/tasks/${taskId}/articles`);
      if (res.ok) {
        const data = (await res.json()) as { articles: ArticleRecord[] };
        setArticles(data.articles);
      }
    },
    [taskId],
  );

  useEffect(() => {
    fetch(`/api/tasks/${taskId}/articles`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { articles: ArticleRecord[] } | null) => {
        if (data) setArticles(data.articles);
      });
  }, [taskId]);

  // 生成中的文章也作为展示对象：部分 content 落库后刷新页面能直接看到已生成章节
  const active =
    articles.find((a) => a.id === selected) ??
    articles.find((a) => a.status === "done") ??
    articles.find((a) => a.status === "streaming") ??
    articles.find((a) => a.status === "interrupted");

  const seek = (t: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = t;
    void video.play().catch(() => {});
  };

  // 08 号票：生成改为后台任务。POST 拿 202 + jobId，随后订阅 events；
  // 断开连接不再中止生成，刷新回来重新订阅即可。
  const subscribe = async (articleId: string, ctrl: AbortController) => {
    const res = await fetch(`/api/tasks/${taskId}/articles/${articleId}/events`, {
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const event = /^event: (.+)$/m.exec(block)?.[1];
        const dataLine = /^data: (.+)$/m.exec(block)?.[1];
        if (!event || !dataLine) continue;
        const data = JSON.parse(dataLine) as Record<string, unknown>;
        if (event === "snapshot") {
          const article = data.article as ArticleRecord | undefined;
          if (article) {
            setArticles((prev) => {
              const idx = prev.findIndex((a) => a.id === article.id);
              if (idx >= 0) {
                const next = [...prev];
                next[idx] = article;
                return next;
              }
              return [article, ...prev];
            });
            setSelected(article.id);
          }
        } else if (event === "step") {
          const stage = data.stage as string | undefined;
          const message = data.message ? ` ${data.message}` : "";
          if (stage === "outline") setStage("生成提纲");
          else if (stage === "section") setStage(`撰写章节${message}`);
          else if (data.phase) setStage(String(data.phase));
        } else if (event === "delta") {
          setStreamText((prev) => prev + String(data.delta ?? ""));
        } else if (event === "done") {
          setStage(null);
          petFlow.done();
          await load();
        } else if (event === "error") {
          petFlow.failed();
          setError(String(data.message ?? "生成失败"));
          setStage(null);
        }
      }
    }
  };

  const generate = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setRequestId(null);
    setStreamText("");
    setStage("准备中");
    petFlow.working();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetch(`/api/tasks/${taskId}/articles`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ detailLevel: detail, purpose }),
        signal: ctrl.signal,
      });
      const data = (await res.json().catch(() => null)) as {
        error?: string;
        jobId?: string;
        articleId?: string;
      } | null;
      if (!res.ok || !data?.articleId) {
        setRequestId(res.headers.get("x-request-id"));
        setError(data?.error ?? `生成失败（${res.status}）`);
        petFlow.failed();
        return;
      }
      await subscribe(data.articleId, ctrl);
    } catch (err) {
      if (ctrl.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
      petFlow.failed();
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
      setBusy(false);
      setStage(null);
    }
  };

  const cancelGeneration = async (articleId: string) => {
    await fetch(`/api/tasks/${taskId}/articles/${articleId}/cancel`, { method: "POST" });
    abortRef.current?.abort();
    setBusy(false);
    setStage(null);
    await load();
  };

  const resumeGeneration = async (articleId: string) => {
    setBusy(true);
    setError(null);
    setStreamText("");
    setStage("继续生成");
    petFlow.working();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetch(`/api/tasks/${taskId}/articles/${articleId}/resume`, { method: "POST" });
      const data = (await res.json().catch(() => null)) as { error?: string; articleId?: string } | null;
      if (!res.ok || !data?.articleId) {
        setError(data?.error ?? `继续生成失败（${res.status}）`);
        petFlow.failed();
        return;
      }
      await subscribe(data.articleId, ctrl);
    } catch (err) {
      if (ctrl.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
      petFlow.failed();
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
      setBusy(false);
      setStage(null);
    }
  };

  // PDF 走「浏览器打印」：复用 HTML 导出产物（自包含、图片内联），在离屏 iframe 里渲染后
  // 唤起打印面板，用户选「另存为 PDF」即得矢量文本、中文字体原生的 PDF（不引入 puppeteer/jsPDF）。
  // 不用 window.open：新窗口会被弹窗拦截，且离开页面后打印面板与页面生命周期不同步。
  const exportPdf = async () => {
    if (!active || exporting) return;
    setExporting("pdf");
    setError(null);
    const url = `/api/tasks/${taskId}/articles/${active.id}/export?format=html`;
    let iframe: HTMLIFrameElement | null = null;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(detail?.error ?? `导出失败（${res.status}）`);
        return;
      }
      // 用 blob URL 而不是 srcdoc：data URL 形式的图片在 srcdoc 里会被部分浏览器按同源策略拦下
      const blob = await res.blob();
      iframe = document.createElement("iframe");
      iframe.setAttribute("aria-hidden", "true");
      iframe.tabIndex = -1;
      // 必须给接近 A4 的视口尺寸：若缩成 1px，文档会按窄屏排版（响应式断点生效），
      // 打印出来行宽和分栏都不对。改成移到屏幕外而不是隐藏，避免部分浏览器不打印不可见 iframe。
      iframe.style.position = "fixed";
      iframe.style.left = "-10000px";
      iframe.style.top = "0";
      iframe.style.width = "820px";
      iframe.style.height = "1160px";
      iframe.style.border = "0";
      iframe.style.pointerEvents = "none";

      const objectUrl = URL.createObjectURL(blob);
      try {
        await new Promise<void>((resolve, reject) => {
          if (!iframe) return reject(new Error("iframe 初始化失败"));
          iframe.onload = () => resolve();
          iframe.onerror = () => reject(new Error("打印页面加载失败"));
          iframe.src = objectUrl;
          document.body.appendChild(iframe);
        });
      } finally {
        URL.revokeObjectURL(objectUrl);
      }

      const frameWindow = iframe.contentWindow;
      if (!frameWindow) throw new Error("无法访问打印页面");
      frameWindow.focus();
      // 打印面板是异步弹出的，iframe 在打印结束前不能移除，否则会打出空白页。
      // 以 afterprint 为准清理，再用兜底定时器处理用户直接关掉面板等不触发事件的情况。
      frameWindow.addEventListener("afterprint", () => iframe?.remove(), { once: true });
      window.setTimeout(() => iframe?.remove(), 5 * 60_000);
      frameWindow.print();
    } catch (err) {
      iframe?.remove();
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(null);
    }
  };

  const download = async (format: "md" | "zip" | "html") => {
    if (!active || exporting) return;
    setExporting(format);
    setError(null);
    try {
      const res = await fetch(`/api/tasks/${taskId}/articles/${active.id}/export?format=${format}`);
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(detail?.error ?? `导出失败（${res.status}）`);
        return;
      }
      const blob = await res.blob();
      const disposition = res.headers.get("content-disposition") ?? "";
      const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
      const filename = encoded ? decodeURIComponent(encoded) : `${active.title ?? "article"}.${format}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(null);
    }
  };

  return (
    <div className="flex h-full min-h-[420px] flex-col gap-4">
      <div className="glass rounded-2xl p-4">
        <div className="flex items-center justify-between">
          <p className="flex items-center gap-2 font-mono text-[10px] tracking-widest text-paper-faint">
            <FileText className="size-3.5" strokeWidth={1.5} />
            图文文章
          </p>
          {active?.content ? (
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <button
                type="button"
                onClick={() => setShareOpen(true)}
                disabled={active.status !== "done"}
                className="inline-flex items-center gap-1 font-mono text-[10px] text-paper-faint transition-colors hover:text-gold disabled:opacity-50"
                title="创建只读分享链接"
              >
                <Link2 className="size-3" strokeWidth={1.5} />
                分享
              </button>
              <button
                type="button"
                onClick={() => void exportPdf()}
                disabled={exporting !== null}
                className="inline-flex items-center gap-1 rounded-lg border border-gold/40 bg-gold/10 px-2 py-1 font-mono text-[10px] text-gold transition-colors hover:bg-gold/20 disabled:opacity-50"
                title="按 HTML 排版打开打印面板，选择「另存为 PDF」"
              >
                {exporting === "pdf" ? (
                  <Loader className="size-3 animate-spin" strokeWidth={1.5} />
                ) : (
                  <Printer className="size-3" strokeWidth={1.5} />
                )}
                导出 PDF
              </button>
              <button
                type="button"
                onClick={() => void download("html")}
                disabled={exporting !== null}
                className="inline-flex items-center gap-1 font-mono text-[10px] text-paper-faint transition-colors hover:text-gold disabled:opacity-50"
                title="下载自包含 HTML（图片已内联，可离线打开）"
              >
                {exporting === "html" ? (
                  <Loader className="size-3 animate-spin" strokeWidth={1.5} />
                ) : (
                  <FileDown className="size-3" strokeWidth={1.5} />
                )}
                HTML
              </button>
              <button
                type="button"
                onClick={() => void download("md")}
                disabled={exporting !== null}
                className="inline-flex items-center gap-1 font-mono text-[10px] text-paper-faint transition-colors hover:text-gold disabled:opacity-50"
              >
                {exporting === "md" ? (
                  <Loader className="size-3 animate-spin" strokeWidth={1.5} />
                ) : (
                  <Download className="size-3" strokeWidth={1.5} />
                )}
                Markdown
              </button>
              <button
                type="button"
                onClick={() => void download("zip")}
                disabled={exporting !== null}
                className="inline-flex items-center gap-1 font-mono text-[10px] text-paper-faint transition-colors hover:text-gold disabled:opacity-50"
              >
                {exporting === "zip" ? (
                  <Loader className="size-3 animate-spin" strokeWidth={1.5} />
                ) : (
                  <Archive className="size-3" strokeWidth={1.5} />
                )}
                图文 ZIP
              </button>
            </div>
          ) : null}
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {DETAIL_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setDetail(opt.value)}
              title={opt.hint}
              className={`rounded-lg border px-2.5 py-1 font-mono text-[10px] transition-colors ${
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
          placeholder="本次关注点（可选，≤500 字）"
          className="mt-2 w-full rounded-xl border border-tint/10 bg-ink-950/60 px-3 py-2 text-xs text-paper outline-none transition-colors placeholder:text-paper-faint focus:border-gold/50"
        />

        <button
          type="button"
          onClick={() => void generate()}
          disabled={busy}
          className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl border border-gold/40 bg-gold/10 px-3 py-2 font-mono text-[11px] tracking-wider text-gold transition-colors hover:bg-gold/20 disabled:opacity-40"
        >
          {busy ? <Loader className="size-3.5 animate-spin" strokeWidth={1.5} /> : <FileText className="size-3.5" strokeWidth={1.5} />}
          {busy ? "生成中" : articles.some((a) => a.status === "done") ? "重新生成" : "生成图文文章"}
        </button>

        {busy && active ? (
          <button
            type="button"
            onClick={() => void cancelGeneration(active.id)}
            className="mt-1.5 flex w-full items-center justify-center gap-2 rounded-xl border border-danger/30 bg-danger/5 px-3 py-1.5 font-mono text-[10px] tracking-wider text-danger/80 transition-colors hover:bg-danger/15"
          >
            <X className="size-3" strokeWidth={1.5} />
            取消生成
          </button>
        ) : null}

        {!busy && active && (active.status === "interrupted" || active.status === "failed") && active.content ? (
          <button
            type="button"
            onClick={() => void resumeGeneration(active.id)}
            className="mt-1.5 flex w-full items-center justify-center gap-2 rounded-xl border border-gold/40 bg-gold/10 px-3 py-1.5 font-mono text-[10px] tracking-wider text-gold transition-colors hover:bg-gold/20"
          >
            <RotateCcw className="size-3" strokeWidth={1.5} />
            已保存 {active.content.sections.length} 章 · 继续生成
          </button>
        ) : null}

        {stage ? (
          <p className="mt-2 truncate font-mono text-[10px] text-gold/80">{stage}</p>
        ) : null}
        {error ? (
          <div className="mt-2 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-[11px] leading-relaxed text-danger/90">
            <X className="mt-0.5 size-3 shrink-0" strokeWidth={1.5} />
            <span className="min-w-0 break-words">
              {error}
              <RequestIdLine id={requestId} />
            </span>
          </div>
        ) : null}
      </div>

      {busy && streamText ? (
        <div className="glass min-h-0 flex-1 overflow-auto rounded-2xl p-5 font-mono text-[11px] leading-relaxed text-paper-faint">
          <pre className="whitespace-pre-wrap break-words">{streamText}</pre>
        </div>
      ) : null}

      {active?.content ? (
        <div ref={contentRef} className="glass relative min-h-0 flex-1 overflow-auto rounded-2xl p-6">
          {onAskSection ? (
            <SelectionPopover
              containerRef={contentRef}
              onAsk={(quote) => {
                // 用选区起点反查所属章节与块：向上找最近的 section 根，
                // 途中经过块包装 div（data-block-index）时记下块序号
                const sel = window.getSelection();
                let el: Node | null = sel?.rangeCount
                  ? sel.getRangeAt(0).startContainer
                  : null;
                let blockIndex = -1;
                while (el) {
                  if (el instanceof HTMLElement) {
                    if (blockIndex < 0 && el.dataset.blockIndex !== undefined) {
                      blockIndex = Number(el.dataset.blockIndex);
                    }
                    if (el.dataset.sectionId) break;
                  }
                  el = el.parentNode;
                }
                const host = el as HTMLElement | null;
                if (!host?.dataset.sectionId) return;
                onAskSection(host.dataset.sectionId, blockIndex, quote);
              }}
            />
          ) : null}
          {/* 正文限宽：过宽的行长会让阅读跳行，正文区在宽屏下居中 */}
          <div className="mx-auto w-full max-w-[44rem]">
          {active.status === "streaming" ? (
            <p className="mb-4 flex items-center gap-2 rounded-xl border border-gold/20 bg-gold/5 px-3 py-2 font-mono text-[10px] tracking-wider text-gold/90">
              <Loader className="size-3 animate-spin" strokeWidth={1.5} />
              生成中 · {active.content.sections.length} 章已完成
            </p>
          ) : null}
          <h2 className="font-display text-2xl font-semibold leading-snug text-paper">
            {active.content.title}
          </h2>
          <p className="mt-1.5 font-mono text-[10px] tracking-wider text-paper-faint">
            {active.detailLevel === "concise" ? "速览" : active.detailLevel === "detailed" ? "深入" : "标准"}
            {" · "}
            {active.content.sections.length} 章
            {/* 模型身份行（11 号票 S6）：历史文章 model 为默认值时不显示 */}
            {active.model && active.model !== "glm-4.6" ? ` · ${active.model}` : ""}
            {active.purpose ? ` · 关注点：${active.purpose}` : ""}
          </p>

          {active.content.mindMap.length > 0 ? (
            <div className="mt-5 rounded-xl border border-tint/5 bg-tint/[0.02] p-3">
              <p className="mb-2 font-mono text-[10px] tracking-widest text-paper-faint">内容导图</p>
              <MindMapTree
                nodes={active.content.mindMap}
                activeSection={null}
                onJump={(sectionId) => {
                  document
                    .getElementById(`section-${sectionId}`)
                    ?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
              />
            </div>
          ) : null}

          <div className="mt-6 space-y-9">
            {active.content.sections.map((section, index) => (
              <section
                key={section.id}
                id={`section-${section.id}`}
                data-section-id={section.id}
                className={`scroll-mt-4 ${index > 0 ? "border-t border-tint/[0.07] pt-8" : ""}`}
              >
                <h3 className="flex items-baseline gap-2.5 font-display text-[19px] font-semibold leading-snug text-paper">
                  <span className="font-mono text-[11px] tracking-widest text-gold/80">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  {section.title}
                </h3>
                <div className="mt-3 space-y-3.5">
                  {section.blocks.map((block, i) => (
                    <div key={i} data-block-index={i} data-block-type={block.type}>
                      <ArticleBlockView
                        taskId={taskId}
                        block={block}
                        times={citationTimes}
                        onSeek={seek}
                        onAskFrame={onAskFrame}
                      />
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>

          {active.content.limitations.length > 0 ? (
            <div className="mt-9 rounded-xl border border-gold/20 bg-gold/5 p-4">
              <p className="font-mono text-[10px] tracking-widest text-gold/80">未确认之处</p>
              <ul className="mt-2 space-y-1.5 text-[13px] leading-relaxed text-paper-dim">
                {active.content.limitations.map((l, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-gold/60">·</span>
                    <span className="min-w-0">
                      <InlineText text={l.text} times={citationTimes} onSeek={seek} />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          </div>
        </div>
      ) : null}

      {articles.length > 1 ? (
        <div className="glass shrink-0 rounded-2xl p-3">
          <p className="mb-2 font-mono text-[10px] tracking-widest text-paper-faint">历史版本</p>
          <div className="flex flex-wrap gap-1.5">
            {articles.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => setSelected(a.id)}
                className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 font-mono text-[10px] transition-colors ${
                  a.id === active?.id
                    ? "border-gold/40 text-gold"
                    : "border-tint/10 text-paper-faint hover:text-paper-dim"
                }`}
              >
                {a.status === "failed" ? (
                  <X className="size-3" strokeWidth={1.5} />
                ) : a.status === "interrupted" ? (
                  <X className="size-3 text-gold/70" strokeWidth={1.5} />
                ) : a.status === "streaming" ? (
                  <RotateCcw className="size-3 animate-spin" strokeWidth={1.5} />
                ) : null}
                {new Date(a.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
                {a.title ? ` · ${a.title.slice(0, 12)}` : ""}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {!active?.content && !busy ? (
        <div className="glass flex min-h-0 flex-1 flex-col items-center justify-center gap-3 rounded-2xl border-dashed p-8 text-center">
          <FileText className="size-7 text-paper-faint" strokeWidth={1.5} />
          <p className="text-sm text-paper-dim">还没有图文文章</p>
          <p className="max-w-xs text-xs leading-relaxed text-paper-faint">
            基于转写稿与全景画面生成带章节、时间出处和内容导图的文章。挑选深度后点上方按钮开始。
          </p>
          {(active?.status === "failed" || active?.status === "interrupted") && active.error ? (
            <p className="max-w-sm break-all font-mono text-[10px] leading-relaxed text-danger/70">
              {active.error}
            </p>
          ) : null}
        </div>
      ) : null}

      {shareOpen && active ? (
        <ShareDialog
          taskId={taskId}
          articleId={active.id}
          onClose={() => setShareOpen(false)}
        />
      ) : null}
    </div>
  );
}

