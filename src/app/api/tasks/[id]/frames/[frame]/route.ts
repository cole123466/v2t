import { readFile } from "node:fs/promises";
import path from "node:path";
import { framesDir, readFrameManifest } from "@/server/frames";
import { taskDir } from "@/server/paths";
import { getRuntime } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 帧图片流：只允许访问 frames.json 清单里登记的文件（白名单，防路径穿越）。
 * 媒体被清理后返回 410，前端据此退化为无图阅读。
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; frame: string }> },
) {
  const { id, frame } = await params;
  const rt = getRuntime();
  if (!rt.store.get(id)) return new Response("task not found", { status: 404 });

  const dir = taskDir(rt.dataDir, id);
  const manifest = await readFrameManifest(dir);
  const known = manifest?.frames.find((f) => f.id === frame);
  if (!known) return new Response("frame not found", { status: 404 });

  // manifest 里的 file 形如 frames/f00.jpg（相对任务目录），
  // 已通过清单白名单命中，这里再规范化并确保不逃出 frames 目录
  const file = path.join(dir, path.normalize(known.file));
  if (!file.startsWith(framesDir(dir) + path.sep)) {
    return new Response("frame not found", { status: 404 });
  }
  const bytes = await readFile(file).catch(() => null);
  if (!bytes) return new Response("frame purged", { status: 410 });

  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": "image/jpeg",
      "cache-control": "private, max-age=3600",
    },
  });
}
