import { describe, expect, it } from "vitest";
import type { TaskStatus } from "@/server/tasks";
import { isProcessing, isTaskTerminal } from "@/lib/task-status";

const PROCESSING: TaskStatus[] = [
  "queued",
  "downloading",
  "extracting",
  "fetching-subtitles",
  "transcribing",
  "extracting-frames",
];
const TERMINAL: TaskStatus[] = ["ready", "failed", "canceled"];

describe("任务终态判定（SSE 收流一致性）", () => {
  it("ready/failed/canceled 视为终态", () => {
    for (const status of TERMINAL) expect(isTaskTerminal(status)).toBe(true);
  });

  it("处理中状态均非终态", () => {
    for (const status of PROCESSING) expect(isTaskTerminal(status)).toBe(false);
  });

  it("终态与处理中状态互补，且不重叠（与 SSE 服务端收流条件一致）", () => {
    const all: TaskStatus[] = [...PROCESSING, ...TERMINAL];
    expect(new Set(all).size).toBe(all.length);
    for (const status of all) {
      expect(isTaskTerminal(status)).toBe(!isProcessing(status));
    }
  });
});
