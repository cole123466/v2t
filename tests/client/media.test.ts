import { describe, expect, it } from "vitest";
import { isAbortError, safePlay } from "@/lib/media";

/** 只需 play() 的对象 mock，不依赖 jsdom 的媒体实现 */
function fakeMedia(play: () => Promise<void>): HTMLMediaElement {
  return { play } as unknown as HTMLMediaElement;
}

describe("安全播放", () => {
  it("play() 正常完成时返回 true", async () => {
    await expect(safePlay(fakeMedia(() => Promise.resolve()))).resolves.toBe(true);
  });

  it("play() 被 pause() 打断（AbortError）时静默返回 false", async () => {
    const media = fakeMedia(() =>
      Promise.reject(new DOMException("The play() request was interrupted by a call to pause()", "AbortError")),
    );
    await expect(safePlay(media)).resolves.toBe(false);
  });

  it("其他播放错误（如自动播放被拒）原样抛出", async () => {
    const error = new DOMException("play() failed because the user didn't interact", "NotAllowedError");
    await expect(safePlay(fakeMedia(() => Promise.reject(error)))).rejects.toBe(error);
  });

  it("isAbortError 只认 DOMException 里的 AbortError", () => {
    expect(isAbortError(new DOMException("x", "AbortError"))).toBe(true);
    expect(isAbortError(new DOMException("x", "NotAllowedError"))).toBe(false);
    expect(isAbortError(new Error("AbortError"))).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError("AbortError")).toBe(false);
  });
});
