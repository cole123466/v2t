import { getRuntime } from "@/server/runtime";
import { deviceOwner } from "@/server/owner";
import { logInfo } from "@/server/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 取消任务（12 号票 I5）：仅排队中的任务可取消——runner 出队 + 标 canceled。
 * 运行中的任务不支持取消：ASR 分段与 ffmpeg 半途掐断会留下脏文件，
 * 删除重建比支持半态便宜（见 runner.cancelQueued 注释）。
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const rt = getRuntime();
  const task = rt.store.getOwned(id, deviceOwner(req));
  if (!task) {
    return Response.json({ error: "任务不存在" }, { status: 404 });
  }
  if (task.status !== "queued") {
    return Response.json({ error: "仅排队中的任务可以取消" }, { status: 409 });
  }
  const ok = rt.runner.cancelQueued(id);
  if (!ok) {
    // 行状态是 queued 但已不在内存队列（如上传尚未入队）：按不可取消处理
    return Response.json({ error: "任务已开始处理，无法取消" }, { status: 409 });
  }
  logInfo("queued task canceled", { task_id: id });
  return Response.json(rt.store.get(id));
}
