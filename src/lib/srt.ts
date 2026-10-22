import type { TranscriptSegment } from "@/server/asr";

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

function fmtTime(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
}

/** 由带时间戳的转录分段生成标准 SRT 字幕文本 */
export function toSrt(segments: TranscriptSegment[]): string {
  return segments
    .map(
      (seg, i) =>
        `${i + 1}\n${fmtTime(seg.start)} --> ${fmtTime(seg.end)}\n${seg.text}\n`,
    )
    .join("\n");
}
