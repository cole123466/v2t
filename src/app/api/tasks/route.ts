import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { getMaxUploadBytes } from "@/server/config";
import { sourcePath, taskDir } from "@/server/paths";
import { getRuntime } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fail(error: string, status: number) {
  return Response.json({ error }, { status });
}

export async function POST(req: Request) {
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
  const task = store.create({ originalName, ext, sizeBytes });
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
    return fail("上传中断", 500);
  }

  const actual = await stat(dest).then((s) => s.size).catch(() => -1);
  if (actual !== sizeBytes) {
    store.update(task.id, { status: "failed", error: "上传不完整，请重试" });
    return fail("上传不完整", 500);
  }

  runner.enqueue(task.id);
  return Response.json(task, { status: 201 });
}

export async function GET() {
  const { store } = getRuntime();
  return Response.json({ tasks: store.list() });
}
