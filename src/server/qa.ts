import { randomUUID } from "node:crypto";
import { normalizeCitations } from "./article";
import { citationRetryNote } from "@/lib/citations";
import type { Transcript, TranscriptSegment } from "./asr";
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

/**
 * 09 号票 P3：追问锚点。服务端校验白名单外的形状直接拒绝（422）。
 * quote 与目标块文本做「前缀+包含」核对，容忍选区截断，不要求逐字全等。
 */
export type QaContext =
  | { kind: "section"; sectionId: string; blockIndex: number; quote: string }
  | { kind: "transcript"; segmentIndex: number; quote: string }
  | { kind: "frame"; frameId: string };

export const MAX_QUOTE_CHARS = 200;

/** 锚点校验失败的原因，路由层转 422（field 对齐 15 号 strict 词汇表） */
export class QaContextError extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
  }
}

type SectionLookup = (sectionId: string) => { blocks: ReadonlyArray<unknown> } | null;
type FrameLookup = (frameId: string) => { id: string; tSec: number } | null;

/**
 * 锚点白名单校验（对齐 15 号 strict 词汇表）：
 * - quote ≤ 200 字，与目标块文本做前缀/包含核对（容忍选区截断）
 * - frame 锚点必须在帧目录内
 */
export function validateQaContext(
  context: QaContext,
  lookups: { section: SectionLookup; frame: FrameLookup; segmentCount: number },
): void {
  if (!context || typeof context !== "object") {
    throw new QaContextError("锚点格式不合法", "context");
  }
  if (context.kind === "section") {
    if (
      typeof context.sectionId !== "string" ||
      !Number.isInteger(context.blockIndex) ||
      context.blockIndex < 0 ||
      typeof context.quote !== "string" ||
      context.quote.length === 0
    ) {
      throw new QaContextError("锚点格式不合法", "context");
    }
    if (context.quote.length > MAX_QUOTE_CHARS) {
      throw new QaContextError(`选段不能超过 ${MAX_QUOTE_CHARS} 字`, "context.quote");
    }
    const section = lookups.section(context.sectionId);
    const block = section?.blocks[context.blockIndex] as { text?: unknown } | undefined;
    const text = typeof block?.text === "string" ? block.text : null;
    if (!text) throw new QaContextError("选段锚点指向不存在的块", "context");
    if (!text.startsWith(context.quote) && !text.includes(context.quote)) {
      throw new QaContextError("选段内容与文章不符", "context.quote");
    }
    return;
  }
  if (context.kind === "transcript") {
    if (
      !Number.isInteger(context.segmentIndex) ||
      context.segmentIndex < 0 ||
      context.segmentIndex >= lookups.segmentCount ||
      typeof context.quote !== "string" ||
      context.quote.length === 0
    ) {
      throw new QaContextError("文稿锚点格式不合法", "context");
    }
    if (context.quote.length > MAX_QUOTE_CHARS) {
      throw new QaContextError(`选段不能超过 ${MAX_QUOTE_CHARS} 字`, "context.quote");
    }
    return;
  }
  if (context.kind === "frame") {
    if (typeof context.frameId !== "string" || !lookups.frame(context.frameId)) {
      throw new QaContextError("画面锚点指向不存在的帧", "context");
    }
    return;
  }
  throw new QaContextError("锚点格式不合法", "context");
}

/** assistant 行的状态机：streaming → completed | canceled | failed */
export type QaTurnStatus = "streaming" | "completed" | "canceled" | "failed";

export interface QaMessage {
  id: string;
  taskId: string;
  role: "user" | "assistant";
  content: string;
  citations: QaCitation[] | null;
  limitations: string[] | null;
  createdAt: string;
  /** 同一轮的 user 行与 assistant 行共享；老数据 NULL，读投影按相邻对合成 */
  turnId: string | null;
  /** 仅 assistant 行：streaming|completed|canceled|failed */
  status: QaTurnStatus | null;
  /** 提问锚点（落在 user 行上） */
  context: QaContext | null;
  /** 仅 assistant 行失败时 */
  error: string | null;
}

interface QaRow {
  id: string;
  task_id: string;
  role: string;
  content: string;
  citations: string | null;
  limitations: string | null;
  created_at: string;
  turn_id: string | null;
  status: string | null;
  context: string | null;
  error: string | null;
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
    turnId: row.turn_id,
    status: (row.status as QaTurnStatus | null) ?? null,
    context: row.context ? (JSON.parse(row.context) as QaContext) : null,
    error: row.error,
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
    turnId?: string | null;
    status?: QaTurnStatus | null;
    context?: QaContext | null;
  }): QaMessage {
    const message: QaMessage = {
      id: randomUUID(),
      taskId: input.taskId,
      role: input.role,
      content: input.content,
      citations: input.citations ?? null,
      limitations: input.limitations ?? null,
      createdAt: new Date().toISOString(),
      turnId: input.turnId ?? null,
      status: input.status ?? null,
      context: input.context ?? null,
      error: null,
    };
    this.db
      .prepare(
        `INSERT INTO qa_messages (id, task_id, role, content, citations, limitations, created_at, turn_id, status, context, error)
         VALUES (@id, @taskId, @role, @content, @citations, @limitations, @createdAt, @turnId, @status, @context, @error)`,
      )
      .run(
        bind({
          ...message,
          citations: message.citations ? JSON.stringify(message.citations) : null,
          limitations: message.limitations ? JSON.stringify(message.limitations) : null,
          context: message.context ? JSON.stringify(message.context) : null,
        }),
      );
    return message;
  }

  /** 轮状态回写：服务端 abort / 失败 / 完成时落终态（写状态的动作在服务端，不依赖客户端活着） */
  updateStatus(id: string, patch: { status: QaTurnStatus; error?: string | null }): void {
    this.db
      .prepare("UPDATE qa_messages SET status = @status, error = COALESCE(@error, error) WHERE id = @id")
      .run(bind({ id, status: patch.status, error: patch.error ?? null }));
  }

  /** 完成回写：把 streaming 行填充为终态正文，返回 assistant 消息 */
  finishStreaming(
    id: string,
    patch: { content: string; citations: QaCitation[]; limitations: string[] },
  ): QaMessage {
    this.db
      .prepare(
        "UPDATE qa_messages SET content = @content, citations = @citations, limitations = @limitations, status = 'completed', error = NULL WHERE id = @id",
      )
      .run(
        bind({
          id,
          content: patch.content,
          citations: JSON.stringify(patch.citations),
          limitations: JSON.stringify(patch.limitations),
        }),
      );
    const row = this.db.prepare("SELECT * FROM qa_messages WHERE id = ?").get(id) as unknown as QaRow;
    return toMessage(row);
  }

  listForTask(taskId: string): QaMessage[] {
    const rows = many<QaRow>(
      this.db
        .prepare("SELECT * FROM qa_messages WHERE task_id = ? ORDER BY created_at ASC, rowid ASC")
        .all(taskId),
    );
    return rows.map(toMessage);
  }

  /**
   * 取某轮（turnId 或老数据的 assistant 消息 id）的全部消息。
   * retry 端点据此还原问题与锚点。
   */
  getTurn(taskId: string, turnId: string): QaMessage[] {
    const byTurn = many<QaRow>(
      this.db
        .prepare("SELECT * FROM qa_messages WHERE task_id = ? AND turn_id = ? ORDER BY created_at ASC, rowid ASC")
        .all(taskId, turnId),
    );
    if (byTurn.length > 0) return byTurn.map(toMessage);
    // 老数据无 turn_id：允许用 assistant 行 id 定位该轮
    const anchor = this.db
      .prepare("SELECT * FROM qa_messages WHERE task_id = ? AND id = ? AND role = 'assistant'")
      .get(taskId, turnId) as QaRow | undefined;
    if (!anchor) return [];
    const all = this.listForTask(taskId);
    const idx = all.findIndex((m) => m.id === anchor.id);
    return idx > 0 && all[idx - 1].role === "user" ? [all[idx - 1], all[idx]] : [all[idx]];
  }

  /** 最后一轮的消息（重新回答按钮只出现在最后一轮） */
  lastTurn(taskId: string): QaMessage[] {
    const all = this.listForTask(taskId);
    if (all.length === 0) return [];
    const lastAssistant = [...all].reverse().find((m) => m.role === "assistant");
    if (!lastAssistant) return [];
    const idx = all.indexOf(lastAssistant);
    return idx > 0 && all[idx - 1].role === "user" ? [all[idx - 1], all[idx]] : [lastAssistant];
  }

  /** 僵尸轮清理的读投影辅助：仍为 streaming 的轮（服务重启或断连遗留） */
  staleStreamingForTask(taskId: string): QaMessage[] {
    const rows = many<QaRow>(
      this.db
        .prepare(
          "SELECT * FROM qa_messages WHERE task_id = ? AND status = 'streaming' ORDER BY created_at ASC, rowid ASC",
        )
        .all(taskId),
    );
    return rows.map(toMessage);
  }

  removeAllForTask(taskId: string): void {
    this.db.prepare("DELETE FROM qa_messages WHERE task_id = ?").run(taskId);
  }
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
  /** 提问锚点（选段/文稿/选帧），服务端已校验过 */
  context?: QaContext | null;
  /** 本轮 turn id：由服务端生成，user 行与 assistant 行共享 */
  turnId?: string;
  /** 中止信号：客户端断开或点「停止」时掐断上游 LLM 请求 */
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
}

export class QaService {
  constructor(private readonly opts: QaServiceOptions) {}

  async ask(input: AskInput): Promise<{ message: QaMessage; answer: QaAnswer; turnId: string }> {
    const question = input.question.trim();
    if (!question) throw new Error("问题不能为空");

    const startedAt = Date.now();
    const turnId = input.turnId ?? randomUUID();
    this.opts.store.add({
      taskId: input.taskId,
      role: "user",
      content: question,
      turnId,
      context: input.context ?? null,
    });

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
    const runOnce = async (extraNote: string, emitDelta: boolean): Promise<{
      normalized: string;
      parsedLimitations: string[];
      valid: QaCitation[];
      invalidTokens: string[];
    }> => {
      const userContent = [
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
      ].join("\n");
      let raw: string;
      try {
        raw = await this.opts.llm.generate(
          [
            { role: "system", content: QA_SYSTEM },
            { role: "user", content: userContent },
          ],
          (delta) => emitDelta && input.onDelta?.(delta),
          { operation: "qa.answer", taskId: input.taskId, traceId: input.traceId, signal: input.signal },
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
      return { normalized, parsedLimitations: parsed.limitations, valid, invalidTokens };
    };

    // assistant 行先落 streaming：服务端是状态真源，断连/停止时由 signal 落 canceled
    const streamingRow = this.opts.store.add({
      taskId: input.taskId,
      role: "assistant",
      content: "",
      turnId,
      status: "streaming",
    });

    let attempt: Awaited<ReturnType<typeof runOnce>>;
    try {
      attempt = await runOnce("", true);
      if (attempt.invalidTokens.length > 0) {
        logWarn("qa invalid citations, retrying once", {
          task_id: input.taskId,
          trace_id: input.traceId,
          invalid: attempt.invalidTokens.length,
        });
        const retried = await runOnce(citationRetryNote(attempt.invalidTokens, knownExample), false);
        if (retried.invalidTokens.length === 0) attempt = retried;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 中止 → canceled（正文保留已流出部分没有意义：内容未过白名单校验）；
      // 其余 → failed。轮状态在服务端落定，刷新后读投影直接可见。
      const canceled = input.signal?.aborted === true || message.includes("已取消") || message.includes("已中止");
      this.opts.store.updateStatus(streamingRow.id, {
        status: canceled ? "canceled" : "failed",
        error: canceled ? null : message.slice(0, 200),
      });
      throw err;
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

    const message = this.opts.store.finishStreaming(streamingRow.id, {
      content: text,
      citations: attempt.valid,
      limitations,
    });
    logInfo("qa answer completed", {
      task_id: input.taskId,
      trace_id: input.traceId,
      turn_id: turnId,
      message_id: message.id,
      citations: attempt.valid.length,
      invalid_citations: attempt.invalidTokens.length,
      limitations: limitations.length,
      chars: text.length,
      duration_ms: elapsedMs(startedAt),
    });
    return { message, answer: { text, citations: attempt.valid, limitations }, turnId };
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
