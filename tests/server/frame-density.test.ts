import { describe, expect, it } from "vitest";
import { MAX_OVERVIEW_FRAMES, MIN_OVERVIEW_FRAMES, overviewFrameCount, overviewTimestamps } from "@/server/frames";

describe("全景帧密度", () => {
  it("按 20s 一帧计算", () => {
    expect(overviewFrameCount(600)).toBe(30);
    expect(overviewFrameCount(1600)).toBe(80);
    expect(overviewFrameCount(2401)).toBe(120);
  });

  it("短片不低于既有 12 帧", () => {
    expect(MIN_OVERVIEW_FRAMES).toBe(12);
    expect(overviewFrameCount(60)).toBe(12);
    expect(overviewFrameCount(200)).toBe(12);
    expect(overviewFrameCount(240)).toBe(12);
  });

  it("超长片截断到上限", () => {
    expect(MAX_OVERVIEW_FRAMES).toBe(120);
    expect(overviewFrameCount(3600)).toBe(120);
    expect(overviewFrameCount(7200)).toBe(120);
  });

  it("非法时长返回 0", () => {
    expect(overviewFrameCount(0)).toBe(0);
    expect(overviewFrameCount(-10)).toBe(0);
    expect(overviewFrameCount(Number.NaN)).toBe(0);
  });

  it("采样点落在片内且严格递增", () => {
    const timestamps = overviewTimestamps(600, 30);
    expect(timestamps).toHaveLength(30);
    expect(timestamps[0]).toBeGreaterThan(0);
    expect(timestamps[timestamps.length - 1]).toBeLessThan(600);
    expect(timestamps.every((t, i) => i === 0 || t > timestamps[i - 1])).toBe(true);
  });
});
