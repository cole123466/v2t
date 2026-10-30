"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { MindMapNode } from "@/server/article";
import {
  indexTree,
  overviewMind,
  MIND_TOPICS_PER_PAGE,
  NARROW_BREAKPOINT,
} from "@/lib/mind-model";

/**
 * 星形导图概览（06 号票 M1）：替换旧的灰字列表。
 * 根居中、主题左右分列，连线为贝塞尔曲线；
 * 分组节点点击展开/收起，叶子点击跳章节（滚动由父级容器的 scrollToSection 完成）。
 */
export function MindOverview({
  nodes,
  title,
  sectionIds,
  activeSection,
  onJump,
}: {
  nodes: MindMapNode[];
  title: string;
  sectionIds: readonly string[];
  activeSection: string | null;
  onJump: (sectionId: string) => void;
}) {
  const index = useMemo(
    () => indexTree(nodes, title, new Set(sectionIds)),
    [nodes, title, sectionIds],
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0);
  const [narrow, setNarrow] = useState(false);

  const ref = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 鼠标按住拖拽平移（触摸端走原生滚动，不拦截）。拖过阈值后本次 click 作废，
  // 避免平移结束时误触节点跳转。
  const dragRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const movedRef = useRef(false);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    const el = scrollRef.current;
    if (!el) return;
    dragRef.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
    movedRef.current = false;
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    const el = scrollRef.current;
    if (!d || !el) return;
    if (!movedRef.current) {
      // 越过阈值才开始平移并重锚起点；此前不动画面，click 保持有效
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) <= 4) return;
      movedRef.current = true;
      // 真正开始拖拽才捕获指针，按下时不吞节点 click
      e.currentTarget.setPointerCapture(e.pointerId);
      d.x = e.clientX;
      d.y = e.clientY;
      d.left = el.scrollLeft;
      d.top = el.scrollTop;
      return;
    }
    el.scrollLeft = d.left - (e.clientX - d.x);
    el.scrollTop = d.top - (e.clientY - d.y);
  };
  const endDrag = () => {
    dragRef.current = null;
    setDragging(false);
    // click 在 pointerup 之后同步派发，拖拽后的误点 click 要拦；
    // 延迟一拍复位，不影响之后的触摸点按与键盘 Enter
    window.setTimeout(() => {
      movedRef.current = false;
    }, 0);
  };

  // pointerup 被吞（窗口失焦等）时靠 lostpointercapture/blur 兜底，
  // 否则 dragRef 残留，之后鼠标悬停也会平移、光标卡在 grabbing
  useEffect(() => {
    const onBlur = () => {
      dragRef.current = null;
      setDragging(false);
    };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, []);

  // 560px 断点按容器实际宽度走，而不是 window：概览嵌在正文栏里
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      setNarrow(entry.contentRect.width < NARROW_BREAKPOINT);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const root = index.nodes.get(index.rootId);
  const topicCount = root?.childIds.length ?? 0;
  const pageCount = Math.max(1, Math.ceil(topicCount / MIND_TOPICS_PER_PAGE));
  // 翻页或数据更换后页码可能越界，渲染时钳回有效区间
  const safePage = Math.min(page, pageCount - 1);

  const layout = useMemo(
    () => overviewMind(index, collapsed, safePage, narrow),
    [index, collapsed, safePage, narrow],
  );

  const toggle = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div
      ref={ref}
      className="mt-5 rounded-xl border border-tint/5 bg-tint/[0.02] p-3"
    >
      <div className="mb-2 flex items-center justify-between">
        <p className="font-mono text-[10px] tracking-widest text-paper-faint">内容导图</p>
        {pageCount > 1 ? (
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="上一组"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              className="rounded-md border border-tint/10 p-0.5 text-paper-faint transition-colors hover:text-gold disabled:opacity-30"
            >
              <ChevronLeft className="size-3" strokeWidth={1.5} />
            </button>
            <span className="font-mono text-[10px] text-paper-faint">
              {page * MIND_TOPICS_PER_PAGE + 1}–
              {Math.min((page + 1) * MIND_TOPICS_PER_PAGE, topicCount)} / {topicCount}
            </span>
            <button
              type="button"
              aria-label="下一组"
              disabled={page >= pageCount - 1}
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              className="rounded-md border border-tint/10 p-0.5 text-paper-faint transition-colors hover:text-gold disabled:opacity-30"
            >
              <ChevronRight className="size-3" strokeWidth={1.5} />
            </button>
          </div>
        ) : null}
      </div>

      <div
        ref={scrollRef}
        className={`overflow-x-auto ${dragging ? "cursor-grabbing" : "cursor-grab"}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onClickCapture={(e) => {
          if (movedRef.current) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
      >
        <svg
          role="img"
          aria-label="内容导图概览"
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          className="block w-full select-none"
          style={{ minWidth: layout.width }}
        >
          {layout.edges.map((edge) => (
            <path
              key={edge.id}
              d={edge.path}
              fill="none"
              className="stroke-tint/20"
              strokeWidth={1.5}
            />
          ))}
          {layout.nodes.map((node) => {
            const isRoot = node.depth === 0;
            const hasChildren = node.sectionId === null;
            const active = node.sectionId !== null && node.sectionId === activeSection;
            const jump = () => {
              if (node.sectionId) {
                onJump(node.sectionId);
              } else if (!isRoot) {
                toggle(node.id);
              }
            };
            return (
              <g
                key={node.id}
                role={isRoot ? undefined : "button"}
                tabIndex={isRoot ? undefined : 0}
                aria-expanded={hasChildren && !isRoot ? !collapsed.has(node.id) : undefined}
                onClick={jump}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    jump();
                  }
                }}
                className={isRoot ? "cursor-default" : "cursor-pointer"}
              >
                <rect
                  x={node.x - node.w / 2}
                  y={node.y - node.h / 2}
                  width={node.w}
                  height={node.h}
                  rx={isRoot ? 12 : 8}
                  className={
                    isRoot
                      ? "fill-gold/15 stroke-gold/40"
                      : active
                        ? "fill-gold/10 stroke-gold/60"
                        : "fill-tint/[0.04] stroke-tint/15"
                  }
                  strokeWidth={1}
                />
                <text
                  x={node.x}
                  y={node.y}
                  textAnchor="middle"
                  dominantBaseline="central"
                  className={
                    isRoot
                      ? "fill-gold font-display text-[13px] font-semibold"
                      : active
                        ? "fill-gold text-[12px]"
                        : hasChildren
                          ? "fill-paper text-[12px]"
                          : "fill-paper-dim text-[12px]"
                  }
                >
                  {node.label.length > 16 ? `${node.label.slice(0, 15)}…` : node.label}
                </text>
                {hasChildren && !isRoot ? (
                  <text
                    x={node.x + node.w / 2 - 10}
                    y={node.y}
                    textAnchor="middle"
                    dominantBaseline="central"
                    className="fill-paper-faint text-[10px]"
                  >
                    {collapsed.has(node.id) ? "…" : "–"}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
