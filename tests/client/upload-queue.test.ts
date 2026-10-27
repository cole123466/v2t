import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addUploads,
  createUploadId,
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
  describe("createUploadId", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("安全上下文优先用 crypto.randomUUID", () => {
      const randomUUID = vi.fn(() => "123e4567-e89b-12d3-a456-426614174000");
      vi.stubGlobal("crypto", { randomUUID });
      expect(createUploadId()).toBe("123e4567-e89b-12d3-a456-426614174000");
      expect(randomUUID).toHaveBeenCalledOnce();
    });

    it("没有 randomUUID（非安全上下文）时回退到本地 id", () => {
      vi.stubGlobal("crypto", undefined);
      const id = createUploadId(1000, () => 0.5);
      expect(id).toBe(`u-${(1000).toString(36)}-${(0.5).toString(36).slice(2, 10)}`);
      expect(id.startsWith("u-")).toBe(true);
    });
  });

  it("追加多个文件后都处于 waiting，顺序保持", () => {
    const list = addUploads([], [
      { id: "a", name: "a.mp4", sizeBytes: 1 },
      { id: "b", name: "b.mp4", sizeBytes: 2 },
    ]);
    expect(list.map((u) => u.id)).toEqual(["a", "b"]);
    expect(list.every((u) => u.state === "waiting" && u.pct === 0)).toBe(true);
    expect(uploadSummary(list)).toMatchObject({ active: null });
    expect(uploadSummary(list).waiting.map((u) => u.id)).toEqual(["a", "b"]);
  });

  it("串行：已有 uploading 时不再取下一个", () => {
    const list = [item("a", "uploading", 30), item("b")];
    const result = startNext(list);
    expect(result.next).toBeNull();
    expect(result.list).toBe(list);
  });

  it("串行：空出后按先来后到取下一个", () => {
    const first = startNext([item("a"), item("b")]);
    expect(first.next?.id).toBe("a");
    expect(first.list.map((u) => u.state)).toEqual(["uploading", "waiting"]);

    const done = removeUpload(first.list, "a");
    const second = startNext(done);
    expect(second.next?.id).toBe("b");
  });

  it("进度钳制在 0–100 且取整，只影响目标任务", () => {
    const list = setUploadProgress([item("a", "uploading"), item("b")], "a", 42.6);
    expect(list[0].pct).toBe(43);
    expect(list[1].pct).toBe(0);
    expect(setUploadProgress(list, "a", -5)[0].pct).toBe(0);
    expect(setUploadProgress(list, "a", 130)[0].pct).toBe(100);
  });

  it("出列后队列为空即回到空闲", () => {
    const list = removeUpload([item("a", "uploading", 100)], "a");
    expect(list).toEqual([]);
    expect(uploadSummary(list)).toEqual({ active: null, waiting: [] });
  });

  it("连续选两个文件：a 传完前 b 一直 waiting，a 传完后 b 自动接上", () => {
    let list = addUploads([], [
      { id: "a", name: "a.mp4", sizeBytes: 1 },
      { id: "b", name: "b.mp4", sizeBytes: 1 },
    ]);

    const first = startNext(list);
    list = setUploadProgress(first.list, "a", 50);
    expect(uploadSummary(list).active?.id).toBe("a");
    expect(uploadSummary(list).waiting.map((u) => u.id)).toEqual(["b"]);
    // b 不会因为 a 还在传就被丢弃
    expect(startNext(list).next).toBeNull();

    list = removeUpload(list, "a");
    const second = startNext(list);
    expect(second.next?.id).toBe("b");
    list = removeUpload(second.list, "b");
    expect(uploadSummary(list)).toEqual({ active: null, waiting: [] });
  });
});
