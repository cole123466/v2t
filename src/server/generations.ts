import { randomUUID } from "node:crypto";
import { TEMPLATE_META } from "@/lib/templates";
import { getLlmConfig } from "./config";
import type { Db } from "./db";
import { bind, row as one, rows as many } from "./sql";
import type { Transcript } from "./asr";
import { elapsedMs, errorFields, logError, logInfo } from "./log";

export interface Generation {
  id: string;
  taskId: string;
  mode: "auto" | "manual";
  templateId: string | null;
  prompt: string | null;
  output: string;
  model: string;
  status: "streaming" | "done" | "failed";
  error: string | null;
  createdAt: string;
}

interface GenerationRow {
  id: string;
  task_id: string;
  mode: string;
  template_id: string | null;
  prompt: string | null;
  output: string;
  model: string;
  status: string;
  error: string | null;
  created_at: string;
}

function toGeneration(row: GenerationRow): Generation {
  return {
    id: row.id,
    taskId: row.task_id,
    mode: row.mode as Generation["mode"],
    templateId: row.template_id,
    prompt: row.prompt,
    output: row.output,
    model: row.model,
    status: row.status as Generation["status"],
    error: row.error,
    createdAt: row.created_at,
  };
}

export class GenerationStore {
  constructor(private readonly db: Db) {}

  create(input: {
    taskId: string;
    mode: "auto" | "manual";
    templateId: string | null;
    prompt: string | null;
    model: string;
  }): Generation {
    const gen: Generation = {
      id: randomUUID(),
      taskId: input.taskId,
      mode: input.mode,
      templateId: input.templateId,
      prompt: input.prompt,
      output: "",
      model: input.model,
      status: "streaming",
      error: null,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO generations (id, task_id, mode, template_id, prompt, output, model, status, error, created_at)
         VALUES (@id, @taskId, @mode, @templateId, @prompt, @output, @model, @status, @error, @createdAt)`,
      )
      .run(bind(gen));
    return gen;
  }

  update(
    id: string,
    patch: { output?: string; model?: string; status?: Generation["status"]; error?: string | null },
  ): void {
    const sets: string[] = [];
    const params: Record<string, string | null> = { id };
    for (const key of ["output", "model", "status", "error"] as const) {
      if (key in patch) {
        sets.push(`${key} = @${key}`);
        params[key] = patch[key] ?? null;
      }
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE generations SET ${sets.join(", ")} WHERE id = @id`).run(bind(params));
  }

  get(id: string): Generation | undefined {
    const row = one<GenerationRow>(
      this.db.prepare("SELECT * FROM generations WHERE id = ?").get(id),
    );
    return row ? toGeneration(row) : undefined;
  }

  listForTask(taskId: string): Generation[] {
    const rows = many<GenerationRow>(
      this.db
        .prepare("SELECT * FROM generations WHERE task_id = ? ORDER BY created_at DESC, rowid DESC")
        .all(taskId),
    );
    return rows.map(toGeneration);
  }

  removeAllForTask(taskId: string): void {
    this.db.prepare("DELETE FROM generations WHERE task_id = ?").run(taskId);
  }
}

// ---------------------------------------------------------------------------
// LLM provider 抽象
// ---------------------------------------------------------------------------

/** 视觉输入块：文本或图片（OpenAI 兼容 content 数组形态） */
export type LLMContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface LLMMessage {
  role: "system" | "user";
  /** 纯文本消息用字符串；带图消息用 content 数组 */
  content: string | LLMContentPart[];
}

/** 日志用上下文：不参与请求内容，只用于把模型调用归到具体任务/操作 */
export interface LLMCallMeta {
  operation?: string;
  taskId?: string;
  traceId?: string;
  /** 客户端断开时中止上游流式请求，避免继续占用连接与内存 */
  signal?: AbortSignal;
  /** 本次调用实际使用的模型（provider 按消息是否带图选择），供调用方落库 */
  onModel?: (model: string) => void;
}

export interface LLMProvider {
  generate(messages: LLMMessage[], onChunk: (delta: string) => void, meta?: LLMCallMeta): Promise<string>;
}

// ---------------------------------------------------------------------------
// 预设模板
// ---------------------------------------------------------------------------

export interface TemplateDef {
  id: string;
  label: string;
  buildPrompt(transcriptText: string): string;
}

const BUILDERS: Record<string, (transcriptText: string) => string> = {
  refine: (t) =>
    `请把下面的视频转录稿整理成一篇结构清晰的文章：口语转书面、纠正口误、划分小节并加小标题，保留全部关键信息与原意，不使用表情符号，输出 Markdown。\n\n转录稿：\n${t}`,
  xhs: (t) =>
    `请把下面的视频内容改写成一篇小红书笔记：吸睛标题（不超过 20 字）、分点正文、口语化有网感、结尾附 3-5 个 #话题 标签。全文不使用表情符号，只输出笔记本身。\n\n转录稿：\n${t}`,
  article: (t) =>
    `请把下面的视频内容扩写为一篇公众号长文：有引入、有观点、有小标题分节、结尾有总结与互动引导，风格克制专业，不使用表情符号，输出 Markdown。\n\n转录稿：\n${t}`,
  brief: (t) =>
    `请用三句话概括下面视频内容的核心要点：每句话一行，简洁有力，不使用表情符号，只输出这三句话。\n\n转录稿：\n${t}`,
};

// id/label 以 lib/templates 为唯一来源，防止客户端 chips 与服务端漂移
export const PRESET_TEMPLATES: TemplateDef[] = TEMPLATE_META.map(({ id, label }) => ({
  id,
  label,
  buildPrompt: BUILDERS[id],
}));

const SYSTEM_PROMPT =
  "你是一位资深中文编辑。只依据用户提供的视频转录稿写作，不编造不存在的信息；输出直接可用，不使用表情符号。";

// ---------------------------------------------------------------------------
// 生成服务（Seam B）
// ---------------------------------------------------------------------------

export interface GenerationInput {
  mode: "auto" | "manual";
  templateId?: string;
  prompt?: string;
}

export class GenerationService {
  constructor(private readonly opts: { store: GenerationStore; llm: LLMProvider }) {}

  async generateForTask(
    taskId: string,
    transcript: Pick<Transcript, "segments">,
    input: GenerationInput,
    onChunk?: (delta: string) => void,
    traceId?: string,
    signal?: AbortSignal,
  ): Promise<Generation> {
    const template =
      input.mode === "auto" ? PRESET_TEMPLATES.find((t) => t.id === input.templateId) : undefined;
    if (input.mode === "auto" && !template) {
      throw new Error(`未知模板：${input.templateId}`);
    }

    const transcriptText = transcript.segments.map((s) => s.text).join("\n");
    const userContent =
      input.mode === "auto"
        ? template!.buildPrompt(transcriptText)
        : `${input.prompt}\n\n转录稿：\n${transcriptText}`;

    const startedAt = Date.now();
    const gen = this.opts.store.create({
      taskId,
      mode: input.mode,
      templateId: template?.id ?? null,
      prompt: input.mode === "manual" ? (input.prompt ?? null) : null,
      model: getLlmConfig().model,
    });
    logInfo("copywriting generation started", {
      task_id: taskId,
      trace_id: traceId,
      generation_id: gen.id,
      mode: input.mode,
      template: template?.id,
      prompt_chars: input.mode === "manual" ? (input.prompt?.length ?? 0) : 0,
      transcript_segments: transcript.segments.length,
    });

    try {
      const output = await this.opts.llm.generate(
        [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        (delta) => {
          gen.output += delta;
          onChunk?.(delta);
        },
        {
          operation: `copywriting.${input.mode}`,
          taskId,
          traceId,
          signal,
          // 记录模型以 provider 实际选用为准（带图会切到视觉模型），不再只写默认文本模型
          onModel: (model) => {
            if (model === gen.model) return;
            gen.model = model;
            this.opts.store.update(gen.id, { model });
          },
        },
      );
      this.opts.store.update(gen.id, { output, status: "done" });
      logInfo("copywriting generation completed", {
        task_id: taskId,
        trace_id: traceId,
        generation_id: gen.id,
        chars: output.length,
        duration_ms: elapsedMs(startedAt),
      });
      return { ...gen, output, status: "done" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.opts.store.update(gen.id, { status: "failed", error: message });
      logError("copywriting generation failed", {
        task_id: taskId,
        trace_id: traceId,
        generation_id: gen.id,
        ...errorFields(err),
        duration_ms: elapsedMs(startedAt),
      });
      throw err;
    }
  }
}
