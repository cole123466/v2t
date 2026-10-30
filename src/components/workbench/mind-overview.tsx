"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import type { MindMapNode } from "@/server/article";
import {
  ancestorPath,
  indexTree,
  nodeForSection,
  overviewMind,
  MIND_TOPICS_PER_PAGE,
  NARROW_BREAKPOINT,
} from "@/lib/mind-model";
import { MindReader, type MindTarget } from "./mind-reader";
import { useMindReveal } from "@/hooks/use-mind-reveal";

/**
 * 星形导图概览（对齐 vid-lens MindMap 交互）：
 * 概览只到主题层——点主题打开该分支的阅读弹层（MindReader），
 * 点根节点或「查看完整导图」进入完整阅读器；定位章节由父级 onJump 完成。
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
  const [page, setPage] = useState(0);
  const [narrow, setNarrow] = useState(false);
  // 阅读弹层目标：scope=进入的分支，revision 驱动 MindReader 重聚焦
  const [target, setTarget] = useState<MindTarget | null>(null);
  // 概览入场动画 + 弹层焦点管理
  const diagramRef = useRef<SVGSVGElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const ref = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 鼠标按住拖拽平移（触摸端走原生滚动，不拦截）。拖过阈值后本次 click 作废，
  // 避免平移结束时误触节点跳转。
  const dragRef = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
  const movedRef = useRef(false);
  const [dragging, setDragging] = useState(false);

  // pointerId 贯穿校验：只有发起拖拽的那只指针能结束拖拽，
  // 触摸、右键等其他指针的 up/cancel 不会误终止
  const endDrag = useCallback((pointerId?: number) => {
    const d = dragRef.current;
    if (d && pointerId !== undefined && pointerId !== d.id) return;
    dragRef.current = null;
    setDragging(false);
    // click 在 pointerup 之后同步派发，拖拽后的误点 click 要拦；
    // 延迟一拍复位，不影响之后的触摸点按与键盘 Enter
    window.setTimeout(() => {
      movedRef.current = false;
    }, 0);
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    const el = scrollRef.current;
    if (!el) return;
    dragRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
    movedRef.current = false;
    setDragging(true);
    // 按下不捕获指针（会把节点 click 改道到容器），捕获推迟到越过阈值
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    const el = scrollRef.current;
    if (!d || !el || e.pointerId !== d.id) return;
    // 指针在窗外/浏览器 UI 上松开时收不到 pointerup，buttons 归零兜底，
    // 防止 dragRef 残留导致悬停误平移和对失效指针捕获
    if (e.buttons === 0) {
      endDrag(e.pointerId);
      return;
    }
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

  // window 级持久监听（组件卸载统一清理，不随 pointerdown 累积）：
  // 捕获前在容器外松开、窗口失焦等收不到容器事件的情况都在这里兜底
  useEffect(() => {
    const onUp = (e: PointerEvent) => {
      if (e.type === "pointercancel" || e.button === 0) endDrag(e.pointerId);
    };
    const onBlur = () => {
      dragRef.current = null;
      movedRef.current = false;
      setDragging(false);
    };
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [endDrag]);

  // 阅读弹层：ESC 关闭
  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTarget(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target]);

  // 弹层焦点：打开时聚焦关闭按钮，关闭后还原到触发元素
  useEffect(() => {
    if (!target) return;
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => prev?.focus();
  }, [target]);

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
    () => overviewMind(index, safePage, narrow),
    [index, safePage, narrow],
  );

  // 当前章节的热路径：所在概念及其祖先在概览上高亮
  const hot = useMemo(
    () => ancestorPath(index, nodeForSection(index, activeSection)),
    [index, activeSection],
  );

  // 概览入场动画：翻页/断点/数据变化后重放
  useMindReveal(diagramRef, true, safePage + ":" + narrow + ":" + topicCount);

  const openReader = (scope?: string) => {
    const scopeId = scope ?? index.rootId;
    setTarget((prev) => ({ scope: scopeId, node: scopeId, revision: (prev?.revision ?? 0) + 1 }));
  };

  return (
    <div
      ref={ref}
      className="mt-5 rounded-xl border border-tint/5 bg-tint/[0.02] p-3"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="font-mono text-[10px] tracking-widest text-paper-faint">内容导图</p>
        <div className="flex items-center gap-2">
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
          <button
            type="button"
            aria-haspopup="dialog"
            onClick={() => openReader()}
            className="rounded-md border border-tint/10 px-2 py-0.5 font-mono text-[10px] text-paper-faint transition-colors hover:border-gold/40 hover:text-gold"
          >
            查看完整导图 <span aria-hidden="true">↗</span>
          </button>
        </div>
      </div>

      <div
        ref={scrollRef}
        className={"overflow-x-auto " + (dragging ? "cursor-grabbing" : "cursor-grab")}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onClickCapture={(e) => {
          if (movedRef.current) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
      >
        <svg
          ref={diagramRef}
          role="img"
          aria-label="内容导图概览"
          viewBox={"0 0 " + layout.width + " " + layout.height}
          className="block w-full select-none"
          style={{ minWidth: layout.width }}
        >
          {layout.edges.map((edge) => (
            <path
              key={edge.id}
              d={edge.path}
              pathLength={1}
              fill="none"
              data-mind-enter="wire"
              data-mind-level={1}
              className="stroke-tint/20"
              strokeWidth={1.5}
            />
          ))}
          {layout.nodes.map((node) => {
            const isRoot = node.depth === 0;
            const active = node.sectionId !== null && node.sectionId === activeSection;
            const isHot = hot.has(node.id);
            const jump = () => openReader(isRoot ? undefined : node.id);
            return (
              <g
                key={node.id}
                role="button"
                tabIndex={0}
                data-mind-enter="node"
                data-mind-level={isRoot ? 0 : 1}
                data-mind-from={isRoot ? 0 : node.x < layout.width / 2 ? 1 : -1}
                aria-label={(isRoot ? "查看完整导图" : "阅读分支") + "：" + node.label}
                onClick={jump}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    jump();
                  }
                }}
                className="cursor-pointer"
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
                        : isHot
                          ? "fill-tint/[0.04] stroke-gold/30"
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
                        : "fill-paper-dim text-[12px]"
                  }
                >
                  {node.label.length > 16 ? node.label.slice(0, 15) + "…" : node.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <p className="mt-2 font-mono text-[10px] text-paper-faint/70">点主题阅读分支，选中概念可定位原文。</p>

      {/* 分支阅读弹层：全屏覆盖，ESC/按钮关闭；定位章节先关弹层再滚动 */}
      {target ? (
        createPortal(
        <div
          ref={overlayRef}
          className="fixed inset-0 z-50 flex flex-col bg-ink-950/95 p-4 sm:p-8"
          role="dialog"
          aria-modal="true"
          aria-label="内容导图阅读"
          onKeyDown={(e) => {
            // 焦点圈定：Tab 在弹层内循环，不漏到背景页面
            if (e.key !== "Tab" || !overlayRef.current) return;
            const focusables = overlayRef.current.querySelectorAll<HTMLElement>(
              'button, select, [tabindex]:not([tabindex="-1"])',
            );
            if (!focusables.length) return;
            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first.focus();
            }
          }}
        >
          <div className="flex items-center justify-between pb-3">
            <p className="min-w-0 truncate font-mono text-[10px] tracking-widest text-paper-faint">
              内容导图 · {title}
            </p>
            <button
              ref={closeRef}
              type="button"
              onClick={() => setTarget(null)}
              className="shrink-0 rounded-lg border border-tint/10 p-1.5 text-paper-faint transition-colors hover:text-gold"
              aria-label="关闭导图阅读"
            >
              <X className="size-3.5" strokeWidth={1.5} />
            </button>
          </div>
          <MindReader
            index={index}
            current={activeSection}
            target={target}
            active={target !== null}
            onLocate={(sectionId) => {
              setTarget(null);
              onJump(sectionId);
            }}
          />
        </div>,
        document.body,
        )
      ) : null}
    </div>
  );
}