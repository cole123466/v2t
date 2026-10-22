import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RequestIdLine } from "@/components/workbench/request-id";

describe("错误框的 request id", () => {
  it("有编号时可见且可选中复制", () => {
    const html = renderToStaticMarkup(createElement(RequestIdLine, { id: "trace-sse-12345678" }));
    expect(html).toContain("请求 ID：trace-sse-12345678");
    expect(html).toContain("select-all");
    expect(html).toContain('title="排查问题时请提供此编号"');
  });

  it("没有编号时不渲染多余内容", () => {
    expect(renderToStaticMarkup(createElement(RequestIdLine, { id: null }))).toBe("");
  });
});
