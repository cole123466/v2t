import { mkdir } from "node:fs/promises";
import { taskDir } from "@/server/paths";
import { normalizeArticleOptions } from "@/server/articles";
import { QUEUE_FULL_CODE, QueueFullError, queueFullMessage } from "@/server/runner";
import { getRuntime } from "@/server/runtime";
import { isSupportedLink } from "@/server/source";
import { errorFields, logInfo, logWarn } from "@/server/log";
import { requestId } from "@/server/request";
import { deviceOwner } from "@/server/owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 创建链接任务：立即返回 queued 任务，下载与转写在串行管线里进行。
 * 元数据（标题/时长/封面）在此处先行取一次，让用户在下载开始前看到将导入什么。
 */
export async function POST(req: Request) {
  const traceId = requestId(req);
  const body = (await req.json().catch(() => null)) as
    | { url?: string; detailLevel?: string; purpose?: string }
    | null;
  const url = body?.url?.trim() ?? "";
  if (!url) return Response.json({ error: "缺少 url" }, { status: 400 });
  if (!isSupportedLink(url)) {
    return Response.json(
      { error: "仅支持 B 站或 YouTube 视频链接（bilibili.com / b23.tv / youtube.com / youtu.be）" },
      { status: 400 },
    );
  }

  const { store, runner, dataDir, source } = getRuntime();

  // 12 号票 I1：导入页选定的文章默认值随任务落库
  const options = normalizeArticleOptions({
    detailLevel: body?.detailLevel,
    purpose: body?.purpose,
  });
  if ("error" in options) {
    return Response.json({ error: options.error }, { status: 400 });
  }

  // 队列已满时不做 probe / 落库，直接拒绝
  if (runner.isQueueFull()) {
    return Response.json(
      { error: queueFullMessage(runner.queueLimit), code: QUEUE_FULL_CODE },
      { status: 429 },
    );
  }

  let meta;
  try {
    meta = await source.probe(url);
  } catch (err) {
    logWarn("link probe failed", {
      trace_id: traceId,
      host: new URL(url).host,
      ...errorFields(err),
    });
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  const task = store.create({
    originalName: meta.title,
    owner: deviceOwner(req),
    // 实际扩展名在下载完成后由下载器回填
    ext: ".mp4",
    sizeBytes: 0,
    sourceKind: "link",
    sourceUrl: url,
    sourceTitle: meta.title,
    sourceThumbnail: meta.thumbnailUrl,
    sourceNotice: meta.notice ?? null,
    detailLevel: options.detailLevel,
    purpose: options.purpose,
  });
  if (meta.durationSec !== null) {
    store.update(task.id, { durationSec: meta.durationSec });
  }

  try {
    await mkdir(taskDir(dataDir, task.id), { recursive: true });
  } catch {
    store.update(task.id, { status: "failed", error: "无法创建任务目录" });
    return Response.json({ error: "无法创建任务目录" }, { status: 500 });
  }

  logInfo("link task accepted", {
    task_id: task.id,
    trace_id: traceId,
    host: new URL(url).host,
    title_chars: meta.title.length,
    duration_sec: meta.durationSec,
  });
  try {
    runner.enqueue(task.id);
  } catch (err) {
    // probe 期间队列可能被占满：任务作废，避免留下永远排队的行
    store.update(task.id, {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    });
    if (err instanceof QueueFullError) {
      return Response.json(
        { error: err.message, code: QUEUE_FULL_CODE, taskId: task.id },
        { status: 429 },
      );
    }
    throw err;
  }
  return Response.json(store.get(task.id) ?? task, { status: 201 });
}
