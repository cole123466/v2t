import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCatalog } from "@/server/article";
import { ArticleService, ArticleStore } from "@/server/articles";
import { ActivityStore } from "@/server/activities";
import { runArticleJob } from "@/server/article-jobs";
import { openDb, type Db } from "@/server/db";
import { JobStore, JobWorker } from "@/server/jobs";
import { taskDir, transcriptPath } from "@/server/paths";
import type { LLMProvider } from "@/server/generations";

let dir: string;
let db: Db;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "v2t-jobs-"));
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
  ],
};
const MANIFEST = {
  width: 1280,
  frames: [{ id: "f00", tSec: 5, file: "frames/f00.jpg", kind: "overview" as const, width: 1280 }],
};

function fakeLlm(sectionCount = 2, failAt?: number): LLMProvider {
  let calls = 0;
  return {
    async generate() {
      calls += 1;
      if (calls === 1) {
        return JSON.stringify({
          title: "后台文章",
          sections: Array.from({ length: sectionCount }, (_, i) => ({
            id: `s${i + 1}`,
            title: `第${i + 1}章`,
            summary: "",
          })),
          mindMap: [],
        });
      }
      const idx = calls - 2;
      if (failAt === idx) return "not-json";
      return JSON.stringify({
        id: `s${idx + 1}`,
        title: `第${idx + 1}章`,
        blocks: [{ type: "paragraph", text: `第 ${idx + 1} 章 [[t01]]` }],
      });
    },
  };
}

interface Harness {
  jobs: JobStore;
  articles: ArticleStore;
  activities: ActivityStore;
  svc: ArticleService;
}

async function seedTranscript(taskId: string): Promise<void> {
  const d = taskDir(dir, taskId);
  await mkdir(d, { recursive: true });
  await writeFile(transcriptPath(d), JSON.stringify(TRANSCRIPT), "utf8");
}

function makeHarness(llm: LLMProvider): Harness {
  const jobs = new JobStore(db);
  const articles = new ArticleStore(db);
  const activities = new ActivityStore(db);
  const svc = new ArticleService({ store: articles, llm, activities });
  return { jobs, articles, activities, svc };
}

describe("08 号票：后台执行", () => {
  it("验收1/6：worker 领取 job 并完成，无客户端连接也成功", async () => {
    await seedTranscript("t-bg-1");
    const h = makeHarness(fakeLlm());
    const record = h.articles.create({ taskId: "t-bg-1", detailLevel: "standard", purpose: null, model: "m" });
    const job = h.jobs.create({ taskId: "t-bg-1", kind: "article", articleId: record.id });
    const events: string[] = [];
    await runArticleJob(
      { jobs: h.jobs, articles: h.articles, articleService: h.svc, dataDir: dir },
      { ...job, taskId: "t-bg-1" },
      new AbortController().signal,
      (event) => events.push(event),
    );
    const after = h.jobs.get(job.id)!;
    expect(after.status).toBe("succeeded");
    expect(after.doneSections).toBe(2);
    const article = h.articles.get(record.id)!;
    expect(article.status).toBe("done");
    expect(article.content?.sections).toHaveLength(2);
    expect(events).toContain("done");
  });

  it("验收3：取消后 job 为 canceled，已存章节保留", async () => {
    await seedTranscript("t-bg-2");
    const h = makeHarness(fakeLlm(3));
    const record = h.articles.create({ taskId: "t-bg-2", detailLevel: "standard", purpose: null, model: "m" });
    const job = h.jobs.create({ taskId: "t-bg-2", kind: "article", articleId: record.id });
    const controller = new AbortController();
    // 第 2 章时中止
    let calls = 0;
    const llm: LLMProvider = {
      async generate() {
        calls += 1;
        if (calls === 1) {
          return JSON.stringify({
            title: "取消文章",
            sections: [
              { id: "s1", title: "第1章", summary: "" },
              { id: "s2", title: "第2章", summary: "" },
            ],
            mindMap: [],
          });
        }
        if (calls === 2) controller.abort(); // 第 1 章调用时取消，下一章检查点停手
        return JSON.stringify({
          id: `s${calls - 1}`,
          title: `第${calls - 1}章`,
          blocks: [{ type: "paragraph", text: "正文 [[t01]]" }],
        });
      },
    };
    h.svc = new ArticleService({ store: h.articles, llm, activities: h.activities });
    h.jobs.update(job.id, { status: "canceled", error: "用户取消生成" });
    await runArticleJob(
      { jobs: h.jobs, articles: h.articles, articleService: h.svc, dataDir: dir },
      job,
      controller.signal,
      () => {},
    );
    const after = h.jobs.get(job.id)!;
    expect(after.status).toBe("canceled");
    // 第 1 章已存
    const article = h.articles.get(record.id)!;
    expect(article.content?.sections.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("验收2：reap 把残留 running 折为 interrupted，文章同步", () => {
    const h = makeHarness(fakeLlm());
    const record = h.articles.create({ taskId: "t-bg-3", detailLevel: "standard", purpose: null, model: "m" });
    const job = h.jobs.create({ taskId: "t-bg-3", kind: "article", articleId: record.id });
    h.jobs.update(job.id, { status: "running", totalSections: 3, doneSections: 1 });
    const reaped = h.jobs.reap();
    expect(reaped).toBe(1);
    expect(h.jobs.get(job.id)?.status).toBe("interrupted");
    expect(h.jobs.get(job.id)?.error).toContain("服务重启");
    expect(h.articles.get(record.id)?.status).toBe("interrupted");
    // 再 reap 一次不重复
    expect(h.jobs.reap()).toBe(0);
  });

  it("验收4：同任务重复提交被 activeForTask 挡住", () => {
    const h = makeHarness(fakeLlm());
    const record = h.articles.create({ taskId: "t-bg-4", detailLevel: "standard", purpose: null, model: "m" });
    h.jobs.create({ taskId: "t-bg-4", kind: "article", articleId: record.id });
    expect(h.jobs.activeForTask("t-bg-4")).toBeTruthy();
    // 终态后不再挡
    const job = h.jobs.activeForTask("t-bg-4")!;
    h.jobs.update(job.id, { status: "succeeded" });
    expect(h.jobs.activeForTask("t-bg-4")).toBeUndefined();
  });

  it("resume：只补缺失章节，已存章节跳过", async () => {
    await seedTranscript("t-bg-5");
    const h = makeHarness(fakeLlm());
    const record = h.articles.create({ taskId: "t-bg-5", detailLevel: "standard", purpose: null, model: "m" });
    // 先模拟：提纲已存 + 第 1 章已存
    const outline = {
      title: "续跑文章",
      sections: [
        { id: "s1", title: "第1章", summary: "" },
        { id: "s2", title: "第2章", summary: "" },
      ],
      mindMap: [],
    };
    h.articles.update(record.id, {
      outline,
      status: "interrupted",
      content: {
        title: "续跑文章",
        sections: [{ id: "s1", title: "第1章", blocks: [{ type: "paragraph", text: "已存 [[t01]]" }] }],
        mindMap: [],
        limitations: [],
      },
    });
    // LLM：resume 不应再要提纲；章节调用只应发生 1 次（第 2 章）
    let sectionCalls = 0;
    const llm: LLMProvider = {
      async generate() {
        sectionCalls += 1;
        return JSON.stringify({
          id: "s2",
          title: "第2章",
          blocks: [{ type: "paragraph", text: "补齐 [[t01]]" }],
        });
      },
    };
    const svc = new ArticleService({ store: h.articles, llm, activities: h.activities });
    const job = h.jobs.create({
      taskId: "t-bg-5",
      kind: "article",
      articleId: record.id,
      attemptNo: 2,
      retryOfJobId: "old-job",
      outlineJson: JSON.stringify(outline),
      doneSections: 1,
      totalSections: 2,
    });
    await runArticleJob(
      { jobs: h.jobs, articles: h.articles, articleService: svc, dataDir: dir },
      job,
      new AbortController().signal,
      () => {},
    );
    expect(sectionCalls).toBe(1); // 只补了第 2 章
    const after = h.articles.get(record.id)!;
    expect(after.status).toBe("done");
    expect(after.content?.sections).toHaveLength(2);
    expect(after.content?.sections[0].title).toBe("第1章"); // 已存章节原样
    expect(h.jobs.get(job.id)?.status).toBe("succeeded");
  });

  it("worker 循环：notify 唤醒 + claimNext 串行", async () => {
    const h = makeHarness(fakeLlm());
    const record = h.articles.create({ taskId: "t-bg-6", detailLevel: "standard", purpose: null, model: "m" });
    h.jobs.create({ taskId: "t-bg-6", kind: "article", articleId: record.id });
    const ran: string[] = [];
    const worker = new JobWorker({
      jobs: h.jobs,
      pollMs: 50,
      run: async (job) => {
        ran.push(job.id);
        h.jobs.update(job.id, { status: "succeeded" });
      },
    });
    worker.start();
    worker.notify();
    await new Promise((r) => setTimeout(r, 200));
    worker.stop();
    expect(ran).toHaveLength(1);
    expect(h.jobs.get(ran[0])?.status).toBe("succeeded");
  });
});
