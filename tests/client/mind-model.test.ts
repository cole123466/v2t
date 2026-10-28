import { describe, expect, it } from "vitest";
import type { MindMapNode } from "@/server/article";
import {
  estimateNodeBox,
  indexTree,
  MIND_MAX_NODES,
  overviewMind,
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
    const layout = overviewMind(index, new Set(), 0, false);
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
    const p0 = overviewMind(index, new Set(), 0, false);
    const p1 = overviewMind(index, new Set(), 1, false);
    const p99 = overviewMind(index, new Set(), 99, false);
    expect(p0.nodes.filter((n) => n.depth === 1)).toHaveLength(10);
    expect(p1.nodes.filter((n) => n.depth === 1)).toHaveLength(3);
    expect(p99.nodes.filter((n) => n.depth === 1)).toHaveLength(3);
  });

  it("画布高度不低于 256", () => {
    const index = indexTree([{ label: "唯一主题", sectionId: "s1" }], "t", sections);
    expect(overviewMind(index, new Set(), 0, false).height).toBeGreaterThanOrEqual(256);
  });

  it("窄屏退化：主题竖排两列，连线为三段折线（无 C 命令）", () => {
    const input: MindMapNode[] = [
      { label: "一", sectionId: "s1" },
      { label: "二", sectionId: "s2" },
      { label: "三", sectionId: "s3" },
    ];
    const index = indexTree(input, "t", sections);
    const layout = overviewMind(index, new Set(), 0, true);
    const topics = layout.nodes.filter((n) => n.depth === 1);
    expect(topics).toHaveLength(3);
    // 两列网格：x 只有两个取值
    expect(new Set(topics.map((n) => n.x)).size).toBe(2);
    expect(layout.edges.every((e) => !e.path.includes("C"))).toBe(true);
    // 根独占整行，在主题上方
    const root = layout.nodes.find((n) => n.depth === 0)!;
    expect(topics.every((n) => n.y > root.y)).toBe(true);
  });

  it("收起的分组不展开子节点", () => {
    const input: MindMapNode[] = [
      { label: "分组", children: [{ label: "子点", sectionId: "s1" }] },
    ];
    const index = indexTree(input, "t", sections);
    const open = overviewMind(index, new Set(), 0, false);
    const closed = overviewMind(index, new Set(["p0-0"]), 0, false);
    expect(open.nodes).toHaveLength(3);
    expect(closed.nodes).toHaveLength(2);
  });
});
