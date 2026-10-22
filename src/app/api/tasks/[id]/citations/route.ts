import { readFile } from "node:fs/promises";
import type { Transcript } from "@/server/asr";
import type { FrameManifest } from "@/server/frames";
import { taskDir, transcriptPath } from "@/server/paths";
import { readFrameManifest } from "@/server/frames";
import { getRuntime } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 引用目录：供前端把 [[tNN]] / [[fNN]] 渲染成可点击芯片并跳转。
 * 只暴露编号与时间点，不回传全文（转写稿走独立端点）。
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const rt = getRuntime();
  const task = rt.store.get(id);
  if (!task) return Response.json({ error: "任务不存在" }, { status: 404 });

  const dir = taskDir(rt.dataDir, id);
  let transcript: Transcript | null = null;
  try {
    transcript = JSON.parse(await readFile(transcriptPath(dir), "utf8")) as Transcript;
  } catch {
    transcript = null;
  }
  const manifest: FrameManifest | null = await readFrameManifest(dir);

  return Response.json({
    durationSec: transcript?.durationSec ?? task.durationSec ?? 0,
    timeCitations: (transcript?.segments ?? []).map((s, i) => ({
      id: `t${String(i + 1).padStart(2, "0")}`,
      start: s.start,
      end: s.end,
    })),
    frames: (manifest?.frames ?? []).map((f) => ({ id: f.id, tSec: f.tSec, hasFile: true })),
  });
}
