import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getRuntime: vi.fn() }));

vi.mock("@/server/runtime", () => ({ getRuntime: mocks.getRuntime }));

import { POST as cancelPost } from "@/app/api/tasks/[id]/articles/[articleId]/cancel/route";
import { GET as eventsGet } from "@/app/api/tasks/[id]/articles/[articleId]/events/route";

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

describe("生成事件流收流", () => {
  it("job 已取消时只推一次快照就关闭，不挂空连接", async () => {
    mocks.getRuntime.mockReturnValue({
      store: { getOwned: () => ({ id: "task-1" }) },
      articles: { get: () => article("streaming") },
      jobs: { latestForArticle: () => job("canceled") },
      worker: { subscribe: vi.fn() },
    });

    const res = await eventsGet(
      new Request("http://localhost/api/tasks/task-1/articles/article-1/events"),
      params(),
    );

    // 流已关闭：text() 能直接读完，不会一直等待
    const text = await res.text();
    expect(text).toContain("event: snapshot");
    expect(text).toContain('"status":"canceled"');
    expect(text.match(/event: snapshot/g)).toHaveLength(1);
  });
});
