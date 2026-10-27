import { DatabaseSync } from "node:sqlite";

// Node 内置 SQLite（node:sqlite，Node 22+）：零原生编译，免 MSVC/Python 工具链——
// 这是"新机器从零搭建"能一次跑通的前提。API 与 better-sqlite3 基本一致。
export type Db = DatabaseSync;

/**
 * 增量迁移：每条都会被重复执行，因此必须幂等。
 * 新增列用 ADD COLUMN + 容错（老库已升级后重复执行会抛 "duplicate column"）。
 */
const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS tasks (
     id TEXT PRIMARY KEY,
     original_name TEXT NOT NULL,
     ext TEXT NOT NULL,
     size_bytes INTEGER NOT NULL,
     duration_sec REAL,
     status TEXT NOT NULL DEFAULT 'queued',
     progress INTEGER NOT NULL DEFAULT 0,
     error TEXT,
     created_at TEXT NOT NULL,
     media_purged_at TEXT
   );`,
  `CREATE TABLE IF NOT EXISTS generations (
     id TEXT PRIMARY KEY,
     task_id TEXT NOT NULL,
     mode TEXT NOT NULL,
     template_id TEXT,
     prompt TEXT,
     output TEXT NOT NULL DEFAULT '',
     model TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'streaming',
     error TEXT,
     created_at TEXT NOT NULL
   );`,
];

/** 追加表（幂等） */
const TABLES = [
  `CREATE TABLE IF NOT EXISTS articles (
     id TEXT PRIMARY KEY,
     task_id TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'streaming',
     title TEXT,
     content TEXT,
     outline TEXT,
     detail_level TEXT NOT NULL DEFAULT 'standard',
     purpose TEXT,
     model TEXT NOT NULL,
     error TEXT,
     created_at TEXT NOT NULL
   );`,
  `CREATE TABLE IF NOT EXISTS activities (
     id TEXT PRIMARY KEY,
     task_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     stage TEXT,
     message TEXT,
     started_at TEXT NOT NULL,
     ended_at TEXT,
     ok INTEGER
   );`,
  `CREATE TABLE IF NOT EXISTS qa_messages (
     id TEXT PRIMARY KEY,
     task_id TEXT NOT NULL,
     role TEXT NOT NULL,
     content TEXT NOT NULL,
     citations TEXT,
     limitations TEXT,
     created_at TEXT NOT NULL
   );`,
  // 14 号票（decision-data-migration）：一次性数据改判标记表
  `CREATE TABLE IF NOT EXISTS data_fixes (
     key TEXT PRIMARY KEY,
     applied_at TEXT NOT NULL
   );`,
  // 08 号票（decision-background-execution）的 jobs 表：14 号票的启动序列要求
  // DDL 先于 worker 存在，故在此建表；worker 逻辑在 08 号票落地
  `CREATE TABLE IF NOT EXISTS jobs (
     id TEXT PRIMARY KEY,
     task_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     status TEXT NOT NULL,
     phase TEXT,
     attempt_no INTEGER NOT NULL DEFAULT 1,
     failure_count INTEGER NOT NULL DEFAULT 0,
     outline_json TEXT,
     done_sections INTEGER NOT NULL DEFAULT 0,
     total_sections INTEGER NOT NULL DEFAULT 0,
     article_id TEXT,
     retry_of_job_id TEXT,
     error TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );`,
  // 10 号票（decision-review-quality）：手动审稿，每次审核一行，历史全留。
  // trigger 列不做——R1 定死只手动触发，无自动/手动之分，也不需要幂等索引
  `CREATE TABLE IF NOT EXISTS article_reviews (
     id TEXT PRIMARY KEY,
     task_id TEXT NOT NULL,
     article_id TEXT NOT NULL,
     job_id TEXT NOT NULL,
     status TEXT NOT NULL,
     model TEXT,
     summary TEXT,
     findings TEXT,
     error TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );`,
];

/** 追加列（幂等：重复执行时忽略 duplicate column 错误） */
const COLUMNS: Array<{ table: string; column: string; ddl: string }> = [
  { table: "tasks", column: "source_kind", ddl: "TEXT NOT NULL DEFAULT 'upload'" },
  { table: "tasks", column: "source_url", ddl: "TEXT" },
  { table: "tasks", column: "source_title", ddl: "TEXT" },
  { table: "tasks", column: "source_thumbnail", ddl: "TEXT" },
  { table: "tasks", column: "transcript_origin", ddl: "TEXT" },
  { table: "tasks", column: "download_pct", ddl: "INTEGER" },
  { table: "tasks", column: "source_notice", ddl: "TEXT" },
  // 设备归属：空串是加隔离之前的历史任务
  { table: "tasks", column: "owner", ddl: "TEXT NOT NULL DEFAULT ''" },
  // 07 号票（decision-progress-model）：步骤模型——run / seq / phase / title / status 等
  { table: "activities", column: "run_id", ddl: "TEXT" },
  { table: "activities", column: "seq", ddl: "INTEGER NOT NULL DEFAULT 0" },
  { table: "activities", column: "phase", ddl: "TEXT" },
  { table: "activities", column: "title", ddl: "TEXT" },
  { table: "activities", column: "status", ddl: "TEXT" },
  { table: "activities", column: "parent_id", ddl: "TEXT" },
  { table: "activities", column: "attempt_no", ddl: "INTEGER NOT NULL DEFAULT 1" },
  { table: "activities", column: "article_id", ddl: "TEXT" },
  { table: "activities", column: "usage_json", ddl: "TEXT" },
];

/** 追加索引（幂等） */
const INDEXES = [
  "CREATE INDEX IF NOT EXISTS activities_run ON activities(run_id, seq)",
  "CREATE INDEX IF NOT EXISTS activities_task_run ON activities(task_id, run_id)",
  "CREATE INDEX IF NOT EXISTS jobs_pick ON jobs(status, created_at)",
  "CREATE INDEX IF NOT EXISTS reviews_article ON article_reviews(article_id, created_at)",
];

export function openDb(file: string): Db {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  for (const sql of MIGRATIONS) db.exec(sql);
  for (const sql of TABLES) db.exec(sql);
  for (const { table, column, ddl } of COLUMNS) {
    const exists = db
      .prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`)
      .get(table, column);
    if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
  for (const sql of INDEXES) db.exec(sql);
  return db;
}

/**
 * 一次性数据改判（14 号票）：同一 key 只执行一次，重复启动跳过。
 * 与幂等 DDL 的分工：DDL 可重复执行；数据修复重复执行为害，用 data_fixes 单行标记。
 * 必须在 worker 启动之前调用，避免与任务领取产生矛盾状态。
 */
export function applyOnce(db: Db, key: string, fn: () => void): boolean {
  const done = db.prepare("SELECT 1 FROM data_fixes WHERE key = ?").get(key);
  if (done) return false;
  db.exec("BEGIN");
  try {
    fn();
    db.prepare("INSERT INTO data_fixes (key, applied_at) VALUES (?, ?)").run(key, new Date().toISOString());
    db.exec("COMMIT");
    return true;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
