import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb, type Db } from "@/server/db";
import type { LLMProvider } from "@/server/generations";
import {
  QaService,
  QaStore,
  QaContextError,
  retrieveSegments,
  sampleAcross,
  shouldSendFullTranscript,
  tokenize,
  validateQaContext,
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

describe("轮模型（09 号票 P3）", () => {
  it("同一轮 user 与 assistant 共享 turn_id，assistant 行落 completed 终态", async () => {
    const store = new QaStore(db);
    const svc = new QaService({ store, llm: fakeLlm('{"answer":"权重重要 [[t03]]。","limitations":[]}') });
    const { message, turnId } = await svc.ask({
      taskId: "turn-task-1",
      transcript: TRANSCRIPT,
      question: "权重是什么？",
    });

    expect(turnId).toBeTruthy();
    expect(message.turnId).toBe(turnId);
    expect(message.status).toBe("completed");
    const history = store.listForTask("turn-task-1");
    expect(history.map((m) => m.turnId)).toEqual([turnId, turnId]);
    expect(history[0].status).toBeNull(); // user 行无状态
    expect(history[1].content).toContain("权重");
  });

  it("上游中止：assistant 行由服务端落 canceled", async () => {
    const store = new QaStore(db);
    const controller = new AbortController();
    const svc = new QaService({
      store,
      llm: {
        async generate(_messages, _onChunk, meta) {
          meta?.signal?.addEventListener("abort", () => controller.abort(), { once: true });
          controller.abort();
          // 模拟 llm 层感知 signal 后抛错（对齐 llm.ts 的「请求已取消」文案）
          throw new Error("请求已取消");
        },
      },
    });
    await expect(
      svc.ask({
        taskId: "turn-task-2",
        transcript: TRANSCRIPT,
        question: "讲讲开场",
        signal: controller.signal,
      }),
    ).rejects.toThrow(/已取消/);

    const [user, assistant] = store.listForTask("turn-task-2");
    expect(assistant.status).toBe("canceled");
    expect(assistant.error).toBeNull();
    expect(user.turnId).toBe(assistant.turnId);
  });

  it("上游失败：assistant 行落 failed 并带错误信息", async () => {
    const store = new QaStore(db);
    const svc = new QaService({
      store,
      llm: {
        async generate() {
          throw new Error("LLM 服务返回 500");
        },
      },
    });
    await expect(
      svc.ask({ taskId: "turn-task-3", transcript: TRANSCRIPT, question: "问" }),
    ).rejects.toThrow(/500/);

    const [, assistant] = store.listForTask("turn-task-3");
    expect(assistant.status).toBe("failed");
    expect(assistant.error).toContain("500");
  });

  it("lastTurn/getTurn 定位最后一轮；重答以新 turn 追加，旧轮保留", async () => {
    const store = new QaStore(db);
    const svc = new QaService({ store, llm: fakeLlm('{"answer":"答 [[t01]]","limitations":[]}') });
    const first = await svc.ask({ taskId: "turn-task-4", transcript: TRANSCRIPT, question: "第一问" });
    const second = await svc.ask({
      taskId: "turn-task-4",
      transcript: TRANSCRIPT,
      question: "第二问",
      turnId: first.turnId,
    });
    expect(second.turnId).toBe(first.turnId);

    // 手动把最后一轮改成 canceled 模拟中断
    const lastAssistant = store.lastTurn("turn-task-4").find((m) => m.role === "assistant")!;
    store.updateStatus(lastAssistant.id, { status: "canceled" });

    expect(store.lastTurn("turn-task-4").map((m) => m.role)).toEqual(["user", "assistant"]);
    // 两问共用同一个 turnId，getTurn 返回全部 4 行
    expect(store.getTurn("turn-task-4", first.turnId).length).toBe(4);

    // 重答产生新 turn，旧轮原样保留
    const retried = await svc.ask({ taskId: "turn-task-4", transcript: TRANSCRIPT, question: "第二问" });
    expect(retried.turnId).not.toBe(first.turnId);
    const all = store.listForTask("turn-task-4");
    expect(all.filter((m) => m.role === "user")).toHaveLength(3);
    // 重答的轮排在最后；被取消的是第二次问答那一行（下标 3），重答行已 completed
    expect(all[3].status).toBe("canceled");
    expect(all[5].status).toBe("completed");
    const oldTurn = store.getTurn("turn-task-4", first.turnId);
    expect(oldTurn).toHaveLength(4); // 两问共用一个 turnId：2 问 + 2 答
    expect(oldTurn[3].status).toBe("canceled"); // 被取消的是第二次问答那一行
    expect(store.lastTurn("turn-task-4")[1].status).toBe("completed");
  });

  it("老数据（无 turn_id）按相邻对合成轮，getTurn 兼容 assistant 行 id", async () => {
    const store = new QaStore(db);
    store.add({ taskId: "turn-task-5", role: "user", content: "老问题" });
    store.add({ taskId: "turn-task-5", role: "assistant", content: "老回答" });
    const all = store.listForTask("turn-task-5");
    expect(all.every((m) => m.turnId === null)).toBe(true);

    const assistant = all[1];
    const turn = store.getTurn("turn-task-5", assistant.id);
    expect(turn.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(turn[0].content).toBe("老问题");
  });
});

describe("锚点校验（09 号票 P1/P2 服务端白名单）", () => {
  const lookups = {
    section: (id: string) =>
      id === "s1" ? { blocks: [{ text: "神经网络的基础结构是分层处理" }] } : null,
    frame: (id: string) => (id === "f01" ? { id: "f01", tSec: 3 } : null),
    segmentCount: TRANSCRIPT.segments.length,
  };

  it("section 锚点：quote 是块文本前缀或包含时通过", () => {
    expect(() =>
      validateQaContext(
        { kind: "section", sectionId: "s1", blockIndex: 0, quote: "神经网络的基础结构" },
        lookups,
      ),
    ).not.toThrow();
    expect(() =>
      validateQaContext({ kind: "section", sectionId: "s1", blockIndex: 0, quote: "分层处理" }, lookups),
    ).not.toThrow();
  });

  it("伪造锚点（quote 与块内容不符）拒绝，field 指向 context.quote", () => {
    try {
      validateQaContext(
        { kind: "section", sectionId: "s1", blockIndex: 0, quote: "凭空捏造的内容" },
        lookups,
      );
      expect.unreachable("应抛出 QaContextError");
    } catch (err) {
      expect(err).toBeInstanceOf(QaContextError);
      expect((err as QaContextError).field).toBe("context.quote");
    }
  });

  it("quote 超 200 字拒绝；块不存在拒绝", () => {
    expect(() =>
      validateQaContext(
        { kind: "section", sectionId: "s1", blockIndex: 0, quote: "长".repeat(201) },
        lookups,
      ),
    ).toThrow(/200/);
    expect(() =>
      validateQaContext({ kind: "section", sectionId: "missing", blockIndex: 0, quote: "x" }, lookups),
    ).toThrow(/不存在/);
    expect(() =>
      validateQaContext({ kind: "section", sectionId: "s1", blockIndex: 9, quote: "x" }, lookups),
    ).toThrow(/不存在/);
  });

  it("transcript 锚点：段下标越界拒绝；frame 锚点不在目录内拒绝", () => {
    expect(() =>
      validateQaContext({ kind: "transcript", segmentIndex: 0, quote: "今天我们讲" }, lookups),
    ).not.toThrow();
    expect(() =>
      validateQaContext({ kind: "transcript", segmentIndex: 99, quote: "x" }, lookups),
    ).toThrow();
    expect(() => validateQaContext({ kind: "frame", frameId: "f01" }, lookups)).not.toThrow();
    expect(() => validateQaContext({ kind: "frame", frameId: "f99" }, lookups)).toThrow(/不存在/);
  });
});
