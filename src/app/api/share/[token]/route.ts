import { readFrameManifest } from "@/server/frames";
import { taskDir } from "@/server/paths";
import { getRuntime } from "@/server/runtime";
import { buildSharePayload, readPinnedFrame, shareFrameIds } from "@/server/shares";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_SNAPSHOT = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow, noarchive",
};

/** token 路径段的白名单校验（防路径穿越；真实 token 形如 32hex.hmac） */
function safeToken(value: string): string | null {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value) ? value : null;
}

/**
 * 公开分享载荷（11 号票）：新命名空间，不消费设备 cookie，token 即全部凭据。
 * 载荷 = 文章全文 + 处理步骤投影 + 钉帧清单；绝不含追问（qa_messages 不进投影模块）。
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const clean = safeToken(token);
  if (!clean) return new Response("share not found", { status: 404, headers: NO_SNAPSHOT });

  const rt = getRuntime();
  const share = rt.shares.getByToken(clean);
  // 撤销（删行）后这里立即 404，分享页据此停止轮询
  if (!share) return new Response("share not found", { status: 404, headers: NO_SNAPSHOT });

  const task = rt.store.get(share.taskId);
  const article = rt.articles.get(share.articleId);
  if (!task || !article || article.taskId !== share.taskId) {
    return new Response("share not found", { status: 404, headers: NO_SNAPSHOT });
  }

  // 钉帧清单：钉住目录里实际存在的帧（文件缺失视为无图），时间点从任务帧清单回查
  const dir = taskDir(rt.dataDir, share.taskId);
  const manifest = await readFrameManifest(dir);
  const frameTimes = new Map((manifest?.frames ?? []).map((f) => [f.id, f.tSec]));
  const pinned = article.content ? shareFrameIds(article.content) : [];
  const pinnedFrameIds: string[] = [];
  for (const frameId of pinned) {
    const bytes = await readPinnedFrame(rt.dataDir, share, frameId);
    if (bytes) pinnedFrameIds.push(frameId);
  }

  const payload = buildSharePayload({
    share,
    task,
    article,
    steps: rt.activities.listForTask(share.taskId),
    pinnedFrameIds,
    frameTimes,
  });
  return Response.json(payload, { headers: NO_SNAPSHOT });
}
