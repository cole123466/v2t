import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { chunkAudio, extractAudio, probe, type AudioChunk } from "./ffmpeg";
import type { ASRProvider, Transcript, TranscriptSegment } from "./asr";
import {
  closeUncovered,
  extractSubtitleTrack,
  subtitleCoverage,
  type SubtitleCue,
} from "./subtitle";
import { audioPath, sourcePath, taskDir, transcriptPath } from "./paths";
import { extractOverviewFrames } from "./frames";
import type { SourceProvider } from "./source";
import type { Task, TaskPatch, TaskStore } from "./tasks";
import { elapsedMs, errorFields, logError, logInfo, logWarn } from "./log";

type Listener = (task: Task) => void;

export interface RunnerOptions {
  store: TaskStore;
  dataDir: string;
  asr: ASRProvider;
  /** 链接任务的下载器；上传任务不用 */
  source?: SourceProvider;
  /** 超过该秒数即分段转写；默认 10 分钟（见 DEFAULT_CHUNK_SECONDS） */
  chunkSeconds?: number;
  /** 全景帧张数，默认 12 */
  overviewFrames?: number;
  /** 同时等待处理的任务上限（不含正在处理的那个），默认 3 */
  queueLimit?: number;
}

/**
 * 默认 10 分钟一段。提供方的硬限制是 ≤1h / ≤50MB，但单次请求实际会被网关在
 * 120s 上下掐断：整段 43 分钟（15MB）曾停在 125s 报 fetch failed，而 11 分钟
 * （3.4MB）稳定 60-70s 返回。所以按「单请求能在超时窗口内跑完」来分段。
 */
const DEFAULT_CHUNK_SECONDS = 10 * 60;
const DEFAULT_OVERVIEW_FRAMES = 12;

/** 排队任务上限：串行管线同一时刻只处理 1 个，最多再排 3 个等待 */
export const DEFAULT_QUEUE_LIMIT = 3;
export const QUEUE_FULL_CODE = "QUEUE_FULL";

export function queueFullMessage(limit: number): string {
  return `队列已满：最多 ${limit} 个任务排队，请等待当前任务完成后再试`;
}

/** 排队已满时由 enqueue 抛出，路由层转成 429 + QUEUE_FULL */
export class QueueFullError extends Error {
  readonly code = QUEUE_FULL_CODE;

  constructor(readonly limit: number = DEFAULT_QUEUE_LIMIT) {
    super(queueFullMessage(limit));
    this.name = "QueueFullError";
  }
}

/** 队列快照：active 最多 1 个（串行），queued 按入队顺序 */
export interface QueueSnapshot {
  active: Task[];
  queued: Task[];
  queuedLimit: number;
}

/**
 * 进程内串行任务管线：enqueue 入队，drain 逐个处理。
 * 状态流转 queued → (downloading) → extracting → (fetching-subtitles) → transcribing
 *          → (extracting-frames) → ready / failed，
 * 每次流转向订阅者推送任务快照（SSE 的数据源）。
 */
export class TaskRunner {
  private readonly queue: string[] = [];
  /** 正在 process 的任务 id，用于队列快照区分「处理中」与「排队中」 */
  private activeId: string | null = null;
  private running = false;
  private readonly subs = new Map<string, Set<Listener>>();
  private readonly idleResolvers: Array<() => void> = [];

  constructor(private readonly opts: RunnerOptions) {}

  get queueLimit(): number {
    return this.opts.queueLimit ?? DEFAULT_QUEUE_LIMIT;
  }

  /**
   * 当前队列快照（只读）：active 是处理中的任务，queued 按入队顺序。
   * owner 缺省返回全部（内部用途）；接口层传设备 ID，别把别人的任务名漏出去。
   */
  getQueueSnapshot(owner?: string): QueueSnapshot {
    const pick = (id: string) =>
      owner === undefined ? this.opts.store.get(id) : this.opts.store.getOwned(id, owner);
    const active = this.activeId ? pick(this.activeId) : undefined;
    const queued = this.queue.map(pick).filter((task): task is Task => task !== undefined);
    return {
      active: active ? [active] : [],
      queued,
      queuedLimit: this.queueLimit,
    };
  }

  subscribe(taskId: string, cb: Listener): () => void {
    let set = this.subs.get(taskId);
    if (!set) {
      set = new Set();
      this.subs.set(taskId, set);
    }
    set.add(cb);
    return () => {
      set.delete(cb);
      if (set.size === 0) this.subs.delete(taskId);
    };
  }

  /** 排队位是否已满（不含正在处理的任务） */
  isQueueFull(): boolean {
    return this.queue.length >= this.queueLimit;
  }

  /** 入队前的前置校验；路由层据此在落盘/下载前就拒绝，避免无谓的上传 */
  assertQueueCapacity(): void {
    if (this.isQueueFull()) throw new QueueFullError(this.queueLimit);
  }

  enqueue(taskId: string): void {
    this.assertQueueCapacity();
    this.queue.push(taskId);
    this.emit(taskId);
    void this.drain();
  }

  /**
   * 取消排队中的任务：出队 + 标 canceled（12 号票 I5）。
   * 只对还在内存队列里的任务生效；正在处理或不存在于队列时返回 false，
   * 由路由层转成 409。canceled 是终态：不在 isProcessing 里，
   * 重启后 failOrphanTasks 不会把它改成 failed，worker 也不会再捡起。
   *
   * 为什么不做「运行中取消」：ASR 分段与 ffmpeg 半途掐断会留下脏文件
   * （audio.mp3 存在但转录稿缺失），删除重建比支持半态便宜——
   * 失败/不要的任务直接重新提交即可。
   */
  cancelQueued(taskId: string): boolean {
    const idx = this.queue.indexOf(taskId);
    if (idx === -1) return false;
    this.queue.splice(idx, 1);
    this.opts.store.update(taskId, { status: "canceled" });
    this.emit(taskId);
    return true;
  }

  async whenIdle(): Promise<void> {
    if (!this.running && this.queue.length === 0) return;
    await new Promise<void>((resolve) => this.idleResolvers.push(resolve));
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const id = this.queue.shift();
        if (id === undefined) continue;
        this.activeId = id;
        try {
          await this.process(id);
        } finally {
          this.activeId = null;
        }
      }
    } finally {
      this.running = false;
      this.activeId = null;
      const waiters = this.idleResolvers.splice(0);
      for (const resolve of waiters) resolve();
    }
  }

  private async process(taskId: string): Promise<void> {
    const task = this.opts.store.get(taskId);
    if (!task) return;
    const dir = taskDir(this.opts.dataDir, taskId);
    const startedAt = Date.now();
    logInfo("task processing started", {
      task_id: taskId,
      source_kind: task.sourceKind,
      ext: task.ext,
    });
    try {
      let ext = task.ext;

      // 阶段 1：链接任务先下载（落成 source.<ext>，与上传任务同一后续管线）
      if (task.sourceKind === "link") {
        if (!this.opts.source) throw new Error("未配置下载器");
        if (!task.sourceUrl) throw new Error("链接任务缺少来源地址");
        this.patch(taskId, { status: "downloading", progress: 5, downloadPct: 0 });
        const downloadAt = Date.now();
        await mkdir(dir, { recursive: true });
        const media = await this.opts.source.fetch(task.sourceUrl, dir, (p) => {
          const pct =
            p.totalBytes > 0 ? Math.round((p.downloadedBytes / p.totalBytes) * 100) : 0;
          this.patch(taskId, {
            downloadPct: Math.min(99, pct),
            progress: 5 + Math.round(pct * 0.15),
          });
        });
        ext = media.ext;
        // 下载器产出 media.<ext>，统一改名为管线的 source.<ext>
        const target = sourcePath(dir, ext);
        if (media.file !== target) await rename(media.file, target);
        this.patch(taskId, {
          ext,
          sizeBytes: media.sizeBytes,
          downloadPct: 100,
          progress: 20,
          sourceNotice: media.notice ?? task.sourceNotice,
        });
        logInfo("media downloaded", {
          task_id: taskId,
          ext,
          bytes: media.sizeBytes,
          duration_ms: elapsedMs(downloadAt),
        });
      }

      const source = sourcePath(dir, ext);
      const probeAt = Date.now();
      const info = await probe(source);
      if (!info.hasAudio) throw new Error("文件中没有检测到音轨");
      this.patch(taskId, { durationSec: info.durationSec });
      logInfo("media probed", {
        task_id: taskId,
        duration_sec: info.durationSec,
        has_audio: info.hasAudio,
        duration_ms: elapsedMs(probeAt),
      });

      // 阶段 2：字幕优先（容器内字幕轨道），不可用则 ASR 兜底
      this.patch(taskId, { status: "fetching-subtitles", progress: 30 });
      const cues = await this.trySubtitles(source, dir);

      if (cues) {
        const segments: TranscriptSegment[] = cues.map((c) => ({
          start: c.start,
          end: c.end,
          text: c.text,
        }));
        await this.writeTranscript(dir, info.durationSec, segments, undefined, false);
        logInfo("subtitle track selected", {
          task_id: taskId,
          cues: cues.length,
          segments: segments.length,
        });
        this.patch(taskId, { status: "extracting-frames", progress: 88, transcriptOrigin: "subtitle" });
      } else {
        logInfo("subtitle track unavailable; falling back to asr", { task_id: taskId });
        const audio = audioPath(dir);
        this.patch(taskId, { status: "extracting", progress: 35 });
        await extractAudio(source, audio);

        const chunkSeconds = this.opts.chunkSeconds ?? DEFAULT_CHUNK_SECONDS;
        this.patch(taskId, { status: "transcribing", progress: 40 });

        const needsChunking = info.durationSec > chunkSeconds;
        const chunks = needsChunking
          ? await chunkAudio(audio, dir, info.durationSec, chunkSeconds)
          : [{ file: audio, start: 0 } satisfies AudioChunk];

        const segments: TranscriptSegment[] = [];
        let timestampsMissing = false;
        let language: string | undefined;
        try {
          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const chunkAt = Date.now();
            const part = await this.opts.asr.transcribe(chunk.file);
            logInfo("asr chunk completed", {
              task_id: taskId,
              chunk: i + 1,
              chunks: chunks.length,
              segments: part.segments.length,
              duration_ms: elapsedMs(chunkAt),
            });
            timestampsMissing ||= part.timestampsMissing;
            language ??= part.language;
            for (const seg of part.segments) {
              segments.push({
                start: seg.start + chunk.start,
                end: seg.end + chunk.start,
                text: seg.text,
              });
            }
            this.patch(taskId, {
              status: "transcribing",
              progress: 40 + Math.round(((i + 1) / chunks.length) * 45),
            });
          }
        } finally {
          if (needsChunking) {
            for (const chunk of chunks) {
              await rm(chunk.file, { force: true }).catch(() => {});
            }
          }
        }

        segments.sort((a, b) => a.start - b.start);
        await this.writeTranscript(dir, info.durationSec, segments, language, timestampsMissing);
        logInfo("transcript ready", {
          task_id: taskId,
          origin: "asr",
          segments: segments.length,
          language,
          timestamps_missing: timestampsMissing,
        });
        this.patch(taskId, { status: "extracting-frames", progress: 88, transcriptOrigin: "asr" });
      }

      // 阶段 3：全景帧（失败不阻塞就绪——抽帧只影响文章与画面问答）
      const framesAt = Date.now();
      try {
        await extractOverviewFrames(
          source,
          dir,
          info.durationSec,
          this.opts.overviewFrames ?? DEFAULT_OVERVIEW_FRAMES,
        );
        logInfo("overview frames ready", {
          task_id: taskId,
          duration_ms: elapsedMs(framesAt),
        });
      } catch (err) {
        logWarn("overview frame extraction failed", {
          task_id: taskId,
          ...errorFields(err),
          duration_ms: elapsedMs(framesAt),
        });
      }

      this.patch(taskId, { status: "ready", progress: 100 });
      logInfo("task ready", { task_id: taskId, duration_ms: elapsedMs(startedAt) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.patch(taskId, { status: "failed", error: message });
      logError("task failed", {
        task_id: taskId,
        ...errorFields(err),
        duration_ms: elapsedMs(startedAt),
      });
    }
  }

  /** 容器内字幕轨道：抽不出来或覆盖率不足都回退 ASR */
  private async trySubtitles(source: string, dir: string): Promise<SubtitleCue[] | null> {
    try {
      const cues = await extractSubtitleTrack(source, dir);
      if (cues.length === 0) return null;
      const coverage = subtitleCoverage(cues, (await probe(source)).durationSec);
      // 低于"可用"阈值（50%）视为不可用，回退 ASR
      if (coverage < 0.5) return null;
      return closeUncovered(cues);
    } catch {
      return null;
    }
  }

  private async writeTranscript(
    dir: string,
    durationSec: number,
    segments: TranscriptSegment[],
    language: string | undefined,
    timestampsMissing: boolean,
  ): Promise<void> {
    const transcript: Transcript = { durationSec, segments, language, timestampsMissing };
    await writeFile(transcriptPath(dir), JSON.stringify(transcript, null, 2), "utf8");
  }

  private patch(taskId: string, patch: TaskPatch): void {
    this.opts.store.update(taskId, patch);
    this.emit(taskId);
  }

  private emit(taskId: string): void {
    const task = this.opts.store.get(taskId);
    if (!task) return;
    const set = this.subs.get(taskId);
    if (!set) return;
    for (const cb of set) cb(task);
  }
}
