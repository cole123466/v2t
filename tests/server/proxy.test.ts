import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { config, proxy, resolveRequestId } from "@/proxy";
import { requestId } from "@/server/request";

describe("request id 代理", () => {
  it("只匹配 /api/*", () => {
    expect(config.matcher).toBe("/api/:path*");
  });

  it("没有请求头时生成 UUID 并写回响应头", () => {
    const response = proxy(new NextRequest("http://localhost/api/tasks"));
    expect(response.headers.get("x-request-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("复用合法的上游 request id", () => {
    const response = proxy(
      new NextRequest("http://localhost/api/tasks", {
        headers: { "x-request-id": "trace-12345678" },
      }),
    );
    expect(response.headers.get("x-request-id")).toBe("trace-12345678");
  });

  it("拒绝超长或含空白的 request id", () => {
    expect(resolveRequestId("bad id")).not.toBe("bad id");
    expect(resolveRequestId("x".repeat(129))).not.toBe("x".repeat(129));
    expect(resolveRequestId(null)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("Route Handler 能读到注入的 id", () => {
    const req = new Request("http://localhost/api/tasks", {
      headers: { "x-request-id": "trace-12345678" },
    });
    expect(requestId(req)).toBe("trace-12345678");
    expect(requestId(new Request("http://localhost/api/tasks"))).toBeUndefined();
  });
});
