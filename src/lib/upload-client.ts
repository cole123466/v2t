"use client";

/**
 * 浏览器端单文件上传：管理 XHR 生命周期与错误归类。
 * 从导入页抽出，便于用假 XHR + 假定时器复现/回归上传超时判定。
 */
export interface UploadClientOptions {
  url: string;
  file: File;
  onProgress: (pct: number) => void;
  onSuccess: () => void;
  onError: (message: string) => void;
  /** 测试注入，默认 new XMLHttpRequest() */
  createXhr?: () => XMLHttpRequest;
  /** 连续无进展多久判停滞，默认 2 分钟 */
  stallMs?: number;
  /** 字节发完后等响应多久，默认 5 分钟 */
  responseMs?: number;
}

export const UPLOAD_TIMEOUT_MESSAGE = "上传超时，请检查网络后重试";

const DEFAULT_STALL_MS = 2 * 60 * 1000;
const DEFAULT_RESPONSE_MS = 5 * 60 * 1000;

/** 发一个文件；返回中止句柄。成功/失败都通过回调通知，不抛异常。 */
export function sendUpload(options: UploadClientOptions): () => void {
  const { url, file, onProgress, onSuccess, onError } = options;
  const stallMs = options.stallMs ?? DEFAULT_STALL_MS;
  const responseMs = options.responseMs ?? DEFAULT_RESPONSE_MS;
  const createXhr = options.createXhr ?? (() => new XMLHttpRequest());
  const xhr = createXhr();
  let settled = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;

  const clearWatchdog = () => {
    if (watchdog !== undefined) clearTimeout(watchdog);
    watchdog = undefined;
  };

  /** 只认「停滞」：窗口内没有任何进度字节才中断，持续慢传不会误杀 */
  const armWatchdog = (ms: number) => {
    clearWatchdog();
    watchdog = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearWatchdog();
      xhr.abort();
      onError(UPLOAD_TIMEOUT_MESSAGE);
    }, ms);
  };

  const settle = (fn: () => void) => {
    if (settled) return;
    settled = true;
    clearWatchdog();
    fn();
  };

  xhr.open("POST", url);
  xhr.setRequestHeader("content-type", "application/octet-stream");
  // 不用 xhr.timeout：它是从 send() 起算的绝对总时长，进度事件不会重置，
  // 慢速但持续进展的大文件（如 250MB）会在 30 分钟处被误杀。改为停滞检测。

  xhr.upload.onprogress = (e) => {
    if (settled) return;
    if (e.lengthComputable && e.total > 0) {
      onProgress(Math.min(100, (e.loaded / e.total) * 100));
    }
    // 字节还在走就顺延；全部字节发完后改等响应，给更宽松的窗口
    armWatchdog(e.loaded >= e.total ? responseMs : stallMs);
  };
  xhr.onload = () => {
    if (settled) return;
    if (xhr.status === 201) {
      settle(onSuccess);
      return;
    }
    let message = `上传失败（${xhr.status}）`;
    try {
      message = (JSON.parse(xhr.responseText) as { error: string }).error || message;
    } catch {
      // 响应不是 JSON，保留状态码文案
    }
    settle(() => onError(message));
  };
  xhr.onerror = () => settle(() => onError("网络中断，上传失败"));
  xhr.ontimeout = () => settle(() => onError(UPLOAD_TIMEOUT_MESSAGE));

  armWatchdog(stallMs);
  try {
    xhr.send(file);
  } catch (error) {
    settle(() => onError(error instanceof Error ? error.message : "上传失败"));
  }

  return () => {
    if (settled) return;
    settled = true;
    clearWatchdog();
    xhr.abort();
  };
}
