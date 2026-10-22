import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildCatalog,
  extractCitations,
  looseJsonBody,
  normalizeArticle,
  normalizeCitations,
  parseArticleJson,
  validateBlocks,
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
        blocks: [{ type: "paragraph", text: "开场提到 [[t01]]，画面见 [[f00]]。" }],
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
      makeArticle({ sections: [{ id: "s1", title: "x", blocks: [{ type: "paragraph", text: "见 [[t99]] 与 [[f42]]" }] }] }),
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
      makeArticle({ sections: [{ id: "s1", title: "x", blocks: [{ type: "paragraph", text: "画面 [[f00]]" }] }] }),
      noTs,
    );
    expect(frameOnly).toEqual([]);
  });

  it("格式错误的引用被拒绝", () => {
    const problems = validateCitations(
      makeArticle({
        sections: [{ id: "s1", title: "x", blocks: [{ type: "paragraph", text: "错误引用 [[t1]] 与 [[fx]]" }] }],
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
        { id: "s1", title: "b", blocks: [{ type: "paragraph", text: "x" }] },
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
      sections: [{ id: "s1", title: "x", blocks: [{ type: "paragraph", text: "见 [[t01] 和 [[f00]" }] }],
    });
    const fixed = normalizeArticle(article);
    expect(validateCitations(fixed, catalog)).toEqual([]);
  });
});


describe("结构化块兼容层", () => {
  const legacy = {
    title: "旧文章",
    sections: [
      {
        id: "s1",
        title: "第一章",
        blocks: [{ text: "开头 [[t01]]，画面 [[f00]] 与 [[f01]]，再来 [[f00]]。" }],
      },
    ],
    mindMap: [],
    limitations: [{ text: "这里不确定 [[t02]]" }],
  };

  it("旧 {text} 迁移为 paragraph，并把 [[fNN]] 抽成 figure 且全篇去重", () => {
    const article = normalizeArticle(legacy);
    expect(article.schemaVersion).toBe(2);
    expect(article.sections[0].blocks).toEqual([
      { type: "paragraph", text: "开头 [[t01]]，画面 与 ，再来 。" },
      { type: "figure", frameId: "f00" },
      { type: "figure", frameId: "f01" },
    ]);
  });

  it("归一化幂等", () => {
    const once = normalizeArticle(legacy);
    expect(normalizeArticle(once)).toEqual(once);
  });

  it("未知 type 有 text 降级为 paragraph，无 text 丢弃", () => {
    const article = normalizeArticle({
      title: "t",
      sections: [
        {
          id: "s1",
          title: "章",
          blocks: [
            { type: "weird", text: "降级内容" },
            { type: "note", foo: 1 },
            { text: "旧格式" },
          ],
        },
      ],
      mindMap: [],
      limitations: [],
    });
    expect(article.sections[0].blocks).toEqual([
      { type: "paragraph", text: "降级内容" },
      { type: "paragraph", text: "旧格式" },
    ]);
  });

  it("空章节补占位段落", () => {
    const article = normalizeArticle({ title: "t", sections: [{ id: "s1", title: "空", blocks: [] }] });
    expect(article.sections[0].blocks).toHaveLength(1);
    expect(article.sections[0].blocks[0]).toMatchObject({ type: "paragraph" });
  });

  it("结构化块原样保留，图注与表格字段不丢失", () => {
    const article = normalizeArticle({
      title: "t",
      sections: [
        {
          id: "s1",
          title: "章",
          blocks: [
            { type: "quote", text: "引用 [[t01]]" },
            { type: "list", ordered: true, items: ["甲 [[t02]]", "乙"] },
            { type: "code", lang: "bash", text: "echo hi" },
            { type: "table", header: ["列一", "列二"], rows: [["甲", "乙"]], caption: "表注" },
            { type: "figure", frameId: "f00", caption: "画面说明" },
          ],
        },
      ],
      mindMap: [],
      limitations: [],
    });
    expect(article.sections[0].blocks.map((b) => b.type)).toEqual([
      "quote",
      "list",
      "code",
      "table",
      "figure",
    ]);
  });
});

describe("块级校验", () => {
  const catalog = buildCatalog(TRANSCRIPT, MANIFEST);

  function sectionWith(blocks: Article["sections"][number]["blocks"]): Article {
    return { title: "t", sections: [{ id: "s1", title: "章", blocks }], mindMap: [], limitations: [] };
  }

  it("代码块不参与引用扫描", () => {
    const article = sectionWith([{ type: "code", text: "echo [[t99]]" }]);
    expect(validateCitations(article, catalog)).toEqual([]);
  });

  it("表格列数与行数超限被拒绝", () => {
    const article = sectionWith([
      {
        type: "table",
        header: ["一", "二", "三", "四", "五"],
        rows: [["1", "2"]],
      },
    ]);
    const messages = validateBlocks(article, catalog).map((p) => p.message).join(" | ");
    expect(messages).toMatch(/2-4 列/);
    expect(messages).toMatch(/不一致/);
  });

  it("同章重复帧与不存在的帧被拒绝", () => {
    const article = sectionWith([
      { type: "figure", frameId: "f00" },
      { type: "figure", frameId: "f00" },
      { type: "figure", frameId: "f42" },
    ]);
    const messages = validateBlocks(article, catalog).map((p) => p.message).join(" | ");
    expect(messages).toMatch(/重复引用/);
    expect(messages).toMatch(/f42 不存在/);
  });

  it("列表项数、段落字数与非段落块配额", () => {
    const article = sectionWith([
      { type: "paragraph", text: "长".repeat(801) },
      { type: "list", items: ["只有一项"] },
      { type: "quote", text: "A" },
      { type: "quote", text: "B" },
      { type: "code", text: "x" },
      { type: "figure", frameId: "f00" },
    ]);
    const messages = validateBlocks(article, catalog).map((p) => p.message).join(" | ");
    expect(messages).toMatch(/800/);
    expect(messages).toMatch(/2-6 项/);
    expect(messages).toMatch(/非段落块每章最多 3 个/);
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

  it("六类结构化块可解析落库，提示词声明块类型", async () => {
    const store = new ArticleStore(db);
    const calls: LLMMessage[][] = [];
    const sections = [
      {
        id: "s1",
        title: "第一章",
        blocks: [
          { type: "paragraph", text: "正文 [[t01]]" },
          { type: "quote", text: "原话 [[t02]]" },
          { type: "list", ordered: false, items: ["甲 [[t01]]", "乙"] },
        ],
      },
      {
        id: "s2",
        title: "第二章",
        blocks: [
          { type: "paragraph", text: "承接上文。" },
          { type: "code", lang: "bash", text: "echo [[t99]]" },
          { type: "table", header: ["列一", "列二"], rows: [["甲", "乙"]] },
          { type: "figure", frameId: "f00", caption: "真实画面" },
        ],
      },
    ];
    const llm: LLMProvider = {
      async generate(messages, onChunk) {
        calls.push(messages);
        if (calls.length === 1) {
          onChunk("提纲");
          return JSON.stringify({
            title: "结构化文章",
            sections: [
              { id: "s1", title: "第一章", summary: "要点一" },
              { id: "s2", title: "第二章", summary: "要点二" },
            ],
            mindMap: [{ label: "主题" }],
          });
        }
        onChunk("章节");
        return JSON.stringify(sections[calls.length - 2] ?? sections[0]);
      },
    };
    const svc = new ArticleService({ store, llm });
    const record = await svc.generate({
      taskId: "task-article-structured",
      catalog: buildCatalog(TRANSCRIPT, MANIFEST),
      frameFiles: new Map(),
    });

    const types = record.content?.sections.flatMap((s) => s.blocks.map((b) => b.type)) ?? [];
    expect(new Set(types)).toEqual(
      new Set(["paragraph", "quote", "list", "code", "table", "figure"]),
    );
    const outlinePromptText = String(calls[0][1].content);
    expect(outlinePromptText).toContain("只允许以下六种");
    expect(outlinePromptText).toContain("figure");
  });

  it("块字段不合规时重试，并在第二次提示中说明原因", async () => {
    const store = new ArticleStore(db);
    const calls: LLMMessage[][] = [];
    const llm: LLMProvider = {
      async generate(messages) {
        calls.push(messages);
        if (calls.length === 1) {
          return JSON.stringify({
            title: "重试文章",
            sections: [{ id: "s1", title: "第一章", summary: "要点" }],
            mindMap: [],
          });
        }
        if (calls.length === 2) {
          return JSON.stringify({
            id: "s1",
            title: "第一章",
            blocks: [{ type: "table", header: ["一", "二", "三", "四", "五"], rows: [] }],
          });
        }
        return JSON.stringify({
          id: "s1",
          title: "第一章",
          blocks: [{ type: "paragraph", text: "修正后的正文 [[t01]]" }],
        });
      },
    };
    const svc = new ArticleService({ store, llm });
    const record = await svc.generate({
      taskId: "task-article-retry",
      catalog: buildCatalog(TRANSCRIPT, MANIFEST),
      frameFiles: new Map(),
    });

    expect(record.status).toBe("done");
    expect(calls).toHaveLength(3);
    const retryPrompt = String(calls[2][2]?.content);
    expect(retryPrompt).toContain("块字段不合规");
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
