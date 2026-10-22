export const REQUEST_ID_HEADER = "x-request-id";

/** Route Handler 内读取代理注入的 request id；缺失时返回 undefined，不阻塞业务 */
export function requestId(req: Request): string | undefined {
  return req.headers.get(REQUEST_ID_HEADER) ?? undefined;
}
