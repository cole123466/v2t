import { randomUUID } from "node:crypto";
import type { Db } from "./db";
import { bind, row as one, rows as many } from "./sql";

export type TaskStatus =
  | "queued"
  | "downloading"
  | "extracting"
  | "fetching-subtitles"
  | "transcribing"
  | "extracting-frames"
  | "ready"
  | "failed";

export type SourceKind = "upload" | "link";

/** 转写稿来源诊断 */
export type TranscriptOrigin = "subtitle" | "asr" | "mixed";

export interface Task {
  id: string;
  originalName: string;
  ext: string;
  sizeBytes: number;
  durationSec: number | null;
  status: TaskStatus;
  progress: number;
  error: string | null;
  createdAt: string;
  mediaPurgedAt: string | null;
  sourceKind: SourceKind;
  sourceUrl: string | null;
  sourceTitle: string | null;
  sourceThumbnail: string | null;
  /** 本次任务的转写来源（字幕 / ASR / 混合），未完成时为空 */
  transcriptOrigin: TranscriptOrigin | null;
  /** 链接任务的下载百分比，上传任务为空 */
  downloadPct: number | null;
  /** 来源降级提示（如 B 站风控后改用官方接口），无则为空 */
  sourceNotice: string | null;
  /** 设备归属（浏览器 cookie 派生）；空串表示加隔离之前的历史任务 */
  owner: string;
}

export interface NewTask {
  originalName: string;
  ext: string;
  sizeBytes: number;
  /** 设备归属；缺省为空（仅测试/内部调用会省略） */
  owner?: string;
  sourceKind?: SourceKind;
  sourceUrl?: string | null;
  sourceTitle?: string | null;
  sourceThumbnail?: string | null;
  sourceNotice?: string | null;
}

export type TaskPatch = Partial<
  Pick<
    Task,
    | "durationSec"
    | "status"
    | "progress"
    | "error"
    | "mediaPurgedAt"
    | "ext"
    | "sizeBytes"
    | "sourceTitle"
    | "sourceThumbnail"
    | "transcriptOrigin"
    | "downloadPct"
    | "sourceNotice"
  >
>;

interface TaskRow {
  id: string;
  original_name: string;
  ext: string;
  size_bytes: number;
  duration_sec: number | null;
  status: string;
  progress: number;
  error: string | null;
  created_at: string;
  media_purged_at: string | null;
  source_kind: string;
  source_url: string | null;
  source_title: string | null;
  source_thumbnail: string | null;
  transcript_origin: string | null;
  download_pct: number | null;
  source_notice: string | null;
  owner: string;
}

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    originalName: row.original_name,
    ext: row.ext,
    sizeBytes: row.size_bytes,
    durationSec: row.duration_sec,
    status: row.status as TaskStatus,
    progress: row.progress,
    error: row.error,
    createdAt: row.created_at,
    mediaPurgedAt: row.media_purged_at,
    sourceKind: (row.source_kind as SourceKind) ?? "upload",
    sourceUrl: row.source_url,
    sourceTitle: row.source_title,
    sourceThumbnail: row.source_thumbnail,
    transcriptOrigin: (row.transcript_origin as TranscriptOrigin | null) ?? null,
    downloadPct: row.download_pct,
    sourceNotice: row.source_notice,
    owner: row.owner ?? "",
  };
}

export class TaskStore {
  constructor(private readonly db: Db) {}

  create(input: NewTask): Task {
    const task: Task = {
      id: randomUUID(),
      originalName: input.originalName,
      ext: input.ext,
      sizeBytes: input.sizeBytes,
      durationSec: null,
      status: "queued",
      progress: 0,
      error: null,
      createdAt: new Date().toISOString(),
      mediaPurgedAt: null,
      sourceKind: input.sourceKind ?? "upload",
      sourceUrl: input.sourceUrl ?? null,
      sourceTitle: input.sourceTitle ?? null,
      sourceThumbnail: input.sourceThumbnail ?? null,
      transcriptOrigin: null,
      downloadPct: null,
      sourceNotice: input.sourceNotice ?? null,
      owner: input.owner ?? "",
    };
    this.db
      .prepare(
        `INSERT INTO tasks (id, original_name, ext, size_bytes, duration_sec, status, progress, error,
                            created_at, media_purged_at, source_kind, source_url, source_title,
                            source_thumbnail, transcript_origin, download_pct, source_notice, owner)
         VALUES (@id, @originalName, @ext, @sizeBytes, @durationSec, @status, @progress, @error,
                 @createdAt, @mediaPurgedAt, @sourceKind, @sourceUrl, @sourceTitle,
                 @sourceThumbnail, @transcriptOrigin, @downloadPct, @sourceNotice, @owner)`,
      )
      .run(bind(task));
    return task;
  }

  get(id: string): Task | undefined {
    const row = one<TaskRow>(this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id));
    return row ? toTask(row) : undefined;
  }

  /** 只按设备归属取任务：别人的任务一律当作不存在，不暴露存在性 */
  getOwned(id: string, owner: string): Task | undefined {
    const row = one<TaskRow>(
      this.db.prepare("SELECT * FROM tasks WHERE id = ? AND owner = ?").get(id, owner),
    );
    return row ? toTask(row) : undefined;
  }

  /** owner 缺省时返回全部（清理、统计等内部用途）；页面/接口一律传具体设备 */
  list(owner?: string): Task[] {
    // rowid 兜底同毫秒创建的平局，保证插入序即展示序
    const order = " ORDER BY created_at DESC, rowid DESC";
    const rows =
      owner === undefined
        ? many<TaskRow>(this.db.prepare("SELECT * FROM tasks" + order).all())
        : many<TaskRow>(this.db.prepare("SELECT * FROM tasks WHERE owner = ?" + order).all(owner));
    return rows.map(toTask);
  }

  /**
   * 把加隔离之前的历史任务（owner 为空）认领给某台设备，避免升级后老任务凭空消失。
   * 只有第一台访问的设备能认领成功，返回认领条数。
   */
  claimLegacy(owner: string): number {
    const result = this.db
      .prepare("UPDATE tasks SET owner = ? WHERE owner = ''")
      .run(owner);
    return Number(result.changes ?? 0);
  }

  remove(id: string): void {
    this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
  }

  update(id: string, patch: TaskPatch): void {
    const columns: Record<keyof TaskPatch, string> = {
      durationSec: "duration_sec",
      status: "status",
      progress: "progress",
      error: "error",
      mediaPurgedAt: "media_purged_at",
      ext: "ext",
      sizeBytes: "size_bytes",
      sourceTitle: "source_title",
      sourceThumbnail: "source_thumbnail",
      transcriptOrigin: "transcript_origin",
      downloadPct: "download_pct",
      sourceNotice: "source_notice",
    };
    const sets: string[] = [];
    const params: Record<string, string | number | null> = { id };
    for (const key of Object.keys(patch) as Array<keyof TaskPatch>) {
      sets.push(`${columns[key]} = @${key}`);
      params[key] = patch[key] ?? null;
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = @id`).run(bind(params));
  }
}
