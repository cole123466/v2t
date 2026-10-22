"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, Copy, Download, FileText, Loader, PenLine, Sparkle } from "lucide-react";
import type { Generation } from "@/server/generations";
import { TEMPLATE_META } from "@/lib/templates";
import { WaveBars } from "@/components/landing/wave-bars";

type Phase = "idle" | "streaming" | "error";

export function PromptPanel({
  taskId,
  taskName,
}: {
  taskId: string;
  taskName: string;
}) {
  const [selected, setSelected] = useState<string>("refine");
  const [prompt, setPrompt] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [streamText, setStreamText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<Generation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [overlay, setOverlay] = useState(false);
  const outputRef = useRef<HTMLDivElement>(null);

  const refreshHistory = useCallback(async () => {
    const res = await fetch(`/api/tasks/${taskId}/generations`);
    if (res.ok) {
      const data = (await res.json()) as { generations: Generation[] };
      setHistory(data.generations);
    }
  }, [taskId]);

  useEffect(() => {
    fetch(`/api/tasks/${taskId}/generations`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { generations: Generation[] } | null) => {
        if (data) setHistory(data.generations);
      });
  }, [taskId]);

  // 流式输出时自动滚到底部
  useEffect(() => {
    if (phase === "streaming" && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [streamText, phase]);

  const activeOutput = phase === "streaming" ? streamText : (history.find((g) => g.id === activeId)?.output ?? "");

  const start = useCallback(async () => {
    if (phase === "streaming") return;
    const manual = prompt.trim().length > 0;
    if (manual && prompt.trim().length < 2) return;
    setPhase("streaming");
    setStreamText("");
    setError(null);
    setActiveId(null);

    try {
      const res = await fetch(`/api/tasks/${taskId}/generations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          manual ? { mode: "manual", prompt: prompt.trim() } : { mode: "auto", templateId: selected },
        ),
      });
      if (!res.ok || !res.body) {
        const detail = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(detail?.error ?? `请求失败（${res.status}）`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let text = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const eventLine = block.split("\n").find((l) => l.startsWith("event:"));
          const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
          if (!eventLine || !dataLine) continue;
          const event = eventLine.slice(6).trim();
          const payload = JSON.parse(dataLine.slice(5)) as Record<string, unknown>;
          if (event === "delta") {
            text += String(payload.delta ?? "");
            setStreamText(text);
          } else if (event === "done") {
            const gen = payload as unknown as Generation;
            setActiveId(gen.id);
            await refreshHistory();
            setPhase("idle");
            setOverlay(true);
            setTimeout(() => setOverlay(false), 2000);
          } else if (event === "error") {
            throw new Error(String(payload.message ?? "生成失败"));
          }
        }
      }
      // 流意外中断（无 done/error 事件）时兜底复位
      setPhase((p) => (p === "streaming" ? "idle" : p));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
      await refreshHistory();
    }
  }, [phase, prompt, selected, taskId, refreshHistory]);

  const copy = async () => {
    if (!activeOutput) return;
    try {
      await navigator.clipboard.writeText(activeOutput);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 剪贴板权限被拒时静默
    }
  };

  const download = () => {
    if (!activeOutput) return;
    const blob = new Blob([activeOutput], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${taskName.replace(/\.[^.]+$/, "") || "copy"}-文案.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <aside className="glass flex min-w-0 flex-col gap-5 rounded-2xl p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <PenLine className="size-4 text-gold" strokeWidth={1.5} />
          <h2 className="text-sm text-paper">文案生成</h2>
        </div>
        {phase === "streaming" ? (
          <span className="font-mono text-[10px] tracking-widest text-gold">GENERATING</span>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2">
        {TEMPLATE_META.map((t) => (
          <button
            key={t.id}
            type="button"
            disabled={phase === "streaming"}
            onClick={() => setSelected(t.id)}
            className={`rounded-full border px-3 py-1.5 text-xs transition-colors disabled:opacity-50 ${
              selected === t.id && prompt.trim().length === 0
                ? "border-gold/60 bg-gold/10 text-gold"
                : "border-white/15 text-paper-dim hover:border-gold/40 hover:text-paper"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        disabled={phase === "streaming"}
        rows={3}
        placeholder="自定义提示词（留空则使用所选模板）"
        className="w-full resize-none rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-3 text-xs leading-relaxed text-paper outline-none transition-colors placeholder:text-paper-faint focus:border-gold/50 disabled:opacity-50"
      />

      <button
        type="button"
        onClick={() => void start()}
        disabled={phase === "streaming"}
        className="inline-flex items-center justify-center gap-2 rounded-xl bg-gold px-4 py-2.5 text-sm font-medium text-ink-950 transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {phase === "streaming" ? (
          <Loader className="size-4 animate-spin" strokeWidth={1.5} />
        ) : (
          <Sparkle className="size-4" strokeWidth={1.5} />
        )}
        {phase === "streaming" ? "生成中" : prompt.trim() ? "按提示词生成" : "按模板生成"}
      </button>

      {error ? (
        <p className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-xs leading-relaxed text-danger/90">
          {error}
        </p>
      ) : null}

      {(activeOutput || phase === "streaming") && (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] tracking-widest text-paper-faint">OUTPUT</span>
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={copy}
                className="inline-flex items-center gap-1 rounded-full border border-white/15 px-2.5 py-1 font-mono text-[10px] text-paper-dim transition-colors hover:border-gold/60 hover:text-gold"
              >
                {copied ? <Check className="size-3" strokeWidth={1.5} /> : <Copy className="size-3" strokeWidth={1.5} />}
                {copied ? "已复制" : "复制"}
              </button>
              <button
                type="button"
                onClick={download}
                className="inline-flex items-center gap-1 rounded-full border border-white/15 px-2.5 py-1 font-mono text-[10px] text-paper-dim transition-colors hover:border-gold/60 hover:text-gold"
              >
                <Download className="size-3" strokeWidth={1.5} />
                MD
              </button>
            </div>
          </div>
          <div
            ref={outputRef}
            className="max-h-72 min-h-32 overflow-y-auto rounded-xl border border-white/5 bg-white/[0.02] p-4 text-sm leading-relaxed text-paper-dim"
          >
            <span className="whitespace-pre-wrap">
              {activeOutput || (phase === "streaming" ? "等待第一个字…" : "")}
            </span>
            {phase === "streaming" ? (
              <span className="ml-0.5 inline-block h-4 w-[2px] animate-pulse bg-gold align-middle" />
            ) : null}
          </div>
        </div>
      )}

      {history.length > 0 ? (
        <div className="flex flex-col gap-2">
          <span className="font-mono text-[10px] tracking-widest text-paper-faint">
            历史 / {history.length} 版
          </span>
          <ul className="flex max-h-44 flex-col gap-1 overflow-y-auto pr-1">
            {history.map((gen) => (
              <li key={gen.id}>
                <button
                  type="button"
                  onClick={() => {
                    setActiveId(gen.id);
                    setStreamText("");
                    setPhase("idle");
                  }}
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${
                    activeId === gen.id ? "bg-white/[0.06] text-paper" : "text-paper-faint hover:bg-white/[0.03]"
                  }`}
                >
                  {gen.status === "failed" ? (
                    <span className="size-1.5 shrink-0 rounded-full bg-danger/80" />
                  ) : (
                    <span className="size-1.5 shrink-0 rounded-full bg-positive/80" />
                  )}
                  <span className="min-w-0 flex-1 truncate">
                    {gen.mode === "auto"
                      ? (TEMPLATE_META.find((t) => t.id === gen.templateId)?.label ?? "模板")
                      : "自定义"}
                    {" · "}
                    {new Date(gen.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-xs text-paper-faint">
          <FileText className="size-3.5" strokeWidth={1.5} />
          还没有生成记录
        </div>
      )}

      <AnimatePresence>
        {overlay ? (
          <motion.div
            key="done-overlay"
            className="fixed inset-0 z-[60] flex items-center justify-center bg-ink-950/85 backdrop-blur-md"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.35 }}
            onClick={() => setOverlay(false)}
          >
            <div className="flex flex-col items-center gap-10">
              <WaveBars count={56} className="h-16 w-[min(70vw,520px)] text-gold/60" />
              <motion.p
                initial={{ scale: 1.12, opacity: 0, letterSpacing: "0.6em" }}
                animate={{ scale: 1, opacity: 1, letterSpacing: "0.12em" }}
                transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
                className="font-display text-5xl font-black text-gold md:text-7xl"
              >
                文案已就绪
              </motion.p>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </aside>
  );
}
