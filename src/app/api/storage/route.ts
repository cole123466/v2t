import { storageStats } from "@/server/maintenance";
import { getRuntime } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const stats = await storageStats(getRuntime());
  return Response.json(stats);
}
