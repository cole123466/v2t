import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": path.join(__dirname, "src") },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 90_000,
    hookTimeout: 90_000,
  },
});
