import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractAudio, probe } from "@/server/ffmpeg";

const run = promisify(execFile);

let dir: string;
let fixture: string;

// 用 ffmpeg 现场生成 2 秒带正弦音轨的 mp4 作为 fixture
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "v2t-ffmpeg-"));
  fixture = path.join(dir, "fixture.mp4");
  await run("ffmpeg", [
    "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=15",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac",
    "-shortest", "-y", fixture,
  ]);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function audioParams(file: string) {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-select_streams", "a:0",
    "-show_entries", "stream=sample_rate,channels,codec_name",
    "-print_format", "json", file,
  ]);
  const stream = JSON.parse(stdout).streams[0];
  return {
    sampleRate: Number(stream.sample_rate),
    channels: Number(stream.channels),
    codec: String(stream.codec_name),
  };
}

describe("ffmpeg 模块（Seam A · 抽取环节）", () => {
  it("probe 返回时长且识别出音轨", async () => {
    const info = await probe(fixture);
    expect(info.durationSec).toBeGreaterThan(1.5);
    expect(info.durationSec).toBeLessThan(2.5);
    expect(info.hasAudio).toBe(true);
  });

  it("extractAudio 产出 16kHz 单声道 MP3", async () => {
    const out = path.join(dir, "audio.mp3");
    await extractAudio(fixture, out);
    const params = await audioParams(out);
    expect(params.sampleRate).toBe(16000);
    expect(params.channels).toBe(1);
    expect(params.codec).toBe("mp3");
  });

  it("对不可解码的文件，probe 抛出带 stderr 摘要的错误", async () => {
    const junk = path.join(dir, "junk.mp4");
    await import("node:fs/promises").then((fs) => fs.writeFile(junk, Buffer.from("not a video")));
    await expect(probe(junk)).rejects.toThrow(/ffprobe/i);
  });
});
