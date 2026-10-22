import type { FrameManifest } from "./frames";
import type { Transcript } from "./asr";

/**
 * 文章结构：章节 → 段落块。每个块可引用时间（tN）与帧（fN），
 * 引用 token 以 [[t01]] / [[f03]] 内联在文本中，服务端校验后才会发布。
 */
export interface ArticleBlock {
  /** 段落正文，可含 [[tNN]] / [[fNN]] 引用 token */
  text: string;
}

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

/**
 * 引用校验（纯函数）：编号在白名单内、帧存在、时间不越界、无时间戳禁用 t 引用。
 * 返回空数组即通过。
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
      check(block.text, `sections[${si}].blocks[${bi}]`);
    });
  });
  article.limitations.forEach((l, i) => check(l.text, `limitations[${i}]`));
  return problems;
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
      if (!b.text?.trim()) problems.push({ field: `sections[${i}].blocks[${bi}]`, message: "空内容块" });
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
  body = repairUnescapedQuotes(body);
  body = body.replace(/,(\s*[}\]])/g, "$1");
  return body;
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
