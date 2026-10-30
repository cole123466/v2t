import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb, type Db } from "@/server/db";
import { GenerationStore } from "@/server/generations";
import { TaskStore } from "@/server/tasks";
import {
  deleteTask,
  failOrphanTasks,
  purgeExpiredMedia,
  storageStats,
  type MaintenanceDeps,
} from "@/server/maintenance";

let dir: string;
let db: Db;
let store: TaskStore;
let generations: GenerationStore;
let deps: MaintenanceDeps;

const DAY = 86_400_000;

interface Seed {
  name: string;
  ext?: string;
  status?: "queued" | "extracting" | "transcribing" | "ready" | "failed";
  ageDays?: number;
  files?: ("source" | "audio" | "transcript")[];
  sizes?: Record<string, number>;
  owner?: string;
}

async function seed(s: Seed) {
  const task = store.create({ originalName: s.name, ext: s.ext ?? ".mp4", sizeBytes: 100, owner: s.owner });
  if (s.status && s.status !== "queued") {
    store.update(task.id, { status: s.status });
  }
  if (s.ageDays) {
    const created = new Date(Date.now() - s.ageDays * DAY - 1000).toISOString();
    db.prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run(created, task.id);
  }
  const tdir = path.join(dir, "tasks", task.id);
  await mkdir(tdir, { recursive: true });
  for (const f of s.files ?? []) {
    const file =
      f === "source"
        ? path.join(tdir, `source${task.ext}`)
        : f === "audio"
          ? path.join(tdir, "audio.mp3")
          : path.join(tdir, "transcript.json");
    await writeFile(file, Buffer.alloc(s.sizes?.[f] ?? 16));
  }
  return task;
}

async function exists(p: string) {
  return !!(await stat(p).catch(() => null));
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "v2t-maint-"));
  db = openDb(path.join(dir, "test.db"));
  store = new TaskStore(db);
  generations = new GenerationStore(db);
  deps = { store, generations, dataDir: dir };
});

afterAll(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("媒体保留期清理", () => {
  it("到期任务：源视频与音频被删，转录稿保留并标记 mediaPurgedAt；新任务不受影响；重复执行幂等", async () => {
    const old = await seed({ name: "old.mp4", status: "ready", ageDays: 9, files: ["source", "audio", "transcript"] });
    const fresh = await seed({ name: "new.mp4", status: "ready", files: ["source", "audio", "transcript"] });

    const purged = await purgeExpiredMedia(deps, { retentionDays: 7 });

    expect(purged).toBe(1);
    const oldDir = path.join(dir, "tasks", old.id);
    expect(await exists(path.join(oldDir, "source.mp4"))).toBe(false);
    expect(await exists(path.join(oldDir, "audio.mp3"))).toBe(false);
    expect(await exists(path.join(oldDir, "transcript.json"))).toBe(true);
    expect(store.get(old.id)?.mediaPurgedAt).toBeTruthy();

    const freshTask = store.get(fresh.id)!;
    expect(freshTask.mediaPurgedAt).toBeNull();
    expect(await exists(path.join(dir, "tasks", fresh.id, "source.mp4"))).toBe(true);

    // 幂等：已清理的任务不重复计数
    expect(await purgeExpiredMedia(deps, { retentionDays: 7 })).toBe(0);
  });
});

describe("启动孤儿扫描", () => {
  it("queued/extracting/transcribing 全部转 failed 且原因可见，ready/failed 不动", () => {
    const orphan1 = store.create({ originalName: "q.mp4", ext: ".mp4", sizeBytes: 1 });
    const orphan2 = store.create({ originalName: "e.mp4", ext: ".mp4", sizeBytes: 1 });
    store.update(orphan2.id, { status: "extracting" });
    const orphan3 = store.create({ originalName: "t.mp4", ext: ".mp4", sizeBytes: 1 });
    store.update(orphan3.id, { status: "transcribing" });
    const done = store.create({ originalName: "r.mp4", ext: ".mp4", sizeBytes: 1 });
    store.update(done.id, { status: "ready", progress: 100 });

    const n = failOrphanTasks(store);

    expect(n).toBe(3);
    for (const o of [orphan1, orphan2, orphan3]) {
      const t = store.get(o.id)!;
      expect(t.status).toBe("failed");
      expect(t.error).toMatch(/服务重启/);
    }
    expect(store.get(done.id)?.status).toBe("ready");
    // 二次执行无事可做
    expect(failOrphanTasks(store)).toBe(0);
  });
});

describe("任务删除", () => {
  it("目录、任务行、文案行一并消失；不存在返回 false", async () => {
    const task = await seed({ name: "del.mp4", status: "ready", files: ["source", "transcript"] });
    generations.create({
      taskId: task.id,
      mode: "auto",
      templateId: "brief",
      prompt: null,
      model: "glm-test",
    });

    expect(await deleteTask(deps, task.id)).toBe(true);
    expect(await exists(path.join(dir, "tasks", task.id))).toBe(false);
    expect(store.get(task.id)).toBeUndefined();
    expect(generations.listForTask(task.id)).toHaveLength(0);
    expect(await deleteTask(deps, task.id)).toBe(false);
  });
});

describe("存储统计", () => {
  it("媒体字节精确、总数覆盖全部文件、任务与清理计数正确", async () => {
    const a = await seed({
      name: "stat-a.mp4",
      status: "ready",
      files: ["source", "audio", "transcript"],
      sizes: { source: 1000, audio: 200, transcript: 300 },
    });
    await seed({ name: "stat-b.mp4", status: "ready", files: ["source"], sizes: { source: 4000 } });

    const stats = await storageStats(deps);

    expect(stats.taskCount).toBeGreaterThanOrEqual(2);
    expect(stats.mediaBytes).toBeGreaterThanOrEqual(1000 + 200 + 4000);
    expect(stats.totalBytes).toBeGreaterThan(stats.mediaBytes); // 还含 transcript 与 db 文件
    expect(stats.purgedCount).toBeGreaterThanOrEqual(1); // 上一组用例中 old.mp4 已清理
    expect(store.get(a.id)).toBeDefined();
  });

  it("按 owner 过滤：只统计该设备的任务目录，其他设备的不计入", async () => {
    await seed({ name: "mine.mp4", status: "ready", files: ["source"], sizes: { source: 500 }, owner: "device-a" });
    await seed({ name: "other.mp4", status: "ready", files: ["source"], sizes: { source: 9000 }, owner: "device-b" });

    const stats = await storageStats(deps, { owner: "device-a" });

    expect(stats.taskCount).toBe(1);
    expect(stats.mediaBytes).toBe(500);
    expect(stats.totalBytes).toBeLessThan(9000); // 不含 device-b 的 source
    // 全量口径不受影响（内部用途）；同文件前面的用例已建了若干任务
    const all = await storageStats(deps);
    expect(all.taskCount).toBeGreaterThanOrEqual(2);
    expect(all.mediaBytes).toBeGreaterThanOrEqual(9500);
  });
});
