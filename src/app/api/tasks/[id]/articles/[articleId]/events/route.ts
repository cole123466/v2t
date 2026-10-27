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
      };
      snapshot();

      const unsubscribe = rt.worker.subscribe(articleId, (e) => {
        if (e.event === "done" || e.event === "error") {
          send(e.event, e.data);
          snapshot();
        } else {
          send(e.event, e.data);
        }
      });

      // 心跳：防止中间层掐掉空闲连接
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          // ignore
        }
      }, 15000);

      req.signal.addEventListener("abort", () => {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // 已关闭
        }
      }, { once: true });
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
