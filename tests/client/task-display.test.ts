import { describe, expect, it } from "vitest";
import type { Task } from "@/server/tasks";
import type { QueueSnapshot } from "@/server/runner";
import { queuedPositions } from "@/lib/task-display";

function task(id: string, status: Task["status"] = "queued"): Task {
  return {
    id,
    originalName: `${id}.mp4`,
    ext: ".mp4",
    sizeBytes: 1024,
    durationSec: null,
    status,
    progress: 0,
    error: null,
    createdAt: new Date(0).toISOString(),
    mediaPurgedAt: null,
    sourceKind: "upload",
    sourceUrl: null,
    sourceTitle: null,
    sourceThumbnail: null,
    transcriptOrigin: null,
    downloadPct: null,
    sourceNotice: null,
    detailLevel: null,
    purpose: null,
    owner: "device",
  };
}

function snapshot(queued: Task[]): QueueSnapshot {
  return { active: [], queued, queuedLimit: 5 };
}

describe("任务列表排队位次", () => {
  it("以服务端队列快照为准，从 1 开始编号", () => {
    const positions = queuedPositions([task("a"), task("b")], snapshot([task("b"), task("a")]));
    expect(positions.get("b")).toBe(1);
    expect(positions.get("a")).toBe(2);
  });

  it("快照里还没有的 queued 任务按列表先后补在已有位次之后", () => {
    // 列表最新的在前：刚上传的 a 排在 b、c 之前，但它是最后入队的
    const positions = queuedPositions(
      [task("a"), task("b"), task("c")],
      snapshot([task("c")]),
    );
    expect(positions.get("c")).toBe(1);
    expect(positions.get("b")).toBe(2);
    expect(positions.get("a")).toBe(3);
  });

  it("非 queued 任务与空快照不产生位次", () => {
    const positions = queuedPositions([task("ready", "ready")], null);
    expect(positions.size).toBe(0);
    expect(queuedPositions([task("x")], null).get("x")).toBe(1);
  });
});
