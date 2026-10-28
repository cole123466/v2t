import { getRuntime } from "@/server/runtime";
import { deviceOwner } from "@/server/owner";
import { logError } from "@/server/log";
import { requestId } from "@/server/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 10 号票：手动审稿。
 * GET  — 全部审核记录（新→旧），历史全留（用户可能改稿前后各审一次）。
 * POST — 发起审核：同一事务建 review job(queued) + article_reviews(queued)，
 *        notify() 后 202；同篇已有 queued/running 审核 → 409。
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; articleId: string }> },
) {
  const { id, articleId } = await params;
  const rt = getRuntime();
  if (!rt.store.getOwned(id, deviceOwner(req))) return Response.json({ error: "任务不存在" }, { status: 404 });
  const article = rt.articles.get(articleId);
  if (!article || article.taskId !== id) return Response.json({ error: "文章不存在" }, { status: 404 });
  return Response.json({ reviews: rt.reviews.listForArticle(articleId) });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; articleId: string }> },
) {
  const { id, articleId } = await params;
  const rt = getRuntime();
  if (!rt.store.getOwned(id, deviceOwner(req))) return Response.json({ error: "任务不存在" }, { status: 404 });
  const article = rt.articles.get(articleId);
  if (!article || article.taskId !== id) return Response.json({ error: "文章不存在" }, { status: 404 });
  if (article.status !== "done" || !article.content) {
    return Response.json({ error: "仅生成完成的文章可审核" }, { status: 409 });
  }
  // 同篇已有 queued/running 审核 → 409（验收 3：不产生第二个 review job）
  const activeJob = rt.jobs.activeForArticle(articleId);
  if (activeJob && activeJob.kind === "review") {
    return Response.json({ error: "该文章正在审核中" }, { status: 409 });
  }
  const activeReview = rt.reviews.activeForArticle(articleId);
  if (activeReview) {
    return Response.json({ error: "该文章正在审核中" }, { status: 409 });
  }

  const traceId = requestId(req);
  let committed: { reviewId: string; jobId: string } | null = null;
  try {
    // job + review 同一事务：失败可回溯执行现场，也避免出现无主 review 行
    rt.db.exec("BEGIN");
    try {
      const job = rt.jobs.create({ taskId: id, kind: "review", articleId });
      const review = rt.reviews.create({ taskId: id, articleId, jobId: job.id, model: null });
      rt.db.exec("COMMIT");
      // COMMIT 之后不再回滚；notify 失败只记日志，worker 轮询兜底
      committed = { reviewId: review.id, jobId: job.id };
    } catch (txErr) {
      rt.db.exec("ROLLBACK");
      throw txErr;
    }
    try {
      rt.worker.notify();
    } catch (notifyErr) {
      logError("review worker notify failed", {
        task_id: id,
        article_id: articleId,
        trace_id: traceId,
        error: notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
      });
    }
    return Response.json(committed, { status: 202 });
  } catch {
    logError("review create failed", { task_id: id, article_id: articleId, trace_id: traceId });
    // 不透传内部 err.message（可能含 SQL 片段/路径）
    return Response.json({ error: "发起审核失败，请稍后重试" }, { status: 500 });
  }
}
