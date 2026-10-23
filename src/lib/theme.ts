/** 主题偏好的取值：显式浅色 / 显式深色 / 跟随系统 */
export type ThemePreference = "light" | "dark" | "system";

/** 实际落到 <html class> 上的主题 */
export type ResolvedTheme = "light" | "dark";

/** localStorage 的键名，需与 THEME_INIT_SCRIPT 内联脚本保持一致 */
export const THEME_STORAGE_KEY = "v2t-theme";

/** 深色通过 <html class="dark"> 触发，样式见 globals.css */
export const DARK_CLASS = "dark";

/** 任何非法/缺失的存储值都回落到跟随系统 */
export function parseThemePreference(raw: string | null | undefined): ThemePreference {
  return raw === "light" || raw === "dark" ? raw : "system";
}

/** 把偏好折算成实际主题；system 时听系统深色媒体查询 */
export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (preference === "system") return systemPrefersDark ? "dark" : "light";
  return preference;
}

/** system 不落存储（保留 null 表示清除），其余原样写入 */
export function serializeThemePreference(preference: ThemePreference): string | null {
  return preference === "system" ? null : preference;
}

/**
 * 首屏阻塞脚本：在 HTML 解析阶段就把 dark 类挂到 <html> 上，
 * 避免刷新时先渲染浅色再翻转（FOUC）。必须保持纯 ES5 + try/catch，
 * 在 localStorage 被禁用时静默回落到系统偏好。
 */
export const THEME_INIT_SCRIPT = `(function(){try{var k=${JSON.stringify(
  THEME_STORAGE_KEY,
)};var s=localStorage.getItem(k);var p=s==="light"||s==="dark"?s:"system";var m=window.matchMedia("(prefers-color-scheme: dark)").matches;var d=p==="dark"||(p==="system"&&m);document.documentElement.classList.toggle(${JSON.stringify(
  DARK_CLASS,
)},d)}catch(e){}})()`;
