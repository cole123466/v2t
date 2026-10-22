import { randomUUID } from "node:crypto";
import { normalizeCitations } from "./article";
import type { Transcript, TranscriptSegment } from "./asr";
import type { Db } from "./db";
import { bind, rows as many } from "./sql";
import type { LLMProvider } from "./generations";

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
  transcript: Transcript;
  question: string;
  onDelta?: (delta: string) => void;
}

export class QaService {
  constructor(private readonly opts: QaServiceOptions) {}

  async ask(input: AskInput): Promise<{ message: QaMessage; answer: QaAnswer }> {
    const question = input.question.trim();
    if (!question) throw new Error("问题不能为空");

    this.opts.store.add({ taskId: input.taskId, role: "user", content: question });

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
    const context = candidates
      .map((c) => `[t${String(c.index + 1).padStart(2, "0")}] ${formatTime(c.segment.start)}-${formatTime(c.segment.end)} ${c.segment.text}`)
      .join("\n");

    const raw = await this.opts.llm.generate(
      [
        { role: "system", content: QA_SYSTEM },
        {
          role: "user",
          content: [
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
          ].join("\n"),
        },
      ],
      (delta) => input.onDelta?.(delta),
    );

    const parsed = parseAnswer(raw);
    // 引用格式先规范化（模型常少写方括号），再校验编号范围
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

    let text = normalized;
    for (const token of invalidTokens) {
      text = text.split(`[[${token}]]`).join("");
    }
    const limitations = [...parsed.limitations];
    if (invalidTokens.length > 0) {
      limitations.push(`已移除 ${invalidTokens.length} 个无法核实的出处编号`);
    }

    const message = this.opts.store.add({
      taskId: input.taskId,
      role: "assistant",
      content: text,
      citations: valid,
      limitations,
    });
    return { message, answer: { text, citations: valid, limitations } };
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
