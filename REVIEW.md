# Code Review Guidelines for Agent

> 供自动审查 Agent（agent/review/）消费。只写可判定的规则，不写空话。

## Non-negotiable Rules

1. 数据库查询禁止在循环体内执行（必须批量查询）。
   Done: 循环体内不出现 `SELECT/INSERT/UPDATE/DELETE` 或 `db.prepare(...).run/get/all` 调用；需要按 ID 集合查询时，使用 `IN (?,?,...)` 一次性查询。
2. 所有对外 API 路由必须校验设备归属（owner.ts 的隔离检查），不得直接用请求参数读写任务数据。
   Done: 路由 handler 内先调用 owner 归属校验（`assertOwner`/等价函数）再访问任务数据；`params.id` 只用于查库后比对归属，不直接拼进存储路径或 SQL。
3. 变更涉及 `src/server/db.ts`、`src/server/owner.ts`、数据库 migration 或 `scripts/ci.sh` 视为 Tier 3 高危变动，严禁自动通过。
   Done: 决策永远为 human；报告明示命中的文件与规则，由 Reviewer of Record 人工确认。
4. `node:sqlite` 与文件句柄必须在使用后关闭/释放，禁止在请求路径上同步读大文件。
   Done: 新增的 open/create 有对应 close/release（或进程生命周期持有）；请求路径不出现 `readFileSync` 读非配置小文件。
5. 多个资源的释放必须按依赖逆序执行：定时器/事件监听必须先于其访问的数据库连接或句柄关闭（`clearInterval` 在 `db.close()` 之前），否则 Critical。
   Done: 同一释放路径中，`clearInterval`/`removeEventListener`/`abort` 出现在 `db.close()`/`destroy()` 之前；修复验证时按文件检索释放顺序，两行顺序对调即为通过。

## Patterns to Flag (Critical)

- 未捕获的 Promise rejection（async 调用无 await、无 .catch、不在 try/catch 内）。
- SSE / 长连接路由缺少错误监听（error/aborted）导致连接泄漏。
- 以用户输入直接拼接 shell 命令、SQL 或路径（注入类）。
- 引入新的重型依赖但未在 PR 说明中注明理由。
- 对 `data/` 目录的写入缺少大小/数量上限。

## Patterns to Flag (Warning)

- 循环内重复编译正则 / 重复创建大对象。
- 错误信息把内部实现细节（栈、路径）直接透传给客户端。
- 删除了仍被引用的导出（会先被 typecheck 拦截，但值得提醒）。

## 明确忽略（交给 Linter / CI）

- 命名风格、缩进、import 顺序。
- 类型标注缺失（typecheck 负责）。
- 测试覆盖率数字。
