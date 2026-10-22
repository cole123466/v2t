import { getLlmConfig, getVisionModel } from "./config";
import type { LLMMessage, LLMProvider } from "./generations";

/** 消息里带图片块时改用视觉模型 */
function pickModel(messages: LLMMessage[]): string {
  const hasImage = messages.some(
    (m) => Array.isArray(m.content) && m.content.some((part) => part.type === "image_url"),
  );
  return hasImage ? getVisionModel() : getLlmConfig().model;
}

/**
 * OpenAI 兼容 chat completions 流式客户端。
 * 默认指向智谱 bigmodel 的 GLM；换厂商只改 .env 的 BASE_URL / API_KEY / MODEL。
 * 带图片输入的消息会自动切换到 LLM_VISION_MODEL。
 */
export function createOpenAiCompatibleLlm(): LLMProvider {
  return {
    async generate(messages: LLMMessage[], onChunk: (delta: string) => void): Promise<string> {
      // 个别模型只输出思维链不出正文：自动重试一次，仍为空才报错
      let lastError: Error | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return await streamOnce(messages, onChunk);
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          if (!/没有返回正文内容/.test(lastError.message)) throw lastError;
        }
      }
      throw lastError ?? new Error("LLM 调用失败");
    },
  };
}

async function streamOnce(
  messages: LLMMessage[],
  onChunk: (delta: string) => void,
): Promise<string> {
  const { apiKey, baseUrl } = getLlmConfig();
  if (!apiKey) throw new Error("未配置 LLM_API_KEY");

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: pickModel(messages),
      messages,
      stream: true,
    }),
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(`LLM 服务返回 ${res.status}：${detail.slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
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
    throw new Error("模型没有返回正文内容（可能只生成了推理过程），请重试或更换模型");
  }
  return full;
}
