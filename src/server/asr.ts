import { readFile } from "node:fs/promises";
import path from "node:path";
import { getSiliconFlowConfig } from "./config";
import { elapsedMs, errorFields, logError, logInfo, logWarn } from "./log";

/** 单次请求上限：超时即重连，避免一个卡住的请求把串行管线堵死 */
const ASR_TIMEOUT_MS = 180_000;
/** 网络层失败（连接被重置/网关掐断）重试一次，换个新连接通常就过了 */
const ASR_MAX_ATTEMPTS = 2;
const ASR_RETRY_DELAY_MS = 2_000;

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

interface PostAudioOptions {
  endpoint: string;
  apiKey: string;
  model: string;
  buffer: Buffer;
  fileName: string;
  fields: Record<string, string>;
}

/** 每次重试都要新 FormData：请求体是一次性的流，复用会报 disturbed */
function buildForm(opts: PostAudioOptions): FormData {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(opts.buffer)]), opts.fileName);
  form.append("model", opts.model);
  form.append("response_format", "verbose_json");
  return form;
}

function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError" || error.name === "AbortError") return true;
  // undici 把连接层失败统一成 TypeError("fetch failed")，真正原因在 cause
  return error.message === "fetch failed";
}

/** 上传并等结果；网络层失败重试一次，HTTP 错误码不重试（重发也没用） */
async function postAudio(opts: PostAudioOptions): Promise<Response> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fetch(opts.endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.apiKey}` },
        body: buildForm(opts),
        signal: AbortSignal.timeout(ASR_TIMEOUT_MS),
      });
    } catch (err) {
      if (attempt >= ASR_MAX_ATTEMPTS || !isNetworkError(err)) throw err;
      logWarn("asr request retry", { ...opts.fields, attempt, ...errorFields(err) });
      await new Promise((resolve) => setTimeout(resolve, ASR_RETRY_DELAY_MS));
    }
  }
}

/**
 * 硅基流动转写（OpenAI 兼容 /audio/transcriptions）。
 * 默认 XingChenASR-V3.2-Ultra：实测返回带 start/end 的 segments（带时间戳是播放器联动的硬需求）；
 * SenseVoiceSmall 只回整段 text（无时间戳），whisper-large-v3 已下架，均可经 .env 切换。
 * 单文件硬限制：时长 ≤1 小时且 ≤50MB。但真正卡人的是请求时长本身：整段 43 分钟
 * （15MB）上传后曾在大约 125s 被网关掐断（fetch failed），而 11 分钟（3.4MB）稳定
 * 60-70s 返回。所以管线默认 10 分钟一段（runner 的 DEFAULT_CHUNK_SECONDS）。
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
        const res = await postAudio({
          endpoint: `${baseUrl}/audio/transcriptions`,
          apiKey,
          model,
          buffer,
          fileName: path.basename(audioFile),
          fields,
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
