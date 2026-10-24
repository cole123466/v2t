/**
 * 设备归属。
 *
 * 服务端是单库单租户：所有任务都落在同一个 SQLite 里，没有账号体系。
 * 「不同端各看各的」靠一个随机设备 ID：proxy 在首次访问时下发 HttpOnly cookie，
 * 建任务时写进 tasks.owner，读任务时按 owner 过滤（别人的任务按不存在处理）。
 *
 * 这只是防串台的软隔离，不是鉴权：拿到 cookie 的人就能看到该设备的历史。
 */
export const DEVICE_COOKIE = "v2t-device";

const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isDeviceId(value: string | null | undefined): value is string {
  return !!value && DEVICE_ID.test(value);
}

/** 从 Cookie 头里取设备 ID（代理已下发时一定有；没有则返回空串 = 什么都看不到） */
export function deviceOwner(req: Request): string {
  const header = req.headers.get("cookie");
  if (!header) return "";
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== DEVICE_COOKIE) continue;
    const value = decodeURIComponent(part.slice(index + 1).trim());
    return isDeviceId(value) ? value.toLowerCase() : "";
  }
  return "";
}
