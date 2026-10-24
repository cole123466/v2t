import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openDb, type Db } from "@/server/db";
import {
  DEFAULT_QUEUE_LIMIT,
  QUEUE_FULL_CODE,
  QueueFullError,
  TaskRunner,
} from "@/server/runner";
import { TaskStore } from "@/server/tasks";

let dir: string;
let db: Db;
let store: TaskStore;

/** 卡住 process 的 ASR：让任务一直停留在处理中，便于断言 active / queued */
function blockingRunner() {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runner = new TaskRunner({
    store,
    dataDir: dir,
    asr: {
      async transcribe() {
        await gate;
        return { segments: [{ start: 0, end: 1, text: "转写" }], timestampsMissing: false };
      },
    },
  });
  return { runner, release };
}

function makeTask(name: string) {
  return store.create({ originalName: name, ext: ".mp4", sizeBytes: 10 });
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "v2t-queue-"));
  db = openDb(path.join(dir, "test.db"));
  store = new TaskStore(db);
});

afterAll(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("队列容量（排队上限 3）", () => {
  it("默认上限是 3", () => {
    expect(DEFAULT_QUEUE_LIMIT).toBe(3);
    const { runner } = blockingRunner();
    expect(runner.queueLimit).toBe(3);
  });

  it("空队列不判满，快照只有上限", () => {
    const { runner } = blockingRunner();
    expect(runner.isQueueFull()).toBe(false);
    expect(runner.getQueueSnapshot()).toEqual({ active: [], queued: [], queuedLimit: 3 });
  });

  it("排满 3 个后第 4 个被拒绝，且快照区分处理中与排队中", async () => {
    const { runner, release } = blockingRunner();
    // 缺少源文件的任务会很快 failed，这里只关心排队计数，直接操作队列语义：
    // 第一个任务由 drain 取出成为 active，其余 3 个留在 queue 里
    const ids = [makeTask("t1"), makeTask("t2"), makeTask("t3"), makeTask("t4")].map((t) => t.id);
    runner.enqueue(ids[0]);
    runner.enqueue(ids[1]);
    runner.enqueue(ids[2]);
    runner.enqueue(ids[3]);

    expect(runner.isQueueFull()).toBe(true);
    expect(() => runner.enqueue(makeTask("t5").id)).toThrow(QueueFullError);
    try {
      runner.enqueue(makeTask("t6").id);
    } catch (err) {
      expect((err as QueueFullError).code).toBe(QUEUE_FULL_CODE);
      expect((err as QueueFullError).message).toMatch(/队列已满/);
    }

    const snapshot = runner.getQueueSnapshot();
    expect(snapshot.queuedLimit).toBe(3);
    expect(snapshot.queued.map((t) => t.id)).toEqual([ids[1], ids[2], ids[3]]);
    expect(snapshot.active.map((t) => t.id)).toEqual([ids[0]]);

    release();
    await runner.whenIdle();
  });

  it("处理完成后空出的位置可以继续入队", async () => {
    const { runner, release } = blockingRunner();
    const tasks = [makeTask("a"), makeTask("b"), makeTask("c"), makeTask("d")];
    for (const task of tasks) runner.enqueue(task.id);
    expect(runner.isQueueFull()).toBe(true);

    release();
    await runner.whenIdle();
    expect(runner.isQueueFull()).toBe(false);
    expect(runner.getQueueSnapshot()).toMatchObject({ active: [], queued: [] });
    expect(() => runner.enqueue(makeTask("e").id)).not.toThrow();
    await runner.whenIdle();
  });

  it("queueLimit 可配置", () => {
    const runner = new TaskRunner({
      store,
      dataDir: dir,
      queueLimit: 1,
      asr: { async transcribe() { return { segments: [], timestampsMissing: false }; } },
    });
    expect(runner.queueLimit).toBe(1);
    expect(runner.isQueueFull()).toBe(false);
    runner.enqueue(makeTask("one").id);
    runner.enqueue(makeTask("two").id);
    expect(runner.isQueueFull()).toBe(true);
    expect(() => runner.enqueue(makeTask("three").id)).toThrow(QueueFullError);
    return runner.whenIdle();
  });
});

describe("GET /api/queue", () => {
  it("返回队列快照，并把设备 ID 透传给 runner（别人的任务不出现）", async () => {
    vi.resetModules();
    const snapshot = {
      active: [],
      queued: [],
      queuedLimit: DEFAULT_QUEUE_LIMIT,
    };
    const owners: Array<string | undefined> = [];
    vi.doMock("@/server/runtime", () => ({
      getRuntime: () => ({
        runner: {
          getQueueSnapshot: (owner?: string) => {
            owners.push(owner);
            return snapshot;
          },
        },
      }),
    }));
    const { GET } = await import("@/app/api/queue/route");
    const device = "11111111-2222-4333-8444-555555555555";
    const response = await GET(
      new Request("http://localhost/api/queue", { headers: { cookie: `v2t-device=${device}` } }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(snapshot);
    expect(owners).toEqual([device]);
    vi.doUnmock("@/server/runtime");
  });
});

describe("任务创建在队列已满时返回 429", () => {
  it("上传接口在读取文件体之前就拒绝", async () => {
    vi.resetModules();
    const create = vi.fn();
    const enqueue = vi.fn();
    vi.doMock("@/server/runtime", () => ({
      getRuntime: () => ({
        store: { create },
        runner: { isQueueFull: () => true, queueLimit: 3, enqueue },
        dataDir: dir,
      }),
    }));
    const { POST } = await import("@/app/api/tasks/route");
    const response = await POST(
      new Request("http://localhost/api/tasks?name=full.mp4", {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "content-length": "4" },
        body: "data",
      }),
    );
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ code: QUEUE_FULL_CODE });
    expect(create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    vi.doUnmock("@/server/runtime");
  });

  it("链接接口在 probe 之前就拒绝", async () => {
    vi.resetModules();
    const probe = vi.fn();
    vi.doMock("@/server/runtime", () => ({
      getRuntime: () => ({
        store: { create: vi.fn() },
        runner: { isQueueFull: () => true, queueLimit: 3, enqueue: vi.fn() },
        dataDir: dir,
        source: { probe },
      }),
    }));
    const { POST } = await import("@/app/api/tasks/link/route");
    const response = await POST(
      new Request("http://localhost/api/tasks/link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://www.bilibili.com/video/BV1test" }),
      }),
    );
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ code: QUEUE_FULL_CODE });
    expect(probe).not.toHaveBeenCalled();
    vi.doUnmock("@/server/runtime");
  });
});
