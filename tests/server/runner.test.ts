import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb, type Db } from "@/server/db";
import { TaskRunner } from "@/server/runner";
import { TaskStore, type Task } from "@/server/tasks";

const run = promisify(execFile);

let dir: string;
let db: Db;
let store: TaskStore;
let runner: TaskRunner;
let fixture: string;

async function makeTask(name: string, sourceFile: string) {
  const task = store.create({ originalName: name, ext: path.extname(name), sizeBytes: 123 });
  const taskDir = path.join(dir, "tasks", task.id);
  await (await import("node:fs/promises")).mkdir(taskDir, { recursive: true });
  await copyFile(sourceFile, path.join(taskDir, `source${task.ext}`));
  return task;
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "v2t-runner-"));
  fixture = path.join(dir, "fixture.mp4");
  await run("ffmpeg", [
    "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=15",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac",
    "-shortest", "-y", fixture,
  ]);
  db = openDb(path.join(dir, "test.db"));
  store = new TaskStore(db);
  runner = new TaskRunner({
    store,
    dataDir: dir,
    asr: {
      async transcribe() {
        return { segments: [{ start: 0, end: 1, text: "假转写" }], timestampsMissing: false };
      },
    },
  });
});

afterAll(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("TaskRunner（Seam A · 串行管线）", () => {
  it("happy path：queued → extracting → ready，音频规格正确且时长入库", async () => {
    const task = await makeTask("demo.mp4", fixture);
    const states: string[] = [];
    runner.subscribe(task.id, (t) => states.push(t.status));
    runner.enqueue(task.id);
    await runner.whenIdle();

    const done = store.get(task.id) as Task;
    expect(done.status).toBe("ready");
    expect(done.progress).toBe(100);
    expect(done.durationSec).toBeGreaterThan(1.5);
    expect(states[states.length - 1]).toBe("ready");
    expect(states).toContain("extracting");

    const { stdout } = await run("ffprobe", [
      "-v", "error", "-select_streams", "a:0",
      "-show_entries", "stream=sample_rate,channels,codec_name",
      "-print_format", "json",
      path.join(dir, "tasks", task.id, "audio.mp3"),
    ]);
    const stream = JSON.parse(stdout).streams[0];
    expect({ rate: Number(stream.sample_rate), ch: Number(stream.channels), codec: stream.codec_name })
      .toEqual({ rate: 16000, ch: 1, codec: "mp3" });
  });

  it("坏文件：进入 failed 且错误原因落库", async () => {
    const junk = path.join(dir, "junk.mp4");
    await (await import("node:fs/promises")).writeFile(junk, Buffer.from("not a video"));
    const task = await makeTask("junk.mp4", junk);
    runner.enqueue(task.id);
    await runner.whenIdle();

    const done = store.get(task.id) as Task;
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/ffprobe|时长/i);
  });

  it("忙时入队：新任务保持 queued 并在前一个跑完后自动开跑", async () => {
    // 卡住 ASR，让第一个任务停在 transcribing，模拟"解析中"
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gated = new TaskRunner({
      store,
      dataDir: dir,
      asr: {
        async transcribe() {
          await gate;
          return { segments: [{ start: 0, end: 1, text: "假转写" }], timestampsMissing: false };
        },
      },
    });

    const first = await makeTask("gated-a.mp4", fixture);
    const second = await makeTask("gated-b.mp4", fixture);
    const firstTranscribing = new Promise<void>((resolve) => {
      gated.subscribe(first.id, (t) => {
        if (t.status === "transcribing") resolve();
      });
    });
    gated.enqueue(first.id);
    await firstTranscribing;

    // 处理中再入队：任务既不丢，也不会被单次 kick 丢掉
    gated.enqueue(second.id);
    expect(store.get(second.id)?.status).toBe("queued");
    expect(gated.getQueueSnapshot().queued.map((t) => t.id)).toEqual([second.id]);
    expect(gated.getQueueSnapshot().active.map((t) => t.id)).toEqual([first.id]);

    release();
    await gated.whenIdle();

    expect(store.get(first.id)?.status).toBe("ready");
    expect(store.get(second.id)?.status).toBe("ready");
    expect(gated.getQueueSnapshot()).toMatchObject({ active: [], queued: [] });
  });

  it("前一个任务失败时，队列里的下一个仍会被取出执行", async () => {
    const junk = path.join(dir, "junk-first.mp4");
    await (await import("node:fs/promises")).writeFile(junk, Buffer.from("not a video"));
    const bad = await makeTask("bad-first.mp4", junk);
    const good = await makeTask("good-after-bad.mp4", fixture);

    runner.enqueue(bad.id);
    runner.enqueue(good.id);
    await runner.whenIdle();

    expect(store.get(bad.id)?.status).toBe("failed");
    expect(store.get(good.id)?.status).toBe("ready");
  });

  it("串行：先入队者先进入 extracting，两者最终都 ready", async () => {
    const a = await makeTask("a.mp4", fixture);
    const b = await makeTask("b.mp4", fixture);
    const order: string[] = [];
    runner.subscribe(a.id, (t) => { if (t.status === "extracting") order.push("a"); });
    runner.subscribe(b.id, (t) => { if (t.status === "extracting") order.push("b"); });
    runner.enqueue(a.id);
    runner.enqueue(b.id);
    await runner.whenIdle();

    expect(order).toEqual(["a", "b"]);
    expect(store.get(a.id)?.status).toBe("ready");
    expect(store.get(b.id)?.status).toBe("ready");
  });
});