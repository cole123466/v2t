import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb, type Db } from "@/server/db";
import { readFrameManifest } from "@/server/frames";
import { TaskRunner } from "@/server/runner";
import type { SourceProvider } from "@/server/source";
import { TaskStore, type Task } from "@/server/tasks";

const run = promisify(execFile);

let dir: string;
let db: Db;
let store: TaskStore;
let videoFixture: string;
let subtitleFixture: string;

/** 假下载器：把预置视频复制成 media.mp4，并记录进度回调 */
function fakeSource(opts: { fail?: boolean } = {}): SourceProvider & { calls: string[] } {
  const self = {
    calls: [] as string[],
    async probe(url: string) {
      self.calls.push(`probe:${url}`);
      return { title: "测试视频", durationSec: 2, thumbnailUrl: null };
    },
    async fetch(url: string, destDir: string, onProgress?: (p: { downloadedBytes: number; totalBytes: number }) => void) {
      self.calls.push(`fetch:${url}`);
      if (opts.fail) throw new Error("下载失败（模拟）：403 Forbidden");
      onProgress?.({ downloadedBytes: 50, totalBytes: 100 });
      const file = path.join(destDir, "media.mp4");
      await copyFile(videoFixture, file);
      onProgress?.({ downloadedBytes: 100, totalBytes: 100 });
      return { file, ext: ".mp4", sizeBytes: 100 };
    },
  };
  return self;
}

function makeRunner(source?: SourceProvider) {
  return new TaskRunner({
    store,
    dataDir: dir,
    asr: {
      async transcribe() {
        return { segments: [{ start: 0, end: 1, text: "假转写" }], timestampsMissing: false };
      },
    },
    source,
  });
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "v2t-source-"));
  videoFixture = path.join(dir, "fixture.mp4");
  // 带内嵌字幕轨道的视频（2 秒，字幕覆盖全片 → 走字幕分支）
  subtitleFixture = path.join(dir, "subtitle.mp4");
  const srt = path.join(dir, "fixture.srt");
  await writeFile(srt, "1\n00:00:00,000 --> 00:00:02,000\n内嵌字幕内容\n", "utf8");
  await run("ffmpeg", [
    "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=15",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-i", srt,
    "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-c:s", "mov_text",
    "-shortest", "-y", subtitleFixture,
  ]);
  await run("ffmpeg", [
    "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=15",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac",
    "-shortest", "-y", videoFixture,
  ]);
  db = openDb(path.join(dir, "test.db"));
  store = new TaskStore(db);
});

afterAll(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("链接导入（Seam C · SourceProvider 注入）", () => {
  it("链接任务：downloading → ready，媒体落为 source.mp4，下载进度回收", async () => {
    const source = fakeSource();
    const runner = makeRunner(source);
    const task = store.create({
      originalName: "测试视频",
      ext: ".mp4",
      sizeBytes: 0,
      sourceKind: "link",
      sourceUrl: "https://www.bilibili.com/video/BV1xx411c7mD",
      sourceTitle: "测试视频",
    });

    const states: string[] = [];
    const pcts: number[] = [];
    runner.subscribe(task.id, (t) => {
      states.push(t.status);
      if (t.downloadPct !== null) pcts.push(t.downloadPct);
    });
    runner.enqueue(task.id);
    await runner.whenIdle();

    const done = store.get(task.id) as Task;
    expect(done.status).toBe("ready");
    expect(done.sourceKind).toBe("link");
    expect(done.downloadPct).toBe(100);
    expect(states).toContain("downloading");
    expect(pcts).toContain(50);
    expect(source.calls).toEqual([
      "fetch:https://www.bilibili.com/video/BV1xx411c7mD",
    ]);
    const media = await readFile(path.join(dir, "tasks", task.id, "source.mp4"));
    expect(media.length).toBeGreaterThan(0);
  });

  it("下载失败：任务 failed 且错误原因指向下载", async () => {
    const runner = makeRunner(fakeSource({ fail: true }));
    const task = store.create({
      originalName: "坏链接",
      ext: ".mp4",
      sizeBytes: 0,
      sourceKind: "link",
      sourceUrl: "https://www.bilibili.com/video/BVbad",
    });
    runner.enqueue(task.id);
    await runner.whenIdle();
    const done = store.get(task.id) as Task;
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/下载失败/);
  });

  it("未配置下载器的链接任务：failed 并给出原因", async () => {
    const runner = makeRunner(undefined);
    const task = store.create({
      originalName: "无下载器",
      ext: ".mp4",
      sizeBytes: 0,
      sourceKind: "link",
      sourceUrl: "https://www.bilibili.com/video/BVx",
    });
    runner.enqueue(task.id);
    await runner.whenIdle();
    expect(store.get(task.id)?.error).toMatch(/未配置下载器/);
  });
});

describe("字幕优先（容器字幕轨道）", () => {
  it("有内嵌字幕且覆盖全片：直接采用字幕，不调用 ASR", async () => {
    let asrCalls = 0;
    const runner = new TaskRunner({
      store,
      dataDir: dir,
      asr: {
        async transcribe() {
          asrCalls += 1;
          return { segments: [{ start: 0, end: 1, text: "不该出现" }], timestampsMissing: false };
        },
      },
    });
    const task = store.create({
      originalName: "subtitle.mp4",
      ext: ".mp4",
      sizeBytes: 1,
    });
    const taskPath = path.join(dir, "tasks", task.id);
    await mkdir(taskPath, { recursive: true });
    await copyFile(subtitleFixture, path.join(taskPath, "source.mp4"));

    runner.enqueue(task.id);
    await runner.whenIdle();

    const done = store.get(task.id) as Task;
    expect(done.status).toBe("ready");
    expect(done.transcriptOrigin).toBe("subtitle");
    expect(asrCalls).toBe(0);

    const transcript = JSON.parse(
      await readFile(path.join(taskPath, "transcript.json"), "utf8"),
    ) as { segments: Array<{ text: string }> };
    expect(transcript.segments.map((s) => s.text)).toContain("内嵌字幕内容");
  });

  it("无字幕轨道：回退 ASR 并标记来源为 asr", async () => {
    const runner = makeRunner();
    const task = store.create({ originalName: "plain.mp4", ext: ".mp4", sizeBytes: 1 });
    const taskPath = path.join(dir, "tasks", task.id);
    await mkdir(taskPath, { recursive: true });
    await copyFile(videoFixture, path.join(taskPath, "source.mp4"));

    runner.enqueue(task.id);
    await runner.whenIdle();

    const done = store.get(task.id) as Task;
    expect(done.status).toBe("ready");
    expect(done.transcriptOrigin).toBe("asr");
  });
});

describe("全景帧（Seam A · 就绪后抽帧）", () => {
  it("就绪任务写出 frames.json 与帧文件，时间点覆盖全片", async () => {
    const runner = makeRunner();
    const task = store.create({ originalName: "frames.mp4", ext: ".mp4", sizeBytes: 1 });
    const taskPath = path.join(dir, "tasks", task.id);
    await mkdir(taskPath, { recursive: true });
    await copyFile(videoFixture, path.join(taskPath, "source.mp4"));

    runner.enqueue(task.id);
    await runner.whenIdle();

    expect(store.get(task.id)?.status).toBe("ready");
    const manifest = await readFrameManifest(taskPath);
    expect(manifest).not.toBeNull();
    expect(manifest!.frames.length).toBeGreaterThan(0);
    expect(manifest!.frames.every((f) => f.kind === "overview")).toBe(true);
    // 2 秒视频 12 张全景帧：中点采样落在 0.083s 与 1.92s 之间
    const times = manifest!.frames.map((f) => f.tSec);
    expect(Math.min(...times)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...times)).toBeLessThan(2);
    for (const frame of manifest!.frames) {
      const bytes = await readFile(path.join(taskPath, frame.file));
      expect(bytes.length).toBeGreaterThan(0);
    }
  });

  it("抽帧失败不影响就绪（源文件损坏时仍 ready 或 failed 但无帧）", async () => {
    const runner = makeRunner();
    const task = store.create({ originalName: "noframes.mp4", ext: ".mp4", sizeBytes: 1 });
    const taskPath = path.join(dir, "tasks", task.id);
    await mkdir(taskPath, { recursive: true });
    // 只有音频的源：有音轨可通过 probe，但没有视频流 → 抽帧产出 0 张
    await run("ffmpeg", [
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-c:a", "aac", "-y", path.join(taskPath, "source.mp4"),
    ]);
    runner.enqueue(task.id);
    await runner.whenIdle();
    expect(store.get(task.id)?.status).toBe("ready");
    const manifest = await readFrameManifest(taskPath);
    expect(manifest?.frames.length ?? 0).toBe(0);
  });
});
