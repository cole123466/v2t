import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendOverviewFrames, extractOverviewFrames, readFrameManifest } from "@/server/frames";

const run = promisify(execFile);

let dir: string;
let video: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "v2t-frames-"));
  video = path.join(dir, "fixture.mp4");
  await run("ffmpeg", [
    "-f", "lavfi", "-i", "testsrc=duration=4:size=160x120:rate=10",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-y", video,
  ]);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("全景帧补齐（存量任务升级）", () => {
  it("追加新帧时保留旧帧 id 与时间点，清单按时间有序", async () => {
    const task = path.join(dir, "task");
    await mkdir(task, { recursive: true });

    const first = await extractOverviewFrames(video, task, 4, 2);
    expect(first.frames.map((f) => f.id)).toEqual(["f00", "f01"]);
    const old = first.frames.map((f) => ({ id: f.id, tSec: f.tSec }));

    const merged = await appendOverviewFrames(video, task, 4, 6);
    expect(merged.frames).toHaveLength(8);
    expect(new Set(merged.frames.map((f) => f.id)).size).toBe(8);

    // 旧 id 仍指向原时间点（旧文章引用的画面不能变）
    for (const frame of old) {
      expect(merged.frames.find((f) => f.id === frame.id)?.tSec).toBe(frame.tSec);
    }
    const times = merged.frames.map((f) => f.tSec);
    expect(times.every((t, i) => i === 0 || t >= times[i - 1])).toBe(true);
    expect((await readFrameManifest(task))?.frames).toHaveLength(8);
  });
});
