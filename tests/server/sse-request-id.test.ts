import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  getRuntime: vi.fn(),
  readFrameManifest: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile }));
vi.mock("@/server/runtime", () => ({ getRuntime: mocks.getRuntime }));
vi.mock("@/server/frames", () => ({ readFrameManifest: mocks.readFrameManifest }));

import { POST as articlesPost } from "@/app/api/tasks/[id]/articles/route";
import { POST as generationsPost } from "@/app/api/tasks/[id]/generations/route";
import { POST as qaPost } from "@/app/api/tasks/[id]/qa/route";

const TRANSCRIPT = JSON.stringify({
  durationSec: 10,
  segments: [{ start: 0, end: 2, text: "测试转写" }],
});

const REQUEST_ID = "trace-sse-12345678";

function params(id = "task-1") {
  return { params: Promise.resolve({ id }) };
}

function activities() {
  return {
    start: vi.fn(() => ({ id: "activity-1" })),
    finish: vi.fn(),
    newRunId: vi.fn(() => "run-1"),
  };
}

function errorEvent(text: string): Record<string, unknown> | null {
  for (const block of text.split("\n\n")) {
    if (!/^event: error$/m.test(block)) continue;
    const data = /^data: (.+)$/m.exec(block)?.[1];
    return data ? (JSON.parse(data) as Record<string, unknown>) : null;
  }
  return null;
}

beforeEach(() => {
  mocks.readFile.mockReset();
  mocks.readFile.mockResolvedValue(TRANSCRIPT);
  mocks.getRuntime.mockReset();
  mocks.readFrameManifest.mockReset();
  mocks.readFrameManifest.mockResolvedValue(null);
});

describe("SSE 错误事件携带 request_id", () => {
  it("文案生成失败", async () => {
    mocks.getRuntime.mockReturnValue({
      store: { getOwned: () => ({ id: "task-1", status: "ready" }) },
      dataDir: "/tmp/v2t-test",
      generationService: {
        generateForTask: async () => {
          throw new Error("模拟模型失败");
        },
      },
    });

    const response = await generationsPost(
      new Request("http://localhost/api/tasks/task-1/generations", {
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": REQUEST_ID },
        body: JSON.stringify({ mode: "auto", templateId: "refine" }),
      }),
      params(),
    );

    const event = errorEvent(await response.text());
    expect(event).toMatchObject({ message: "模拟模型失败", request_id: REQUEST_ID });
  });

  it("问答失败", async () => {
    mocks.getRuntime.mockReturnValue({
      store: { getOwned: () => ({ id: "task-1", status: "ready" }) },
      dataDir: "/tmp/v2t-test",
      activities: activities(),
      qaService: {
        ask: async () => {
          throw new Error("模拟问答失败");
        },
      },
    });

    const response = await qaPost(
      new Request("http://localhost/api/tasks/task-1/qa", {
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": REQUEST_ID },
        body: JSON.stringify({ question: "这个视频讲了什么？" }),
      }),
      params(),
    );

    const event = errorEvent(await response.text());
    expect(event).toMatchObject({ message: "模拟问答失败", request_id: REQUEST_ID });
  });

  it("图文文章失败", async () => {
    mocks.getRuntime.mockReturnValue({
      store: { getOwned: () => ({ id: "task-1", status: "ready", mediaPurgedAt: null }) },
      dataDir: "/tmp/v2t-test",
      activities: activities(),
      articles: { listForTask: () => [] },
      articleService: {
        generate: async () => {
          throw new Error("模拟文章失败");
        },
      },
    });

    const response = await articlesPost(
      new Request("http://localhost/api/tasks/task-1/articles", {
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": REQUEST_ID },
        body: JSON.stringify({ detailLevel: "standard" }),
      }),
      params(),
    );

    const event = errorEvent(await response.text());
    expect(event).toMatchObject({ message: "模拟文章失败", request_id: REQUEST_ID });
  });
});
