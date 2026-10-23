"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

const BARS = 360;

/**
 * 波形锚点：客户端 Web Audio 解码抽取的音频画峰值，
 * 已播部分点亮金色，点击任意位置跳转播放进度。
 */
export function Waveform({
  audioSrc,
  videoRef,
}: {
  audioSrc: string;
  videoRef: RefObject<HTMLVideoElement | null>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const peaksRef = useRef<Float32Array | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    let ctx: AudioContext | null = null;
    peaksRef.current = null;
    (async () => {
      setStatus("loading");
      const res = await fetch(audioSrc);
      if (!res.ok) throw new Error("audio fetch failed");
      const raw = await res.arrayBuffer();
      ctx = new AudioContext();
      const audio = await ctx.decodeAudioData(raw);
      await ctx.close();
      if (cancelled) return;

      const data = audio.getChannelData(0);
      const peaks = new Float32Array(BARS);
      const step = Math.max(1, Math.floor(data.length / BARS));
      const stride = Math.max(1, Math.floor(step / 200));
      for (let i = 0; i < BARS; i++) {
        let max = 0;
        const from = i * step;
        const to = Math.min(data.length, from + step);
        for (let j = from; j < to; j += stride) {
          const v = Math.abs(data[j]);
          if (v > max) max = v;
        }
        peaks[i] = max;
      }
      peaksRef.current = peaks;
      setStatus("ready");
    })().catch(() => {
      void ctx?.close();
      if (!cancelled) setStatus("error");
    });
    return () => {
      cancelled = true;
      void ctx?.close();
    };
  }, [audioSrc]);

  useEffect(() => {
    let raf = 0;
    // 画布颜色取自主题变量；缓存下来，避免每帧都触发 getComputedStyle 的样式重算
    let cachedDark: boolean | null = null;
    let activeColor = "#d9a441";
    let idleColor = "rgba(236,233,226,0.22)";
    const draw = () => {
      const canvas = canvasRef.current;
      const peaks = peaksRef.current;
      if (canvas && peaks) {
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
          canvas.width = Math.round(w * dpr);
          canvas.height = Math.round(h * dpr);
        }
        const c = canvas.getContext("2d");
        if (c) {
          c.setTransform(dpr, 0, 0, dpr, 0, 0);
          c.clearRect(0, 0, w, h);
          // 主题切换后下一帧重新取色，其余帧复用缓存
          const isDark = document.documentElement.classList.contains("dark");
          if (isDark !== cachedDark) {
            cachedDark = isDark;
            const styles = getComputedStyle(canvas);
            activeColor =
              styles.getPropertyValue("--v2t-wave-active").trim() ||
              (isDark ? "#d9a441" : "#8a6114");
            idleColor =
              styles.getPropertyValue("--v2t-wave-idle").trim() ||
              (isDark ? "rgba(236,233,226,0.22)" : "rgba(22,19,14,0.22)");
          }
          const video = videoRef.current;
          const dur = video && Number.isFinite(video.duration) ? video.duration : 0;
          const frac = dur > 0 && video ? Math.min(1, video.currentTime / dur) : 0;
          const barW = w / peaks.length;
          for (let i = 0; i < peaks.length; i++) {
            const barH = Math.max(1.5, peaks[i] * h * 0.9);
            c.fillStyle = i / peaks.length <= frac ? activeColor : idleColor;
            c.fillRect(i * barW, (h - barH) / 2, Math.max(1, barW - 1.2), barH);
          }
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [videoRef]);

  const seek = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !Number.isFinite(video.duration)) return;
    const rect = canvas.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    video.currentTime = frac * video.duration;
  };

  return (
    <div className="glass rounded-2xl px-3 py-2">
      {status === "loading" ? (
        <div className="flex h-16 items-center justify-center font-mono text-[10px] tracking-widest text-paper-faint">
          WAVEFORM DECODING
        </div>
      ) : status === "error" ? (
        <div className="flex h-16 items-center justify-center font-mono text-[10px] tracking-widest text-paper-faint">
          WAVEFORM UNAVAILABLE
        </div>
      ) : null}
      <canvas
        ref={canvasRef}
        onClick={seek}
        className={`h-16 w-full cursor-pointer ${status === "ready" ? "" : "absolute"}`}
        style={{ visibility: status === "ready" ? "visible" : "hidden" }}
      />
    </div>
  );
}
