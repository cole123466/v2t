"use client";

import { useRef } from "react";
import Link from "next/link";
import { motion, useScroll, useTransform } from "motion/react";
import {
  ArrowRight,
  AudioWaveform,
  Captions,
  ChevronDown,
  PenLine,
  Play,
  Upload,
} from "lucide-react";
import { WaveBars } from "@/components/landing/wave-bars";
import { ThemeToggle } from "@/components/theme-toggle";

const FEATURES = [
  {
    icon: Upload,
    title: "拖拽上传",
    desc: "本地视频直接拖入，最大 2GB，ffmpeg 解码主流封装格式。",
  },
  {
    icon: Captions,
    title: "时间戳转写",
    desc: "句级时间戳的中文转写，长音频自动分段、偏移合并。",
  },
  {
    icon: AudioWaveform,
    title: "声画稿联动",
    desc: "播放器、波形与文稿三方联动，点击任意一句即回到画面。",
  },
  {
    icon: PenLine,
    title: "AI 文案生成",
    desc: "预设模板或自定义提示词，流式生成，多版本随时回看。",
  },
];

const TRANSCRIPT_PREVIEW = [
  { t: "00:01", text: "各位好，欢迎来到本期节目。" },
  { t: "00:04", text: "今天聊聊怎么把一段视频，变成一篇能用的文案。" },
  { t: "00:09", text: "上传、转写、生成，一气呵成。" },
];

export default function Home() {
  return (
    <main className="relative overflow-x-clip">
      <SiteHeader />
      <Hero />
      <Narrative />
      <Features />
      <FinalCall />
      <footer className="flex flex-col gap-2 border-t border-tint/5 px-6 py-8 font-mono text-[10px] tracking-widest text-paper-faint sm:flex-row sm:items-center sm:justify-between md:px-10">
        <span>V2T — LOCAL VIDEO COPY STATION</span>
        <span>FFMPEG INSIDE</span>
      </footer>
    </main>
  );
}

function SiteHeader() {
  return (
    <header className="fixed inset-x-0 top-0 z-50 flex items-center justify-between px-6 py-5 md:px-10">
      <Link href="/" className="font-display text-xl font-bold tracking-wide">
        V2T<span className="text-gold">.</span>
      </Link>
      <div className="flex items-center gap-6">
        <a
          href="#features"
          className="hidden font-mono text-[11px] tracking-widest text-paper-faint transition-colors hover:text-paper sm:block"
        >
          核心能力
        </a>
        <ThemeToggle />
        <Link
          href="/studio"
          className="rounded-full border border-gold/40 px-4 py-1.5 font-mono text-[11px] tracking-widest text-gold transition-colors hover:bg-gold hover:text-ink-950"
        >
          进入工作台
        </Link>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="relative flex min-h-svh flex-col items-center justify-center gap-7 px-6 text-center">
      <WaveBars
        count={110}
        className="absolute inset-x-0 top-1/2 h-44 -translate-y-1/2 text-tint/[0.045]"
      />
      <p
        className="relative font-mono text-[11px] tracking-[0.35em] text-gold"
        style={{ animation: "rise 0.9s var(--ease-smooth) both" }}
      >
        VIDEO&nbsp;&nbsp;TO&nbsp;&nbsp;COPY
      </p>
      <h1
        className="relative font-display text-[clamp(5.5rem,22vw,17rem)] font-bold leading-[0.95] tracking-tight"
        style={{ animation: "rise 1.1s var(--ease-smooth) 0.1s both" }}
      >
        V<span className="text-gold">2</span>T
      </h1>
      <p
        className="relative font-display text-3xl font-black tracking-wide md:text-5xl"
        style={{ animation: "rise 1s var(--ease-smooth) 0.25s both" }}
      >
        视频，进。文案，出。
      </p>
      <p
        className="relative max-w-xl text-sm leading-relaxed text-paper-dim"
        style={{ animation: "rise 1s var(--ease-smooth) 0.4s both" }}
      >
        上传一段本地视频，自动转写为带时间戳的文稿，再由 AI 生成可直接使用的文案。
        全程一站式完成。
      </p>
      <Link
        href="/studio"
        className="group relative inline-flex items-center gap-3 rounded-full bg-gold px-8 py-3.5 text-sm font-medium text-ink-950 transition-all hover:brightness-110"
        style={{ animation: "rise 1s var(--ease-smooth) 0.55s both" }}
      >
        开始上传
        <ArrowRight
          className="size-4 transition-transform group-hover:translate-x-1"
          strokeWidth={1.5}
        />
      </Link>
      <div className="absolute bottom-8 flex flex-col items-center gap-2 text-paper-faint">
        <span className="font-mono text-[10px] tracking-[0.3em]">SCROLL</span>
        <ChevronDown className="size-4 animate-bounce" strokeWidth={1.5} />
      </div>
    </section>
  );
}

/** 三幕滚动叙事：画面 → 声波 → 文字，sticky 视口内由滚动进度驱动交叉淡入 */
function Narrative() {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start start", "end end"],
  });

  const act1 = useTransform(scrollYProgress, [0, 0.26, 0.34], [1, 1, 0]);
  const act2 = useTransform(scrollYProgress, [0.3, 0.38, 0.6, 0.68], [0, 1, 1, 0]);
  const act3 = useTransform(scrollYProgress, [0.64, 0.72, 1], [0, 1, 1]);
  const act1Scale = useTransform(scrollYProgress, [0, 0.34], [1, 0.92]);
  const act2Scale = useTransform(scrollYProgress, [0.3, 0.68], [0.94, 1]);
  const act3Y = useTransform(scrollYProgress, [0.64, 0.8], [28, 0]);
  const railFill = useTransform(scrollYProgress, [0, 1], [0, 1]);

  return (
    <section ref={ref} className="relative h-[340vh]">
      <div className="sticky top-0 flex h-svh items-center justify-center overflow-hidden">
        {/* 第一幕：画面（取景器） */}
        <motion.div
          style={{ opacity: act1, scale: act1Scale }}
          className="absolute inset-0 flex items-center justify-center px-6"
        >
          <div className="glass relative aspect-video w-[min(78vw,880px)] rounded-2xl">
            <Corner className="left-4 top-4 border-l border-t" />
            <Corner className="right-4 top-4 border-r border-t" />
            <Corner className="bottom-4 left-4 border-b border-l" />
            <Corner className="bottom-4 right-4 border-b border-r" />
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="flex size-16 items-center justify-center rounded-full border border-tint/15 text-paper">
                <Play className="size-6 translate-x-0.5" strokeWidth={1.5} />
              </span>
            </div>
            <p className="absolute bottom-5 left-1/2 -translate-x-1/2 font-mono text-[10px] tracking-[0.3em] text-paper-faint">
              REC&nbsp;&nbsp;00:00:00
            </p>
          </div>
        </motion.div>

        {/* 第二幕：声波 */}
        <motion.div
          style={{ opacity: act2, scale: act2Scale }}
          className="absolute inset-0 flex items-center justify-center px-6"
        >
          <div className="w-[min(84vw,960px)]">
            <WaveBars count={84} className="h-40 text-gold/80 md:h-56" />
          </div>
        </motion.div>

        {/* 第三幕：文字（转写稿） */}
        <motion.div
          style={{ opacity: act3, y: act3Y }}
          className="absolute inset-0 flex items-center justify-center px-6"
        >
          <div className="glass w-[min(84vw,720px)] rounded-2xl p-6 md:p-9">
            {TRANSCRIPT_PREVIEW.map((row, i) => (
              <div
                key={row.t}
                className="flex items-baseline gap-4 border-b border-tint/5 py-3.5 last:border-none md:py-4"
                style={{
                  animation: `rise 0.8s var(--ease-smooth) ${(0.15 + i * 0.18).toFixed(2)}s both`,
                }}
              >
                <span className="shrink-0 font-mono text-xs text-gold">{row.t}</span>
                <span className="text-sm leading-relaxed text-paper-dim md:text-base">
                  {row.text}
                </span>
              </div>
            ))}
          </div>
        </motion.div>

        {/* 幕次字幕（绝对定位于同一锚点，随进度交叉淡入） */}
        <div className="absolute bottom-10 left-6 h-28 md:left-10">
          <motion.div style={{ opacity: act1 }} className="absolute bottom-0 left-0">
            <ActLabel
              no="ACT I"
              en="THE FRAME"
              cn="画面"
              line="一切从一帧画面开始。上传你的视频，本地解码。"
            />
          </motion.div>
          <motion.div style={{ opacity: act2 }} className="absolute bottom-0 left-0">
            <ActLabel
              no="ACT II"
              en="THE WAVE"
              cn="声波"
              line="画面退去，声音显形。16kHz 单声道，每一秒都被听见。"
            />
          </motion.div>
          <motion.div style={{ opacity: act3 }} className="absolute bottom-0 left-0">
            <ActLabel
              no="ACT III"
              en="THE TEXT"
              cn="文字"
              line="声波落定成文字。句句带时间戳，点击即回放。"
            />
          </motion.div>
        </div>

        {/* 右侧进度轨 */}
        <div className="absolute right-6 top-1/2 hidden h-40 w-px -translate-y-1/2 bg-tint/10 md:right-10 md:block">
          <motion.div style={{ scaleY: railFill }} className="h-full w-full origin-top bg-gold" />
        </div>
      </div>
    </section>
  );
}

function Corner({ className }: { className: string }) {
  return <span className={`absolute size-5 border-tint/25 ${className}`} aria-hidden />;
}

function ActLabel({ no, en, cn, line }: { no: string; en: string; cn: string; line: string }) {
  return (
    <span className="block max-w-xs">
      <span className="block font-mono text-[10px] tracking-[0.3em] text-gold">
        {no} — {en}
      </span>
      <span className="mt-2 block font-display text-4xl font-black">{cn}</span>
      <span className="mt-2 block text-xs leading-relaxed text-paper-dim">{line}</span>
    </span>
  );
}

function Features() {
  return (
    <section id="features" className="mx-auto w-full max-w-6xl px-6 py-28 md:py-36">
      <p className="font-mono text-[11px] tracking-[0.35em] text-gold">WHAT&apos;S INSIDE</p>
      <h2 className="mt-3 font-display text-4xl font-bold md:text-5xl">核心能力</h2>
      <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {FEATURES.map((f, i) => (
          <motion.div
            key={f.title}
            initial={{ opacity: 0, y: 28 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{ duration: 0.7, delay: i * 0.08, ease: [0.22, 1, 0.36, 1] }}
            className="glass flex flex-col gap-4 rounded-2xl p-6"
          >
            <span className="flex size-11 items-center justify-center rounded-full border border-tint/10 text-gold">
              <f.icon className="size-5" strokeWidth={1.5} />
            </span>
            <h3 className="text-base text-paper">{f.title}</h3>
            <p className="text-xs leading-relaxed text-paper-faint">{f.desc}</p>
          </motion.div>
        ))}
      </div>
    </section>
  );
}

function FinalCall() {
  return (
    <section className="relative flex flex-col items-center gap-8 px-6 py-32 text-center md:py-40">
      <WaveBars count={72} className="absolute inset-x-0 top-8 h-20 text-tint/[0.04]" />
      <p className="relative font-mono text-[11px] tracking-[0.35em] text-gold">
        READY WHEN YOU ARE
      </p>
      <h2 className="relative font-display text-5xl font-bold leading-tight md:text-7xl">
        把视频，变成文案。
      </h2>
      <Link
        href="/studio"
        className="group relative inline-flex items-center gap-3 rounded-full border border-gold/50 px-8 py-3.5 text-sm text-gold transition-all hover:bg-gold hover:text-ink-950"
      >
        进入工作台
        <ArrowRight
          className="size-4 transition-transform group-hover:translate-x-1"
          strokeWidth={1.5}
        />
      </Link>
    </section>
  );
}
