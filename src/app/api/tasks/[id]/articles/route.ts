import { getRuntime } from "@/server/runtime";
import { DETAIL_LEVELS, type ArticleDetailLevel } from "@/server/articles";
import { getLlmConfig } from "@/server/config";
import { deviceOwner } from "@/server/owner";


export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { store, articles } = getRuntime();
  if (!store.getOwned(id, deviceOwner(req))) return Response.json({ error: "任务不存在" }, { status: 404 });
  return Response.json({ articles: articles.listForTask(id) });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const rt = getRuntime();
  const task = rt.store.getOwned(id, deviceOwner(req));
  if (!task) return Response.json({ error: "任务不存在" }, { status: 404 });
  if (task.status !== "ready") {
    return Response.json({ error: "任务尚未转写完成" }, { status: 409 });
  }
  if (task.mediaPurgedAt) {
    return Response.json({ error: "媒体已清理，无法生成图文文章" }, { status: 409 });
  }
  // 并发保护：本任务已有生成中的文章或未终态 job 时不接受第二次提交（07 号票 D3 / 08 号票）
  if (rt.articles.listForTask(id).some((a) => a.status === "streaming") || rt.jobs.activeForTask(id)) {
    return Response.json({ error: "已有生成任务在进行中" }, { status: 409 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    detailLevel?: string;
    purpose?: string;
  };
  const detailLevel = (body.detailLevel ?? "standard") as ArticleDetailLevel;
  if (!DETAIL_LEVELS.includes(detailLevel)) {
    return Response.json({ error: "detailLevel 需为 concise / standard / detailed" }, { status: 400 });
  }
  const purpose = body.purpose?.trim() ?? "";
  if (purpose.length > 500) {
    return Response.json({ error: "关注点不能超过 500 字" }, { status: 400 });
  }

  // 08 号票收尾：生成转入后台 job，完全脱离 HTTP 请求生命周期；
  // 客户端断开/刷新只影响事件订阅，不再中断生成；进度落库，中断后可 resume。
  const record = rt.articles.create({
    taskId: id,
    detailLevel,
    purpose: purpose || null,
    model: getLlmConfig().model,
  });
  const job = rt.jobs.create({ taskId: id, kind: "article", articleId: record.id });
  rt.worker.notify();
  return Response.json({ jobId: job.id, articleId: record.id }, { status: 202 });
}
