import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb, type Db } from "@/server/db";
import type { LLMProvider } from "@/server/generations";
import {
  QaService,
  QaStore,
  retrieveSegments,
  sampleAcross,
  shouldSendFullTranscript,
  tokenize,
} from "@/server/qa";

let dir: string;
let db: Db;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "v2t-qa-"));
  db = openDb(path.join(dir, "test.db"));
});

afterAll(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

const TRANSCRIPT = {
  durationSec: 100,
  timestampsMissing: false,
  segments: [
    { start: 0, end: 8, text: "今天我们讲神经网络的基础结构" },
    { start: 8, end: 20, text: "输入层负责接收数据，隐含层做特征变换" },
    { start: 20, end: 35, text: "权重决定了每个连接的重要性" },
    { start: 35, end: 50, text: "反向传播用来更新这些权重" },
    { start: 50, end: 70, text: "最后输出层给出预测结果" },
  ],
};

function fakeLlm(answer: string): LLMProvider {
  return {
    async generate(_messages, onChunk) {
      onChunk(answer);
      return answer;
    },
  };
}

describe("词法检索（纯函数）", () => {
  it("中文按 2 字滑窗切分，英文词保持整体", () => {
    const tokens = tokenize("神经网络 API demo");
    expect(tokens).toContain("神经");
    expect(tokens).toContain("网络");
    expect(tokens).toContain("api");
    expect(tokens).toContain("demo");
  });

  it("命中段落与邻居一起返回，按时间排序", () => {
    const hits = retrieveSegments(TRANSCRIPT.segments, "权重");
    const texts = hits.map((h) => h.segment.text);
    expect(texts.some((t) => t.includes("权重决定"))).toBe(true);
    // 邻接段也被带出
    expect(texts.some((t) => t.includes("隐含层")) || texts.some((t) => t.includes("反向传播"))).toBe(true);
    const indexes = hits.map((h) => h.index);
    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);
  });

  it("无命中返回空数组", () => {
    expect(retrieveSegments(TRANSCRIPT.segments, "量子计算")).toEqual([]);
  });

  it("短稿判定：段数与总字数都超限才走检索", () => {
    expect(shouldSendFullTranscript(TRANSCRIPT.segments)).toBe(true);
    // 段数超限、字数也超限
    const many = Array.from({ length: 100 }, (_, i) => ({
      start: i * 5,
      end: i * 5 + 4,
      text: "这是一段比较长的转写内容用来超过字数上限".repeat(4),
    }));
    expect(shouldSendFullTranscript(many)).toBe(false);
    // 段数超限但字数很少（大量短句）仍全量送入
    const manyShort = Array.from({ length: 100 }, (_, i) => ({
      start: i * 5,
      end: i * 5 + 4,
      text: "好",
    }));
    expect(shouldSendFullTranscript(manyShort)).toBe(true);
  });

  it("无命中时全片均匀抽样，覆盖首尾", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      start: i * 5,
      end: i * 5 + 4,
      text: `第 ${i} 段内容`,
    }));
    const sampled = sampleAcross(many, 24);
    expect(sampled).toHaveLength(24);
    expect(sampled[0].index).toBe(0);
    expect(sampled[sampled.length - 1].index).toBeGreaterThan(90);
  });
});

describe("问答（Seam D · 引用校验）", () => {
  it("合法引用：回答带出处，会话按序落库", async () => {
    const store = new QaStore(db);
    const svc = new QaService({
      store,
      llm: fakeLlm('{"answer":"权重表示连接重要性 [[t03]]。","limitations":["画面未参与判断"]}'),
    });
    const { message } = await svc.ask({
      taskId: "qa-task-1",
      transcript: TRANSCRIPT,
      question: "权重是什么意思？",
    });

    expect(message.citations).toHaveLength(1);
    expect(message.citations![0].segmentIndex).toBe(2);
    expect(message.citations![0].quote).toContain("权重");
    expect(message.limitations).toEqual(["画面未参与判断"]);

    const history = store.listForTask("qa-task-1");
    expect(history.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("越界引用被移除，并追加一条限制说明", async () => {
    const store = new QaStore(db);
    const svc = new QaService({
      store,
      llm: fakeLlm('{"answer":"编的出处 [[t99]] 和真出处 [[t01]]。","limitations":[]}'),
    });
    const { message } = await svc.ask({
      taskId: "qa-task-2",
      transcript: TRANSCRIPT,
      question: "讲讲开场",
    });
    expect(message.content).not.toContain("t99");
    expect(message.citations!.map((c) => c.segmentIndex)).toEqual([0]);
    expect(message.limitations!.join()).toMatch(/无法核实/);
  });

  it("模型不按 JSON 返回：整段作为回答并标注限制", async () => {
    const store = new QaStore(db);
    const svc = new QaService({ store, llm: fakeLlm("这是一段自由文本回答。") });
    const { message } = await svc.ask({
      taskId: "qa-task-3",
      transcript: TRANSCRIPT,
      question: "随便问问",
    });
    expect(message.content).toBe("这是一段自由文本回答。");
    expect(message.limitations!.length).toBeGreaterThan(0);
  });

  it("跨语言提问（中文问、英文稿）：无词法命中时仍把抽样内容交给模型", async () => {
    const store = new QaStore(db);
    let seen = "";
    const svc = new QaService({
      store,
      llm: {
        async generate(messages) {
          seen = String(messages[1].content);
          return '{"answer":"这是一首关于承诺的歌 [[t01]]。","limitations":[]}';
        },
      },
    });
    const longEnglish = Array.from({ length: 100 }, (_, i) => ({
      start: i * 3,
      end: i * 3 + 2,
      text: `English lyric line number ${i} about love and promises`,
    }));
    await svc.ask({
      taskId: "qa-task-cross-lang",
      transcript: { durationSec: 300, timestampsMissing: false, segments: longEnglish },
      question: "这首歌主要讲了什么？",
    });
    expect(seen).toContain("均匀抽样");
    expect(seen).toContain("English lyric line number 0");
  });

  it("空问题被拒绝", async () => {
    const store = new QaStore(db);
    const svc = new QaService({ store, llm: fakeLlm("{}") });
    await expect(
      svc.ask({ taskId: "qa-task-4", transcript: TRANSCRIPT, question: "   " }),
    ).rejects.toThrow(/不能为空/);
  });

  it("会话删除：removeAllForTask 清空该任务历史", async () => {
    const store = new QaStore(db);
    const svc = new QaService({ store, llm: fakeLlm('{"answer":"x [[t01]]","limitations":[]}') });
    await svc.ask({ taskId: "qa-task-5", transcript: TRANSCRIPT, question: "问一个问题" });
    expect(store.listForTask("qa-task-5").length).toBeGreaterThan(0);
    store.removeAllForTask("qa-task-5");
    expect(store.listForTask("qa-task-5")).toEqual([]);
  });
});
