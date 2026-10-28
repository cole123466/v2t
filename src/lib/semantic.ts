/**
 * 15 号票后半（C4/C6/C7）：章节语义核对的纯函数部分。
 * 核对 = 每章生成后一次模型调用，把「论断句子 ↔ 被引转写段原文」成对列出批量判定；
 * 本模块只负责配对抽取、判定结果解析与未支持标注，不发起 IO。
 *
 * 定位必须清楚：语义核对是质量增强，不是发布门禁——
 * 核对环节的任何失败都不能让章节或文章失败（票内 C6/C7 的底线）。
 */
import {
  blockText,
  looseJsonBody,
  type ArticleBlock,
  type ArticleSection,
  type CitationCatalog,
} from "@/server/article";

export type VerifyVerdict = "supported" | "unsupported" | "partial";

export interface VerifyPair {
  /** 被引编号（tNN） */
  token: string;
  /** 论断所在句子 */
  claim: string;
  /** 被引转写段原文 */
  evidence: string;
}

export interface VerifyResult {
  index: number;
  verdict: VerifyVerdict;
  reason: string;
}

const CITE_TOKEN = /\[\[(t\d{2,})\]\]/g;
const SENTENCE_BREAKS = "。！？；!?;\n";

/** 从章节正文抽「句子 ↔ 引用」对；[[fNN]] 是画面引用，不参与文本核对 */
export function collectVerifyPairs(
  section: Pick<ArticleSection, "blocks">,
  catalog: CitationCatalog,
): VerifyPair[] {
  const evidence = new Map(catalog.transcripts.map((t) => [t.id, t.text]));
  const pairs: VerifyPair[] = [];
  for (const block of section.blocks) {
    if (block.type === "code") continue; // 代码块是原文/命令，不参与核对
    const text = blockText(block);
    for (const m of text.matchAll(CITE_TOKEN)) {
      const source = evidence.get(m[1]);
      if (source === undefined) continue; // 非法编号归白名单校验管
      pairs.push({ token: m[1], claim: sentenceAround(text, m.index ?? 0), evidence: source });
    }
  }
  return pairs;
}

function sentenceAround(text: string, pos: number): string {
  let start = 0;
  for (let i = pos - 1; i >= 0; i--) {
    if (SENTENCE_BREAKS.includes(text[i])) {
      start = i + 1;
      break;
    }
  }
  let end = text.length;
  for (let i = pos; i < text.length; i++) {
    if (SENTENCE_BREAKS.includes(text[i])) {
      end = i + 1;
      break;
    }
  }
  return text.slice(start, end).trim();
}

/** 核对提示：把「句子 ↔ 引用」成对列出，一次批量判定（不逐条调用） */
export function verifyPrompt(pairs: VerifyPair[]): string {
  return [
    "逐条判断下面的「论断 ↔ 原文」对：论断是否被对应的原文直接支持。只依据原文判断，不引入外部知识。",
    "verdict 取值：supported（原文直接支持）/ partial（相关但只支持一部分）/ unsupported（原文不支持或无关）。",
    "",
    ...pairs.map((p, i) => `${i}. 论断：「${p.claim}」\n   引用 [[${p.token}]] 的原文：「${p.evidence}」`),
    "",
    '只输出 JSON：{"results":[{"i":0,"verdict":"supported","reason":"一句话理由"}]}，i 与上面的序号一致，每条都要给。',
  ].join("\n");
}

/**
 * 解析核对输出。核对是增强，解析失败、条目缺席、verdict 非法一律按 supported：
 * 宁可漏判，不可误伤正文（票内风险节「核对本身会误判」的兜底方向）。
 */
export function parseVerifyResults(raw: string, count: number): VerifyResult[] {
  const fallback = (i: number): VerifyResult => ({ index: i, verdict: "supported", reason: "" });
  let parsed: unknown;
  try {
    parsed = JSON.parse(looseJsonBody(raw));
  } catch {
    return Array.from({ length: count }, (_, i) => fallback(i));
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { results?: unknown } | null)?.results;
  if (!Array.isArray(list)) return Array.from({ length: count }, (_, i) => fallback(i));

  const byIndex = new Map<number, VerifyResult>();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const index = Number(rec.i ?? rec.index);
    if (!Number.isInteger(index) || index < 0 || index >= count) continue;
    const verdict = String(rec.verdict ?? "").toLowerCase();
    if (verdict === "supported" || verdict === "partial" || verdict === "unsupported") {
      byIndex.set(index, { index, verdict, reason: String(rec.reason ?? "") });
    }
  }
  return Array.from({ length: count }, (_, i) => byIndex.get(i) ?? fallback(i));
}

export const UNVERIFIED_MARK = "（出处未核实）";

/** 在未支持引用后内联标注（句末脚注标记的简化实现）；返回实际标注到的编号 */
export function annotateUnsupported(
  blocks: ArticleBlock[],
  tokens: string[],
): { blocks: ArticleBlock[]; annotated: string[] } {
  if (tokens.length === 0) return { blocks, annotated: [] };
  const annotated: string[] = [];
  const mark = (text: string): string => {
    let out = text;
    for (const token of tokens) {
      const target = `[[${token}]]`;
      if (out.includes(target) && !out.includes(target + UNVERIFIED_MARK)) {
        out = out.replace(target, target + UNVERIFIED_MARK);
        if (!annotated.includes(token)) annotated.push(token);
      }
    }
    return out;
  };
  const next = blocks.map((block): ArticleBlock => {
    switch (block.type) {
      case "paragraph":
      case "quote":
        return { ...block, text: mark(block.text) };
      case "list":
        return { ...block, items: block.items.map(mark) };
      case "table":
        return {
          ...block,
          caption: block.caption === undefined ? undefined : mark(block.caption),
          header: block.header.map(mark),
          rows: block.rows.map((row) => row.map(mark)),
        };
      case "code":
        return block;
      case "figure":
        return block.caption === undefined ? block : { ...block, caption: mark(block.caption) };
    }
  });
  return { blocks: next, annotated };
}

/** limitations 条目：去掉引用标记并截断（limitations 里的引用还要过一遍校验） */
export function unverifiedLimitation(sectionNo: number, claim: string): string {
  const cleaned = claim.replace(/\[\[[tf]\d{2,}\]\]/g, "").replace(/\s+/g, " ").trim();
  return `第 ${sectionNo} 章：「${cleaned.slice(0, 50)}」未能在原文中找到直接支持`;
}
