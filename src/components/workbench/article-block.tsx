"use client";

import { useMemo, useState, type ReactNode } from "react";
import Image from "next/image";
import { parseInline, type ArticleBlock, type InlineMark } from "@/server/article";
import { clock } from "@/lib/time";

function withMarks(text: string, marks: InlineMark[]) {
  let node: ReactNode = text;
  if (marks.includes("code")) {
    node = (
      <code className="rounded bg-tint/10 px-1 py-0.5 font-mono text-[0.9em] text-paper">{node}</code>
    );
  }
  if (marks.includes("bold")) node = <strong className="font-semibold text-paper">{node}</strong>;
  if (marks.includes("emphasis")) node = <em className="italic">{node}</em>;
  return node;
}

export function InlineText({
  text,
  times,
  onSeek,
}: {
  text: string;
  /** 引用编号 → 视频内时间；缺失表示无出处 */
  times: Map<string, number>;
  onSeek: (t: number) => void;
}) {
  const parts = useMemo(() => parseInline(text), [text]);
  return (
    <>
      {parts.map((part, i) => {
        if (part.kind === "cite") {
          const t = times.get(part.id);
          // 画面引用由 figure 块承载，正文里不占位置
          if (part.id.startsWith("f")) return null;
          if (t === undefined) {
            return (
              <span
                key={i}
                className="mx-0.5 inline-flex items-center rounded-md border border-danger/30 px-1.5 py-0.5 align-baseline font-mono text-[10px] text-danger/70"
                title={`出处 ${part.id} 无法核实`}
              >
                {part.id}
              </span>
            );
          }
          return (
            <button
              key={i}
              type="button"
              onClick={() => onSeek(t)}
              className="mx-0.5 inline-flex items-center rounded-md border border-gold/30 bg-gold/10 px-1.5 py-0.5 align-baseline font-mono text-[10px] text-gold transition-colors hover:bg-gold/20"
              title={`转写段 ${part.id} · ${clock(t)}`}
            >
              {part.id}
            </button>
          );
        }
        if (part.kind === "link") {
          return (
            <a
              key={i}
              href={part.href}
              target="_blank"
              rel="noreferrer"
              className="text-gold underline decoration-gold/40 underline-offset-2 transition-colors hover:decoration-gold"
            >
              {withMarks(part.text, part.marks)}
            </a>
          );
        }
        return <span key={i}>{withMarks(part.text, part.marks)}</span>;
      })}
    </>
  );
}

/** 单张画面：点击回到视频对应时间；帧被清理或缺失时不渲染 */
function ArticleFrame({
  taskId,
  frameId,
  tSec,
  caption,
  times,
  onSeek,
  onAskFrame,
}: {
  taskId: string;
  frameId: string;
  tSec: number;
  caption?: string;
  times: Map<string, number>;
  onSeek: (t: number) => void;
  onAskFrame?: (frameId: string) => void;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <figure className="overflow-hidden rounded-xl border border-tint/10 bg-tint/[0.02]">
      <button
        type="button"
        onClick={() => onSeek(tSec)}
        title={`回到 ${clock(tSec)}`}
        className="block w-full"
      >
        <Image
          src={`/api/tasks/${taskId}/frames/${frameId}`}
          alt={caption ?? `画面 ${frameId}`}
          width={1280}
          height={720}
          unoptimized
          loading="lazy"
          className="aspect-video w-full object-cover"
          onError={() => setFailed(true)}
        />
      </button>
      <figcaption className="flex items-start justify-between gap-3 px-3.5 py-2 text-[11px] leading-relaxed text-paper-faint">
        <span className="min-w-0 flex-1 text-paper-dim">
          {caption ? <InlineText text={caption} times={times} onSeek={onSeek} /> : frameId.toUpperCase()}
        </span>
        <span className="shrink-0">{clock(tSec)}</span>
        {onAskFrame ? (
          <button
            type="button"
            onClick={() => onAskFrame(frameId)}
            title={`就 ${frameId.toUpperCase()} 这张画面提问`}
            className="shrink-0 rounded-md border border-gold/30 bg-gold/10 px-1.5 py-0.5 font-mono text-[10px] text-gold transition-colors hover:bg-gold/20"
          >
            问这张画面
          </button>
        ) : null}
      </figcaption>
    </figure>
  );
}

export function ArticleBlockView({
  taskId,
  block,
  times,
  onSeek,
  onAskFrame,
}: {
  taskId: string;
  block: ArticleBlock;
  times: Map<string, number>;
  onSeek: (t: number) => void;
  onAskFrame?: (frameId: string) => void;
}) {
  switch (block.type) {
    case "paragraph":
      // 中文正文：稍大的字号 + 更松的行距 + 两端对齐，避免长段落"糊成一团"
      return (
        <p className="text-[15px] leading-[1.9] text-paper-dim lg:text-base [text-align:justify] [text-justify:inter-ideograph]">
          <InlineText text={block.text} times={times} onSeek={onSeek} />
        </p>
      );
    case "quote":
      return (
        <blockquote className="rounded-r-xl border-l-2 border-gold/50 bg-tint/[0.03] px-4 py-3 text-[14px] leading-[1.85] text-paper-dim">
          <InlineText text={block.text} times={times} onSeek={onSeek} />
        </blockquote>
      );
    case "list": {
      const List = block.ordered ? "ol" : "ul";
      return (
        <List
          className={`space-y-1.5 pl-5 text-[15px] leading-[1.85] text-paper-dim marker:text-gold/70 ${
            block.ordered ? "list-decimal" : "list-disc"
          }`}
        >
          {block.items.map((item, i) => (
            <li key={i}>
              <InlineText text={item} times={times} onSeek={onSeek} />
            </li>
          ))}
        </List>
      );
    }
    case "code":
      return (
        <div className="overflow-hidden rounded-xl border border-tint/10 bg-ink-950/80">
          {block.lang ? (
            <p className="border-b border-tint/5 px-3 py-1 font-mono text-[10px] tracking-wider text-paper-faint">
              {block.lang}
            </p>
          ) : null}
          <pre className="overflow-x-auto p-3.5 font-mono text-[12px] leading-[1.75] text-paper-dim">
            <code>{block.text}</code>
          </pre>
        </div>
      );
    case "table":
      return (
        <figure className="overflow-hidden rounded-xl border border-tint/10">
          <div className="overflow-x-auto">
            <table className="w-full min-w-max border-collapse text-left text-[13px]">
              <thead className="bg-tint/5 text-paper">
                <tr>
                  {block.header.map((cell, i) => (
                    <th key={i} className="whitespace-nowrap px-3.5 py-2.5 font-medium">
                      <InlineText text={cell} times={times} onSeek={onSeek} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="text-paper-dim">
                {block.rows.map((row, ri) => (
                  <tr key={ri} className="border-t border-tint/5 odd:bg-tint/[0.02]">
                    {row.map((cell, ci) => (
                      <td key={ci} className="px-3.5 py-2.5 align-top leading-[1.7]">
                        <InlineText text={cell} times={times} onSeek={onSeek} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {block.caption ? (
            <figcaption className="border-t border-tint/5 px-3.5 py-2 text-[11px] leading-relaxed text-paper-faint">
              <InlineText text={block.caption} times={times} onSeek={onSeek} />
            </figcaption>
          ) : null}
        </figure>
      );
    case "figure": {
      const tSec = times.get(block.frameId);
      if (tSec === undefined) return null;
      return (
        <ArticleFrame
          taskId={taskId}
          frameId={block.frameId}
          tSec={tSec}
          caption={block.caption}
          times={times}
          onSeek={onSeek}
          onAskFrame={onAskFrame}
        />
      );
    }
  }
}
