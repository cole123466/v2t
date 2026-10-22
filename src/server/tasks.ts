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
}

export interface NewTask {
  originalName: string;
  ext: string;
  sizeBytes: number;
  sourceKind?: SourceKind;
  sourceUrl?: string | null;
  sourceTitle?: string | null;
  sourceThumbnail?: string | null;
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
    };
    this.db
      .prepare(
        `INSERT INTO tasks (id, original_name, ext, size_bytes, duration_sec, status, progress, error,
                            created_at, media_purged_at, source_kind, source_url, source_title,
                            source_thumbnail, transcript_origin, download_pct)
         VALUES (@id, @originalName, @ext, @sizeBytes, @durationSec, @status, @progress, @error,
                 @createdAt, @mediaPurgedAt, @sourceKind, @sourceUrl, @sourceTitle,
                 @sourceThumbnail, @transcriptOrigin, @downloadPct)`,
      )
      .run(bind(task));
    return task;
  }

  get(id: string): Task | undefined {
    const row = one<TaskRow>(this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id));
    return row ? toTask(row) : undefined;
  }

  list(): Task[] {
    // rowid 兜底同毫秒创建的平局，保证插入序即展示序
    const rows = many<TaskRow>(
      this.db.prepare("SELECT * FROM tasks ORDER BY created_at DESC, rowid DESC").all(),
    );
    return rows.map(toTask);
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
