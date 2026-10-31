import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match.js";
import { config, proxy, resolveRequestId } from "@/proxy";
import { requestId } from "@/server/request";

describe("request id 代理", () => {
  it("匹配 /api/* 但排除 /api/upload（上传绕开 body 克隆走纯流式）", () => {
    expect(config.matcher).toBe("/api/((?!upload).*)");
    // 用 Next 编译 matcher 的同一实现验证，避免裸 RegExp 与 path-to-regexp 语义差异
    const match = getPathMatch(config.matcher);
    expect(match("/api/tasks")).toBeTruthy();
    expect(match("/api/upload")).toBeFalsy();
    expect(match("/api/upload/anything")).toBeFalsy();
    expect(match("/api/uploads")).toBeFalsy();
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
