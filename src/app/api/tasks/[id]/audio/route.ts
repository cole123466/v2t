import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { audioPath, taskDir } from "@/server/paths";
import { getRuntime } from "@/server/runtime";
import { deviceOwner } from "@/server/owner";


export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { store, dataDir } = getRuntime();
  const task = store.getOwned(id, deviceOwner(req));
  if (!task) return new Response("task not found", { status: 404 });

  const file = audioPath(taskDir(dataDir, id));
  const info = await stat(file).catch(() => null);
  if (!info) return new Response("媒体已清理", { status: 410 });

  const stream = createReadStream(file);
  // 与 source 路由同理：node 侧吞错 + abort 即销毁，防止 toWeb 适配器
  // 在客户端断开后往已关闭的 controller enqueue（ERR_INVALID_STATE）
  stream.on("error", () => {});
  req.signal.addEventListener("abort", () => stream.destroy(), { once: true });
  // 整文件一次性返回（波形解码用），不支持 Range，故不声明 accept-ranges
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: {
      "content-type": "audio/mpeg",
      "content-length": String(info.size),
    },
  });
}
