import { describe, expect, it } from "vitest";
import {
  addUploads,
  removeUpload,
  setUploadProgress,
  startNext,
  uploadSummary,
  type UploadItem,
} from "@/lib/upload-queue";

function item(id: string, state: UploadItem["state"] = "waiting", pct = 0): UploadItem {
  return { id, name: `${id}.mp4`, sizeBytes: 1024, pct, state };
}

describe("浏览器上传队列", () => {
  describe("addUploads", () => {
    it("按顺序追加，统一从 waiting / 0% 起步", () => {
      const existing = [item("a", "uploading", 42)];
      const result = addUploads(existing, [
        { id: "b", name: "b.mp4", sizeBytes: 2048 },
        { id: "c", name: "c.mp4", sizeBytes: 4096 },
      ]);
      expect(result).toEqual([
        item("a", "uploading", 42),
        { id: "b", name: "b.mp4", sizeBytes: 2048, pct: 0, state: "waiting" },
        { id: "c", name: "c.mp4", sizeBytes: 4096, pct: 0, state: "waiting" },
      ]);
      expect(existing).toEqual([item("a", "uploading", 42)]);
    });

    it("空数组不改变已有队列", () => {
      const list = [item("a")];
      expect(addUploads(list, [])).toEqual(list);
    });
  });

  describe("startNext", () => {
    it("没有在传的文件时取第一个 waiting", () => {
      const list = [item("a"), item("b")];
      const { list: nextList, next } = startNext(list);
      expect(next?.id).toBe("a");
      expect(nextList).toEqual([item("a", "uploading"), item("b")]);
      expect(list).toEqual([item("a"), item("b")]);
    });

    it("已有文件在传时返回 null（串行）", () => {
      const list = [item("a", "uploading", 30), item("b")];
      const result = startNext(list);
      expect(result.next).toBeNull();
      expect(result.list).toBe(list);
    });

    it("没有 waiting 时返回 null", () => {
      expect(startNext([]).next).toBeNull();
      expect(startNext([item("a", "uploading", 100)]).next).toBeNull();
    });
  });

  describe("setUploadProgress", () => {
    it("只更新匹配项并把进度夹到 0-100", () => {
      const list = [item("a", "uploading", 10), item("b")];
      expect(setUploadProgress(list, "a", 12.6)).toEqual([item("a", "uploading", 13), item("b")]);
      expect(setUploadProgress(list, "a", -5)).toEqual([item("a", "uploading", 0), item("b")]);
      expect(setUploadProgress(list, "a", 120)).toEqual([item("a", "uploading", 100), item("b")]);
    });

    it("未知 id 不改变任何项", () => {
      const list = [item("a", "uploading", 10)];
      expect(setUploadProgress(list, "missing", 50)).toEqual(list);
      expect(list[0].pct).toBe(10);
    });
  });

  describe("removeUpload", () => {
    it("按 id 出列，未知 id 保持原样", () => {
      const list = [item("a"), item("b"), item("c")];
      expect(removeUpload(list, "b")).toEqual([item("a"), item("c")]);
      expect(removeUpload(list, "missing")).toEqual(list);
      expect(list).toHaveLength(3);
    });
  });

  describe("uploadSummary", () => {
    it("返回当前上传项与全部 waiting", () => {
      const list = [item("a", "uploading", 40), item("b"), item("c")];
      expect(uploadSummary(list)).toEqual({
        active: item("a", "uploading", 40),
        waiting: [item("b"), item("c")],
      });
    });

    it("空队列和纯 waiting 队列没有 active", () => {
      expect(uploadSummary([])).toEqual({ active: null, waiting: [] });
      expect(uploadSummary([item("a"), item("b")])).toEqual({
        active: null,
        waiting: [item("a"), item("b")],
      });
    });
  });

  it("串行流程：上传中继续追加，完成后自动接下一个", () => {
    let list = addUploads([], [
      { id: "a", name: "a.mp4", sizeBytes: 1 },
      { id: "b", name: "b.mp4", sizeBytes: 2 },
    ]);
    const first = startNext(list);
    expect(first.next?.id).toBe("a");
    list = first.list;

    list = addUploads(list, [{ id: "c", name: "c.mp4", sizeBytes: 3 }]);
    expect(startNext(list).next).toBeNull();

    list = removeUpload(list, "a");
    const second = startNext(list);
    expect(second.next?.id).toBe("b");
    list = second.list;
    expect(uploadSummary(list).waiting.map((entry) => entry.id)).toEqual(["c"]);
  });
});
