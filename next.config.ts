import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
};

export default nextConfig;
