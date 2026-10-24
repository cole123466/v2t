import path from "node:path";

export function getDataDir(): string {
  return process.env.DATA_DIR ?? path.join(process.cwd(), "data");
}

export function getMaxUploadBytes(): number {
  const gb = Number(process.env.MAX_UPLOAD_GB ?? "2");
  return (Number.isFinite(gb) && gb > 0 ? gb : 2) * 1024 * 1024 * 1024;
}

/** 媒体保留天数（源视频与音频），转录稿与文案不受此限制 */
export function getRetentionDays(): number {
  const days = Number(process.env.MEDIA_RETENTION_DAYS ?? "7");
  return Number.isFinite(days) && days > 0 ? days : 7;
}

/** ASR 分段秒数：越小单请求越快，边界切句越多；默认 600（10 分钟） */
export function getAsrChunkSeconds(): number {
  const raw = Number(process.env.ASR_CHUNK_SECONDS ?? "");
  if (!Number.isFinite(raw) || raw <= 0) return 600;
  return Math.min(Math.max(Math.round(raw), 60), 3000);
}

export function getSiliconFlowConfig(): { apiKey: string; baseUrl: string; model: string } {
  return {
    apiKey: process.env.SILICONFLOW_API_KEY ?? "",
    baseUrl: process.env.SILICONFLOW_BASE_URL ?? "https://api.siliconflow.cn/v1",
    model: process.env.ASR_MODEL ?? "XingChenAGI/XingChenASR-V3.2-Ultra",
  };
}

export function getDownloaderConfig(): { cookiesFile: string } {
  return { cookiesFile: process.env.DOWNLOADER_COOKIES_FILE?.trim() ?? "" };
}

export function getLlmConfig(): { apiKey: string; baseUrl: string; model: string } {
  return {
    apiKey: process.env.LLM_API_KEY ?? "",
    baseUrl: process.env.LLM_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4",
    model: process.env.LLM_MODEL ?? "glm-4.6",
  };
}

/**
 * 图文文章的视觉模型（需支持图片输入）。独立于纯文本 LLM_MODEL。
 * 默认 glm-4.6v：实测可稳定返回正文；glm-4.6v-flash 虽免费但高峰期常 429，
 * glm-4.5v 只输出思维链不出正文，都不宜作默认。
 */
export function getVisionModel(): string {
  return process.env.LLM_VISION_MODEL?.trim() || "glm-4.6v";
}
