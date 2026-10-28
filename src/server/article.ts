import type { FrameManifest } from "./frames";
import type { Transcript } from "./asr";

/**
 * 文章结构：章节 → 内容块。正文里的引用 token 以 [[t01]] / [[f03]] 内联在文本中；
 * 段落中出现的 [[fNN]] 会在归一化时抽出为紧随其后的 figure 块。
 */
export type InlineMark = "bold" | "emphasis" | "code";

export type Inline =
  | { kind: "text"; text: string; marks: InlineMark[] }
  | { kind: "cite"; id: string }
  | { kind: "link"; href: string; text: string; marks: InlineMark[] };

export type ArticleBlock =
  | { type: "paragraph"; text: string }
  | { type: "quote"; text: string }
  | { type: "list"; ordered?: boolean; items: string[] }
  | { type: "code"; text: string; lang?: string }
  | { type: "table"; header: string[]; rows: string[][]; caption?: string }
  | { type: "figure"; frameId: string; caption?: string };

export const ARTICLE_BLOCK_TYPES = ["paragraph", "quote", "list", "code", "table", "figure"] as const;

export interface ArticleSection {
  id: string;
  title: string;
  blocks: ArticleBlock[];
}

export interface MindMapNode {
  label: string;
  /** 叶子节点指向章节 id；分组节点可缺省 */
  sectionId?: string;
  children?: MindMapNode[];
}

export interface ArticleLimitation {
  text: string;
}

export interface Article {
  /** 内容形态版本；2 = 结构化块。仅用于排障，读取时不强校验 */
  schemaVersion?: number;
  title: string;
  sections: ArticleSection[];
  mindMap: MindMapNode[];
  /** 显式的不确定之处 */
  limitations: ArticleLimitation[];
}

export interface ArticleDraftOutline {
  title: string;
  sections: Array<{ id: string; title: string; summary: string }>;
  mindMap: MindMapNode[];
}

export const ARTICLE_MAX_SECTIONS = 12;
export const ARTICLE_MAX_BLOCKS = 8;
export const ARTICLE_MAX_DEPTH = 3;

/** 转写段与帧的引用目录（供 prompt 用，也是校验白名单） */
export interface CitationCatalog {
  transcripts: Array<{ id: string; start: number; end: number; text: string }>;
  frames: Array<{ id: string; tSec: number }>;
  /** 无句级时间戳时禁止 t 引用 */
  allowTimeCitations: boolean;
  durationSec: number;
}

export function buildCatalog(
  transcript: Transcript,
  manifest: FrameManifest | null,
): CitationCatalog {
  return {
    transcripts: transcript.segments.map((seg, i) => ({
      id: `t${String(i + 1).padStart(2, "0")}`,
      start: seg.start,
      end: seg.end,
      text: seg.text,
    })),
    frames: (manifest?.frames ?? []).map((f) => ({ id: f.id, tSec: f.tSec })),
    allowTimeCitations: !transcript.timestampsMissing && transcript.segments.length > 0,
    durationSec: transcript.durationSec,
  };
}

/** 规范化引用标记：容忍模型少写/多写方括号（[[t01] / [t01]] / 【t01】），统一成 [[t01]] */
export function normalizeCitations(text: string): string {
  return (
    text
      // [[t01]  /  [t01]]  → [[t01]]
      .replace(/\[\[([tf]\d{2,})\](?!\])/g, "[[$1]]")
      .replace(/(?<!\[)\[([tf]\d{2,})\]\]/g, "[[$1]]")
      // 【t01】 / ［t01］ → [[t01]]
      .replace(/[【［]\s*([tf]\d{2,})\s*[】］]/g, "[[$1]]")
      // 裸括号 [t01]（单方括号）→ [[t01]]
      .replace(/(?<!\[)\[([tf]\d{2,})\](?!\])/g, "[[$1]]")
      // 已经正确的不动
      .replace(/\[\[\[([tf]\d{2,})\]\]\]/g, "[[$1]]")
  );
}

/** 从文本中提取全部 [[tNN]] / [[fNN]] token */
export function extractCitations(text: string): string[] {
  return Array.from(text.matchAll(/\[\[([tf]\d{2,})\]/g), (m) => m[1]);
}

export interface CitationProblem {
  field: string;
  message: string;
}

/** 块内文本：用于引用扫描与导出；code 不参与引用扫描，单独跳过 */
export function blockText(block: ArticleBlock): string {
  switch (block.type) {
    case "paragraph":
    case "quote":
      return block.text;
    case "list":
      return block.items.join("\n");
    case "code":
      return "";
    case "table":
      return [block.caption ?? "", ...block.header, ...block.rows.flat()]
        .filter((part) => part.length > 0)
        .join("\n");
    case "figure":
      return block.caption ?? "";
  }
}

function addMark(marks: InlineMark[], mark: InlineMark): InlineMark[] {
  return marks.includes(mark) ? marks : [...marks, mark];
}

function findEmphasisEnd(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === "*" && text[i - 1] !== "*" && text[i + 1] !== "*") return i;
  }
  return -1;
}

function parseMarks(text: string, marks: InlineMark[]): Inline[] {
  const out: Inline[] = [];
  let buffer = "";
  const flush = () => {
    if (!buffer) return;
    out.push({ kind: "text", text: buffer, marks: [...marks] });
    buffer = "";
  };

  for (let i = 0; i < text.length; ) {
    if (text.startsWith("**", i)) {
      const end = text.indexOf("**", i + 2);
      if (end > i + 2) {
        flush();
        out.push(...parseMarks(text.slice(i + 2, end), addMark(marks, "bold")));
        i = end + 2;
        continue;
      }
    }
    if (text[i] === "*") {
      const end = findEmphasisEnd(text, i + 1);
      if (end > i + 1) {
        flush();
        out.push(...parseMarks(text.slice(i + 1, end), addMark(marks, "emphasis")));
        i = end + 1;
        continue;
      }
    }
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        out.push({ kind: "text", text: text.slice(i + 1, end), marks: addMark(marks, "code") });
        i = end + 1;
        continue;
      }
    }
    if (text.startsWith("[[", i)) {
      const cite = /^\[\[([tf]\d{2,})\]\]/.exec(text.slice(i));
      if (cite) {
        flush();
        out.push({ kind: "cite", id: cite[1] });
        i += cite[0].length;
        continue;
      }
    }
    if (text[i] === "[") {
      const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/.exec(text.slice(i));
      if (link) {
        flush();
        out.push({ kind: "link", href: link[2], text: link[1], marks: [...marks] });
        i += link[0].length;
        continue;
      }
    }
    buffer += text[i];
    i += 1;
  }
  flush();
  return out;
}

/** 解析行内 Markdown 子集与引用 token，返回结构化 Inline（渲染与导出共用） */
export function parseInline(text: string): Inline[] {
  return parseMarks(text, []);
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(asText) : [];
}

/** 抽出正文里的 [[fNN]]，交给调用方生成 figure 块 */
function extractFrameRefs(text: string): { text: string; frames: string[] } {
  const frames: string[] = [];
  const cleaned = text.replace(/\[\[(f\d{2,})\]\]/g, (_, id: string) => {
    frames.push(id);
    return "";
  });
  return { text: cleaned.replace(/[ \t]{2,}/g, " ").trim(), frames };
}

/**
 * 兼容层：把任意历史/模型输出归一化为结构化文章。
 * - 缺 type 的 `{text}` → paragraph；未知 type 有 text → paragraph，否则丢弃
 * - 段落里的 [[fNN]] 抽出为紧随其后的 figure，全篇同帧只保留一次
 * - 空章节补占位段落；引用标记统一为 [[tNN]]/[[fNN]]
 * 幂等，不抛错。
 */
export function normalizeArticle(raw: unknown): Article {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const seenFrames = new Set<string>();
  const rawSections = Array.isArray(input.sections) ? input.sections : [];

  const sections = rawSections.map((rawSection, index): ArticleSection => {
    const section = (rawSection && typeof rawSection === "object" ? rawSection : {}) as Record<string, unknown>;
    const blocks: ArticleBlock[] = [];

    const pushFigure = (frameId: string) => {
      if (seenFrames.has(frameId)) return;
      seenFrames.add(frameId);
      blocks.push({ type: "figure", frameId });
    };

    const pushTextBlock = (type: "paragraph" | "quote", value: unknown) => {
      const normalized = extractFrameRefs(normalizeCitations(asText(value)));
      if (normalized.text) blocks.push({ type, text: normalized.text });
      for (const frameId of normalized.frames) pushFigure(frameId);
    };

    const rawBlocks = Array.isArray(section.blocks) ? section.blocks : [];
    for (const rawBlock of rawBlocks) {
      if (!rawBlock || typeof rawBlock !== "object") continue;
      const block = rawBlock as Record<string, unknown>;
      let type = asText(block.type);
      if (!(ARTICLE_BLOCK_TYPES as readonly string[]).includes(type)) {
        type = typeof block.text === "string" ? "paragraph" : "";
      }

      switch (type) {
        case "paragraph":
        case "quote":
          pushTextBlock(type, block.text);
          break;
        case "list": {
          const rawItems = Array.isArray(block.items) ? block.items : [];
          const items: string[] = [];
          const frames: string[] = [];
          for (const rawItem of rawItems) {
            const item =
              rawItem && typeof rawItem === "object"
                ? asText((rawItem as Record<string, unknown>).text)
                : asText(rawItem);
            const normalized = extractFrameRefs(normalizeCitations(item));
            if (normalized.text) items.push(normalized.text);
            frames.push(...normalized.frames);
          }
          if (items.length > 0) {
            blocks.push(
              typeof block.ordered === "boolean"
                ? { type: "list", ordered: block.ordered, items }
                : { type: "list", items },
            );
          }
          for (const frameId of frames) pushFigure(frameId);
          break;
        }
        case "code": {
          const text = asText(block.text);
          if (text.trim()) {
            const lang = asText(block.lang).trim();
            blocks.push(lang ? { type: "code", text, lang } : { type: "code", text });
          }
          break;
        }
        case "table": {
          const header = asStringArray(block.header);
          const rows = Array.isArray(block.rows)
            ? block.rows.filter((row): row is unknown[] => Array.isArray(row)).map((row) => row.map(asText))
            : [];
          const normalizedCaption = extractFrameRefs(normalizeCitations(asText(block.caption)));
          const caption = normalizedCaption.text;
          if (header.length > 0) {
            const frames: string[] = [...normalizedCaption.frames];
            const cleanHeader = header.map((cell) => {
              const normalized = extractFrameRefs(normalizeCitations(cell));
              frames.push(...normalized.frames);
              return normalized.text;
            });
            const cleanRows = rows.map((row) =>
              row.map((cell) => {
                const normalized = extractFrameRefs(normalizeCitations(cell));
                frames.push(...normalized.frames);
                return normalized.text;
              }),
            );
            blocks.push(
              caption
                ? { type: "table", header: cleanHeader, rows: cleanRows, caption }
                : { type: "table", header: cleanHeader, rows: cleanRows },
            );
            for (const frameId of frames) pushFigure(frameId);
          }
          break;
        }
        case "figure": {
          const frameIds = Array.isArray(block.frame_ids) ? block.frame_ids : [];
          const frameId = asText(block.frameId ?? block.frame_id ?? frameIds[0]);
          if (!/^f\d{2,}$/.test(frameId) || seenFrames.has(frameId)) break;
          const caption = normalizeCitations(asText(block.caption)).trim();
          seenFrames.add(frameId);
          blocks.push(caption ? { type: "figure", frameId, caption } : { type: "figure", frameId });
          break;
        }
      }
    }

    if (blocks.length === 0) blocks.push({ type: "paragraph", text: "（本章暂无正文）" });
    return {
      id: asText(section.id) || `s${index + 1}`,
      title: asText(section.title) || `第 ${index + 1} 章`,
      blocks,
    };
  });

  const limitations = Array.isArray(input.limitations)
    ? input.limitations
        .map((item) => {
          if (typeof item === "string") return { text: normalizeCitations(item).trim() };
          if (!item || typeof item !== "object") return { text: "" };
          return { text: normalizeCitations(asText((item as Record<string, unknown>).text)).trim() };
        })
        .filter((item) => item.text.length > 0)
    : [];

  return {
    schemaVersion: 2,
    title: normalizeCitations(asText(input.title)).trim(),
    sections,
    mindMap: Array.isArray(input.mindMap) ? (input.mindMap as MindMapNode[]) : [],
    limitations,
  };
}

/**
 * 引用校验（纯函数）：编号在白名单内、帧存在、时间不越界、无时间戳禁用 t 引用。
 * code 块是原文/命令，不扫描引用。返回空数组即通过。
 */
export function validateCitations(
  article: Article,
  catalog: CitationCatalog,
): CitationProblem[] {
  const problems: CitationProblem[] = [];
  const timeIds = new Set(catalog.transcripts.map((t) => t.id));
  const frameIds = new Set(catalog.frames.map((f) => f.id));

  const check = (text: string, field: string) => {
    // 先用规范化后的文本查格式：把各种括号写法统一，再看是否还有畸形标记
    const normalized = normalizeCitations(text);
    const strays = normalized.match(/\[\[[^\]]*\]?\]?/g) ?? [];
    for (const raw of strays) {
      if (!/^\[\[[tf]\d{2,}\]\]$/.test(raw)) {
        problems.push({ field, message: `引用格式错误：${raw.slice(0, 20)}` });
      }
    }
    for (const token of extractCitations(normalized)) {
      if (token.startsWith("t")) {
        if (!catalog.allowTimeCitations) {
          problems.push({ field, message: `本任务没有句级时间戳，不允许时间引用 ${token}` });
        } else if (!timeIds.has(token)) {
          problems.push({ field, message: `时间引用 ${token} 不存在` });
        }
      } else if (!frameIds.has(token)) {
        problems.push({ field, message: `画面引用 ${token} 不存在` });
      }
    }
  };

  article.sections.forEach((section, si) => {
    section.blocks.forEach((block, bi) => {
      if (block.type === "code") return;
      check(blockText(block), `sections[${si}].blocks[${bi}]`);
    });
  });
  article.limitations.forEach((l, i) => check(l.text, `limitations[${i}]`));
  return problems;
}

function blockHasContent(block: ArticleBlock): boolean {
  switch (block.type) {
    case "paragraph":
    case "quote":
      return block.text.trim().length > 0;
    case "list":
      return block.items.some((item) => item.trim().length > 0);
    case "code":
      return block.text.trim().length > 0;
    case "table":
      return block.header.length > 0;
    case "figure":
      return block.frameId.trim().length > 0;
  }
}

/** 结构校验：章节/块数量、导图深度与指向 */
export function validateStructure(article: Article): CitationProblem[] {
  const problems: CitationProblem[] = [];
  if (!article.title?.trim()) problems.push({ field: "title", message: "缺少文章标题" });
  if (article.sections.length === 0) problems.push({ field: "sections", message: "文章没有章节" });
  if (article.sections.length > ARTICLE_MAX_SECTIONS) {
    problems.push({ field: "sections", message: `章节超过上限 ${ARTICLE_MAX_SECTIONS}` });
  }
  const ids = new Set<string>();
  article.sections.forEach((s, i) => {
    if (!s.id?.trim()) problems.push({ field: `sections[${i}].id`, message: "章节缺少 id" });
    else if (ids.has(s.id)) problems.push({ field: `sections[${i}].id`, message: `章节 id 重复：${s.id}` });
    else ids.add(s.id);
    if (!s.title?.trim()) problems.push({ field: `sections[${i}].title`, message: "章节缺少标题" });
    if (s.blocks.length === 0) {
      problems.push({ field: `sections[${i}].blocks`, message: "章节没有内容块" });
    }
    if (s.blocks.length > ARTICLE_MAX_BLOCKS) {
      problems.push({ field: `sections[${i}].blocks`, message: `块数超过上限 ${ARTICLE_MAX_BLOCKS}` });
    }
    s.blocks.forEach((b, bi) => {
      if (!blockHasContent(b)) problems.push({ field: `sections[${i}].blocks[${bi}]`, message: "空内容块" });
    });
  });

  const walk = (nodes: MindMapNode[], depth: number, path: string) => {
    // depth 从 0 起算，等于上限时说明还要再嵌一层就会超限
    if (depth >= ARTICLE_MAX_DEPTH) {
      problems.push({ field: path, message: `导图超过 ${ARTICLE_MAX_DEPTH} 层` });
      return;
    }
    for (const node of nodes) {
      if (!node.label?.trim()) problems.push({ field: path, message: "导图节点缺少标签" });
      if (node.sectionId && !ids.has(node.sectionId)) {
        problems.push({ field: path, message: `导图指向不存在的章节：${node.sectionId}` });
      }
      if (node.children) walk(node.children, depth + 1, path);
    }
  };
  walk(article.mindMap, 0, "mindMap");
  return problems;
}

/** 块级校验：每类块的字段、配额与 figure 唯一性/存在性 */
export function validateBlocks(article: Article, catalog?: CitationCatalog): CitationProblem[] {
  const problems: CitationProblem[] = [];
  const catalogFrames = catalog ? new Set(catalog.frames.map((frame) => frame.id)) : null;
  const seenFrames = new Set<string>();

  article.sections.forEach((section, si) => {
    let nonParagraph = 0;
    if (section.blocks[0]?.type !== "paragraph") {
      problems.push({ field: `sections[${si}].blocks[0]`, message: "首块必须是段落" });
    }
    section.blocks.forEach((block, bi) => {
      const field = `sections[${si}].blocks[${bi}]`;
      if (block.type !== "paragraph") nonParagraph += 1;
      switch (block.type) {
        case "paragraph":
          if (block.text.length > 800) {
            problems.push({ field, message: `段落超过 800 字（${block.text.length}）` });
          }
          break;
        case "quote":
          break;
        case "list":
          if (block.items.length < 2 || block.items.length > 6) {
            problems.push({ field, message: `列表需 2-6 项（当前 ${block.items.length}）` });
          }
          break;
        case "code":
          if (block.text.split("\n").length > 40) {
            problems.push({ field, message: "代码块超过 40 行" });
          }
          break;
        case "table": {
          if (block.header.length < 2 || block.header.length > 4) {
            problems.push({ field, message: `表格需 2-4 列（当前 ${block.header.length}）` });
          }
          if (block.rows.length > 8) {
            problems.push({ field, message: `表格超过 8 行（当前 ${block.rows.length}）` });
          }
          block.rows.forEach((row, ri) => {
            if (row.length !== block.header.length) {
              problems.push({
                field: `${field}.rows[${ri}]`,
                message: `表格行有 ${row.length} 列，与表头 ${block.header.length} 列不一致`,
              });
            }
          });
          break;
        }
        case "figure": {
          if (!/^f\d{2,}$/.test(block.frameId)) {
            problems.push({ field, message: `画面编号格式错误：${block.frameId}` });
          } else if (seenFrames.has(block.frameId)) {
            problems.push({ field, message: `画面 ${block.frameId} 重复引用` });
          }
          seenFrames.add(block.frameId);
          if (catalogFrames && !catalogFrames.has(block.frameId)) {
            problems.push({ field, message: `画面引用 ${block.frameId} 不存在` });
          }
          break;
        }
      }
    });
    if (nonParagraph > 3) {
      problems.push({ field: `sections[${si}].blocks`, message: "非段落块每章最多 3 个" });
    }
  });

  return problems;
}

/** 解析模型输出的 JSON（容忍 ```json 围栏、前后废话、常见缺陷与截断） */
export function parseArticleJson(raw: string): unknown {
  return JSON.parse(looseJsonBody(raw));
}

/**
 * 取出 JSON 主体并修复模型输出的常见缺陷：
 * - ```json 围栏与前后说明文字
 * - 字符串内未转义的英文双引号（"他说"你好"" → 中文引号替代不了时补转义）
 * - 尾随逗号
 * - 输出被长度上限截断（补齐未闭合的字符串/对象/数组）
 * 修复只改结构，不改文字内容。
 */
export function looseJsonBody(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  let body = (fenced ? fenced[1] : trimmed).trim();
  const start = body.indexOf("{");
  if (start === -1) throw new Error("模型没有返回 JSON 对象");
  body = body.slice(start);

  // 截断处理：先看整体是否闭合，不闭合就补齐
  body = closeTruncated(body);
  // 缺逗号修复必须先于 repairUnescapedQuotes：否则后者会把缺逗号处的
  // 合法收尾引号误判为正文内引号转义掉，把两个独立字符串焊死
  body = insertMissingCommas(body);
  body = repairUnescapedQuotes(body);
  body = body.replace(/,(\s*[}\]])/g, "$1");
  return body;
}

/**
 * 补齐模型输出中漏掉的属性间逗号（glm 写长 JSON 的高发缺陷）。
 * 判定条件（全部满足才插逗号，避免误伤）：
 * 1. 当前在字符串外；
 * 2. 该引号开启的是一个"key"字符串——它闭合后紧跟冒号；
 * 3. 前一个非空白字符是某个值的收尾（" } ] 数字或 true/false/null 尾字母），
 *    且不是逗号/冒号（冒号开头说明引号是值而非 key）。
 * 线上案例：sections 长数组结束后直接跟 "mindMap"（trace 426e03a6，
 * position 3702 报 Expected ',' or '}' after property value）。
 */
function insertMissingCommas(body: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch !== '"') {
      out += ch;
      continue;
    }
    // 字符串外的引号：判断它闭合后是否紧跟冒号（即是 key）
    let j = i + 1;
    let isKey = false;
    while (j < body.length) {
      if (body[j] === "\\") { j += 2; continue; }
      if (body[j] === '"') {
        let k = j + 1;
        while (k < body.length && /\s/.test(body[k])) k++;
        isKey = body[k] === ":";
        break;
      }
      j++;
    }
    if (isKey) {
      let p = out.length - 1;
      while (p >= 0 && /\s/.test(out[p])) p--;
      const prev = p >= 0 ? out[p] : "";
      // 裸字母只认 true/false/null 的尾字母（e/l）：更宽的 [a-z] 会把
      // "key"内含未转义引号的裸字母误判成值结尾，把逗号插进 key 里改坏字段名
      if (p >= 0 && prev !== "," && /["\}\]0-9eElL]/.test(prev)) {
        // 补一个逗号并保留原有缩进排版
        out += ",";
      }
    }
    out += ch;
    inString = true;
  }
  return out;
}

/**
 * 处理被长度上限截断的输出。
 * 做法：先从头扫描，记录最后一个"结构完整"的位置（字符串闭合且不在括号中间），
 * 截断到那里，再补齐剩余闭合符号——这样不会把半句话当成完整值。
 */
function closeTruncated(body: string): string {
  let inString = false;
  let escaped = false;
  const stack: string[] = [];
  let lastSafe = -1; // 最后一个结构安全点（字符串外、刚结束一个值）

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') {
        inString = false;
        lastSafe = i + 1;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      stack.push(ch);
      continue;
    }
    if (ch === "}" || ch === "]") {
      stack.pop();
      lastSafe = i + 1;
      continue;
    }
    if (/\s/.test(ch)) continue;
    // 数字 / true / false / null 的结尾字符也算安全点
    if (/[0-9a-z]/i.test(ch)) lastSafe = i + 1;
  }

  // 未截断：原样返回
  if (!inString && stack.length === 0) return body;

  // 截断：回到最后一个安全点，再补齐括号
  const truncated = lastSafe > 0 ? body.slice(0, lastSafe) : body;
  let result = truncated.replace(/[,:\s]+$/, "");

  // 去掉悬空的 key（"key" 后没有值）
  result = result.replace(/,\s*"[^"]*"$/, "").replace(/[{[]\s*"[^"]*"$/, (m) =>
    m.slice(0, 1),
  );

  const reopened: string[] = [];
  let inStr = false;
  let esc = false;
  for (const ch of result) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") reopened.push(ch);
    else if (ch === "}" || ch === "]") reopened.pop();
  }
  const closers = reopened.reverse().map((open) => (open === "{" ? "}" : "]"));
  result += closers.join("");
  // 收口后可能留下尾随逗号
  result = result.replace(/,(\s*[}\]])/g, "$1");
  // 截断点恰好在"还没写值的 key"上时会补出空对象（如 blocks 末尾的 {}），丢掉它
  for (let i = 0; i < 3; i++) {
    const before = result;
    result = result
      .replace(/,\s*\{\s*\}/g, "")
      .replace(/\[\s*\{\s*\}\s*\]/g, "[]");
    if (result === before) break;
  }
  return result;
}

/**
 * 修复字符串内未转义的英文双引号。
 * 判定：字符串内遇到 `"` 后，若其后（跳过空白）不是 , : } ] 或结尾，则该引号属于正文内容。
 */
function repairUnescapedQuotes(body: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      continue;
    }
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      // 看下一个非空白字符，判断是字符串结束还是正文里的引号
      let j = i + 1;
      while (j < body.length && /\s/.test(body[j])) j++;
      const next = body[j];
      const endsString = next === undefined || next === "," || next === ":" || next === "}" || next === "]";
      if (endsString) {
        out += ch;
        inString = false;
      } else {
        out += '\\"';
      }
      continue;
    }
    out += ch;
  }
  return out;
}
