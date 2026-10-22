"use client";

// global-error 替换整个 root layout 渲染，字体与全局 CSS 均不可用，只能内联样式。
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="zh-CN">
      <body
        style={{
          margin: 0,
          minHeight: "100svh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 24,
          background: "#060608",
          color: "#ece9e2",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <p style={{ margin: 0, fontSize: 12, letterSpacing: "0.3em", color: "#6d6a64" }}>
          V2T / FATAL
        </p>
        <h1 style={{ margin: 0, fontSize: 28, fontWeight: 600 }}>发生了全局错误</h1>
        {error.digest ? (
          <p style={{ margin: 0, fontSize: 12, color: "#a6a29a" }}>digest: {error.digest}</p>
        ) : null}
        <button
          onClick={reset}
          style={{
            border: "1px solid rgba(255,255,255,0.15)",
            background: "rgba(255,255,255,0.05)",
            color: "#ece9e2",
            padding: "10px 28px",
            borderRadius: 999,
            cursor: "pointer",
          }}
        >
          重试
        </button>
      </body>
    </html>
  );
}
