import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildCatalog, validateCitations, validateStructure, type Article } from "@/server/article";
import type { Transcript } from "@/server/asr";
import { readFrameManifest } from "@/server/frames";
import { taskDir, transcriptPath } from "@/server/paths";
import { getRuntime } from "@/server/runtime";
import type { ArticleDetailLevel } from "@/server/articles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DETAIL_LEVELS: ArticleDetailLevel[] = ["concise", "standard", "detailed"];

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { store, articles } = getRuntime();
  if (!store.get(id)) return Response.json({ error: "任务不存在" }, { status: 404 });
  return Response.json({ articles: articles.listForTask(id) });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const rt = getRuntime();
  const task = rt.store.get(id);
  if (!task) return Response.json({ error: "任务不存在" }, { status: 404 });
  if (task.status !== "ready") {
    return Response.json({ error: "任务尚未转写完成" }, { status: 409 });
  }
  if (task.mediaPurgedAt) {
    return Response.json({ error: "媒体已清理，无法生成图文文章" }, { status: 409 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    detailLevel?: string;
    purpose?: string;
  };
  const detailLevel = (body.detailLevel ?? "standard") as ArticleDetailLevel;
  if (!DETAIL_LEVELS.includes(detailLevel)) {
    return Response.json({ error: "detailLevel 需为 concise / standard / detailed" }, { status: 400 });
  }
  const purpose = body.purpose?.trim() ?? "";
  if (purpose.length > 500) {
    return Response.json({ error: "关注点不能超过 500 字" }, { status: 400 });
  }

  const dir = taskDir(rt.dataDir, id);
  let transcript: Transcript;
  try {
    transcript = JSON.parse(await readFile(transcriptPath(dir), "utf8")) as Transcript;
  } catch {
    return Response.json({ error: "转录稿缺失" }, { status: 409 });
  }
  const manifest = await readFrameManifest(dir);
  const catalog = buildCatalog(transcript, manifest);
  const frameFiles = new Map(
    (manifest?.frames ?? []).map((f) => [f.id, path.join(dir, f.file)]),
  );

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
      const activity = rt.activities.start({ taskId: id, kind: "model", stage: "article" });
      try {
        const record = await rt.articleService.generate({
          taskId: id,
          catalog,
          frameFiles,
          detailLevel,
          purpose,
          onProgress: (e) => send("progress", e),
          onDelta: (delta) => send("delta", { delta }),
        });

        // 发布前校验：结构 + 引用白名单（不通过则不标记为可用文章）
        const content = record.content as Article;
        const problems = [...validateStructure(content), ...validateCitations(content, catalog)];
        if (problems.length > 0) {
          rt.articles.update(record.id, {
            status: "failed",
            error: problems.map((p) => `${p.field}: ${p.message}`).join("；").slice(0, 500),
          });
          rt.activities.finish(activity.id, { ok: false, message: "引用或结构校验未通过" });
          send("error", {
            message: "引用或结构校验未通过",
            problems: problems.slice(0, 10),
          });
          return;
        }

        rt.activities.finish(activity.id, { ok: true, message: record.title ?? undefined });
        send("done", rt.articles.get(record.id) ?? record);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
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
