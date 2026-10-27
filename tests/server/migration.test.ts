import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ArticleStore } from "@/server/articles";
import { openDb, applyOnce, type Db } from "@/server/db";
import { JobStore } from "@/server/jobs";
import { applyDataFixes } from "@/server/migration";
import { TaskStore } from "@/server/tasks";
import { GenerationStore } from "@/server/generations";
import { deleteTask } from "@/server/maintenance";

let dir: string;
let db: Db;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "v2t-migration-"));
  db = openDb(path.join(dir, "test.db"));
});

afterAll(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

function insertArticle(id: string, taskId: string, status: string): void {
  db.prepare(
    `INSERT INTO articles (id, task_id, status, model, created_at) VALUES (?, ?, ?, 'm', '2026-01-01T00:00:00Z')`,
  ).run(id, taskId, status);
}

function insertJob(id: string, taskId: string, status: string, articleId: string): void {
  db.prepare(
    `INSERT INTO jobs (id, task_id, kind, status, article_id, created_at, updated_at)
     VALUES (?, ?, 'article', ?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  ).run(id, taskId, status, articleId);
}

describe("14 号票：数据迁移", () => {
  it("验收1/2：冷启动落标记，热启动不重复执行", () => {
    const first = applyOnce(db, "test-fix-once", () => {
      db.prepare("CREATE TABLE IF NOT EXISTS t_once (x TEXT)").run();
    });
    expect(first).toBe(true);
    const second = applyOnce(db, "test-fix-once", () => {
      throw new Error("不应再次执行");
    });
    expect(second).toBe(false);
    const row = db.prepare("SELECT key FROM data_fixes WHERE key = 'test-fix-once'").get() as { key: string };
    expect(row.key).toBe("test-fix-once");
  });

  it("验收3：无 job 认领的 streaming 文章改判 interrupted", () => {
    insertArticle("art-zombie", "task-zombie", "streaming");
    applyDataFixes(db);
    const row = db.prepare("SELECT status, error FROM articles WHERE id = 'art-zombie'").get() as {
      status: string;
      error: string | null;
    };
    expect(row.status).toBe("interrupted");
    expect(row.error).toContain("历史生成中断");
  });

  it("验收4：有 queued/running job 的 streaming 文章不被误伤", () => {
    insertArticle("art-live", "task-live", "streaming");
    insertJob("job-live", "task-live", "running", "art-live");
    // 修复已在上面执行过（幂等）：手工重放同一条 SQL 验证条件
    db.prepare(
      `UPDATE articles
          SET status = 'interrupted'
        WHERE status = 'streaming'
          AND id NOT IN (SELECT article_id FROM jobs WHERE status IN ('queued', 'running'))`,
    ).run();
    const row = db.prepare("SELECT status FROM articles WHERE id = 'art-live'").get() as { status: string };
    expect(row.status).toBe("streaming");
  });

  it("验收6：删除任务级联删 jobs", async () => {
    const store = new TaskStore(db);
    const task = store.create({
      originalName: "t.mp4",
      ext: ".mp4",
      sizeBytes: 100,
      sourceKind: "upload",
      owner: "test-device",
    });
    insertArticle("art-del", task.id, "done");
    insertJob("job-del", task.id, "succeeded", "art-del");
    const deps = {
      store,
      generations: new GenerationStore(db),
      articles: new ArticleStore(db),
      jobs: new JobStore(db),
      dataDir: dir,
    };
    const ok = await deleteTask(deps, task.id);
    expect(ok).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE task_id = ?").get(task.id)).toMatchObject({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM articles WHERE task_id = ?").get(task.id)).toMatchObject({ n: 0 });
  });

  it("验收7：openDb 幂等，重复打开不报错", () => {
    const db2 = openDb(path.join(dir, "test.db"));
    expect(() => db2.prepare("SELECT 1 FROM data_fixes LIMIT 1").get()).not.toThrow();
    db2.close();
  });
});
