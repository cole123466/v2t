import type { MindMapNode } from "./article";
import {
  countMindNodes,
  estimateReaderBox,
  indexTree,
  layoutMind,
  MIND_EXPORT_LIMITS,
  MIND_EXPORT_MAX_NODES,
  visibleMind,
  type MindIndex,
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

/** 单页可打印区上限：沿用 A4 打印可用尺寸（670×900 CSS px 的安全内值） */
const PAGE_MAX_WIDTH = MAX_WIDTH;
const PAGE_MAX_HEIGHT = MAX_HEIGHT;
/** 布局字号为 14–16px，有效字号下限 9px ⇒ 每页缩放至少 9/14（按最小字号 14 计算） */
const EXPORT_MIN_FONT_PX = 9;
const EXPORT_MIN_SCALE = EXPORT_MIN_FONT_PX / 14;
/** 分页总数上限；超出时在 SVG 区与文字大纲前都给出显式提示，不静默丢弃 */
const EXPORT_MAX_PAGES = 20;

/** 一页的构成：页根 + 本页包含的页根直接子级；子级各自完整展开 */
interface PagePlan {
  rootId: string;
  childIds: string[];
}

interface MeasuredPage {
  visible: MindNode[];
  boxes: Map<string, { x: number; y: number; w: number; h: number }>;
  wires: { d: string }[];
  width: number;
  height: number;
  scale: number;
}

/** 只保留页根的指定子级，其余节点原样共享；页内子级仍全部展开 */
function scopedIndex(index: MindIndex, rootId: string, childIds: string[]): MindIndex {
  const root = index.nodes.get(rootId);
  if (!root) return index;
  const nodes = new Map(index.nodes);
  nodes.set(rootId, { ...root, childIds });
  return { rootId, nodes };
}

function measurePage(
  index: MindIndex,
  rootId: string,
  childIds: string[],
): MeasuredPage | null {
  const pageIndex = scopedIndex(index, rootId, childIds);
  const visible = visibleMind(pageIndex, new Set());
  if (visible.length <= 1) return null;
  const sizes = new Map(
    visible.map((node) => [node.id, estimateReaderBox(node.label, node.depth)] as const),
  );
  const { boxes, wires, width, height } = layoutMind(visible, rootId, sizes);
  if (width <= 0 || height <= 0) return null;
  const scale = Math.min(PAGE_MAX_WIDTH / width, PAGE_MAX_HEIGHT / height, 1);
  return { visible, boxes, wires, width, height, scale };
}

/** 单页是否能以不小于字号下限的缩放呈现（不做向上 clamp，避免溢出打印区） */
function fitsPage(index: MindIndex, rootId: string, childIds: string[]): boolean {
  const measured = measurePage(index, rootId, childIds);
  return measured !== null && measured.scale >= EXPORT_MIN_SCALE;
}

/**
 * 按顶层主题分支贪心拆页：尽量多收主题，直到再加一个会让缩放低于字号下限。
 * 单个主题独占一页仍不达标时下钻到它的子级（页根换成该主题），保证每页可读。
 */
function paginate(index: MindIndex, rootId: string, pages: PagePlan[]): void {
  const root = index.nodes.get(rootId);
  if (!root) return;
  let current: string[] | null = null;
  for (const childId of root.childIds) {
    if (current) {
      const candidate: string[] = [...current, childId];
      if (fitsPage(index, rootId, candidate)) {
        current = candidate;
        continue;
      }
      pages.push({ rootId, childIds: current });
      current = null;
    }
    if (fitsPage(index, rootId, [childId])) {
      current = [childId];
      continue;
    }
    const child = index.nodes.get(childId);
    if (child && child.childIds.length > 0) {
      paginate(index, childId, pages);
    } else {
      // 无子级可拆，只能独占一页（叶子节点本身不会触发这条）
      pages.push({ rootId, childIds: [childId] });
    }
  }
  if (current) pages.push({ rootId, childIds: current });
}

function renderPageSvg(
  measured: MeasuredPage,
  plan: PagePlan,
  rootLabel: string,
  sectionNumber: Map<string, number>,
  ariaLabel: string,
  isArticleRoot: boolean,
): string {
  const { visible, boxes, wires, width, height, scale } = measured;
  const svgWidth = Math.min(PAGE_MAX_WIDTH, Math.max(1, Math.round(width * scale)));
  const svgHeight = Math.min(PAGE_MAX_HEIGHT, Math.max(1, Math.round(height * scale)));

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
      return renderNode(node, box, node.id === plan.rootId, sectionNumber);
    })
    .join("");

  // 页根下沉到某个主题时，文章标题不再作为节点出现，用 <title> 保留可读上下文
  const title = isArticleRoot ? "内容导图" : `${esc(rootLabel)} · 内容导图`;
  return `<svg xmlns="http://www.w3.org/2000/svg" class="mindmap-svg" role="img" aria-label="${esc(
    ariaLabel,
  )}" viewBox="0 0 ${num(width)} ${num(height)}" width="${svgWidth}" height="${svgHeight}"><title>${title}</title>${paths}${nodesSvg}</svg>`;
}

export interface MindMapExportRender {
  /** 分页后的 HTML；单页时就是一个 `<svg>`，与分页前一致 */
  html: string;
  /** 实际输出的页数；无内容时为 0 */
  pages: number;
  /** 原始导图的节点数（用于提示文案） */
  nodeCount: number;
  /** 超过导出硬上限或页数上限时的提示文案；正常时为 null */
  notice: string | null;
}

/**
 * 导出用渲染：完整树（不折叠）按顶层主题分页，每页独立缩放且保证字号下限。
 * 单页时只返回一个 `<svg>`（与分页前行为一致），多页时才包 `.mindmap-pages` 并标注页码。
 */
export function renderMindMapForExport(
  nodes: MindMapNode[],
  rootLabel: string,
  sectionNumber: Map<string, number>,
): MindMapExportRender {
  if (nodes.length === 0) return { html: "", pages: 0, nodeCount: 0, notice: null };
  const nodeCount = countMindNodes(nodes);
  if (nodeCount > MIND_EXPORT_MAX_NODES) {
    return {
      html: "",
      pages: 0,
      nodeCount,
      notice: `导图过大（${nodeCount} 个节点），完整结构见下方文字大纲`,
    };
  }

  const index = indexTree(nodes, rootLabel, new Set(sectionNumber.keys()), MIND_EXPORT_LIMITS);
  if (index.nodes.size - 1 < nodeCount) {
    // 超过导出硬上限（层级或节点数）时不做部分渲染，避免 SVG 与文字大纲不一致
    return {
      html: "",
      pages: 0,
      nodeCount,
      notice: `导图过大或层级过深，未能完整渲染（${nodeCount} 个节点），完整结构见下方文字大纲`,
    };
  }

  const plans: PagePlan[] = [];
  paginate(index, index.rootId, plans);
  if (plans.length === 0) return { html: "", pages: 0, nodeCount, notice: null };

  const truncated = plans.length > EXPORT_MAX_PAGES;
  const shown = truncated ? plans.slice(0, EXPORT_MAX_PAGES) : plans;
  const total = shown.length;

  const blocks = shown.map((plan, i) => {
    const measured = measurePage(index, plan.rootId, plan.childIds);
    if (!measured) return "";
    const continuation = i > 0 && shown[i - 1].rootId === plan.rootId;
    const ariaLabel =
      total === 1
        ? "内容导图"
        : `内容导图 第 ${i + 1} 页，共 ${total} 页${continuation ? "（续）" : ""}`;
    const svg = renderPageSvg(
      measured,
      plan,
      rootLabel,
      sectionNumber,
      ariaLabel,
      plan.rootId === index.rootId,
    );
    if (total === 1) return svg;
    return `<div class="mindmap-page"><div class="mindmap-page-label">第 ${i + 1} / ${total} 页</div>${svg}</div>`;
  });
  const html = total === 1 ? blocks[0] : `<div class="mindmap-pages">${blocks.join("")}</div>`;
  const notice = truncated
    ? `导图过大，已显示前 ${EXPORT_MAX_PAGES} 页（共需 ${plans.length} 页），完整结构见下方文字大纲`
    : null;
  return { html, pages: total, nodeCount, notice };
}

/**
 * 渲染完整树状导图（根在左、子级向右，不折叠任何分支），导出 HTML 的入口。
 * `nodes` 为空（或只有根、无子级）时返回空串，不输出空 svg。
 */
export function renderMindMapSvg(
  nodes: MindMapNode[],
  rootLabel: string,
  sectionNumber: Map<string, number>,
): string {
  return renderMindMapForExport(nodes, rootLabel, sectionNumber).html;
}
