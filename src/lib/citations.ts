/**
 * 15 号票（decision-citation-integrity）：引用校验的统一下沉模块。
 * 服务端与测试共用，纯函数无 IO。
 *
 * 背景：旧实现是「模型自由写 [[tNN]] → 服务端事后删非法编号」——那是清理，
 * 不是校验。统一模块提供 strict（文章：非法即拒绝，配合重问）与
 * lenient（问答：重问一次后仍非法 → 移除 + 降级声明）两种消费方式，
 * 文章与问答共用一套编号来源（buildCatalog 的 transcripts[].id + frames[].id）。
 *
 * 不采用参考工程的「服务端下发别名」协议：那服务于多轮工具调用的编号稳定，
 * 当前一次性生成不存在该问题，别名只会多一层映射（票内 C2 的论证）。
 */
export type CitationStrictness = "strict" | "lenient";

export interface CitationCheck {
  valid: string[];
  invalid: string[];
  /** 已移除非法编号的文本（lenient 消费；strict 下应消费原文） */
  cleaned: string;
}

const TOKEN_RE = /\[\[([tf]\d{2,})\]\]/g;

/** 提取全文里的 [[tNN]] / [[fNN]] 编号（按出现顺序，不去重） */
export function extractCitationTokens(text: string): string[] {
  return Array.from(text.matchAll(TOKEN_RE), (m) => m[1]);
}

/** 一次构造、多处复用：catalog 的全部已知编号 */
export function knownCitationIds(transcriptIds: string[], frameIds: string[]): Set<string> {
  return new Set([...transcriptIds, ...frameIds]);
}

export function checkCitations(text: string, known: Set<string>): CitationCheck {
  const seen = new Set<string>();
  for (const token of extractCitationTokens(text)) seen.add(token);
  const invalid = [...seen].filter((t) => !known.has(t)).sort();
  let cleaned = text;
  for (const token of invalid) {
    cleaned = cleaned.split(`[[${token}]]`).join("");
  }
  return { valid: [...seen].filter((t) => known.has(t)), invalid, cleaned };
}

/** 重问提示：把非法编号与可用范围写回模型 */
export function citationRetryNote(invalid: string[], knownExample: string): string {
  return (
    `你引用了不存在的编号 ${invalid.map((t) => `[[${t}]]`).join("、")}。` +
    `可用编号范围是 ${knownExample}，请只用这些编号重新输出。`
  );
}
