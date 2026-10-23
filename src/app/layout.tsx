import "@fontsource/playfair-display/400.css";
import "@fontsource/playfair-display/700.css";
import "@fontsource/noto-serif-sc/600.css";
import "@fontsource/noto-serif-sc/900.css";
import "./globals.css";
import type { Metadata } from "next";
import { THEME_INIT_SCRIPT } from "@/lib/theme";

export const metadata: Metadata = {
  title: {
    default: "V2T — 视频转文案工作站",
    template: "%s — V2T",
  },
  description: "上传视频，自动转写，生成文案。一站式本地工作站。",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // suppressHydrationWarning：内联脚本会在 hydration 前改写 <html class>，属于预期差异
    <html lang="zh-CN" className="h-full antialiased" suppressHydrationWarning>
      <head>
        {/* 首屏前阻塞执行，避免深色偏好下的白屏闪烁 */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col bg-ink-950 text-paper font-sans">
        {children}
        <div className="grain-overlay" aria-hidden />
      </body>
    </html>
  );
}
