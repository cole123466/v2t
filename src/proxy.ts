import { NextResponse, type NextRequest } from "next/server";
import { DEVICE_COOKIE, isDeviceId } from "@/server/owner";

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

  // 设备归属：首次访问签发一个随机 ID，之后随请求头透传给 route handler，
  // 同时写回响应 cookie，让同一浏览器的后续请求都带着它。
  const existing = request.cookies.get(DEVICE_COOKIE)?.value;
  const device = isDeviceId(existing) ? existing.toLowerCase() : crypto.randomUUID();
  headers.set("cookie", withDeviceCookie(request.headers.get("cookie"), device));

  const response = NextResponse.next({ request: { headers } });
  response.headers.set("x-request-id", requestId);
  // 只在首次（或 cookie 失效）时下发：每个响应都重发 Set-Cookie 会让
  // 客户端认为会话一直在变，dev 下会触发反复刷新。
  if (!isDeviceId(existing)) {
    response.cookies.set(DEVICE_COOKIE, device, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
      secure: request.nextUrl.protocol === "https:",
    });
  }
  return response;
}

/** 用签发的设备 ID 覆盖请求里的同名 cookie，避免旧值继续透传 */
function withDeviceCookie(header: string | null, device: string): string {
  const kept = (header ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith(`${DEVICE_COOKIE}=`));
  kept.push(`${DEVICE_COOKIE}=${device}`);
  return kept.join("; ");
}

export const config = {
  matcher: "/api/:path*",
};
