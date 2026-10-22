import { describe, expect, it } from "vitest";
import { parseInline } from "@/server/article";

describe("行内解析", () => {
  it("纯文本", () => {
    expect(parseInline("一段普通文字")).toEqual([{ kind: "text", text: "一段普通文字", marks: [] }]);
  });

  it("粗体、斜体与代码", () => {
    expect(parseInline("**粗体** *斜体* `code`")).toEqual([
      { kind: "text", text: "粗体", marks: ["bold"] },
      { kind: "text", text: " ", marks: [] },
      { kind: "text", text: "斜体", marks: ["emphasis"] },
      { kind: "text", text: " ", marks: [] },
      { kind: "text", text: "code", marks: ["code"] },
    ]);
  });

  it("引用 token 渲染为 cite，时间与画面都识别", () => {
    expect(parseInline("见 [[t01]] 与 [[f02]]")).toEqual([
      { kind: "text", text: "见 ", marks: [] },
      { kind: "cite", id: "t01" },
      { kind: "text", text: " 与 ", marks: [] },
      { kind: "cite", id: "f02" },
    ]);
  });

  it("链接只接受 http(s)，其余保留为文本", () => {
    expect(parseInline("[官网](https://example.com/a)")).toEqual([
      { kind: "link", href: "https://example.com/a", text: "官网", marks: [] },
    ]);
    expect(parseInline("[坏链](javascript:alert(1))")).toEqual([
      { kind: "text", text: "[坏链](javascript:alert(1))", marks: [] },
    ]);
  });

  it("粗体包裹引用时引用仍能解析", () => {
    expect(parseInline("**见 [[t01]]**")).toEqual([
      { kind: "text", text: "见 ", marks: ["bold"] },
      { kind: "cite", id: "t01" },
    ]);
  });

  it("代码里的 Markdown 标记不再解析", () => {
    expect(parseInline("`**x**`")).toEqual([{ kind: "text", text: "**x**", marks: ["code"] }]);
  });

  it("未闭合标记保持字面量", () => {
    expect(parseInline("**未闭合")).toEqual([{ kind: "text", text: "**未闭合", marks: [] }]);
    expect(parseInline("2 * 3")).toEqual([{ kind: "text", text: "2 * 3", marks: [] }]);
  });
});
