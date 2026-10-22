import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Transcript } from "@/server/asr";
import { buildCitationIndex, collectFrameIds, renderArticleMarkdown } from "@/server/export";
import { readFrameManifest } from "@/server/frames";
import { taskDir, transcriptPath } from "@/server/paths";
import { getRuntime } from "@/server/runtime";
import { createZip } from "@/server/zip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

function attachment(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return "attachment; filename=\"" + ascii + "\"; filename*=UTF-8''" + encodeURIComponent(filename);
}

function safeName(title: string, ext: string): string {
  const base = title.replace(/[\\/:*?"<>|]/g, "-").trim() || "article";
  return base + ext;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; articleId: string }> },
) {
  const { id, articleId } = await params;
  const format = new URL(req.url).searchParams.get("format") === "zip" ? "zip" : "md";
  const rt = getRuntime();
  const task = rt.store.get(id);
  if (!task) return Response.json({ error: "任务不存在" }, { status: 404 });
  const record = rt.articles.get(articleId);
  if (!record || record.taskId !== id) return Response.json({ error: "文章不存在" }, { status: 404 });
  const article = record.content;
  if (record.status !== "done" || !article) {
    return Response.json({ error: "文章尚未生成完成" }, { status: 409 });
  }

  const dir = taskDir(rt.dataDir, id);
  let transcript: Transcript | null = null;
  try {
    transcript = JSON.parse(await readFile(transcriptPath(dir), "utf8")) as Transcript;
  } catch {
    transcript = null;
  }
  const manifest = await readFrameManifest(dir);
  const citations = buildCitationIndex(transcript, manifest);
  const frameIds = collectFrameIds(article);
  const frameById = new Map((manifest?.frames ?? []).map((frame) => [frame.id, frame]));

  const images = new Map<string, string>();
  const assets: Array<{ name: string; data: Buffer }> = [];
  let index = 0;
  for (const frameId of frameIds) {
    const frame = frameById.get(frameId);
    if (!frame) continue;
    const bytes = await readFile(path.join(dir, path.normalize(frame.file))).catch(() => null);
    if (!bytes) continue;
    index += 1;
    const ext = path.extname(frame.file).toLowerCase() || ".jpg";
    if (format === "zip") {
      const name = "images/frame-" + String(index).padStart(3, "0") + ext;
      images.set(frameId, name);
      assets.push({ name, data: bytes });
    } else {
      const mime = MIME[ext] ?? "image/jpeg";
      images.set(frameId, "data:" + mime + ";base64," + bytes.toString("base64"));
    }
  }

  const md = renderArticleMarkdown({
    article,
    detailLevel:
      record.detailLevel === "concise" ? "速览" : record.detailLevel === "detailed" ? "深入" : "标准",
    purpose: record.purpose,
    model: record.model,
    sourceUrl: task.sourceUrl ?? null,
    citations,
    images,
  });

  const title = record.title ?? article.title;
  if (format === "md") {
    return new Response(md, {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": attachment(safeName(title, ".md")),
      },
    });
  }

  const sources = {
    source: { title: task.sourceTitle ?? task.originalName, url: task.sourceUrl ?? null },
    citations: Object.fromEntries(
      Array.from(citations.values()).map((c) => [
        c.id,
        {
          kind: c.kind,
          time_ms: Math.round(c.timeSec * 1000),
          end_ms: c.endSec === undefined ? null : Math.round(c.endSec * 1000),
        },
      ]),
    ),
    frames: frameIds.map((frameId) => ({
      id: frameId,
      file: images.get(frameId) ?? null,
      time_ms: frameById.get(frameId) ? Math.round((frameById.get(frameId)?.tSec ?? 0) * 1000) : null,
    })),
    generation_model: record.model,
    published_at: record.createdAt,
  };

  const zip = createZip([
    { name: "article.md", data: Buffer.from(md, "utf8") },
    ...assets,
    { name: "sources.json", data: Buffer.from(JSON.stringify(sources, null, 2), "utf8") },
  ]);
  return new Response(new Uint8Array(zip), {
    headers: {
      "content-type": "application/zip",
      "content-disposition": attachment(safeName(title, ".zip")),
    },
  });
}
