import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildCatalog, type ArticleSection } from "./article";
import type { ArticleService, ArticleStore } from "./articles";
import type { Transcript } from "./asr";
import { readFrameManifest } from "./frames";
import type { JobRecord, JobStore, WorkerEvent } from "./jobs";
import { errorFields, logError, logInfo } from "./log";
import { taskDir, transcriptPath } from "./paths";

export interface ArticleJobDeps {
  jobs: JobStore;
  articles: ArticleStore;
  articleService: ArticleService;
  dataDir: string;
}

/**
 * 08 号票：worker 领取 job 后的执行体。
 * 生成完全脱离 HTTP 请求生命周期；AbortSignal 只来自 worker.stop()/cancel()。
 */
export async function runArticleJob(
  deps: ArticleJobDeps,
  job: JobRecord,
  signal: AbortSignal,
  emit: (event: WorkerEvent["event"], data: unknown) => void,
): Promise<void> {
  const taskId = job.taskId;
  const articleId = job.articleId;
  if (!articleId) {
    deps.jobs.update(job.id, { status: "failed", error: "job 缺少 article_id" });
    return;
  }

  const dir = taskDir(deps.dataDir, taskId);
  let transcript: Transcript;
  try {
    transcript = JSON.parse(await readFile(transcriptPath(dir), "utf8")) as Transcript;
  } catch {
    deps.jobs.update(job.id, { status: "failed", error: "转录稿缺失" });
    deps.articles.update(articleId, { status: "failed", error: "转录稿缺失" });
    emit("error", { message: "转录稿缺失" });
    return;
  }
  const manifest = await readFrameManifest(dir);
  const catalog = buildCatalog(transcript, manifest);
  const frameFiles = new Map((manifest?.frames ?? []).map((f) => [f.id, path.join(dir, f.file)]));

  // resume：旧 job 的提纲 + 已存章节（只补缺失，不重生成、不重校验已存章节）
  let resume: { outline: import("./article").ArticleDraftOutline; existingSections: ArticleSection[] } | undefined;
  if (job.attemptNo > 1 || job.retryOfJobId) {
    const article = deps.articles.get(articleId);
    if (article?.outline) {
      resume = {
        outline: article.outline,
        existingSections: article.content?.sections ?? [],
      };
    }
  }

  let done = 0;
  let total = 0;
  try {
    await deps.articleService.runForJob({
      taskId,
      articleId,
      runId: job.id,
      catalog,
      frameFiles,
      resume,
      signal,
      onDelta: (delta) => emit("delta", { delta }),
      onProgress: (e) => emit("step", { stage: e.stage, message: e.message ?? null }),
      hooks: {
        onOutline: (outline) => {
          total = outline.sections.length;
          deps.jobs.update(job.id, {
            outlineJson: JSON.stringify(outline),
            totalSections: total,
            phase: "write",
          });
        },
        onSectionDone: (d, t) => {
          done = d;
          total = t;
          deps.jobs.update(job.id, { doneSections: d, totalSections: t });
          emit("step", { kind: "section", done: d, total: t });
        },
        onPhase: (phase) => {
          deps.jobs.update(job.id, { phase });
          emit("step", { phase });
        },
        onSectionVerified: (index, message) => {
          emit("step", { kind: "verify", index, message });
        },
      },
    });
    deps.jobs.update(job.id, {
      status: "succeeded",
      phase: "publish",
      doneSections: total,
      totalSections: total,
      error: null,
    });
    logInfo("article job succeeded", { job_id: job.id, article_id: articleId, sections: total });
    emit("done", { articleId, sections: total });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const current = deps.jobs.get(job.id);
    if (current?.status === "canceled") {
      // 用户取消：状态已置好，只发事件
      emit("error", { message: "生成已取消", canceled: true });
      return;
    }
    const aborted = signal.aborted; // worker.stop()（进程退出/HMR 重建）
    deps.jobs.update(job.id, {
      status: aborted ? "interrupted" : "failed",
      error: aborted ? `服务重启导致中断，已保存 ${done}/${total} 章` : message,
      doneSections: done,
      totalSections: total,
      failureCount: (current?.failureCount ?? 0) + (aborted ? 0 : 1),
    });
    if (!aborted) {
      logError("article job failed", { job_id: job.id, article_id: articleId, ...errorFields(err) });
    }
    emit("error", { message: aborted ? "服务重启导致中断" : message });
  }
}
