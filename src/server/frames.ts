import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type FrameKind = "overview" | "evidence";

export interface Frame {
  id: string;
  /** 视频内时间点（秒） */
  tSec: number;
  /** 相对任务目录的文件名，如 frames/f01.jpg */
  file: string;
  kind: FrameKind;
  width: number;
}

export interface FrameManifest {
  width: number;
  frames: Frame[];
}

export function framesDir(dir: string): string {
  return path.join(dir, "frames");
}

export function frameManifestPath(dir: string): string {
  return path.join(dir, "frames.json");
}

/** 全景帧时间点：中点采样，覆盖全片且避开首尾黑场 */
export function overviewTimestamps(durationSec: number, count: number): number[] {
  if (durationSec <= 0 || count <= 0) return [];
  return Array.from({ length: count }, (_, i) =>
    Number(((durationSec * (i + 0.5)) / count).toFixed(3)),
  );
}

function frameId(index: number): string {
  return `f${String(index).padStart(2, "0")}`;
}

/**
 * 按时间点逐点抽帧（seek 循环）：与片长无关，只与帧数有关。
 * 单帧抽取失败只丢该帧，不整体失败。
 */
export async function extractFramesAt(
  input: string,
  dir: string,
  timestamps: number[],
  opts: { kind: FrameKind; width?: number; quality?: number; startIndex?: number } = {
    kind: "overview",
  },
): Promise<Frame[]> {
  const outDir = framesDir(dir);
  await mkdir(outDir, { recursive: true });
  const width = opts.width ?? 1280;
  const quality = opts.quality ?? 4;
  const startIndex = opts.startIndex ?? 0;
  const frames: Frame[] = [];

  for (let i = 0; i < timestamps.length; i++) {
    const tSec = timestamps[i];
    const id = frameId(startIndex + i);
    const name = `${id}.jpg`;
    const target = path.join(outDir, name);
    const seek = Math.max(0, tSec);
    try {
      await run("ffmpeg", [
        "-hide_banner", "-loglevel", "error",
        "-ss", String(seek),
        "-i", input,
        "-frames:v", "1",
        "-vf", `scale=${width}:-2`,
        "-q:v", String(quality),
        "-y", target,
      ]);
      const size = await stat(target).catch(() => null);
      if (!size || size.size === 0) continue;
      frames.push({ id, tSec: Number(seek.toFixed(3)), file: `frames/${name}`, kind: opts.kind, width });
    } catch {
      // 单帧失败忽略（损坏点、超出片尾）
    }
  }
  return frames;
}

/** 覆盖全片的全景帧，写 frames.json */
export async function extractOverviewFrames(
  input: string,
  dir: string,
  durationSec: number,
  count: number,
): Promise<FrameManifest> {
  const timestamps = overviewTimestamps(durationSec, count);
  const frames = await extractFramesAt(input, dir, timestamps, { kind: "overview" });
  const manifest: FrameManifest = { width: 1280, frames };
  await writeFile(frameManifestPath(dir), JSON.stringify(manifest, null, 2), "utf8");
  return manifest;
}

/** 追加取证帧（不覆盖既有全景帧），返回新帧并回写清单 */
export async function appendEvidenceFrames(
  input: string,
  dir: string,
  timestamps: number[],
): Promise<Frame[]> {
  const manifest = await readFrameManifest(dir);
  const startIndex = manifest?.frames.length ?? 0;
  const frames = await extractFramesAt(input, dir, timestamps, {
    kind: "evidence",
    width: 1920,
    quality: 3,
    startIndex,
  });
  if (frames.length > 0) {
    const next: FrameManifest = {
      width: manifest?.width ?? 1280,
      frames: [...(manifest?.frames ?? []), ...frames],
    };
    await writeFile(frameManifestPath(dir), JSON.stringify(next, null, 2), "utf8");
  }
  return frames;
}

export async function readFrameManifest(dir: string): Promise<FrameManifest | null> {
  try {
    return JSON.parse(await readFile(frameManifestPath(dir), "utf8")) as FrameManifest;
  } catch {
    return null;
  }
}

/** 删除任务帧目录（保留治理用） */
export async function removeFrames(dir: string): Promise<void> {
  await rm(framesDir(dir), { recursive: true, force: true });
  await rm(frameManifestPath(dir), { force: true });
}
