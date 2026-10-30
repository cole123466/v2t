"use client";

/**
 * 导图阅读器视口 hook（对齐 vid-lens useMindViewport）：
 * 拖拽平移 + 滚轮缩放（以指针为中心）+ focus/panTo 编程定位。
 * viewport ref 由调用方持有传入（hook 返回值里不带 ref，规避
 * react-hooks 编译规则对渲染期 ref 访问的误报）。缩放与定位通过
 * pending 意图在布局生效后一次性落到 scrollLeft/Top。
 */
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { MindBox } from "@/lib/mind-model";
import { mindScroll, mindWorld, mindZoom, type Point } from "@/lib/mind-viewport";

const useClientLayout = typeof window === "undefined" ? useEffect : useLayoutEffect;

type Pending =
  | { id: string; reset: boolean; client?: Point }
  | { point: Point; client: Point };

export function useMindViewport(
  viewportRef: RefObject<HTMLDivElement | null>,
  content: { width: number; height: number; boxes: Map<string, MindBox> },
  layoutKey: string,
  active: boolean,
  initialFocusId?: string,
) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [scale, setScale] = useState(1);
  const [scroll, setScroll] = useState({ x: 0, y: 0 });
  const [request, setRequest] = useState(0);
  const [dragging, setDragging] = useState(false);
  const pending = useRef<Pending | null>(null);
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const scrollFrame = useRef(0);
  const suppressTimer = useRef(0);
  const didInitialFocus = useRef(false);
  const latest = useRef({ content, size, scale });
  const world = mindWorld(content, size, scale);

  useEffect(() => {
    latest.current = { content, size, scale };
  });

  function syncScroll() {
    if (scrollFrame.current) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = 0;
      const node = viewportRef.current;
      if (node) setScroll({ x: node.scrollLeft, y: node.scrollTop });
    });
  }

  /** 把节点滚到视口中心；reset 时同时恢复 100% 缩放 */
  function focus(id: string, reset = false, hold = false) {
    const node = viewportRef.current;
    const state = latest.current;
    const box = state.content.boxes.get(id);
    const old = mindWorld(state.content, state.size, state.scale);
    pending.current = {
      id,
      reset,
      ...(hold && node && box
        ? {
            client: {
              x: old.x + (box.x + box.w / 2) * state.scale - node.scrollLeft,
              y: old.y + (box.y + box.h / 2) * state.scale - node.scrollTop,
            },
          }
        : {}),
    };
    if (reset) setScale(1);
    setRequest((value) => value + 1);
  }

  /** 缩放到指定倍率，client 为视口内的缩放锚点（默认中心） */
  function zoom(value: number, client?: Point) {
    const node = viewportRef.current;
    const state = latest.current;
    const next = mindZoom(value);
    if (!node || Math.abs(next - state.scale) < 0.001) return;
    const at = client ?? { x: state.size.width / 2, y: state.size.height / 2 };
    const old = mindWorld(state.content, state.size, state.scale);
    pending.current = {
      point: { x: (node.scrollLeft + at.x - old.x) / state.scale, y: (node.scrollTop + at.y - old.y) / state.scale },
      client: at,
    };
    setScale(next);
  }

  function panTo(point: Point) {
    const node = viewportRef.current;
    const state = latest.current;
    if (!node) return;
    const position = mindScroll(point, { x: state.size.width / 2, y: state.size.height / 2 }, state.content, state.size, state.scale);
    node.scrollLeft = position.x;
    node.scrollTop = position.y;
    syncScroll();
  }

  useEffect(() => {
    const node = viewportRef.current;
    if (!node || !active) return;
    const resize = () => {
      if (node.clientWidth > 0 && node.clientHeight > 0) {
        setSize((old) =>
          old.width === node.clientWidth && old.height === node.clientHeight
            ? old
            : { width: node.clientWidth, height: node.clientHeight },
        );
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    resize();
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.shiftKey) {
        node.scrollLeft += event.deltaY + event.deltaX;
        syncScroll();
        return;
      }
      const rect = node.getBoundingClientRect();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientHeight : 1;
      zoom(latest.current.scale * Math.exp(-event.deltaY * unit * 0.0015), {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    };
    node.addEventListener("wheel", wheel, { passive: false });
    return () => {
      observer.disconnect();
      node.removeEventListener("wheel", wheel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- syncScroll/zoom 随渲染重建，仅订阅一次
  }, [active]);

  // pending 意图落位：缩放/聚焦等状态变更后，把内容点滚到视口目标处。
  // 首次尺寸就绪时若带 initialFocusId，先定位初始节点（不经过 setState）。
  useClientLayout(() => {
    const node = viewportRef.current;
    if (!node) return;
    if (!pending.current && initialFocusId && !didInitialFocus.current && size.width > 0) {
      didInitialFocus.current = true;
      pending.current = { id: initialFocusId, reset: false };
    }
    const intent = pending.current;
    if (!active || !size.width || !size.height || !intent) return;
    const box = "id" in intent ? content.boxes.get(intent.id) : null;
    if ("id" in intent && !box) return;
    const point = box ? { x: box.x + box.w / 2, y: box.y + box.h / 2 } : (intent as { point: Point }).point;
    const client = intent.client ?? { x: size.width / 2, y: size.height / 2 };
    const position = mindScroll(point, client, content, size, scale);
    node.scrollLeft = position.x;
    node.scrollTop = position.y;
    pending.current = null;
    syncScroll();
  }, [active, request, layoutKey, size.width, size.height, scale]);

  useEffect(() => {
    return () => {
      if (scrollFrame.current) cancelAnimationFrame(scrollFrame.current);
      if (suppressTimer.current) window.clearTimeout(suppressTimer.current);
    };
  }, []);

  function down(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    suppressClick.current = false;
    drag.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: event.currentTarget.scrollLeft,
      top: event.currentTarget.scrollTop,
      moved: false,
    };
  }

  function move(event: ReactPointerEvent<HTMLDivElement>) {
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    if (!start.moved && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 5) return;
    if (!start.moved) {
      start.moved = true;
      suppressClick.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(true);
    }
    event.preventDefault();
    event.currentTarget.scrollLeft = start.left - event.clientX + start.x;
    event.currentTarget.scrollTop = start.top - event.clientY + start.y;
    syncScroll();
  }

  function up(event: ReactPointerEvent<HTMLDivElement>) {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    window.clearTimeout(suppressTimer.current);
    suppressTimer.current = window.setTimeout(() => {
      suppressClick.current = false;
    }, 0);
  }

  return {
    size,
    scale,
    scroll,
    world,
    dragging,
    focus,
    zoom,
    panTo,
    syncScroll,
    pointer: {
      onPointerDown: down,
      onPointerMove: move,
      onPointerUp: up,
      onPointerCancel: up,
      onLostPointerCapture: up,
      onClickCapture: (event: ReactMouseEvent) => {
        if (suppressClick.current) {
          event.preventDefault();
          event.stopPropagation();
        }
      },
    },
  };
}