import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildCatalog, validateBlocks, validateCitations, validateStructure, type Article } from "@/server/article";
import type { Transcript } from "@/server/asr";
import { readFrameManifest } from "@/server/frames";
import { taskDir, transcriptPath } from "@/server/paths";
import { getRuntime } from "@/server/runtime";
import { DETAIL_LEVELS, type ArticleDetailLevel } from "@/server/articles";
import { errorFields, logError } from "@/server/log";
import { requestId } from "@/server/request";
import { deviceOwner } from "@/server/owner";


export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { store, articles } = getRuntime();
  if (!store.getOwned(id, deviceOwner(req))) return Response.json({ error: "任务不存在" }, { status: 404 });
  return Response.json({ articles: articles.listForTask(id) });
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
  if (task.mediaPurgedAt) {
    return Response.json({ error: "媒体已清理，无法生成图文文章" }, { status: 409 });
  }
  // 并发保护：本任务已有生成中的文章时不接受第二次提交（07 号票 D3）
  if (rt.articles.listForTask(id).some((a) => a.status === "streaming")) {
    return Response.json({ error: "已有生成任务在进行中" }, { status: 409 });
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
      const activity = rt.activities.start({ taskId: id, kind: "model", stage: "article" });
      try {
        const record = await rt.articleService.generate({
          taskId: id,
          traceId,
          catalog,
          frameFiles,
          detailLevel,
          purpose,
          onProgress: (e) => send("progress", e),
          onDelta: (delta) => send("delta", { delta }),
          signal: abort.signal,
        });

        // 发布前校验：结构 + 引用白名单（不通过则不标记为可用文章）
        const content = record.content as Article;
        const problems = [
          ...validateStructure(content),
          ...validateBlocks(content, catalog),
          ...validateCitations(content, catalog),
        ];
        if (problems.length > 0) {
          rt.articles.update(record.id, {
            status: "failed",
            error: problems.map((p) => `${p.field}: ${p.message}`).join("；").slice(0, 500),
          });
          rt.activities.finish(activity.id, { ok: false, message: "引用或结构校验未通过" });
          logError("article validation failed", {
            task_id: id,
            trace_id: traceId,
            problems: problems.length,
          });
          send("error", {
            message: "引用或结构校验未通过",
            problems: problems.slice(0, 10),
            request_id: traceId,
          });
          return;
        }

        rt.activities.finish(activity.id, { ok: true, message: record.title ?? undefined });
        send("done", rt.articles.get(record.id) ?? record);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logError("article request failed", { task_id: id, trace_id: traceId, ...errorFields(err) });
        rt.activities.finish(activity.id, { ok: false, message });
        send("error", { message, request_id: traceId });
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
