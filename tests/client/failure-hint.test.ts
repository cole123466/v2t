import { describe, expect, it } from "vitest";
import { failureHint } from "@/lib/failure-hint";

/** 用例取自真实日志与管线抛出的文案 */
describe("失败提示分类", () => {
  it("网络层失败：不劝重传，说明稍后重试即可", () => {
    for (const error of [
      "fetch failed",
      "TypeError: fetch failed",
      "连接超时 timeout",
      "ASR 服务返回 502：upstream connect error",
    ]) {
      const { kind, hint } = failureHint(error);
      expect(kind).toBe("network");
      expect(hint).toContain("不用重新上传");
    }
  });

  it("文件问题：让用户检查后重新上传", () => {
    for (const error of [
      "文件中没有检测到音轨",
      "ffprobe 无法解析时长（/data/tasks/x/source.mp4）",
      "ffmpeg 处理失败（/data/x.mp4）：Invalid data found when processing input",
    ]) {
      const { kind, hint } = failureHint(error);
      expect(kind).toBe("media");
      expect(hint).toContain("重新上传");
    }
  });

  it("链接/下载失败：建议换链接或改上传", () => {
    const bili =
      "下载失败（https://www.bilibili.com/video/BV1y）：ERROR: [BiliBili] 无法下载网页：HTTP Error 412（B 站风控拦截，可配置 .env 的 DOWNLOADER_COOKIES_FILE 或更换出口网络）";
    expect(failureHint(bili).kind).toBe("source");
    expect(failureHint(bili).hint).toContain("换一个链接");
    expect(failureHint("链接任务缺少来源地址").kind).toBe("source");
  });

  it("配置缺失：提示联系维护者，重试没用", () => {
    for (const error of ["未配置 SILICONFLOW_API_KEY", "未找到 yt-dlp，请先运行 scripts/setup 脚本安装下载器"]) {
      const { kind, hint } = failureHint(error);
      expect(kind).toBe("config");
      expect(hint).toContain("请联系维护者");
    }
  });

  it("认不出来或没有错误信息时给通用建议", () => {
    expect(failureHint("未知错误").kind).toBe("other");
    expect(failureHint(null).kind).toBe("other");
    expect(failureHint("   ").kind).toBe("other");
    expect(failureHint(undefined).hint).toContain("重试");
  });
});
