"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { Ban, Loader, MessageCircleQuestion, RotateCcw, Send, X } from "lucide-react";
import { clock } from "@/lib/time";
import { RequestIdLine } from "./request-id";

/** GET /qa 的轮投影（09 号票 P3）：老数据按相邻对合成，不报错 */
interface QaTurnAnswer {
  status: "completed" | "canceled" | "failed";
  text: string;
  citations: Array<{ segmentIndex: number; start: number; end: number; quote: string }> | null;
  limitations: string[] | null;
  error: string | null;
  /** 该轮失败时的请求追踪编号（服务端落库投影），排障用 */
  requestId: string | null;
}

interface QaTurn {
  turnId: string;
  question: string;
  context: { kind: "section" | "transcript" | "frame" } | null;
  answer: QaTurnAnswer | null;
  retryable: boolean;
}

export function QaPanel({
  taskId,
  videoRef,
}: {
  taskId: string;
  videoRef: RefObject<HTMLVideoElement | null>;
}) {
  const [turns, setTurns] = useState<QaTurn[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 最近一次请求的追踪编号：仅用于本次会话的错误横幅，
  // 历史失败轮的编号由服务端投影（answer.requestId）提供
  const [requestId, setRequestId] = useState<string | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const [streamText, setStreamText] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const refresh = () =>
    fetch(`/api/tasks/${taskId}/qa`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { turns?: QaTurn[] } | null) => {
        if (data?.turns) setTurns(data.turns);
      })
      .catch(() => {});

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, streamText]);

  // 卸载时断开在飞的 SSE：服务端经 req.signal 落 canceled
  useEffect(() => () => abortRef.current?.abort(), []);

  const seek = (t: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = t;
    void video.play().catch(() => {});
  };

  const consumeStream = async (res: Response, aborted: () => boolean): Promise<"done" | "error" | "aborted"> => {
    if (!res.ok || !res.body) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      setRequestId(res.headers.get("x-request-id"));
      setError(data?.error ?? `提问失败（${res.status}）`);
      return "error";
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
        if (event === "delta") {
          setStreamText((cur) => cur + String(data.delta ?? ""));
        } else if (event === "done") {
          return "done";
        } else if (event === "error") {
          if (aborted() || data.code === "canceled") return "aborted";
          setRequestId(
            typeof data.request_id === "string" ? data.request_id : res.headers.get("x-request-id"),
          );
          setError(String(data.message ?? "提问失败"));
          return "error";
        }
      }
    }
    // 流提前结束（未收到 done/error）＝连接被掐断：刷新读服务端落好的 canceled 状态
    return aborted() ? "aborted" : "error";
  };

  const runTurn = async (payload: { question: string; retryOfTurnId?: string }) => {
    setBusy(true);
    setError(null);
    setRequestId(null);
    setPendingQuestion(payload.question);
    setStreamText("");
    setQuestion("");
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      const url = payload.retryOfTurnId
        ? `/api/tasks/${taskId}/qa/${payload.retryOfTurnId}/retry`
        : `/api/tasks/${taskId}/qa`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload.retryOfTurnId ? {} : { question: payload.question }),
        signal: abort.signal,
      });
      const outcome = await consumeStream(res, () => abort.signal.aborted);
      // 轮状态在服务端落定（done→completed、断流→canceled/failed）：
      // 无论哪种结局都刷新，把终态轮换回列表，流式正文随 finally 清空不丢内容
      if (outcome !== "aborted") await refresh();
    } catch (err) {
      if (abort.signal.aborted) {
        await refresh();
      } else {
        setError(err instanceof Error ? err.message : String(err));
        await refresh();
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
      setPendingQuestion(null);
      setStreamText("");
    }
  };

  const ask = async () => {
    const text = question.trim();
    if (!text || busy) return;
    await runTurn({ question: text });
  };

  const stop = () => abortRef.current?.abort();

  const retry = async (turnId: string, questionText: string) => {
    if (busy) return;
    await runTurn({ question: questionText, retryOfTurnId: turnId });
  };

  const statusIcon = (status: QaTurnAnswer["status"]) =>
    status === "completed" ? null : status === "canceled" ? (
      <span className="inline-flex items-center gap-1 font-mono text-[10px] text-paper-faint">
        <Ban className="size-3" strokeWidth={1.5} />
        已停止
      </span>
    ) : (
      <span className="inline-flex items-center gap-1 font-mono text-[10px] text-danger/90">
        <X className="size-3" strokeWidth={1.5} />
        失败
      </span>
    );

  return (
    <div className="glass flex h-[calc(100svh-170px)] min-h-[420px] flex-col rounded-2xl">
      <div className="flex shrink-0 items-center justify-between border-b border-tint/5 px-5 py-3">
        <p className="flex items-center gap-2 font-mono text-[10px] tracking-widest text-paper-faint">
          <MessageCircleQuestion className="size-3.5" strokeWidth={1.5} />
          围绕视频提问
        </p>
        <span className="font-mono text-[10px] text-paper-faint">{turns.length} 轮</span>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-auto px-5 py-4">
        {turns.length === 0 && !busy ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <MessageCircleQuestion className="size-7 text-paper-faint" strokeWidth={1.5} />
            <p className="text-sm text-paper-dim">问点什么</p>
            <p className="max-w-[240px] text-xs leading-relaxed text-paper-faint">
              回答会标出转写稿中的出处，点击编号即可跳到视频对应时间。
            </p>
          </div>
        ) : null}

        {turns.map((turn) => (
          <div key={turn.turnId} className="space-y-2">
            <div className="flex justify-end">
              <p className="max-w-[85%] rounded-2xl rounded-br-sm border border-tint/10 bg-tint/[0.04] px-3.5 py-2 text-xs leading-relaxed text-paper">
                {turn.question}
              </p>
            </div>

            {turn.answer ? (
              <div className="space-y-2">
                <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-paper-dim">
                  {turn.answer.text || "（未产出内容）"}
                </p>
                <div className="flex items-center gap-2">
                  {statusIcon(turn.answer.status)}
                  {turn.answer.citations && turn.answer.citations.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {turn.answer.citations.map((c) => (
                        <button
                          key={c.segmentIndex}
                          type="button"
                          onClick={() => seek(c.start)}
                          title={c.quote}
                          className="inline-flex items-center gap-1 rounded-md border border-gold/30 bg-gold/10 px-1.5 py-0.5 font-mono text-[10px] text-gold transition-colors hover:bg-gold/20"
                        >
                          {clock(c.start)}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
                {turn.answer.status === "failed" ? (
                  <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-[11px] leading-relaxed text-danger/90">
                    <X className="mt-0.5 size-3 shrink-0" strokeWidth={1.5} />
                    <span className="min-w-0 break-words">
                      {turn.answer.error ?? "回答失败"}
                      <RequestIdLine id={turn.answer.requestId} />
                    </span>
                  </div>
                ) : null}
                {turn.answer.limitations && turn.answer.limitations.length > 0 ? (
                  <div className="rounded-lg border border-gold/20 bg-gold/5 px-3 py-2">
                    <p className="font-mono text-[9px] tracking-widest text-gold/70">未确认之处</p>
                    <ul className="mt-1 space-y-0.5 text-[11px] leading-relaxed text-paper-faint">
                      {turn.answer.limitations.map((l, i) => (
                        <li key={i}>· {l}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="font-mono text-[10px] text-paper-faint">已中断，未产出回答</p>
            )}

            {turn.retryable && !busy ? (
              <button
                type="button"
                onClick={() => void retry(turn.turnId, turn.question)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-tint/15 px-2.5 py-1 font-mono text-[10px] text-paper-dim transition-colors hover:border-gold/40 hover:text-gold"
              >
                <RotateCcw className="size-3" strokeWidth={1.5} />
                重新回答
              </button>
            ) : null}
          </div>
        ))}

        {busy ? (
          <div className="space-y-2">
            {pendingQuestion ? (
              <div className="flex justify-end">
                <p className="max-w-[85%] rounded-2xl rounded-br-sm border border-tint/10 bg-tint/[0.04] px-3.5 py-2 text-xs leading-relaxed text-paper-faint">
                  {pendingQuestion}
                </p>
              </div>
            ) : null}
            <p className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-paper-faint">
              {streamText || "检索相关段落…"}
            </p>
          </div>
        ) : null}

        {error ? (
          <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-[11px] leading-relaxed text-danger/90">
            <X className="mt-0.5 size-3 shrink-0" strokeWidth={1.5} />
            <span className="min-w-0 break-words">
              {error}
              <RequestIdLine id={requestId} />
            </span>
          </div>
        ) : null}
        <div ref={bottomRef} />
      </div>

      <div className="shrink-0 border-t border-tint/5 p-3">
        <div className="flex items-end gap-2">
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value.slice(0, 1000))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void ask();
              }
            }}
            rows={2}
            placeholder="例如：3:05 那里讲的是什么？"
            className="min-h-[44px] flex-1 resize-none rounded-xl border border-tint/10 bg-ink-950/60 px-3 py-2 text-xs leading-relaxed text-paper outline-none transition-colors placeholder:text-paper-faint focus:border-gold/50"
          />
          {busy ? (
            <button
              type="button"
              onClick={stop}
              title="停止回答"
              className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-danger/40 bg-danger/10 text-danger transition-colors hover:bg-danger/20"
            >
              <Ban className="size-4" strokeWidth={1.5} />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void ask()}
              disabled={!question.trim()}
              className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-gold/40 bg-gold/10 text-gold transition-colors hover:bg-gold/20 disabled:opacity-40"
            >
              <Send className="size-4" strokeWidth={1.5} />
            </button>
          )}
        </div>
        {busy ? (
          <p className="mt-1.5 flex items-center gap-1 font-mono text-[9px] text-paper-faint">
            <Loader className="size-2.5 animate-spin" strokeWidth={1.5} />
            回答中，可点击右侧按钮停止
          </p>
        ) : null}
      </div>
    </div>
  );
}