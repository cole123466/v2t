<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->


## Issue 流程约定（提票规范）

改动一律先提 GitHub issue 再实施（应急直改 main 后必须补提追溯 issue 并注明 commit 号）。
**每个 issue 必须打两类标签，缺一不可：**

- 类型标签（五选一）：`type/bug`（缺陷）、`type/feature`（新功能）、`type/chore`（工程杂务/构建/依赖/lint）、`type/docs`（文档）、`type/test`（测试）
- 风险等级标签（三选一，与自动审查 tiering 对齐）：
  - `risk/tier1`：纯文档/测试/锁文件，验证通过可自动合并
  - `risk/tier2`：常规业务代码，零 Critical 且验证通过可自动合并
  - `risk/tier3`：涉及 src/server/db.ts、src/server/owner.ts、数据库 migration、scripts/ci.sh，或变更超阈值——严禁自动通过，必须人工确认

不确定风险等级时按高一级处理。issue poller 依赖标签与 open 状态捕获入队（见 agent/issues/poller.ts）。
