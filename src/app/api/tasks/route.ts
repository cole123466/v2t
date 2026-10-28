import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { getMaxUploadBytes } from "@/server/config";
import { normalizeArticleOptions } from "@/server/articles";
import { sourcePath, taskDir } from "@/server/paths";
import { QUEUE_FULL_CODE, QueueFullError, queueFullMessage } from "@/server/runner";
import { getRuntime } from "@/server/runtime";
import { logInfo, logWarn } from "@/server/log";
import { requestId } from "@/server/request";
import { deviceOwner } from "@/server/owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fail(error: string, status: number) {
  return Response.json({ error }, { status });
}

export async function POST(req: Request) {
  const traceId = requestId(req);
  const rawName = new URL(req.url).searchParams.get("name") ?? "upload.mp4";
  const originalName =
    path.basename(rawName).replace(/[\u0000-\u001f<>:"/\\|?*]/g, "").slice(0, 200) ||
    "upload.mp4";
  const ext = path.extname(originalName).toLowerCase();

  const sizeBytes = Number(req.headers.get("content-length"));
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return fail("缺少有效的 content-length", 400);
  }
  const maxBytes = getMaxUploadBytes();
  if (sizeBytes > maxBytes) {
    return fail(`文件超过上限 ${(maxBytes / 1024 ** 3).toFixed(0)}GB`, 413);
  }
  if (!req.body) {
    return fail("请求没有文件体", 400);
  }

  const { store, runner, dataDir } = getRuntime();

  // 12 号票 I1：导入页选定的文章默认值随查询串传入（请求体是原始文件字节）
  const params = new URL(req.url).searchParams;
  const options = normalizeArticleOptions({
    detailLevel: params.get("detailLevel") ?? undefined,
    purpose: params.get("purpose") ?? undefined,
  });
  if ("error" in options) return fail(options.error, 400);

  // 队列已满时在接收文件体之前就拒绝，避免白传一个 2GB 文件
  if (runner.isQueueFull()) {
    return Response.json(
      { error: queueFullMessage(runner.queueLimit), code: QUEUE_FULL_CODE },
      { status: 429 },
    );
  }

  const task = store.create({
    originalName,
    ext,
    sizeBytes,
    owner: deviceOwner(req),
    detailLevel: options.detailLevel,
    purpose: options.purpose,
  });
  const dir = taskDir(dataDir, task.id);
  const dest = sourcePath(dir, ext);

  try {
    await mkdir(dir, { recursive: true });
    await pipeline(
      Readable.fromWeb(req.body as unknown as NodeWebReadableStream<Uint8Array>),
      createWriteStream(dest),
    );
  } catch {
    store.update(task.id, { status: "failed", error: "上传中断，文件不完整" });
    logWarn("upload interrupted", {
      task_id: task.id,
      trace_id: traceId,
      file: originalName,
      bytes: sizeBytes,
    });
    return fail("上传中断", 500);
  }

  const actual = await stat(dest).then((s) => s.size).catch(() => -1);
  if (actual !== sizeBytes) {
    store.update(task.id, { status: "failed", error: "上传不完整，请重试" });
    logWarn("upload incomplete", {
      task_id: task.id,
      trace_id: traceId,
      file: originalName,
      expected_bytes: sizeBytes,
      actual_bytes: actual,
    });
    return fail("上传不完整", 500);
  }

  try {
    runner.enqueue(task.id);
  } catch (err) {
    // 上传期间别的请求可能占满队列：任务作废，避免留下永远排队的行
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

  logInfo("upload accepted", {
    task_id: task.id,
    trace_id: traceId,
    file: originalName,
    bytes: sizeBytes,
    ext,
  });
  return Response.json(task, { status: 201 });
}

export async function GET(req: Request) {
  const { store } = getRuntime();
  const owner = deviceOwner(req);
  // 升级后第一次有设备来取列表：把无主的历史任务认领给它，免得老任务凭空消失。
  // 之后 owner 已全部有值，这条 UPDATE 命中 0 行。
  store.claimLegacy(owner);
  return Response.json({ tasks: store.list(owner) });
}
