"use client";

import { useRef, useState, type RefObject } from "react";
import { Pause, Play } from "lucide-react";
import { safePlay } from "@/lib/media";
import { clock } from "@/lib/time";

const SPEEDS = [1, 1.25, 1.5, 2];

export function Player({
  src,
  videoRef,
  onTime,
  onError,
}: {
  src: string;
  videoRef: RefObject<HTMLVideoElement | null>;
  onTime: (t: number) => void;
  onError: () => void;
}) {
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speedIdx, setSpeedIdx] = useState(0);
  const barRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const pct = duration > 0 ? Math.min(1, time / duration) : 0;

  const applyFrac = (clientX: number) => {
    const bar = barRef.current;
    const video = videoRef.current;
    if (!bar || !video || !Number.isFinite(video.duration)) return;
    const rect = bar.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    video.currentTime = frac * video.duration;
    setTime(video.currentTime);
    onTime(video.currentTime);
  };

  const toggle = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      // AbortError（play 被 pause/换源打断）由 safePlay 吞掉；其余错误仅记录，避免未处理 rejection
      void safePlay(video).catch((error) => console.debug("play blocked:", error));
    } else video.pause();
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-tint/10 bg-black">
      <video
        ref={videoRef}
        src={src}
        className="aspect-video w-full cursor-pointer bg-black"
        playsInline
        onClick={toggle}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => {
          if (draggingRef.current) return;
          const t = e.currentTarget.currentTime;
          setTime(t);
          onTime(t);
        }}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onError={onError}
      />

      <div className="flex items-center gap-4 border-t border-tint/10 bg-ink-900/90 px-4 py-3">
        <button
          type="button"
          onClick={toggle}
          aria-label={playing ? "暂停" : "播放"}
          className="flex size-9 shrink-0 items-center justify-center rounded-full border border-tint/15 text-paper transition-colors hover:border-gold/60 hover:text-gold"
        >
          {playing ? (
            <Pause className="size-4" strokeWidth={1.5} />
          ) : (
            <Play className="size-4 translate-x-[1px]" strokeWidth={1.5} />
          )}
        </button>

        <span className="shrink-0 font-mono text-[11px] text-paper-dim">
          {clock(time)} / {clock(duration)}
        </span>

        <div
          ref={barRef}
          role="slider"
          aria-label="进度"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(time)}
          tabIndex={0}
          className="group h-6 flex-1 cursor-pointer"
          onPointerDown={(e) => {
            draggingRef.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            applyFrac(e.clientX);
          }}
          onPointerMove={(e) => {
            if (draggingRef.current) applyFrac(e.clientX);
          }}
          onPointerUp={() => {
            draggingRef.current = false;
          }}
        >
          <div className="relative top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-tint/15 transition-all group-hover:h-1.5">
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-gold"
              style={{ width: `${pct * 100}%` }}
            />
          </div>
        </div>

        <button
          type="button"
          onClick={() => {
            const next = (speedIdx + 1) % SPEEDS.length;
            setSpeedIdx(next);
            if (videoRef.current) videoRef.current.playbackRate = SPEEDS[next];
          }}
          className="shrink-0 rounded-full border border-tint/15 px-3 py-1 font-mono text-[11px] text-paper-dim transition-colors hover:border-gold/60 hover:text-gold"
        >
          {SPEEDS[speedIdx]}x
        </button>
      </div>
    </div>
  );
}
