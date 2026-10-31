import { describe, expect, it } from "vitest";
import type { MindMapNode } from "@/server/article";
import {
  ancestorPath,
  estimateNodeBox,
  estimateReaderBox,
  indexTree,
  layoutMind,
  mindMove,
  MIND_MAX_NODES,
  nodeForSection,
  overviewMind,
  visibleMind,
} from "@/lib/mind-model";

const sections = new Set(["s1", "s2", "s3"]);

describe("indexTree 适配", () => {
  it("合成虚拟 root，顶层主题 depth=1，路径 id 稳定", () => {
    const input: MindMapNode[] = [
      { label: "主题一", sectionId: "s1", children: [{ label: "子点", sectionId: "s2" }] },
      { label: "主题二" },
    ];
    const index = indexTree(input, "文章标题", sections);
    const root = index.nodes.get(index.rootId)!;
    expect(root.parentId).toBeNull();
    expect(root.depth).toBe(0);
    expect(root.label).toBe("文章标题");
    expect(root.childIds).toEqual(["p0-0", "p0-1"]);
    const topic = index.nodes.get("p0-0")!;
    expect(topic.depth).toBe(1);
    expect(topic.sectionId).toBe("s1");
    const child = index.nodes.get("p0-0-0")!;
    expect(child.parentId).toBe("p0-0");
    expect(child.depth).toBe(2);
  });

  it("悬空 sectionId 置空，视为分组节点", () => {
    const input: MindMapNode[] = [{ label: "分组", sectionId: "nope" }];
    const index = indexTree(input, "t", sections);
    expect(index.nodes.get("p0-0")!.sectionId).toBeNull();
  });

  it("空 label 节点被丢弃（路径 id 保持数组位置）", () => {
    const input: MindMapNode[] = [{ label: "  " }, { label: "有效" }];
    const index = indexTree(input, "t", sections);
    expect(index.nodes.get("p0-1")!.label).toBe("有效");
    expect(index.nodes.has("p0-0")).toBe(false);
  });

  it("超过 6 层截断", () => {
    // 构造一条 10 层深的链，第 7 层起不进索引
    let node: MindMapNode = { label: "L10" };
    for (let i = 9; i >= 1; i--) node = { label: `L${i}`, children: [node] };
    const index = indexTree([{ label: "L0", children: [node] }], "t", sections);
    expect(index.nodes.has("p0-0-0-0-0-0-0-0")).toBe(false);
    expect(index.nodes.has("p0-0-0-0-0-0-0")).toBe(true);
  });

  it("节点总数封顶 96", () => {
    const kids: MindMapNode[] = Array.from({ length: 120 }, (_, i) => ({ label: `n${i}` }));
    const index = indexTree([{ label: "root", children: kids }], "t", sections);
    expect(index.nodes.size).toBe(MIND_MAX_NODES);
  });
});

describe("estimateNodeBox", () => {
  it("CJK 全宽、latin 半宽，且有上下限", () => {
    const cjk = estimateNodeBox("四个汉字", 1);
    const latin = estimateNodeBox("abcd", 1);
    expect(cjk.w).toBeGreaterThan(latin.w);
    expect(cjk.h).toBe(32);
    expect(estimateNodeBox("", 0).h).toBe(44);
    expect(estimateNodeBox("一".repeat(50), 1).w).toBeLessThanOrEqual(240);
  });
});

describe("estimateReaderBox 阅读器盒尺寸", () => {
  it("按深度定宽，长标签换行到最多 3 行，高度随行数增长", () => {
    const short = estimateReaderBox("短", 2);
    const long = estimateReaderBox("很".repeat(40), 2);
    expect(short.w).toBe(248);
    expect(long.w).toBe(248);
    expect(long.h).toBeGreaterThan(short.h);
    // 3 行封顶：再长也不会更高
    const extreme = estimateReaderBox("超".repeat(80), 2);
    expect(extreme.h).toBe(long.h);
    expect(long.h).toBeGreaterThanOrEqual(48);
  });

  it("与概览的单行盒尺寸相互独立", () => {
    const label = "某个中等长度的主题标签文字";
    expect(estimateReaderBox(label, 1).w).not.toBe(estimateNodeBox(label, 1).w);
  });
});

describe("overviewMind 星形布局", () => {
  it("根居中，主题左右分列（左 floor(n/2)），连线为贝塞尔", () => {
    const input: MindMapNode[] = [
      { label: "一", sectionId: "s1" },
      { label: "二", sectionId: "s2" },
      { label: "三", sectionId: "s3" },
      { label: "四" },
      { label: "五" },
    ];
    const index = indexTree(input, "标题", sections);
    const layout = overviewMind(index, 0, false);
    const root = layout.nodes.find((n) => n.depth === 0)!;
    expect(root.x).toBeCloseTo(layout.width / 2);
    const left = layout.nodes.filter((n) => n.x < root.x && n.depth === 1);
    const right = layout.nodes.filter((n) => n.x > root.x && n.depth === 1);
    expect(left).toHaveLength(2);
    expect(right).toHaveLength(3);
    expect(layout.edges.every((e) => e.path.startsWith("M ") && e.path.includes("C "))).toBe(true);
  });

  it("一页最多 10 个主题，页码越界钳回", () => {
    const input: MindMapNode[] = Array.from({ length: 13 }, (_, i) => ({
      label: `主题${i}`,
      sectionId: "s1",
    }));
    const index = indexTree(input, "t", sections);
    const p0 = overviewMind(index, 0, false);
    const p1 = overviewMind(index, 1, false);
    const p99 = overviewMind(index, 99, false);
    expect(p0.nodes.filter((n) => n.depth === 1)).toHaveLength(10);
    expect(p1.nodes.filter((n) => n.depth === 1)).toHaveLength(3);
    expect(p99.nodes.filter((n) => n.depth === 1)).toHaveLength(3);
  });

  it("画布高度不低于 256", () => {
    const index = indexTree([{ label: "唯一主题", sectionId: "s1" }], "t", sections);
    expect(overviewMind(index, 0, false).height).toBeGreaterThanOrEqual(256);
  });

  it("窄屏退化：主题竖排两列，连线为三段折线（无 C 命令）", () => {
    const input: MindMapNode[] = [
      { label: "一", sectionId: "s1" },
      { label: "二", sectionId: "s2" },
      { label: "三", sectionId: "s3" },
    ];
    const index = indexTree(input, "t", sections);
    const layout = overviewMind(index, 0, true);
    const topics = layout.nodes.filter((n) => n.depth === 1);
    expect(topics).toHaveLength(3);
    // 两列网格：x 只有两个取值
    expect(new Set(topics.map((n) => n.x)).size).toBe(2);
    expect(layout.edges.every((e) => !e.path.includes("C"))).toBe(true);
    // 根独占整行，在主题上方
    const root = layout.nodes.find((n) => n.depth === 0)!;
    expect(topics.every((n) => n.y > root.y)).toBe(true);
  });

  it("概览只渲染根与主题层，子级留给阅读弹层", () => {
    const input: MindMapNode[] = [
      { label: "分组", children: [{ label: "子点", sectionId: "s1" }] },
      { label: "主题二" },
    ];
    const index = indexTree(input, "t", sections);
    const layout = overviewMind(index, 0, false);
    // 根 + 2 个主题，子点不出现在概览
    expect(layout.nodes).toHaveLength(3);
    expect(layout.nodes.every((n) => n.depth <= 1)).toBe(true);
  });
});

describe("分支阅读层", () => {
  const input: MindMapNode[] = [
    {
      label: "主题一",
      sectionId: "s1",
      children: [
        { label: "概念A", sectionId: "s2" },
        { label: "概念B", children: [{ label: "概念B1" }] },
      ],
    },
    { label: "主题二", sectionId: "s3" },
  ];
  const index = indexTree(input, "标题", sections);

  it("visibleMind 默认全展开，跳过收起分支，可按主题定界", () => {
    const all = visibleMind(index, new Set());
    expect(all.map((n) => n.id)).toEqual(["p0", "p0-0", "p0-0-0", "p0-0-1", "p0-0-1-0", "p0-1"]);
    const folded = visibleMind(index, new Set(["p0-0"]));
    expect(folded.map((n) => n.id)).toEqual(["p0", "p0-0", "p0-1"]);
    const scoped = visibleMind(index, new Set(), "p0-0");
    expect(scoped.map((n) => n.id)).toEqual(["p0-0", "p0-0-0", "p0-0-1", "p0-0-1-0"]);
  });

  it("ancestorPath 含自身与根；nodeForSection 取首个映射节点", () => {
    const path = ancestorPath(index, "p0-0-1-0");
    expect(path.has("p0")).toBe(true);
    expect(path.has("p0-0-1")).toBe(true);
    expect(nodeForSection(index, "s2")).toBe("p0-0-0");
    expect(nodeForSection(index, "nope")).toBeNull();
  });

  it("layoutMind：父在子级跨度内居中，连线为贝塞尔", () => {
    const visible = visibleMind(index, new Set());
    const layout = layoutMind(visible, index.rootId, new Map());
    const parent = layout.boxes.get("p0-0")!;
    const kids = ["p0-0-0", "p0-0-1"].map((id) => layout.boxes.get(id)!);
    const mid = (kids[0].y + kids[0].h / 2 + kids[1].y + kids[1].h / 2) / 2;
    expect(parent.y + parent.h / 2).toBeCloseTo(mid, 5);
    expect(layout.wires).toHaveLength(visible.length - 1);
    expect(layout.wires.every((w) => w.d.startsWith("M ") && w.d.includes("C "))).toBe(true);
  });

  it("mindMove：上下同层序，左右折叠/升层，Home/End 跳首尾", () => {
    const visible = visibleMind(index, new Set());
    const collapsed = new Set<string>();
    expect(mindMove("p0", "ArrowDown", visible, collapsed)?.focus).toBe("p0-0");
    expect(mindMove("p0-0-0", "ArrowUp", visible, collapsed)?.focus).toBe("p0-0");
    // 左：展开节点先折叠自己
    const fold = mindMove("p0-0", "ArrowLeft", visible, collapsed);
    expect(fold?.focus).toBe("p0-0");
    expect(fold?.collapsed).toContain("p0-0");
    // 左：已折叠的升到父级
    expect(mindMove("p0-0", "ArrowLeft", visible, new Set(["p0-0"]))?.focus).toBe("p0");
    // 右：进入第一个子级
    expect(mindMove("p0-0", "ArrowRight", visible, collapsed)?.focus).toBe("p0-0-0");
    expect(mindMove("p0", "Home", visible, collapsed)?.focus).toBe("p0");
    expect(mindMove("p0", "End", visible, collapsed)?.focus).toBe("p0-1");
  });
});
