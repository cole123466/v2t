import { useMemo } from "react";

/** 纯装饰性波形条阵：高度与动画节奏由索引伪随机生成，避免引入音频解码 */
export function WaveBars({
  count = 48,
  className = "",
}: {
  count?: number;
  className?: string;
}) {
  const bars = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => ({
        h: 0.22 + Math.abs(Math.sin(i * 0.72 + 0.4)) * 0.78,
        delay: ((i * 137) % 100) / 100,
        duration: 1.5 + (((i * 73) % 90) / 100),
      })),
    [count],
  );
  return (
    <div className={`flex items-center gap-[3px] ${className}`} aria-hidden>
      {bars.map((b, i) => (
        <span
          key={i}
          className="wave-bar min-w-[2px] flex-1 origin-center rounded-full bg-current"
          style={{
            height: `${Math.round(b.h * 100)}%`,
            animation: `wave-pulse ${b.duration.toFixed(2)}s ease-in-out ${b.delay.toFixed(2)}s infinite`,
          }}
        />
      ))}
    </div>
  );
}
