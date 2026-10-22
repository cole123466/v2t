import { mkdirSync } from "node:fs";
import path from "node:path";
import { ActivityStore } from "./activities";
import { ArticleService, ArticleStore } from "./articles";
import { createSiliconFlowAsr } from "./asr";
import { getDataDir, getRetentionDays } from "./config";
import { openDb, type Db } from "./db";
import { GenerationService, GenerationStore } from "./generations";
import { createOpenAiCompatibleLlm } from "./llm";
import { failOrphanTasks, purgeExpiredMedia, type MaintenanceDeps } from "./maintenance";
import { QaService, QaStore } from "./qa";
import { TaskRunner } from "./runner";
import { createYtDlpProvider, type SourceProvider } from "./source";
import { TaskStore } from "./tasks";

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

// dev 模式下 HMR 会重建模块，用 globalThis 保住单例连接、队列与定时器
const globalForV2t = globalThis as {
  __v2tRuntime?: Runtime;
  __v2tPurgeTimer?: ReturnType<typeof setInterval>;
};

const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function getRuntime(): Runtime {
  if (!globalForV2t.__v2tRuntime) {
    const dataDir = getDataDir();
    mkdirSync(path.join(dataDir, "tasks"), { recursive: true });
    const db = openDb(path.join(dataDir, "v2t.db"));
    const store = new TaskStore(db);
    const source = createYtDlpProvider();
    const runner = new TaskRunner({ store, dataDir, asr: createSiliconFlowAsr(), source });
    const generations = new GenerationStore(db);
    const llm = createOpenAiCompatibleLlm();
    const generationService = new GenerationService({ store: generations, llm });
    const articles = new ArticleStore(db);
    const articleService = new ArticleService({
      store: articles,
      llm,
      readFrame: async (file) => {
        const { readFile } = await import("node:fs/promises");
        const bytes = await readFile(file).catch(() => null);
        if (!bytes) return null;
        return `data:image/jpeg;base64,${bytes.toString("base64")}`;
      },
    });
    const activities = new ActivityStore(db);
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
    globalForV2t.__v2tRuntime = runtime;

    // 启动收口：孤儿任务标记失败（串行队列是内存态，重启即丢失）
    failOrphanTasks(store);

    // 媒体保留期清理：启动时一次 + 每日一次（转录与文案永久保留）
    const deps: MaintenanceDeps = { store, generations, articles, activities, qa, dataDir };
    const runPurge = () =>
      purgeExpiredMedia(deps, { retentionDays: getRetentionDays() }).catch((err) =>
        console.error("[v2t] 媒体清理失败：", err),
      );
    void runPurge();
    if (!globalForV2t.__v2tPurgeTimer) {
      globalForV2t.__v2tPurgeTimer = setInterval(() => void runPurge(), PURGE_INTERVAL_MS);
      globalForV2t.__v2tPurgeTimer.unref?.();
    }
  }
  return globalForV2t.__v2tRuntime;
}
