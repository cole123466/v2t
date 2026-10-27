import { randomUUID } from "node:crypto";
import type { Db } from "./db";
import { bind, row as one, rows as many } from "./sql";

/**
 * 过程可视化：一次执行（run）里的可展示步骤。
 *
 * 术语（对齐 decision-progress-model）：
 * - 执行（run）：一次「生成图文 / 提问」产生的运行，run_id 标识；
 *   08 号票落地后统一为 job_id，本模块字段名先行按 run 暴露。
 * - 步骤（step）：执行里的可展示单元，即本表一行。
 * - 阶段（phase）：outline → write → validate → publish；问答为 qa。
 */
export type StepStatus = "queued" | "running" | "completed" | "failed" | "canceled";
/**
 * 阶段取值：outline → write → validate → publish 为文章 run；qa 为问答；
 * download → subtitles → asr → frames 为来源管线（runner 写入，kind='source'，
 * 无 run_id——见 decision-input-ops I2）。
 */
export type StepPhase =
  | "outline"
  | "write"
  | "validate"
  | "publish"
  | "qa"
  | "download"
  | "subtitles"
  | "asr"
  | "frames";

export interface Activity {
  id: string;
  taskId: string;
  kind: "model" | "stage" | "section" | "qa" | "source" | "verify" | "review";
  stage: string | null;
  message: string | null;
  startedAt: string;
  endedAt: string | null;
  ok: boolean | null;
  // ---- 07 号票新增字段 ----
  runId: string | null;
  seq: number;
  phase: StepPhase | null;
  title: string | null;
  status: StepStatus | null;
  parentId: string | null;
  attemptNo: number;
  articleId: string | null;
  usageJson: string | null;
}

interface ActivityRow {
  id: string;
  task_id: string;
  kind: string;
  stage: string | null;
  message: string | null;
  started_at: string;
  ended_at: string | null;
  ok: number | null;
  run_id: string | null;
  seq: number;
  phase: string | null;
  title: string | null;
  status: string | null;
  parent_id: string | null;
  attempt_no: number;
  article_id: string | null;
  usage_json: string | null;
}

/** 老行（status 为 NULL）按 ended_at / ok 推导，不回填数据 */
function deriveLegacyStatus(row: ActivityRow): StepStatus {
  if (row.ended_at === null) return "running";
  return row.ok === 1 ? "completed" : "failed";
}

function toActivity(row: ActivityRow): Activity {
  return {
    id: row.id,
    taskId: row.task_id,
    kind: row.kind as Activity["kind"],
    stage: row.stage,
    message: row.message,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    ok: row.ok === null ? null : row.ok === 1,
    runId: row.run_id,
    seq: row.seq ?? 0,
    phase: (row.phase as StepPhase | null) ?? null,
    title: row.title,
    status: (row.status as StepStatus | null) ?? deriveLegacyStatus(row),
    parentId: row.parent_id,
    attemptNo: row.attempt_no ?? 1,
    articleId: row.article_id,
    usageJson: row.usage_json,
  };
}

export interface StepInput {
  taskId: string;
  kind: Activity["kind"];
  /** 旧版阶段标签（article/qa），仅用于兼容旧 UI 展示 */
  stage?: string | null;
  runId?: string | null;
  phase?: StepPhase | null;
  title?: string | null;
  status?: StepStatus;
  message?: string | null;
  attemptNo?: number;
  articleId?: string | null;
  /** queued 计划步骤与提纲同事务预插入：保持排序稳定的自定义开始时间 */
  startedAt?: string;
}

export interface CurrentRun {
  runId: string;
  articleId: string | null;
  phase: StepPhase | null;
  status: "running";
  /** 已完成章节数 / 预插入章节总数 */
  done: number;
  total: number;
  stepCount: number;
  hasQueued: boolean;
}

export class ActivityStore {
  constructor(private readonly db: Db) {}

  /** 新开一次执行 */
  newRunId(): string {
    return randomUUID();
  }

  private nextSeq(runId: string): number {
    const r = one<{ n: number }>(
      this.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM activities WHERE run_id = ?").get(runId),
    );
    return r?.n ?? 1;
  }

  start(input: StepInput): Activity {
    const runId = input.runId ?? null;
    const seq = runId ? this.nextSeq(runId) : 0;
    const activity: Activity = {
      id: randomUUID(),
      taskId: input.taskId,
      kind: input.kind,
      stage: input.stage ?? null,
      message: input.message ?? null,
      startedAt: input.startedAt ?? new Date().toISOString(),
      endedAt: null,
      ok: null,
      runId,
      seq,
      phase: input.phase ?? null,
      title: input.title ?? null,
      status: input.status ?? "running",
      parentId: null,
      attemptNo: input.attemptNo ?? 1,
      articleId: input.articleId ?? null,
      usageJson: null,
    };
    this.db
      .prepare(
        `INSERT INTO activities (id, task_id, kind, stage, message, started_at, ended_at, ok,
           run_id, seq, phase, title, status, parent_id, attempt_no, article_id, usage_json)
         VALUES (@id, @taskId, @kind, @stage, @message, @startedAt, @endedAt, @ok,
           @runId, @seq, @phase, @title, @status, @parentId, @attemptNo, @articleId, @usageJson)`,
      )
      .run(
        bind({
          id: activity.id,
          taskId: activity.taskId,
          kind: activity.kind,
          stage: activity.stage,
          message: activity.message,
          startedAt: activity.startedAt,
          endedAt: null,
          ok: null,
          runId: activity.runId,
          seq: activity.seq,
          phase: activity.phase,
          title: activity.title,
          status: activity.status,
          parentId: null,
          attemptNo: activity.attemptNo,
          articleId: activity.articleId,
          usageJson: null,
        }),
      );
    return activity;
  }

  /**
   * 结束一步。兼容旧语义：ok 同步写 ended_at/ok，让未改造的旧 UI 仍可读。
   */
  finish(
    id: string,
    patch: {
      ok: boolean | null;
      status?: StepStatus;
      message?: string | null;
      usageJson?: string | null;
    },
  ): void {
    const status = patch.status ?? (patch.ok === null ? "completed" : patch.ok ? "completed" : "failed");
    const sets = ["ended_at = @endedAt", "ok = @ok", "status = @status"];
    const params: Record<string, string | number | null> = {
      id,
      endedAt: new Date().toISOString(),
      ok: patch.ok === null ? null : patch.ok ? 1 : 0,
      status,
    };
    if (patch.message !== undefined) {
      sets.push("message = COALESCE(@message, message)");
      params.message = patch.message ?? null;
    }
    if (patch.usageJson !== undefined) {
      sets.push("usage_json = @usageJson");
      params.usageJson = patch.usageJson ?? null;
    }
    this.db.prepare(`UPDATE activities SET ${sets.join(", ")} WHERE id = @id`).run(bind(params));
  }

  /** 步骤状态流转（queued → running → 终态），终态同时补 ended_at/ok */
  updateStatus(id: string, status: StepStatus, message?: string | null): void {
    const now = new Date().toISOString();
    const terminal = status === "completed" || status === "failed" || status === "canceled";
    this.db
      .prepare(
        `UPDATE activities SET status = @status,
           message = COALESCE(@message, message),
           ended_at = CASE WHEN @terminal = 1 THEN COALESCE(ended_at, @endedAt) ELSE ended_at END,
           ok = CASE WHEN @terminal = 1 THEN (CASE WHEN @status = 'completed' THEN 1 WHEN @status IN ('failed','canceled') THEN 0 ELSE ok END) ELSE ok END
         WHERE id = @id`,
      )
      .run(bind({ id, status, message: message ?? null, endedAt: now, terminal: terminal ? 1 : 0 }));
  }

  get(id: string): Activity | undefined {
    const r = one<ActivityRow>(this.db.prepare("SELECT * FROM activities WHERE id = ?").get(id));
    return r ? toActivity(r) : undefined;
  }

  listForTask(taskId: string): Activity[] {
    const rs = many<ActivityRow>(
      this.db
        .prepare("SELECT * FROM activities WHERE task_id = ? ORDER BY started_at ASC, rowid ASC")
        .all(taskId),
    );
    return rs.map(toActivity);
  }

  /** 派生当前执行视图：无进行中的 run 时为 null */
  currentRunForTask(taskId: string): CurrentRun | null {
    const run = one<{ run_id: string; article_id: string | null }>(
      this.db
        .prepare(
          `SELECT run_id, MAX(article_id) AS article_id FROM activities
           WHERE task_id = ? AND run_id IS NOT NULL AND status = 'running'
           GROUP BY run_id ORDER BY MAX(seq) DESC LIMIT 1`,
        )
        .get(taskId),
    );
    if (!run) return null;
    const steps = many<ActivityRow>(
      this.db
        .prepare("SELECT * FROM activities WHERE task_id = ? AND run_id = ? ORDER BY seq ASC, rowid ASC")
        .all(taskId, run.run_id),
    )
      .map(toActivity)
      .filter((a) => a.kind !== "model");
    const sections = steps.filter((s) => s.kind === "section");
    const done = sections.filter((s) => s.status === "completed").length;
    const total = sections.length;
    const running = steps.find((s) => s.status === "running");
    const last = steps[steps.length - 1];
    return {
      runId: run.run_id,
      articleId: run.article_id,
      phase: running?.phase ?? last?.phase ?? null,
      status: "running",
      done,
      total,
      stepCount: steps.length,
      hasQueued: steps.some((s) => s.status === "queued"),
    };
  }

  /** run 内仍处 running 的步骤 id（失败/中断回写用） */
  runningIdsForRun(runId: string): string[] {
    const rs = many<{ id: string }>(
      this.db.prepare("SELECT id FROM activities WHERE run_id = ? AND status = 'running'").all(runId),
    );
    return rs.map((r) => r.id);
  }

  removeAllForTask(taskId: string): void {
    this.db.prepare("DELETE FROM activities WHERE task_id = ?").run(taskId);
  }
}
