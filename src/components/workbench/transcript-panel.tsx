"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Check, Copy, Download } from "lucide-react";
import type { Transcript } from "@/server/asr";
import { toSrt } from "@/lib/srt";
import { clock } from "@/lib/time";

export function TranscriptPanel({
  transcript,
  videoRef,
  activeIndex,
  taskName,
  onSeek,
}: {
  transcript: Transcript;
  videoRef: RefObject<HTMLVideoElement | null>;
  activeIndex: number;
  taskName: string;
  onSeek: (t: number) => void;
}) {
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (activeIndex < 0) return;
    rowRefs.current[activeIndex]?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeIndex]);

  const fullText = useMemo(
    () => transcript.segments.map((s) => s.text).join("\n"),
    [transcript],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(fullText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 剪贴板权限被拒时静默
    }
  };

  const downloadSrt = () => {
    const blob = new Blob([toSrt(transcript.segments)], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${taskName.replace(/\.[^.]+$/, "") || "transcript"}.srt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const chars = useMemo(
    () => transcript.segments.reduce((n, s) => n + s.text.length, 0),
    [transcript],
  );

  return (
    <section className="glass flex h-full min-h-0 flex-col rounded-2xl">
      <header className="flex items-center justify-between border-b border-tint/5 px-5 py-3.5">
        <div>
          <h2 className="text-sm text-paper">文稿</h2>
          <p className="mt-0.5 font-mono text-[10px] tracking-widest text-paper-faint">
            {transcript.segments.length} SEG · {chars} 字
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={copy}
            className="inline-flex items-center gap-1.5 rounded-full border border-tint/15 px-3 py-1.5 font-mono text-[10px] tracking-wider text-paper-dim transition-colors hover:border-gold/60 hover:text-gold"
          >
            {copied ? (
              <Check className="size-3" strokeWidth={1.5} />
            ) : (
              <Copy className="size-3" strokeWidth={1.5} />
            )}
            {copied ? "已复制" : "复制"}
          </button>
          <button
            type="button"
            onClick={downloadSrt}
            className="inline-flex items-center gap-1.5 rounded-full border border-tint/15 px-3 py-1.5 font-mono text-[10px] tracking-wider text-paper-dim transition-colors hover:border-gold/60 hover:text-gold"
          >
            <Download className="size-3" strokeWidth={1.5} />
            SRT
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {transcript.segments.map((seg, i) => {
          const active = i === activeIndex;
          return (
            <button
              key={`${i}-${seg.start}`}
              ref={(el) => {
                rowRefs.current[i] = el;
              }}
              type="button"
              onClick={() => {
                const video = videoRef.current;
                if (video) video.currentTime = seg.start;
                onSeek(seg.start);
              }}
              className={`flex w-full items-start gap-4 rounded-xl px-4 py-2.5 text-left transition-colors ${
                active ? "bg-tint/[0.06]" : "hover:bg-tint/[0.03]"
              }`}
            >
              <span
                className={`mt-1 shrink-0 font-mono text-[10px] tabular-nums ${
                  active ? "text-gold" : "text-paper-faint"
                }`}
              >
                {clock(seg.start)}
              </span>
              <span
                className={`text-sm leading-relaxed ${
                  active ? "text-paper" : "text-paper-dim"
                }`}
              >
                {seg.text}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
