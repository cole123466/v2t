import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface SubtitleCue {
  start: number;
  end: number;
  text: string;
}

/** "00:01:02,500" / "01:02.5" / "62.5" → 秒 */
export function parseTimestamp(raw: string): number | null {
  const text = raw.trim().replace(",", ".");
  const parts = text.split(":").map((p) => p.trim());
  if (parts.length === 0 || parts.some((p) => p === "" || Number.isNaN(Number(p)))) return null;
  const nums = parts.map(Number);
  if (nums.length === 3) return nums[0] * 3600 + nums[1] * 60 + nums[2];
  if (nums.length === 2) return nums[0] * 60 + nums[1];
  if (nums.length === 1) return nums[0];
  return null;
}

/**
 * 解析 SRT / WebVTT 文本为 cue 列表。
 * WebVTT 的 `NOTE` 块与 `WEBVTT` 头跳过；SRT 的序号行忽略。
 */
export function parseSubtitles(content: string): SubtitleCue[] {
  const normalized = content.replace(/\r\n?/g, "\n");
  const blocks = normalized.split(/\n{2,}/);
  const cues: SubtitleCue[] = [];

  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (lines.length === 0) continue;
    if (/^WEBVTT/.test(lines[0]) || /^NOTE\b/.test(lines[0])) continue;

    const arrowIndex = lines.findIndex((l) => l.includes("-->"));
    if (arrowIndex === -1) continue;
    const [rawStart, rawEnd] = lines[arrowIndex].split("-->");
    const start = parseTimestamp(rawStart ?? "");
    // 结束时间可能带 WebVTT 的位置参数（"00:00:05.000 align:start position:0%"）
    const end = parseTimestamp((rawEnd ?? "").trim().split(/\s+/)[0] ?? "");
    if (start === null || end === null || end <= start) continue;

    const text = lines
      .slice(arrowIndex + 1)
      .join(" ")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    cues.push({ start, end, text });
  }
  return cues;
}

/** cue 文本时间的并集占视频总时长的比例（不看画面、不推断静音） */
export function subtitleCoverage(cues: SubtitleCue[], durationSec: number): number {
  if (durationSec <= 0 || cues.length === 0) return 0;
  const sorted = [...cues].sort((a, b) => a.start - b.start);
  let covered = 0;
  let cursor = 0;
  for (const cue of sorted) {
    const start = Math.max(cursor, cue.start);
    const end = Math.min(durationSec, cue.end);
    if (end > start) {
      covered += end - start;
      cursor = end;
    }
  }
  return Math.min(1, covered / durationSec);
}

/**
 * 补全缺失的结束时间：字幕偶尔 end <= start 或不连续，
 * 这里让前一条的结束不晚于后一条的开始，避免时间戳倒挂。
 */
export function closeUncovered(cues: SubtitleCue[]): SubtitleCue[] {
  const sorted = [...cues].sort((a, b) => a.start - b.start);
  return sorted.map((cue, i) => {
    const next = sorted[i + 1];
    const end = next && next.start > cue.start && cue.end > next.start ? next.start : cue.end;
    return { ...cue, end: Math.max(cue.start, end) };
  });
}

const SUBTITLE_EXTS = [".srt", ".vtt", ".ass", ".ssa"];

/**
 * 抽取容器内的字幕轨道（第一条文本字幕）。
 * 无字幕轨、抽不出或格式不支持都返回空数组，由调用方回退 ASR。
 */
export async function extractSubtitleTrack(
  source: string,
  scratchDir: string,
): Promise<SubtitleCue[]> {
  const list = await listSubtitleStreams(source);
  if (list.length === 0) return [];

  const workDir = await mkdtemp(path.join(tmpdir(), "v2t-sub-"));
  try {
    for (const index of list) {
      const target = path.join(workDir, `sub-${index}.srt`);
      try {
        await run("ffmpeg", [
          "-hide_banner", "-loglevel", "error",
          "-i", source,
          "-map", `0:${index}`,
          "-c:s", "srt",
          "-y", target,
        ]);
      } catch {
        continue;
      }
      const size = await stat(target).catch(() => null);
      if (!size || size.size === 0) continue;
      const content = await readFile(target, "utf8");
      const cues = parseSubtitles(content);
      if (cues.length > 0) return cues;
    }
    return [];
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    // scratchDir 保留参数以便未来缓存字幕原文；当前不留痕
    void scratchDir;
  }
}

async function listSubtitleStreams(source: string): Promise<number[]> {
  try {
    const { stdout } = await run("ffprobe", [
      "-v", "error",
      "-select_streams", "s",
      "-show_entries", "stream=index,codec_name",
      "-print_format", "json",
      source,
    ]);
    const parsed = JSON.parse(stdout) as { streams?: Array<{ index?: number; codec_name?: string }> };
    return (parsed.streams ?? [])
      .filter((s) => typeof s.index === "number")
      .map((s) => s.index as number);
  } catch {
    return [];
  }
}

export function isSubtitleFile(name: string): boolean {
  return SUBTITLE_EXTS.includes(path.extname(name).toLowerCase());
}
