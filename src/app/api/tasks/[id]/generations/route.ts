import { readFile } from "node:fs/promises";
import { taskDir, transcriptPath } from "@/server/paths";
import { getRuntime } from "@/server/runtime";
import { PRESET_TEMPLATES, type GenerationInput } from "@/server/generations";
import type { Transcript } from "@/server/asr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { store, generations } = getRuntime();
  if (!store.get(id)) {
    return Response.json({ error: "任务不存在" }, { status: 404 });
  }
  return Response.json({ generations: generations.listForTask(id) });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { store, generationService, dataDir } = getRuntime();
  const task = store.get(id);
  if (!task) return Response.json({ error: "任务不存在" }, { status: 404 });
  if (task.status !== "ready") {
    return Response.json({ error: "任务尚未转写完成" }, { status: 409 });
  }

  const body = (await req.json().catch(() => null)) as GenerationInput | null;
  if (!body || (body.mode !== "auto" && body.mode !== "manual")) {
    return Response.json({ error: "请求体需要 mode: auto|manual" }, { status: 400 });
  }
  if (body.mode === "manual" && !body.prompt?.trim()) {
    return Response.json({ error: "手动模式需要提示词" }, { status: 400 });
  }
  if (body.mode === "auto" && !PRESET_TEMPLATES.some((t) => t.id === body.templateId)) {
    return Response.json(
      { error: `未知模板：${body.templateId ?? "(空)"}，可选：${PRESET_TEMPLATES.map((t) => t.id).join(" / ")}` },
      { status: 400 },
    );
  }

  let transcript: Transcript;
  try {
    transcript = JSON.parse(
      await readFile(transcriptPath(taskDir(dataDir, id)), "utf8"),
    ) as Transcript;
  } catch {
    return Response.json({ error: "转录稿缺失" }, { status: 409 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // 客户端已断开，流已被关闭
        }
      };
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // 客户端已断开：停止写入，避免 uncaughtException
          closed = true;
        }
      };
      try {
        const gen = await generationService.generateForTask(id, transcript, body, (delta) =>
          send("delta", { delta }),
        );
        send("done", gen);
      } catch (err) {
        send("error", { message: err instanceof Error ? err.message : String(err) });
      } finally {
        close();
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
