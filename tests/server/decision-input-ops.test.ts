import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openDb, type Db } from "@/server/db";
import { failOrphanTasks } from "@/server/maintenance";
import { TaskRunner } from "@/server/runner";
import { TaskStore } from "@/server/tasks";

let dir: string;
let db: Db;
let store: TaskStore;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "v2t-decision12-"));
  db = openDb(path.join(dir, "test.db"));
  store = new TaskStore(db);
});

afterAll(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// I1：导入页选项前移——tasks 默认两列
// ---------------------------------------------------------------------------

describe("I1 tasks 默认两列（detail_level / purpose）", () => {
  it("create 带上深度与关注点时随任务落库", () => {
    const task = store.create({
      originalName: "a.mp4",
      ext: ".mp4",
      sizeBytes: 10,
      detailLevel: "detailed",
      purpose: "只关心部署步骤",
    });
    expect(task.detailLevel).toBe("detailed");
    expect(task.purpose).toBe("只关心部署步骤");
    const fetched = store.get(task.id);
    expect(fetched?.detailLevel).toBe("detailed");
    expect(fetched?.purpose).toBe("只关心部署步骤");
  });

  it("未选时两列为空（历史任务按 standard 处理由读取方兜底）", () => {
    const task = store.create({ originalName: "b.mp4", ext: ".mp4", sizeBytes: 10 });
    expect(task.detailLevel).toBeNull();
    expect(task.purpose).toBeNull();
  });

  it("上传接口把查询串里的选项传给 store.create", async () => {
    vi.resetModules();
    const create = vi.fn(() => ({ id: "t-upload", status: "queued" }));
    const enqueue = vi.fn();
    vi.doMock("@/server/runtime", () => ({
      getRuntime: () => ({
        store: { create },
        runner: { isQueueFull: () => false, queueLimit: 3, enqueue },
        dataDir: dir,
      }),
    }));
    const { POST } = await import("@/app/api/upload/route");
    const response = await POST(
      new Request(
        "http://localhost/api/upload?name=a.mp4&detailLevel=concise&purpose=" +
          encodeURIComponent("聚焦成本"),
        {
          method: "POST",
          headers: { "content-type": "application/octet-stream", "content-length": "4", cookie: "v2t-device=11111111-2222-4333-8444-555555555555" },
          body: "data",
        },
      ),
    );
    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ detailLevel: "concise", purpose: "聚焦成本" }),
    );
    vi.doUnmock("@/server/runtime");
  });

  it("上传接口拒绝非法深度（400）", async () => {
    vi.resetModules();
    const create = vi.fn();
    vi.doMock("@/server/runtime", () => ({
      getRuntime: () => ({
        store: { create },
        runner: { isQueueFull: () => false, queueLimit: 3, enqueue: vi.fn() },
        dataDir: dir,
      }),
    }));
    const { POST } = await import("@/app/api/upload/route");
    const response = await POST(
      new Request("http://localhost/api/upload?name=a.mp4&detailLevel=extreme", {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "content-length": "4" },
        body: "data",
      }),
    );
    expect(response.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
    vi.doUnmock("@/server/runtime");
  });

  it("链接接口把 body 里的选项传给 store.create", async () => {
    vi.resetModules();
    const create = vi.fn(() => ({ id: "t-link", status: "queued" }));
    vi.doMock("@/server/runtime", () => ({
      getRuntime: () => ({
        store: { create, update: vi.fn(), get: vi.fn(() => undefined) },
        runner: { isQueueFull: () => false, queueLimit: 3, enqueue: vi.fn() },
        dataDir: dir,
        source: {
          probe: async () => ({
            title: "示例视频",
            durationSec: 12,
            thumbnailUrl: null,
            notice: null,
          }),
        },
      }),
    }));
    const { POST } = await import("@/app/api/tasks/link/route");
    const response = await POST(
      new Request("http://localhost/api/tasks/link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: "https://www.bilibili.com/video/BV1test",
          detailLevel: "standard",
          purpose: "面向新手",
        }),
      }),
    );
    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ detailLevel: "standard", purpose: "面向新手" }),
    );
    vi.doUnmock("@/server/runtime");
  });
});

// ---------------------------------------------------------------------------
// I5：取消排队
// ---------------------------------------------------------------------------

/** probe 永不返回：让第一个任务稳定停在处理中，其余留在队列里 */
vi.mock("@/server/ffmpeg", () => ({
  probe: () => new Promise(() => {}),
  extractAudio: async () => {},
  chunkAudio: async () => [],
}));

describe("I5 runner.cancelQueued", () => {
  it("排队中的任务可取消：出队 + 标 canceled，队列位释放", async () => {
    const runner = new TaskRunner({
      store,
      dataDir: dir,
      asr: { async transcribe() { return { segments: [], timestampsMissing: false }; } },
    });
    const t1 = store.create({ originalName: "t1", ext: ".mp4", sizeBytes: 10 });
    const t2 = store.create({ originalName: "t2", ext: ".mp4", sizeBytes: 10 });
    const t3 = store.create({ originalName: "t3", ext: ".mp4", sizeBytes: 10 });
    runner.enqueue(t1.id);
    runner.enqueue(t2.id);
    runner.enqueue(t3.id);

    expect(runner.getQueueSnapshot().queued.map((t) => t.id)).toEqual([t2.id, t3.id]);

    expect(runner.cancelQueued(t2.id)).toBe(true);
    expect(store.get(t2.id)?.status).toBe("canceled");
    // 队列位立即释放：t3 从第 2 位升到第 1 位
    expect(runner.getQueueSnapshot().queued.map((t) => t.id)).toEqual([t3.id]);

    // 处理中与不存在的任务不可取消
    expect(runner.cancelQueued(t1.id)).toBe(false);
    expect(runner.cancelQueued("no-such-id")).toBe(false);
    expect(store.get(t1.id)?.status).not.toBe("canceled");
  });

  it("canceled 是终态：重启收口不会被改判，worker 也不会再捡起", () => {
    const t1 = store.create({ originalName: "orphan", ext: ".mp4", sizeBytes: 10 });
    const t2 = store.create({ originalName: "still-queued", ext: ".mp4", sizeBytes: 10 });
    store.update(t1.id, { status: "canceled" });
    // t2 保持 queued，模拟重启后残留的内存队列语义
    failOrphanTasks(store);
    expect(store.get(t1.id)?.status).toBe("canceled");
    expect(store.get(t2.id)?.status).toBe("failed");
  });
});

describe("I5 POST /api/tasks/[id]/cancel", () => {
  const device = "11111111-2222-4333-8444-555555555555";
  const req = () =>
    new Request("http://localhost/api/tasks/x/cancel", {
      method: "POST",
      headers: { cookie: `v2t-device=${device}` },
    });

  it("排队中的任务取消成功并返回取消后的任务", async () => {
    vi.resetModules();
    const cancelQueued = vi.fn(() => true);
    const canceled = { id: "x", status: "canceled" };
    vi.doMock("@/server/runtime", () => ({
      getRuntime: () => ({
        store: {
          getOwned: vi.fn((id: string, owner: string) =>
            owner === device ? { id, status: "queued" } : undefined,
          ),
          get: vi.fn(() => canceled),
        },
        runner: { cancelQueued },
      }),
    }));
    const { POST } = await import("@/app/api/tasks/[id]/cancel/route");
    const res = await POST(req(), { params: Promise.resolve({ id: "x" }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "canceled" });
    expect(cancelQueued).toHaveBeenCalledWith("x");
    vi.doUnmock("@/server/runtime");
  });

  it("非 queued 状态返回 409，且不触达 runner", async () => {
    vi.resetModules();
    const cancelQueued = vi.fn();
    vi.doMock("@/server/runtime", () => ({
      getRuntime: () => ({
        store: { getOwned: vi.fn(() => ({ id: "x", status: "transcribing" })) },
        runner: { cancelQueued },
      }),
    }));
    const { POST } = await import("@/app/api/tasks/[id]/cancel/route");
    const res = await POST(req(), { params: Promise.resolve({ id: "x" }) });
    expect(res.status).toBe(409);
    expect(cancelQueued).not.toHaveBeenCalled();
    vi.doUnmock("@/server/runtime");
  });

  it("runner 出队失败（如任务已开始处理）返回 409", async () => {
    vi.resetModules();
    vi.doMock("@/server/runtime", () => ({
      getRuntime: () => ({
        store: {
          getOwned: vi.fn(() => ({ id: "x", status: "queued" })),
          get: vi.fn(),
        },
        runner: { cancelQueued: vi.fn(() => false) },
      }),
    }));
    const { POST } = await import("@/app/api/tasks/[id]/cancel/route");
    const res = await POST(req(), { params: Promise.resolve({ id: "x" }) });
    expect(res.status).toBe(409);
    vi.doUnmock("@/server/runtime");
  });

  it("别人的任务按不存在处理（404）", async () => {
    vi.resetModules();
    vi.doMock("@/server/runtime", () => ({
      getRuntime: () => ({
        store: { getOwned: vi.fn(() => undefined) },
        runner: { cancelQueued: vi.fn() },
      }),
    }));
    const { POST } = await import("@/app/api/tasks/[id]/cancel/route");
    const res = await POST(req(), { params: Promise.resolve({ id: "x" }) });
    expect(res.status).toBe(404);
    vi.doUnmock("@/server/runtime");
  });
});