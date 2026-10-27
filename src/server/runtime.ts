import { mkdirSync } from "node:fs";
import path from "node:path";
import { ActivityStore } from "./activities";
import { ArticleService, ArticleStore } from "./articles";
import { createSiliconFlowAsr } from "./asr";
import { getAsrChunkSeconds, getDataDir, getRetentionDays } from "./config";
import { openDb, type Db } from "./db";
import { GenerationService, GenerationStore } from "./generations";
import { createOpenAiCompatibleLlm } from "./llm";
import { failOrphanTasks, purgeExpiredMedia, type MaintenanceDeps } from "./maintenance";
import { QaService, QaStore } from "./qa";
import { TaskRunner } from "./runner";
import { createYtDlpProvider, type SourceProvider } from "./source";
import { TaskStore } from "./tasks";
import { errorFields, logError, logInfo, logWarn } from "./log";

export interface Runtime extends MaintenanceDeps {
  db: Db;
  store: TaskStore;
  runner: TaskRunner;
  generations: GenerationStore;
  generationService: GenerationService;
  articles: ArticleStore;
  articleService: ArticleService;
  activities: ActivityStore;
  qa: QaStore;
  qaService: QaService;
  dataDir: string;
  source: SourceProvider;
}

/**
 * Runtime 结构版本：增删公开成员（如给 TaskRunner 加方法）时必须 +1。
 * dev 模式下 HMR 只替换模块、不清 globalThis，旧实例会与旧类一起留在内存里；
 * 不做版本校验就会出现「代码已是新的、拿到的 runner 还是旧的」——
 * 例如调用 runner.isQueueFull() 抛 "is not a function"。
 */
export const RUNTIME_VERSION = 2;

interface CachedRuntime {
  version: number;
  runtime: Runtime;
}

// dev 模式下 HMR 会重建模块，用 globalThis 保住单例连接、队列与定时器
const globalForV2t = globalThis as {
  __v2tRuntime?: CachedRuntime;
  __v2tPurgeTimer?: ReturnType<typeof setInterval>;
};

const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function getRuntime(): Runtime {
  // 版本不符（HMR 后代码已更新）则重建，避免复用缺少新方法的旧实例
  const cached = globalForV2t.__v2tRuntime;
  if (cached && cached.version !== RUNTIME_VERSION) {
    logWarn("runtime version changed; rebuilding", {
      from: cached.version,
      to: RUNTIME_VERSION,
    });
    // 旧 SQLite 连接与定时器需要显式释放：新实例会重新打开同一 DB 文件
    // 先停定时器再关连接，避免 purge 回调访问已关闭的数据库
    if (globalForV2t.__v2tPurgeTimer) {
      clearInterval(globalForV2t.__v2tPurgeTimer);
      globalForV2t.__v2tPurgeTimer = undefined;
    }
    cached.runtime.db.close();
    globalForV2t.__v2tRuntime = undefined;
  }
  if (!globalForV2t.__v2tRuntime) {
    const dataDir = getDataDir();
    mkdirSync(path.join(dataDir, "tasks"), { recursive: true });
    const db = openDb(path.join(dataDir, "v2t.db"));
    const store = new TaskStore(db);
    const source = createYtDlpProvider();
    const runner = new TaskRunner({
      store,
      dataDir,
      asr: createSiliconFlowAsr(),
      source,
      chunkSeconds: getAsrChunkSeconds(),
    });
    const generations = new GenerationStore(db);
    const llm = createOpenAiCompatibleLlm();
    const generationService = new GenerationService({ store: generations, llm });
    const articles = new ArticleStore(db);
    const activities = new ActivityStore(db);
    const articleService = new ArticleService({
      store: articles,
      llm,
      activities,
      readFrame: async (file) => {
        const { readFile } = await import("node:fs/promises");
        const bytes = await readFile(file).catch(() => null);
        if (!bytes) return null;
        return `data:image/jpeg;base64,${bytes.toString("base64")}`;
      },
    });
    const qa = new QaStore(db);
    const qaService = new QaService({ store: qa, llm });
    const runtime: Runtime = {
      db,
      store,
      runner,
      generations,
      generationService,
      articles,
      articleService,
      activities,
      qa,
      qaService,
      dataDir,
      source,
    };
    globalForV2t.__v2tRuntime = { version: RUNTIME_VERSION, runtime };

    logInfo("runtime initialised", {
      data_dir: dataDir,
      retention_days: getRetentionDays(),
      node: process.version,
    });

    // 启动收口：孤儿任务标记失败（串行队列是内存态，重启即丢失）
    const orphans = failOrphanTasks(store);
    if (orphans > 0) logWarn("orphan tasks marked failed", { count: orphans });

    // 媒体保留期清理：启动时一次 + 每日一次（转录与文案永久保留）
    const deps: MaintenanceDeps = { store, generations, articles, activities, qa, dataDir };
    const runPurge = () =>
      purgeExpiredMedia(deps, { retentionDays: getRetentionDays() })
        .then((count) => {
          logInfo("media purge completed", {
            removed: count,
            retention_days: getRetentionDays(),
          });
        })
        .catch((err) => {
          logError("media purge failed", errorFields(err));
        });
    void runPurge();
    if (!globalForV2t.__v2tPurgeTimer) {
      globalForV2t.__v2tPurgeTimer = setInterval(() => void runPurge(), PURGE_INTERVAL_MS);
      globalForV2t.__v2tPurgeTimer.unref?.();
    }
  }
  return globalForV2t.__v2tRuntime.runtime;
}
