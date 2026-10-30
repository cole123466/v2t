"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
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
 * 画布支持指针拖拽平移；fullscreen=true 时填满宿主高度（全屏弹层用）。
 */
export function MindOverview({
  nodes,
  title,
  sectionIds,
  activeSection,
  onJump,
  fullscreen = false,
}: {
  nodes: MindMapNode[];
  title: string;
  sectionIds: readonly string[];
  activeSection: string | null;
  onJump: (sectionId: string) => void;
  fullscreen?: boolean;
}) {
  const index = useMemo(
    () => indexTree(nodes, title, new Set(sectionIds)),
    [nodes, title, sectionIds],
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0);
  const [narrow, setNarrow] = useState(false);

  const ref = useRef<HTMLDivElement>(null);

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

  // 拖拽平移：viewBox 原点跟着指针走；didDrag 用于区分拖拽与点击
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const didDragRef = useRef(false);

  // 翻页/折叠/数据变化后布局重建，视口复位（渲染期调整 state，避免 effect 级联渲染）
  const [pannedLayout, setPannedLayout] = useState(layout);
  if (pannedLayout !== layout) {
    setPannedLayout(layout);
    setPan({ x: 0, y: 0 });
  }

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: pan.x, oy: pan.y };
    didDragRef.current = false;
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) {
      // 达到拖拽阈值才捕获指针：按下即捕获会把 click 目标改到 svg，导致节点点击失效
      if (!didDragRef.current) e.currentTarget.setPointerCapture(e.pointerId);
      didDragRef.current = true;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const scale = layout.width / rect.width;
    setPan({ x: drag.ox - dx * scale, y: drag.oy - dy * scale });
  };

  const endDrag = () => {
    dragRef.current = null;
  };

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
      className={
        fullscreen
          ? "flex h-full min-h-0 flex-col rounded-xl border border-tint/5 bg-tint/[0.02] p-3"
          : "mt-5 rounded-xl border border-tint/5 bg-tint/[0.02] p-3"
      }
    >
      <div className="mb-2 flex items-center justify-between">
        <p className="font-mono text-[10px] tracking-widest text-paper-faint">
          内容导图
          <span className="ml-2 hidden font-sans tracking-normal sm:inline">
            拖拽平移 · 双击复位
          </span>
        </p>
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

      <div className={fullscreen ? "min-h-0 flex-1" : "overflow-hidden"}>
        <svg
          role="img"
          aria-label="内容导图概览"
          width={fullscreen ? undefined : "100%"}
          height={fullscreen ? "100%" : undefined}
          viewBox={`${pan.x} ${pan.y} ${layout.width} ${layout.height}`}
          className={
            (fullscreen ? "h-full w-full " : "block w-full ") +
            "cursor-grab touch-none select-none active:cursor-grabbing"
          }
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={() => setPan({ x: 0, y: 0 })}
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
                onClick={() => {
                  if (didDragRef.current) return; // 拖拽结束不当作点击
                  jump();
                }}
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