import { isProcessing } from "@/lib/task-status";
import { deleteTask } from "@/server/maintenance";
import { getRuntime } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const task = getRuntime().store.get(id);
  if (!task) {
    return Response.json({ error: "任务不存在" }, { status: 404 });
  }
  return Response.json(task);
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const rt = getRuntime();
  const task = rt.store.get(id);
  if (!task) {
    return Response.json({ error: "任务不存在" }, { status: 404 });
  }
  if (isProcessing(task.status)) {
    return Response.json({ error: "任务处理中，无法删除" }, { status: 409 });
  }
  await deleteTask(rt, id);
  return Response.json({ ok: true });
}
