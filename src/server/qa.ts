import { randomUUID } from "node:crypto";
import { normalizeCitations } from "./article";
import { citationRetryNote } from "@/lib/citations";
import type { Transcript, TranscriptSegment } from "./asr";
import type { Article } from "./article";
import type { Db } from "./db";
import { bind, rows as many } from "./sql";
import type { LLMProvider } from "./generations";
import { elapsedMs, errorFields, logError, logInfo, logWarn } from "./log";

/** 回答中的时间引用（点击联动播放器） */
export interface QaCitation {
  /** 转写段在全文中的序号（0 起） */
  segmentIndex: number;
  start: number;
  end: number;
  quote: string;
}

/** 引用编号（tNN）→ 段落下标 */
export function citationIndex(token: string): number | null {
  const match = /^t(\d{2,})$/.exec(token);
  return match ? Number(match[1]) - 1 : null;
}

export interface QaAnswer {
  text: string;
  citations: QaCitation[];
  limitations: string[];
}

export interface QaMessage {
  id: string;
  taskId: string;
  role: "user" | "assistant";
  content: string;
  citations: QaCitation[] | null;
  limitations: string[] | null;
  createdAt: string;
}

interface QaRow {
  id: string;
  task_id: string;
  role: string;
  content: string;
  citations: string | null;
  limitations: string | null;
  created_at: string;
}

function toMessage(row: QaRow): QaMessage {
  return {
    id: row.id,
    taskId: row.task_id,
    role: row.role as QaMessage["role"],
    content: row.content,
    citations: row.citations ? (JSON.parse(row.citations) as QaCitation[]) : null,
    limitations: row.limitations ? (JSON.parse(row.limitations) as string[]) : null,
    createdAt: row.created_at,
  };
}

export class QaStore {
  constructor(private readonly db: Db) {}

  add(input: {
    taskId: string;
    role: QaMessage["role"];
    content: string;
    citations?: QaCitation[] | null;
    limitations?: string[] | null;
  }): QaMessage {
    const message: QaMessage = {
      id: randomUUID(),
      taskId: input.taskId,
      role: input.role,
      content: input.content,
      citations: input.citations ?? null,
      limitations: input.limitations ?? null,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO qa_messages (id, task_id, role, content, citations, limitations, created_at)
         VALUES (@id, @taskId, @role, @content, @citations, @limitations, @createdAt)`,
      )
      .run(
        bind({
          ...message,
          citations: message.citations ? JSON.stringify(message.citations) : null,
          limitations: message.limitations ? JSON.stringify(message.limitations) : null,
        }),
      );
    return message;
  }

  listForTask(taskId: string): QaMessage[] {
    const rows = many<QaRow>(
      this.db
        .prepare("SELECT * FROM qa_messages WHERE task_id = ? ORDER BY created_at ASC, rowid ASC")
        .all(taskId),
    );
    return rows.map(toMessage);
  }

  removeAllForTask(taskId: string): void {
    this.db.prepare("DELETE FROM qa_messages WHERE task_id = ?").run(taskId);
  }
}

// ---------------------------------------------------------------------------
// 选段 / 选帧锚点（09 号票 P1/P2）
// ---------------------------------------------------------------------------

/** 追问锚点：文章选段、文稿选段或单帧画面 */
export type QaContext =
  | { kind: "section"; sectionId: string; blockIndex: number; quote: string }
  | { kind: "transcript"; segmentIndex: number; quote: string }
  | { kind: "frame"; frameId: string };

export const QA_QUOTE_MAX = 200;

export class QaContextError extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
  }
}

/** quote 核对：不要求逐字全等，容忍选区截断（前缀或包含） */
function quoteMatches(quote: string, source: string): boolean {
  const q = quote.trim();
  if (!q || q.length > QA_QUOTE_MAX) return false;
  return source.includes(q) || q.startsWith(source.trim()) || source.trim().startsWith(q);
}

export interface QaContextSource {
  article: Article | null;
  transcript: Transcript;
  /** 全部可用帧 id（来自 frames.json 白名单） */
  frameIds: Set<string>;
}

/**
 * 服务端校验锚点：白名单外直接拒绝（422），
 * 错误信息带 field 供前端定位（对齐 15 号 strict 词汇表）。
 */
export function validateQaContext(
  context: QaContext,
  source: QaContextSource,
): void {
  switch (context.kind) {
    case "section": {
      if (!Number.isInteger(context.blockIndex) || context.blockIndex < 0) {
        throw new QaContextError("锚点块序号非法", "context.blockIndex");
      }
      const section = source.article?.sections.find((s) => s.id === context.sectionId);
      const block = section?.blocks[context.blockIndex];
      if (!section || !block) {
        throw new QaContextError("锚点章节或块不存在", "context.sectionId");
      }
      const text = blockTextOf(block);
      if (!quoteMatches(context.quote, text)) {
        throw new QaContextError("选段与文章内容不符", "context.quote");
      }
      return;
    }
    case "transcript": {
      const segment = source.transcript.segments[context.segmentIndex];
      if (!segment) {
        throw new QaContextError("锚点转写段不存在", "context.segmentIndex");
      }
      if (!quoteMatches(context.quote, segment.text)) {
        throw new QaContextError("选段与转写内容不符", "context.quote");
      }
      return;
    }
    case "frame": {
      if (!source.frameIds.has(context.frameId)) {
        throw new QaContextError("锚点画面不存在", "context.frameId");
      }
      return;
    }
  }
}

function blockTextOf(block: Article["sections"][number]["blocks"][number]): string {
  switch (block.type) {
    case "paragraph":
    case "quote":
    case "code":
      return block.text;
    case "list":
      return block.items.join("\n");
    case "table":
      return [block.caption ?? "", ...block.header, ...block.rows.flat()].join("\n");
    case "figure":
      return block.caption ?? "";
  }
}

/** 锚点 chip 用：选段前 18 字或帧时间点展示文案 */
export function qaContextSummary(context: QaContext): string {
  if (context.kind === "frame") return context.frameId;
  return context.quote.slice(0, 18);
}

// ---------------------------------------------------------------------------
// 词法检索（不引入向量：SQLite 无原生支持，vid-lens 现状同样是词法）
// ---------------------------------------------------------------------------

/** 简单中文友好的分词：按非文字字符切分，再取 2 字滑窗（中文无空格） */
export function tokenize(text: string): string[] {
  const normalized = text.toLowerCase();
  const chunks = normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const tokens: string[] = [];
  for (const chunk of chunks) {
    if (/[\u4e00-\u9fff]/.test(chunk)) {
      if (chunk.length === 1) tokens.push(chunk);
      for (let i = 0; i < chunk.length - 1; i++) tokens.push(chunk.slice(i, i + 2));
    } else {
      tokens.push(chunk);
    }
  }
  return Array.from(new Set(tokens));
}

export interface RetrievedSegment {
  index: number;
  segment: TranscriptSegment;
  score: number;
}

/** 短转写（段数少或总字数少）直接全量送入上下文，避免检索漏召回 */
const FULL_CONTEXT_MAX_SEGMENTS = 60;
const FULL_CONTEXT_MAX_CHARS = 4000;

export function shouldSendFullTranscript(segments: TranscriptSegment[]): boolean {
  if (segments.length <= FULL_CONTEXT_MAX_SEGMENTS) return true;
  return segments.reduce((n, s) => n + s.text.length, 0) <= FULL_CONTEXT_MAX_CHARS;
}

/**
 * 全片抽样：词法检索无命中（典型：中文提问 + 英文转写稿）时的兜底，
 * 均匀取若干段，让模型仍能看到全片脉络而不是凭空回答。
 */
export function sampleAcross(
  segments: TranscriptSegment[],
  count = 24,
): RetrievedSegment[] {
  if (segments.length <= count) {
    return segments.map((segment, index) => ({ index, segment, score: 0 }));
  }
  const step = segments.length / count;
  const picked: RetrievedSegment[] = [];
  for (let i = 0; i < count; i++) {
    const index = Math.min(segments.length - 1, Math.floor(i * step));
    if (picked.length === 0 || picked[picked.length - 1].index !== index) {
      picked.push({ index, segment: segments[index], score: 0 });
    }
  }
  return picked;
}

/**
 * 相关段落检索：词法命中计分（完整词 > 单字），
 * 返回按分数排序的候选，并附带相邻段（保留上下文）。
 */
export function retrieveSegments(
  segments: TranscriptSegment[],
  query: string,
  limit = 8,
): RetrievedSegment[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];
  const scored: RetrievedSegment[] = segments.map((segment, index) => {
    const text = segment.text.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (text.includes(token)) score += token.length;
    }
    return { index, segment, score };
  });

  const hits = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit);

  // 补邻居段（前后各一），去重后按时间排序
  const picked = new Map<number, RetrievedSegment>();
  for (const hit of hits) {
    for (const idx of [hit.index - 1, hit.index, hit.index + 1]) {
      if (idx >= 0 && idx < segments.length && !picked.has(idx)) {
        const found = scored[idx];
        picked.set(idx, { ...found, score: idx === hit.index ? found.score : Math.max(0, found.score) });
      }
    }
  }
  return Array.from(picked.values()).sort((a, b) => a.index - b.index);
}

// ---------------------------------------------------------------------------
// 问答服务
// ---------------------------------------------------------------------------

const QA_SYSTEM =
  "你是视频内容助手。只依据提供的转写段落回答；每个关键结论后用 [[tNN]] 标注来源编号（编号来自给定目录）。" +
  "不确定或转写稿没有覆盖的内容，写进 limitations 而不是猜测。不使用表情符号，输出严格 JSON。";

export interface QaServiceOptions {
  store: QaStore;
  llm: LLMProvider;
}

export interface AskInput {
  taskId: string;
  /** 请求级关联 id（来自 proxy 注入的 x-request-id） */
  traceId?: string;
  transcript: Transcript;
  question: string;
  /** 选段 / 选帧锚点（已在路由层校验过） */
  context?: QaContext;
  /** frame 锚点的单帧 dataURL（路由层读文件，服务保持无 IO） */
  contextImage?: string | null;
  onDelta?: (delta: string) => void;
}

export class QaService {
  constructor(private readonly opts: QaServiceOptions) {}

  async ask(input: AskInput): Promise<{ message: QaMessage; answer: QaAnswer }> {
    const question = input.question.trim();
    if (!question) throw new Error("问题不能为空");

    const startedAt = Date.now();
    this.opts.store.add({ taskId: input.taskId, role: "user", content: question });

    const ctx = input.context ?? null;
    const frameId = ctx?.kind === "frame" ? ctx.frameId : null;
    // grounded 铁律：选帧追问的回答必须引用该帧，无法确认就明说
    const frameToken = frameId ? `[[${frameId}]]` : null;

    // 选段 / 选帧的注入前缀：告诉模型用户盯的是哪一段
    let anchorNote = "";
    if (ctx?.kind === "section" || ctx?.kind === "transcript") {
      const origin =
        ctx.kind === "section"
          ? "文章选段"
          : `${formatTime(input.transcript.segments[ctx.segmentIndex]?.start ?? 0)}`;
      anchorNote = `用户选中了这段：\n> ${ctx.quote}\n（出自 ${origin}），请针对这段回答。\n\n`;
    }

    // 取材策略：短稿全给；长稿先检索，检索空手则全片抽样（跨语言提问的兜底）
    const all = input.transcript.segments;
    const full = shouldSendFullTranscript(all);
    const hits = full ? [] : retrieveSegments(all, question);
    const candidates = full
      ? all.map((segment, index) => ({ index, segment, score: 0 }))
      : hits.length > 0
        ? hits
        : sampleAcross(all);
    const sampled = !full && hits.length === 0 && candidates.length > 0;
    logInfo("qa retrieval ready", {
      task_id: input.taskId,
      trace_id: input.traceId,
      mode: full ? "full" : hits.length > 0 ? "retrieval" : "sample",
      total_segments: all.length,
      candidates: candidates.length,
      question_chars: question.length,
    });
    const context = candidates
      .map((c) => `[t${String(c.index + 1).padStart(2, "0")}] ${formatTime(c.segment.start)}-${formatTime(c.segment.end)} ${c.segment.text}`)
      .join("\n");

    const knownExample =
      input.transcript.segments.length > 0
        ? `[[t01]]…[[t${String(input.transcript.segments.length).padStart(2, "0")}]]`
        : "（转写稿为空，正文不要写引用标记）";

    // 一次问答最多两次调用：出现非法编号时重问一次（15 号票 C1/C5），
    // 仍非法则降级交付（移除编号 + limitations 声明），绝不交付假证据。
    // 选帧追问另有 grounded 预算（轮级 2 次）：回答缺 [[fNN]] 时重问一次，仍缺则整轮失败。
    const runOnce = async (extraNote: string, emitDelta: boolean): Promise<{
      normalized: string;
      parsedLimitations: string[];
      valid: QaCitation[];
      invalidTokens: string[];
      raw: string;
    }> => {
      const frameRequirement = frameToken
        ? `\n\n硬性要求：回答必须引用 [[${frameId}]]（用户选中的画面编号）；无法从画面确认的内容就写"无法确认"，不要编造。`
        : "";
      const userText =
        anchorNote +
        [
          `问题：${question}`,
          "",
          candidates.length === 0
            ? "（转写稿为空，只能说明无法回答）"
            : sampled
              ? "（未检索到直接相关段落，以下是全片均匀抽样，请据此判断能否回答）"
              : full
                ? "完整转写稿："
                : "相关转写段落：",
          context,
          "",
          "只输出 JSON：",
          '{"answer":"回答正文，含 [[tNN]] 引用","limitations":["未确认之处"]}',
          extraNote,
          frameRequirement,
        ].join("\n");
      // 单帧注入：照 articles.ts 的多模态 content 写法
      const userMessage = input.contextImage
        ? {
            role: "user" as const,
            content: [
              { type: "text" as const, text: userText },
              { type: "image_url" as const, image_url: { url: input.contextImage } },
            ],
          }
        : { role: "user" as const, content: userText };
      let raw: string;
      try {
        raw = await this.opts.llm.generate(
          [
            { role: "system", content: QA_SYSTEM },
            userMessage,
          ],
          (delta) => emitDelta && input.onDelta?.(delta),
          { operation: "qa.answer", taskId: input.taskId, traceId: input.traceId },
        );
      } catch (err) {
        logError("qa answer failed", {
          task_id: input.taskId,
          trace_id: input.traceId,
          ...errorFields(err),
          duration_ms: elapsedMs(startedAt),
        });
        throw err;
      }
      const parsed = parseAnswer(raw);
      // 引用格式先规范化（模型常少写方括号），再校验编号白名单
      const normalized = normalizeCitations(parsed.answer);
      const valid: QaCitation[] = [];
      const invalidTokens: string[] = [];
      for (const token of Array.from(normalized.matchAll(/\[\[(t\d{2,})\]\]/g), (m) => m[1])) {
        const index = citationIndex(token);
        if (index === null || index < 0 || index >= input.transcript.segments.length) {
          invalidTokens.push(token);
          continue;
        }
        const segment = input.transcript.segments[index];
        if (!valid.some((c) => c.segmentIndex === index)) {
          valid.push({
            segmentIndex: index,
            start: segment.start,
            end: segment.end,
            quote: segment.text,
          });
        }
      }
      return { normalized, parsedLimitations: parsed.limitations, valid, invalidTokens, raw };
    };

    let attempt = await runOnce("", true);
    if (attempt.invalidTokens.length > 0) {
      logWarn("qa invalid citations, retrying once", {
        task_id: input.taskId,
        trace_id: input.traceId,
        invalid: attempt.invalidTokens.length,
      });
      const retried = await runOnce(citationRetryNote(attempt.invalidTokens, knownExample), false);
      if (retried.invalidTokens.length === 0) attempt = retried;
    }

    // 选帧 grounded 铁律（P2）：回答必须引用选中帧的 [[fNN]]。
    // 缺失时重问一次；两次都缺失则整轮失败，绝不交付无证据的回答。
    if (frameToken && !attempt.normalized.includes(frameToken)) {
      logWarn("qa frame citation missing, retrying once", {
        task_id: input.taskId,
        trace_id: input.traceId,
        frame: frameId,
      });
      const retried = await runOnce(
        `上一次回答没有引用 [[${frameId}]]。请重新回答，正文必须包含 [[${frameId}]]；如果画面无法支持结论，就在 limitations 里说明无法确认。`,
        false,
      );
      if (retried.normalized.includes(frameToken)) {
        attempt = retried;
      } else {
        throw new QaContextError(
          `回答未能引用选中画面 ${frameId}，已按证据要求中止本轮`,
          "context.frame",
        );
      }
    }

    // 降级交付：仍有非法编号 → 保留回答但移除编号 + 声明（lenient）
    let text = attempt.normalized;
    for (const token of attempt.invalidTokens) {
      text = text.split(`[[${token}]]`).join("");
    }
    const limitations = [...attempt.parsedLimitations];
    if (attempt.invalidTokens.length > 0) {
      limitations.push(`已移除 ${attempt.invalidTokens.length} 个无法核实的出处编号`);
    }

    const message = this.opts.store.add({
      taskId: input.taskId,
      role: "assistant",
      content: text,
      citations: attempt.valid,
      limitations,
    });
    logInfo("qa answer completed", {
      task_id: input.taskId,
      trace_id: input.traceId,
      message_id: message.id,
      citations: attempt.valid.length,
      invalid_citations: attempt.invalidTokens.length,
      limitations: limitations.length,
      chars: text.length,
      duration_ms: elapsedMs(startedAt),
    });
    return { message, answer: { text, citations: attempt.valid, limitations } };
  }
}

function parseAnswer(raw: string): { answer: string; limitations: string[] } {
  const trimmed = raw.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) {
    // 模型没给 JSON：整段当回答，附一条限制说明
    return { answer: trimmed, limitations: ["模型未按结构化格式返回，出处可能不完整"] };
  }
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as {
      answer?: unknown;
      limitations?: unknown;
    };
    return {
      answer: String(parsed.answer ?? "").trim(),
      limitations: Array.isArray(parsed.limitations)
        ? parsed.limitations.map((l) => String(l)).filter(Boolean)
        : [],
    };
  } catch {
    return { answer: trimmed, limitations: ["模型返回的结构无法解析，出处可能不完整"] };
  }
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
