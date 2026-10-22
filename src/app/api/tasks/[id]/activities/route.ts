import { getRuntime } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 过程回看：任务的阶段与模型调用活动记录 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const rt = getRuntime();
  if (!rt.store.get(id)) return Response.json({ error: "任务不存在" }, { status: 404 });
  return Response.json({ activities: rt.activities.listForTask(id) });
}
