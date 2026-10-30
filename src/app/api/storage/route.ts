import { storageStats } from "@/server/maintenance";
import { getRuntime } from "@/server/runtime";
import { deviceOwner } from "@/server/owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const owner = deviceOwner(req);
  // 与 /api/tasks 同口径：只统计本设备可见的任务；无设备 cookie 时统计为空
  const stats = owner
    ? await storageStats(getRuntime(), { owner })
    : { taskCount: 0, purgedCount: 0, mediaBytes: 0, totalBytes: 0 };
  return Response.json(stats);
}
