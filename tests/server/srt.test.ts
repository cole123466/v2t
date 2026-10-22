import { describe, expect, it } from "vitest";
import { toSrt } from "@/lib/srt";

describe("SRT 生成（纯函数）", () => {
  it("标准分段：序号、时间轴格式、文本逐段输出", () => {
    const out = toSrt([
      { start: 0, end: 3.8, text: "大家好" },
      { start: 3.88, end: 8.96, text: "第二句" },
    ]);
    expect(out).toBe(
      "1\n00:00:00,000 --> 00:00:03,800\n大家好\n\n2\n00:00:03,880 --> 00:00:08,960\n第二句\n",
    );
  });

  it("跨小时边界与毫秒进位", () => {
    const out = toSrt([{ start: 3599.999, end: 3601.5, text: "x" }]);
    expect(out).toContain("00:59:59,999 --> 01:00:01,500");
  });

  it("空 segments 产出空串", () => {
    expect(toSrt([])).toBe("");
  });
});
