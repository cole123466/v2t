"use client";

/**
 * 导图分支阅读器（对齐 vid-lens MindReader）：
 * 缩放/平移画布 + 分支折叠 + 所选概念详情（定位章节）+ minimap 导航。
 * 由 MindOverview 以弹层承载，这里只管画布本体。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { MindIndex } from "@/lib/mind-model";
import {
  ancestorPath,
  estimateNodeBox,
  layoutMind,
  mindMove,
  visibleMind,
} from "@/lib/mind-model";
import {
  MAX_MIND_ZOOM,
  MIN_MIND_ZOOM,
  minimapPoint,
  MIND_PADDING,
} from "@/lib/mind-viewport";
import { useMindViewport } from "@/hooks/use-mind-viewport";

export type MindTarget = { scope: string; node: string; revision: number };

const useClientLayout = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function MindReader({
  index,
  current,
  target,
  active,
  onLocate,
}: {
  index: MindIndex;
  /** 当前阅读页所在章节，用于 aria-current 与热路径 */
  current: string | null;
  target: MindTarget;
  active: boolean;
  onLocate: (sectionId: string) => void;
}) {
  const [scope, setScope] = useState(target.scope);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState(target.node);
  const [focused, setFocused] = useState(target.node);
  // 父级未必按 target 重挂载：切换文章后同步分支状态，避免沿用旧文章路径 id
  const [seenTarget, setSeenTarget] = useState(target);
  if (
    seenTarget.revision !== target.revision ||
    seenTarget.scope !== target.scope ||
    seenTarget.node !== target.node
  ) {
    setSeenTarget(target);
    setScope(target.scope);
    setSelected(target.node);
    setFocused(target.node);
    setCollapsed(new Set());
  }
  const [hovered, setHovered] = useState<string | null>(null);
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const keyboardFocus = useRef(false);
  const miniDrag = useRef<number | null>(null);
  // 视口 ref 由组件持有（hook 返回值不带 ref），画布与 minimap 都用它
  const viewportRef = useRef<HTMLDivElement>(null);
  const visible = useMemo(() => visibleMind(index, collapsed, scope), [index, collapsed, scope]);
  const layoutKey = visible.map((node) => node.id).join("\n");
  const layout = useMemo(() => {
    const depth = index.nodes.get(scope)?.depth ?? 0;
    return layoutMind(
      visible,
      scope,
      new Map(visible.map((node) => [node.id, estimateNodeBox(node.label, node.depth - depth)])),
    );
  }, [visible, scope, index]);
  const view = useMindViewport(viewportRef, layout, layoutKey, active, target.node);
  const selectedNode =
    index.nodes.get(selected) ?? index.nodes.get(scope) ?? index.nodes.get(index.rootId)!;
  const hot = ancestorPath(index, hovered ?? selectedNode.id);
  const topics = (index.nodes.get(index.rootId)?.childIds ?? []).map((id) => index.nodes.get(id)!);
  const rootDepth = index.nodes.get(scope)?.depth ?? 0;
  const viewSize = view.size.width > 0 ? view.size : { width: 1, height: 1 };

  // 换分支/重新进入由父级用 key={target.revision} 重挂载，
  // 初始聚焦经 useMindViewport 的 initialFocusId 完成，不走 effect setState
  useClientLayout(() => {
    if (!keyboardFocus.current) return;
    refs.current.get(focused)?.focus({ preventScroll: true });
    keyboardFocus.current = false;
  }, [focused, layoutKey]);

  function changeScope(id: string) {
    setScope(id);
    setSelected(id);
    setFocused(id);
    setHovered(null);
    setCollapsed((existing) => {
      const next = new Set(existing);
      next.delete(id);
      return next;
    });
    view.focus(id, true);
  }

  function toggle(id: string) {
    view.focus(id, false, true);
    setCollapsed((existing) => {
      const next = new Set(existing);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setSelected(id);
    setFocused(id);
  }

  function onKey(event: KeyboardEvent) {
    const move = mindMove(focused, event.key, visible, collapsed);
    if (!move) return;
    event.preventDefault();
    if (move.collapsed) setCollapsed(move.collapsed);
    keyboardFocus.current = true;
    setFocused(move.focus);
    setSelected(move.focus);
    view.focus(move.focus);
  }

  function navigateMini(event: React.PointerEvent<HTMLButtonElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const at = minimapPoint(
      { x: event.clientX - rect.left, y: event.clientY - rect.top },
      { width: rect.width, height: rect.height },
      { width: layout.width + MIND_PADDING * 2, height: layout.height + MIND_PADDING * 2 },
    );
    view.panTo({ x: at.x - MIND_PADDING, y: at.y - MIND_PADDING });
  }

  const mapW = layout.width + MIND_PADDING * 2;
  const mapH = layout.height + MIND_PADDING * 2;
  const miniX = Math.max(0, Math.min(mapW - 1, (view.scroll.x - view.world.x) / view.scale + MIND_PADDING));
  const miniY = Math.max(0, Math.min(mapH - 1, (view.scroll.y - view.world.y) / view.scale + MIND_PADDING));
  const ancestors = [...ancestorPath(index, selectedNode.id)]
    .reverse()
    .filter((id) => id !== index.rootId && id !== selectedNode.id);
  const nodeClass = (isScopeRoot: boolean, isSelected: boolean, isHot: boolean) =>
    isScopeRoot
      ? "border-gold/40 bg-gold/15 font-semibold text-gold"
      : isSelected
        ? "border-gold/60 bg-gold/10 text-gold"
        : isHot
          ? "border-gold/30 bg-tint/[0.05] text-paper"
          : "border-tint/15 bg-tint/[0.04] text-paper-dim hover:border-tint/30";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 工具行：阅读范围 + 缩放 */}
      <div className="flex flex-wrap items-center gap-3 pb-2">
        <label className="flex items-center gap-1.5 font-mono text-[10px] tracking-widest text-paper-faint">
          阅读范围
          <select
            aria-label="选择导图分支"
            value={scope}
              onChange={(event) => changeScope(event.target.value)}
              className="max-w-40 rounded-lg border border-tint/10 bg-ink-900 px-2 py-1 font-mono text-[11px] text-paper-dim outline-none focus:border-gold/40"
          >
            <option value={index.rootId}>完整导图</option>
            {topics.map((node) => (
              <option key={node.id} value={node.id}>
                {node.label}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-1" aria-label="导图缩放">
          <button
            type="button"
            aria-label="缩小导图"
            disabled={view.scale <= MIN_MIND_ZOOM}
            onClick={() => view.zoom(view.scale / 1.2)}
            className="rounded-lg border border-tint/10 px-2 py-1 font-mono text-[11px] text-paper-faint transition-colors hover:text-gold disabled:opacity-30"
          >
            −
          </button>
          <span
            aria-label={"缩放比例 " + Math.round(view.scale * 100) + "%"}
            className="w-10 text-center font-mono text-[10px] text-paper-faint"
          >
            {Math.round(view.scale * 100)}%
          </span>
          <button
            type="button"
            aria-label="放大导图"
            disabled={view.scale >= MAX_MIND_ZOOM}
            onClick={() => view.zoom(view.scale * 1.2)}
            className="rounded-lg border border-tint/10 px-2 py-1 font-mono text-[11px] text-paper-faint transition-colors hover:text-gold disabled:opacity-30"
          >
            ＋
          </button>
          <button
            type="button"
            onClick={() => view.focus(selectedNode.id, true)}
            className="rounded-lg border border-tint/10 px-2 py-1 font-mono text-[10px] text-paper-faint transition-colors hover:text-gold"
          >
            复位
          </button>
        </div>
        <span className="font-mono text-[10px] text-paper-faint/70">拖动平移 · 滚轮缩放</span>
      </div>

      <div className="flex min-h-0 flex-1 gap-3">
        {/* 画布 */}
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-tint/10 bg-tint/[0.02]">
          <div
            ref={viewportRef}
            data-dragging={view.dragging}
            onScroll={view.syncScroll}
            {...view.pointer}
            tabIndex={0}
            role="region"
            aria-label="导图画布，拖动平移，滚轮缩放"
            className={"size-full overflow-auto " + (view.dragging ? "cursor-grabbing" : "cursor-grab")}
          >
            <div style={{ width: view.world.width, height: view.world.height }} className="relative">
              <div
                role="tree"
                aria-label="概念关系"
                onKeyDown={onKey}
                onMouseLeave={() => setHovered(null)}
                style={{
                  width: layout.width,
                  height: layout.height,
                  left: view.world.x,
                  top: view.world.y,
                  transform: "scale(" + view.scale + ")",
                  transformOrigin: "0 0",
                }}
                className="absolute"
              >
                <svg width={layout.width} height={layout.height} aria-hidden="true" className="absolute inset-0">
                  {layout.wires.map((wire) => (
                    <path
                      key={wire.id}
                      d={wire.d}
                      pathLength={1}
                      fill="none"
                      className={hot.has(wire.id) ? "stroke-gold/50" : "stroke-tint/20"}
                      strokeWidth={1.5}
                    />
                  ))}
                </svg>
                {visible.map((node) => {
                  const box = layout.boxes.get(node.id)!;
                  const open = !collapsed.has(node.id);
                  const isScopeRoot = node.id === scope;
                  const isSelected = selectedNode.id === node.id;
                  return (
                    <div
                      key={node.id}
                      style={{
                        width: box.w,
                        height: box.h,
                        transform: "translate(" + box.x + "px, " + box.y + "px)",
                      }}
                      className="absolute"
                    >
                      <div className="relative size-full">
                        <button
                          type="button"
                          role="treeitem"
                          aria-label={node.label}
                          aria-level={node.depth - rootDepth + 1}
                          aria-selected={isSelected}
                          aria-expanded={node.childIds.length ? open : undefined}
                          aria-current={node.sectionId && node.sectionId === current ? "location" : undefined}
                          tabIndex={focused === node.id ? 0 : -1}
                          ref={(element) => {
                            if (element) refs.current.set(node.id, element);
                            else refs.current.delete(node.id);
                          }}
                          onMouseEnter={() => setHovered(node.id)}
                          onFocus={() => {
                            setFocused(node.id);
                            setSelected(node.id);
                          }}
                          onClick={() => {
                            setFocused(node.id);
                            setSelected(node.id);
                          }}
                          className={
                            "truncate rounded-lg border px-2 text-center text-[12px] leading-none transition-colors " +
                            nodeClass(isScopeRoot, isSelected, hot.has(node.id))
                          }
                        >
                          {node.label}
                        </button>
                        {node.childIds.length ? (
                          <button
                            type="button"
                            tabIndex={-1}
                            aria-label={(open ? "折叠" : "展开") + node.label}
                            onClick={() => toggle(node.id)}
                            className="absolute -right-3 top-1/2 z-10 size-5 -translate-y-1/2 rounded-full border border-tint/20 bg-ink-900 font-mono text-[10px] leading-none text-paper-faint transition-colors hover:text-gold"
                          >
                            {open ? "−" : "＋"}
                          </button>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
          {/* minimap：点按/拖动平移视口 */}
          <button
            type="button"
            aria-label="导图缩略导航，方向键平移"
            onPointerDown={(event) => {
              miniDrag.current = event.pointerId;
              event.currentTarget.setPointerCapture(event.pointerId);
              navigateMini(event);
            }}
            onPointerMove={(event) => {
              if (miniDrag.current === event.pointerId) navigateMini(event);
            }}
            onPointerUp={(event) => {
              miniDrag.current = null;
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
            }}
            onPointerCancel={() => {
              miniDrag.current = null;
            }}
            onClick={(event) => {
              if (event.detail === 0) view.focus(selectedNode.id);
            }}
            onKeyDown={(event) => {
              const node = viewportRef.current;
              if (!node) return;
              const directions: Record<string, [number, number]> = {
                ArrowLeft: [-1, 0],
                ArrowRight: [1, 0],
                ArrowUp: [0, -1],
                ArrowDown: [0, 1],
              };
              const direction = directions[event.key];
              if (direction) {
                event.preventDefault();
                node.scrollLeft += (direction[0] * viewSize.width) / 3;
                node.scrollTop += (direction[1] * viewSize.height) / 3;
                view.syncScroll();
              }
            }}
            className="absolute bottom-2 right-2 h-20 w-28 rounded-lg border border-tint/10 bg-ink-950/85 p-1"
          >
            <svg viewBox={"0 0 " + mapW + " " + mapH} aria-hidden="true" className="size-full">
              {visible.map((node) => {
                const box = layout.boxes.get(node.id)!;
                return (
                  <rect
                    key={node.id}
                    className={node.id === selectedNode.id ? "fill-gold/70" : "fill-tint/30"}
                    x={box.x + MIND_PADDING}
                    y={box.y + MIND_PADDING}
                    width={box.w}
                    height={box.h}
                  />
                );
              })}
              <rect
                className="fill-gold/10 stroke-gold/60"
                strokeWidth={1.5}
                x={miniX}
                y={miniY}
                width={Math.max(1, Math.min(mapW - miniX, viewSize.width / view.scale))}
                height={Math.max(1, Math.min(mapH - miniY, viewSize.height / view.scale))}
              />
            </svg>
          </button>
        </div>

        {/* 所选概念详情 */}
        <aside aria-label="所选概念" className="hidden w-52 shrink-0 flex-col gap-2 xl:flex">
          <p className="font-mono text-[10px] tracking-widest text-paper-faint">
            {selectedNode.id === index.rootId ? "视频主线" : selectedNode.depth === 1 ? "当前主题" : "当前概念"}
          </p>
          {ancestors.length ? (
            <p className="text-[11px] leading-relaxed text-paper-faint">
              {ancestors.map((id) => index.nodes.get(id)!.label).join(" › ")}
            </p>
          ) : null}
          <h3 className="font-display text-[15px] font-semibold leading-snug text-paper">{selectedNode.label}</h3>
          {selectedNode.sectionId ? (
            <button
              type="button"
              onClick={() => onLocate(selectedNode.sectionId!)}
              className="inline-flex w-fit items-center gap-1 rounded-xl border border-gold/40 bg-gold/10 px-3 py-1.5 font-mono text-[10px] tracking-wider text-gold transition-colors hover:bg-gold/20"
            >
              查看对应章节 <span aria-hidden="true">↗</span>
            </button>
          ) : null}
          {selectedNode.childIds.length ? (
            <div className="mt-1 rounded-xl border border-tint/10 p-2.5">
              <p className="font-mono text-[10px] text-paper-faint">
                下级概念 <span>{selectedNode.childIds.length} 项</span>
              </p>
              <button
                type="button"
                onClick={() => toggle(selectedNode.id)}
                className="mt-1.5 text-[11px] text-gold/90 underline-offset-2 hover:underline"
              >
                {collapsed.has(selectedNode.id) ? "展开子概念" : "折叠这个分支"}
              </button>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}