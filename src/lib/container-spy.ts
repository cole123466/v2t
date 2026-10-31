"use client";

import { useEffect, useMemo, useState, type RefObject } from "react";

/**
 * 滚动容器内的章节联动（06 号票 K3）。
 *
 * 正文在 article-panel 的 overflow-auto 容器里滚，window 不滚——
 * 所以 spy 读的是容器的 scrollTop + 子元素相对偏移，
 * 定位用 container.scrollTo 而不是 scrollIntoView（后者会连带滚动外层页面）。
 */

/** 章节标题落在容器顶部以下多少像素算「当前阅读位」 */
export const SECTION_ANCHOR_OFFSET = 96;

/** 返回 sectionId 在滚动容器内的偏移；不在容器内时为 null */
export function measureSection(
  container: HTMLElement,
  sectionId: string,
): number | null {
  const el = container.querySelector<HTMLElement>(`#section-${CSS.escape(sectionId)}`);
  if (!el) return null;
  // 相对容器的偏移 = 视口位置差 + 容器已滚出的部分
  return el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
}

/** 当前阅读位落在哪个章节：取「顶部 ≤ 阈值」的最后一个章节 */
export function pickActiveSection(
  container: HTMLElement,
  sectionIds: readonly string[],
  scrollTop: number,
): string | null {
  let active: string | null = null;
  for (const sectionId of sectionIds) {
    const offset = measureSection(container, sectionId);
    if (offset === null) continue;
    if (offset <= scrollTop + SECTION_ANCHOR_OFFSET) active = sectionId;
    else break;
  }
  return active;
}

/** 把某章节滚到容器顶部下方 96px；容器由调用方持有，不碰外层页面滚动 */
export function scrollToSection(
  container: HTMLElement,
  sectionId: string,
  behavior: ScrollBehavior = "smooth",
): void {
  const offset = measureSection(container, sectionId);
  if (offset === null) return;
  container.scrollTo({ top: Math.max(0, offset - SECTION_ANCHOR_OFFSET), behavior });
}

/**
 * 监听滚动容器的 scrollTop，返回当前阅读位对应的章节。
 * 导图概览与章节目录共用同一份 activeSection，不各算一遍。
 */
export function useContainerSpy(
  containerRef: RefObject<HTMLElement | null>,
  sectionIds: readonly string[],
): string | null {
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);

  // 调用方常在渲染期新建数组（map 结果、字面量），数组身份每次渲染都不同。
  // 直接把它放进 effect 依赖，会让 effect 每次渲染都重订阅并立刻读一次 scrollTop，
  // setState → 重渲染 → 再重订阅，叠到 50 层就是 Maximum update depth exceeded。
  // 这里按「内容签名」锁定身份：章节 id 不变就不重订阅。
  const sectionKey = sectionIds.join("\u0000");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 以 sectionKey 的值签名为准，内容相同即复用同一数组
  const ids = useMemo(() => sectionIds, [sectionKey]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || ids.length === 0) {
      // 函数式更新：值相同时复用旧 state，不额外触发重渲染
      setActiveSection((prev) => (prev === null ? prev : null));
      return;
    }
    let raf = 0;
    // 只取整像素：亚像素抖动（滚动锚定、平滑滚动、布局重排）会让每帧的值都「不相等」，
    // 从而每帧都触发一次无意义的 setState；同值直接沿用旧 state 让 React 跳过渲染。
    const syncScrollTop = () => {
      const next = Math.round(container.scrollTop);
      setScrollTop((prev) => (prev === next ? prev : next));
    };
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(syncScrollTop);
    };
    // 挂载 / 换文章时同步一次初值，之后只由 scroll 事件驱动，不随渲染重新订阅
    onScroll();
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      container.removeEventListener("scroll", onScroll);
    };
  }, [containerRef, ids]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || ids.length === 0) {
      setActiveSection((prev) => (prev === null ? prev : null));
      return;
    }
    const next = pickActiveSection(container, ids, scrollTop);
    setActiveSection((prev) => (prev === next ? prev : next));
  }, [containerRef, ids, scrollTop]);

  return activeSection;
}
