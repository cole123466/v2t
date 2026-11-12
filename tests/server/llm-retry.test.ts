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

  it("上游 5xx 退避重试后成功", async () => {
    process.env.LLM_API_KEY = "test-key";
    process.env.LLM_BASE_URL = "https://llm.test/v4";
    process.env.LLM_MODEL = "test-model";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"code":50507,"message":"Request failed: Unknown error."}', { status: 500 }))
      .mockResolvedValueOnce(sseResponse(["恢复"]));
    vi.stubGlobal("fetch", fetchMock);

    const out = await createOpenAiCompatibleLlm().generate([{ role: "user", content: "hi" }], () => {});
    expect(out).toBe("恢复");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("上游 429 余额不足不重试（重试只会再失败一次）", async () => {
    process.env.LLM_API_KEY = "test-key";
    process.env.LLM_BASE_URL = "https://llm.test/v4";
    process.env.LLM_MODEL = "test-model";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"error":{"code":"1113","message":"余额不足或无可用资源包,请充值。"}}', { status: 429 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createOpenAiCompatibleLlm().generate([{ role: "user", content: "hi" }], () => {}),
    ).rejects.toThrow("429");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("上游 5xx 连续失败时最多尝试三次", async () => {
    process.env.LLM_API_KEY = "test-key";
    process.env.LLM_BASE_URL = "https://llm.test/v4";
    process.env.LLM_MODEL = "test-model";
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"code":50507}', { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createOpenAiCompatibleLlm().generate([{ role: "user", content: "hi" }], () => {}),
    ).rejects.toThrow("500");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("带图消息走独立视觉服务商", () => {
  const keys = [
    "LLM_API_KEY",
    "LLM_BASE_URL",
    "LLM_MODEL",
    "LLM_VISION_API_KEY",
    "LLM_VISION_BASE_URL",
    "LLM_VISION_MODEL",
  ] as const;
  const prev = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of keys) {
      const value = prev[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const imageMessage = () => [
    {
      role: "user" as const,
      content: [
        { type: "text" as const, text: "看图写一段" },
        { type: "image_url" as const, image_url: { url: "data:image/jpeg;base64,AAAA" } },
      ],
    },
  ];

  it("配齐 vision base/key 时，图片消息发往视觉服务商", async () => {
    process.env.LLM_API_KEY = "text-key";
    process.env.LLM_BASE_URL = "https://text.test/v1";
    process.env.LLM_MODEL = "text-model";
    process.env.LLM_VISION_API_KEY = "vision-key";
    process.env.LLM_VISION_BASE_URL = "https://vision.test/v1";
    process.env.LLM_VISION_MODEL = "vision-model";
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(["图"]));
    vi.stubGlobal("fetch", fetchMock);

    const seen: string[] = [];
    await createOpenAiCompatibleLlm().generate(imageMessage(), () => {}, {
      onModel: (model) => seen.push(model),
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://vision.test/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer vision-key");
    expect(JSON.parse(String(init.body)).model).toBe("vision-model");
    expect(seen).toEqual(["vision-model"]);
  });

  it("只配 vision model 时沿用文本服务商的 base/key", async () => {
    process.env.LLM_API_KEY = "text-key";
    process.env.LLM_BASE_URL = "https://text.test/v1";
    process.env.LLM_MODEL = "text-model";
    delete process.env.LLM_VISION_API_KEY;
    delete process.env.LLM_VISION_BASE_URL;
    process.env.LLM_VISION_MODEL = "vision-model";
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(["图"]));
    vi.stubGlobal("fetch", fetchMock);

    await createOpenAiCompatibleLlm().generate(imageMessage(), () => {});

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://text.test/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer text-key");
    expect(JSON.parse(String(init.body)).model).toBe("vision-model");
  });

  it("纯文本消息仍走文本服务商", async () => {
    process.env.LLM_API_KEY = "text-key";
    process.env.LLM_BASE_URL = "https://text.test/v1";
    process.env.LLM_MODEL = "text-model";
    process.env.LLM_VISION_API_KEY = "vision-key";
    process.env.LLM_VISION_BASE_URL = "https://vision.test/v1";
    process.env.LLM_VISION_MODEL = "vision-model";
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(["文"]));
    vi.stubGlobal("fetch", fetchMock);

    await createOpenAiCompatibleLlm().generate([{ role: "user", content: "hi" }], () => {});

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://text.test/v1/chat/completions");
    expect(JSON.parse(String(init.body)).model).toBe("text-model");
  });
});
