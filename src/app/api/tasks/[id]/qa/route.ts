import { readFile } from "node:fs/promises";
import type { Transcript } from "@/server/asr";
import { taskDir, transcriptPath } from "@/server/paths";
import { getRuntime } from "@/server/runtime";
import { errorFields, logError } from "@/server/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_QUESTION = 1000;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const rt = getRuntime();
  if (!rt.store.get(id)) return Response.json({ error: "任务不存在" }, { status: 404 });
  return Response.json({ messages: rt.qa.listForTask(id) });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const rt = getRuntime();
  const task = rt.store.get(id);
  if (!task) return Response.json({ error: "任务不存在" }, { status: 404 });
  if (task.status !== "ready") {
    return Response.json({ error: "任务尚未转写完成" }, { status: 409 });
  }

  const body = (await req.json().catch(() => null)) as { question?: string } | null;
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
      const activity = rt.activities.start({ taskId: id, kind: "model", stage: "qa" });
      try {
        const result = await rt.qaService.ask({
          taskId: id,
          transcript,
          question,
          onDelta: (delta) => send("delta", { delta }),
        });
        rt.activities.finish(activity.id, { ok: true, message: question.slice(0, 120) });
        send("done", result.message);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logError("qa request failed", { task_id: id, ...errorFields(err) });
        rt.activities.finish(activity.id, { ok: false, message });
        send("error", { message });
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
