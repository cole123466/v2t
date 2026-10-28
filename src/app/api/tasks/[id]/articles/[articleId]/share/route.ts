import { readFrameManifest } from "@/server/frames";
import { taskDir } from "@/server/paths";
import { getRuntime } from "@/server/runtime";
import { deviceOwner } from "@/server/owner";
import { pinShareFrames, removeShareDir, shareFrameIds } from "@/server/shares";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 单篇分享（11 号票）：PUT 创建（幂等）、GET 读状态、DELETE 撤销。
 * 分享钉住 articleId：重新生成文章不改变已分享页内容；重分享 = 新 id = 新链接。
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; articleId: string }> },
) {
  const { id, articleId } = await params;
  const rt = getRuntime();
  if (!rt.store.getOwned(id, deviceOwner(req))) {
    return Response.json({ error: "任务不存在" }, { status: 404 });
  }
  const share = rt.shares.listForTask(id).find((s) => s.articleId === articleId) ?? null;
  return Response.json({ share });
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string; articleId: string }> },
) {
  const { id, articleId } = await params;
  const rt = getRuntime();
  if (!rt.store.getOwned(id, deviceOwner(req))) {
    return Response.json({ error: "任务不存在" }, { status: 404 });
  }
  const article = rt.articles.get(articleId);
  if (!article || article.taskId !== id) {
    return Response.json({ error: "文章不存在" }, { status: 404 });
  }
  if (article.status !== "done" || !article.content) {
    return Response.json({ error: "文章尚未生成完成" }, { status: 409 });
  }

  // 幂等：同 task + article 已有分享则返回现有链接，不产生第二条行
  const existing = rt.shares.listForTask(id).find((s) => s.articleId === articleId);
  const share = existing ?? rt.shares.ensure({ taskId: id, articleId }).share;

  // 钉帧（S3）：把正文引用的帧复制进分享专属目录（覆盖写，幂等），媒体清理后分享页仍有图
  const dir = taskDir(rt.dataDir, id);
  const manifest = await readFrameManifest(dir);
  const files = new Map((manifest?.frames ?? []).map((f) => [f.id, `${dir}/${f.file}`]));
  const toPin = new Map<string, string>();
  for (const frameId of shareFrameIds(article.content)) {
    const src = files.get(frameId);
    if (src) toPin.set(frameId, src);
  }
  if (toPin.size > 0) {
    await pinShareFrames(rt.dataDir, share, toPin);
  }

  return Response.json({ share, url: `/s/${share.token}` });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string; articleId: string }> },
) {
  const { id, articleId } = await params;
  const rt = getRuntime();
  if (!rt.store.getOwned(id, deviceOwner(req))) {
    return Response.json({ error: "任务不存在" }, { status: 404 });
  }
  const existing = rt.shares.listForTask(id).find((s) => s.articleId === articleId);
  if (existing) {
    // 撤销 = 删行 + 删钉帧目录；删后 /s/{token} 与帧接口同时 404
    rt.shares.remove(existing.id);
    await removeShareDir(rt.dataDir, existing.id);
  }
  return Response.json({ ok: true });
}
