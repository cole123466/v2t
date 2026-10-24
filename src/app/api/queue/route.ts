import { getRuntime } from "@/server/runtime";
import { deviceOwner } from "@/server/owner";


export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 当前处理队列：active 是串行管线正在处理的任务（最多 1 个），
 * queued 按入队顺序排列，queuedLimit 是排队上限。
 */
export async function GET(req: Request) {
  return Response.json(getRuntime().runner.getQueueSnapshot(deviceOwner(req)));
}
