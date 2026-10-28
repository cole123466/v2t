"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { ChevronDown, ChevronRight, Eye, Loader, RotateCcw, ScanSearch, X } from "lucide-react";

/**
 * 10 号票：审稿旁栏（可折叠卡，不新开弹窗）。
 * 语义边界：只产「意见」，禁止通过/拒绝/合格措辞；正文保持原样。
 */

export interface ReviewFinding {
  sectionId: string;
  problem: string;
  suggestion: string;
}

export interface ArticleReviewView {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "canceled";
  summary: string | null;
  findings: ReviewFinding[];
  error: string | null;
  createdAt: string;
}

const STATUS_LABEL: Record<ArticleReviewView["status"], string> = {
  queued: "排队中",
  running: "审核中",
  completed: "已完成",
  failed: "未完成",
  canceled: "已取消",
};

/** 状态徽标文案：没有可展示记录时显示「未审核」 */
function badge(latest: ArticleReviewView | undefined): string {
  if (!latest) return "未审核";
  return STATUS_LABEL[latest.status] ?? "未审核";
}

export function ReviewSidebar({
  taskId,
  articleId,
  articleReady,
  scrollRef,
  onJumpSection,
}: {
  taskId: string;
  articleId: string;
  /** done 文章才可发起（铁律：不因审稿改稿，也不审未完成稿） */
  articleReady: boolean;
  /** 正文滚动容器：定位用容器内滚动（不用 scrollIntoView） */
  scrollRef: RefObject<HTMLDivElement | null>;
  onJumpSection?: (sectionId: string) => void;
}) {
  const [reviews, setReviews] = useState<ArticleReviewView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const loadedRef = useRef<string | null>(null);
  // 竞态防护：切文章后旧文章的在途响应作废
  const articleIdRef = useRef(articleId);

  const load = async () => {
    const current = articleIdRef.current;
    const res = await fetch(`/api/tasks/${taskId}/articles/${articleId}/reviews`);
    if (!res.ok) return;
    const data = (await res.json()) as { reviews?: ArticleReviewView[] };
    if (articleIdRef.current !== current) return;
    if (data.reviews) setReviews(data.reviews);
  };

  // 换文章时重新拉取；刷新页面后从持久化记录恢复状态
  useEffect(() => {
    articleIdRef.current = articleId;
    if (loadedRef.current === articleId) return;
    loadedRef.current = articleId;
    setReviews([]);
    void load().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [articleId]);

  // 审核中：轮询 review 列表（进度粒度粗，单次 LLM 调用无增量；轮询比 SSE 少一条订阅线）
  const hasActive = reviews.some((r) => r.status === "queued" || r.status === "running");
  useEffect(() => {
    if (!hasActive) return;
    const timer = setInterval(() => {
      void load().catch(() => {});
    }, 2000);
    return () => {
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasActive, articleId]);

  const latest = reviews[0];
  const reviewInFlight = hasActive;

  const startReview = async () => {
    if (starting || reviewInFlight) return;
    setStarting(true);
    setError(null);
    try {
      const res = await fetch(`/api/tasks/${taskId}/articles/${articleId}/reviews`, { method: "POST" });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(data?.error ?? `发起审核失败（${res.status}）`);
        return;
      }
      await load();
    } catch {
      setError("网络异常，发起审核失败");
    } finally {
      setStarting(false);
    }
  };

  const retry = () => void startReview();

  // 「查看对应章节」：容器内定位（offsetTop - 96），不用 scrollIntoView
  const jumpTo = (sectionId: string) => {
    onJumpSection?.(sectionId);
    const container = scrollRef.current;
    const el = document.getElementById(`section-${sectionId}`);
    if (container && el) {
      container.scrollTo({ top: el.offsetTop - 96, behavior: "smooth" });
    }
  };

  const visible = articleReady || reviews.length > 0;
  if (!visible) return null;

  return (
    <div className="glass shrink-0 rounded-2xl p-4">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-2 font-mono text-[10px] tracking-widest text-paper-faint transition-colors hover:text-paper-dim"
        >
          {expanded ? (
            <ChevronDown className="size-3" strokeWidth={1.5} />
          ) : (
            <ChevronRight className="size-3" strokeWidth={1.5} />
          )}
          <ScanSearch className="size-3.5" strokeWidth={1.5} />
          审稿意见
        </button>
        <div className="flex items-center gap-2">
          {reviews.length > 1 ? (
            <button
              type="button"
              onClick={() => setHistoryOpen((v) => !v)}
              className="font-mono text-[10px] text-paper-faint transition-colors hover:text-paper-dim"
            >
              历史 {reviews.length}
            </button>
          ) : null}
          <span
            className={`rounded-lg border px-2 py-0.5 font-mono text-[10px] ${
              reviewInFlight
                ? "border-gold/40 bg-gold/10 text-gold"
                : latest?.status === "completed"
                  ? "border-tint/10 text-paper-dim"
                  : latest?.status === "failed"
                    ? "border-danger/30 text-danger/80"
                    : "border-tint/10 text-paper-faint"
            }`}
          >
            {badge(latest)}
          </span>
          {articleReady && !reviewInFlight ? (
            latest?.status === "failed" ? (
              <button
                type="button"
                onClick={retry}
                disabled={starting}
                className="inline-flex items-center gap-1 rounded-lg border border-gold/40 bg-gold/10 px-2 py-1 font-mono text-[10px] text-gold transition-colors hover:bg-gold/20 disabled:opacity-50"
              >
                {starting ? (
                  <Loader className="size-3 animate-spin" strokeWidth={1.5} />
                ) : (
                  <RotateCcw className="size-3" strokeWidth={1.5} />
                )}
                重试
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void startReview()}
                disabled={starting}
                className="inline-flex items-center gap-1 rounded-lg border border-gold/40 bg-gold/10 px-2 py-1 font-mono text-[10px] text-gold transition-colors hover:bg-gold/20 disabled:opacity-50"
              >
                {starting ? (
                  <Loader className="size-3 animate-spin" strokeWidth={1.5} />
                ) : (
                  <Eye className="size-3" strokeWidth={1.5} />
                )}
                审核这篇
              </button>
            )
          ) : null}
        </div>
      </div>

      {expanded ? (
        <div className="mt-3">
          {error ? (
            <p className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-[11px] text-danger/90">{error}</p>
          ) : null}

          {reviewInFlight ? (
            <p className="flex items-center gap-2 rounded-xl border border-gold/20 bg-gold/5 px-3 py-2 font-mono text-[10px] tracking-wider text-gold/90">
              <Loader className="size-3 animate-spin" strokeWidth={1.5} />
              正在通读全文并核对引用…
            </p>
          ) : null}

          {!reviewInFlight && !latest && !error ? (
            <p className="text-[11px] leading-relaxed text-paper-faint">
              点「审核这篇」，模型会通读全文并对照转写原文，给出修改意见。正文保持原样。
            </p>
          ) : null}

          {!reviewInFlight && latest?.status === "failed" ? (
            <p className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-[11px] leading-relaxed text-danger/90">
              审核未完成：{latest.error ?? "原因未知"}。正文保持原样，可重试。
            </p>
          ) : null}

          {!reviewInFlight && latest?.status === "completed" ? (
            <>
              <p className="rounded-xl border border-tint/10 bg-tint/[0.02] px-3 py-2 text-[11px] leading-relaxed text-paper-dim">
                以下意见供你核对，正文保持原样。
              </p>
              {latest.summary ? (
                <p className="mt-2 whitespace-pre-wrap text-[12px] leading-relaxed text-paper-dim">{latest.summary}</p>
              ) : null}
              {latest.findings.length > 0 ? (
                <ul className="mt-3 space-y-2.5">
                  {latest.findings.map((f, i) => (
                    <li key={i} className="rounded-xl border border-tint/10 bg-tint/[0.02] px-3 py-2">
                      <p className="text-[12px] leading-relaxed text-paper">{f.problem}</p>
                      {f.suggestion ? (
                        <p className="mt-1 text-[11px] leading-relaxed text-paper-faint">建议：{f.suggestion}</p>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => jumpTo(f.sectionId)}
                        className="mt-1.5 inline-flex items-center gap-1 font-mono text-[10px] text-gold/80 transition-colors hover:text-gold"
                      >
                        查看对应章节 ↗
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : null}

          {historyOpen && reviews.length > 1 ? (
            <div className="mt-3 border-t border-tint/10 pt-2">
              {reviews.slice(1).map((r) => (
                <div key={r.id} className="py-1.5 font-mono text-[10px] text-paper-faint">
                  {new Date(r.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                  {" · "}
                  {STATUS_LABEL[r.status] ?? "未完成"}
                  {r.status === "completed" && r.findings.length > 0 ? ` · ${r.findings.length} 条意见` : ""}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** 状态徽标复用：面板顶部工具行的紧凑入口文案 */
export function ReviewEntryLabel({ hasReviews }: { hasReviews: boolean }) {
  return hasReviews ? "审稿意见" : "审核这篇";
}

export function ReviewErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p className="flex items-center gap-1.5 text-[10px] text-danger/80">
      <X className="size-3" strokeWidth={1.5} />
      {error}
    </p>
  );
}
