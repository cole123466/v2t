import { applyOnce, type Db } from "./db";
import { logInfo } from "./log";

/**
 * 一次性数据修复（14 号票：decision-data-migration）。
 *
 * 与幂等 DDL 的分工：加列建表可重复执行；数据改判重复执行为害，
 * 用 data_fixes 单行标记保证「只执行一次」。
 *
 * 调用时机：openDb 之后、任何后台执行（08 号票的 worker）启动之前。
 * 顺序不可调换：否则 worker 可能把某 job 拉起、改判逻辑又把它文章置
 * interrupted，产生矛盾状态。
 */
export function applyDataFixes(db: Db): void {
  // M1：无 job 认领的 streaming 文章 → interrupted。
  // 首次升级时命中历史僵尸；之后新建的 streaming 必然有 job，不会误伤。
  const reapStreaming = applyOnce(db, "2026-10-reap-streaming", () => {
    const result = db
      .prepare(
        `UPDATE articles
            SET status = 'interrupted',
                error = COALESCE(error, '历史生成中断，可继续生成')
          WHERE status = 'streaming'
            AND id NOT IN (SELECT article_id FROM jobs WHERE status IN ('queued', 'running'))`,
      )
      .run();
    logInfo("data fix applied: reap-streaming", { updated: Number(result.changes) });
  });
  if (reapStreaming) logInfo("data fixes completed", { fix: "2026-10-reap-streaming" });

  // 占位：08 号票落地后如需回填 job_id 用此 key，本期为空操作
  applyOnce(db, "2026-10-backfill-job-ids", () => {});
}
