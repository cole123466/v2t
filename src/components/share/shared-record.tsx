"use client";

import { useEffect, useRef, useState } from "react";
import { Activity, Check, FileText, Loader, X } from "lucide-react";
import type { ArticleBlock } from "@/server/article";
import { ArticleBlockView, InlineText } from "@/components/workbench/article-block";
import type { SharePayload } from "@/server/shares";

/**
 * 只读分享页（11 号票）：图文 + 可折叠处理过程。
 * 无追问 / 停止 / 重试 / 导出入口；请求不带任何 cookie（credentials: "omit"），
 * 即便访问者自己也有设备 cookie 也不让分享页串用。
 */

const FETCH_INIT: RequestInit = {
  credentials: "omit",
  cache: "no-store",
  referrerPolicy: "no-referrer",
};

const POLL_MS = 12_000;

function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function SharedRecord({ token }: { token: string }) {
  const [payload, setPayload] = useState<SharePayload | null>(null);
  const [gone, setGone] = useState(false);
  const [showSteps, setShowSteps] = useState(false);
  // revoked 锁：404 后停止一切轮询
  const revokedRef = useRef(false);

  useEffect(() => {
    const load = () =>
      fetch(`/api/share/${token}`, FETCH_INIT)
        .then((r) => {
          if (r.status === 404) {
            revokedRef.current = true;
            setGone(true);
            return null;
          }
          return r.ok ? (r.json() as Promise<SharePayload>) : null;
        })
        .then((data) => {
          if (data) setPayload(data);
        })
        .catch(() => {});
    void load();
    const timer = setInterval(() => {
      if (revokedRef.current || document.hidden) return;
      void load();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [token]);

  if (gone) {
    return (
      <div className="glass flex flex-col items-center gap-3 rounded-2xl border-dashed p-10 text-center">
        <X className="size-7 text-paper-faint" strokeWidth={1.5} />
        <p className="text-sm text-paper-dim">这条分享已不可用或已被取消</p>
      </div>
    );
  }
  if (!payload) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader className="size-5 animate-spin text-paper-faint" strokeWidth={1.5} />
      </div>
    );
  }

  const article = payload.article;
  const streaming = article.status === "streaming";
  const failed = article.status === "failed" || article.status === "interrupted";

  return (
    <div className="mx-auto w-full max-w-[52rem] space-y-5">
      <div className="glass rounded-2xl px-5 py-3">
        <p className="font-mono text-[10px] tracking-widest text-paper-faint">
          分享的处理记录 · 只读 · 图文与处理过程
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-paper-faint">
          获得链接的人可以查看这篇图文和处理过程。追问不会公开。
        </p>
      </div>

      <div className="glass rounded-2xl p-6">
        <div className="mx-auto w-full max-w-[44rem]">
          <h2 className="font-display text-2xl font-semibold leading-snug text-paper">
            {article.title ?? "未命名的图文"}
          </h2>
          <p className="mt-1.5 font-mono text-[10px] tracking-wider text-paper-faint">
            {article.detailLevel === "concise"
              ? "速览"
              : article.detailLevel === "detailed"
                ? "深入"
                : "标准"}
            {article.content ? ` · ${article.content.sections.length} 章` : ""}
            {` · 生成模型 ${article.model}`}
          </p>

          {streaming ? (
            <p className="mt-4 flex items-center gap-2 rounded-xl border border-gold/20 bg-gold/5 px-3 py-2 font-mono text-[10px] tracking-wider text-gold/90">
              <Loader className="size-3 animate-spin" strokeWidth={1.5} />
              仍在处理中，图文完成后会自动显示
            </p>
          ) : null}
          {failed ? (
            <p className="mt-4 rounded-xl border border-danger/20 bg-danger/5 px-3 py-2 text-[11px] leading-relaxed text-danger/80">
              这次处理未能完成。
            </p>
          ) : null}

          {article.content ? (
            <div className="mt-6 space-y-9">
              {article.content.sections.map((section, index) => (
                <section
                  key={section.id}
                  className={index > 0 ? "border-t border-tint/[0.07] pt-8" : ""}
                >
                  <h3 className="flex items-baseline gap-2.5 font-display text-[19px] font-semibold leading-snug text-paper">
                    <span className="font-mono text-[11px] tracking-widest text-gold/80">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    {section.title}
                  </h3>
                  <div className="mt-3 space-y-3.5">
                    {section.blocks.map((block: ArticleBlock, i) => (
                      <ShareBlock key={i} block={block} token={token} frames={payload.frames} />
                    ))}
                  </div>
                </section>
              ))}
              {article.content.limitations.length > 0 ? (
                <div className="rounded-xl border border-gold/20 bg-gold/5 p-4">
                  <p className="font-mono text-[10px] tracking-widest text-gold/80">未确认之处</p>
                  <ul className="mt-2 space-y-1.5 text-[13px] leading-relaxed text-paper-dim">
                    {article.content.limitations.map((l, i) => (
                      <li key={i} className="flex gap-2">
                        <span className="text-gold/60">·</span>
                        <span className="min-w-0">
                          <InlineText text={l.text} times={new Map()} onSeek={() => {}} />
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {payload.steps.length > 0 ? (
        <div className="glass rounded-2xl">
          <button
            type="button"
            onClick={() => setShowSteps((v) => !v)}
            className="flex w-full items-center justify-between px-5 py-3 text-left"
          >
            <span className="flex items-center gap-2 font-mono text-[10px] tracking-widest text-paper-faint">
              <Activity className="size-3.5" strokeWidth={1.5} />
              处理过程（{payload.steps.length} 步）
            </span>
            <span className="font-mono text-[10px] text-gold/80">
              {showSteps ? "收起" : "展开"}
            </span>
          </button>
          {showSteps ? (
            <ol className="relative space-y-0.5 border-t border-tint/5 px-5 py-4 pl-9">
              {payload.steps.map((s, i) => (
                <li key={i} className="relative py-2">
                  <span
                    className={`absolute -left-[19px] top-3 flex size-3 items-center justify-center rounded-full border ${
                      s.endedAt === null
                        ? "border-gold/50"
                        : s.ok
                          ? "border-positive/50"
                          : "border-danger/50"
                    } bg-ink-950`}
                  >
                    {s.endedAt === null ? (
                      <Loader className="size-1.5 animate-spin text-gold" strokeWidth={2} />
                    ) : s.ok ? (
                      <Check className="size-2 text-positive/90" strokeWidth={2.5} />
                    ) : (
                      <X className="size-2 text-danger/90" strokeWidth={2.5} />
                    )}
                  </span>
                  <p className="text-xs text-paper-dim">{s.title ?? s.phase ?? "步骤"}</p>
                  {s.message ? (
                    <p className="mt-1 break-words text-[11px] leading-relaxed text-paper-faint">
                      {s.message}
                    </p>
                  ) : null}
                  <p className="mt-1 font-mono text-[9px] tracking-wider text-paper-faint/70">
                    {new Date(s.startedAt).toLocaleString("zh-CN")}
                  </p>
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      ) : null}

      <p className="flex items-center justify-center gap-2 pb-6 font-mono text-[10px] tracking-wider text-paper-faint/70">
        <FileText className="size-3" strokeWidth={1.5} />
        只读快照 · 追问等私人内容不会出现在分享页
      </p>
    </div>
  );
}

/** 分享页的块渲染：figure 走公开帧代理，时间引用不可跳转播放器 */
function ShareBlock({
  block,
  token,
  frames,
}: {
  block: ArticleBlock;
  token: string;
  frames: SharePayload["frames"];
}) {
  const times = new Map(frames.filter((f) => f.tSec !== null).map((f) => [f.id, f.tSec as number]));
  switch (block.type) {
    case "figure": {
      if (!frames.some((f) => f.id === block.frameId)) return null;
      const tSec = times.get(block.frameId) ?? 0;
      return (
        <figure className="overflow-hidden rounded-xl border border-tint/10 bg-tint/[0.02]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/share/${token}/frames/${block.frameId}`}
            alt={block.caption ?? `画面 ${block.frameId}`}
            loading="lazy"
            className="aspect-video w-full object-cover"
          />
          <figcaption className="flex items-start justify-between gap-3 px-3.5 py-2 text-[11px] leading-relaxed text-paper-faint">
            <span className="min-w-0 flex-1 text-paper-dim">
              {block.caption ?? block.frameId.toUpperCase()}
            </span>
            <span className="shrink-0">{clock(tSec)}</span>
          </figcaption>
        </figure>
      );
    }
    default:
      return (
        <ArticleBlockView
          taskId=""
          block={block}
          times={times}
          // 分享页没有播放器：时间引用只展示，不跳转
          onSeek={() => {}}
        />
      );
  }
}
