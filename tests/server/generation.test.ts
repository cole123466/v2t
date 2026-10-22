import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb, type Db } from "@/server/db";
import {
  GenerationService,
  GenerationStore,
  PRESET_TEMPLATES,
  type LLMMessage,
  type LLMProvider,
} from "@/server/generations";

let dir: string;
let db: Db;
let store: GenerationStore;
let service: GenerationService;

/** 假 LLM：分片推流并记录收到的 messages */
type ChatMessage = LLMMessage;

function makeFakeLlm(behavior: "ok" | "boom"): LLMProvider & { messages: ChatMessage[] } {
  const self = {
    messages: [] as ChatMessage[],
    async generate(messages: ChatMessage[], onChunk: (delta: string) => void): Promise<string> {
      self.messages = messages;
      if (behavior === "boom") throw new Error("LLM 服务不可用（模拟）");
      onChunk("第一段。");
      onChunk("第二段。");
      return "第一段。第二段。";
    },
  };
  return self;
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "v2t-gen-"));
  db = openDb(path.join(dir, "test.db"));
  store = new GenerationStore(db);
});

afterAll(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

const TASK_A = "11111111-1111-1111-1111-111111111111";

describe("文案生成（Seam B）", () => {
  it("模板注入：预设模板的指令与转录稿一起进入 user 消息，版本落库为 auto", async () => {
    const fake = makeFakeLlm("ok");
    const svc = new GenerationService({ store, llm: fake });
    const gen = await svc.generateForTask(
      TASK_A,
      { segments: [{ start: 0, end: 5, text: "今天聊聊工作流。" }] },
      { mode: "auto", templateId: "xhs" },
    );

    const userMsg = fake.messages.find((m) => m.role === "user");
    expect(userMsg?.content).toContain("今天聊聊工作流。");
    expect(userMsg?.content).toContain(PRESET_TEMPLATES.find((t) => t.id === "xhs")!.label);
    expect(gen.mode).toBe("auto");
    expect(gen.templateId).toBe("xhs");
    expect(gen.status).toBe("done");
    expect(gen.output).toBe("第一段。第二段。");
  });

  it("流式聚合：onChunk 按序收到增量，output 为完整聚合", async () => {
    const fake = makeFakeLlm("ok");
    const svc = new GenerationService({ store, llm: fake });
    const deltas: string[] = [];
    const gen = await svc.generateForTask(
      TASK_A,
      { segments: [{ start: 0, end: 5, text: "内容" }] },
      { mode: "manual", prompt: "写一段朋友圈文案" },
      (d) => deltas.push(d),
    );
    expect(deltas).toEqual(["第一段。", "第二段。"]);
    expect(gen.output).toBe("第一段。第二段。");
    // manual 模式：用户提示词原样进入 user 消息
    const userMsg = fake.messages.find((m) => m.role === "user");
    expect(userMsg?.content).toContain("写一段朋友圈文案");
    expect(gen.mode).toBe("manual");
  });

  it("多版本：同一任务多次生成，历史按新到旧排列", async () => {
    const svc = new GenerationService({ store, llm: makeFakeLlm("ok") });
    const t = { segments: [{ start: 0, end: 1, text: "x" }] };
    const g1 = await svc.generateForTask(
      TASK_A,
      t,
      { mode: "auto", templateId: "brief" },
    );
    const g2 = await svc.generateForTask(
      TASK_A,
      t,
      { mode: "auto", templateId: "refine" },
    );
    const list = store.listForTask(TASK_A);
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list[0].id).toBe(g2.id);
    expect(list.some((g) => g.id === g1.id)).toBe(true);
  });

  it("LLM 失败：版本保留为 failed 且带错误原因", async () => {
    const svc = new GenerationService({ store, llm: makeFakeLlm("boom") });
    await expect(
      svc.generateForTask(
        TASK_A,
        { segments: [{ start: 0, end: 1, text: "x" }] },
        { mode: "auto", templateId: "refine" },
      ),
    ).rejects.toThrow(/LLM/);
    const last = store.listForTask(TASK_A)[0];
    expect(last.status).toBe("failed");
    expect(last.error).toMatch(/LLM/);
  });
});
