import { getRuntime } from "@/server/runtime";
import { readPinnedFrame, shareFrameIds } from "@/server/shares";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 公开帧代理（11 号票）：从分享钉帧目录读文件，不复用任务目录的帧路由。
 * 每次请求都重查 shares 行——撤销后的分享必须同时失去图片访问。
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string; frame: string }> },
) {
  const { token, frame } = await params;
  const headers = {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex, nofollow, noarchive",
  };

  // token 形如 {id}.{hmac}；frameId 是单段白名单字符
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    return new Response("share not found", { status: 404, headers });
  }
  if (!/^[a-z0-9_-]+$/i.test(frame)) {
    return new Response("frame not found", { status: 404, headers });
  }

  const rt = getRuntime();
  const share = rt.shares.getByToken(token);
  if (!share) return new Response("share not found", { status: 404, headers });

  // 帧白名单：只给分享文章正文引用过的帧，分享页不是整片帧下载器
  const article = rt.articles.get(share.articleId);
  const allowed = article?.content
    ? new Set(shareFrameIds(article.content))
    : new Set<string>();
  if (!allowed.has(frame)) return new Response("frame not found", { status: 404, headers });

  const bytes = await readPinnedFrame(rt.dataDir, share, frame);
  if (!bytes) return new Response("frame not found", { status: 404, headers });

  return new Response(new Uint8Array(bytes), {
    headers: { ...headers, "content-type": "image/jpeg" },
  });
}
