"use client";

import { useEffect, useState } from "react";

/**
 * 选区浮层（09 号票 P1）：文章区与文稿区共用。
 * 监听容器内的 selection，选区非空时在选区右端弹「问这段」按钮；
 * 点击后把选中文本交给 onAsk，并清除选区。
 */
export function SelectionPopover({
  containerRef,
  onAsk,
}: {
  containerRef: React.RefObject<HTMLElement | null>;
  onAsk: (quote: string) => void;
}) {
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const [quote, setQuote] = useState("");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onSelect = () => {
      const sel = window.getSelection();
      const text = sel?.toString().trim() ?? "";
      if (!sel || sel.isCollapsed || !text || text.length > 200) {
        setAnchor(null);
        setQuote("");
        return;
      }
      // 选区必须落在容器内
      const range = sel.getRangeAt(0);
      if (!container.contains(range.commonAncestorContainer)) {
        setAnchor(null);
        setQuote("");
        return;
      }
      const rect = range.getBoundingClientRect();
      const host = container.getBoundingClientRect();
      setAnchor({ top: rect.top - host.top, left: rect.right - host.left });
      setQuote(text);
    };
    const clear = () => setAnchor(null);

    document.addEventListener("selectionchange", onSelect);
    window.addEventListener("scroll", clear, true);
    return () => {
      document.removeEventListener("selectionchange", onSelect);
      window.removeEventListener("scroll", clear, true);
    };
  }, [containerRef]);

  if (!anchor) return null;
  return (
    <button
      type="button"
      onMouseDown={(e) => {
        // 阻止点击按钮时清掉 selection（虽然已捕获 quote，保持选区高亮更自然）
        e.preventDefault();
        onAsk(quote);
        window.getSelection()?.removeAllRanges();
        setAnchor(null);
      }}
      className="absolute z-20 -translate-y-full rounded-lg border border-gold/50 bg-ink-950/95 px-2.5 py-1.5 font-mono text-[10px] tracking-wider text-gold shadow-lg shadow-black/30 transition-colors hover:bg-gold/10"
      style={{ top: anchor.top, left: anchor.left }}
    >
      问这段
    </button>
  );
}
