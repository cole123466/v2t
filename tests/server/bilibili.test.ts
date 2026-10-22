import { describe, expect, it } from "vitest";
import { isBilibiliUrl } from "@/server/bilibili";

describe("B 站链接识别（API 兜底通道的入口判断）", () => {
  it("识别正式视频页与短链", () => {
    expect(isBilibiliUrl("https://www.bilibili.com/video/BV1AdKF64EJ7?spm_id_from=333.788")).toBe(true);
    expect(isBilibiliUrl("https://b23.tv/abcd123")).toBe(true);
    expect(isBilibiliUrl("https://m.bilibili.com/video/BV1AdKF64EJ7")).toBe(true);
  });

  it("不误判其他站点与非法输入", () => {
    expect(isBilibiliUrl("https://www.youtube.com/watch?v=x")).toBe(false);
    expect(isBilibiliUrl("https://bilibili.com.evil.test/video/BV1AdKF64EJ7")).toBe(false);
    expect(isBilibiliUrl("not a url")).toBe(false);
  });
});
