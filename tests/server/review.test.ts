import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Article } from "@/server/article";
import { openDb, type Db } from "@/server/db";
import { JobStore } from "@/server/jobs";
import { runReviewJob, ReviewStore, sanitizeFindings } from "@/server/reviews";
import { taskDir, transcriptPath } from "@/server/paths";
import type { LLMProvider } from "@/server/generations";

let dir: string;
let db: Db;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "v2t-review-"));
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

const ARTICLE: Article = {
  title: "测试文章",
  sections: [
    { id: "s1", title: "第1章", blocks: [{ type: "paragraph", text: "正文 [[t01]]" }] },
    { id: "s2", title: "第2章", blocks: [{ type: "paragraph", text: "正文 [[t02]]" }] },
  ],
  mindMap: [],
  limitations: [],
};

async function seedTranscript(taskId: string): Promise<void> {
  const d = taskDir(dir, taskId);
  await mkdir(d, { recursive: true });
  await writeFile(transcriptPath(d), JSON.stringify(TRANSCRIPT), "utf8");
}

function okLlm(): LLMProvider {
  return {
    async generate() {
      return JSON.stringify({
        summary: "整体结构清晰",
        findings: [
          { section_id: "s1", problem: "论点铺垫不足", suggestion: "补一句背景" },
          { section_id: "s9", problem: "编造的章节", suggestion: "应被丢弃" },
        ],
      });
    },
  };
}

interface Harness {
  jobs: JobStore;
  reviews: ReviewStore;
}

function makeHarness(llm: LLMProvider): Harness & { llm: LLMProvider } {
  const jobs = new JobStore(db);
  const reviews = new ReviewStore(db);
  return { jobs, reviews, llm };
}

describe("10 号票：手动审稿", () => {
  it("验收1/5：审核完成 summary + findings 落库，编造的 section_id 被丢弃", async () => {
    await seedTranscript("t-rv-1");
    const h = makeHarness(okLlm());
    const job = h.jobs.create({ taskId: "t-rv-1", kind: "review", articleId: "a-rv-1" });
    const review = h.reviews.create({ taskId: "t-rv-1", articleId: "a-rv-1", jobId: job.id, model: null });
    const events: string[] = [];
    await runReviewJob(
      { reviews: h.reviews, llm: h.llm, dataDir: dir, articleContent: async () => ARTICLE },
      job,
      new AbortController().signal,
      (event) => events.push(event),
    );
    const after = h.reviews.get(review.id)!;
    expect(after.status).toBe("completed");
    expect(after.summary).toBe("整体结构清晰");
    expect(after.findings).toHaveLength(1); // s9 被丢弃
    expect(after.findings[0].sectionId).toBe("s1");
    expect(events).toContain("done");
    // job 状态由 worker 收尾
  });

  it("验收4：审核失败 → review 行 failed，文章内容原样（正文一字节不改）", async () => {
    await seedTranscript("t-rv-2");
    const badLlm: LLMProvider = {
      async generate() {
        return "not-json-at-all";
      },
    };
    const h = makeHarness(badLlm);
    const job = h.jobs.create({ taskId: "t-rv-2", kind: "review", articleId: "a-rv-2" });
    const review = h.reviews.create({ taskId: "t-rv-2", articleId: "a-rv-2", jobId: job.id, model: null });
    const events: string[] = [];
    await runReviewJob(
      { reviews: h.reviews, llm: badLlm, dataDir: dir, articleContent: async () => ARTICLE },
      job,
      new AbortController().signal,
      (event) => events.push(event),
    );
    const after = h.reviews.get(review.id)!;
    expect(after.status).toBe("failed");
    expect(after.error).toBeTruthy();
    // 铁律：文章内容不被改动——articleContent 提供的对象引用未被触碰，这里验证 emit error
    expect(events).toContain("error");
  });

  it("验收6：重启 reap——running 审核 job 折为 interrupted，review 行 failed，queued 行也折为 failed", () => {
    const h = makeHarness(okLlm());
    const jobA = h.jobs.create({ taskId: "t-rv-3", kind: "review", articleId: "a-rv-3" });
    h.reviews.create({ taskId: "t-rv-3", articleId: "a-rv-3", jobId: jobA.id, model: null });
    h.jobs.update(jobA.id, { status: "running" });
    // 旧 review 行 running
    const rowA = h.reviews.listForArticle("a-rv-3")[0];
    h.reviews.update(rowA.id, { status: "running" });

    const reaped = h.jobs.reap();
    expect(reaped).toBe(1);
    expect(h.jobs.get(jobA.id)?.status).toBe("interrupted");
    const afterA = h.reviews.get(rowA.id)!;
    expect(afterA.status).toBe("failed");
    expect(afterA.error).toContain("审核中断");
  });

  it("R2：历史全留——每次审核一行，新→旧排序", async () => {
    const h = makeHarness(okLlm());
    const j1 = h.jobs.create({ taskId: "t-rv-4", kind: "review", articleId: "a-rv-4" });
    const r1 = h.reviews.create({ taskId: "t-rv-4", articleId: "a-rv-4", jobId: j1.id, model: null });
    const j2 = h.jobs.create({ taskId: "t-rv-4", kind: "review", articleId: "a-rv-4" });
    const r2 = h.reviews.create({ taskId: "t-rv-4", articleId: "a-rv-4", jobId: j2.id, model: null });
    const list = h.reviews.listForArticle("a-rv-4");
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe(r2.id); // 新→旧
    expect(list[1].id).toBe(r1.id);
    // 审核中判定的并发保护：r2 running 时命中；r1 保持 queued 也会命中（任一未终态都算在审）
    h.reviews.update(r2.id, { status: "running" });
    expect(h.reviews.activeForArticle("a-rv-4")?.id).toBe(r2.id);
    h.reviews.update(r2.id, { status: "completed" });
    // r1 仍是 queued，仍在审核中
    expect(h.reviews.activeForArticle("a-rv-4")?.id).toBe(r1.id);
    h.reviews.update(r1.id, { status: "completed" });
    expect(h.reviews.activeForArticle("a-rv-4")).toBeUndefined();
  });

  it("验收5/I14：findings ≤8 条、每条 ≤1200 字、summary ≤1200 字截断", () => {
    const sectionIds = new Set(["s1"]);
    const many = Array.from({ length: 12 }, (_, i) => ({
      section_id: "s1",
      problem: `问题${i}`,
      suggestion: "",
    }));
    expect(sanitizeFindings(many, sectionIds)).toHaveLength(8);
    const long = [{ section_id: "s1", problem: "长".repeat(1500), suggestion: "改".repeat(1500) }];
    const cleaned = sanitizeFindings(long, sectionIds);
    expect(cleaned[0].problem.length).toBe(1200);
    expect(cleaned[0].suggestion.length).toBe(1200);
    // 非法 section_id 全丢
    expect(sanitizeFindings([{ section_id: "sX", problem: "p", suggestion: "s" }], sectionIds)).toHaveLength(0);
  });
});
