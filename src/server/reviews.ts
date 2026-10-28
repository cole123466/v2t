import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { Db } from "./db";
import { bind, row as one, rows as many } from "./sql";
import type { Transcript } from "./asr";
import type { LLMProvider } from "./generations";
import { elapsedMs, errorFields, logError, logInfo } from "./log";
import { blockText, looseJsonBody, type Article } from "./article";
import { taskDir, transcriptPath } from "./paths";

/**
 * 10 号票（decision-review-quality）：手动审稿。
 *
 * 语义边界：审稿 ≠ 语义核对。审稿只产出「意见」，禁止通过/拒绝措辞；
 * 正文一字节不改——审核失败时文章保持 done 不变（铁律）。
 * 状态词汇表与 jobs 一致；R1 手动语义：重启打断后不自动重跑。
 */

export type ReviewStatus = "queued" | "running" | "completed" | "failed" | "canceled";

export interface ReviewFinding {
  sectionId: string;
  problem: string;
  suggestion: string;
}

export interface ArticleReview {
  id: string;
  taskId: string;
  articleId: string;
  jobId: string;
  status: ReviewStatus;
  model: string | null;
  summary: string | null;
  findings: ReviewFinding[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ReviewRow {
  id: string;
  task_id: string;
  article_id: string;
  job_id: string;
  status: string;
  model: string | null;
  summary: string | null;
  findings: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

function toRecord(row: ReviewRow): ArticleReview {
  let findings: ReviewFinding[] = [];
  if (row.findings) {
    try {
      const parsed: unknown = JSON.parse(row.findings);
      if (Array.isArray(parsed)) {
        findings = parsed
          .filter((f): f is Record<string, unknown> => Boolean(f) && typeof f === "object")
          .map((f) => ({
            sectionId: String(f.sectionId ?? ""),
            problem: String(f.problem ?? ""),
            suggestion: String(f.suggestion ?? ""),
          }));
      }
    } catch {
      findings = [];
    }
  }
  return {
    id: row.id,
    taskId: row.task_id,
    articleId: row.article_id,
    jobId: row.job_id,
    status: row.status as ReviewStatus,
    model: row.model,
    summary: row.summary,
    findings,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ReviewStore {
  constructor(private readonly db: Db) {}

  create(input: { taskId: string; articleId: string; jobId: string; model: string | null }): ArticleReview {
    const now = new Date().toISOString();
    const record: ArticleReview = {
      id: randomUUID(),
      taskId: input.taskId,
      articleId: input.articleId,
      jobId: input.jobId,
      status: "queued",
      model: input.model,
      summary: null,
      findings: [],
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO article_reviews (id, task_id, article_id, job_id, status, model, summary, findings, error, created_at, updated_at)
         VALUES (@id, @taskId, @articleId, @jobId, @status, @model, @summary, @findings, @error, @createdAt, @updatedAt)`,
      )
      .run(
        bind({
          ...record,
          findings: JSON.stringify(record.findings),
        }),
      );
    return record;
  }

  get(id: string): ArticleReview | undefined {
    const row = one<ReviewRow>(this.db.prepare("SELECT * FROM article_reviews WHERE id = ?").get(id));
    return row ? toRecord(row) : undefined;
  }

  /** worker 按 job 领单：review.job_id 即 job.id */
  getByJob(jobId: string): ArticleReview | undefined {
    const row = one<ReviewRow>(this.db.prepare("SELECT * FROM article_reviews WHERE job_id = ?").get(jobId));
    return row ? toRecord(row) : undefined;
  }

  /** 新→旧 */
  listForArticle(articleId: string): ArticleReview[] {
    const rows = many<ReviewRow>(
      this.db
        .prepare("SELECT * FROM article_reviews WHERE article_id = ? ORDER BY created_at DESC, rowid DESC")
        .all(articleId),
    );
    return rows.map(toRecord);
  }

  /** 同篇未终态审核（并发保护用） */
  activeForArticle(articleId: string): ArticleReview | undefined {
    const row = one<ReviewRow>(
      this.db
        .prepare(
          "SELECT * FROM article_reviews WHERE article_id = ? AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1",
        )
        .get(articleId),
    );
    return row ? toRecord(row) : undefined;
  }

  update(
    id: string,
    patch: Partial<{
      status: ReviewStatus;
      model: string | null;
      summary: string | null;
      findings: ReviewFinding[];
      error: string | null;
    }>,
  ): void {
    const sets: string[] = ["updated_at = @updatedAt"];
    const params: Record<string, string | null> = { id, updatedAt: new Date().toISOString() };
    if ("status" in patch) {
      sets.push("status = @status");
      params.status = patch.status ?? null;
    }
    if ("model" in patch) {
      sets.push("model = @model");
      params.model = patch.model ?? null;
    }
    if ("summary" in patch) {
      sets.push("summary = @summary");
      params.summary = patch.summary ?? null;
    }
    if ("findings" in patch) {
      sets.push("findings = @findings");
      params.findings = JSON.stringify(patch.findings ?? []);
    }
    if ("error" in patch) {
      sets.push("error = @error");
      params.error = patch.error ?? null;
    }
    this.db.prepare(`UPDATE article_reviews SET ${sets.join(", ")} WHERE id = @id`).run(bind(params));
  }

  removeAllForTask(taskId: string): void {
    this.db.prepare("DELETE FROM article_reviews WHERE task_id = ?").run(taskId);
  }
}

// ---------------------------------------------------------------------------
// 审稿执行：单次 LLM 调用，输出清洗后落库
// ---------------------------------------------------------------------------

const REVIEW_SYSTEM =
  "你是资深中文编辑，负责给一篇依据视频转写稿整理成的图文文章提修改意见。" +
  "你给的是意见，不是裁决：不要使用「通过/不通过/合格/不合格」这类措辞，只描述问题与建议。" +
  "只依据给定的文章正文与转写原文对照，不引入文章之外的事实。" +
  "findings 的 section_id 必须取自文章给定的章节 id，不得自造。不使用表情符号，输出严格 JSON。";

const MAX_FINDINGS = 8;
const MAX_FINDING_CHARS = 1200;
const MAX_SUMMARY_CHARS = 1200;

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/** 文章全文（含引用编号）+ 转写原文对照表（纯文本，R4：不用视觉模型） */
function reviewUserPrompt(article: Article, transcriptText: string): string {
  const body = article.sections
    .map((s) => {
      const text = s.blocks.map((b) => blockText(b)).join("\n");
      return `[章节 id=${s.id}] ${s.title}\n${text}`;
    })
    .join("\n\n");
  return [
    `文章标题：${article.title}`,
    "",
    "正文（保留 [[tNN]] 等引用编号）：",
    body,
    "",
    "被引用的转写段原文对照表：",
    transcriptText || "（本任务没有可用转写段）",
    "",
    "请审阅这篇文章的整体写作质量（结构、表达、与原文的一致性）。",
    "只输出 JSON：",
    '{"summary":"不超过1200字的总评","findings":[{"section_id":"s1","problem":"问题描述","suggestion":"修改建议"}]}',
    `findings 最多 ${MAX_FINDINGS} 条，每条不超过 ${MAX_FINDING_CHARS} 字；没有问题就给空数组。`,
  ].join("\n");
}

/**
 * 输出清洗：section_id 必须在文章里存在，非法条目丢弃（展示性数据，
 * 不值得整次审核失败重问）；条数与字数超限截断（照参考工程 I14）。
 */
export function sanitizeFindings(
  raw: unknown,
  sectionIds: ReadonlySet<string>,
): ReviewFinding[] {
  if (!Array.isArray(raw)) return [];
  const out: ReviewFinding[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const f = item as Record<string, unknown>;
    const sectionId = String(f.section_id ?? f.sectionId ?? "").trim();
    if (!sectionIds.has(sectionId)) continue;
    out.push({
      sectionId,
      problem: truncate(String(f.problem ?? "").trim(), MAX_FINDING_CHARS),
      suggestion: truncate(String(f.suggestion ?? "").trim(), MAX_FINDING_CHARS),
    });
    if (out.length >= MAX_FINDINGS) break;
  }
  return out;
}

export interface RunReviewInput {
  taskId: string;
  traceId?: string;
  article: Article;
  /** 转写段原文对照表（[tNN] 时间 原文） */
  transcriptText: string;
  signal?: AbortSignal;
  onModel?: (model: string) => void;
}

/** 审稿核心：一次调用 + 清洗，返回待落库的结果（不碰文章） */
export async function reviewArticle(
  llm: LLMProvider,
  input: RunReviewInput,
): Promise<{ summary: string; findings: ReviewFinding[] }> {
  const sectionIds = new Set(input.article.sections.map((s) => s.id));
  const raw = await llm.generate(
    [
      { role: "system", content: REVIEW_SYSTEM },
      { role: "user", content: reviewUserPrompt(input.article, input.transcriptText) },
    ],
    () => {},
    { operation: "article.review", taskId: input.taskId, traceId: input.traceId, signal: input.signal },
  );
  const parsed = JSON.parse(looseJsonBody(raw)) as { summary?: unknown; findings?: unknown };
  const summary = truncate(String(parsed.summary ?? "").trim(), MAX_SUMMARY_CHARS);
  const findings = sanitizeFindings(parsed.findings, sectionIds);
  if (!summary && findings.length === 0) {
    throw new Error("审稿输出为空");
  }
  return { summary, findings };
}

// ---------------------------------------------------------------------------
// worker 执行体：kind='review' 的 job → review 行状态机
// ---------------------------------------------------------------------------

export interface ReviewJobDeps {
  reviews: ReviewStore;
  llm: LLMProvider;
  dataDir: string;
  /** 动态取 ArticleStore：避免与 articles.ts 的模块级循环依赖 */
  articleContent: (articleId: string) => Promise<Article | null>;
}

/**
 * 审稿 job 执行体（10 号票）。与 runArticleJob 同构：自行读转录稿与文章，
 * 单次 LLM 调用，结果写回 review 行；文章正文一字节不改。
 */
export async function runReviewJob(
  deps: ReviewJobDeps,
  job: { id: string; taskId: string; articleId: string | null },
  signal: AbortSignal,
  emit: (event: "step" | "done" | "error", data: unknown) => void,
): Promise<void> {
  const taskId = job.taskId;
  const articleId = job.articleId;
  const review = deps.reviews.getByJob(job.id);
  if (!articleId || !review) {
    if (review) {
      deps.reviews.update(review.id, { status: "failed", error: "job 缺少 article_id 或审核记录" });
    }
    emit("error", { message: "审核记录缺失" });
    return;
  }
  const startedAt = Date.now();
  try {
    const dir = taskDir(deps.dataDir, taskId);
    const transcript = JSON.parse(await readFile(transcriptPath(dir), "utf8")) as Transcript;
    const article = await deps.articleContent(articleId);
    if (!article) throw new Error("文章内容缺失，无法审核");
    deps.reviews.update(review.id, { status: "running" });
    emit("step", { reviewId: review.id, status: "running" });
    const result = await reviewArticle(deps.llm, {
      taskId,
      article,
      transcriptText: transcriptTextTable(transcript),
      signal,
    });
    deps.reviews.update(review.id, {
      status: "completed",
      summary: result.summary,
      findings: result.findings,
      error: null,
    });
    logInfo("article review completed", {
      task_id: taskId,
      review_id: review.id,
      article_id: articleId,
      findings: result.findings.length,
      duration_ms: elapsedMs(startedAt),
    });
    emit("done", { reviewId: review.id, articleId });
  } catch (err) {
    // fs 类错误的 message 含 data/ 绝对路径，不下发客户端；完整错误只进日志
    const code = typeof (err as { code?: unknown }).code === "string" ? (err as { code: string }).code : null;
    const message = code ? `任务文件读取失败（${code}）` : err instanceof Error ? err.message : String(err);
    const aborted = signal.aborted;
    // 文章永远不因审核失败而变化；重启打断折为 failed，不自动重跑（R1 手动语义）
    deps.reviews.update(review.id, {
      status: "failed",
      error: aborted ? "服务重启导致审核中断" : message,
    });
    logError("article review failed", {
      task_id: taskId,
      review_id: review.id,
      article_id: articleId,
      ...errorFields(err),
      duration_ms: elapsedMs(startedAt),
    });
    emit("error", { reviewId: review.id, message: aborted ? "服务重启导致审核中断" : message });
  }
}

/** 转写段原文对照表（[tNN] 时间 原文），审稿输入的引用核对材料 */
export function transcriptTextTable(transcript: Transcript): string {
  const fmt = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  };
  return transcript.segments
    .map((seg, i) => `[t${String(i + 1).padStart(2, "0")}] ${fmt(seg.start)}-${fmt(seg.end)} ${seg.text}`)
    .join("\n");
}
