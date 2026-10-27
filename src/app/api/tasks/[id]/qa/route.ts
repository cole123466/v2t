import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Transcript } from "@/server/asr";
import { taskDir, transcriptPath } from "@/server/paths";
import { readFrameManifest } from "@/server/frames";
import { getRuntime } from "@/server/runtime";
import { errorFields, logError } from "@/server/log";
import { requestId } from "@/server/request";
import { deviceOwner } from "@/server/owner";
import { QaContextError, validateQaContext, type QaContext } from "@/server/qa";


export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_QUESTION = 1000;

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const rt = getRuntime();
  if (!rt.store.getOwned(id, deviceOwner(req))) return Response.json({ error: "任务不存在" }, { status: 404 });
  return Response.json({ messages: rt.qa.listForTask(id) });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const traceId = requestId(req);
  const rt = getRuntime();
  const task = rt.store.getOwned(id, deviceOwner(req));
  if (!task) return Response.json({ error: "任务不存在" }, { status: 404 });
  if (task.status !== "ready") {
    return Response.json({ error: "任务尚未转写完成" }, { status: 409 });
  }

  const body = (await req.json().catch(() => null)) as {
    question?: string;
    context?: QaContext;
  } | null;
  const question = body?.question?.trim() ?? "";
  if (!question) return Response.json({ error: "缺少 question" }, { status: 400 });
  if (question.length > MAX_QUESTION) {
    return Response.json({ error: `问题不能超过 ${MAX_QUESTION} 字` }, { status: 400 });
  }

  let transcript: Transcript;
  try {
    transcript = JSON.parse(
      await readFile(transcriptPath(taskDir(rt.dataDir, id)), "utf8"),
    ) as Transcript;
  } catch {
    return Response.json({ error: "转录稿缺失" }, { status: 409 });
  }

  // 锚点校验（09 号票）：白名单外 422，DB 不落脏行
  const context = body?.context ?? null;
  let contextImage: string | null = null;
  if (context) {
    const manifest = await readFrameManifest(taskDir(rt.dataDir, id));
    const article = rt.articles.listForTask(id).find((a) => a.content) ?? null;
    try {
      validateQaContext(context, {
        article: article?.content ?? null,
        transcript,
        frameIds: new Set((manifest?.frames ?? []).map((f) => f.id)),
      });
    } catch (err) {
      if (err instanceof QaContextError) {
        return Response.json({ error: err.message, field: err.field }, { status: 422 });
      }
      throw err;
    }
    // 单帧注入：读帧文件转 dataURL（帧被清理时按无图降级？不——校验基于清单，
    // 清单在而文件缺失属于异常，仍 422 拒绝，避免交付无证据回答）
    if (context.kind === "frame") {
      const frame = manifest?.frames.find((f) => f.id === context.frameId);
      const bytes = frame
        ? await readFile(path.join(taskDir(rt.dataDir, id), frame.file)).catch(() => null)
        : null;
      if (!bytes) {
        return Response.json(
          { error: "画面文件缺失，无法就该帧回答", field: "context.frameId" },
          { status: 422 },
        );
      }
      contextImage = `data:image/jpeg;base64,${bytes.toString("base64")}`;
    }
  }

  const encoder = new TextEncoder();
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
        taskId: id,
        kind: "qa",
        runId,
        phase: "qa",
        title: question.slice(0, 40),
      });
      try {
        const result = await rt.qaService.ask({
          taskId: id,
          traceId,
          transcript,
          question,
          context: context ?? undefined,
          contextImage,
          onDelta: (delta) => send("delta", { delta }),
        });
        rt.activities.finish(activity.id, {
          ok: true,
          status: "completed",
          message: question.slice(0, 120),
        });
        send("done", result.message);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logError("qa request failed", { task_id: id, trace_id: traceId, ...errorFields(err) });
        rt.activities.finish(activity.id, { ok: false, status: "failed", message: message.slice(0, 200) });
        send("error", { message, request_id: traceId });
      } finally {
        try {
          controller.close();
        } catch {
          // 已关闭
        }
      }
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
