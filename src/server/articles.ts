import { randomUUID } from "node:crypto";
import { getLlmConfig } from "./config";
import type { Db } from "./db";
import { bind, row as one, rows as many } from "./sql";
import type { LLMMessage, LLMProvider } from "./generations";
import {
  looseJsonBody,
  normalizeArticle,
  validateBlocks,
  validateCitations,
  validateStructure,
  type Article,
  type ArticleDraftOutline,
  type ArticleSection,
  type CitationCatalog,
} from "./article";

export type ArticleDetailLevel = "concise" | "standard" | "detailed";

export interface ArticleRecord {
  id: string;
  taskId: string;
  status: "streaming" | "done" | "failed";
  title: string | null;
  /** 完整文章 JSON（成功后才有） */
  content: Article | null;
  /** 提纲（成功后也有，便于回看） */
  outline: ArticleDraftOutline | null;
  detailLevel: ArticleDetailLevel;
  purpose: string | null;
  model: string;
  error: string | null;
  createdAt: string;
}

interface ArticleRow {
  id: string;
  task_id: string;
  status: string;
  title: string | null;
  content: string | null;
  outline: string | null;
  detail_level: string;
  purpose: string | null;
  model: string;
  error: string | null;
  created_at: string;
}

function toRecord(row: ArticleRow): ArticleRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    status: row.status as ArticleRecord["status"],
    title: row.title,
    content: row.content ? normalizeArticle(JSON.parse(row.content)) : null,
    outline: row.outline ? (JSON.parse(row.outline) as ArticleDraftOutline) : null,
    detailLevel: row.detail_level as ArticleDetailLevel,
    purpose: row.purpose,
    model: row.model,
    error: row.error,
    createdAt: row.created_at,
  };
}

export class ArticleStore {
  constructor(private readonly db: Db) {}

  create(input: {
    taskId: string;
    detailLevel: ArticleDetailLevel;
    purpose: string | null;
    model: string;
  }): ArticleRecord {
    const record: ArticleRecord = {
      id: randomUUID(),
      taskId: input.taskId,
      status: "streaming",
      title: null,
      content: null,
      outline: null,
      detailLevel: input.detailLevel,
      purpose: input.purpose,
      model: input.model,
      error: null,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO articles (id, task_id, status, title, content, outline, detail_level, purpose, model, error, created_at)
         VALUES (@id, @taskId, @status, @title, @content, @outline, @detailLevel, @purpose, @model, @error, @createdAt)`,
      )
      .run(
        bind({
          ...record,
          content: null,
          outline: null,
        }),
      );
    return record;
  }

  update(
    id: string,
    patch: Partial<{
      status: ArticleRecord["status"];
      title: string | null;
      content: Article | null;
      outline: ArticleDraftOutline | null;
      error: string | null;
    }>,
  ): void {
    const sets: string[] = [];
    const params: Record<string, string | null> = { id };
    for (const key of ["status", "title", "error"] as const) {
      if (key in patch) {
        sets.push(`${key} = @${key}`);
        params[key] = patch[key] ?? null;
      }
    }
    if ("content" in patch) {
      sets.push("content = @content");
      params.content = patch.content ? JSON.stringify(normalizeArticle(patch.content)) : null;
    }
    if ("outline" in patch) {
      sets.push("outline = @outline");
      params.outline = patch.outline ? JSON.stringify(patch.outline) : null;
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE articles SET ${sets.join(", ")} WHERE id = @id`).run(bind(params));
  }

  get(id: string): ArticleRecord | undefined {
    const row = one<ArticleRow>(this.db.prepare("SELECT * FROM articles WHERE id = ?").get(id));
    return row ? toRecord(row) : undefined;
  }

  listForTask(taskId: string): ArticleRecord[] {
    const rows = many<ArticleRow>(
      this.db
        .prepare("SELECT * FROM articles WHERE task_id = ? ORDER BY created_at DESC, rowid DESC")
        .all(taskId),
    );
    return rows.map(toRecord);
  }

  removeAllForTask(taskId: string): void {
    this.db.prepare("DELETE FROM articles WHERE task_id = ?").run(taskId);
  }
}

// ---------------------------------------------------------------------------
// 两步生成服务：提纲 → 逐章
// ---------------------------------------------------------------------------

const DETAIL_GUIDE: Record<ArticleDetailLevel, string> = {
  concise: "速览：每章 1-2 段，只保留核心论点与关键步骤，总字数控制在 800 字内。",
  standard: "标准：每章 2-4 段，讲清背景、要点与例子，信息完整但克制。",
  detailed: "深入：每章 3-6 段，展开推导、条件、易忽略的细节与对比，允许更长篇幅。",
};

const BLOCK_SPEC = [
  "正文块只允许以下六种（每章非段落块合计 ≤3，首块必须是 paragraph）：",
  '- paragraph：{"type":"paragraph","text":"正文"}，每段 ≤800 字',
  '- quote：{"type":"quote","text":"原文引用"}，仅用于转写稿里的原话',
  '- list：{"type":"list","ordered":false,"items":["要点一","要点二"]}，2-6 项',
  '- code：{"type":"code","lang":"bash","text":"命令或代码"}，≤40 行',
  '- table：{"type":"table","header":["列一","列二"],"rows":[["甲","乙"]]}，2-4 列、≤8 行',
  '- figure：{"type":"figure","frameId":"f01","caption":"画面说明"}，同一帧全篇只用一次',
  "行内可用 **粗体**、*斜体*、`代码`、[文案](https://example.com) 与 [[tNN]] 时间引用；",
  "画面一律用 figure 块，不要在段落里写 [[fNN]]；不要输出 HTML 或 Markdown 图片。",
].join("\n");

const SYSTEM_PROMPT =
  "你是资深中文编辑，负责把视频内容整理成可独立阅读的图文文章。" +
  "只依据提供的转写文本与画面写作用，不编造视频里没有的事实；不确定的地方写进 limitations。" +
  "所有时间与画面出处必须使用给定的引用编号（[[tNN]] 指转写段，[[fNN]] 指画面帧），不得自造编号。" +
  "不使用表情符号，输出严格 JSON。";

function transcriptCatalogText(catalog: CitationCatalog): string {
  return catalog.transcripts
    .map((t) => `[${t.id}] ${formatTime(t.start)}-${formatTime(t.end)} ${t.text}`)
    .join("\n");
}

function frameCatalogText(catalog: CitationCatalog): string {
  if (catalog.frames.length === 0) return "（本任务没有可用画面帧，禁止使用 [[fNN]] 引用）";
  return catalog.frames.map((f) => `[${f.id}] ${formatTime(f.tSec)}`).join("\n");
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function outlinePrompt(catalog: CitationCatalog, detail: ArticleDetailLevel, purpose: string | null): string {
  return [
    `请为下面的视频设计一篇图文文章的提纲。${DETAIL_GUIDE[detail]}`,
    purpose ? `本次关注点：${purpose}` : "",
    "",
    "转写目录：",
    transcriptCatalogText(catalog),
    "",
    "画面目录：",
    frameCatalogText(catalog),
    "",
    BLOCK_SPEC,
    "",
    "只输出 JSON，结构如下：",
    '{"title":"文章标题","sections":[{"id":"s1","title":"章节标题","summary":"本章要点"}],"mindMap":[{"label":"主题","children":[{"label":"子题","sectionId":"s1"}]}]}',
  ]
    .filter(Boolean)
    .join("\n");
}

function sectionPrompt(
  catalog: CitationCatalog,
  outline: ArticleDraftOutline,
  section: ArticleDraftOutline["sections"][number],
  detail: ArticleDetailLevel,
  purpose: string | null,
  frameImages: Array<{ id: string; dataUrl: string }>,
): { system: string; user: string } {
  const user = [
    `文章标题：${outline.title}`,
    `全文提纲：${outline.sections.map((s) => `${s.id} ${s.title}（${s.summary}）`).join("；")}`,
    `现在只写这一章：${section.id} 《${section.title}》——${section.summary}`,
    DETAIL_GUIDE[detail],
    purpose ? `本次关注点：${purpose}` : "",
    "",
    "转写目录（可在正文中用 [[tNN]] 引用）：",
    transcriptCatalogText(catalog),
    "",
    "可用画面（可在正文中用 [[fNN]] 引用，并在引用前用一句话描述画面内容）：",
    frameImages.length > 0
      ? frameImages.map((f) => `[${f.id}]`).join(" ")
      : frameCatalogText(catalog),
    "",
    BLOCK_SPEC,
    "只输出 JSON：",
    '{"id":"本章 id","title":"章节标题","blocks":[{"type":"paragraph","text":"段落正文，含 [[tNN]] 引用"},{"type":"figure","frameId":"f01","caption":"画面说明"}]}',
  ]
    .filter(Boolean)
    .join("\n");
  return { system: SYSTEM_PROMPT, user };
}

export interface ArticleServiceOptions {
  store: ArticleStore;
  llm: LLMProvider;
  /** 读取帧图片为 data url；缺省表示不发送图片 */
  readFrame?: (file: string) => Promise<string | null>;
}

export interface GenerateArticleInput {
  taskId: string;
  catalog: CitationCatalog;
  /** 帧目录相对路径 → 帧 id，用于挑选发给模型的图片 */
  frameFiles: Map<string, string>;
  detailLevel?: ArticleDetailLevel;
  purpose?: string | null;
  onProgress?: (event: { stage: string; message?: string }) => void;
  onDelta?: (delta: string) => void;
}

export class ArticleService {
  constructor(private readonly opts: ArticleServiceOptions) {}

  async generate(input: GenerateArticleInput): Promise<ArticleRecord> {
    const detail = input.detailLevel ?? "standard";
    const purpose = input.purpose?.trim() || null;
    const record = this.opts.store.create({
      taskId: input.taskId,
      detailLevel: detail,
      purpose,
      model: getLlmConfig().model,
    });

    try {
      // 第一步：提纲
      input.onProgress?.({ stage: "outline" });
      const outlineRaw = await this.opts.llm.generate(
        [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: outlinePrompt(input.catalog, detail, purpose) },
        ],
        () => {},
      );
      const outline = this.parseOutline(outlineRaw);
      this.opts.store.update(record.id, { outline, title: outline.title });

      // 第二步：逐章生成（每章一次调用，带该章相关画面）
      const sections = [] as Article["sections"];
      for (let i = 0; i < outline.sections.length; i++) {
        const section = outline.sections[i];
        input.onProgress?.({
          stage: "section",
          message: `${i + 1}/${outline.sections.length} ${section.title}`,
        });
        const images = await this.pickSectionFrames(
          i,
          outline.sections.length,
          input.catalog,
          input.frameFiles,
        );
        const prompt = sectionPrompt(input.catalog, outline, section, detail, purpose, images);
        const content: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [
          { type: "text", text: prompt.user },
        ];
        for (const img of images) {
          content.push({ type: "image_url", image_url: { url: img.dataUrl } });
        }

        // 章节 JSON 偶有结构缺陷（截断、未转义引号）：解析失败时重问一次并要求更短
        interface SectionPayload {
          id?: string;
          title?: string;
          blocks?: unknown[];
        }
        let parsed: SectionPayload | null = null;
        let parsedBlocks: ArticleSection["blocks"] | null = null;
        let lastError: Error | null = null;
        let blockProblems: string[] = [];
        for (let attempt = 0; attempt < 2 && !parsedBlocks; attempt++) {
          const retryNote =
            attempt === 0
              ? ""
              : lastError
                ? "上一次输出不是合法的 JSON。请只输出一个 JSON 对象，不要任何解释、不要 Markdown 围栏；" +
                  "正文里不要出现英文双引号（改用中文引号「」），总长度控制在 1200 字以内。"
                : `上一次输出的块字段不合规：${blockProblems.join("；")}。` +
                  "请严格按上面的块类型与配额输出，只输出 JSON。";
          const messages: LLMMessage[] =
            attempt === 0
              ? [
                  { role: "system", content: prompt.system },
                  { role: "user", content },
                ]
              : [
                  { role: "system", content: prompt.system },
                  { role: "user", content },
                  { role: "user", content: retryNote },
                ];
          const raw = await this.opts.llm.generate(messages, (delta) => input.onDelta?.(delta));
          try {
            parsed = JSON.parse(looseJsonBody(raw)) as SectionPayload;
            const normalized = normalizeArticle({
              title: outline.title,
              sections: [
                {
                  id: section.id,
                  title: parsed.title?.trim() || section.title,
                  blocks: parsed.blocks ?? [],
                },
              ],
              mindMap: [],
              limitations: [],
            });
            const issues = validateBlocks(normalized, input.catalog);
            if (issues.length > 0) {
              blockProblems = issues.slice(0, 5).map((p) => p.message);
              lastError = null;
              parsed = null;
              continue;
            }
            parsedBlocks = normalized.sections[0].blocks;
          } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
            blockProblems = [];
            parsed = null;
          }
        }
        if (!parsedBlocks || !parsed) {
          throw new Error(
            `第 ${i + 1} 章《${section.title}》生成结果不合规（${lastError?.message ?? (blockProblems.join("；") || "未知原因")}），已重试一次仍失败，请重新生成`,
          );
        }
        sections.push({
          id: section.id,
          title: parsed.title?.trim() || section.title,
          blocks: parsedBlocks,
        });
      }

      const article = normalizeArticle({
        title: outline.title,
        sections,
        mindMap: outline.mindMap,
        limitations: [],
      });
      const problems = [
        ...validateStructure(article),
        ...validateBlocks(article, input.catalog),
        ...validateCitations(article, input.catalog),
      ];
      if (problems.length > 0) {
        throw new Error(
          `文章校验未通过：${problems
            .slice(0, 8)
            .map((p) => p.message)
            .join("；")}`,
        );
      }
      this.opts.store.update(record.id, { content: article, status: "done", title: article.title });
      return { ...record, outline, content: article, status: "done", title: article.title };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.opts.store.update(record.id, { status: "failed", error: message });
      throw err;
    }
  }

  /** 校验失败的成品也保留记录并抛出可读错误（由调用方决定是否重试） */
  private parseOutline(raw: string): ArticleDraftOutline {
    const parsed = JSON.parse(looseJsonBody(raw)) as Partial<ArticleDraftOutline>;
    if (!parsed.title?.trim() || !Array.isArray(parsed.sections) || parsed.sections.length === 0) {
      throw new Error("提纲缺少标题或章节");
    }
    return {
      title: parsed.title.trim(),
      sections: parsed.sections.map((s, i) => ({
        id: String(s.id ?? `s${i + 1}`),
        title: String(s.title ?? `第 ${i + 1} 章`),
        summary: String(s.summary ?? ""),
      })),
      mindMap: Array.isArray(parsed.mindMap) ? parsed.mindMap : [],
    };
  }

  /**
   * 每章挑最多 4 张画面：把全景帧按章节数均分，各章取自己那一段，
   * 既保证每章都有画面可用，又避免每章都发全量图片。
   */
  private async pickSectionFrames(
    sectionIndex: number,
    sectionCount: number,
    catalog: CitationCatalog,
    frameFiles: Map<string, string>,
  ): Promise<Array<{ id: string; dataUrl: string }>> {
    if (!this.opts.readFrame || catalog.frames.length === 0) return [];
    const limit = 4;
    const total = catalog.frames.length;
    const perSection = Math.max(1, Math.floor(total / Math.max(1, sectionCount)));
    const start = sectionIndex * perSection;
    const chosen = catalog.frames.slice(start, Math.min(total, start + perSection)).slice(0, limit);
    const pool = chosen.length > 0 ? chosen : catalog.frames.slice(0, limit);

    const images: Array<{ id: string; dataUrl: string }> = [];
    for (const frame of pool) {
      const file = frameFiles.get(frame.id);
      if (!file) continue;
      const dataUrl = await this.opts.readFrame(file);
      if (dataUrl) images.push({ id: frame.id, dataUrl });
    }
    return images;
  }
}
