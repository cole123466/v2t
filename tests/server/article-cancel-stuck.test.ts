import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getRuntime: vi.fn() }));

vi.mock("@/server/runtime", () => ({ getRuntime: mocks.getRuntime }));

import { POST as cancelPost } from "@/app/api/tasks/[id]/articles/[articleId]/cancel/route";
import { GET as eventsGet } from "@/app/api/tasks/[id]/articles/[articleId]/events/route";
import { JobWorker, type JobStore } from "@/server/jobs";

function params(articleId = "article-1") {
  return { params: Promise.resolve({ id: "task-1", articleId }) };
}

function article(status = "streaming") {
  return {
    id: "article-1",
    taskId: "task-1",
    status,
    title: null,
    content: { title: "", sections: [], mindMap: [], limitations: [] },
  };
}

function job(status = "queued") {
  return {
    id: "job-1",
    taskId: "task-1",
    articleId: "article-1",
    status,
    phase: null,
    doneSections: 0,
    totalSections: 0,
    error: null,
  };
}

beforeEach(() => {
  mocks.getRuntime.mockReset();
});

describe("取消排队中的图文生成", () => {
  it("cancel 把仍为 streaming 的文章回写为 interrupted", async () => {
    const update = vi.fn();
    mocks.getRuntime.mockReturnValue({
      store: { getOwned: () => ({ id: "task-1" }) },
      articles: { get: () => article("streaming"), update },
      jobs: { activeForArticle: () => job("queued") },
      worker: { cancel: () => true },
      activities: { runningIdsForRun: () => [] },
    });

    const res = await cancelPost(
      new Request("http://localhost/api/tasks/task-1/articles/article-1/cancel", { method: "POST" }),
      params(),
    );

    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith("article-1", {
      status: "interrupted",
      error: "生成已取消，可继续生成",
    });
  });

  it("job 已结束导致取消失败时不改文章状态", async () => {
    const update = vi.fn();
    mocks.getRuntime.mockReturnValue({
      store: { getOwned: () => ({ id: "task-1" }) },
      articles: { get: () => article("streaming"), update },
      jobs: { activeForArticle: () => job("running") },
      worker: { cancel: () => false },
      activities: { runningIdsForRun: () => [] },
    });

    const res = await cancelPost(
      new Request("http://localhost/api/tasks/task-1/articles/article-1/cancel", { method: "POST" }),
      params(),
    );

    expect(res.status).toBe(409);
    expect(update).not.toHaveBeenCalled();
  });
});

describe("排队中取消的通知", () => {
  it("取消排队 job 时向已连上的订阅者发终态事件", () => {
    const update = vi.fn();
    const jobs = { get: () => job("queued"), update } as unknown as JobStore;
    const worker = new JobWorker({ jobs, run: async () => {} });
    const events: Array<{ event: string; data: unknown }> = [];
    worker.subscribe("article-1", (e) => events.push(e));

    expect(worker.cancel("job-1")).toBe(true);
    expect(update).toHaveBeenCalledWith("job-1", { status: "canceled", error: "用户取消生成" });
    expect(events).toEqual([{ event: "error", data: { message: "生成已取消", canceled: true } }]);
  });
});

describe("生成事件流收流", () => {
  it("job 已取消时只推一次快照就关闭，并把遗留的 streaming 文章落为 interrupted", async () => {
    const update = vi.fn();
    let current = article("streaming");
    mocks.getRuntime.mockReturnValue({
      store: { getOwned: () => ({ id: "task-1" }) },
      articles: {
        get: () => current,
        update: (id: string, patch: Record<string, unknown>) => {
          update(id, patch);
          current = { ...current, ...patch } as ReturnType<typeof article>;
        },
      },
      jobs: { latestForArticle: () => ({ ...job("canceled"), kind: "article" }) },
      worker: { subscribe: vi.fn() },
    });

    const res = await eventsGet(
      new Request("http://localhost/api/tasks/task-1/articles/article-1/events"),
      params(),
    );

    // 流已关闭：text() 能直接读完，不会一直等待
    const text = await res.text();
    expect(update).toHaveBeenCalledWith("article-1", {
      status: "interrupted",
      error: "生成已取消，可继续生成",
    });
    expect(text).toContain("event: snapshot");
    expect(text).toContain('"status":"canceled"');
    expect(text).toContain('"status":"interrupted"');
    expect(text.match(/event: snapshot/g)).toHaveLength(1);
  });

  it("error 事件到达时先自愈文章状态再推快照（cancel 广播早于回写的竞态）", async () => {
    const update = vi.fn();
    let current = article("streaming");
    let latest: { kind: string; status: string } = { ...job("running"), kind: "article" };
    let handler: ((e: { event: string; data: unknown }) => void) | null = null;
    mocks.getRuntime.mockReturnValue({
      store: { getOwned: () => ({ id: "task-1" }) },
      articles: {
        get: () => current,
        update: (id: string, patch: Record<string, unknown>) => {
          update(id, patch);
          current = { ...current, ...patch } as ReturnType<typeof article>;
        },
      },
      jobs: { latestForArticle: () => latest },
      worker: {
        subscribe: (_id: string, fn: (e: { event: string; data: unknown }) => void) => {
          handler = fn;
          return () => {};
        },
      },
    });

    const res = await eventsGet(
      new Request("http://localhost/api/tasks/task-1/articles/article-1/events"),
      params(),
    );

    // 模拟 worker.cancel() 先广播、cancel 路由还没来得及回写文章的窗口
    latest = { ...job("canceled"), kind: "article" };
    (handler as ((e: { event: string; data: unknown }) => void) | null)?.({
      event: "error",
      data: { message: "生成已取消", canceled: true },
    });

    const text = await res.text();
    expect(update).toHaveBeenCalledWith("article-1", {
      status: "interrupted",
      error: "生成已取消，可继续生成",
    });
    expect(text).toContain("event: error");
    expect(text).toContain('"status":"interrupted"');
  });
});
