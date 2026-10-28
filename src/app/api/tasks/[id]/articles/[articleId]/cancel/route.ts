import { getRuntime } from "@/server/runtime";
import { deviceOwner } from "@/server/owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 08 号票：取消生成。仅未终态 job 可取消；非 running/queued 返回 409。 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; articleId: string }> },
) {
  const { id, articleId } = await params;
  const rt = getRuntime();
  if (!rt.store.getOwned(id, deviceOwner(req))) return Response.json({ error: "任务不存在" }, { status: 404 });
  const article = rt.articles.get(articleId);
  if (!article || article.taskId !== id) return Response.json({ error: "文章不存在" }, { status: 404 });

  const job = rt.jobs.activeForArticle(articleId);
  if (!job) return Response.json({ error: "没有进行中的生成任务" }, { status: 409 });

  const ok = rt.worker.cancel(job.id);
  if (!ok) return Response.json({ error: "任务已结束，无法取消" }, { status: 409 });
  rt.activities.runningIdsForRun(job.id).forEach((sid) =>
    rt.activities.updateStatus(sid, "canceled", "用户取消生成"),
  );
  return Response.json({ canceled: true, jobId: job.id });
}
