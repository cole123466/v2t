/**
 * 导图数据适配 + 星形概览布局（06 号票 M1）。
 *
 * 输入是文章自带的 `MindMapNode[]`（多根、可能含历史脏数据），
 * 这里只做前端适配：合成虚拟 root、生成路径 id、丢弃悬空引用，
 * 再算出概览布局坐标。不动后端、不改导图校验规则。
 */
import type { MindMapNode } from "@/server/article";

export interface MindNode {
  /** 路径 id：p0 / p0-1 / p0-1-2，稳定可作 React key 与折叠集合键 */
  id: string;
  parentId: string | null;
  label: string;
  /** 叶子指向章节 id；悬空引用在适配时置 null（历史文章可能是旧校验规则的产物） */
  sectionId: string | null;
  /** 虚拟 root 为 0，顶层主题为 1 */
  depth: number;
  childIds: string[];
}

export interface MindIndex {
  rootId: string;
  nodes: Map<string, MindNode>;
}

/** 适配防御上限：超深截断、总节点数封顶，防止脏数据把布局撑爆 */
export const MIND_MAX_DEPTH = 6;
export const MIND_MAX_NODES = 96;

/**
 * 把多根的 MindMapNode[] 合成为带虚拟 root 的扁平索引。
 * sectionIds 是存在章节的白名单；不在白名单的 sectionId 一律视为分组节点。
 */
export function indexTree(
  roots: MindMapNode[],
  rootLabel: string,
  sectionIds: ReadonlySet<string>,
): MindIndex {
  const nodes = new Map<string, MindNode>();
  const rootId = "p0";
  nodes.set(rootId, {
    id: rootId,
    parentId: null,
    label: rootLabel,
    sectionId: null,
    depth: 0,
    childIds: [],
  });

  let count = 1;
  const walk = (list: MindMapNode[], parentId: string, depth: number) => {
    if (depth > MIND_MAX_DEPTH) return;
    list.forEach((node, i) => {
      if (count >= MIND_MAX_NODES) return;
      if (!node.label?.trim()) return;
      const id = `${parentId}-${i}`;
      const sectionId =
        node.sectionId && sectionIds.has(node.sectionId) ? node.sectionId : null;
      nodes.set(id, {
        id,
        parentId,
        label: node.label.trim(),
        sectionId,
        depth,
        childIds: [],
      });
      count += 1;
      nodes.get(parentId)!.childIds.push(id);
      if (node.children?.length) walk(node.children, id, depth + 1);
    });
  };
  walk(roots, rootId, 1);
  return { rootId, nodes };
}

/**
 * 按字符宽度估算节点盒尺寸：布局先于渲染，避免挂载后二次跳动。
 * CJK 字符按全宽算，其余按半宽。
 */
export function estimateNodeBox(label: string, depth: number): { w: number; h: number } {
  let units = 0;
  for (const ch of label) units += ch.charCodeAt(0) > 0x2e7f ? 1 : 0.55;
  const w = Math.min(240, Math.max(56, Math.ceil(units * 13) + 20));
  const h = depth === 0 ? 44 : 32;
  return { w, h };
}

/**
 * 阅读器节点盒尺寸：按深度定宽、标签最多 3 行换行（对齐 vid-lens）。
 * 与概览的单行 estimateNodeBox 分开，阅读器要的是可读性不是紧凑。
 */
export function estimateReaderBox(label: string, depth: number): { w: number; h: number } {
  const w = depth === 0 ? 224 : depth === 1 ? 212 : 248;
  const font = depth === 0 ? 16 : depth === 1 ? 15 : 14;
  let units = 0;
  for (const ch of label) units += ch.charCodeAt(0) > 0x2e7f ? 1 : 0.56;
  const lines = Math.max(1, Math.min(3, Math.ceil((units * font) / (w - 42))));
  return { w, h: Math.max(48, Math.ceil(lines * 24 + 20)) };
}

export interface MindOverviewNode {
  id: string;
  label: string;
  sectionId: string | null;
  depth: number;
  /** 节点中心点，画布坐标系 */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MindOverviewEdge {
  id: string;
  /** 贝塞尔控制点与端点；窄屏退化成折线时走 polyline */
  path: string;
}

export interface MindOverviewLayout {
  nodes: MindOverviewNode[];
  edges: MindOverviewEdge[];
  width: number;
  height: number;
}

/** 一页最多展示的主题数（根自身不占主题位），超出走分页 */
export const MIND_TOPICS_PER_PAGE = 10;

const GAP_X = 48;
const GAP_Y = 16;
const NARROW_BREAKPOINT = 560;

/**
 * 星形概览布局：根居中，主题左右分列（左侧 floor(n/2)），
 * 一页最多 10 个主题；窄屏（narrow=true，视口 <560px）改为根独占整行、
 * 主题竖排两列网格，连线用三段折线。
 */
export function overviewMind(
  index: MindIndex,
  page: number,
  narrow: boolean,
): MindOverviewLayout {
  const root = index.nodes.get(index.rootId);
  if (!root) return { nodes: [], edges: [], width: 0, height: 0 };

  const rootBox = estimateNodeBox(root.label, 0);
  const topics = root.childIds
    .map((id) => index.nodes.get(id)!)
    .filter(Boolean);

  const pageCount = Math.max(1, Math.ceil(topics.length / MIND_TOPICS_PER_PAGE));
  const safePage = Math.min(Math.max(0, page), pageCount - 1);
  const visible = topics.slice(
    safePage * MIND_TOPICS_PER_PAGE,
    (safePage + 1) * MIND_TOPICS_PER_PAGE,
  );

  const nodes: MindOverviewNode[] = [];
  const edges: MindOverviewEdge[] = [];

  if (narrow) {
    // 窄屏：根独占整行，主题两列网格竖排，连线三段折线
    const cols = 2;
    const colW = 168;
    const rowH = 52;
    const rows = Math.ceil(visible.length / cols) || 1;
    const width = cols * colW + 24;
    const rootY = rootBox.h / 2 + 8;
    const gridTop = rootBox.h + 28;
    const height = Math.max(256, gridTop + rows * rowH + 8);

    nodes.push({
      id: root.id,
      label: root.label,
      sectionId: root.sectionId,
      depth: 0,
      x: width / 2,
      y: rootY,
      ...rootBox,
    });

    visible.forEach((topic, i) => {
      const box = estimateNodeBox(topic.label, topic.depth);
      const col = i % cols;
      const row = Math.floor(i / cols);
      // 两列交错居中：单数行换列序，避免视觉上一边倒
      const orderedCol = row % 2 === 1 ? cols - 1 - col : col;
      const x = 12 + orderedCol * colW + colW / 2 - 12;
      const y = gridTop + row * rowH + rowH / 2;
      nodes.push({
        id: topic.id,
        label: topic.label,
        sectionId: topic.sectionId,
        depth: topic.depth,
        x,
        y,
        ...box,
      });
      edges.push({ id: `${root.id}->${topic.id}`, path: elbowPath(nodes[0], nodes[nodes.length - 1]) });
    });
    return { nodes, edges, width, height };
  }

  // 宽屏：根居中，主题左右分列，左侧 floor(n/2)
  const leftCount = Math.floor(visible.length / 2);
  const left = visible.slice(0, leftCount);
  const right = visible.slice(leftCount);

  const sideGap = rootBox.w / 2 + GAP_X;
  const halfRows = Math.max(left.length, right.length, 1);
  const span = Math.max(
    halfRows * (32 + GAP_Y) - GAP_Y,
    visible.length * (32 + GAP_Y) - GAP_Y,
  );
  const width = Math.max(360, rootBox.w + sideGap * 2 + 240);
  const rootY = span / 2 + 16;
  const height = Math.max(256, span + 32);

  nodes.push({
    id: root.id,
    label: root.label,
    sectionId: root.sectionId,
    depth: 0,
    x: width / 2,
    y: rootY,
    ...rootBox,
  });

  const place = (list: typeof left, side: -1 | 1) => {
    const total = list.length * (32 + GAP_Y) - GAP_Y;
    list.forEach((topic, i) => {
      const box = estimateNodeBox(topic.label, topic.depth);
      const y = rootY - total / 2 + i * (32 + GAP_Y) + 16;
      const x = width / 2 + side * (sideGap + box.w / 2);
      nodes.push({
        id: topic.id,
        label: topic.label,
        sectionId: topic.sectionId,
        depth: topic.depth,
        x,
        y,
        ...box,
      });
      const node = nodes[nodes.length - 1];
      edges.push({ id: `${root.id}->${topic.id}`, path: bezierPath(nodes[0], node, side) });
    });
  };
  place(left, -1);
  place(right, 1);

  // 子节点可能超出按主题行数估算的高度，重新钳制画布
  const maxY = Math.max(...nodes.map((n) => n.y + n.h / 2), 0);
  return { nodes, edges, width, height: Math.max(height, maxY + 16) };
}

/** 宽屏连线：三次贝塞尔，bend = max(24, Δx * 0.46) */
function bezierPath(from: MindOverviewNode, to: MindOverviewNode, side: -1 | 1): string {
  const x1 = from.x + side * (from.w / 2);
  const y1 = from.y;
  const x2 = to.x - side * (to.w / 2);
  const y2 = to.y;
  const bend = Math.max(24, Math.abs(x2 - x1) * 0.46);
  return `M ${x1} ${y1} C ${x1 + side * bend} ${y1}, ${x2 - side * bend} ${y2}, ${x2} ${y2}`;
}

/** 窄屏连线：根底部 → 竖直段 → 水平段 → 节点左侧，三段折线 */
function elbowPath(from: MindOverviewNode, to: MindOverviewNode): string {
  const midY = (from.y + from.h / 2 + to.y - to.h / 2) / 2;
  return `M ${from.x} ${from.y + from.h / 2} L ${from.x} ${midY} L ${to.x} ${midY} L ${to.x} ${to.y - to.h / 2}`;
}

export { NARROW_BREAKPOINT };

/* ============================================================
 * 分支阅读层（对齐 vid-lens MindReader）：可见节点、祖先路径、
 * 树状布局、键盘导航。概览只到主题层，下钻阅读在这组函数上构建。
 * ============================================================ */

export interface MindBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MindWire {
  id: string;
  depth: number;
  d: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const READER_GAP_X = 56;
const READER_GAP_Y = 16;

/** 深度优先展开（跳过收起分支）；Map 迭代序即 indexTree 的插入序 */
export function visibleMind(
  index: MindIndex,
  collapsed: ReadonlySet<string>,
  rootId: string = index.rootId,
): MindNode[] {
  const result: MindNode[] = [];
  const walk = (id: string) => {
    const node = index.nodes.get(id);
    if (!node) return;
    result.push(node);
    if (!collapsed.has(id)) node.childIds.forEach(walk);
  };
  walk(rootId);
  return result;
}

export function descendantCount(index: MindIndex, id: string): number {
  return visibleMind(index, new Set(), id).length - 1;
}

/** 节点到根的路径（含自身），用于热路径高亮与面包屑 */
export function ancestorPath(index: MindIndex, nodeId: string | null): Set<string> {
  const path = new Set<string>();
  const guard = new Set<string>();
  let current = nodeId;
  while (current && !guard.has(current)) {
    guard.add(current);
    path.add(current);
    current = index.nodes.get(current)?.parentId ?? null;
  }
  return path;
}

/** 章节所属的第一个导图节点；找不到返回 null */
export function nodeForSection(index: MindIndex, sectionId: string | null): string | null {
  if (!sectionId) return null;
  for (const [id, node] of index.nodes) {
    if (node.sectionId === sectionId) return id;
  }
  return null;
}

/** 阅读器树状布局：根在左、子级向右缩进，父节点在子级跨度内垂直居中 */
export function layoutMind(
  visible: MindNode[],
  rootId: string,
  sizes: ReadonlyMap<string, { w: number; h: number }>,
): { boxes: Map<string, MindBox>; wires: MindWire[]; width: number; height: number } {
  const byId = new Map(visible.map((node) => [node.id, node]));
  const boxes = new Map<string, MindBox>();
  const sizeOf = (id: string): { w: number; h: number } => {
    const hit = sizes.get(id);
    if (hit) return hit;
    const node = byId.get(id);
    return estimateNodeBox(node?.label ?? "", node?.depth ?? 1);
  };
  const kidsOf = (id: string) =>
    (byId.get(id)?.childIds ?? []).filter((child) => byId.has(child));
  const extent = (id: string): number => {
    const kids = kidsOf(id);
    if (!kids.length) return sizeOf(id).h;
    const sum = kids.reduce((total, child) => total + extent(child), 0) + READER_GAP_Y * (kids.length - 1);
    return Math.max(sizeOf(id).h, sum);
  };
  const place = (id: string, x: number, top: number) => {
    const box = sizeOf(id);
    const span = extent(id);
    boxes.set(id, { x, y: top + (span - box.h) / 2, w: box.w, h: box.h });
    const kids = kidsOf(id);
    if (!kids.length) return;
    const kidsSpan = kids.reduce((total, child) => total + extent(child), 0) + READER_GAP_Y * (kids.length - 1);
    let cursor = top + (span - kidsSpan) / 2;
    for (const child of kids) {
      place(child, x + box.w + READER_GAP_X, cursor);
      cursor += extent(child) + READER_GAP_Y;
    }
  };
  place(rootId, 16, 12);
  let width = 32;
  let height = 24;
  for (const box of boxes.values()) {
    width = Math.max(width, box.x + box.w + 28);
    height = Math.max(height, box.y + box.h + 16);
  }
  const wires: MindWire[] = [];
  for (const node of visible) {
    if (!node.parentId) continue;
    const parent = boxes.get(node.parentId);
    const child = boxes.get(node.id);
    if (!parent || !child) continue;
    const x1 = parent.x + parent.w;
    const y1 = parent.y + parent.h / 2;
    const x2 = child.x;
    const y2 = child.y + child.h / 2;
    const bend = Math.max(24, (x2 - x1) * 0.46);
    wires.push({
      id: node.id,
      depth: node.depth,
      x1,
      y1,
      x2,
      y2,
      d: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
    });
  }
  return { boxes, wires, width, height };
}

export interface MindMove {
  focus: string;
  collapsed?: Set<string>;
}

/** 方向键导航：左右折叠/升层，上下同层可见序，Home/End 跳首尾 */
export function mindMove(
  focusedId: string,
  key: string,
  visible: MindNode[],
  collapsed: ReadonlySet<string>,
): MindMove | null {
  const at = visible.findIndex((node) => node.id === focusedId);
  const node = visible[at];
  if (!node) return null;
  if (key === "Home") return { focus: visible[0].id };
  if (key === "End") return { focus: visible[visible.length - 1].id };
  if (key === "ArrowDown" || key === "ArrowUp") {
    const next = visible[at + (key === "ArrowDown" ? 1 : -1)];
    return next ? { focus: next.id } : null;
  }
  if (key === "ArrowLeft") {
    if (node.childIds.length && !collapsed.has(node.id)) {
      return { focus: node.id, collapsed: new Set([...collapsed, node.id]) };
    }
    return node.parentId && visible.some((item) => item.id === node.parentId)
      ? { focus: node.parentId }
      : null;
  }
  if (key === "ArrowRight" && node.childIds.length) {
    const next = new Set(collapsed);
    next.delete(node.id);
    return { focus: node.childIds[0], ...(collapsed.has(node.id) ? { collapsed: next } : {}) };
  }
  return null;
}
