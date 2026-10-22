import { NextResponse, type NextRequest } from "next/server";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

/** 复用客户端/网关传来的合法 request id，否则生成新的 */
export function resolveRequestId(incoming: string | null): string {
  return incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : crypto.randomUUID();
}

/**
 * 为 /api/* 统一注入 request id：
 * - 写回请求头，供 Route Handler / 服务层日志使用
 * - 写回响应头，前端可在 Network 中直接看到并反馈
 */
export function proxy(request: NextRequest) {
  const requestId = resolveRequestId(request.headers.get("x-request-id"));
  const headers = new Headers(request.headers);
  headers.set("x-request-id", requestId);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set("x-request-id", requestId);
  return response;
}

export const config = {
  matcher: "/api/:path*",
};
