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
