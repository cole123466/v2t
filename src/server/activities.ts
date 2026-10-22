import { randomUUID } from "node:crypto";
import type { Db } from "./db";
import { bind, row as one, rows as many } from "./sql";

/** 过程可视化：一次模型调用或一个处理阶段的活动记录 */
export interface Activity {
  id: string;
  taskId: string;
  kind: "model" | "stage";
  stage: string | null;
  message: string | null;
  startedAt: string;
  endedAt: string | null;
  ok: boolean | null;
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
  };
}

export class ActivityStore {
  constructor(private readonly db: Db) {}

  start(input: {
    taskId: string;
    kind: Activity["kind"];
    stage?: string | null;
    message?: string | null;
  }): Activity {
    const activity: Activity = {
      id: randomUUID(),
      taskId: input.taskId,
      kind: input.kind,
      stage: input.stage ?? null,
      message: input.message ?? null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      ok: null,
    };
    this.db
      .prepare(
        `INSERT INTO activities (id, task_id, kind, stage, message, started_at, ended_at, ok)
         VALUES (@id, @taskId, @kind, @stage, @message, @startedAt, @endedAt, @ok)`,
      )
      .run(bind({ ...activity, ok: null }));
    return activity;
  }

  finish(id: string, patch: { ok: boolean; message?: string | null }): void {
    this.db
      .prepare("UPDATE activities SET ended_at = @endedAt, ok = @ok, message = COALESCE(@message, message) WHERE id = @id")
      .run(
        bind({
          id,
          endedAt: new Date().toISOString(),
          ok: patch.ok ? 1 : 0,
          message: patch.message ?? null,
        }),
      );
  }

  get(id: string): Activity | undefined {
    const row = one<ActivityRow>(this.db.prepare("SELECT * FROM activities WHERE id = ?").get(id));
    return row ? toActivity(row) : undefined;
  }

  listForTask(taskId: string): Activity[] {
    const rows = many<ActivityRow>(
      this.db
        .prepare("SELECT * FROM activities WHERE task_id = ? ORDER BY started_at ASC, rowid ASC")
        .all(taskId),
    );
    return rows.map(toActivity);
  }

  removeAllForTask(taskId: string): void {
    this.db.prepare("DELETE FROM activities WHERE task_id = ?").run(taskId);
  }
}
