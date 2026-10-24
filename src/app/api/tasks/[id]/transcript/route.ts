import { readFile } from "node:fs/promises";
import { getRuntime } from "@/server/runtime";
import { deviceOwner } from "@/server/owner";

import { taskDir, transcriptPath } from "@/server/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { store, dataDir } = getRuntime();
  const task = store.getOwned(id, deviceOwner(req));
  if (!task) {
    return Response.json({ error: "任务不存在" }, { status: 404 });
  }
  try {
    const raw = await readFile(transcriptPath(taskDir(dataDir, id)), "utf8");
    return new Response(raw, {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  } catch {
    return Response.json({ error: "转录稿尚未生成" }, { status: 404 });
  }
}
