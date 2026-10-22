import {
  blockText,
  normalizeArticle,
  parseInline,
  type Article,
  type ArticleBlock,
  type InlineMark,
  type MindMapNode,
} from "./article";
import type { FrameManifest } from "./frames";
import type { Transcript } from "./asr";

/** 导出时的引用索引：编号 → 类型与时间 */
export interface ExportCitation {
  id: string;
  kind: "t" | "f";
  timeSec: number;
  endSec?: number;
}

export interface ArticleExportInput {
  article: Article;
  detailLevel: string;
  purpose: string | null;
  model: string;
  sourceUrl: string | null;
  citations: Map<string, ExportCitation>;
  /** frameId → 图片地址（ZIP 里是 images/frame-001.jpg，单文件里是 data URL） */
  images: Map<string, string>;
}

const ESCAPE = /[\\*_[\]<>#!|~]/g;

function escapeText(text: string): string {
  return text.replace(ESCAPE, (ch) => "\\" + ch);
}

export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${String(m).padStart(2, "0")}:${ss}`;
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

/** 从转写稿与帧清单构建引用索引，与前端 /citations 端点保持一致 */
export function buildCitationIndex(
  transcript: Transcript | null,
  manifest: FrameManifest | null,
): Map<string, ExportCitation> {
  const map = new Map<string, ExportCitation>();
  (transcript?.segments ?? []).forEach((segment, i) => {
    const id = `t${String(i + 1).padStart(2, "0")}`;
    map.set(id, { id, kind: "t", timeSec: segment.start, endSec: segment.end });
  });
  for (const frame of manifest?.frames ?? []) {
    map.set(frame.id, { id: frame.id, kind: "f", timeSec: frame.tSec });
  }
  return map;
}

function inlineCode(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const ticks = "`".repeat(longest + 1);
  const pad = /^`|`$|^ | $/.test(text) ? " " : "";
  return ticks + pad + text + pad + ticks;
}

function codeFence(text: string, lang: string): string[] {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const ticks = "`".repeat(longest + 1);
  return [ticks + lang, text, ticks];
}

function applyMarks(text: string, marks: InlineMark[]): string {
  let out = marks.includes("code") ? inlineCode(text) : text;
  if (marks.includes("bold")) out = `**${out}**`;
  if (marks.includes("emphasis")) out = `*${out}*`;
  return out;
}

/** 正文引用到的画面 id，按出现顺序去重；figure 块与图注都算 */
export function collectFrameIds(source: Article): string[] {
  const article = normalizeArticle(source);
  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  const scan = (text: string) => {
    for (const match of text.matchAll(/\[\[(f\d{2,})\]\]/g)) add(match[1]);
  };
  for (const section of article.sections) {
    for (const block of section.blocks) {
      if (block.type === "code") continue;
      if (block.type === "figure") add(block.frameId);
      else scan(blockText(block));
    }
  }
  for (const limitation of article.limitations) scan(limitation.text);
  return ids;
}

export function renderArticleMarkdown(input: ArticleExportInput): string {
  const { citations, images } = input;
  const article = normalizeArticle(input.article);
  const order: string[] = [];
  const numbers = new Map<string, number>();
  const numberFor = (id: string): number => {
    if (!numbers.has(id)) {
      order.push(id);
      numbers.set(id, order.length);
    }
    return numbers.get(id) as number;
  };

  const inline = (text: string): string =>
    parseInline(text)
      .map((part) => {
        if (part.kind === "cite") {
          if (!citations.has(part.id)) return "";
          // 画面引用由 figure 块承载，正文里只保留时间引用的脚注
          return part.id.startsWith("t") ? `[^source-${numberFor(part.id)}]` : "";
        }
        if (part.kind === "link") {
          const href = part.href.replace(/[<>]/g, (ch) => encodeURIComponent(ch));
          return `[${applyMarks(escapeText(part.text), part.marks)}](<${href}>)`;
        }
        if (part.marks.includes("code")) return inlineCode(part.text);
        return applyMarks(escapeText(part.text), part.marks);
      })
      .join("");

  const caption = (text: string): string => inline(text);
  const cell = (text: string): string => inline(text).replace(/\r?\n/g, "<br>").trim();

  const renderBlock = (block: ArticleBlock): void => {
    switch (block.type) {
      case "paragraph": {
        const text = inline(block.text).replace(/[ \t]{2,}/g, " ").trim();
        if (text) lines.push(text, "");
        break;
      }
      case "quote": {
        const text = inline(block.text).trim();
        if (text) lines.push(...text.split("\n").map((line) => `> ${line}`), "");
        break;
      }
      case "list": {
        block.items.forEach((item, index) => {
          const text = inline(item).trim();
          if (text) lines.push(`${block.ordered ? `${index + 1}.` : "-"} ${text}`);
        });
        lines.push("");
        break;
      }
      case "code": {
        const lang = (block.lang ?? "").replace(/[^\w+#.-]/g, "");
        lines.push(...codeFence(block.text, lang), "");
        break;
      }
      case "table": {
        if (block.header.length === 0) break;
        lines.push(`| ${block.header.map(cell).join(" | ")} |`);
        lines.push(`| ${block.header.map(() => "---").join(" | ")} |`);
        for (const row of block.rows) lines.push(`| ${row.map(cell).join(" | ")} |`);
        if (block.caption) lines.push("", `*${caption(block.caption)}*`);
        lines.push("");
        break;
      }
      case "figure": {
        const info = citations.get(block.frameId);
        const plain = block.caption
          ? block.caption
          : info
            ? `画面 ${block.frameId} · ${clock(info.timeSec)}`
            : `画面 ${block.frameId}`;
        const text = caption(plain);
        // 图片 alt 里不能出现未转义的方括号，否则会提前闭合
        const alt = plain.replace(/[\[\]\r\n]/g, " ").replace(/\s{2,}/g, " ").trim();
        const src = images.get(block.frameId);
        if (src) lines.push(`![${alt}](${src})`, "");
        const note = info ? `[^source-${numberFor(block.frameId)}]` : "";
        lines.push(`*图：${text}*${note}`, "");
        break;
      }
    }
  };

  const lines: string[] = [];
  lines.push(`# ${escapeText(article.title)}`, "");
  lines.push(`解读详细程度：${escapeText(input.detailLevel)}`, "");
  if (input.sourceUrl) lines.push(`原视频：[打开原片](<${input.sourceUrl}>)`, "");
  lines.push(`生成模型：${escapeText(input.model)}`, "");
  if (input.purpose) lines.push(`本次关注点：${escapeText(input.purpose)}`, "");

  if (article.sections.length > 0) {
    lines.push("## 目录", "");
    article.sections.forEach((section, index) => {
      lines.push(`- [${escapeText(section.title)}](#section-${index + 1})`);
    });
    lines.push("");
  }

  article.sections.forEach((section, index) => {
    lines.push(`<a id="section-${index + 1}"></a>`, "");
    lines.push(`## ${escapeText(section.title)}`, "");
    for (const block of section.blocks) renderBlock(block);
  });

  if (article.mindMap.length > 0) {
    const target = new Map(article.sections.map((section, i) => [section.id, i + 1]));
    const walk = (nodes: MindMapNode[], depth: number) => {
      for (const node of nodes) {
        const index = node.sectionId ? target.get(node.sectionId) : undefined;
        const label = escapeText(node.label);
        lines.push(`${"  ".repeat(depth)}- ${index ? `[${label}](#section-${index})` : label}`);
        if (node.children?.length) walk(node.children, depth + 1);
      }
    };
    lines.push("## 文章导图", "");
    walk(article.mindMap, 0);
    lines.push("");
  }

  if (article.limitations.length > 0) {
    lines.push("## 还没确认的部分", "");
    for (const limitation of article.limitations) lines.push(`- ${inline(limitation.text)}`.trimEnd());
    lines.push("");
  }

  if (order.length > 0) {
    lines.push("## 来源", "");
    for (const id of order) {
      const info = citations.get(id);
      if (!info) continue;
      const label = info.kind === "t" ? "转写" : "画面";
      const stamp = clock(info.timeSec);
      const url = input.sourceUrl ? withTime(input.sourceUrl, info.timeSec) : null;
      const head = url ? `[${label} · ${stamp}](<${url}>)` : `${label} · ${stamp}`;
      const range = info.endSec !== undefined ? `（至 ${clock(info.endSec)}）` : "";
      lines.push(`[^source-${numbers.get(id)}]: ${head}${range}`);
    }
    lines.push("");
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}
