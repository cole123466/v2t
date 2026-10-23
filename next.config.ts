import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 远程访问（非 localhost）时，Next 16 默认拦截 /_next/* 开发资源，
  // 会导致 HMR/Fast Refresh 失效、跨站预览时 JS/CSS 直接 403（页面“组件失效”）。
  // 允许的 host 放在 .env（不入库），这里只做解析，避免把具体环境写进仓库。
  allowedDevOrigins: (process.env.ALLOWED_DEV_ORIGINS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean),
  // 上传走 route handler 流式读 body（Readable.fromWeb → pipeline），
  // 不经过 Server Actions 的 bodySizeLimit，因此无需在这里调大请求体上限；
  // 2GB 上限由 MAX_UPLOAD_GB 在 /api/tasks 内校验。
  turbopack: {
    root: path.join(__dirname),
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  // 桌宠运行时与素材允许被其他站点用 <script>/<img> 直接引用（零依赖嵌入）。
  // pet.json 走 fetch，必须带 CORS 头；图集本身只做 drawImage，不会被读像素。
  async headers() {
    const cors = [
      { key: "Access-Control-Allow-Origin", value: "*" },
      { key: "Cross-Origin-Resource-Policy", value: "cross-origin" },
    ];
    return [
      { source: "/pet-embed/:path*", headers: cors },
      { source: "/pets/:path*", headers: cors },
    ];
  },
};

export default nextConfig;
