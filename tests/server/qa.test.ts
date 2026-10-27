import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb, type Db } from "@/server/db";
import type { LLMProvider } from "@/server/generations";
import {
  QaContextError,
  QaService,
  QaStore,
  retrieveSegments,
  sampleAcross,
  shouldSendFullTranscript,
  tokenize,
  validateQaContext,
  type QaContext,
} from "@/server/qa";
import type { Article } from "@/server/article";

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

describe("锚点校验（09 号票 P1/P2）", () => {
  const ARTICLE: Article = {
    title: "神经 网络 讲义",
    sections: [
      {
        id: "sec-1",
        title: "基础结构",
        blocks: [
          { type: "paragraph", text: "神经网络由多层节点组成，每层负责不同粒度的特征。" },
          { type: "figure", frameId: "f01", caption: "网络结构示意" },
        ],
      },
    ],
    mindMap: [],
    limitations: [],
  };
  const source = {
    article: ARTICLE,
    transcript: TRANSCRIPT,
    frameIds: new Set(["f01", "f02"]),
  };

  it("合法锚点通过：文章选段（包含核对）、文稿选段、帧", () => {
    const section: QaContext = {
      kind: "section",
      sectionId: "sec-1",
      blockIndex: 0,
      quote: "多层节点组成",
    };
    expect(() => validateQaContext(section, source)).not.toThrow();
    const transcript: QaContext = { kind: "transcript", segmentIndex: 2, quote: "权重决定了" };
    expect(() => validateQaContext(transcript, source)).not.toThrow();
    const frame: QaContext = { kind: "frame", frameId: "f01" };
    expect(() => validateQaContext(frame, source)).not.toThrow();
  });

  it("伪造锚点拒绝：quote 与块内容不符时抛 QaContextError 且 field=context.quote", () => {
    const bad: QaContext = {
      kind: "section",
      sectionId: "sec-1",
      blockIndex: 0,
      quote: "这段文字不在文章里",
    };
    try {
      validateQaContext(bad, source);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(QaContextError);
      expect((err as QaContextError).field).toBe("context.quote");
    }
  });

  it("越界引用拒绝：章节 / 块 / 段 / 帧不存在", () => {
    expect(() =>
      validateQaContext({ kind: "section", sectionId: "nope", blockIndex: 0, quote: "x" }, source),
    ).toThrow(QaContextError);
    expect(() =>
      validateQaContext({ kind: "section", sectionId: "sec-1", blockIndex: 9, quote: "x" }, source),
    ).toThrow(QaContextError);
    expect(() =>
      validateQaContext({ kind: "transcript", segmentIndex: 99, quote: "x" }, source),
    ).toThrow(QaContextError);
    expect(() => validateQaContext({ kind: "frame", frameId: "f99" }, source)).toThrow(
      QaContextError,
    );
  });

  it("超长 quote 拒绝（上限 200 字）", () => {
    expect(() =>
      validateQaContext(
        { kind: "transcript", segmentIndex: 0, quote: "很".repeat(201) },
        source,
      ),
    ).toThrow(QaContextError);
  });
});

describe("选帧追问（09 号票 P2 · grounded 铁律）", () => {
  it("frame 锚点：单帧 dataURL 注入 user 消息，prompt 硬要求引用 [[fNN]]", async () => {
    const store = new QaStore(db);
    const seen: Array<string | unknown> = [];
    const svc = new QaService({
      store,
      llm: {
        async generate(messages) {
          seen.push(messages[1].content);
          return '{"answer":"画面显示网络结构 [[f01]]。","limitations":[]}';
        },
      },
    });
    const { message } = await svc.ask({
      taskId: "qa-frame-1",
      transcript: TRANSCRIPT,
      question: "这张画面里是什么？",
      context: { kind: "frame", frameId: "f01" },
      contextImage: "data:image/jpeg;base64,QUJD",
    });
    expect(message.content).toContain("[[f01]]");
    const content = seen[0] as Array<{ type: string; text?: string }>;
    expect(Array.isArray(content)).toBe(true);
    expect(content.some((p) => p.type === "image_url")).toBe(true);
    expect(JSON.stringify(content)).toContain("必须引用 [[f01]]");
  });

  it("回答缺 [[fNN]] 时重问一次；两次都缺则整轮失败，不落 assistant 行", async () => {
    const store = new QaStore(db);
    let calls = 0;
    const svc = new QaService({
      store,
      llm: {
        async generate() {
          calls++;
          return '{"answer":"说不清的画面内容 [[t01]]。","limitations":[]}';
        },
      },
    });
    await expect(
      svc.ask({
        taskId: "qa-frame-2",
        transcript: TRANSCRIPT,
        question: "这张画面里是什么？",
        context: { kind: "frame", frameId: "f01" },
        contextImage: "data:image/jpeg;base64,QUJD",
      }),
    ).rejects.toThrow(/未能引用选中画面/);
    expect(calls).toBe(2);
    const history = store.listForTask("qa-frame-2");
    expect(history.map((m) => m.role)).toEqual(["user"]);
  });

  it("重问后引用了帧：按第二次回答交付", async () => {
    const store = new QaStore(db);
    let calls = 0;
    const svc = new QaService({
      store,
      llm: {
        async generate() {
          calls++;
          return calls === 1
            ? '{"answer":"没提画面的回答。","limitations":[]}'
            : '{"answer":"画面里是结构图 [[f01]]。","limitations":[]}';
        },
      },
    });
    const { message } = await svc.ask({
      taskId: "qa-frame-3",
      transcript: TRANSCRIPT,
      question: "这张画面里是什么？",
      context: { kind: "frame", frameId: "f01" },
      contextImage: "data:image/jpeg;base64,QUJD",
    });
    expect(calls).toBe(2);
    expect(message.content).toContain("[[f01]]");
  });
});
