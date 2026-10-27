import { readFile } from "node:fs/promises";
import type { Transcript } from "@/server/asr";
import { readFrameManifest } from "@/server/frames";
import { taskDir, transcriptPath } from "@/server/paths";
import { getRuntime } from "@/server/runtime";
import { errorFields, logError } from "@/server/log";
import { requestId } from "@/server/request";
import { deviceOwner } from "@/server/owner";
import { validateQaContext, type QaContext } from "@/server/qa";
import type { Article } from "@/server/article";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_QUESTION = 1000;

/**
 * 读投影（09 号票 P3 / 14 号票原则）：按相邻 user/assistant 对合成轮，
 * 老数据（无 turn_id）也能正确配对，不做数据回填。
 * 仍为 streaming 的行是僵尸（服务重启或断连遗留），一律投影成 canceled。
 */
function groupTurns(taskId: string) {
  const rt = getRuntime();
  const messages = rt.qa.listForTask(taskId);
  const turns: Array<{
    turnId: string;
    question: string;
    context: QaContext | null;
    answer: {
      status: "completed" | "canceled" | "failed";
      text: string;
      citations: typeof messages[number]["citations"];
      limitations: typeof messages[number]["limitations"];
      error: string | null;
    } | null;
    retryable: boolean;
  }> = [];
  for (let i = 0; i < messages.length; i++) {
    const user = messages[i];
    if (user.role !== "user") continue;
    const answer = messages[i + 1]?.role === "assistant" ? messages[i + 1] : null;
    const status =
      answer?.status === "failed" ? "failed" : !answer || answer.status === "streaming" ? "canceled" : "completed";
    turns.push({
      turnId: user.turnId ?? user.id,
      question: user.content,
      context: user.context,
      answer: answer
        ? {
            status,
            text: answer.content,
            citations: answer.citations,
            limitations: answer.limitations,
            error: status === "failed" ? answer.error : null,
          }
        : null,
      retryable: false,
    });
  }
  // 重新回答仅在最后一轮且 canceled/failed 时可用
  const last = turns[turns.length - 1];
  if (last && (last.answer?.status === "canceled" || last.answer?.status === "failed")) {
    last.retryable = true;
  }
  return turns;
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const rt = getRuntime();
  if (!rt.store.getOwned(id, deviceOwner(req))) return Response.json({ error: "任务不存在" }, { status: 404 });
  return Response.json({ turns: groupTurns(id) });
}

interface QaRequestBody {
  question?: string;
  context?: QaContext;
}

async function prepare(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const traceId = requestId(req);
  const rt = getRuntime();
  const task = rt.store.getOwned(id, deviceOwner(req));
  if (!task) {
    return { error: Response.json({ error: "任务不存在" }, { status: 404 }) };
  }
  if (task.status !== "ready") {
    return { error: Response.json({ error: "任务尚未转写完成" }, { status: 409 }) };
  }
  const body = (await req.json().catch(() => null)) as QaRequestBody | null;
  const question = body?.question?.trim() ?? "";
  if (!question) return { error: Response.json({ error: "缺少 question" }, { status: 400 }) };
  if (question.length > MAX_QUESTION) {
    return { error: Response.json({ error: `问题不能超过 ${MAX_QUESTION} 字` }, { status: 400 }) };
  }
  let transcript: Transcript;
  const dir = taskDir(rt.dataDir, id);
  try {
    transcript = JSON.parse(await readFile(transcriptPath(dir), "utf8")) as Transcript;
  } catch {
    return { error: Response.json({ error: "转录稿缺失" }, { status: 409 }) };
  }
  return { id, traceId, rt, dir, question, context: body?.context ?? null, transcript };
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const prep = await prepare(req, { params });
  if (prep.error) return prep.error;
  const { id, traceId, rt, question, context, transcript } = prep;

  // 锚点白名单校验（422，DB 不落脏行）；section 锚点要对照已发布文章的块文本
  if (context) {
    let article: Article | null = null;
    if (context.kind === "section") {
      article = (rt.articles.listForTask(id).find((a) => a.status === "done")?.content as Article | undefined) ?? null;
    }
    const manifest = await readFrameManifest(taskDir(rt.dataDir, id));
    try {
      validateQaContext(context, {
        section: (sectionId) => article?.sections.find((s) => s.id === sectionId) ?? null,
        frame: (frameId) => manifest?.frames.find((f) => f.id === frameId) ?? null,
        segmentCount: transcript.segments.length,
      });
    } catch (err) {
      const field = err instanceof Error && "field" in err ? String((err as { field: unknown }).field) : "context";
      return Response.json({ error: err instanceof Error ? err.message : "锚点不合法", field }, { status: 422 });
    }
  }

  return streamAnswer({ taskId: id, traceId, question, context, transcript, req });
}

function streamAnswer(input: {
  taskId: string;
  traceId: string | undefined;
  question: string;
  context: QaContext | null;
  transcript: Transcript;
  req: Request;
}): Response {
  const rt = getRuntime();
  const { taskId, traceId, question, context, transcript, req } = input;

  const encoder = new TextEncoder();
  // 客户端断开（刷新/停止）→ 掐断上游 LLM 请求并落 canceled，写状态在服务端
  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort(), { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // 客户端已断开
        }
      };
      const runId = rt.activities.newRunId();
      const activity = rt.activities.start({
        taskId,
        kind: "qa",
        runId,
        phase: "qa",
        title: question.slice(0, 40),
      });
      try {
        const result = await rt.qaService.ask({
          taskId,
          traceId,
          transcript,
          question,
          context,
          signal: abort.signal,
          onDelta: (delta) => send("delta", { delta }),
        });
        rt.activities.finish(activity.id, {
          ok: true,
          status: "completed",
          message: question.slice(0, 120),
        });
        send("done", { ...result.message, turnId: result.turnId });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const canceled = abort.signal.aborted || message.includes("已取消") || message.includes("已中止");
        logError("qa request failed", {
          task_id: taskId,
          trace_id: traceId,
          aborted: canceled,
          ...errorFields(err),
        });
        rt.activities.finish(activity.id, {
          ok: false,
          status: canceled ? "canceled" : "failed",
          message: message.slice(0, 200),
        });
        // 询轮 id：ask 抛错前已落 user 行，取该任务最后一轮
        const turnId = rt.qa.lastTurn(taskId).find((m) => m.role === "user")?.turnId ?? null;
        send("error", { turnId, message, request_id: traceId, code: canceled ? "canceled" : "failed" });
      } finally {
        try {
          controller.close();
        } catch {
          // 已关闭
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
