import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { audioPath, taskDir } from "@/server/paths";
import { getRuntime } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { store, dataDir } = getRuntime();
  const task = store.get(id);
  if (!task) return new Response("task not found", { status: 404 });

  const file = audioPath(taskDir(dataDir, id));
  const info = await stat(file).catch(() => null);
  if (!info) return new Response("媒体已清理", { status: 410 });

  const stream = createReadStream(file);
  // 整文件一次性返回（波形解码用），不支持 Range，故不声明 accept-ranges
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: {
      "content-type": "audio/mpeg",
      "content-length": String(info.size),
    },
  });
}
