import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // 本地索引 / 运行数据 / 日志不参与代码规范检查
    ".projetcIndex/**",
    "data/**",
    "coverage/**",
    "app.log",
  ]),
]);

export default eslintConfig;
