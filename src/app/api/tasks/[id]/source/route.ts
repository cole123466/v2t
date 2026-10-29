import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { sourcePath, taskDir } from "@/server/paths";
import { getRuntime } from "@/server/runtime";
import { deviceOwner } from "@/server/owner";


export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
};

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { store, dataDir } = getRuntime();
  const task = store.getOwned(id, deviceOwner(req));
  if (!task) return new Response("task not found", { status: 404 });

  const file = sourcePath(taskDir(dataDir, id), task.ext);
  const info = await stat(file).catch(() => null);
  if (!info) return new Response("媒体已清理", { status: 410 });

  const type = MIME[task.ext.toLowerCase()] ?? "application/octet-stream";
  const range = req.headers.get("range");

  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    const start = match?.[1] ? Number.parseInt(match[1], 10) : 0;
    const end = Math.min(
      match?.[2] ? Number.parseInt(match[2], 10) : info.size - 1,
      info.size - 1,
    );
    if (Number.isNaN(start) || start > end) {
      return new Response(null, {
        status: 416,
        headers: { "content-range": `bytes */${info.size}` },
      });
    }
    const stream = createReadStream(file, { start, end });
    // 客户端中断后 toWeb 写已关闭的 controller 会抛 ERR_INVALID_STATE，
    // 吞掉读取端错误避免 uncaughtException 打死进程
    stream.on("error", () => {});
    // node 侧 error 监听拦不住 web 侧适配器的 ERR_INVALID_STATE：
    // abort 后在途数据仍会 enqueue 进已关闭的 controller（2026-10-29 16:31
    // 的 uncaughtException 即此）。abort 时立刻销毁文件流，掐断在途写入。
    req.signal.addEventListener("abort", () => stream.destroy(), { once: true });
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 206,
      headers: {
        "content-type": type,
        "content-length": String(end - start + 1),
        "content-range": `bytes ${start}-${end}/${info.size}`,
        "accept-ranges": "bytes",
      },
    });
  }

  const stream = createReadStream(file);
  stream.on("error", () => {});
  // 同上：abort 即销毁，防止 toWeb 适配器写已关闭的 controller
  req.signal.addEventListener("abort", () => stream.destroy(), { once: true });
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: {
      "content-type": type,
      "content-length": String(info.size),
      "accept-ranges": "bytes",
    },
  });
}
