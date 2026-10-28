import { randomUUID } from "node:crypto";
import { getLlmConfig } from "./config";
import type { Db } from "./db";
import { bind, row as one, rows as many } from "./sql";
import type { ActivityStore } from "./activities";
import { checkCitations, citationRetryNote, knownCitationIds } from "@/lib/citations";
import type { LLMMessage, LLMProvider } from "./generations";
import { elapsedMs, errorFields, logError, logInfo, logWarn } from "./log";
import {
  blockText,
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
import {
  annotateUnsupported,
  collectVerifyPairs,
  parseVerifyResults,
  unverifiedLimitation,
  verifyPrompt,
  type VerifyPair,
  type VerifyResult,
} from "@/lib/semantic";

export type ArticleDetailLevel = "concise" | "standard" | "detailed";

/** 合法的深度取值（导入页与文章接口共用校验） */
export const DETAIL_LEVELS: ArticleDetailLevel[] = ["concise", "standard", "detailed"];

/**
 * 归一化导入时选定的文章选项（深度 + 关注点），落库到 tasks 的默认两列。
 * 非法深度或超长关注点返回 error；关注点空白归一为 null。
 */
export function normalizeArticleOptions(input: {
  detailLevel?: unknown;
  purpose?: unknown;
}): { detailLevel: ArticleDetailLevel; purpose: string | null } | { error: string } {
  const detailLevel = (input.detailLevel ?? "standard") as ArticleDetailLevel;
  if (!DETAIL_LEVELS.includes(detailLevel)) {
    return { error: "detailLevel 需为 concise / standard / detailed" };
  }
  const purpose = typeof input.purpose === "string" ? input.purpose.trim() : "";
  if (purpose.length > 500) {
    return { error: "关注点不能超过 500 字" };
  }
  return { detailLevel, purpose: purpose || null };
}

export interface ArticleRecord {
  id: string;
  taskId: string;
  status: "streaming" | "done" | "failed" | "interrupted";
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
      model: string;
      error: string | null;
    }>,
  ): void {
    const sets: string[] = [];
    const params: Record<string, string | null> = { id };
    for (const key of ["status", "title", "model", "error"] as const) {
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
  /** 步骤记录（07 号票：进度真实、刷新可见） */
  activities?: ActivityStore;
}

export interface GenerateArticleInput {
  taskId: string;
  /** 请求级关联 id（来自 proxy 注入的 x-request-id） */
  traceId?: string;
  catalog: CitationCatalog;
  /** 帧目录相对路径 → 帧 id，用于挑选发给模型的图片 */
  frameFiles: Map<string, string>;
  detailLevel?: ArticleDetailLevel;
  purpose?: string | null;
  onProgress?: (event: { stage: string; message?: string }) => void;
  onDelta?: (delta: string) => void;
  /** 中止信号：08 号票后仅来自 worker（stop/cancel），不再接 HTTP 请求 */
  signal?: AbortSignal;
}

/** 08 号票：worker 执行入口的输入。runId 即 jobId（命名修正：执行就是 job） */
export interface RunForJobInput {
  taskId: string;
  traceId?: string;
  catalog: CitationCatalog;
  frameFiles: Map<string, string>;
  /** 目标文章行（创建时即确定） */
  articleId: string;
  /** run/job id：步骤都挂在这个 id 下 */
  runId: string;
  /** resume 输入：旧 job 的提纲 + 已存章节（跳过不重生成） */
  resume?: { outline: ArticleDraftOutline; existingSections: ArticleSection[] };
  signal?: AbortSignal;
  onProgress?: (event: { stage: string; message?: string }) => void;
  onDelta?: (delta: string) => void;
  hooks?: {
    onOutline?: (outline: ArticleDraftOutline) => void;
    onSectionDone?: (done: number, total: number) => void;
    onPhase?: (phase: string) => void;
    onSectionVerified?: (index: number, message: string) => void;
  };
}

interface PipelineInput {
  taskId: string;
  traceId?: string;
  catalog: CitationCatalog;
  frameFiles: Map<string, string>;
  detail: ArticleDetailLevel;
  purpose: string | null;
  record: ArticleRecord;
  runId: string | null;
  signal?: AbortSignal;
  resume?: { outline: ArticleDraftOutline; existingSections: ArticleSection[] };
  /** resume 的降级交付：发布前校验失败不阻塞，文章置 done + error 摘要 */
  downgradeOnValidateFail?: boolean;
  onProgress?: (event: { stage: string; message?: string }) => void;
  onDelta?: (delta: string) => void;
  hooks?: RunForJobInput["hooks"];
}

export class ArticleService {
  constructor(private readonly opts: ArticleServiceOptions) {}

  /** 同步生成（保留给测试与旧调用方；生产路径走 runForJob） */
  async generate(input: GenerateArticleInput): Promise<ArticleRecord> {
    const detail = input.detailLevel ?? "standard";
    const purpose = input.purpose?.trim() || null;
    const record = this.opts.store.create({
      taskId: input.taskId,
      detailLevel: detail,
      purpose,
      model: getLlmConfig().model,
    });
    const runId = this.opts.activities?.newRunId() ?? null;
    return this.runPipeline({
      taskId: input.taskId,
      traceId: input.traceId,
      catalog: input.catalog,
      frameFiles: input.frameFiles,
      detail,
      purpose,
      record,
      runId,
      signal: input.signal,
      onProgress: input.onProgress,
      onDelta: input.onDelta,
    });
  }

  /**
   * 08 号票：后台执行入口。文章行已存在（创建时即建），本方法负责提纲/章节/发布；
   * resume 时跳过已存章节，只补齐缺失部分。
   */
  async runForJob(input: RunForJobInput): Promise<ArticleRecord> {
    const record = this.opts.store.get(input.articleId);
    if (!record) throw new Error("文章记录不存在");
    return this.runPipeline({
      taskId: input.taskId,
      traceId: input.traceId,
      catalog: input.catalog,
      frameFiles: input.frameFiles,
      detail: record.detailLevel,
      purpose: record.purpose,
      record,
      runId: input.runId,
      signal: input.signal,
      resume: input.resume,
      downgradeOnValidateFail: Boolean(input.resume),
      onProgress: input.onProgress,
      onDelta: input.onDelta,
      hooks: input.hooks,
    });
  }

  private async runPipeline(input: PipelineInput): Promise<ArticleRecord> {
    const detail = input.detail;
    const purpose = input.purpose;
    const record = input.record;
    const startedAt = Date.now();
    logInfo("article generation started", {
      task_id: input.taskId,
      trace_id: input.traceId,
      article_id: record.id,
      detail,
      has_purpose: purpose !== null,
      resume: Boolean(input.resume),
      frames: input.catalog.frames.length,
      segments: input.catalog.transcripts.length,
    });

    // 一篇文章可能同时用到文本模型（提纲）与视觉模型（带画面的章节），
    // 按实际调用去重记录，避免整篇都被记成默认文本模型
    const usedModels: string[] = [];
    const onModel = (model: string) => {
      if (usedModels.includes(model)) return;
      usedModels.push(model);
      const used = usedModels.join(" + ");
      record.model = used;
      this.opts.store.update(record.id, { model: used });
    };

    const runId = input.runId;
    const sectionStepIds: string[] = [];
    const steps = this.opts.activities;
    let outlineStep = null as ReturnType<NonNullable<typeof steps>["start"]> | null;
    if (!input.resume) {
      outlineStep =
        steps?.start({
          taskId: input.taskId,
          kind: "stage",
          runId,
          phase: "outline",
          title: "生成提纲",
          articleId: record.id,
        }) ?? null;
    }
    input.onProgress?.({ stage: "outline" });

    try {
      // 第一步：提纲（resume 时直接复用）
      let outline: ArticleDraftOutline;
      if (input.resume) {
        outline = input.resume.outline;
        input.hooks?.onOutline?.(outline);
      } else {
        const outlineAt = Date.now();
        const outlineRaw = await this.opts.llm.generate(
          [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: outlinePrompt(input.catalog, detail, purpose) },
          ],
          () => {},
          {
            operation: "article.outline",
            taskId: input.taskId,
            traceId: input.traceId,
            signal: input.signal,
            onModel,
          },
        );
        outline = this.parseOutline(outlineRaw);
        this.opts.store.update(record.id, { outline, title: outline.title });
        steps?.finish(outlineStep!.id, {
          ok: true,
          status: "completed",
          message: `${outline.sections.length} 章`,
        });
        input.hooks?.onOutline?.(outline);
        logInfo("article outline ready", {
          task_id: input.taskId,
          trace_id: input.traceId,
          article_id: record.id,
          sections: outline.sections.length,
          duration_ms: elapsedMs(outlineAt),
        });
      }

      // 计划即步骤集合：预插入 N 条 queued 章节步骤（D4：不落库计划快照）
      const planAt = new Date().toISOString();
      sectionStepIds.length = 0;
      if (steps) {
        for (let s = 0; s < outline.sections.length; s++) {
          const step = steps.start({
            taskId: input.taskId,
            kind: "section",
            runId,
            phase: "write",
            title: `第 ${s + 1} 章 · ${outline.sections[s].title}`,
            status: "queued",
            articleId: record.id,
            startedAt: planAt,
          });
          sectionStepIds.push(step.id);
        }
      }

      // 引用白名单：一次构造、多处复用（15 号票 C2/C3）
      const knownCitations = knownCitationIds(
        input.catalog.allowTimeCitations ? input.catalog.transcripts.map((t) => t.id) : [],
        input.catalog.frames.map((f) => f.id),
      );
      const knownExample =
        input.catalog.transcripts.length > 0
          ? `[[t01]]…[[t${String(input.catalog.transcripts.length).padStart(2, "0")}]]` +
            (input.catalog.frames.length > 0
              ? ` 与 [[f00]]…[[f${String(input.catalog.frames.length - 1).padStart(2, "0")}]]`
              : "")
          : "（本任务没有可用编号，正文不要写引用标记）";

      // 第二步：逐章生成（每章一次调用，带该章相关画面）；resume 跳过已存章节
      const existing = new Map((input.resume?.existingSections ?? []).map((s) => [s.id, s]));
      const sections = [] as Article["sections"];
      // 语义核对产生的未支持条目（C6）：随最终 limitations 一起落库
      const verifyLimitations: Article["limitations"] = [];
      let doneCount = 0;
      for (let i = 0; i < outline.sections.length; i++) {
        if (input.signal?.aborted) throw new Error("生成已中止");
        const section = outline.sections[i];
        const sectionStepId = sectionStepIds[i];
        const kept = existing.get(section.id);
        if (kept) {
          // 已存章节不重新生成、不重新校验（避免旧内容因规则变化而卡死）
          sections.push(kept);
          doneCount += 1;
          steps?.updateStatus(sectionStepId, "completed", "已保存，跳过");
          input.hooks?.onSectionDone?.(doneCount, outline.sections.length);
          continue;
        }
        steps?.updateStatus(sectionStepId, "running");
        input.onProgress?.({
          stage: "section",
          message: `${i + 1}/${outline.sections.length} ${section.title}`,
        });
        input.hooks?.onPhase?.("write");
        const sectionAt = Date.now();
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
                : blockProblems.some((p) => p.includes("引用") && p.includes("不存在"))
                  ? citationRetryNote(
                      blockProblems
                        .map((p) => /引用 (t\d+|f\d+) 不存在/.exec(p)?.[1])
                        .filter((x): x is string => Boolean(x)),
                      knownExample,
                    ) + "请只输出 JSON。"
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
          const raw = await this.opts.llm.generate(messages, (delta) => input.onDelta?.(delta), {
            operation: "article.section",
            taskId: input.taskId,
            traceId: input.traceId,
            signal: input.signal,
            onModel,
          });
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
            // 15 号票 C1：章内引用白名单校验（strict），与块校验共用同一 attempt<2 预算
            const sectionText = normalized.sections[0].blocks.map((b) => blockText(b)).join(" ");
            const citationCheck = checkCitations(sectionText, knownCitations);
            const citationProblems = citationCheck.invalid.map((t) => `时间/画面引用 ${t} 不存在`);
            const allProblems = [...issues.map((p) => p.message), ...citationProblems];
            if (allProblems.length > 0) {
              blockProblems = allProblems.slice(0, 5);
              lastError = null;
              parsed = null;
              logWarn("article section retry", {
                task_id: input.taskId,
                trace_id: input.traceId,
                article_id: record.id,
                section: section.id,
                attempt: attempt + 1,
                reason: citationProblems.length > 0 ? "invalid_citations" : "invalid_blocks",
                problems: blockProblems.length,
              });
              continue;
            }
            parsedBlocks = normalized.sections[0].blocks;
          } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
            blockProblems = [];
            parsed = null;
            logWarn("article section retry", {
              task_id: input.taskId,
              trace_id: input.traceId,
              article_id: record.id,
              section: section.id,
              attempt: attempt + 1,
              reason: "invalid_json",
            });
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
        doneCount += 1;
        // 章节增量落库：content 与步骤 completed 必须相邻落库（同一同步块内），
        // 保证「步骤 completed ⇒ 内容已可读」（07 号票验收 2/3 的前提）
        this.opts.store.update(record.id, {
          content: normalizeArticle({
            title: outline.title,
            sections: [...sections],
            mindMap: outline.mindMap,
            limitations: [],
          }),
          status: "streaming",
        });
        steps?.updateStatus(sectionStepId, "completed");
        input.hooks?.onSectionDone?.(doneCount, outline.sections.length);
        logInfo("article section ready", {
          task_id: input.taskId,
          trace_id: input.traceId,
          article_id: record.id,
          section: section.id,
          index: i + 1,
          total: outline.sections.length,
          blocks: parsedBlocks.length,
          images: images.length,
          duration_ms: elapsedMs(sectionAt),
        });

        // ---- 15 号票后半（C4/C6/C7）：语义核对 ----
        // 定位：质量增强，不是发布门禁。核对环节任何失败（LLM 报错、输出不合规）
        // 都只记 failed 步骤，绝不让章节或文章失败——不能因核对丢内容。
        const verifyAt = Date.now();
        const verifyStep =
          steps?.start({
            taskId: input.taskId,
            kind: "verify",
            runId,
            phase: "write",
            title: `核对第 ${i + 1} 章引用`,
            articleId: record.id,
          }) ?? null;
        let verifyNote = "本章没有需要核对的引用";
        try {
          const outcome = await this.verifySection({
            blocks: parsedBlocks,
            catalog: input.catalog,
            signal: input.signal,
            onModel,
            // 重写该章一次（C6）：让模型改写论断或换更贴切的引用
            onUnsupported: async (failed) => {
              const rewriteNote =
                `第 ${failed.map((r) => r.index + 1).join("、")} 处引用未能支持论断，` +
                "请改写论断或换用更贴切的引用编号；只输出 JSON（与之前相同的章节结构）。";
              const raw = await this.opts.llm.generate(
                [
                  { role: "system", content: prompt.system },
                  { role: "user", content: prompt.user },
                  { role: "user", content: rewriteNote },
                ],
                () => {},
                {
                  operation: "article.verify-rewrite",
                  taskId: input.taskId,
                  traceId: input.traceId,
                  signal: input.signal,
                  onModel,
                },
              );
              const rewritten = JSON.parse(looseJsonBody(raw)) as { blocks?: unknown[] };
              const normalized = normalizeArticle({
                title: outline.title,
                sections: [
                  {
                    id: section.id,
                    title: parsed!.title?.trim() || section.title,
                    blocks: rewritten.blocks ?? [],
                  },
                ],
                mindMap: [],
                limitations: [],
              });
              // 重写没有产出可用正文（缺 blocks 字段 / 空数组）时按核对失败处理，
              // 调用方 catch 后保留原章节——绝不让重写把整章清空
              if (normalized.sections[0].blocks.length === 0) {
                throw new Error("重写结果没有正文内容");
              }
              return normalized.sections[0].blocks;
            },
          });
          if (outcome.unsupported.length > 0) {
            // 重写仍不过 → 保留正文，内联标注 + limitations（C6 底线：绝不丢内容）
            const marked = annotateUnsupported(
              outcome.blocks,
              outcome.unsupported.map((u) => u.token),
            );
            sections[sections.length - 1] = {
              id: section.id,
              title: parsed.title?.trim() || section.title,
              blocks: marked.blocks,
            };
            verifyLimitations.push(
              ...outcome.unsupported.map((u): Article["limitations"][number] => ({
                text: unverifiedLimitation(i + 1, u.claim),
              })),
            );
            verifyNote = `已保留正文并标注：${outcome.note}`;
          } else if (outcome.blocks !== parsedBlocks) {
            // 重写通过 → 用重写后的正文替换原章节
            sections[sections.length - 1] = {
              id: section.id,
              title: parsed.title?.trim() || section.title,
              blocks: outcome.blocks,
            };
            verifyNote = outcome.note;
          } else {
            verifyNote = outcome.note;
          }
          steps?.finish(verifyStep!.id, { ok: true, status: "completed", message: verifyNote });
        } catch (err) {
          // 核对本身失败不中止整篇（质量增强非门禁），步骤记 failed
          steps?.finish(verifyStep!.id, {
            ok: false,
            status: "failed",
            message: err instanceof Error ? err.message.slice(0, 200) : "核对失败",
          });
          logWarn("article section verify failed; continuing", {
            task_id: input.taskId,
            trace_id: input.traceId,
            article_id: record.id,
            section: section.id,
            ...errorFields(err),
            duration_ms: elapsedMs(verifyAt),
          });
          verifyNote = "核对未完成（不影响文章）";
        }
        input.hooks?.onSectionVerified?.(i + 1, verifyNote);
        logInfo("article section verified", {
          task_id: input.taskId,
          trace_id: input.traceId,
          article_id: record.id,
          section: section.id,
          message: verifyNote,
          duration_ms: elapsedMs(verifyAt),
        });
      }

      const article = normalizeArticle({
        title: outline.title,
        sections,
        mindMap: outline.mindMap,
        limitations: verifyLimitations,
      });
      input.hooks?.onPhase?.("validate");
      const validateStep = steps?.start({
        taskId: input.taskId,
        kind: "stage",
        runId,
        phase: "validate",
        title: "校验引用与结构",
        articleId: record.id,
      });
      const problems = [
        ...validateStructure(article),
        ...validateBlocks(article, input.catalog),
        ...validateCitations(article, input.catalog),
      ];
      if (problems.length > 0) {
        const msg = `文章校验未通过：${problems
          .slice(0, 8)
          .map((p) => p.message)
          .join("；")}`;
        if (input.downgradeOnValidateFail) {
          // resume 降级交付：已存章节不重校，失败只记录不阻塞（08 号票）
          steps?.finish(validateStep!.id, { ok: false, status: "failed", message: msg.slice(0, 200) });
          const publishStep = steps?.start({
            taskId: input.taskId,
            kind: "stage",
            runId,
            phase: "publish",
            title: "发布文章",
            articleId: record.id,
          });
          this.opts.store.update(record.id, {
            content: article,
            status: "done",
            title: article.title,
            error: `部分引用未通过校验：${problems.slice(0, 3).map((p) => p.message).join("；")}`,
          });
          steps?.finish(publishStep!.id, { ok: true, status: "completed" });
          return { ...record, outline, content: article, status: "done", title: article.title };
        }
        steps?.finish(validateStep!.id, { ok: false, status: "failed", message: msg.slice(0, 200) });
        throw new Error(msg);
      }
      steps?.finish(validateStep!.id, { ok: true, status: "completed" });
      input.hooks?.onPhase?.("publish");
      const publishStep = steps?.start({
        taskId: input.taskId,
        kind: "stage",
        runId,
        phase: "publish",
        title: "发布文章",
        articleId: record.id,
      });
      this.opts.store.update(record.id, { content: article, status: "done", title: article.title, error: null });
      steps?.finish(publishStep!.id, { ok: true, status: "completed" });
      logInfo("article generation completed", {
        task_id: input.taskId,
        trace_id: input.traceId,
        article_id: record.id,
        sections: article.sections.length,
        blocks: article.sections.reduce((sum, section) => sum + section.blocks.length, 0),
        duration_ms: elapsedMs(startedAt),
      });
      return { ...record, outline, content: article, status: "done", title: article.title };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 步骤终态回写：中止 → 当前步骤 canceled；其余失败 → failed
      const aborted = input.signal?.aborted === true || message.includes("已中止");
      const runningIds = steps ? this.runningStepIds(runId) : [];
      for (const sid of runningIds) {
        steps!.updateStatus(sid, aborted ? "canceled" : "failed", aborted ? "生成已中断" : message.slice(0, 200));
      }
      if (outlineStep && !steps?.get(outlineStep.id)?.endedAt) {
        steps?.finish(outlineStep.id, {
          ok: false,
          status: aborted ? "canceled" : "failed",
          message: aborted ? "生成已中断" : message.slice(0, 200),
        });
      }
      this.opts.store.update(record.id, {
        status: aborted ? "interrupted" : "failed",
        error: aborted ? "生成已中断，可继续生成" : message,
      });
      logError("article generation failed", {
        task_id: input.taskId,
        trace_id: input.traceId,
        article_id: record.id,
        ...errorFields(err),
        duration_ms: elapsedMs(startedAt),
      });
      throw err;
    }
  }

  /** 当前 run 里仍处于 running 的步骤 id（失败回写用） */
  private runningStepIds(runId: string | null): string[] {
    if (!runId || !this.opts.activities) return [];
    return this.opts.activities.runningIdsForRun(runId);
  }

  /**
   * 15 号票 C4：语义核对一章。整章所有「句子 ↔ 引用」成对列出，一次调用批量判定。
   * unsupported → 重写该章一次（C6）；重写仍不过 → 保留正文，返回未支持编号由调用方标注。
   * partial 视为通过，数量汇入步骤 message（限制说明候选池）。
   */
  private async verifySection(input: {
    blocks: ArticleSection["blocks"];
    catalog: CitationCatalog;
    signal?: AbortSignal;
    onModel: (model: string) => void;
    onUnsupported: (failed: VerifyResult[]) => Promise<ArticleSection["blocks"]>;
  }): Promise<{
    note: string;
    /** 未支持的「编号 ↔ 论断」对（基于重写后正文重新抽取，标注与 limitation 用） */
    unsupported: VerifyPair[];
    blocks: ArticleSection["blocks"];
  }> {
    const pairs = collectVerifyPairs({ blocks: input.blocks }, input.catalog);
    if (pairs.length === 0) {
      return { note: "本章没有需要核对的引用", unsupported: [], blocks: input.blocks };
    }
    const judge = async (currentBlocks: ArticleSection["blocks"]): Promise<VerifyResult[]> => {
      const currentPairs = collectVerifyPairs({ blocks: currentBlocks }, input.catalog);
      const raw = await this.opts.llm.generate(
        [
          {
            role: "system",
            content:
              "你是严谨的事实核对员。只依据给定的原文判断论断是否被直接支持，不引入外部知识。输出严格 JSON。",
          },
          { role: "user", content: verifyPrompt(currentPairs) },
        ],
        () => {},
        {
          operation: "article.verify",
          signal: input.signal,
          onModel: input.onModel,
        },
      );
      return parseVerifyResults(raw, currentPairs.length);
    };

    const results = await judge(input.blocks);
    const failed = results.filter((r) => r.verdict === "unsupported");
    if (failed.length === 0) {
      const partial = results.filter((r) => r.verdict === "partial");
      return {
        note:
          `${pairs.length} 处引用全部支持` +
          (partial.length > 0 ? `（${partial.length} 处为部分支持）` : ""),
        unsupported: [],
        blocks: input.blocks,
      };
    }

    // C6：重写该章一次
    const rewrittenBlocks = await input.onUnsupported(failed);
    // 未支持条目按重写后正文重新抽取：重写可能增删/替换引用编号，
    // 不能拿原始 pairs 的索引去映射，否则会标注错位
    const rewrittenPairs = collectVerifyPairs({ blocks: rewrittenBlocks }, input.catalog);
    // 重写把引用删光 = 留下无出处的断言，比标注更糟（票15底线）。
    // judge 对空配对恒判全绿（parseVerifyResults 按 count=0 返回空），
    // 会把无引用版本当重写通过整章替换——此处拒绝重写，退回原文按首轮 failed 标注
    if (rewrittenPairs.length === 0) {
      return {
        note: `${failed.length} 处未支持，重写删光了引用，已按原文标注`,
        unsupported: pairs.filter((_, idx) => failed.some((r) => r.index === idx)),
        blocks: input.blocks,
      };
    }
    const retryResults = await judge(rewrittenBlocks);
    const stillFailed = retryResults.filter((r) => r.verdict === "unsupported");
    if (stillFailed.length === 0) {
      const partial = retryResults.filter((r) => r.verdict === "partial");
      return {
        note: `${failed.length} 处未支持，已重写${partial.length > 0 ? `（${partial.length} 处为部分支持）` : ""}`,
        unsupported: [],
        blocks: rewrittenBlocks,
      };
    }
    return {
      note: `${stillFailed.length} 处未支持，已标注`,
      unsupported: rewrittenPairs.filter((_, idx) =>
        stillFailed.some((r) => r.index === idx),
      ),
      blocks: rewrittenBlocks,
    };
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
