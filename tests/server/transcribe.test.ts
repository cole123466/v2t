import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb, type Db } from "@/server/db";
import type { ASRProvider, ASRResult, Transcript } from "@/server/asr";
import { TaskRunner } from "@/server/runner";
import { TaskStore, type Task } from "@/server/tasks";

const run = promisify(execFile);

let dir: string;
let db: Db;
let store: TaskStore;
let fixture: string;

/** 假 ASR：每次调用返回段内相对时间戳，段文本带调用序号，供偏移合并断言 */
function makeFakeAsr(behavior: "ok" | "boom"): ASRProvider & { calls: string[] } {
  const self = {
    calls: [] as string[],
    async transcribe(file: string): Promise<ASRResult> {
      self.calls.push(file);
      if (behavior === "boom") throw new Error("ASR 服务不可用（模拟）");
      const n = self.calls.length;
      return {
        segments: [
          { start: 0.1, end: 0.9, text: `第${n}块-甲` },
          { start: 0.95, end: 1.0, text: `第${n}块-乙` },
        ],
        timestampsMissing: false,
      };
    },
  };
  return self;
}

async function makeTask(name: string, sourceFile: string) {
  const task = store.create({ originalName: name, ext: path.extname(name), sizeBytes: 123 });
  const td = path.join(dir, "tasks", task.id);
  await mkdir(td, { recursive: true });
  await copyFile(sourceFile, path.join(td, `source${task.ext}`));
  return task;
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "v2t-asr-"));
  fixture = path.join(dir, "fixture.mp4");
  await run("ffmpeg", [
    "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=15",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac",
    "-shortest", "-y", fixture,
  ]);
  db = openDb(path.join(dir, "test.db"));
  store = new TaskStore(db);
});

afterAll(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("转写管线（Seam A · ASR 注入）", () => {
  it("短音频：单次转写直达 ready，transcript 落盘且状态含 transcribing", async () => {
    const asr = makeFakeAsr("ok");
    const runner = new TaskRunner({ store, dataDir: dir, asr });
    const task = await makeTask("short.mp4", fixture);
    const states: string[] = [];
    runner.subscribe(task.id, (t) => states.push(t.status));
    runner.enqueue(task.id);
    await runner.whenIdle();

    expect(store.get(task.id)?.status).toBe("ready");
    expect(asr.calls.length).toBe(1);
    expect(states).toContain("transcribing");

    const transcript = JSON.parse(
      await readFile(path.join(dir, "tasks", task.id, "transcript.json"), "utf8"),
    ) as Transcript;
    expect(transcript.segments.length).toBe(2);
    expect(transcript.segments[0]).toEqual({ start: 0.1, end: 0.9, text: "第1块-甲" });
    expect(transcript.durationSec).toBeGreaterThan(1.5);
  });

  it("长音频：按 chunkSeconds 分段，偏移合并后时间戳单调且跨块边界正确", async () => {
    const asr = makeFakeAsr("ok");
    const runner = new TaskRunner({ store, dataDir: dir, asr, chunkSeconds: 1 });
    const task = await makeTask("long.mp4", fixture);
    runner.enqueue(task.id);
    await runner.whenIdle();

    expect(asr.calls.length).toBeGreaterThanOrEqual(2);
    const transcript = JSON.parse(
      await readFile(path.join(dir, "tasks", task.id, "transcript.json"), "utf8"),
    ) as Transcript;

    const starts = transcript.segments.map((s) => s.start);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]).toBeGreaterThan(starts[i - 1]);
    }
    // 第二块的段必须落在第二块的时间窗内（偏移 >= 0.9s）
    const secondBlockFirst = transcript.segments.find((s) => s.text === "第2块-甲");
    expect(secondBlockFirst!.start).toBeGreaterThanOrEqual(0.9);
    // 分块的临时文件应被清理
    const files = await readdirSafe(path.join(dir, "tasks", task.id));
    expect(files.some((f) => f.startsWith("chunk-"))).toBe(false);
  });

  it("ASR 失败：任务进入 failed 且错误原因落库", async () => {
    const runner = new TaskRunner({ store, dataDir: dir, asr: makeFakeAsr("boom") });
    const task = await makeTask("bad.mp4", fixture);
    runner.enqueue(task.id);
    await runner.whenIdle();

    const done = store.get(task.id) as Task;
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/ASR/);
  });
});

async function readdirSafe(p: string): Promise<string[]> {
  try {
    return await import("node:fs/promises").then((fs) => fs.readdir(p));
  } catch {
    return [];
  }
}
