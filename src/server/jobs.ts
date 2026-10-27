import { randomUUID } from "node:crypto";
import type { Db } from "./db";
import { row as one, rows as many } from "./sql";
import { logError, logInfo, logWarn } from "./log";

/**
 * 后台任务（08 号票：decision-background-execution）的存储层与执行器。
 *
 * 状态机：
 *   queued ──claim──▶ running ──ok──▶ succeeded
 *                        │
 *                        ├── user cancel ──▶ canceled
 *                        └── 进程退出/崩溃 ──▶ interrupted ──user resume──▶ 新 job(queued)
 *
 * 没有 retry_wait（不自动重试）；interrupted 是终态，恢复只能由用户发起。
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

export interface CreateJobInput {
  taskId: string;
  kind: string;
  articleId: string;
  attemptNo?: number;
  retryOfJobId?: string | null;
  outlineJson?: string | null;
  totalSections?: number;
  doneSections?: number;
}

export class JobStore {
  constructor(private readonly db: Db) {}

  create(input: CreateJobInput): JobRecord {
    const now = new Date().toISOString();
    const record: JobRecord = {
      id: randomUUID(),
      taskId: input.taskId,
      kind: input.kind,
      status: "queued",
      phase: null,
      attemptNo: input.attemptNo ?? 1,
      failureCount: 0,
      outlineJson: input.outlineJson ?? null,
      doneSections: input.doneSections ?? 0,
      totalSections: input.totalSections ?? 0,
      articleId: input.articleId,
      retryOfJobId: input.retryOfJobId ?? null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO jobs (id, task_id, kind, status, phase, attempt_no, failure_count,
           outline_json, done_sections, total_sections, article_id, retry_of_job_id, error, created_at, updated_at)
         VALUES (@id, @taskId, @kind, @status, @phase, @attemptNo, @failureCount,
           @outlineJson, @doneSections, @totalSections, @articleId, @retryOfJobId, @error, @createdAt, @updatedAt)`,
      )
      .run({ ...record, phase: null, error: null } as unknown as Record<string, never>);
    return record;
  }

  get(id: string): JobRecord | undefined {
    const row = one<JobRow>(this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id));
    return row ? toRecord(row) : undefined;
  }

  /** 按文章找未终态 job（并发保护与事件路由用） */
  activeForArticle(articleId: string): JobRecord | undefined {
    const row = one<JobRow>(
      this.db
        .prepare("SELECT * FROM jobs WHERE article_id = ? AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1")
        .get(articleId),
    );
    return row ? toRecord(row) : undefined;
  }

  activeForTask(taskId: string): JobRecord | undefined {
    const row = one<JobRow>(
      this.db
        .prepare("SELECT * FROM jobs WHERE task_id = ? AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1")
        .get(taskId),
    );
    return row ? toRecord(row) : undefined;
  }

  latestForArticle(articleId: string): JobRecord | undefined {
    const row = one<JobRow>(
      this.db.prepare("SELECT * FROM jobs WHERE article_id = ? ORDER BY created_at DESC LIMIT 1").get(articleId),
    );
    return row ? toRecord(row) : undefined;
  }

  listForTask(taskId: string): JobRecord[] {
    const rows = many<JobRow>(
      this.db.prepare("SELECT * FROM jobs WHERE task_id = ? ORDER BY created_at DESC").all(taskId),
    );
    return rows.map(toRecord);
  }

  /**
   * 领取最早排队的 job。条件更新（UPDATE ... WHERE status='queued'）天然幂等，
   * 将来提并发/多进程时无需改写。
   */
  claimNext(): JobRecord | undefined {
    let claimed: JobRecord | undefined;
    this.db.exec("BEGIN");
    try {
      const row = one<JobRow>(
        this.db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC, rowid ASC LIMIT 1").get(),
      );
      if (row) {
        const updated = this.db
          .prepare("UPDATE jobs SET status = 'running', updated_at = @now WHERE id = @id AND status = 'queued'")
          .run({ id: row.id, now: new Date().toISOString() });
        if (updated.changes > 0) claimed = toRecord({ ...row, status: "running" });
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return claimed;
  }

  update(
    id: string,
    patch: Partial<{
      status: JobStatus;
      phase: string | null;
      outlineJson: string | null;
      doneSections: number;
      totalSections: number;
      error: string | null;
      failureCount: number;
    }>,
  ): void {
    const sets: string[] = ["updated_at = @updatedAt"];
    const params: Record<string, string | number | null> = { id, updatedAt: new Date().toISOString() };
    if ("status" in patch) {
      sets.push("status = @status");
      params.status = patch.status ?? null;
    }
    if ("phase" in patch) {
      sets.push("phase = @phase");
      params.phase = patch.phase ?? null;
    }
    if ("outlineJson" in patch) {
      sets.push("outline_json = @outlineJson");
      params.outlineJson = patch.outlineJson ?? null;
    }
    if ("doneSections" in patch) {
      sets.push("done_sections = @doneSections");
      params.doneSections = patch.doneSections ?? 0;
    }
    if ("totalSections" in patch) {
      sets.push("total_sections = @totalSections");
      params.totalSections = patch.totalSections ?? 0;
    }
    if ("error" in patch) {
      sets.push("error = @error");
      params.error = patch.error ?? null;
    }
    if ("failureCount" in patch) {
      sets.push("failure_count = @failureCount");
      params.failureCount = patch.failureCount ?? 0;
    }
    this.db.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = @id`).run(params);
  }

  removeAllForTask(taskId: string): void {
    this.db.prepare("DELETE FROM jobs WHERE task_id = ?").run(taskId);
  }

  /**
   * 启动 reap（08 号票）：残留 running 折为 interrupted。
   * 与 failOrphanTasks 分工：这里只碰 jobs/articles/activities，绝不碰 tasks 转写管线。
   */
  reap(): number {
    const running = many<JobRow>(this.db.prepare("SELECT * FROM jobs WHERE status = 'running'").all());
    if (running.length === 0) return 0;
    const now = new Date().toISOString();
    for (const row of running) {
      const job = toRecord(row);
      const done = this.db
        .prepare("SELECT COUNT(*) AS n FROM activities WHERE run_id = ? AND kind = 'section' AND status = 'completed'")
        .get(job.id) as { n: number };
      const total = this.db
        .prepare("SELECT COUNT(*) AS n FROM activities WHERE run_id = ? AND kind = 'section'")
        .get(job.id) as { n: number };
      this.db
        .prepare(
          "UPDATE jobs SET status = 'interrupted', error = @error, done_sections = @done, updated_at = @now WHERE id = @id",
        )
        .run({
          id: job.id,
          error: `服务重启导致中断，已保存 ${done.n}/${total.n} 章`,
          done: done.n,
          now,
        });
      // 该 job 下 running 步骤置 canceled；queued 计划步骤保留（续跑时重建）
      this.db
        .prepare(
          "UPDATE activities SET status = 'canceled', message = '服务中断', ended_at = @now, ok = 0 WHERE run_id = @runId AND status = 'running'",
        )
        .run({ runId: job.id, now });
      if (job.articleId) {
        this.db
          .prepare(
            "UPDATE articles SET status = 'interrupted', error = COALESCE(error, @error) WHERE id = @articleId AND status = 'streaming'",
          )
          .run({ articleId: job.articleId, error: `服务重启导致中断，已保存 ${done.n}/${total.n} 章` });
      }
    }
    logWarn("jobs reaped on startup", { count: running.length });
    return running.length;
  }
}

// ---------------------------------------------------------------------------
// Worker：单例轮询 + 唤醒（B1）；生成脱离 HTTP 请求生命周期
// ---------------------------------------------------------------------------

export interface WorkerEvent {
  event: "snapshot" | "step" | "delta" | "done" | "error";
  data: unknown;
}

export interface JobWorkerDeps {
  jobs: JobStore;
  /** 执行一个 job；由 runtime 注入，避免循环依赖 */
  run: (job: JobRecord, signal: AbortSignal, emit: (event: WorkerEvent["event"], data: unknown) => void) => Promise<void>;
  pollMs?: number;
}

export class JobWorker {
  private stopped = true;
  private loopPromise: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private current: { jobId: string; controller: AbortController } | null = null;
  private subscribers = new Map<string, Set<(e: WorkerEvent) => void>>();

  constructor(private readonly deps: JobWorkerDeps) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const reaped = this.deps.jobs.reap();
    if (reaped > 0) logInfo("worker startup reap completed", { reaped });
    this.loopPromise = this.loop();
  }

  /** 置内存标志并 abort 当前 job；不等待——残留由下次启动 reap 兜底 */
  stop(): void {
    this.stopped = true;
    this.current?.controller.abort();
    this.wake?.();
  }

  /** 有新任务入队时唤醒轮询 */
  notify(): void {
    this.wake?.();
  }

  subscribe(articleId: string, fn: (e: WorkerEvent) => void): () => void {
    let set = this.subscribers.get(articleId);
    if (!set) {
      set = new Set();
      this.subscribers.set(articleId, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.subscribers.delete(articleId);
    };
  }

  private emit(articleId: string, event: WorkerEvent["event"], data: unknown): void {
    const set = this.subscribers.get(articleId);
    if (!set) return;
    for (const fn of set) {
      try {
        fn({ event, data });
      } catch {
        // 订阅者错误不影响任务
      }
    }
  }

  private async loop(): Promise<void> {
    const pollMs = this.deps.pollMs ?? 1000;
    while (!this.stopped) {
      const job = this.deps.jobs.claimNext();
      if (!job) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            this.wake = null;
            resolve();
          }, pollMs);
          this.wake = () => {
            clearTimeout(timer);
            this.wake = null;
            resolve();
          };
        });
        continue;
      }
      const controller = new AbortController();
      this.current = { jobId: job.id, controller };
      const articleId = job.articleId ?? "";
      try {
        await this.deps.run(job, controller.signal, (event, data) => this.emit(articleId, event, data));
      } catch (err) {
        logError("job run crashed", { job_id: job.id, error: err instanceof Error ? err.message : String(err) });
      } finally {
        this.current = null;
      }
    }
  }

  /** 取消：置 canceled 并 abort 当前 LLM 调用；worker 在章节检查点停手 */
  cancel(jobId: string): boolean {
    const job = this.deps.jobs.get(jobId);
    if (!job || (job.status !== "queued" && job.status !== "running")) return false;
    this.deps.jobs.update(jobId, { status: "canceled", error: "用户取消生成" });
    if (this.current?.jobId === jobId) this.current.controller.abort();
    return true;
  }

  async join(): Promise<void> {
    await this.loopPromise;
  }
}
