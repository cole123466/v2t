import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// 统一的 16kHz 单声道 MP3 规格参数（ASR 输入约定）
const AUDIO_ARGS = ["-vn", "-ac", "1", "-ar", "16000", "-codec:a", "libmp3lame", "-b:a", "48k"];

export interface MediaInfo {
  durationSec: number;
  hasAudio: boolean;
}

function toolError(tool: string, target: string, stderr: unknown): never {
  const text = typeof stderr === "string" && stderr.trim() ? stderr : String(stderr ?? "");
  const detail = text.split(/\r?\n/).filter(Boolean).slice(-3).join(" | ") || "无输出";
  throw new Error(`${tool} 处理失败（${target}）：${detail}`);
}

export async function probe(file: string): Promise<MediaInfo> {
  let stdout: string;
  try {
    ({ stdout } = await run("ffprobe", [
      "-v", "error",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      file,
    ]));
  } catch (err) {
    toolError("ffprobe", file, (err as { stderr?: string }).stderr);
  }

  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string }>;
  };
  const durationSec = Number(parsed.format?.duration);
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error(`ffprobe 无法解析时长（${file}）`);
  }
  return {
    durationSec,
    hasAudio: (parsed.streams ?? []).some((s) => s.codec_type === "audio"),
  };
}

export async function extractAudio(input: string, output: string): Promise<void> {
  try {
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-i", input,
      ...AUDIO_ARGS,
      "-y", output,
    ]);
  } catch (err) {
    toolError("ffmpeg", input, (err as { stderr?: string }).stderr);
  }
}

export interface AudioChunk {
  file: string;
  start: number;
}

/** 按时间窗把长音频切成可独立转写的块（块内保持 16kHz 单声道 MP3 规格） */
export async function chunkAudio(
  input: string,
  outDir: string,
  durationSec: number,
  chunkSeconds: number,
): Promise<AudioChunk[]> {
  const count = Math.ceil(durationSec / chunkSeconds);
  const chunks: AudioChunk[] = [];
  for (let i = 0; i < count; i++) {
    const start = i * chunkSeconds;
    const dur = Math.min(chunkSeconds, durationSec - start);
    const file = path.join(outDir, `chunk-${String(i).padStart(4, "0")}.mp3`);
    try {
      await run("ffmpeg", [
        "-hide_banner", "-loglevel", "error",
        "-ss", String(start), "-t", String(dur), "-i", input,
        ...AUDIO_ARGS,
        "-y", file,
      ]);
    } catch (err) {
      toolError("ffmpeg", input, (err as { stderr?: string }).stderr);
    }
    chunks.push({ file, start });
  }
  return chunks;
}
