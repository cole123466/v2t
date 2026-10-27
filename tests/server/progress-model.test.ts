import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCatalog, type Article } from "@/server/article";
import { ArticleService, ArticleStore } from "@/server/articles";
import { ActivityStore } from "@/server/activities";
import { openDb, type Db } from "@/server/db";
import type { LLMProvider } from "@/server/generations";

let dir: string;
let db: Db;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "v2t-progress-"));
  db = openDb(path.join(dir, "test.db"));
});

afterAll(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

const TRANSCRIPT = {
  durationSec: 120,
  timestampsMissing: false,
  segments: [
    { start: 0, end: 10, text: "开场介绍" },
    { start: 30, end: 45, text: "第一个要点" },
    { start: 90, end: 100, text: "总结" },
  ],
};

const MANIFEST = {
  width: 1280,
  frames: [
    { id: "f00", tSec: 5, file: "frames/f00.jpg", kind: "overview" as const, width: 1280 },
    { id: "f01", tSec: 60, file: "frames/f01.jpg", kind: "overview" as const, width: 1280 },
  ],
};

/** 假 LLM：第一次回提纲，之后每次回一章；可让指定章两次尝试都失败 */
function fakeLlm(failSectionIndex?: number): LLMProvider {
  let calls = 0;
  let sectionIndex = 0;
  return {
    async generate() {
      calls += 1;
      if (calls === 1) {
        return JSON.stringify({
          title: "进度模型文章",
          sections: [
            { id: "s1", title: "第一章", summary: "要点一" },
            { id: "s2", title: "第二章", summary: "要点二" },
            { id: "s3", title: "第三章", summary: "要点三" },
          ],
          mindMap: [{ label: "主题" }],
        });
      }
      if (failSectionIndex === sectionIndex) return "not-json"; // 两次尝试都失败
      const idx = sectionIndex;
      sectionIndex += 1; // 成功即进入下一章
      return JSON.stringify({
        id: `s${idx + 1}`,
        title: `第${["一", "二", "三"][idx]}章`,
        blocks: [{ type: "paragraph", text: "内容引用 [[t01]]" }],
      });
    },
  };
}

describe("07 号票：进度模型", () => {
  it("验收1：提纲步骤 + 预插入章节步骤 + 校验/发布步骤，seq 单调无重复", async () => {
    const store = new ArticleStore(db);
    const activities = new ActivityStore(db);
    const svc = new ArticleService({ store, llm: fakeLlm(), activities });
    const catalog = buildCatalog(TRANSCRIPT, MANIFEST);

    await svc.generate({ taskId: "task-progress-1", catalog, frameFiles: new Map() });

    const steps = activities.listForTask("task-progress-1").filter((s) => s.kind !== "model");
    const outline = steps.filter((s) => s.phase === "outline");
    const sections = steps.filter((s) => s.kind === "section");
    const validate = steps.filter((s) => s.phase === "validate");
    const publish = steps.filter((s) => s.phase === "publish");
    expect(outline).toHaveLength(1);
    expect(sections).toHaveLength(3);
    expect(validate).toHaveLength(1);
    expect(publish).toHaveLength(1);
    // seq 单调无重复
    const runId = steps[0].runId;
    expect(runId).toBeTruthy();
    const seqs = steps.filter((s) => s.runId === runId).map((s) => s.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    // 全部终态
    expect(steps.every((s) => s.status === "completed")).toBe(true);
  });

  it("验收2/3：每章完成即落库，步骤 completed 时内容可读", async () => {
    const store = new ArticleStore(db);
    const activities = new ActivityStore(db);
    // 用可控 LLM 在第 2 章完成时抓取快照
    let calls = 0;
    const snapshot: { current: Article | null } = { current: null };
    const llm: LLMProvider = {
      async generate() {
        calls += 1;
        if (calls === 1) {
          return JSON.stringify({
            title: "增量落库文章",
            sections: [
              { id: "s1", title: "第一章", summary: "" },
              { id: "s2", title: "第二章", summary: "" },
            ],
            mindMap: [],
          });
        }
        const idx = calls - 2;
        if (idx === 1) {
          // 第 2 章生成前：第 1 章应已落库
          snapshot.current = store.listForTask("task-progress-2")[0]?.content ?? null;
        }
        return JSON.stringify({
          id: `s${idx + 1}`,
          title: `第${idx + 1}章`,
          blocks: [{ type: "paragraph", text: `第 ${idx + 1} 章正文 [[t01]]` }],
        });
      },
    };
    const svc = new ArticleService({ store, llm, activities });
    const catalog = buildCatalog(TRANSCRIPT, MANIFEST);
    const record = await svc.generate({ taskId: "task-progress-2", catalog, frameFiles: new Map() });

    // 第 2 章生成前，第 1 章已可读
    expect(snapshot.current?.sections).toHaveLength(1);
    expect(snapshot.current?.sections[0].title).toBe("第1章");
    // 终态
    expect(record.status).toBe("done");
    expect(record.content?.sections).toHaveLength(2);
    // 章节步骤 completed 时 content 已含该章（用最终状态反推时序不变量）
    const sectionSteps = activities
      .listForTask("task-progress-2")
      .filter((s) => s.kind === "section");
    expect(sectionSteps.every((s) => s.status === "completed")).toBe(true);
  });

  it("验收5：章节失败后步骤为 failed，错误信息可读", async () => {
    const store = new ArticleStore(db);
    const activities = new ActivityStore(db);
    const svc = new ArticleService({ store, llm: fakeLlm(1), activities });
    const catalog = buildCatalog(TRANSCRIPT, MANIFEST);

    await expect(
      svc.generate({ taskId: "task-progress-3", catalog, frameFiles: new Map() }),
    ).rejects.toThrow(/第 2 章/);

    const steps = activities.listForTask("task-progress-3");
    const failed = steps.filter((s) => s.status === "failed");
    expect(failed.length).toBeGreaterThan(0);
    // 第 1 章已完成且保留
    const sections = steps.filter((s) => s.kind === "section");
    expect(sections[0].status).toBe("completed");
    expect(sections[1].status).toBe("failed");
    // 文章标记 failed
    const record = store.listForTask("task-progress-3")[0];
    expect(record.status).toBe("failed");
  });

  it("currentRun 派生：运行中可见，完成后为 null", () => {
    const activities = new ActivityStore(db);
    const runId = activities.newRunId();
    const step = activities.start({ taskId: "task-cr", kind: "stage", runId, phase: "outline", title: "生成提纲" });
    const running = activities.currentRunForTask("task-cr");
    expect(running?.runId).toBe(runId);
    expect(running?.phase).toBe("outline");
    activities.finish(step.id, { ok: true, status: "completed" });
    expect(activities.currentRunForTask("task-cr")).toBeNull();
  });

  it("验收6：老行（无 status）读时推导，不出现全部进行中", () => {
    const activities = new ActivityStore(db);
    // 手工插一条老格式行（无 run_id/status）
    db.prepare(
      `INSERT INTO activities (id, task_id, kind, stage, message, started_at, ended_at, ok)
       VALUES ('legacy-1', 'task-legacy', 'model', 'article', '旧记录', '2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO activities (id, task_id, kind, stage, message, started_at, ended_at, ok)
       VALUES ('legacy-2', 'task-legacy', 'model', 'qa', '旧记录2', '2026-01-01T00:02:00Z', NULL, NULL)`,
    ).run();
    const list = activities.listForTask("task-legacy");
    expect(list.find((a) => a.id === "legacy-1")?.status).toBe("completed");
    expect(list.find((a) => a.id === "legacy-2")?.status).toBe("running");
  });

  it("验收7：EXPLAIN QUERY PLAN 走 activities_run 索引", () => {
    const plan = db
      .prepare("EXPLAIN QUERY PLAN SELECT * FROM activities WHERE run_id = 'x' ORDER BY seq")
      .all() as Array<{ detail: string }>;
    const detail = plan.map((r) => r.detail).join(" ");
    expect(detail).toContain("activities_run");
  });
});
