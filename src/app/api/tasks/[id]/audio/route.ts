import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { audioPath, taskDir } from "@/server/paths";
import { getRuntime } from "@/server/runtime";
import { deviceOwner } from "@/server/owner";
import { nodeToWebStream } from "@/server/web-stream";


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

  // 用自建桥而不是 Readable.toWeb：后者在客户端中断后会二次 close 已关闭的
  // controller（ERR_INVALID_STATE 进程级异常，见 src/server/web-stream.ts）
  return new Response(nodeToWebStream(createReadStream(file)), {
    headers: {
      "content-type": "audio/mpeg",
      "content-length": String(info.size),
    },
  });
}
