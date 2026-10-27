import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCatalog } from "@/server/article";
import { ArticleService, ArticleStore } from "@/server/articles";
import { ActivityStore } from "@/server/activities";
import { openDb, type Db } from "@/server/db";
import { QaService, QaStore } from "@/server/qa";
import type { LLMMessage, LLMProvider } from "@/server/generations";
import { checkCitations, citationRetryNote, knownCitationIds } from "@/lib/citations";

let dir: string;
let db: Db;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "v2t-cite-"));
  db = openDb(path.join(dir, "test.db"));
});

afterAll(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

const TRANSCRIPT = {
  durationSec: 30,
  timestampsMissing: false,
  segments: [
    { start: 0, end: 10, text: "开场介绍" },
    { start: 10, end: 20, text: "第二个要点" },
    { start: 20, end: 30, text: "总结" },
  ],
};
const CATALOG = buildCatalog(TRANSCRIPT as never, null);
const KNOWN = knownCitationIds(CATALOG.transcripts.map((t) => t.id), CATALOG.frames.map((f) => f.id));

describe("15 号票：checkCitations 纯函数（验收7）", () => {
  it("合法 / 非法 / 混合 / 空 / 重复", () => {
    expect(checkCitations("见 [[t01]] 与 [[t02]]", KNOWN).invalid).toEqual([]);
    expect(checkCitations("见 [[t99]]", KNOWN).invalid).toEqual(["t99"]);
    const mixed = checkCitations("见 [[t01]] 与 [[t99]] 和 [[f01]]", KNOWN);
    expect(mixed.valid).toContain("t01");
    expect(mixed.invalid).toEqual(["f01", "t99"]);
    expect(checkCitations("没有引用", KNOWN).valid).toEqual([]);
    expect(checkCitations("[[t99]] [[t99]]", KNOWN).invalid).toEqual(["t99"]);
    const cleaned = checkCitations("证据 [[t99]] 结尾", KNOWN);
    expect(cleaned.cleaned).toBe("证据  结尾");
  });

  it("重问提示包含非法编号与可用范围", () => {
    const note = citationRetryNote(["t99"], "[[t01]]…[[t03]]");
    expect(note).toContain("t99");
    expect(note).toContain("[[t01]]");
  });
});

function outlineJson(count = 1): string {
  return JSON.stringify({
    title: "引用测试",
    sections: Array.from({ length: count }, (_, i) => ({
      id: "s" + (i + 1),
      title: "第" + (i + 1) + "章",
      summary: "",
    })),
    mindMap: [],
  });
}

describe("文章 strict 引用校验", () => {
  it("验收1：非法编号第一次被拒并重问，第二次成功", async () => {
    const store = new ArticleStore(db);
    const activities = new ActivityStore(db);
    let calls = 0;
    const llm: LLMProvider = {
      async generate(messages: LLMMessage[]) {
        calls += 1;
        if (calls === 1) return outlineJson(1);
        const promptText = JSON.stringify(messages);
        if (promptText.includes("你引用了不存在的编号")) {
          return JSON.stringify({
            id: "s1",
            title: "第1章",
            blocks: [{ type: "paragraph", text: "正确引用 [[t01]]" }],
          });
        }
        return JSON.stringify({
          id: "s1",
          title: "第1章",
          blocks: [{ type: "paragraph", text: "伪造引用 [[t99]]" }],
        });
      },
    };
    const svc = new ArticleService({ store, llm, activities });
    const record = await svc.generate({ taskId: "t-c1", catalog: CATALOG, frameFiles: new Map() });
    expect(record.status).toBe("done");
    expect(JSON.stringify(record.content)).not.toContain("t99");
    expect(JSON.stringify(record.content)).toContain("[[t01]]");
  });

  it("验收2：两次都非法 → 该章失败，整篇不发布", async () => {
    const store = new ArticleStore(db);
    let calls = 0;
    const llm: LLMProvider = {
      async generate() {
        calls += 1;
        if (calls === 1) return outlineJson(1);
        return JSON.stringify({
          id: "s1",
          title: "第1章",
          blocks: [{ type: "paragraph", text: "总是伪造 [[t99]]" }],
        });
      },
    };
    const svc = new ArticleService({ store, llm });
    await expect(
      svc.generate({ taskId: "t-c2", catalog: CATALOG, frameFiles: new Map() }),
    ).rejects.toThrow(/t99|不合规/);
    expect(store.listForTask("t-c2")[0].status).toBe("failed");
  });
});

describe("问答 lenient 引用校验", () => {
  it("验收3：重问一次成功则无降级声明", async () => {
    const store = new QaStore(db);
    let calls = 0;
    const llm: LLMProvider = {
      async generate() {
        calls += 1;
        if (calls === 1) {
          return JSON.stringify({ answer: "答案里有 [[t99]] 这个假编号。", limitations: [] });
        }
        return JSON.stringify({ answer: "修正后的答案，引用 [[t01]]。", limitations: [] });
      },
    };
    const svc = new QaService({ store, llm });
    const { answer } = await svc.ask({ taskId: "t-q1", transcript: TRANSCRIPT as never, question: "测试" });
    expect(answer.text).toContain("[[t01]]");
    expect(answer.text).not.toContain("t99");
    expect(answer.limitations).toHaveLength(0);
  });

  it("验收3b：重问仍非法 → 保留回答 + 降级声明", async () => {
    const store = new QaStore(db);
    const llm: LLMProvider = {
      async generate() {
        return JSON.stringify({ answer: "坚持使用 [[t99]] 和 [[t88]]。", limitations: ["原有限制"] });
      },
    };
    const svc = new QaService({ store, llm });
    const { answer } = await svc.ask({ taskId: "t-q2", transcript: TRANSCRIPT as never, question: "测试" });
    expect(answer.text).not.toContain("[[t99]]");
    expect(answer.text).toContain("坚持使用");
    expect(answer.limitations.join()).toContain("已移除 2 个无法核实的出处编号");
    expect(answer.limitations.join()).toContain("原有限制");
  });
});

// ---------------------------------------------------------------------------
// 15 号票后半：语义核对（C4/C6/C7，验收 4/5/6）
// ---------------------------------------------------------------------------

const SECTION_OK = JSON.stringify({
  id: "s1",
  title: "第1章",
  blocks: [{ type: "paragraph", text: "视频开场是介绍 [[t01]]，随后讲了第二个要点 [[t02]]。" }],
});

const SECTION_BAD = JSON.stringify({
  id: "s1",
  title: "第1章",
  blocks: [{ type: "paragraph", text: "开场介绍了量子纠错的前沿进展 [[t01]]。" }],
});

const VERIFY_RESULTS = (verdicts: string[]) =>
  JSON.stringify({ results: verdicts.map((verdict, i) => ({ i, verdict, reason: "r" })) });

/** 核对链路的假 LLM：按 prompt 特征分流（核对/重写/章节/提纲），顺序敏感——章节 prompt 也含「提纲」字样 */
function verifyLlm(handlers: {
  section: () => string;
  /** verifyCalls：第几次核对调用（1 起）；默认每次都返回同样结果 */
  verify: (verifyCalls: number) => string;
  rewrite?: () => string;
}): LLMProvider & { verifyCalls: () => number; rewriteCalls: () => number } {
  let verifyCalls = 0;
  let rewriteCalls = 0;
  return {
    async generate(messages: LLMMessage[]) {
      const text = JSON.stringify(messages);
      if (text.includes("核对员")) {
        verifyCalls += 1;
        return handlers.verify(verifyCalls);
      }
      if (text.includes("未能支持论断")) {
        rewriteCalls += 1;
        return handlers.rewrite?.() ?? handlers.section();
      }
      if (text.includes("只写这一章")) return handlers.section();
      return outlineJson(1);
    },
    verifyCalls: () => verifyCalls,
    rewriteCalls: () => rewriteCalls,
  };
}

describe("语义核对（C4/C6/C7）", () => {
  it("验收4：unsupported 触发重写一次，重写通过则正文替换", async () => {
    const store = new ArticleStore(db);
    const activities = new ActivityStore(db);
    let sectionCalls = 0;
    let rewriteCalls = 0;
    const llm = verifyLlm({
      section: () => {
        sectionCalls += 1;
        return SECTION_BAD;
      },
      verify: (n) => (n === 1 ? VERIFY_RESULTS(["unsupported"]) : VERIFY_RESULTS(["supported"])),
      rewrite: () => {
        rewriteCalls += 1;
        return SECTION_OK;
      },
    });
    const svc = new ArticleService({ store, llm, activities });
    const record = await svc.generate({ taskId: "t-v1", catalog: CATALOG, frameFiles: new Map() });
    expect(record.status).toBe("done");
    expect(sectionCalls).toBe(1); // 原始章节调用
    expect(rewriteCalls).toBe(1); // 重写恰好一次
    expect(JSON.stringify(record.content)).toContain("第二个要点");
    expect(record.content?.limitations ?? []).toHaveLength(0);
    // verify 步骤：completed，message 记录重写
    const verifyStep = activities
      .listForTask("t-v1")
      .find((a) => a.kind === "verify");
    expect(verifyStep?.status).toBe("completed");
    expect(verifyStep?.title).toContain("第 1 章");
    expect(verifyStep?.message).toContain("已重写");
  });

  it("验收4b：重写仍 unsupported → 正文保留 + 内联标注 + limitations", async () => {
    const store = new ArticleStore(db);
    const activities = new ActivityStore(db);
    const llm = verifyLlm({
      section: () => SECTION_BAD,
      verify: () => VERIFY_RESULTS(["unsupported"]),
    });
    const svc = new ArticleService({ store, llm, activities });
    const record = await svc.generate({ taskId: "t-v2", catalog: CATALOG, frameFiles: new Map() });
    expect(record.status).toBe("done");
    // 核对恰好 2 次（原章 + 重写后各 1 次），重写恰好 1 次——不多不少
    expect(llm.verifyCalls()).toBe(2);
    expect(llm.rewriteCalls()).toBe(1);
    // 正文保留（论断句子还在），引用后带标注
    expect(JSON.stringify(record.content)).toContain("量子纠错");
    expect(JSON.stringify(record.content)).toContain("出处未核实");
    const limitationTexts = (record.content?.limitations ?? []).map((l) => l.text).join();
    expect(limitationTexts).toContain("第 1 章");
    expect(limitationTexts).toContain("未能在原文中找到直接支持");
    const verifyStep = activities.listForTask("t-v2").find((a) => a.kind === "verify");
    expect(verifyStep?.status).toBe("completed");
    expect(verifyStep?.message).toContain("已标注");
  });

  it("验收5：verify 步骤落库且 title 含章节号、message 与结论一致", async () => {
    const store = new ArticleStore(db);
    const activities = new ActivityStore(db);
    const llm = verifyLlm({
      section: () => SECTION_OK,
      verify: () => VERIFY_RESULTS(["supported", "supported"]),
    });
    const svc = new ArticleService({ store, llm, activities });
    await svc.generate({ taskId: "t-v3", catalog: CATALOG, frameFiles: new Map() });
    const verifyStep = activities.listForTask("t-v3").find((a) => a.kind === "verify");
    expect(verifyStep?.status).toBe("completed");
    expect(verifyStep?.title).toBe("核对第 1 章引用");
    expect(verifyStep?.message).toContain("2 处引用全部支持");
    expect(verifyStep?.phase).toBe("write");
  });

  it("验收6：核对调用抛错 → 步骤 failed，文章仍发布（质量增强不阻塞）", async () => {
    const store = new ArticleStore(db);
    const activities = new ActivityStore(db);
    const llm = verifyLlm({
      section: () => SECTION_OK,
      verify: () => {
        throw new Error("模型服务超时");
      },
    });
    const svc = new ArticleService({ store, llm, activities });
    const record = await svc.generate({ taskId: "t-v4", catalog: CATALOG, frameFiles: new Map() });
    expect(record.status).toBe("done");
    const verifyStep = activities.listForTask("t-v4").find((a) => a.kind === "verify");
    expect(verifyStep?.status).toBe("failed");
    expect(verifyStep?.message).toContain("模型服务超时");
  });

  it("无引用的章节只核对一次调用都省掉（步骤 completed，无 unsupported）", async () => {
    const store = new ArticleStore(db);
    const activities = new ActivityStore(db);
    const llm = verifyLlm({
      section: () =>
        JSON.stringify({
          id: "s1",
          title: "第1章",
          blocks: [{ type: "paragraph", text: "本章没有任何引用标记。" }],
        }),
      verify: () => VERIFY_RESULTS([]),
    });
    const svc = new ArticleService({ store, llm, activities });
    const record = await svc.generate({ taskId: "t-v5", catalog: CATALOG, frameFiles: new Map() });
    expect(record.status).toBe("done");
    // 无引用 → 核对调用本身必须被省掉，而不是发一次调用返回空结果
    expect(llm.verifyCalls()).toBe(0);
    const verifyStep = activities.listForTask("t-v5").find((a) => a.kind === "verify");
    expect(verifyStep?.status).toBe("completed");
    expect(verifyStep?.message).toContain("没有需要核对");
  });
});
