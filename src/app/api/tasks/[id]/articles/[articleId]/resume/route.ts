import { getRuntime } from "@/server/runtime";
import { deviceOwner } from "@/server/owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 08 号票：续跑。仅 interrupted / failed 的文章可用。
 * 创建新 job（retry_of_job_id 指向旧 job，attempt_no+1），继承已存章节。
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; articleId: string }> },
) {
  const { id, articleId } = await params;
  const rt = getRuntime();
  if (!rt.store.getOwned(id, deviceOwner(req))) return Response.json({ error: "任务不存在" }, { status: 404 });
  const article = rt.articles.get(articleId);
  if (!article || article.taskId !== id) return Response.json({ error: "文章不存在" }, { status: 404 });
  if (article.status !== "interrupted" && article.status !== "failed") {
    return Response.json({ error: "仅中断或失败的文章可继续生成" }, { status: 409 });
  }
  if (rt.jobs.activeForTask(id)) {
    return Response.json({ error: "已有生成任务在进行中" }, { status: 409 });
  }
  const lastJob = rt.jobs.latestForArticle(articleId);
  const doneSections = article.content?.sections.length ?? 0;
  const job = rt.jobs.create({
    taskId: id,
    kind: "article",
    articleId,
    attemptNo: (lastJob?.attemptNo ?? 0) + 1,
    retryOfJobId: lastJob?.id ?? null,
    outlineJson: lastJob?.outlineJson ?? (article.outline ? JSON.stringify(article.outline) : null),
    doneSections,
    totalSections: lastJob?.totalSections ?? article.outline?.sections.length ?? 0,
  });
  rt.articles.update(articleId, { status: "streaming", error: null });
  rt.worker.notify();
  return Response.json({ jobId: job.id, articleId }, { status: 202 });
}
