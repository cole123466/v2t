"use client";

import { useEffect, useState, type RefObject } from "react";

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

  useEffect(() => {
    const container = containerRef.current;
    if (!container || sectionIds.length === 0) {
      setActiveSection(null);
      return;
    }
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        setScrollTop(container.scrollTop);
      });
    };
    onScroll();
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      container.removeEventListener("scroll", onScroll);
    };
  }, [containerRef, sectionIds]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || sectionIds.length === 0) {
      setActiveSection(null);
      return;
    }
    setActiveSection(pickActiveSection(container, sectionIds, scrollTop));
  }, [containerRef, sectionIds, scrollTop]);

  return activeSection;
}
