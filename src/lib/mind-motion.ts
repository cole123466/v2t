/** 导图动效常量（对齐 vid-lens motion.ts） */
export const EASE = "cubic-bezier(0.23, 1, 0.32, 1)";

export function prefersReduced(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
