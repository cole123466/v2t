import { readFile } from "node:fs/promises";
import path from "node:path";
import { getSiliconFlowConfig } from "./config";
import { elapsedMs, errorFields, logError, logInfo } from "./log";

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface Transcript {
  durationSec: number;
  segments: TranscriptSegment[];
  /** 引擎识别出的语言（ISO 码或名称），未知时缺省 */
  language?: string;
  /** 引擎未返回时间戳时为 true（单段兜底），此时播放器联动与 SRT 不可靠 */
  timestampsMissing?: boolean;
}

export interface ASRResult {
  segments: TranscriptSegment[];
  language?: string;
  timestampsMissing: boolean;
}

export interface ASRProvider {
  transcribe(audioFile: string): Promise<ASRResult>;
}

/**
 * 硅基流动转写（OpenAI 兼容 /audio/transcriptions）。
 * 默认 XingChenASR-V3.2-Ultra：实测返回带 start/end 的 segments（带时间戳是播放器联动的硬需求）；
 * SenseVoiceSmall 只回整段 text（无时间戳），whisper-large-v3 已下架，均可经 .env 切换。
 * 单文件硬限制：时长 ≤1 小时且 ≤50MB——这是管线 50 分钟分段阈值的依据。
 */
export function createSiliconFlowAsr(): ASRProvider {
  return {
    async transcribe(audioFile: string): Promise<ASRResult> {
      const { apiKey, baseUrl, model } = getSiliconFlowConfig();
      if (!apiKey) throw new Error("未配置 SILICONFLOW_API_KEY");

      const startedAt = Date.now();
      const fields = { provider: "asr", model, file: path.basename(audioFile) };
      logInfo("asr transcription started", fields);
      try {
        const buffer = await readFile(audioFile);
        const form = new FormData();
        form.append("file", new Blob([new Uint8Array(buffer)]), path.basename(audioFile));
        form.append("model", model);
        form.append("response_format", "verbose_json");

        const res = await fetch(`${baseUrl}/audio/transcriptions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          throw new Error(`ASR 服务返回 ${res.status}：${detail.slice(0, 200)}`);
        }

        const data = (await res.json()) as {
          segments?: Array<{ start: number; end: number; text: string }>;
          text?: string;
          language?: unknown;
        };
        const language =
          typeof data.language === "string" && data.language ? data.language : undefined;
        const segments = (data.segments ?? [])
          .map((s) => ({
            start: Number(s.start),
            end: Number(s.end),
            text: String(s.text ?? "").trim(),
          }))
          .filter((s) => s.text.length > 0);
        // 引擎偶尔只回整段 text 不回 segments，兜底成单段并标记（联动不可用需提示）
        const result: ASRResult =
          segments.length === 0 && data.text?.trim()
            ? {
                segments: [{ start: 0, end: 0, text: data.text.trim() }],
                language,
                timestampsMissing: true,
              }
            : { segments, language, timestampsMissing: false };
        logInfo("asr transcription completed", {
          ...fields,
          bytes: buffer.length,
          segments: result.segments.length,
          language: result.language,
          timestamps_missing: result.timestampsMissing,
          duration_ms: elapsedMs(startedAt),
        });
        return result;
      } catch (err) {
        logError("asr transcription failed", {
          ...fields,
          ...errorFields(err),
          duration_ms: elapsedMs(startedAt),
        });
        throw err;
      }
    },
  };
}
