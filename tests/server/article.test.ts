import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildCatalog,
  extractCitations,
  looseJsonBody,
  normalizeCitations,
  parseArticleJson,
  validateCitations,
  validateStructure,
  type Article,
} from "@/server/article";
import { ArticleService, ArticleStore } from "@/server/articles";
import { openDb, type Db } from "@/server/db";
import type { LLMMessage, LLMProvider } from "@/server/generations";

let dir: string;
let db: Db;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "v2t-article-"));
  db = openDb(path.join(dir, "test.db"));
});

afterAll(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

const TRANSCRIPT = {
  durationSec: 120,
  timestampsMissing: false,
  segments: [
    { start: 0, end: 10, text: "开场介绍" },
    { start: 30, end: 45, text: "第一个要点" },
    { start: 90, end: 100, text: "总结" },
  ],
};

const MANIFEST = {
  width: 1280,
  frames: [
    { id: "f00", tSec: 5, file: "frames/f00.jpg", kind: "overview" as const, width: 1280 },
    { id: "f01", tSec: 60, file: "frames/f01.jpg", kind: "overview" as const, width: 1280 },
  ],
};

function makeArticle(overrides: Partial<Article> = {}): Article {
  return {
    title: "测试文章",
    sections: [
      {
        id: "s1",
        title: "第一章",
        blocks: [{ text: "开场提到 [[t01]]，画面见 [[f00]]。" }],
      },
    ],
    mindMap: [{ label: "主题", children: [{ label: "第一章", sectionId: "s1" }] }],
    limitations: [],
    ...overrides,
  };
}

describe("引用校验（纯函数）", () => {
  const catalog = buildCatalog(TRANSCRIPT, MANIFEST);

  it("合法引用：t 与 f 均在白名单内时通过", () => {
    expect(validateCitations(makeArticle(), catalog)).toEqual([]);
  });

  it("不存在的编号被拒绝", () => {
    const problems = validateCitations(
      makeArticle({ sections: [{ id: "s1", title: "x", blocks: [{ text: "见 [[t99]] 与 [[f42]]" }] }] }),
      catalog,
    );
    expect(problems.map((p) => p.message).join()).toMatch(/t99.*不存在/);
    expect(problems.map((p) => p.message).join()).toMatch(/f42.*不存在/);
  });

  it("无句级时间戳的任务禁止 t 引用，但仍允许 f 引用", () => {
    const noTs = buildCatalog({ ...TRANSCRIPT, timestampsMissing: true }, MANIFEST);
    const withTime = validateCitations(makeArticle(), noTs);
    expect(withTime.some((p) => p.message.includes("没有句级时间戳"))).toBe(true);

    const frameOnly = validateCitations(
      makeArticle({ sections: [{ id: "s1", title: "x", blocks: [{ text: "画面 [[f00]]" }] }] }),
      noTs,
    );
    expect(frameOnly).toEqual([]);
  });

  it("格式错误的引用被拒绝", () => {
    const problems = validateCitations(
      makeArticle({
        sections: [{ id: "s1", title: "x", blocks: [{ text: "错误引用 [[t1]] 与 [[fx]]" }] }],
      }),
      catalog,
    );
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((p) => p.message.includes("引用格式错误"))).toBe(true);
  });

  it("extractCitations 提取所有 token", () => {
    expect(extractCitations("a [[t01]] b [[f02]] c")).toEqual(["t01", "f02"]);
  });
});

describe("结构校验（纯函数）", () => {
  it("空章节 / 重复 id / 悬空导图被拒绝", () => {
    const problems = validateStructure({
      title: "x",
      sections: [
        { id: "s1", title: "a", blocks: [] },
        { id: "s1", title: "b", blocks: [{ text: "x" }] },
      ],
      mindMap: [{ label: "主题", children: [{ label: "指向不存在", sectionId: "s9" }] }],
      limitations: [],
    });
    const text = problems.map((p) => p.message).join(" | ");
    expect(text).toMatch(/没有内容块/);
    expect(text).toMatch(/重复/);
    expect(text).toMatch(/不存在的章节：s9/);
  });

  it("导图过深被拒绝", () => {
    const deep = { label: "a", children: [{ label: "b", children: [{ label: "c", children: [{ label: "d" }] }] }] };
    const problems = validateStructure(makeArticle({ mindMap: [deep] }));
    expect(problems.some((p) => p.message.includes("层"))).toBe(true);
  });
});

describe("模型输出解析容错（真实故障复现）", () => {
  it("围栏与前后说明文字", () => {
    const raw = '好的，结果如下：\n```json\n{"title":"标题","sections":[]}\n```\n希望有帮助。';
    expect(parseArticleJson(raw)).toEqual({ title: "标题", sections: [] });
  });

  it("输出被长度上限截断：补齐结构并丢弃残缺段落", () => {
    // 真实故障形态：最后一段正文中途被切断
    const raw = `\`\`\`json
{
  "id": "s4",
  "title": "生产实践",
  "blocks": [
    { "text": "第一段完整内容[[t01]]。" },
    { "text": "第二段写到一半就被截断`;
    const parsed = parseArticleJson(raw) as { id: string; title: string; blocks: Array<{ text: string }> };
    expect(parsed.id).toBe("s4");
    expect(parsed.title).toBe("生产实践");
    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.blocks[0].text).toContain("第一段完整内容");
  });

  it("截断在数组中间：保留已完成的元素", () => {
    const raw = '{"title":"t","sections":[{"id":"s1","title":"a","summary":"x"},{"id":"s2","title":"b"';
    const parsed = parseArticleJson(raw) as { sections: Array<{ id: string }> };
    expect(parsed.sections.length).toBeGreaterThanOrEqual(1);
    expect(parsed.sections[0].id).toBe("s1");
  });

  it("正文里未转义的英文双引号被转义，不破坏结构", () => {
    const raw = '{"text":"他说的"配置外置化"就是这个意思","id":"s1"}';
    const parsed = parseArticleJson(raw) as { text: string; id: string };
    expect(parsed.id).toBe("s1");
    expect(parsed.text).toContain("配置外置化");
  });

  it("尾随逗号被移除", () => {
    expect(parseArticleJson('{"a":1,"b":[1,2,],}')).toEqual({ a: 1, b: [1, 2] });
  });

  it("完全没有 JSON 对象时抛可读错误", () => {
    expect(() => parseArticleJson("抱歉，我无法完成这个请求。")).toThrow(/没有返回 JSON/);
  });

  it("合法输出保持原样（容错不改变正确结果）", () => {
    const raw = '{"title":"标题","sections":[{"id":"s1","title":"章","summary":"要"}]}';
    const body = looseJsonBody(raw);
    expect(JSON.parse(body)).toEqual(JSON.parse(raw));
  });
});

describe("引用标记规范化（真实故障）", () => {
  it("少一个右括号的 [[t01] 被补全", () => {
    expect(normalizeCitations("内容 [[t01][[t03] 结束")).toBe("内容 [[t01]][[t03]] 结束");
  });

  it("少一个左括号的 [t01]] 被补全", () => {
    expect(normalizeCitations("内容 [t01]] 结束")).toBe("内容 [[t01]] 结束");
  });

  it("全角括号【t01】被转成标准形式", () => {
    expect(normalizeCitations("内容【t01】结束")).toBe("内容[[t01]]结束");
  });

  it("单方括号 [t01] 被补成双方括号", () => {
    expect(normalizeCitations("内容 [t01] 结束")).toBe("内容 [[t01]] 结束");
  });

  it("已正确的引用保持原样（幂等）", () => {
    const good = "内容 [[t01]] 与 [[f02]] 结束";
    expect(normalizeCitations(good)).toBe(good);
    expect(normalizeCitations(normalizeCitations(good))).toBe(good);
  });

  it("规范化后再校验：缺括号的引用能通过", () => {
    const catalog = buildCatalog(TRANSCRIPT, MANIFEST);
    const article = makeArticle({
      sections: [{ id: "s1", title: "x", blocks: [{ text: "见 [[t01] 和 [[f00]" }] }],
    });
    const fixed = {
      ...article,
      sections: article.sections.map((s) => ({
        ...s,
        blocks: s.blocks.map((b) => ({ text: normalizeCitations(b.text) })),
      })),
    };
    expect(validateCitations(fixed, catalog)).toEqual([]);
  });
});

describe("两步生成（提纲 → 逐章）", () => {
  /** 假 LLM：第一次调用回提纲，之后每次回一章；记录每次 messages */
  function fakeLlm(overrides?: { outline?: unknown; section?: unknown }): LLMProvider & {
    calls: LLMMessage[][];
  } {
    const calls: LLMMessage[][] = [];
    return {
      calls,
      async generate(messages, onChunk) {
        calls.push(messages);
        if (calls.length === 1) {
          onChunk("提纲");
          return JSON.stringify(
            overrides?.outline ?? {
              title: "生成的标题",
              sections: [
                { id: "s1", title: "第一章", summary: "要点一" },
                { id: "s2", title: "第二章", summary: "要点二" },
              ],
              mindMap: [{ label: "主题" }],
            },
          );
        }
        onChunk("章节");
        return JSON.stringify(
          overrides?.section ?? {
            id: "s1",
            title: "第一章",
            blocks: [{ text: "内容引用 [[t01]]" }],
          },
        );
      },
    };
  }

  it("先提纲后逐章：两次章节调用，章节数与提纲一致，文章落库", async () => {
    const store = new ArticleStore(db);
    const llm = fakeLlm();
    const svc = new ArticleService({ store, llm });
    const stages: string[] = [];
    const catalog = buildCatalog(TRANSCRIPT, MANIFEST);

    const record = await svc.generate({
      taskId: "task-article-1",
      catalog,
      frameFiles: new Map(),
      detailLevel: "standard",
      onProgress: (e) => stages.push(e.stage),
    });

    expect(llm.calls).toHaveLength(3); // 1 提纲 + 2 章
    expect(stages).toEqual(["outline", "section", "section"]);
    expect(record.status).toBe("done");
    expect(record.content?.sections).toHaveLength(2);
    expect(record.content?.title).toBe("生成的标题");
    expect(store.listForTask("task-article-1")[0].id).toBe(record.id);

    // 提纲 prompt 里带转写目录编号
    const outlinePromptText = String(llm.calls[0][1].content);
    expect(outlinePromptText).toContain("[t01]");
    expect(outlinePromptText).toContain("0:00-0:10");
  });

  it("深度与关注点进入 prompt", async () => {
    const store = new ArticleStore(db);
    const llm = fakeLlm();
    const svc = new ArticleService({ store, llm });
    await svc.generate({
      taskId: "task-article-2",
      catalog: buildCatalog(TRANSCRIPT, MANIFEST),
      frameFiles: new Map(),
      detailLevel: "detailed",
      purpose: "重点讲清操作步骤",
    });
    const text = String(llm.calls[0][1].content);
    expect(text).toContain("深入");
    expect(text).toContain("重点讲清操作步骤");
  });

  it("模型输出非 JSON：文章标记 failed 并带错误", async () => {
    const store = new ArticleStore(db);
    const llm: LLMProvider = {
      async generate() {
        return "这不是 JSON";
      },
    };
    const svc = new ArticleService({ store, llm });
    await expect(
      svc.generate({
        taskId: "task-article-3",
        catalog: buildCatalog(TRANSCRIPT, MANIFEST),
        frameFiles: new Map(),
      }),
    ).rejects.toThrow(/JSON/);
    expect(store.listForTask("task-article-3")[0].status).toBe("failed");
  });

  it("有帧文件时章节调用带上图片 content 数组", async () => {
    const store = new ArticleStore(db);
    const llm = fakeLlm();
    const svc = new ArticleService({
      store,
      llm,
      readFrame: async () => "data:image/jpeg;base64,AAAA",
    });
    await svc.generate({
      taskId: "task-article-4",
      catalog: buildCatalog(TRANSCRIPT, MANIFEST),
      frameFiles: new Map([
        ["f00", "frames/f00.jpg"],
        ["f01", "frames/f01.jpg"],
      ]),
    });
    const sectionCall = llm.calls[1];
    const content = sectionCall[1].content;
    expect(Array.isArray(content)).toBe(true);
    const parts = content as Array<{ type: string }>;
    expect(parts[0].type).toBe("text");
    expect(parts.some((p) => p.type === "image_url")).toBe(true);
  });
});
