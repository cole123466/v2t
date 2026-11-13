import type { MindMapNode } from "./article";
import {
  estimateReaderBox,
  indexTree,
  layoutMind,
  visibleMind,
  type MindNode,
} from "@/lib/mind-model";

/**
 * 内容导图的静态 SVG 渲染：服务端把完整树（不折叠）铺成根在左、子级向右的
 * 树状图，内嵌进自包含 HTML 导出（同一份产物用于下载 HTML 与打印成 PDF）。
 *
 * 布局复用 `@/lib/mind-model` 的纯函数，与工作台「查看完整导图」的层级一致；
 * 本模块不做 I/O、不依赖 DOM，也不向 HTML 输出任何未经转义的模型文本。
 */

/** 转义映射与 `article-html.ts` 的 `escapeHtml()` 保持一致；本地实现避免循环依赖 */
const HTML_ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPE[ch]);
}

/** A4 打印可打印区约 670×900 CSS px；留出标题与文字大纲余量 */
const MAX_WIDTH = 640;
const MAX_HEIGHT = 820;
/** 与 `estimateReaderBox()` 一致的节点内边距（左右各 21px） */
const NODE_PADDING = 42;
const MAX_LINES = 3;
const LINE_HEIGHT = 20;
const ELLIPSIS = "…";

function fontSizeFor(depth: number): number {
  return depth === 0 ? 16 : depth === 1 ? 15 : 14;
}

/** 与 `estimateReaderBox()` 同口径：CJK 全宽 1em，其余 0.56em */
function charUnits(ch: string): number {
  return ch.charCodeAt(0) > 0x2e7f ? 1 : 0.56;
}

function unitsOf(text: string): number {
  let units = 0;
  for (const ch of text) units += charUnits(ch);
  return units;
}

function truncateLine(line: string, maxEm: number): string {
  const chars = Array.from(line);
  let units = unitsOf(line);
  while (chars.length > 0 && units + charUnits(ELLIPSIS) > maxEm) {
    const removed = chars.pop();
    if (removed === undefined) break;
    units -= charUnits(removed);
  }
  return `${chars.join("")}${ELLIPSIS}`;
}

/**
 * 按节点盒宽折行：口径与 `estimateReaderBox()` 一致（CJK 全宽、西文 0.56），
 * 最多 3 行，超出部分用 `…` 截断，保证文本不溢出 rect。
 */
export function wrapLabel(label: string, maxEm: number, maxLines = MAX_LINES): string[] {
  const text = label.replace(/\s+/g, " ").trim();
  if (!text) return [""];
  const lines: string[] = [];
  let current = "";
  let width = 0;
  for (const ch of text) {
    const units = charUnits(ch);
    if (current && width + units > maxEm) {
      lines.push(current);
      current = "";
      width = 0;
    }
    current += ch;
    width += units;
  }
  if (current) lines.push(current);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = truncateLine(kept[maxLines - 1], maxEm);
  return kept;
}

function num(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function renderNode(
  node: MindNode,
  box: { x: number; y: number; w: number; h: number },
  isRoot: boolean,
  sectionNumber: ReadonlyMap<string, number>,
): string {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const font = fontSizeFor(node.depth);
  const maxEm = Math.max(1, (box.w - NODE_PADDING) / font);
  const lines = wrapLabel(node.label, maxEm);
  const startDy = -((lines.length - 1) * LINE_HEIGHT) / 2;

  const fill = isRoot ? "#f6ecd6" : "#fdfbf6";
  const stroke = isRoot ? "#8a6114" : "#cfc4ae";
  const textFill = isRoot ? "#5c4109" : "#2b2419";
  const strokeWidth = isRoot ? 1.5 : 1;
  const radius = isRoot ? 10 : 8;

  const tspans = lines
    .map(
      (line, i) =>
        `<tspan x="${num(cx)}" dy="${num(i === 0 ? startDy : LINE_HEIGHT)}">${esc(line)}</tspan>`,
    )
    .join("");

  const group = `<g><rect x="${num(box.x)}" y="${num(box.y)}" width="${num(box.w)}" height="${num(
    box.h,
  )}" rx="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"/><text x="${num(
    cx,
  )}" y="${num(cy)}" text-anchor="middle" dominant-baseline="central" font-size="${font}" fill="${textFill}">${tspans}</text></g>`;

  // href 只由章节序号（数值）拼出，不接受任何外部字符串
  const index = node.sectionId ? sectionNumber.get(node.sectionId) : undefined;
  if (typeof index === "number" && Number.isFinite(index)) {
    return `<a href="#section-${Math.floor(index)}">${group}</a>`;
  }
  return group;
}

/**
 * 渲染完整树状导图（根在左、子级向右，不折叠任何分支）。
 * `nodes` 为空（或只有根、无子级）时返回空串，不输出空 svg。
 */
export function renderMindMapSvg(
  nodes: MindMapNode[],
  rootLabel: string,
  sectionNumber: Map<string, number>,
): string {
  if (nodes.length === 0) return "";
  const index = indexTree(nodes, rootLabel, new Set(sectionNumber.keys()));
  const visible = visibleMind(index, new Set());
  if (visible.length <= 1) return "";

  const sizes = new Map(
    visible.map((node) => [node.id, estimateReaderBox(node.label, node.depth)] as const),
  );
  const { boxes, wires, width, height } = layoutMind(visible, index.rootId, sizes);
  if (width <= 0 || height <= 0) return "";

  const scale = Math.min(MAX_WIDTH / width, MAX_HEIGHT / height, 1);
  const svgWidth = Math.min(MAX_WIDTH, Math.max(1, Math.round(width * scale)));
  const svgHeight = Math.min(MAX_HEIGHT, Math.max(1, Math.round(height * scale)));

  const paths = wires
    .map(
      (wire) =>
        `<path d="${esc(wire.d)}" fill="none" stroke="#d8cfbd" stroke-width="1.5" stroke-linecap="round"/>`,
    )
    .join("");

  const nodesSvg = visible
    .map((node) => {
      const box = boxes.get(node.id);
      if (!box) return "";
      return renderNode(node, box, node.id === index.rootId, sectionNumber);
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" class="mindmap-svg" role="img" aria-label="内容导图" viewBox="0 0 ${num(
    width,
  )} ${num(height)}" width="${svgWidth}" height="${svgHeight}"><title>内容导图</title>${paths}${nodesSvg}</svg>`;
}
