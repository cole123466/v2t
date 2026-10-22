import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRuntime: vi.fn(),
}));

vi.mock("@/server/runtime", () => ({ getRuntime: mocks.getRuntime }));

import { POST as linkPost } from "@/app/api/tasks/link/route";
import { BILIBILI_FALLBACK_NOTICE } from "@/server/source";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "v2t-link-notice-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  mocks.getRuntime.mockReset();
});

describe("B 站风控提示写入任务", () => {
  it("probe 走官方接口兜底时，任务写入 sourceNotice", async () => {
    const task = {
      id: "task-1",
      originalName: "B 站视频",
      ext: ".mp4",
      sizeBytes: 0,
      durationSec: 120,
      status: "queued",
      progress: 0,
      error: null,
      createdAt: new Date().toISOString(),
      mediaPurgedAt: null,
      sourceKind: "link",
      sourceUrl: "https://www.bilibili.com/video/BV1test",
      sourceTitle: "B 站视频",
      sourceThumbnail: null,
      transcriptOrigin: null,
      downloadPct: null,
      sourceNotice: BILIBILI_FALLBACK_NOTICE,
    };
    const create = vi.fn(() => task);
    mocks.getRuntime.mockReturnValue({
      store: { create, get: () => task, update: vi.fn() },
      runner: { enqueue: vi.fn() },
      dataDir: dir,
      source: {
        probe: vi.fn(async () => ({
          title: "B 站视频",
          durationSec: 120,
          thumbnailUrl: null,
          notice: BILIBILI_FALLBACK_NOTICE,
        })),
      },
    });

    const response = await linkPost(
      new Request("http://localhost/api/tasks/link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://www.bilibili.com/video/BV1test" }),
      }),
    );

    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ sourceNotice: BILIBILI_FALLBACK_NOTICE }),
    );
  });
});
