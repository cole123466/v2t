"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  Archive,
  ArrowLeft,
  AudioWaveform,
  Captions,
  Check,
  FileText,
  Image,
  Loader,
  MessageCircleQuestion,
  Activity,
  Upload,
  X,
} from "lucide-react";
import type { Task } from "@/server/tasks";
import { petFlow } from "@/components/pet/pet-flow";
import type { Transcript } from "@/server/asr";
import { Player } from "@/components/workbench/player";
import { Waveform } from "@/components/workbench/waveform";
import { TranscriptPanel } from "@/components/workbench/transcript-panel";
import { PromptPanel } from "@/components/workbench/prompt-panel";
import { ArticlePanel } from "@/components/workbench/article-panel";
import { QaPanel } from "@/components/workbench/qa-panel";
import { ProcessPanel } from "@/components/workbench/process-panel";
import { WaveBars } from "@/components/landing/wave-bars";
import { SourceNotice } from "@/components/workbench/source-notice";
import { ThemeToggle } from "@/components/theme-toggle";
import { PetToggle } from "@/components/pet/pet-toggle";
import { clock } from "@/lib/time";
import { failureHint } from "@/lib/failure-hint";

const STAGES = [
  { key: "scope", label: "获取来源", icon: Upload },
  { key: "subtitles", label: "字幕优先", icon: Captions },
  { key: "transcribe", label: "转写", icon: AudioWaveform },
  { key: "frames", label: "抽取画面", icon: Image },
  { key: "ready", label: "就绪", icon: Check },
] as const;

function stageIndex(task: Task): number {
  switch (task.status) {
    case "ready":
      return 5;
    case "extracting-frames":
      return 3;
    case "transcribing":
    case "extracting":
      return 2;
    case "fetching-subtitles":
      return 1;
    case "failed":
      return 2;
    default:
      // queued / downloading 都在来源阶段
      return 0;
  }
}

/** 处理中的说明文案 */
function statusHint(task: Task): string {
  if (task.status === "queued") return "排队等待处理";
  if (task.status === "downloading") {
    return `正在下载媒体${task.downloadPct !== null ? `（${task.downloadPct}%）` : ""}`;
  }
  if (task.status === "fetching-subtitles") return "优先尝试平台或容器内字幕";
  if (task.status === "extracting") return "正在抽取 16kHz 单声道音频";
  if (task.status === "transcribing") return "正在转写，长音频自动分段中";
  return "正在抽取覆盖全片的画面";
}

type TabKey = "transcript" | "article" | "qa" | "process" | "copy";

const TABS: Array<{ key: TabKey; label: string; icon: typeof FileText }> = [
  { key: "transcript", label: "文稿", icon: Captions },
  { key: "article", label: "图文", icon: FileText },
  { key: "qa", label: "问答", icon: MessageCircleQuestion },
  { key: "copy", label: "文案", icon: FileText },
  { key: "process", label: "过程", icon: Activity },
];

/** 处理阶段波形：已点亮比例 = 任务进度，视觉与 landing/工作台同源 */
function ProgressWave({ progress }: { progress: number }) {
  const revealed = Math.min(100, Math.max(0, progress));
  return (
    <div className="relative h-16" aria-hidden>
      <WaveBars count={64} className="absolute inset-0 text-tint/[0.07]" />
      <div
        className="pointer-events-none absolute inset-0 transition-[clip-path] duration-700"
        style={{ clipPath: `inset(0 ${100 - revealed}% 0 0)` }}
      >
        <WaveBars count={64} className="h-full text-gold/70" />
      </div>
    </div>
  );
}

export default function TaskPage() {
  const { id } = useParams<{ id: string }>();
  const [task, setTask] = useState<Task | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [transcriptMissing, setTranscriptMissing] = useState(false);
  const [missing, setMissing] = useState(false);
  const [time, setTime] = useState(0);
  const [playbackError, setPlaybackError] = useState(false);
  const [tab, setTab] = useState<TabKey>("transcript");
  const [canceling, setCanceling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const lastStatus = useRef<string | null>(null);

  useEffect(() => {
    void fetch(`/api/tasks/${id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((t) => (t ? setTask(t) : setMissing(true)));
    const es = new EventSource(`/api/tasks/${id}/events`);
    es.onmessage = (e) => setTask(JSON.parse(e.data) as Task);
    return () => es.close();
  }, [id]);

  // 任务状态 → 桌宠状态。首次进入只同步基线，不补放“完成”庆祝；
  // 后续真正的状态跃迁才触发一次性动作。
  useEffect(() => {
    const status = task?.status;
    if (!status || lastStatus.current === status) return;
    const first = lastStatus.current === null;
    lastStatus.current = status;

    if (status === "queued") petFlow.queued();
    else if (status === "ready") {
      if (first) petFlow.idle();
      else petFlow.done();
    } else if (status === "failed") petFlow.failed();
    else if (status === "canceled") petFlow.idle();
    else petFlow.working();
  }, [task?.status]);

  // 离开任务页时收回桌宠，避免一直停在“检查/等待”
  useEffect(() => {
    return () => {
      // 重置快照，保证 StrictMode 重挂载后能重新同步当前状态
      lastStatus.current = null;
      petFlow.idle();
    };
  }, []);

  useEffect(() => {
    if (task?.status === "ready" && !transcript) {
      void fetch(`/api/tasks/${id}/transcript`)
        .then((r) => {
          if (!r.ok) setTranscriptMissing(true);
          return r.ok ? r.json() : null;
        })
        .then((t) => {
          if (t) setTranscript(t as Transcript);
        });
    }
  }, [task?.status, id, transcript]);

  const activeIndex = useMemo(() => {
    if (!transcript) return -1;
    let idx = -1;
    for (let i = 0; i < transcript.segments.length; i++) {
      if (transcript.segments[i].start <= time + 0.05) idx = i;
      else break;
    }
    return idx;
  }, [transcript, time]);

  // 12 号票 I5：取消排队中的任务。运行中的任务没有取消入口——
  // 半途掐断转写会留下脏文件，重新提交比支持半态便宜。
  const cancelTask = async () => {
    if (canceling) return;
    setCanceling(true);
    setCancelError(null);
    try {
      const res = await fetch(`/api/tasks/${id}/cancel`, { method: "POST" });
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as { error?: string } | null;
        setCancelError(detail?.error ?? `取消失败（${res.status}）`);
      }
    } catch {
      setCancelError("网络中断，取消失败");
    } finally {
      setCanceling(false);
    }
  };

  if (missing) {
    return (
      <main className="flex min-h-svh flex-col items-center justify-center gap-6 px-6 text-center">
        <X className="size-10 text-danger/80" strokeWidth={1.5} />
        <h1 className="font-display text-3xl font-semibold">任务不存在</h1>
        <Link href="/studio/tasks" className="font-mono text-xs tracking-widest text-paper-faint hover:text-gold">
          返回任务列表
        </Link>
      </main>
    );
  }

  if (!task) {
    return (
      <main className="flex min-h-svh items-center justify-center">
        <Loader className="size-6 animate-spin text-paper-faint" strokeWidth={1.5} />
      </main>
    );
  }

  const header = (
    <header className="flex items-center justify-between gap-4 py-6">
      <div className="min-w-0">
        <h1 className="truncate font-display text-2xl font-semibold">{task.originalName}</h1>
        <p className="mt-1 font-mono text-[11px] tracking-widest text-paper-faint">
          {task.durationSec ? `${Math.round(task.durationSec)}s · ` : ""}
          {task.status.toUpperCase()}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-4">
        <PetToggle />
        <ThemeToggle />
        <Link
          href="/studio/tasks"
          className="inline-flex shrink-0 items-center gap-2 font-mono text-xs tracking-widest text-paper-faint transition-colors hover:text-gold"
        >
          <ArrowLeft className="size-3.5" strokeWidth={1.5} />
          任务列表
        </Link>
      </div>
    </header>
  );

  const notice = <SourceNotice text={task.sourceNotice} />;

  if (task.status === "failed") {
    const { hint } = failureHint(task.error);
    return (
      <main className="mx-auto w-full max-w-3xl px-6 pb-16">
        {header}
        {notice}
        <section className="glass mt-6 flex flex-col gap-3 rounded-3xl border-danger/30 p-8">
          <X className="size-8 text-danger/90" strokeWidth={1.5} />
          <h2 className="text-lg text-paper">处理失败</h2>
          <p className="break-all font-mono text-xs leading-relaxed text-danger/80">
            {task.error ?? "未知错误"}
          </p>
          <p className="text-xs leading-relaxed text-paper-faint">{hint}</p>
        </section>
      </main>
    );
  }

  // 已取消：终态视图，没有可继续的内容，引导重新提交
  if (task.status === "canceled") {
    return (
      <main className="mx-auto w-full max-w-3xl px-6 pb-16">
        {header}
        {notice}
        <section className="glass mt-6 flex flex-col gap-3 rounded-3xl p-8">
          <X className="size-8 text-paper-faint" strokeWidth={1.5} />
          <h2 className="text-lg text-paper">任务已取消</h2>
          <p className="text-xs leading-relaxed text-paper-faint">
            该任务在排队时被取消，未产生转录稿与文章。需要的话请重新提交来源。
          </p>
          <Link
            href="/studio"
            className="mt-2 inline-flex w-fit items-center gap-2 rounded-full border border-gold/40 px-4 py-1.5 font-mono text-[11px] tracking-widest text-gold transition-colors hover:bg-gold hover:text-ink-950"
          >
            返回导入页
          </Link>
        </section>
      </main>
    );
  }

  if (task.status !== "ready") {
    const current = stageIndex(task);
    return (
      <main className="mx-auto w-full max-w-3xl px-6 pb-16">
        {header}
        {notice}
        <section className="glass mt-6 flex flex-col gap-8 rounded-3xl p-10">
          {/* 波形随进度点亮：管线进行中时波形即产品的视觉锚 */}
          <ProgressWave progress={task.progress} />
          <div className="flex items-center justify-between">
            {STAGES.map((stage, i) => {
              const done = i < current;
              const active = i === current;
              return (
                <div key={stage.key} className="flex flex-1 items-center gap-3 last:flex-none">
                  <div className="flex items-center gap-3">
                    {done ? (
                      <span className="flex size-8 items-center justify-center rounded-full border border-positive/40 text-positive/90">
                        <Check className="size-4" strokeWidth={1.5} />
                      </span>
                    ) : active ? (
                      <span className="flex size-8 items-center justify-center rounded-full border border-gold/50 text-gold">
                        <Loader className="size-4 animate-spin" strokeWidth={1.5} />
                      </span>
                    ) : (
                      <span className="flex size-8 items-center justify-center rounded-full border border-tint/10 text-paper-faint">
                        <stage.icon className="size-4" strokeWidth={1.5} />
                      </span>
                    )}
                    <span
                      className={`text-sm ${active ? "text-paper" : done ? "text-paper-dim" : "text-paper-faint"}`}
                    >
                      {stage.label}
                    </span>
                  </div>
                  {i < STAGES.length - 1 ? (
                    <div className={`mx-2 h-px flex-1 ${done ? "bg-positive/40" : "bg-tint/10"}`} />
                  ) : null}
                </div>
              );
            })}
          </div>

          <div>
            <div className="h-1 overflow-hidden rounded-full bg-tint/10">
              <div
                className="h-full rounded-full bg-gold transition-all duration-500"
                style={{ width: `${task.progress}%` }}
              />
            </div>
            <p className="mt-3 text-right font-mono text-[11px] text-paper-faint">{task.progress}%</p>
          </div>

          <p className="text-center font-mono text-[11px] tracking-widest text-paper-faint">
            {statusHint(task)}
          </p>

          {/* 排队中的任务可取消出队（12 号票 I5）；处理中没有取消入口 */}
          {task.status === "queued" ? (
            <div className="flex flex-col items-center gap-2">
              <button
                type="button"
                onClick={() => void cancelTask()}
                disabled={canceling}
                className="inline-flex items-center gap-2 rounded-xl border border-danger/30 bg-danger/5 px-4 py-1.5 font-mono text-[10px] tracking-wider text-danger/80 transition-colors hover:bg-danger/15 disabled:opacity-40"
              >
                <X className="size-3" strokeWidth={1.5} />
                {canceling ? "取消中" : "取消任务"}
              </button>
              {cancelError ? (
                <p className="font-mono text-[10px] text-danger/80">{cancelError}</p>
              ) : null}
            </div>
          ) : null}
        </section>
      </main>
    );
  }

  // 就绪：三栏工作台
  return (
    <main className="mx-auto w-full max-w-[1500px] px-6 pb-10">
      {header}
      {notice}
      {playbackError ? (
        <p className="mb-4 rounded-xl border border-gold/30 bg-gold/10 px-4 py-2.5 text-xs text-gold">
          当前浏览器不支持该容器格式的直接播放，文稿联动与导出不受影响。
        </p>
      ) : null}
      {transcript?.timestampsMissing ? (
        <p className="mb-4 rounded-xl border border-gold/30 bg-gold/10 px-4 py-2.5 text-xs text-gold">
          转写引擎本次未返回时间戳，文稿无法与画面逐句联动，SRT 时间轴亦不可用；文案生成不受影响。
        </p>
      ) : null}
      <div className="grid min-h-0 gap-5 xl:grid-cols-[minmax(380px,1fr)_minmax(0,1.3fr)_340px]">
        <div className="flex min-w-0 flex-col gap-4">
          {task.mediaPurgedAt ? (
            <div className="glass flex min-h-64 flex-col items-center justify-center gap-3 rounded-2xl border-dashed p-8 text-center">
              <Archive className="size-8 text-paper-faint" strokeWidth={1.5} />
              <p className="text-sm text-paper-dim">媒体已按保留期自动清理</p>
              <p className="font-mono text-[11px] text-paper-faint">
                {new Date(task.mediaPurgedAt).toLocaleString("zh-CN")}
              </p>
              <p className="max-w-xs text-xs leading-relaxed text-paper-faint">
                源视频与音频已删除，转录稿与生成文案永久保留，可继续查看、复制与导出。
              </p>
            </div>
          ) : (
            <>
              <Player
                src={`/api/tasks/${id}/source`}
                videoRef={videoRef}
                onTime={setTime}
                onError={() => setPlaybackError(true)}
              />
              <Waveform audioSrc={`/api/tasks/${id}/audio`} videoRef={videoRef} />
            </>
          )}
          <div className="glass flex flex-wrap items-center justify-between gap-2 rounded-2xl px-5 py-3 font-mono text-[10px] tracking-widest text-paper-faint">
            <span>{task.mediaPurgedAt ? "MEDIA PURGED" : "SOURCE 16kHz MONO MP3"}</span>
            <span>
              {transcript
                ? [
                    transcript.language?.toUpperCase(),
                    task.durationSec ? clock(task.durationSec) : null,
                    `${transcript.segments.length} SEG`,
                    `${transcript.segments.reduce((n, s) => n + s.text.length, 0)} 字`,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : "…"}
            </span>
          </div>
        </div>

        <div className="min-w-0">
          {transcript ? (
            <div className="h-[calc(100svh-170px)] min-h-[420px]">
              <TranscriptPanel
                transcript={transcript}
                videoRef={videoRef}
                activeIndex={activeIndex}
                taskName={task.originalName}
                onSeek={setTime}
              />
            </div>
          ) : transcriptMissing ? (
            <div className="glass flex h-full min-h-[420px] flex-col items-center justify-center gap-3 rounded-2xl p-8 text-center">
              <X className="size-7 text-danger/80" strokeWidth={1.5} />
              <p className="text-sm text-paper-dim">转录稿缺失</p>
              <p className="max-w-xs text-xs leading-relaxed text-paper-faint">
                该任务的转录稿文件不存在或已损坏，请重新上传处理。
              </p>
            </div>
          ) : (
            <div className="glass flex h-full min-h-[420px] items-center justify-center rounded-2xl">
              <Loader className="size-5 animate-spin text-paper-faint" strokeWidth={1.5} />
            </div>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <div className="glass flex shrink-0 gap-1 rounded-2xl p-1.5">
            {TABS.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl px-2 py-1.5 font-mono text-[10px] tracking-wider transition-colors ${
                  tab === key
                    ? "bg-gold/10 text-gold"
                    : "text-paper-faint hover:bg-tint/[0.03] hover:text-paper-dim"
                }`}
              >
                <Icon className="size-3" strokeWidth={1.5} />
                {label}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1">
            {tab === "transcript" ? (
              <div className="glass h-[calc(100svh-230px)] min-h-[420px] overflow-auto rounded-2xl p-5">
                <p className="font-mono text-[10px] tracking-widest text-paper-faint">
                  当前段落
                </p>
                {activeIndex >= 0 && transcript?.segments[activeIndex] ? (
                  <div className="mt-3">
                    <p className="font-mono text-[11px] text-gold">
                      {clock(transcript.segments[activeIndex].start)} –{" "}
                      {clock(transcript.segments[activeIndex].end)}
                    </p>
                    <p className="mt-2 text-sm leading-relaxed text-paper-dim">
                      {transcript.segments[activeIndex].text}
                    </p>
                  </div>
                ) : (
                  <p className="mt-3 text-xs leading-relaxed text-paper-faint">
                    播放视频时，这里会跟随高亮当前句；也可以直接在左侧文稿里点击任意一句跳转。
                  </p>
                )}
                <div className="mt-6 border-t border-tint/5 pt-4">
                  <p className="font-mono text-[10px] tracking-widest text-paper-faint">
                    转写来源
                  </p>
                  <p className="mt-2 text-xs text-paper-dim">
                    {task.transcriptOrigin === "subtitle"
                      ? "平台/容器内字幕（优先采用）"
                      : task.transcriptOrigin === "asr"
                        ? "语音转写（ASR）"
                        : "未知"}
                  </p>
                  {transcript ? (
                    <p className="mt-1 font-mono text-[10px] text-paper-faint">
                      {transcript.segments.length} 段 ·{" "}
                      {transcript.segments.reduce((n, s) => n + s.text.length, 0)} 字
                      {transcript.language ? ` · ${transcript.language}` : ""}
                    </p>
                  ) : null}
                </div>
              </div>
            ) : null}
            {tab === "article" ? (
              <ArticlePanel
                taskId={id}
                videoRef={videoRef}
                defaultDetail={task.detailLevel}
                defaultPurpose={task.purpose}
              />
            ) : null}
            {tab === "qa" ? <QaPanel taskId={id} videoRef={videoRef} /> : null}
            {tab === "copy" ? <PromptPanel taskId={id} taskName={task.originalName} /> : null}
            {tab === "process" ? <ProcessPanel taskId={id} /> : null}
          </div>
        </div>
      </div>
    </main>
  );
}
