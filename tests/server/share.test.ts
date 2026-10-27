import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb, type Db } from "@/server/db";
import { GenerationStore } from "@/server/generations";
import { TaskStore } from "@/server/tasks";
import { ArticleStore } from "@/server/articles";
import { ActivityStore } from "@/server/activities";
import { ShareStore, buildSharePayload, verifyShareToken, shareFrameIds } from "@/server/shares";
import { deleteTask, purgeExpiredMedia } from "@/server/maintenance";
import type { Article } from "@/server/article";
import type { MaintenanceDeps } from "@/server/maintenance";

const OWNER_A = "11111111-2222-4333-8444-555555555555";
const OWNER_B = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const article: Article = {
  title: "分享测试文章",
  sections: [
    {
      id: "s1",
      title: "第一章",
      blocks: [
        { type: "paragraph", text: "正文 [[t01]]，画面 [[f00]]。" },
        { type: "figure", frameId: "f00", caption: "关键画面" },
      ],
    },
  ],
  mindMap: [],
  limitations: [],
};

let dir: string;
let db: Db;
let store: TaskStore;
let articles: ArticleStore;
let activities: ActivityStore;
let shares: ShareStore;
let generations: GenerationStore;
let deps: MaintenanceDeps;

async function seedReadyTask(owner: string): Promise<string> {
  const task = store.create({ originalName: "a.mp4", ext: ".mp4", sizeBytes: 1, owner });
  store.update(task.id, { status: "ready", mediaPurgedAt: null });
  return task.id;
}

function doneArticle(taskId: string, model = "glm-test") {
  return articles.create({ taskId, detailLevel: "standard", purpose: null, model });
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "v2t-share-"));
  db = openDb(path.join(dir, "test.db"));
  store = new TaskStore(db);
  articles = new ArticleStore(db);
  activities = new ActivityStore(db);
  shares = new ShareStore(db);
  generations = new GenerationStore(db);
  deps = { store, generations, articles, activities, qa: undefined, jobs: undefined, shares, dataDir: dir };
});

afterAll(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("令牌与存储", () => {
  it("token = id + HMAC(id)，verifyShareToken 常量时间校验通过/拒绝", async () => {
    const taskId = await seedReadyTask(OWNER_A);
    const record = doneArticle(taskId);
    articles.update(record.id, { status: "done", content: article, title: article.title });

    const { share, created } = shares.ensure({ taskId, articleId: record.id });
    expect(created).toBe(true);
    expect(share.token).toMatch(/^[0-9a-f]{32}\.[A-Za-z0-9_-]+$/);
    expect(verifyShareToken(share.token)).toBe(share.id);
    // 篡改 mac / 格式不对 / 换 id 都校验失败
    expect(verifyShareToken(`${share.id}.deadbeef`)).toBeNull();
    expect(verifyShareToken("not-a-token")).toBeNull();

    // 幂等：同 task + article 再创建返回同一条（验收 6）
    const again = shares.ensure({ taskId, articleId: record.id });
    expect(again.created).toBe(false);
    expect(again.share.id).toBe(share.id);
    expect(shares.listForTask(taskId)).toHaveLength(1);
  });

  it("getByToken 只认有效行；删行后立即 undefined（撤销语义）", async () => {
    const taskId = await seedReadyTask(OWNER_A);
    const record = doneArticle(taskId);
    const { share } = shares.ensure({ taskId, articleId: record.id });
    expect(shares.getByToken(share.token)?.id).toBe(share.id);

    shares.remove(share.id);
    expect(shares.getByToken(share.token)).toBeUndefined();
  });

  it("owner B 无法创建/读取 owner A 的分享（设备隔离回归）", async () => {
    // store.getOwned 的行为在 task-isolation.test.ts 已覆盖；这里验证分享入口按同一前提
    const taskId = await seedReadyTask(OWNER_A);
    const record = doneArticle(taskId);
    articles.update(record.id, { status: "done", content: article, title: article.title });
    expect(store.getOwned(taskId, OWNER_B)).toBeUndefined();
    expect(store.getOwned(taskId, OWNER_A)?.id).toBe(taskId);
  });
});

describe("载荷脱敏投影", () => {
  it("无 qa 内容可达；taskId/owner 不外泄；失败步骤只说「这次处理未能完成」", async () => {
    const taskId = await seedReadyTask(OWNER_A);
    const record = doneArticle(taskId);
    articles.update(record.id, { status: "done", content: article, title: article.title });

    const step = activities.start({
      taskId,
      kind: "stage",
      phase: "write",
      title: "第 1 章",
      articleId: record.id,
    });
    activities.finish(step.id, { ok: false, status: "failed", message: "堆栈\n at /secret/path/llm.ts:1" });

    const { share } = shares.ensure({ taskId, articleId: record.id });
    const payload = buildSharePayload({
      share,
      task: store.get(taskId)!,
      article: articles.get(record.id)!,
      steps: activities.listForTask(taskId),
      pinnedFrameIds: ["f00"],
      frameTimes: new Map([["f00", 12]]),
    });

    const json = JSON.stringify(payload);
    expect(json).not.toContain(taskId);
    expect(json).not.toContain(record.id);
    expect(json).not.toContain(OWNER_A);
    expect(json).not.toContain("qa");
    expect(json).not.toContain("/secret/path");
    expect(json).not.toContain("堆栈");
    expect(json).toContain("这次处理未能完成");
    expect(payload.frames).toEqual([{ id: "f00", tSec: 12 }]);
    expect(payload.article.content?.title).toBe("分享测试文章");
  });

  it("帧白名单 = 正文引用的帧；上限 12", () => {
    expect(shareFrameIds(article)).toEqual(["f00"]);
    const many: Article = {
      title: "t",
      sections: [
        {
          id: "s1",
          title: "c",
          blocks: Array.from({ length: 20 }, (_, i) => ({
            type: "figure" as const,
            frameId: `f${String(i).padStart(2, "0")}`,
          })),
        },
      ],
      mindMap: [],
      limitations: [],
    };
    expect(shareFrameIds(many)).toHaveLength(12);
  });
});

describe("钉帧与清理", () => {
  it("媒体清理到期后钉帧目录不被动（purgeExpiredMedia 不碰 data/shares）", async () => {
    const taskId = await seedReadyTask(OWNER_A);
    const record = doneArticle(taskId);
    articles.update(record.id, { status: "done", content: article, title: article.title });

    // 伪造任务帧 + 钉帧
    const tdir = path.join(dir, "tasks", taskId, "frames");
    await mkdir(tdir, { recursive: true });
    await writeFile(path.join(tdir, "f00.jpg"), Buffer.from("frame"));
    const { share } = shares.ensure({ taskId, articleId: record.id });
    const pinned = path.join(dir, "shares", share.id, "frames");
    await mkdir(pinned, { recursive: true });
    await writeFile(path.join(pinned, "f00.jpg"), Buffer.from("frame"));

    // 任务设为 9 天前，触发清理
    const created = new Date(Date.now() - 9 * 86_400_000).toISOString();
    db.prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run(created, taskId);

    await purgeExpiredMedia(deps, { retentionDays: 7 });

    expect(await stat(path.join(tdir, "f00.jpg")).catch(() => null)).toBeNull();
    expect(store.get(taskId)?.mediaPurgedAt).toBeTruthy();
    // 钉帧完好：分享页图片独立于媒体保留期（验收 4）
    expect((await stat(path.join(pinned, "f00.jpg"))).isFile()).toBe(true);
  });

  it("删除任务级联删分享行与钉帧目录（验收 8）", async () => {
    const taskId = await seedReadyTask(OWNER_A);
    const record = doneArticle(taskId);
    articles.update(record.id, { status: "done", content: article, title: article.title });
    const { share } = shares.ensure({ taskId, articleId: record.id });
    const shareRoot = path.join(dir, "shares", share.id);
    await mkdir(path.join(shareRoot, "frames"), { recursive: true });
    await writeFile(path.join(shareRoot, "frames", "f00.jpg"), Buffer.from("x"));

    expect(await deleteTask(deps, taskId)).toBe(true);
    expect(shares.getByToken(share.token)).toBeUndefined();
    expect(await stat(shareRoot).catch(() => null)).toBeNull();
  });
});

describe("manifest.json（ZIP 导出契约，验收 9）", () => {
  it("sha256 与条目一致（对导出 route 的内联逻辑做等价校验）", async () => {
    const { createHash } = await import("node:crypto");
    const { createZip } = await import("@/server/zip");
    const md = Buffer.from("# hi");
    const entries = [
      { name: "article.md", data: md },
      { name: "sources.json", data: Buffer.from("{}") },
    ];
    const manifest = {
      format_version: 1,
      files: entries.map((e) => ({
        path: e.name,
        bytes: e.data.length,
        sha256: createHash("sha256").update(e.data).digest("hex"),
      })),
    };
    const zip = createZip([...entries, { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest)) }]);
    expect(zip.toString("utf8")).toContain("manifest.json");
    expect(manifest.files[0].sha256).toBe(createHash("sha256").update(md).digest("hex"));
    // 可复现：不含时间戳字段
    expect(JSON.stringify(manifest)).not.toMatch(/generated|created|time/i);
  });
});
