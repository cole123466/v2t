"use client";

import { useEffect, useMemo, useState, type RefObject } from "react";
import Image from "next/image";
import { Archive, ChevronRight, Download, FileText, Loader, RotateCcw, X } from "lucide-react";
import type { MindMapNode } from "@/server/article";
import type { ArticleDetailLevel, ArticleRecord } from "@/server/articles";
import { clock } from "@/lib/time";

const DETAIL_OPTIONS: Array<{ value: ArticleDetailLevel; label: string; hint: string }> = [
  { value: "concise", label: "速览", hint: "800 字内，只留核心" },
  { value: "standard", label: "标准", hint: "信息完整而克制" },
  { value: "detailed", label: "深入", hint: "展开推导与细节" },
];

/** 把正文里的 [[tNN]] 渲染成可点击的时间芯片；[[fNN]] 由下方的真实画面承载 */
function CitationText({
  text,
  onSeek,
  times,
}: {
  text: string;
  onSeek: (t: number) => void;
  /** 引用编号 → 视频内时间；缺失表示无出处 */
  times: Map<string, number>;
}) {
  const parts = useMemo(() => text.split(/(\[\[[tf]\d{2,}\]\])/g), [text]);
  return (
    <>
      {parts.map((part, i) => {
        const match = /^\[\[([tf])(\d{2,})\]\]$/.exec(part);
        if (!match) return <span key={i}>{part}</span>;
        const id = `${match[1]}${match[2]}`;
        const t = times.get(id);
        // 画面引用不占正文，交给段落下方的图注渲染
        if (match[1] === "f") return null;
        if (t === undefined) {
          return (
            <span
              key={i}
              className="mx-0.5 inline-flex items-center rounded-md border border-danger/30 px-1.5 py-0.5 align-baseline font-mono text-[10px] text-danger/70"
              title={`出处 ${id} 无法核实`}
            >
              {id}
            </span>
          );
        }
        return (
          <button
            key={i}
            type="button"
            onClick={() => onSeek(t)}
            className="mx-0.5 inline-flex items-center rounded-md border border-gold/30 bg-gold/10 px-1.5 py-0.5 align-baseline font-mono text-[10px] text-gold transition-colors hover:bg-gold/20"
            title={`${match[1] === "t" ? "转写段" : "画面"} ${id} · ${clock(t)}`}
          >
            {id}
          </button>
        );
      })}
    </>
  );
}

/** 单张画面：点击回到视频对应时间；帧被清理或缺失时静默不渲染 */
function ArticleFrame({
  taskId,
  frameId,
  tSec,
  onSeek,
}: {
  taskId: string;
  frameId: string;
  tSec: number;
  onSeek: (t: number) => void;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <figure className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.02]">
      <button
        type="button"
        onClick={() => onSeek(tSec)}
        title={`回到 ${clock(tSec)}`}
        className="block w-full"
      >
        <Image
          src={`/api/tasks/${taskId}/frames/${frameId}`}
          alt={`画面 ${frameId}`}
          width={1280}
          height={720}
          unoptimized
          loading="lazy"
          className="aspect-video w-full object-cover"
          onError={() => setFailed(true)}
        />
      </button>
      <figcaption className="flex items-center justify-between px-3 py-1.5 font-mono text-[10px] tracking-wider text-paper-faint">
        <span>{frameId.toUpperCase()}</span>
        <span>{clock(tSec)}</span>
      </figcaption>
    </figure>
  );
}

/** 段落中引用到的画面，按出现顺序渲染为真实图片 */
function FrameStrip({
  text,
  taskId,
  times,
  onSeek,
}: {
  text: string;
  taskId: string;
  times: Map<string, number>;
  onSeek: (t: number) => void;
}) {
  const frames = useMemo(() => {
    const ids = Array.from(text.matchAll(/\[\[(f\d{2,})\]\]/g), (m) => m[1]);
    return Array.from(new Set(ids)).filter((id) => times.has(id));
  }, [text, times]);
  if (frames.length === 0) return null;
  return (
    <div className={`mt-3 grid gap-2 ${frames.length > 1 ? "sm:grid-cols-2" : ""}`}>
      {frames.map((id) => (
        <ArticleFrame
          key={id}
          taskId={taskId}
          frameId={id}
          tSec={times.get(id) as number}
          onSeek={onSeek}
        />
      ))}
    </div>
  );
}

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
                  : "text-paper-dim hover:bg-white/5 hover:text-paper"
                : "text-paper-faint"
            }`}
          >
            {node.sectionId ? (
              <ChevronRight className="mt-0.5 size-3 shrink-0" strokeWidth={1.5} />
            ) : (
              <span className="mt-1.5 size-1 shrink-0 rounded-full bg-white/20" />
            )}
            <span>{node.label}</span>
          </button>
          {node.children?.length ? (
            <div className="ml-3 border-l border-white/5 pl-1">
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
}: {
  taskId: string;
  videoRef: RefObject<HTMLVideoElement | null>;
}) {
  const [articles, setArticles] = useState<ArticleRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ArticleDetailLevel>("standard");
  const [purpose, setPurpose] = useState("");
  const [citationTimes, setCitationTimes] = useState<Map<string, number>>(new Map());
  const [exporting, setExporting] = useState<"md" | "zip" | null>(null);

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

  const active = articles.find((a) => a.id === selected) ?? articles.find((a) => a.status === "done");

  const seek = (t: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = t;
    void video.play().catch(() => {});
  };

  const generate = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setStreamText("");
    setStage("准备中");
    try {
      const res = await fetch(`/api/tasks/${taskId}/articles`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ detailLevel: detail, purpose }),
      });
      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? `生成失败（${res.status}）`);
        return;
      }
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
          if (event === "progress") {
            const message = data.message ? ` ${data.message}` : "";
            setStage(`${data.stage === "outline" ? "生成提纲" : "撰写章节"}${message}`);
          } else if (event === "delta") {
            setStreamText((cur) => cur + String(data.delta ?? ""));
          } else if (event === "done") {
            setStage(null);
            await load();
            setSelected(String((data as { id?: string }).id ?? ""));
          } else if (event === "error") {
            const problems = Array.isArray(data.problems) ? (data.problems as Array<{ field: string; message: string }>) : [];
            setError(
              problems.length > 0
                ? `${String(data.message)}：${problems.map((p) => p.message).join("；")}`
                : String(data.message ?? "生成失败"),
            );
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setStage(null);
    }
  };

  const download = async (format: "md" | "zip") => {
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
            <div className="flex items-center gap-2">
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
                  : "border-white/10 text-paper-faint hover:text-paper-dim"
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
          className="mt-2 w-full rounded-xl border border-white/10 bg-ink-950/60 px-3 py-2 text-xs text-paper outline-none transition-colors placeholder:text-paper-faint focus:border-gold/50"
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

        {stage ? (
          <p className="mt-2 truncate font-mono text-[10px] text-gold/80">{stage}</p>
        ) : null}
        {error ? (
          <div className="mt-2 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-[11px] leading-relaxed text-danger/90">
            <X className="mt-0.5 size-3 shrink-0" strokeWidth={1.5} />
            <span className="min-w-0 break-words">{error}</span>
          </div>
        ) : null}
      </div>

      {busy && streamText ? (
        <div className="glass min-h-0 flex-1 overflow-auto rounded-2xl p-5 font-mono text-[11px] leading-relaxed text-paper-faint">
          <pre className="whitespace-pre-wrap break-words">{streamText}</pre>
        </div>
      ) : null}

      {active?.content ? (
        <div className="glass min-h-0 flex-1 overflow-auto rounded-2xl p-6">
          <h2 className="font-display text-2xl font-semibold text-paper">
            {active.content.title}
          </h2>
          <p className="mt-1 font-mono text-[10px] tracking-wider text-paper-faint">
            {active.detailLevel === "concise" ? "速览" : active.detailLevel === "detailed" ? "深入" : "标准"}
            {" · "}
            {active.content.sections.length} 章
            {active.purpose ? ` · 关注点：${active.purpose}` : ""}
          </p>

          {active.content.mindMap.length > 0 ? (
            <div className="mt-5 rounded-xl border border-white/5 bg-white/[0.02] p-3">
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

          <div className="mt-6 space-y-8">
            {active.content.sections.map((section) => (
              <section key={section.id} id={`section-${section.id}`} className="scroll-mt-4">
                <h3 className="font-display text-lg font-semibold text-paper">{section.title}</h3>
                <div className="mt-2 space-y-3">
                  {section.blocks.map((block, i) => (
                    <div key={i}>
                      <p className="text-sm leading-relaxed text-paper-dim">
                        <CitationText text={block.text} onSeek={seek} times={citationTimes} />
                      </p>
                      <FrameStrip
                        text={block.text}
                        taskId={taskId}
                        times={citationTimes}
                        onSeek={seek}
                      />
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>

          {active.content.limitations.length > 0 ? (
            <div className="mt-8 rounded-xl border border-gold/20 bg-gold/5 p-4">
              <p className="font-mono text-[10px] tracking-widest text-gold/80">未确认之处</p>
              <ul className="mt-2 space-y-1 text-xs leading-relaxed text-paper-dim">
                {active.content.limitations.map((l, i) => (
                  <li key={i}>· {l.text}</li>
                ))}
              </ul>
            </div>
          ) : null}
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
                    : "border-white/10 text-paper-faint hover:text-paper-dim"
                }`}
              >
                {a.status === "failed" ? (
                  <X className="size-3" strokeWidth={1.5} />
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
          {active?.status === "failed" && active.error ? (
            <p className="max-w-sm break-all font-mono text-[10px] leading-relaxed text-danger/70">
              {active.error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

