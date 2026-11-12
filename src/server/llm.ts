import { getLlmConfig, getVisionConfig } from "./config";
import type { LLMCallMeta, LLMMessage, LLMProvider } from "./generations";
import { elapsedMs, errorFields, logError, logInfo, logWarn } from "./log";

/** 消息里是否带图片块：决定走文本 provider 还是独立的视觉 provider */
function hasImageInput(messages: LLMMessage[]): boolean {
  return messages.some(
    (m) => Array.isArray(m.content) && m.content.some((part) => part.type === "image_url"),
  );
}

/** 瞬断类网络错误码：连接被重置/超时/对端断开，重试有意义 */
const TRANSIENT_NET_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** 上游 5xx/429 的尝试次数：比网络瞬断多一次，组内路由有机会换到可用上游 */
const HTTP_ATTEMPTS = 3;

/** 重试也没有意义的 HTTP 失败：余额不足 / 无可用资源包 */
const PERMANENT_HTTP = /余额不足|无可用资源包|insufficient_quota|"code"\s*:\s*"?1113/;

/** 带状态码的上游失败：让 generate 能按 429/5xx 决定是否退避重试 */
class LlmHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "LlmHttpError";
  }
}

/** 退避时长：第一次重试立即，之后 1s、2s（只对 5xx/429 生效） */
function backoffMs(attempt: number): number {
  return attempt <= 0 ? 0 : 1000 * 2 ** (attempt - 1);
}

/** 可被 abort 打断的退避等待：客户端取消后不必再等 */
async function backoff(attempt: number, signal?: AbortSignal): Promise<void> {
  const ms = backoffMs(attempt);
  if (ms === 0) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * 网络瞬断判定：undici 连接层失败的 message 恒为 "fetch failed"（连接期）或
 * "terminated"（流中期），真实原因（ECONNRESET/ETIMEDOUT 等）在 cause 链上，
 * 所以必须沿 cause 链收集 code 与 message 再判断。ENOTFOUND、证书错误等
 * 永久性失败不在瞬断集合里，不重试。
 */
function isTransientNetworkError(err: unknown): boolean {
  const messages: string[] = [];
  let cause: unknown = err;
  for (let depth = 0; cause instanceof Error && depth < 5; depth++) {
    messages.push(cause.message);
    const code = (cause as NodeJS.ErrnoException).code;
    if (code && TRANSIENT_NET_CODES.has(code)) return true;
    cause = cause.cause;
  }
  return /socket hang up|ECONNRESET|ETIMEDOUT|ECONNREFUSED/i.test(messages.join("\n"));
}

/**
 * OpenAI 兼容 chat completions 流式客户端。
 * 默认指向智谱 bigmodel 的 GLM；换厂商只改 .env 的 BASE_URL / API_KEY / MODEL。
 * 带图片输入的消息会自动切换到 LLM_VISION_MODEL。
 */
export function createOpenAiCompatibleLlm(): LLMProvider {
  return {
    async generate(
      messages: LLMMessage[],
      onChunk: (delta: string) => void,
      meta?: LLMCallMeta,
    ): Promise<string> {
      // 三类可重试失败：
      // - 空正文（模型只出思维链）
      // - 连接层瞬断（ETIMEDOUT/ECONNRESET 等）：预算 2 次
      // - 上游 429/5xx：预算 3 次并指数退避（组内路由可能换到可用上游）
      // 余额不足（code 1113）、404 模型不存在、401 等永久性失败不重试
      let lastError: Error | null = null;
      let maxAttempts = 2;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          return await streamOnce(messages, onChunk, meta);
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          const empty = /没有返回正文内容/.test(lastError.message);
          const http = lastError instanceof LlmHttpError ? lastError : null;
          const retryableHttp = http?.retryable ?? false;
          // 已输出部分正文的流中断不重试（会内容重复），其余瞬断走 cause 链判定
          const transient =
            !http &&
            isTransientNetworkError(lastError) &&
            !(lastError as Error & { partialEmitted?: boolean }).partialEmitted;
          if (!empty && !transient && !retryableHttp) throw lastError;
          if (retryableHttp) maxAttempts = HTTP_ATTEMPTS;
          if (attempt + 1 >= maxAttempts) break;
          logWarn(
            empty
              ? "model response empty; retrying"
              : retryableHttp
                ? "model service HTTP failure; retrying"
                : "model request transient failure; retrying",
            {
              provider: "llm",
              operation: meta?.operation,
              task_id: meta?.taskId,
              trace_id: meta?.traceId,
              attempt: attempt + 1,
              http_status: http?.status,
              delay_ms: attempt === 0 ? 0 : backoffMs(attempt),
            },
          );
          await backoff(attempt, meta?.signal);
          if (meta?.signal?.aborted) throw lastError;
        }
      }
      throw lastError ?? new Error("LLM 调用失败");
    },
  };
}

async function streamOnce(
  messages: LLMMessage[],
  onChunk: (delta: string) => void,
  meta?: LLMCallMeta,
): Promise<string> {
  const vision = hasImageInput(messages);
  const { apiKey, baseUrl, model } = vision ? getVisionConfig() : getLlmConfig();
  if (!apiKey) {
    throw new Error(vision ? "未配置视觉模型 API_KEY（LLM_VISION_API_KEY / LLM_API_KEY）" : "未配置 LLM_API_KEY");
  }

  const startedAt = Date.now();
  // 实际模型由这里决定（可能从文本模型切到视觉模型），先告知调用方再发请求
  meta?.onModel?.(model);
  const fields = {
    provider: "llm",
    model,
    operation: meta?.operation,
    task_id: meta?.taskId,
    trace_id: meta?.traceId,
    messages: messages.length,
    images: messages.reduce(
      (count, message) =>
        count +
        (Array.isArray(message.content)
          ? message.content.filter((part) => part.type === "image_url").length
          : 0),
      0,
    ),
  };

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model, messages, stream: true }),
      signal: meta?.signal,
    });
  } catch (err) {
    logError("model request failed", { ...fields, ...errorFields(err), duration_ms: elapsedMs(startedAt) });
    throw err;
  }
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    logWarn("model service HTTP failure", {
      ...fields,
      http_status: res.status,
      duration_ms: elapsedMs(startedAt),
    });
    // 429/5xx 多是上游实例抖动或组内无可用资源，退避重试可能落到别的上游；
    // 余额不足这类永久失败重试只是浪费一次完整等待
    const retryable = (res.status === 429 || res.status >= 500) && !PERMANENT_HTTP.test(detail);
    throw new LlmHttpError(
      res.status,
      `LLM 服务返回 ${res.status}：${detail.slice(0, 200)}`,
      retryable,
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";

  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (err) {
      // 流中期中断：已经向调用方输出过部分正文时重试会导致内容重复，只能上抛；
      // 尚无输出（只拿到响应头就断开）的由 generate 判定瞬断后重试
      if (full.length > 0) {
        throw Object.assign(err instanceof Error ? err : new Error(String(err)), { partialEmitted: true });
      }
      throw err;
    }
    if (chunk.done) break;
    const value = chunk.value;
    // 客户端已断开：取消读取并释放上游连接（不继续攒正文）
    if (meta?.signal?.aborted) {
      await reader.cancel().catch(() => {});
      throw new Error("请求已取消");
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const parsed = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }>;
        };
        const delta = parsed.choices?.[0]?.delta;
        // reasoning_content 是思维链，不属于产出；只取 content，避免把推理混进正文
        if (delta?.content) {
          full += delta.content;
          onChunk(delta.content);
        }
      } catch {
        // 忽略无法解析的 keep-alive 行
      }
    }
  }
  // 只输出思维链、没有正文时，空串会让上层 JSON 解析报出难懂的错
  if (!full.trim()) {
    logWarn("model response empty", { ...fields, duration_ms: elapsedMs(startedAt) });
    throw new Error("模型没有返回正文内容（可能只生成了推理过程），请重试或更换模型");
  }
  logInfo("model response completed", {
    ...fields,
    chars: full.length,
    duration_ms: elapsedMs(startedAt),
  });
  return full;
}
