import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { sourcePath, taskDir } from "@/server/paths";
import { getRuntime } from "@/server/runtime";
import { deviceOwner } from "@/server/owner";
import { nodeToWebStream } from "@/server/web-stream";


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
    // 用自建桥而不是 Readable.toWeb：后者在客户端中断后会二次 close 已关闭的
    // controller（ERR_INVALID_STATE 进程级异常，见 src/server/web-stream.ts）
    return new Response(nodeToWebStream(createReadStream(file, { start, end })), {
      status: 206,
      headers: {
        "content-type": type,
        "content-length": String(end - start + 1),
        "content-range": `bytes ${start}-${end}/${info.size}`,
        "accept-ranges": "bytes",
      },
    });
  }

  return new Response(nodeToWebStream(createReadStream(file)), {
    headers: {
      "content-type": type,
      "content-length": String(info.size),
      "accept-ranges": "bytes",
    },
  });
}
