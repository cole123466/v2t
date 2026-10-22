import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SourceNotice } from "@/components/workbench/source-notice";

describe("来源降级提示", () => {
  it("有提示时展示完整文案", () => {
    const text = "B 站触发了风控限制，已改用官方接口获取 720P 单文件。";
    const html = renderToStaticMarkup(createElement(SourceNotice, { text }));
    expect(html).toContain(text);
    expect(html).toContain("border-gold/25");
  });

  it("没有提示时不占位", () => {
    expect(renderToStaticMarkup(createElement(SourceNotice, { text: null }))).toBe("");
  });
});
