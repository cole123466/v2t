import { describe, expect, it } from "vitest";
import type { Article } from "@/server/article";
import { escapeHtml, renderArticleHtml } from "@/server/article-html";

const article: Article = {
  title: "测试 <文章> & 标题",
  sections: [
    {
      id: "s1",
      title: "第一章",
      blocks: [
        { type: "paragraph", text: "第一句 [[t01]]，坏引用 [[t99]]，**粗体** 与 `code`。" },
        { type: "quote", text: "原话 [[t02]]" },
        { type: "list", ordered: true, items: ["第一 [[t01]]", "第二"] },
        { type: "code", lang: "ts", text: 'const a = "<script>alert(1)</script>";' },
        {
          type: "table",
          header: ["列一", "列二"],
          rows: [["甲 [[t01]]", "乙 | 丙"]],
          caption: "表注",
        },
        { type: "figure", frameId: "f00", caption: "画面说明 [[t01]]" },
      ],
    },
  ],
  mindMap: [{ label: "根", children: [{ label: "子", sectionId: "s1" }] }],
  limitations: [{ text: "这里不确定 [[t02]]" }],
};

const citations = new Map([
  ["t01", { id: "t01", kind: "t" as const, timeSec: 2.5, endSec: 7.2 }],
  ["t02", { id: "t02", kind: "t" as const, timeSec: 65, endSec: 70 }],
  ["f00", { id: "f00", kind: "f" as const, timeSec: 19 }],
]);

const html = renderArticleHtml({
  article,
  detailLevel: "标准",
  purpose: "关注点 <x>",
  model: "glm-4.6",
  sourceUrl: "https://example.com/v?x=1",
  publishedAt: "2026-10-24T10:00:00.000Z",
  citations,
  images: new Map([["f00", "data:image/jpeg;base64,AAAA"]]),
});

describe("HTML 导出", () => {
  it("是自包含 HTML，带 A4 打印样式", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain("@page{size:A4");
    expect(html).toContain("@media print");
    // 自包含：没有外部 css/js 引用
    expect(html).not.toMatch(/<link[^>]+href=/);
    expect(html).not.toMatch(/<script[^>]+src=/);
  });

  it("不含工具栏与自动打印脚本：打印由前端 iframe 触发", () => {
    expect(html).not.toContain('class="toolbar"');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain("window.print()");
  });

  it("标题与元信息全部转义", () => {
    expect(html).toContain("测试 &lt;文章&gt; &amp; 标题");
    expect(html).toContain("关注点 &lt;x&gt;");
    expect(html).not.toContain("<文章>");
  });

  it("代码块原样转义，不会注入标签", () => {
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain('<div class="code-lang">ts</div>');
  });

  it("时间引用编号并链接到视频时间点，画面引用不出现在正文", () => {
    expect(html).toContain('<span class="cite-num">1</span>');
    expect(html).toMatch(/<a class="cite" href="https:\/\/example\.com\/v\?x=1(&amp;|&)t=2"/);
    expect(html).not.toContain("[[t01]]");
    expect(html).not.toContain("[[f00]]");
  });

  it("无法核实的引用渲染为 cite-missing", () => {
    expect(html).toContain('class="cite cite-missing"');
    expect(html).toContain("出处 t99 无法核实");
  });

  it("图片内联为 data URL，图注带时间", () => {
    expect(html).toContain('src="data:image/jpeg;base64,AAAA"');
    expect(html).toContain('<span class="fig-time">00:19</span>');
  });

  it("表格、引用、列表与导图结构完整", () => {
    expect(html).toContain("<table><thead><tr><th>列一</th><th>列二</th></tr></thead>");
    expect(html).toContain("<tbody><tr><td>甲 ");
    expect(html).toContain("<blockquote>原话 ");
    expect(html).toContain("<ol><li>第一 ");
    expect(html).toContain('<a href="#section-1">子</a>');
    expect(html).toContain('href="#section-1"');
  });

  it("文末来源按首次出现编号，图片出处也在列", () => {
    expect(html).toContain('<section class="sources">');
    expect(html).toContain('<span class="src-kind">转写</span>');
    expect(html).toContain('<span class="src-kind">画面</span>');
    // t01（正文首次出现=1）、t02（引用块/列表=2）、f00（图=3）
    const order = Array.from(
      html.matchAll(/<li><span class="src-kind">([^<]+)<\/span>/g),
      (m) => m[1],
    );
    expect(order).toEqual(["转写", "转写", "画面"]);
  });

  it("escapeHtml 覆盖五个特殊字符", () => {
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });
});
