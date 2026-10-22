import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb, type Db } from "@/server/db";
import { TaskStore, type Task } from "@/server/tasks";

let dir: string;
let db: Db;
let store: TaskStore;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "v2t-store-"));
  db = openDb(path.join(dir, "test.db"));
  store = new TaskStore(db);
});

afterAll(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("TaskStore（Seam A · 任务台账）", () => {
  it("create 落一条 queued 任务并返回完整字段", () => {
    const task = store.create({ originalName: "demo.mp4", ext: ".mp4", sizeBytes: 1024 });
    expect(task.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(task.status).toBe("queued");
    expect(task.progress).toBe(0);
    expect(task.error).toBeNull();
    expect(task.durationSec).toBeNull();
    expect(task.sourceNotice).toBeNull();
    expect(task.createdAt).toBeTruthy();
    expect(store.get(task.id)).toMatchObject({ id: task.id, originalName: "demo.mp4" });
  });

  it("update 能推进状态与进度，失败时保留原因", () => {
    const task = store.create({ originalName: "a.mov", ext: ".mov", sizeBytes: 1 });
    store.update(task.id, { status: "extracting", progress: 50 });
    expect(store.get(task.id)).toMatchObject({ status: "extracting", progress: 50 });
    store.update(task.id, { status: "failed", error: "ffmpeg 处理失败" });
    const failed = store.get(task.id) as Task;
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("ffmpeg 处理失败");
  });

  it("sourceNotice 可写入并读回，旧任务默认空", () => {
    const task = store.create({ originalName: "b.mp4", ext: ".mp4", sizeBytes: 1 });
    expect(store.get(task.id)?.sourceNotice).toBeNull();
    store.update(task.id, { sourceNotice: "B 站触发风控，已使用 720P 兜底" });
    expect(store.get(task.id)?.sourceNotice).toBe("B 站触发风控，已使用 720P 兜底");
  });

  it("list 按创建时间新到旧排序", () => {
    const first = store.create({ originalName: "old.mp4", ext: ".mp4", sizeBytes: 1 });
    const second = store.create({ originalName: "new.mp4", ext: ".mp4", sizeBytes: 1 });
    const ids = store.list().map((t) => t.id);
    expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
  });

  it("get 不存在的任务返回 undefined", () => {
    expect(store.get("nope")).toBeUndefined();
  });
});
