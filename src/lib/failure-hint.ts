/**
 * 失败原因 → 用户下一步该做什么。
 *
 * 管线的错误文案来自各方（yt-dlp、ffmpeg、ASR 的 HTTP 状态、undici 的 "fetch failed"），
 * 但用户只关心两件事：重试用不用得着、要不要重新准备文件。所以这里按「补救动作」
 * 归类，不追求技术细节全覆盖；认不出来就退回通用提示。
 */
export type FailureKind = "network" | "source" | "media" | "config" | "other";

export interface FailureHint {
  kind: FailureKind;
  hint: string;
}

const HINTS: Record<FailureKind, string> = {
  config: "服务端缺少必要的配置（下载器、转写或模型 API Key），重试不会成功，请联系维护者。",
  media: "文件本身可能损坏、没有音轨或无法解码。请检查文件是否可播放后，重新上传。",
  network: "这次是网络或服务端没有响应（连接被重置、超时等），不是文件的问题。稍后重新导入即可，文件不用重新上传。",
  source: "链接下载失败（平台风控、需要登录或链接已失效）。可以稍后重试，也可以换一个链接或直接上传本地文件。",
  other: "可以先重试一次；如果反复失败，请更换文件或链接。",
};

/** 顺序即优先级：先判「重试无用」和「文件有问题」，再判链路来源 */
const RULES: Array<[FailureKind, RegExp]> = [
  ["config", /未配置|缺少配置|未找到 yt-dlp|API ?Key|SILICONFLOW|LLM_API_KEY/i],
  ["media", /没有(检测到)?音轨|可播放|ffprobe|ffmpeg|无法解码|损坏/i],
  ["source", /下载|B ?站|bilibili|yt-dlp|链接|来源地址/i],
  ["network", /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EPIPE|socket|网络|超时|timeout|返回 (?:429|5\d\d)|HTTP (?:429|5\d\d)/i],
];

export function failureHint(error: string | null | undefined): FailureHint {
  const text = (error ?? "").trim();
  if (!text) return { kind: "other", hint: HINTS.other };
  for (const [kind, pattern] of RULES) {
    if (pattern.test(text)) return { kind, hint: HINTS[kind] };
  }
  return { kind: "other", hint: HINTS.other };
}
