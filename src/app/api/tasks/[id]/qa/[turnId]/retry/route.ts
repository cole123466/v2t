import { readFile } from "node:fs/promises";
import type { Transcript } from "@/server/asr";
import { taskDir, transcriptPath } from "@/server/paths";
import { getRuntime } from "@/server/runtime";
import { requestId } from "@/server/request";
import { deviceOwner } from "@/server/owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 09 号票 P3：重新回答。仅最后一轮且 canceled/failed 可用；
 * 重发同问题同锚点，产生新 turn_id，旧轮原样保留。
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; turnId: string }> },
) {
  const { id, turnId } = await params;
  const traceId = requestId(req);
  const rt = getRuntime();
  if (!rt.store.getOwned(id, deviceOwner(req))) return Response.json({ error: "任务不存在" }, { status: 404 });
  if (rt.store.get(id)?.status !== "ready") {
    return Response.json({ error: "任务尚未转写完成" }, { status: 409 });
  }

  const turn = rt.qa.getTurn(id, turnId);
  const user = turn.find((m) => m.role === "user");
  if (!user) return Response.json({ error: "轮不存在" }, { status: 404 });

  // 只有最后一轮可重答：防止中途轮被重复触发打乱会话顺序
  const last = rt.qa.lastTurn(id).find((m) => m.role === "user");
  if (!last || last.id !== user.id) {
    return Response.json({ error: "仅最后一轮可重新回答" }, { status: 409 });
  }
  const assistant = turn.find((m) => m.role === "assistant");
  if (assistant && assistant.status !== "canceled" && assistant.status !== "failed") {
    return Response.json({ error: "该轮已完成，无需重新回答" }, { status: 409 });
  }

  let transcript: Transcript;
  try {
    transcript = JSON.parse(
      await readFile(transcriptPath(taskDir(rt.dataDir, id)), "utf8"),
    ) as Transcript;
  } catch {
    return Response.json({ error: "转录稿缺失" }, { status: 409 });
  }

  // 与 POST /qa 相同的 SSE 形态：客户端按同一套流式协议消费
  const encoder = new TextEncoder();
  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort(), { once: true });

  const question = user.content;
  const context = user.context;
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
        rt.activities.finish(activity.id, {
          ok: false,
          status: canceled ? "canceled" : "failed",
          message: message.slice(0, 200),
        });
        const newTurnId = rt.qa.lastTurn(id).find((m) => m.role === "user")?.turnId ?? null;
        send("error", { turnId: newTurnId, message, request_id: traceId, code: canceled ? "canceled" : "failed" });
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
