import { getRuntime } from "@/server/runtime";
import { deviceOwner } from "@/server/owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 08 号票：SSE 订阅。连上即推当前快照（部分正文 + 阶段 + k/N），随后推增量。
 * 断开只移除订阅者，不 abort job——这是与旧实现最大的行为差异。
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; articleId: string }> },
) {
  const { id, articleId } = await params;
  const rt = getRuntime();
  if (!rt.store.getOwned(id, deviceOwner(req))) return Response.json({ error: "任务不存在" }, { status: 404 });
  const article = rt.articles.get(articleId);
  if (!article || article.taskId !== id) return Response.json({ error: "文章不存在" }, { status: 404 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // 客户端已断开
        }
      };

      // 连接收流：done/error 或快照发现任务早已终态时都要主动关闭，
      // 否则客户端会一直挂着连接等一个永远不会来的进度事件。
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let unsubscribe: (() => void) | null = null;
      let finished = false;
      function finish() {
        if (finished) return;
        finished = true;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe?.();
        try {
          controller.close();
        } catch {
          // 已关闭
        }
      }

      // 快照：当前文章 + 当前 job 状态
      const snapshot = () => {
        const current = rt.articles.get(articleId);
        const job = rt.jobs.latestForArticle(articleId);
        send("snapshot", {
          article: current,
          job: job
            ? {
                id: job.id,
                status: job.status,
                phase: job.phase,
                doneSections: job.doneSections,
                totalSections: job.totalSections,
                error: job.error,
              }
            : null,
        });
        return { article: current, job };
      };
      const first = snapshot();

      // 文章已落终态或没有在跑的 job（排队中被取消等）：推完快照直接收流。
      const jobActive = first.job?.status === "queued" || first.job?.status === "running";
      if (!first.article || first.article.status !== "streaming" || !jobActive) {
        finish();
        return;
      }

      unsubscribe = rt.worker.subscribe(articleId, (e) => {
        if (finished) return;
        send(e.event, e.data);
        if (e.event === "done" || e.event === "error") {
          snapshot();
          finish();
        }
      });

      // 心跳：防止中间层掐掉空闲连接
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          // ignore
        }
      }, 15000);

      req.signal.addEventListener("abort", finish, { once: true });
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
