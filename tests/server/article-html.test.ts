import { describe, expect, it } from "vitest";
import type { Article } from "@/server/article";
import { escapeHtml, isSafeHref, renderArticleHtml } from "@/server/article-html";

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

const renderWith = (mindMap: Article["mindMap"], title = "导图测试"): string =>
  renderArticleHtml({
    article: { ...article, title, mindMap },
    detailLevel: "标准",
    purpose: null,
    model: "glm-4.6",
    sourceUrl: null,
    publishedAt: "2026-10-24T10:00:00.000Z",
    citations,
    images: new Map(),
  });

const svgOf = (out: string): string => {
  const start = out.indexOf("<svg");
  const end = out.indexOf("</svg>");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return out.slice(start, end + "</svg>".length);
};

describe("内容导图 SVG", () => {
  it("完整树以单个静态 SVG 渲染，含节点标签与连线", () => {
    const out = renderWith([
      { label: "根", children: [{ label: "主题甲", children: [{ label: "子级乙" }] }] },
    ]);
    const svg = svgOf(out);
    expect(svg).toContain('role="img"');
    expect(svg).toContain('aria-label="内容导图"');
    expect(svg).toMatch(/viewBox="0 0 [\d.]+ [\d.]+"/);
    expect(svg).toContain("<path d=\"M ");
    expect(svg).toContain('fill="none"');
    expect(svg).toContain("导图测试");
    expect(svg).toContain("根");
    expect(svg).toContain("主题甲");
    // 三级全部出现，证明是完整树而不是星形概览
    expect(svg).toContain("子级乙");
    expect(out).toContain('<p class="mindmap-outline-title">文字大纲</p>');
    expect(out).toContain("<ul><li>");
  });

  it("mindMap 为空时不输出 svg", () => {
    const out = renderWith([]);
    expect(out).not.toContain("<svg");
    expect(out).not.toContain('class="mindmap"');
  });

  it("命中章节的节点带 #section-N 内部锚点，href 仅限内部锚点", () => {
    const out = renderWith([{ label: "根", children: [{ label: "子", sectionId: "s1" }] }]);
    const svg = svgOf(out);
    expect(svg).toContain('<a href="#section-1">');
    const hrefs = Array.from(svg.matchAll(/href="([^"]*)"/g), (m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) expect(href).toMatch(/^#section-\d+$/);
  });

  it("节点标签与属性全部转义，不输出原始标签", () => {
    const out = renderWith([{ label: `A<b>&"'`, children: [{ label: "子" }] }]);
    const svg = svgOf(out);
    expect(svg).not.toContain("<b>");
    expect(svg).toContain("A&lt;b&gt;&amp;&quot;&#39;");
    expect(out).not.toMatch(/<script/i);
  });

  it("SVG 显式尺寸落在 A4 打印上限内", () => {
    const out = renderWith([
      { label: "根", children: [{ label: "子", children: [{ label: "孙" }] }] },
    ]);
    const svg = svgOf(out);
    const size = svg.match(/<svg[^>]* width="(\d+)" height="(\d+)"/);
    expect(size).not.toBeNull();
    const width = Number(size![1]);
    const height = Number(size![2]);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    expect(width).toBeLessThanOrEqual(640);
    expect(height).toBeLessThanOrEqual(820);
  });

  it("导图 SVG 尺寸由属性决定，CSS 不铺满容器（防止 PDF 超出单页）", () => {
    const out = renderWith([
      { label: "根", children: [{ label: "主题甲", children: [{ label: "子级乙" }] }] },
    ]);
    // 服务端按 A4 等比缩放后把尺寸写进 SVG 的 width/height 属性。
    // 若 CSS 再写 width:100%/height:auto，浏览器会按 viewBox 比例把高度推回容器宽度对应值，
    // 突破封顶高度；.mindmap/.mindmap-figure 又设了 break-inside:avoid，导图下半部分会被裁掉。
    const rules = Array.from(out.matchAll(/\.mindmap-figure svg\{([^}]*)\}/g), (m) => m[1]);
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule).not.toMatch(/(?:^|;)\s*width\s*:\s*100%/);
      expect(rule).not.toMatch(/(?:^|;)\s*height\s*:\s*auto/);
    }
    expect(rules[0]).toContain("max-width:100%");
    const svg = svgOf(out);
    const size = svg.match(/<svg[^>]* width="(\d+)" height="(\d+)"/);
    const box = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
    expect(size).not.toBeNull();
    expect(box).not.toBeNull();
    const width = Number(size![1]);
    const height = Number(size![2]);
    expect(width).toBeLessThanOrEqual(640);
    expect(height).toBeLessThanOrEqual(820);
    // 属性尺寸必须是 viewBox 的等比缩放，保证高度封顶真实生效
    expect(Math.abs(width / Number(box![1]) - height / Number(box![2]))).toBeLessThan(0.01);
  });

  it("大导图（90 主题）也能容纳且不超上限", () => {
    const mindMap = Array.from({ length: 90 }, (_, i) => ({
      label: `主题 ${i + 1}`,
      children: [{ label: `要点 ${i + 1}` }],
    }));
    // 顶部根数受 MIND_MAX_NODES=96 限制，这里会截断但不该抛错
    const out = renderWith(mindMap);
    const svg = svgOf(out);
    const size = svg.match(/<svg[^>]* width="(\d+)" height="(\d+)"/);
    expect(size).not.toBeNull();
    expect(Number(size![1])).toBeLessThanOrEqual(640);
    expect(Number(size![2])).toBeLessThanOrEqual(820);
  });
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

  it("链接协议白名单只放行 http(s)、mailto、tel 与相对地址", () => {
    expect(isSafeHref("https://example.com/a")).toBe(true);
    expect(isSafeHref("HTTP://example.com/a")).toBe(true);
    expect(isSafeHref("mailto:a@b.com")).toBe(true);
    expect(isSafeHref("tel:+8613800000000")).toBe(true);
    expect(isSafeHref("/relative/path")).toBe(true);
    expect(isSafeHref("//cdn.example.com/x")).toBe(true);
    expect(isSafeHref("#anchor")).toBe(true);
    expect(isSafeHref("?q=1")).toBe(true);

    expect(isSafeHref("javascript:alert(1)")).toBe(false);
    expect(isSafeHref("JaVaScRiPt:alert(1)")).toBe(false);
    expect(isSafeHref("  java\tscript:alert(1)")).toBe(false);
    expect(isSafeHref("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isSafeHref("vbscript:msgbox(1)")).toBe(false);
    expect(isSafeHref("ftp://example.com/x")).toBe(false);
  });

  it("伪协议链接降级为纯文本，安全链接正常渲染", () => {
    const renderText = (text: string): string =>
      renderArticleHtml({
        article: {
          ...article,
          sections: [{ id: "s1", title: "第一章", blocks: [{ type: "paragraph", text }] }],
          mindMap: [],
          limitations: [],
        },
        detailLevel: "标准",
        purpose: null,
        model: "glm-4.6",
        sourceUrl: null,
        publishedAt: "2026-10-24T10:00:00.000Z",
        citations: new Map(),
        images: new Map(),
      });

    const safe = renderText("[官网](https://example.com/x)");
    expect(safe).toContain('<a class="link" href="https://example.com/x"');

    const bad = renderText("[点我](javascript:alert(1))");
    expect(bad).not.toContain('<a class="link"');
    expect(bad).not.toContain('href="javascript');
    expect(bad).toContain("javascript:alert(1)");

    const data = renderText("[点我](data:text/html,<script>alert(1)</script>)");
    expect(data).not.toContain('<a class="link"');
    expect(data).not.toContain('href="data:');
  });
});
