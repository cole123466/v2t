import { describe, expect, it } from "vitest";
import {
  closeUncovered,
  parseSubtitles,
  parseTimestamp,
  subtitleCoverage,
} from "@/server/subtitle";

describe("字幕解析（纯函数）", () => {
  it("SRT：序号行忽略，时间戳与文本正确解析", () => {
    const srt = [
      "1",
      "00:00:01,000 --> 00:00:03,500",
      "第一句",
      "",
      "2",
      "00:00:04,000 --> 00:00:06,000",
      "第二句",
      "",
    ].join("\n");
    expect(parseSubtitles(srt)).toEqual([
      { start: 1, end: 3.5, text: "第一句" },
      { start: 4, end: 6, text: "第二句" },
    ]);
  });

  it("WebVTT：跳过 WEBVTT 头与 NOTE 块，忽略位置参数", () => {
    const vtt = [
      "WEBVTT",
      "",
      "NOTE 这是注释",
      "",
      "00:00:01.000 --> 00:00:02.000 align:start position:0%",
      "带位置参数的 cue",
      "",
    ].join("\n");
    expect(parseSubtitles(vtt)).toEqual([
      { start: 1, end: 2, text: "带位置参数的 cue" },
    ]);
  });

  it("HTML 标签剥离、多行合并、空 cue 丢弃", () => {
    const srt = [
      "1",
      "00:00:01,000 --> 00:00:02,000",
      "<i>斜体</i>",
      "第二行",
      "",
      "2",
      "00:00:03,000 --> 00:00:04,000",
      "   ",
      "",
    ].join("\n");
    const cues = parseSubtitles(srt);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe("斜体 第二行");
  });

  it("时间戳解析：兼容逗号与点、时分秒与纯秒", () => {
    expect(parseTimestamp("00:01:02,500")).toBe(62.5);
    expect(parseTimestamp("01:02.5")).toBe(62.5);
    expect(parseTimestamp("62.5")).toBe(62.5);
    expect(parseTimestamp("abc")).toBeNull();
  });

  it("覆盖率：重叠 cue 只计一次并夹在时长内", () => {
    const cues = [
      { start: 0, end: 30, text: "a" },
      { start: 20, end: 50, text: "b" }, // 与上条重叠 10s，并集 [0,50]
      { start: 80, end: 120, text: "c" }, // 超出 100s 时长部分截断到 100
    ];
    // 并集 [0,50] + [80,100] = 70s
    expect(subtitleCoverage(cues, 100)).toBeCloseTo(0.7, 5);
    expect(subtitleCoverage(cues, 200)).toBeCloseTo(90 / 200, 5);
    expect(subtitleCoverage([], 100)).toBe(0);
    // 完全覆盖
    expect(subtitleCoverage([{ start: 0, end: 100, text: "x" }], 100)).toBe(1);
  });

  it("closeUncovered：后一条开始早于前一条结束时收口，避免时间戳倒挂", () => {
    const cues = [
      { start: 0, end: 10, text: "a" },
      { start: 5, end: 8, text: "b" },
    ];
    const fixed = closeUncovered(cues);
    expect(fixed[0].end).toBe(5);
    expect(fixed[1].end).toBe(8);
  });
});
