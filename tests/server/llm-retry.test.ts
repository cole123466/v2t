import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAiCompatibleLlm } from "@/server/llm";

/** 构造 SSE 流式响应 */
function sseResponse(deltas: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const d of deltas) {
        controller.enqueue(encoder.encode("data: " + JSON.stringify({ choices: [{ delta: { content: d } }] }) + "\n\n"));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

function sseEmpty(): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("data: " + JSON.stringify({ choices: [{ delta: { reasoning_content: "思考中" } }] }) + "\n\n"));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

/** undici 连接层失败：message 恒为 "fetch failed"，真实原因在 cause 链上 */
function fetchFailed(code: string): TypeError {
  return Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error(`connect ${code}`), { code }),
  });
}

/** 流中期中断：响应头返回后连接断开（长流式生成最常见的瞬断形态） */
function sseThenTerminated(deltas: string[]): Response {
  const encoder = new TextEncoder();
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>({
    // 用 pull 逐块给：error() 会清空队列，start 里一次性入队再报错会丢掉前序 delta
    pull(controller) {
      if (pulls < deltas.length) {
        controller.enqueue(
          encoder.encode("data: " + JSON.stringify({ choices: [{ delta: { content: deltas[pulls] } }] }) + "\n\n"),
        );
        pulls++;
      } else {
        controller.error(
          Object.assign(new TypeError("terminated"), {
            cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
          }),
        );
      }
    },
  });
  return new Response(stream, { status: 200 });
}

describe("createOpenAiCompatibleLlm 瞬断重试", () => {
  const prev = {
    key: process.env.LLM_API_KEY,
    base: process.env.LLM_BASE_URL,
    model: process.env.LLM_MODEL,
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    if (prev.key === undefined) delete process.env.LLM_API_KEY; else process.env.LLM_API_KEY = prev.key;
    if (prev.base === undefined) delete process.env.LLM_BASE_URL; else process.env.LLM_BASE_URL = prev.base;
    if (prev.model === undefined) delete process.env.LLM_MODEL; else process.env.LLM_MODEL = prev.model;
  });

  it("fetch 网络瞬断（ETIMEDOUT）时重试一次并成功", async () => {
    process.env.LLM_API_KEY = "test-key";
    process.env.LLM_BASE_URL = "https://llm.test/v4";
    process.env.LLM_MODEL = "test-model";
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(fetchFailed("ETIMEDOUT"))
      .mockResolvedValueOnce(sseResponse(["你好", "世界"]));
    vi.stubGlobal("fetch", fetchMock);

    const out = await createOpenAiCompatibleLlm().generate(
      [{ role: "user", content: "hi" }],
      () => {},
      { operation: "test" },
    );
    expect(out).toBe("你好世界");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("空正文（只有思维链）时重试一次并成功", async () => {
    process.env.LLM_API_KEY = "test-key";
    process.env.LLM_BASE_URL = "https://llm.test/v4";
    process.env.LLM_MODEL = "test-model";
    const fetchMock = vi.fn().mockResolvedValueOnce(sseEmpty()).mockResolvedValueOnce(sseResponse(["ok"]));
    vi.stubGlobal("fetch", fetchMock);

    const out = await createOpenAiCompatibleLlm().generate([{ role: "user", content: "hi" }], () => {});
    expect(out).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("连续两次瞬断才抛错", async () => {
    process.env.LLM_API_KEY = "test-key";
    process.env.LLM_BASE_URL = "https://llm.test/v4";
    process.env.LLM_MODEL = "test-model";
    const fetchMock = vi.fn().mockRejectedValue(fetchFailed("ECONNRESET"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createOpenAiCompatibleLlm().generate([{ role: "user", content: "hi" }], () => {}),
    ).rejects.toThrow("fetch failed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("非瞬断错误（HTTP 401）不重试", async () => {
    process.env.LLM_API_KEY = "test-key";
    process.env.LLM_BASE_URL = "https://llm.test/v4";
    process.env.LLM_MODEL = "test-model";
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"error":{}}', { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createOpenAiCompatibleLlm().generate([{ role: "user", content: "hi" }], () => {}),
    ).rejects.toThrow("401");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("永久性网络错误（ENOTFOUND 域名解析失败）不重试", async () => {
    process.env.LLM_API_KEY = "test-key";
    process.env.LLM_BASE_URL = "https://llm.test/v4";
    process.env.LLM_MODEL = "test-model";
    const fetchMock = vi.fn().mockRejectedValue(fetchFailed("ENOTFOUND"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createOpenAiCompatibleLlm().generate([{ role: "user", content: "hi" }], () => {}),
    ).rejects.toThrow("fetch failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("流中期中断在任何正文输出前断开时重试一次并成功", async () => {
    process.env.LLM_API_KEY = "test-key";
    process.env.LLM_BASE_URL = "https://llm.test/v4";
    process.env.LLM_MODEL = "test-model";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(sseThenTerminated([]))
      .mockResolvedValueOnce(sseResponse(["你好，世界"]));
    vi.stubGlobal("fetch", fetchMock);

    const out = await createOpenAiCompatibleLlm().generate([{ role: "user", content: "hi" }], () => {});
    expect(out).toBe("你好，世界");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("流中断前已输出部分正文时不重试（避免内容重复）", async () => {
    process.env.LLM_API_KEY = "test-key";
    process.env.LLM_BASE_URL = "https://llm.test/v4";
    process.env.LLM_MODEL = "test-model";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(sseThenTerminated(["你好"]))
      .mockResolvedValueOnce(sseResponse(["不该被调用"]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createOpenAiCompatibleLlm().generate([{ role: "user", content: "hi" }], () => {}),
    ).rejects.toThrow("terminated");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
