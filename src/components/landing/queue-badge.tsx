"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ListOrdered } from "lucide-react";
import type { QueueSnapshot } from "@/server/runner";

/**
 * 落地页的队列指示：只在有任务处理中或排队中时出现，
 * 点击直接进工作台。落地页没有任务数据，这里只读 /api/queue。
 */
export function QueueBadge() {
  const [queue, setQueue] = useState<QueueSnapshot | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = () =>
      fetch("/api/queue")
        .then((r) => (r.ok ? r.json() : null))
        .then((data: QueueSnapshot | null) => {
          if (alive && data) setQueue(data);
        })
        .catch(() => {
          // 队列接口不可用时保持隐藏，不影响落地页
        });
    void tick();
    const timer = setInterval(() => void tick(), 10_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const active = queue?.active.length ?? 0;
  const queued = queue?.queued.length ?? 0;
  if (active + queued === 0) return null;

  return (
    <Link
      href="/studio"
      title="当前视频处理队列"
      className="hidden items-center gap-2 rounded-full border border-tint/15 px-3.5 py-1.5 font-mono text-[11px] tracking-wider text-paper-dim transition-colors hover:border-gold/40 hover:text-gold sm:inline-flex"
    >
      <ListOrdered className="size-3.5" strokeWidth={1.5} />
      {active > 0 ? "1 处理中" : "队列空闲"}
      <span className="text-gold">· {queued} 排队</span>
    </Link>
  );
}
