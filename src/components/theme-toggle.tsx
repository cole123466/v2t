"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import {
  DARK_CLASS,
  parseThemePreference,
  resolveTheme,
  serializeThemePreference,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from "@/lib/theme";

const OPTIONS: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon },
  { value: "system", label: "跟随系统", icon: Monitor },
];

/** 读取已持久化的偏好；SSR / 未挂载阶段一律按 system */
function readPreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  try {
    return parseThemePreference(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

// 简单的模块级订阅：同一页面的多个切换入口、以及跨标签页的 storage 事件都能同步
const listeners = new Set<() => void>();

function subscribePreference(onChange: () => void) {
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function emitPreference() {
  for (const listener of listeners) listener();
}

/** 服务端快照固定为 system，保证 hydration 时服务端与客户端输出一致 */
const serverPreference = () => "system" as const;

/** 把 class 落到 <html> 上，immediate 用于点击后立即生效 */
function applyClass(preference: ThemePreference) {
  const dark = resolveTheme(preference, window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle(DARK_CLASS, dark === "dark");
}

/**
 * 浅色 / 深色 / 跟随系统 三态切换。
 * 首屏由 layout 的内联脚本上色，这里只负责交互与持久化；
 * useSyncExternalStore 让服务端快照（system）与客户端读到的 localStorage 自然对齐，
 * 不会出现 hydration 警告，也不需要「先渲染占位再 setState」。
 */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const preference = useSyncExternalStore(subscribePreference, readPreference, serverPreference);

  // 偏好变化（点击、跨标签页 storage 事件）后同步 <html class>；
  // 开发模式下 Strict Mode 重挂载会重置 <html>，这里也会补回，生产环境是幂等操作。
  useEffect(() => {
    applyClass(preference);
  }, [preference]);

  // 选择「跟随系统」时，系统切换深浅要实时跟随
  useEffect(() => {
    if (preference !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => applyClass("system");
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, [preference]);

  const choose = useCallback((next: ThemePreference) => {
    try {
      const stored = serializeThemePreference(next);
      if (stored === null) localStorage.removeItem(THEME_STORAGE_KEY);
      else localStorage.setItem(THEME_STORAGE_KEY, stored);
    } catch {
      // 隐私模式下 localStorage 不可写，本次切换仍在会话内生效
    }
    applyClass(next);
    emitPreference();
  }, []);

  return (
    <div
      role="group"
      aria-label="主题模式"
      className={`inline-flex items-center gap-0.5 rounded-full border border-tint/15 p-0.5 ${className}`}
    >
      {OPTIONS.map(({ value, label, icon: Icon }) => {
        const active = preference === value;
        return (
          <button
            key={value}
            type="button"
            onClick={() => choose(value)}
            aria-label={label}
            aria-pressed={active}
            title={label}
            className={`inline-flex size-7 items-center justify-center rounded-full transition-colors ${
              active ? "bg-gold text-ink-950" : "text-paper-faint hover:text-paper"
            }`}
          >
            <Icon className="size-3.5" strokeWidth={1.75} />
          </button>
        );
      })}
    </div>
  );
}
