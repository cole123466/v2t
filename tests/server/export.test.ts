import { describe, expect, it } from "vitest";
import type { Article } from "@/server/article";
import { buildCitationIndex, collectFrameIds, renderArticleMarkdown } from "@/server/export";
import { createZip } from "@/server/zip";

const article: Article = {
  title: "测试文章",
  sections: [
    {
      id: "s1",
      title: "第一章",
      blocks: [{ text: "第一句 [[t01]]，画面 [[f00]] 与 [[f01]]，重复引用 [[f00]]。" }],
    },
  ],
  mindMap: [{ label: "根", children: [{ label: "子", sectionId: "s1" }] }],
  limitations: [{ text: "这里不确定 [[t02]]" }],
};

const citations = new Map([
  ["t01", { id: "t01", kind: "t" as const, timeSec: 2.5, endSec: 7.2 }],
  ["t02", { id: "t02", kind: "t" as const, timeSec: 65, endSec: 70 }],
  ["f00", { id: "f00", kind: "f" as const, timeSec: 19 }],
  ["f01", { id: "f01", kind: "f" as const, timeSec: 39 }],
]);

describe("Markdown 导出", () => {
  const md = renderArticleMarkdown({
    article,
    detailLevel: "标准",
    purpose: "测试关注点",
    model: "glm-4.6",
    sourceUrl: "https://example.com/v?x=1",
    citations,
    images: new Map([
      ["f00", "images/frame-001.jpg"],
      ["f01", "images/frame-002.jpg"],
    ]),
  });

  it("元信息、目录与章节锚点", () => {
    expect(md).toContain("# 测试文章");
    expect(md).toContain("解读详细程度：标准");
    expect(md).toContain("原视频：[打开原片](<https://example.com/v?x=1>)");
    expect(md).toContain("生成模型：glm-4.6");
    expect(md).toContain("本次关注点：测试关注点");
    expect(md).toContain("- [第一章](#section-1)");
    expect(md).toContain('<a id="section-1"></a>');
  });

  it("时间引用转脚注，画面引用不留标记", () => {
    expect(md).toContain("第一句 [^source-1]");
    expect(md).not.toContain("[[t01]]");
    expect(md).not.toContain("[[f00]]");
  });

  it("画面渲染为相对路径图片与图注", () => {
    expect(md).toContain("![画面 f00 · 00:19](images/frame-001.jpg)");
    expect(md).toContain("*图：画面 f00 · 00:19*");
    // 同段重复引用只出一张图
    expect(md.match(/images\/frame-001\.jpg/g)?.length).toBe(1);
  });

  it("导图带章节跳转，限制章节与来源列表齐全", () => {
    expect(md).toContain("## 文章导图");
    expect(md).toContain("- [子](#section-1)");
    expect(md).toContain("## 还没确认的部分");
    expect(md).toContain("## 来源");
    expect(md).toContain("[^source-1]: [转写 · 00:02](<https://example.com/v?x=1&t=2>)（至 00:07）");
  });
});

describe("导出辅助", () => {
  it("collectFrameIds 按出现顺序去重", () => {
    expect(collectFrameIds(article)).toEqual(["f00", "f01"]);
  });

  it("buildCitationIndex 覆盖转写与帧", () => {
    const index = buildCitationIndex(
      { durationSec: 70, language: "zh", timestampsMissing: false, segments: [{ start: 1, end: 2, text: "甲" }] },
      { width: 1280, frames: [{ id: "f00", tSec: 3, file: "frames/f00.jpg", kind: "overview", width: 1280 }] },
    );
    expect(index.get("t01")?.timeSec).toBe(1);
    expect(index.get("f00")?.kind).toBe("f");
  });
});

describe("ZIP 打包", () => {
  it("生成可识别的 ZIP 并包含条目名", () => {
    const zip = createZip([
      { name: "article.md", data: Buffer.from("# hi") },
      { name: "images/frame-001.jpg", data: Buffer.from([1, 2, 3]) },
    ]);
    expect(zip.subarray(0, 4).toString("hex")).toBe("504b0304");
    expect(zip.toString("utf8")).toContain("article.md");
    expect(zip.toString("utf8")).toContain("images/frame-001.jpg");
    expect(zip.subarray(-22, -18).toString("hex")).toBe("504b0506");
  });
});
