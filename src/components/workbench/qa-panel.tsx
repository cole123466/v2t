"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { Loader, MessageCircleQuestion, Send, X } from "lucide-react";
import type { QaMessage } from "@/server/qa";
import { clock } from "@/lib/time";

export function QaPanel({
  taskId,
  videoRef,
}: {
  taskId: string;
  videoRef: RefObject<HTMLVideoElement | null>;
}) {
  const [messages, setMessages] = useState<QaMessage[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const [streamText, setStreamText] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void fetch(`/api/tasks/${taskId}/qa`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { messages?: QaMessage[] } | null) => {
        if (data?.messages) setMessages(data.messages);
      });
  }, [taskId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, streamText]);

  const seek = (t: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = t;
    void video.play().catch(() => {});
  };

  const ask = async () => {
    const text = question.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    setPendingQuestion(text);
    setStreamText("");
    setQuestion("");
    try {
      const res = await fetch(`/api/tasks/${taskId}/qa`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: text }),
      });
      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? `提问失败（${res.status}）`);
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
          if (event === "delta") {
            setStreamText((cur) => cur + String(data.delta ?? ""));
          } else if (event === "done") {
            setMessages((cur) => [...cur, data as unknown as QaMessage]);
          } else if (event === "error") {
            setError(String(data.message ?? "提问失败"));
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setPendingQuestion(null);
      setStreamText("");
    }
  };

  return (
    <div className="glass flex h-[calc(100svh-170px)] min-h-[420px] flex-col rounded-2xl">
      <div className="flex shrink-0 items-center justify-between border-b border-white/5 px-5 py-3">
        <p className="flex items-center gap-2 font-mono text-[10px] tracking-widest text-paper-faint">
          <MessageCircleQuestion className="size-3.5" strokeWidth={1.5} />
          围绕视频提问
        </p>
        <span className="font-mono text-[10px] text-paper-faint">{messages.length / 2 | 0} 轮</span>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-auto px-5 py-4">
        {messages.length === 0 && !busy ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <MessageCircleQuestion className="size-7 text-paper-faint" strokeWidth={1.5} />
            <p className="text-sm text-paper-dim">问点什么</p>
            <p className="max-w-[240px] text-xs leading-relaxed text-paper-faint">
              回答会标出转写稿中的出处，点击编号即可跳到视频对应时间。
            </p>
          </div>
        ) : null}

        {messages.map((message) =>
          message.role === "user" ? (
            <div key={message.id} className="flex justify-end">
              <p className="max-w-[85%] rounded-2xl rounded-br-sm border border-white/10 bg-white/[0.04] px-3.5 py-2 text-xs leading-relaxed text-paper">
                {message.content}
              </p>
            </div>
          ) : (
            <div key={message.id} className="space-y-2">
              <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-paper-dim">
                {message.content}
              </p>
              {message.citations && message.citations.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {message.citations.map((c) => (
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
              {message.limitations && message.limitations.length > 0 ? (
                <div className="rounded-lg border border-gold/20 bg-gold/5 px-3 py-2">
                  <p className="font-mono text-[9px] tracking-widest text-gold/70">未确认之处</p>
                  <ul className="mt-1 space-y-0.5 text-[11px] leading-relaxed text-paper-faint">
                    {message.limitations.map((l, i) => (
                      <li key={i}>· {l}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ),
        )}

        {busy ? (
          <div className="space-y-2">
            {pendingQuestion ? (
              <div className="flex justify-end">
                <p className="max-w-[85%] rounded-2xl rounded-br-sm border border-white/10 bg-white/[0.04] px-3.5 py-2 text-xs leading-relaxed text-paper-faint">
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
            <span className="min-w-0 break-words">{error}</span>
          </div>
        ) : null}
        <div ref={bottomRef} />
      </div>

      <div className="shrink-0 border-t border-white/5 p-3">
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
            className="min-h-[44px] flex-1 resize-none rounded-xl border border-white/10 bg-ink-950/60 px-3 py-2 text-xs leading-relaxed text-paper outline-none transition-colors placeholder:text-paper-faint focus:border-gold/50"
          />
          <button
            type="button"
            onClick={() => void ask()}
            disabled={busy || !question.trim()}
            className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-gold/40 bg-gold/10 text-gold transition-colors hover:bg-gold/20 disabled:opacity-40"
          >
            {busy ? (
              <Loader className="size-4 animate-spin" strokeWidth={1.5} />
            ) : (
              <Send className="size-4" strokeWidth={1.5} />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
