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
  /** 超过该秒数即分段转写；默认 50 分钟（ASR 提供方 ≤1h 且 ≤50MB 的硬限制倒推） */
  chunkSeconds?: number;
  /** 全景帧张数，默认 12 */
  overviewFrames?: number;
}

const DEFAULT_CHUNK_SECONDS = 50 * 60;
const DEFAULT_OVERVIEW_FRAMES = 12;

/**
 * 进程内串行任务管线：enqueue 入队，drain 逐个处理。
 * 状态流转 queued → (downloading) → extracting → (fetching-subtitles) → transcribing
 *          → (extracting-frames) → ready / failed，
 * 每次流转向订阅者推送任务快照（SSE 的数据源）。
 */
export class TaskRunner {
  private readonly queue: string[] = [];
  private running = false;
  private readonly subs = new Map<string, Set<Listener>>();
  private readonly idleResolvers: Array<() => void> = [];

  constructor(private readonly opts: RunnerOptions) {}

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

  enqueue(taskId: string): void {
    this.queue.push(taskId);
    this.emit(taskId);
    void this.drain();
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
        await this.process(id);
      }
    } finally {
      this.running = false;
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
