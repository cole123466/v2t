import { getRuntime } from "@/server/runtime";
import type { Task } from "@/server/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { store, runner } = getRuntime();
  const task = store.get(id);
  if (!task) {
    return new Response("task not found", { status: 404 });
  }

  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        cleanup();
        try {
          controller.close();
        } catch {
          // 已被客户端关闭
        }
      };
      const send = (t: Task) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(t)}\n\n`));
        } catch {
          close();
          return;
        }
        if (t.status === "ready" || t.status === "failed") close();
      };

      send(task);

      if (!closed) {
        const unsub = runner.subscribe(id, send);
        const heartbeat = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(": ping\n\n"));
          } catch {
            close();
          }
        }, 25_000);
        cleanup = () => {
          unsub();
          clearInterval(heartbeat);
        };
        req.signal.addEventListener("abort", close);
      }
    },
    cancel() {
      cleanup();
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
