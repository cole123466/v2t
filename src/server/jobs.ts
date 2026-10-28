import type { Db } from "./db";
import { row as one, rows as many } from "./sql";

/**
 * 后台任务（08 号票：decision-background-execution）的存储层。
 *
 * 14 号票先落地表结构与删除级联；08 号票在此之上补领取/状态机/恢复。
 * status 词汇表：queued | running | succeeded | failed | canceled | interrupted。
 */
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "canceled" | "interrupted";

export interface JobRecord {
  id: string;
  taskId: string;
  kind: string;
  status: JobStatus;
  phase: string | null;
  attemptNo: number;
  failureCount: number;
  outlineJson: string | null;
  doneSections: number;
  totalSections: number;
  articleId: string | null;
  retryOfJobId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

interface JobRow {
  id: string;
  task_id: string;
  kind: string;
  status: string;
  phase: string | null;
  attempt_no: number;
  failure_count: number;
  outline_json: string | null;
  done_sections: number;
  total_sections: number;
  article_id: string | null;
  retry_of_job_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

function toRecord(row: JobRow): JobRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    kind: row.kind,
    status: row.status as JobStatus,
    phase: row.phase,
    attemptNo: row.attempt_no,
    failureCount: row.failure_count,
    outlineJson: row.outline_json,
    doneSections: row.done_sections,
    totalSections: row.total_sections,
    articleId: row.article_id,
    retryOfJobId: row.retry_of_job_id,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class JobStore {
  constructor(private readonly db: Db) {}

  get(id: string): JobRecord | undefined {
    const row = one<JobRow>(this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id));
    return row ? toRecord(row) : undefined;
  }

  listForTask(taskId: string): JobRecord[] {
    const rows = many<JobRow>(
      this.db.prepare("SELECT * FROM jobs WHERE task_id = ? ORDER BY created_at DESC").all(taskId),
    );
    return rows.map(toRecord);
  }

  removeAllForTask(taskId: string): void {
    this.db.prepare("DELETE FROM jobs WHERE task_id = ?").run(taskId);
  }
}
