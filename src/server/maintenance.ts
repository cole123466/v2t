import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { isProcessing } from "@/lib/task-status";
import { removeFrames } from "./frames";
import type { ActivityStore } from "./activities";
import type { ArticleStore } from "./articles";
import type { GenerationStore } from "./generations";
import { audioPath, sourcePath, taskDir } from "./paths";
import type { JobStore } from "./jobs";
import type { QaStore } from "./qa";
import type { ReviewStore } from "./reviews";
import type { TaskStore } from "./tasks";

export interface MaintenanceDeps {
  store: TaskStore;
  generations: GenerationStore;
  dataDir: string;
  articles?: ArticleStore;
  activities?: ActivityStore;
  qa?: QaStore;
  jobs?: JobStore;
  reviews?: ReviewStore;
}

const DAY_MS = 86_400_000;
const ORPHAN_ERROR = "服务重启导致任务中断，请重新上传";

/**
 * 到期媒体清理：删除源视频与抽取音频，保留转录稿与文案（文字资产永久保留），
 * 并标记 mediaPurgedAt。幂等，返回本次清理的任务数。
 */
export async function purgeExpiredMedia(
  deps: MaintenanceDeps,
  opts: { retentionDays: number; now?: Date },
): Promise<number> {
  const now = opts.now ?? new Date();
  const cutoff = now.getTime() - opts.retentionDays * DAY_MS;
  let count = 0;
  for (const task of deps.store.list()) {
    if (task.mediaPurgedAt) continue;
    if (new Date(task.createdAt).getTime() >= cutoff) continue;
    const dir = taskDir(deps.dataDir, task.id);
    // force: 文件可能从未落盘（上传失败的任务）
    await rm(sourcePath(dir, task.ext), { force: true });
    await rm(audioPath(dir), { force: true });
    // 帧与源媒体同生命周期；已发布文章引用的帧由文章导出副本承担，不在这里单独 pin
    await removeFrames(dir);
    deps.store.update(task.id, { mediaPurgedAt: now.toISOString() });
    count += 1;
  }
  return count;
}

/**
 * 启动孤儿扫描：串行队列是内存态，服务重启后 queued/extracting/transcribing
 * 的任务永远不会再被处理，统一标记为 failed 并给出可见原因。
 */
export function failOrphanTasks(store: TaskStore): number {
  let count = 0;
  for (const task of store.list()) {
    if (isProcessing(task.status)) {
      store.update(task.id, { status: "failed", error: ORPHAN_ERROR });
      count += 1;
    }
  }
  return count;
}

/** 删除任务：任务目录（含全部媒体与转录稿）+ 任务行 + 文案行。任务不存在返回 false。 */
export async function deleteTask(deps: MaintenanceDeps, id: string): Promise<boolean> {
  if (!deps.store.get(id)) return false;
  await rm(taskDir(deps.dataDir, id), { recursive: true, force: true });
  deps.store.remove(id);
  deps.generations.removeAllForTask(id);
  deps.articles?.removeAllForTask(id);
  // jobs 先于 activities 删（父概念在前，便于将来加外键；14 号票）
  deps.jobs?.removeAllForTask(id);
  deps.reviews?.removeAllForTask(id);
  deps.activities?.removeAllForTask(id);
  deps.qa?.removeAllForTask(id);
  return true;
}

export interface StorageStats {
  taskCount: number;
  purgedCount: number;
  mediaBytes: number;
  totalBytes: number;
}

function isMediaFile(name: string): boolean {
  return name === "audio.mp3" || name.startsWith("source.");
}

async function dirSize(root: string): Promise<number> {
  let total = 0;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      total += await dirSize(p);
    } else {
      total += (await stat(p).catch(() => null))?.size ?? 0;
    }
  }
  return total;
}

/** 存储统计：真实遍历 data 目录；媒体字节计 source.*、audio.mp3 与帧目录 */
export async function storageStats(deps: MaintenanceDeps): Promise<StorageStats> {
  const tasks = deps.store.list();
  const tasksRoot = path.join(deps.dataDir, "tasks");
  let mediaBytes = 0;
  for (const e of await readdir(tasksRoot, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory()) continue;
    const dir = path.join(tasksRoot, e.name);
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) {
        if (entry.name === "frames") mediaBytes += await dirSize(path.join(dir, entry.name));
      } else if (isMediaFile(entry.name)) {
        mediaBytes += (await stat(path.join(dir, entry.name)).catch(() => null))?.size ?? 0;
      }
    }
  }
  return {
    taskCount: tasks.length,
    purgedCount: tasks.filter((t) => t.mediaPurgedAt).length,
    mediaBytes,
    totalBytes: await dirSize(deps.dataDir),
  };
}
