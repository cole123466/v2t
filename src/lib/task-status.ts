import type { TaskStatus } from "@/server/tasks";

/**
 * 任务是否处于串行管线的某个处理阶段（不可删除、不可生成）。
 * 注意：canceled 是终态，不属于处理中——重启后 reap 不会碰它（12 号票 I5）。
 */
export function isProcessing(status: TaskStatus): boolean {
  return (
    status === "queued" ||
    status === "downloading" ||
    status === "extracting" ||
    status === "fetching-subtitles" ||
    status === "transcribing" ||
    status === "extracting-frames"
  );
}

/**
 * 任务是否进入终态。与 SSE 服务端收流条件保持一致：服务端在终态 close 流，
 * 浏览器会把「流结束」当断线并每 3 秒重连，客户端须在收到终态快照时 close。
 */
export function isTaskTerminal(status: TaskStatus): boolean {
  return status === "ready" || status === "failed" || status === "canceled";
}

export const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: "排队中",
  downloading: "下载中",
  extracting: "抽取音频",
  "fetching-subtitles": "获取字幕",
  transcribing: "转写中",
  "extracting-frames": "抽取画面",
  ready: "就绪",
  failed: "失败",
  canceled: "已取消",
};
