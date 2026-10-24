import {
  normalizeArticle,
  parseInline,
  type Article,
  type ArticleBlock,
  type Inline,
  type InlineMark,
  type MindMapNode,
} from "./article";
import { clock, type ExportCitation } from "./export";

/**
 * 文章 HTML 导出：把结构化文章渲染成自包含、带打印样式的单页 HTML。
 * 同一份产物用于「下载 HTML」与「导出 PDF」（浏览器打印 → 另存为 PDF）。
 *
 * 不引入 puppeteer / jsPDF：前者要捆绑数百 MB Chromium，后者中文需要内嵌大字体
 * 且输出是位图。浏览器打印是矢量文本、原生中文字体、零新依赖。
 *
 * 所有正文都来自模型输出，拼接前一律转义；本模块不向 HTML 输出任何原始标签。
 */

export type ArticleHtmlMode = "document" | "print";

export interface ArticleHtmlInput {
  article: Article;
  detailLevel: string;
  purpose: string | null;
  model: string;
  sourceUrl: string | null;
  /** 生成时间（ISO），只取日期部分展示 */
  publishedAt: string;
  citations: Map<string, ExportCitation>;
  /** frameId → data URL；缺失时渲染占位而不是破图 */
  images: Map<string, string>;
  /** print：带「打印 / 另存为 PDF」工具栏并自动唤起打印面板 */
  mode: ArticleHtmlMode;
}

const HTML_ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPE[ch]);
}

function withTime(url: string, sec: number): string {
  try {
    const u = new URL(url);
    u.searchParams.set("t", String(Math.max(0, Math.floor(sec))));
    return u.toString();
  } catch {
    return url;
  }
}

interface RenderContext {
  citations: Map<string, ExportCitation>;
  images: Map<string, string>;
  sourceUrl: string | null;
  /** 时间引用按首次出现顺序编号，供文末「来源」列表使用 */
  order: string[];
  numbers: Map<string, number>;
}

function numberFor(id: string, ctx: RenderContext): number {
  const existing = ctx.numbers.get(id);
  if (existing !== undefined) return existing;
  ctx.order.push(id);
  const next = ctx.order.length;
  ctx.numbers.set(id, next);
  return next;
}

function applyMarks(html: string, marks: InlineMark[]): string {
  let out = html;
  if (marks.includes("code")) out = `<code>${out}</code>`;
  if (marks.includes("bold")) out = `<strong>${out}</strong>`;
  if (marks.includes("emphasis")) out = `<em>${out}</em>`;
  return out;
}

function renderCite(id: string, ctx: RenderContext): string {
  // 画面引用由 figure 块承载，正文里不占位置
  if (id.startsWith("f")) return "";
  const info = ctx.citations.get(id);
  if (!info) {
    return `<span class="cite cite-missing" title="${escapeHtml(`出处 ${id} 无法核实`)}">${escapeHtml(id)}</span>`;
  }
  const num = `<span class="cite-num">${numberFor(id, ctx)}</span>`;
  const title = escapeHtml(`转写段 ${id} · ${clock(info.timeSec)}`);
  const href = ctx.sourceUrl ? withTime(ctx.sourceUrl, info.timeSec) : null;
  return href
    ? `<a class="cite" href="${escapeHtml(href)}" title="${title}">${num}</a>`
    : `<span class="cite" title="${title}">${num}</span>`;
}

function renderInlinePart(part: Inline, ctx: RenderContext): string {
  if (part.kind === "cite") return renderCite(part.id, ctx);
  if (part.kind === "link") {
    const href = part.href.replace(/[<>"']/g, (ch) => encodeURIComponent(ch));
    return `<a class="link" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${applyMarks(
      escapeHtml(part.text),
      part.marks,
    )}</a>`;
  }
  return applyMarks(escapeHtml(part.text), part.marks);
}

function renderInline(text: string, ctx: RenderContext): string {
  return parseInline(text).map((part) => renderInlinePart(part, ctx)).join("");
}

/** 富文本 → 纯文本（图片 alt 等只能放纯文本的位置） */
function plainText(text: string): string {
  return parseInline(text)
    .map((part) => (part.kind === "cite" ? "" : part.text))
    .join("")
    .trim();
}

function renderBlock(block: ArticleBlock, ctx: RenderContext): string {
  switch (block.type) {
    case "paragraph": {
      const html = renderInline(block.text, ctx).trim();
      return html ? `<p>${html}</p>` : "";
    }
    case "quote": {
      const html = block.text
        .split(/\r?\n/)
        .map((line) => renderInline(line, ctx).trim())
        .filter(Boolean)
        .join("<br>");
      return html ? `<blockquote>${html}</blockquote>` : "";
    }
    case "list": {
      const tag = block.ordered ? "ol" : "ul";
      const items = block.items
        .map((item) => `<li>${renderInline(item, ctx).trim()}</li>`)
        .filter((item) => item !== "<li></li>");
      return items.length > 0 ? `<${tag}>${items.join("")}</${tag}>` : "";
    }
    case "code": {
      const lang = (block.lang ?? "").replace(/[^\w+#.-]/g, "");
      const label = lang ? `<div class="code-lang">${escapeHtml(lang)}</div>` : "";
      return `<div class="code">${label}<pre><code>${escapeHtml(block.text)}</code></pre></div>`;
    }
    case "table": {
      if (block.header.length === 0) return "";
      const head = `<tr>${block.header
        .map((cell) => `<th>${renderInline(cell, ctx).trim()}</th>`)
        .join("")}</tr>`;
      const body = block.rows
        .map(
          (row) =>
            `<tr>${row.map((cell) => `<td>${renderInline(cell, ctx).trim()}</td>`).join("")}</tr>`,
        )
        .join("");
      const caption = block.caption
        ? `<figcaption>${renderInline(block.caption, ctx).trim()}</figcaption>`
        : "";
      return `<figure class="table-wrap"><table><thead>${head}</thead>${
        body ? `<tbody>${body}</tbody>` : ""
      }</table>${caption}</figure>`;
    }
    case "figure": {
      const info = ctx.citations.get(block.frameId);
      const src = ctx.images.get(block.frameId);
      // 图片本身也是一条出处，登记到文末来源列表
      if (info) numberFor(block.frameId, ctx);
      const alt = plainText(block.caption ?? `画面 ${block.frameId}`) || `画面 ${block.frameId}`;
      const image = src
        ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}">`
        : `<div class="figure-missing">画面 ${escapeHtml(block.frameId)} 不可用</div>`;
      const body = block.caption
        ? renderInline(block.caption, ctx).trim()
        : escapeHtml(`画面 ${block.frameId}`);
      const stamp = info ? `<span class="fig-time">${clock(info.timeSec)}</span>` : "";
      return `<figure class="figure">${image}<figcaption>${body}${stamp}</figcaption></figure>`;
    }
  }
}

function renderMindMap(nodes: MindMapNode[], sectionNumber: Map<string, number>): string {
  if (nodes.length === 0) return "";
  const items = nodes
    .map((node) => {
      const index = node.sectionId ? sectionNumber.get(node.sectionId) : undefined;
      const label = escapeHtml(node.label);
      const inner = index
        ? `<a href="#section-${index}">${label}</a>`
        : `<span>${label}</span>`;
      const children = node.children?.length
        ? renderMindMap(node.children, sectionNumber)
        : "";
      return `<li>${inner}${children}</li>`;
    })
    .join("");
  return `<ul>${items}</ul>`;
}

function sectionLabel(index: number): string {
  return String(index + 1).padStart(2, "0");
}

const STYLE = `
:root{
  --ink:#1a1712;
  --dim:#4a443c;
  --faint:#7b746a;
  --gold:#8a6114;
  --line:#e6dfd2;
  --wash:#faf6ee;
  --bg:#fffdf9;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;
  background:#efeae0;
  color:var(--ink);
  font-family:"Noto Serif SC","Source Han Serif SC","Songti SC",Georgia,ui-serif,serif;
  font-size:16px;
  line-height:1.9;
  -webkit-font-smoothing:antialiased;
}
.page{
  max-width:820px;
  margin:0 auto;
  padding:56px 64px 72px;
  background:var(--bg);
  box-shadow:0 1px 3px rgb(26 23 18 / .08);
}
.kicker{
  margin:0 0 14px;
  font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;
  font-size:11px;
  letter-spacing:.24em;
  text-transform:uppercase;
  color:var(--gold);
}
h1{
  margin:0;
  font-size:34px;
  line-height:1.35;
  letter-spacing:.01em;
  font-weight:700;
}
.meta{
  margin:16px 0 0;
  padding:0 0 20px;
  border-bottom:1px solid var(--line);
  color:var(--faint);
  font-size:13px;
  line-height:1.8;
}
.meta span+span::before{content:"·";margin:0 .55em;color:var(--line)}
.meta a{color:var(--gold)}
.toc{
  margin:30px 0 0;
  padding:18px 22px;
  border:1px solid var(--line);
  border-radius:12px;
  background:var(--wash);
}
.toc-title{
  margin:0 0 10px;
  font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;
  font-size:11px;
  letter-spacing:.2em;
  color:var(--faint);
}
.toc ol{list-style:none;margin:0;padding:0;columns:2;column-gap:32px}
.toc li{margin:0 0 6px;font-size:14px;break-inside:avoid}
.toc a{color:var(--dim);text-decoration:none}
.toc a:hover{color:var(--gold)}
.toc-num{
  display:inline-block;
  width:2.2em;
  font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;
  font-size:11px;
  color:var(--gold);
}
.article{margin-top:36px}
.article>section+section{
  margin-top:40px;
  padding-top:32px;
  border-top:1px solid var(--line);
}
h2{
  display:flex;
  align-items:baseline;
  gap:12px;
  margin:0 0 18px;
  font-size:22px;
  line-height:1.5;
  font-weight:700;
  break-after:avoid;
}
.sec-num{
  font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;
  font-size:12px;
  letter-spacing:.12em;
  color:var(--gold);
}
p{
  margin:0 0 .95em;
  color:var(--dim);
  text-align:justify;
  text-justify:inter-ideograph;
}
section>p:last-child{margin-bottom:0}
blockquote{
  margin:1.4em 0;
  padding:16px 20px;
  border-left:3px solid var(--gold);
  border-radius:0 10px 10px 0;
  background:var(--wash);
  color:var(--dim);
  font-style:normal;
  break-inside:avoid;
}
blockquote p{margin:0}
ul,ol{margin:0 0 1.15em;padding-left:1.5em;color:var(--dim)}
li{margin:0 0 .4em;padding-left:.15em}
li::marker{color:var(--gold)}
ol>li::marker{font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;font-size:.85em}
code{
  padding:.1em .35em;
  border-radius:4px;
  background:rgb(22 19 14 / .06);
  font-family:ui-monospace,"Cascadia Mono",Consolas,"JetBrains Mono",monospace;
  font-size:.88em;
  color:var(--ink);
}
.code{
  margin:1.4em 0;
  overflow:hidden;
  border:1px solid var(--line);
  border-radius:12px;
  background:#f8f5ee;
  break-inside:avoid;
}
.code-lang{
  padding:7px 14px;
  border-bottom:1px solid var(--line);
  font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;
  font-size:10px;
  letter-spacing:.16em;
  text-transform:uppercase;
  color:var(--faint);
}
pre{margin:0;padding:14px 16px;overflow-x:auto}
pre code{padding:0;background:none;font-size:13px;line-height:1.7}
.table-wrap{
  margin:1.4em 0;
  overflow:hidden;
  border:1px solid var(--line);
  border-radius:12px;
  break-inside:avoid;
}
table{width:100%;border-collapse:collapse;font-size:14px;line-height:1.7}
th{
  padding:10px 14px;
  background:var(--wash);
  border-bottom:1px solid var(--line);
  text-align:left;
  font-weight:600;
  color:var(--ink);
  white-space:nowrap;
}
td{
  padding:10px 14px;
  border-bottom:1px solid rgb(230 223 210 / .6);
  color:var(--dim);
  vertical-align:top;
}
tbody tr:last-child td{border-bottom:0}
tbody tr:nth-child(even){background:rgb(250 246 238 / .55)}
.table-wrap figcaption{padding:8px 14px;border-top:1px solid var(--line);font-size:12px;color:var(--faint)}
.figure{
  margin:1.6em 0;
  overflow:hidden;
  border:1px solid var(--line);
  border-radius:14px;
  background:var(--wash);
  break-inside:avoid;
}
.figure img{display:block;width:100%;height:auto}
.figure-missing{padding:48px 16px;text-align:center;font-size:13px;color:var(--faint)}
.figure figcaption{
  display:flex;
  align-items:baseline;
  justify-content:space-between;
  gap:16px;
  padding:9px 14px;
  border-top:1px solid var(--line);
  font-size:12px;
  line-height:1.7;
  color:var(--dim);
}
.fig-time{
  flex:none;
  font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;
  font-size:11px;
  color:var(--faint);
}
.cite{
  display:inline-block;
  margin:0 .12em;
  font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;
  font-size:9px;
  line-height:1.5;
  vertical-align:super;
  color:var(--gold);
  text-decoration:none;
}
.cite-num::before{content:"["}
.cite-num::after{content:"]"}
.cite:hover{text-decoration:underline}
.cite-missing{color:#a8443f}
.link{color:var(--gold);text-decoration:underline;text-underline-offset:2px;text-decoration-color:rgb(138 97 20 / .4)}
.mindmap{
  margin:2.4em 0 0;
  padding:18px 22px;
  border:1px solid var(--line);
  border-radius:12px;
  background:var(--wash);
  font-size:14px;
}
.mindmap-title{
  margin:0 0 10px;
  font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;
  font-size:11px;
  letter-spacing:.2em;
  color:var(--faint);
}
.mindmap ul{list-style:none;margin:0;padding-left:16px;border-left:1px solid var(--line)}
.mindmap>ul{padding-left:0;border-left:0}
.mindmap li{margin:0 0 .35em}
.mindmap a{color:var(--dim);text-decoration:none}
.mindmap a:hover{color:var(--gold)}
.limitations{
  margin:2.4em 0 0;
  padding:18px 22px;
  border:1px solid rgb(138 97 20 / .28);
  border-radius:12px;
  background:rgb(250 246 238 / .7);
}
.limitations-title{
  margin:0 0 8px;
  font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;
  font-size:11px;
  letter-spacing:.2em;
  color:var(--gold);
}
.limitations ul{margin:0;padding-left:1.2em;font-size:14px}
.sources{margin-top:44px;padding-top:28px;border-top:1px solid var(--line)}
.sources h2{font-size:15px;letter-spacing:.08em;color:var(--faint)}
.sources ol{padding-left:1.6em;font-size:13px;color:var(--faint)}
.sources li{margin-bottom:.35em}
.sources .src-kind{
  display:inline-block;
  margin-right:.4em;
  padding:0 .4em;
  border:1px solid var(--line);
  border-radius:4px;
  font-size:11px;
}
.sources a{color:var(--gold);text-decoration:none}
footer{
  margin-top:40px;
  padding-top:16px;
  border-top:1px solid var(--line);
  font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;
  font-size:10px;
  letter-spacing:.18em;
  color:var(--faint);
  display:flex;
  justify-content:space-between;
}
.toolbar{
  position:sticky;
  top:0;
  z-index:10;
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:16px;
  padding:12px 20px;
  background:#1a1712;
  color:#efe9dd;
  font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
  font-size:13px;
  line-height:1.6;
}
.toolbar button{
  flex:none;
  padding:7px 16px;
  border:1px solid rgb(217 164 65 / .5);
  border-radius:8px;
  background:rgb(217 164 65 / .16);
  color:#e7bd6a;
  font:inherit;
  cursor:pointer;
}
.toolbar button:hover{background:rgb(217 164 65 / .28)}
@media (max-width:720px){
  .page{padding:32px 22px 48px}
  .toc ol{columns:1}
  h1{font-size:27px}
}
@media print{
  body{background:#fff}
  .page{max-width:none;margin:0;padding:0;box-shadow:none}
  .toolbar{display:none!important}
  h1,h2{color:#000}
  a{color:inherit;text-decoration:none}
  .cite{color:#7a5a12}
  .article>section+section{border-top-color:#ddd}
  .figure,.table-wrap,.code,blockquote,.toc,.mindmap,.limitations{break-inside:avoid}
}
@page{size:A4;margin:18mm 16mm}
`;

function renderDocument(input: ArticleHtmlInput, article: Article, body: string): string {
  const title = escapeHtml(article.title || "图文文章");
  const toolbar =
    input.mode === "print"
      ? `<div class="toolbar"><span>在打印面板里选择「另存为 PDF」即可导出；页边距已按 A4 优化。</span><button type="button" onclick="window.print()">打印 / 另存为 PDF</button></div>`
      : "";
  const autoPrint =
    input.mode === "print"
      ? `<script>window.addEventListener("load",function(){setTimeout(function(){window.print()},400)});</script>`
      : "";
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="generator" content="V2T">
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body>
${toolbar}
<main class="page">
${body}
</main>
${autoPrint}
</body>
</html>`;
}

/** 渲染整篇 HTML（自包含：样式内嵌、图片为 data URL、无外部资源） */
export function renderArticleHtml(input: ArticleHtmlInput): string {
  const article = normalizeArticle(input.article);
  const ctx: RenderContext = {
    citations: input.citations,
    images: input.images,
    sourceUrl: input.sourceUrl,
    order: [],
    numbers: new Map(),
  };

  const sectionNumber = new Map(article.sections.map((section, i) => [section.id, i + 1]));

  const meta: string[] = [
    `<span>解读详细程度：${escapeHtml(input.detailLevel)}</span>`,
    `<span>${article.sections.length} 章</span>`,
    `<span>生成模型：${escapeHtml(input.model)}</span>`,
  ];
  const published = input.publishedAt.slice(0, 10);
  if (published) meta.push(`<span>${escapeHtml(published)}</span>`);
  if (input.purpose) meta.push(`<span>本次关注点：${escapeHtml(input.purpose)}</span>`);
  if (input.sourceUrl) {
    meta.push(`<a href="${escapeHtml(input.sourceUrl)}" target="_blank" rel="noreferrer">打开原视频</a>`);
  }

  const toc =
    article.sections.length > 0
      ? `<nav class="toc"><p class="toc-title">目录</p><ol>${article.sections
          .map(
            (section, i) =>
              `<li><a href="#section-${i + 1}"><span class="toc-num">${sectionLabel(
                i,
              )}</span>${escapeHtml(section.title)}</a></li>`,
          )
          .join("")}</ol></nav>`
      : "";

  const sections = article.sections
    .map(
      (section, i) => `<section id="section-${i + 1}">
<h2><span class="sec-num">${sectionLabel(i)}</span>${escapeHtml(section.title)}</h2>
${section.blocks.map((block) => renderBlock(block, ctx)).filter(Boolean).join("\n")}
</section>`,
    )
    .join("\n");

  // 正文渲染完成后再输出引用编号，顺序与首次出现一致
  const sources =
    ctx.order.length > 0
      ? `<section class="sources"><h2>来源</h2><ol>${ctx.order
          .map((id) => {
            const info = ctx.citations.get(id);
            if (!info) return "";
            const label = info.kind === "t" ? "转写" : "画面";
            const url = input.sourceUrl ? withTime(input.sourceUrl, info.timeSec) : null;
            const stamp = url
              ? `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${clock(info.timeSec)}</a>`
              : clock(info.timeSec);
            const range = info.endSec !== undefined ? ` – ${clock(info.endSec)}` : "";
            return `<li><span class="src-kind">${label}</span>${stamp}${range}</li>`;
          })
          .filter(Boolean)
          .join("")}</ol></section>`
      : "";

  const mindMap =
    article.mindMap.length > 0
      ? `<section class="mindmap"><p class="mindmap-title">内容导图</p>${renderMindMap(
          article.mindMap,
          sectionNumber,
        )}</section>`
      : "";

  const limitations =
    article.limitations.length > 0
      ? `<section class="limitations"><p class="limitations-title">未确认之处</p><ul>${article.limitations
          .map((item) => `<li>${renderInline(item.text, ctx).trim()}</li>`)
          .join("")}</ul></section>`
      : "";

  const body = `<header>
<p class="kicker">V2T · 图文解读</p>
<h1>${escapeHtml(article.title)}</h1>
<p class="meta">${meta.join("")}</p>
</header>
${toc}
<article class="article">
${sections}
</article>
${mindMap}
${limitations}
${sources}
<footer><span>V2T · 视频转文案工作站</span><span>${escapeHtml(published)}</span></footer>`;

  return renderDocument(input, article, body);
}
