import { getRuntime } from "@/server/runtime";
import { deviceOwner } from "@/server/owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { store } = getRuntime();
  const owner = deviceOwner(req);
  // 升级后第一次有设备来取列表：把无主的历史任务认领给它，免得老任务凭空消失。
  // 之后 owner 已全部有值，这条 UPDATE 命中 0 行。
  store.claimLegacy(owner);
  return Response.json({ tasks: store.list(owner) });
}
