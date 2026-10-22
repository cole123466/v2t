import { getRuntime } from "@/server/runtime";
import { isSupportedLink } from "@/server/source";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 链接任务预检：只取元数据（标题 / 时长 / 封面），不下载。
 * 前端在用户粘贴链接后调用，用于展示"将导入什么"并校验可用性。
 */
export async function GET(req: Request) {
  const url = new URL(req.url).searchParams.get("url")?.trim() ?? "";
  if (!url) return Response.json({ error: "缺少 url 参数" }, { status: 400 });
  if (!isSupportedLink(url)) {
    return Response.json(
      { error: "仅支持 B 站或 YouTube 视频链接（bilibili.com / b23.tv / youtube.com / youtu.be）" },
      { status: 400 },
    );
  }
  try {
    const meta = await getRuntime().source.probe(url);
    return Response.json({ meta });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
