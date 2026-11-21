import { afterEach, describe, expect, it, vi } from "vitest";
import { sendUpload, UPLOAD_TIMEOUT_MESSAGE, type UploadClientOptions } from "@/lib/upload-client";

/** 模拟浏览器 XHR：timeout 从 send() 起算，进度事件不重置（与真实行为一致）。 */
class FakeXhr {
  timeout = 0;
  status = 0;
  responseText = "";
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  aborted = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  open() {}
  setRequestHeader() {}
  send() {
    if (this.timeout > 0) this.timer = setTimeout(() => this.ontimeout?.(), this.timeout);
  }
  abort() {
    this.aborted = true;
    if (this.timer) clearTimeout(this.timer);
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total });
  }
  complete(status = 201, responseText = "{}") {
    if (this.timer) clearTimeout(this.timer);
    this.status = status;
    this.responseText = responseText;
    this.onload?.();
  }
}

function setup(overrides: Partial<UploadClientOptions> = {}) {
  const xhr = new FakeXhr();
  const onProgress = vi.fn();
  const onSuccess = vi.fn();
  const onError = vi.fn();
  sendUpload({
    url: "/api/upload?name=a.mp4",
    file: {} as File,
    onProgress,
    onSuccess,
    onError,
    createXhr: () => xhr as unknown as XMLHttpRequest,
    ...overrides,
  });
  return { xhr, onProgress, onSuccess, onError };
}

describe("上传超时判定", () => {
  afterEach(() => vi.useRealTimers());

  it("慢速但持续进展的上传不应被 30 分钟硬超时打断", () => {
    vi.useFakeTimers();
    const { xhr, onSuccess, onError } = setup();
    // 90 分钟持续上传，每分钟都有进度
    for (let min = 1; min <= 90; min++) {
      vi.advanceTimersByTime(60_000);
      xhr.progress(min * 1000, 90_000);
    }
    xhr.complete(201);
    expect(onError).not.toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it("连续无进展达到停滞窗口才判超时", () => {
    vi.useFakeTimers();
    const { xhr, onError } = setup({ stallMs: 120_000 });
    vi.advanceTimersByTime(60_000);
    xhr.progress(100, 1000);
    vi.advanceTimersByTime(119_000);
    expect(onError).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(onError).toHaveBeenCalledWith(UPLOAD_TIMEOUT_MESSAGE);
    expect(xhr.aborted).toBe(true);
  });
});
