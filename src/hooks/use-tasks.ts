"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Task } from "@/server/tasks";
import type { StorageStats } from "@/server/maintenance";
import type { QueueSnapshot } from "@/server/runner";

const POLL_MS = 4000;

/** 任务列表、存储占用与处理队列总是一起刷新，抽成一次请求组合复用 */
async function fetchDashboard(): Promise<{
  tasks: Task[] | null;
  stats: StorageStats | null;
  queue: QueueSnapshot | null;
}> {
  const tasksRes = await fetch("/api/tasks");
  const tasks = tasksRes.ok ? ((await tasksRes.json()) as { tasks: Task[] }).tasks : null;
  const storageRes = await fetch("/api/storage");
  const stats = storageRes.ok ? ((await storageRes.json()) as StorageStats) : null;
  const queueRes = await fetch("/api/queue");
  const queue = queueRes.ok ? ((await queueRes.json()) as QueueSnapshot) : null;
  return { tasks, stats, queue };
}

/** 任务列表页的数据层：首屏取数 + 4 秒轮询 + 删除（带二次确认） */
export function useTasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [queue, setQueue] = useState<QueueSnapshot | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchDashboard();
      if (next.tasks) setTasks(next.tasks);
      if (next.stats) setStats(next.stats);
      if (next.queue) setQueue(next.queue);
    } catch {
      // 刷新失败保留旧数据；页面每 4 秒轮询会重试，不打断上传队列
    }
  }, []);

  const removeTask = useCallback(
    async (id: string) => {
      if (confirmDelete !== id) {
        setConfirmDelete(id);
        setTimeout(() => setConfirmDelete((cur) => (cur === id ? null : cur)), 3000);
        return;
      }
      setConfirmDelete(null);
      const res = await fetch(`/api/tasks/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(detail?.error ?? "删除失败");
      }
      await refresh();
    },
    [confirmDelete, refresh],
  );

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const { tasks, stats, queue } = await fetchDashboard();
      if (cancelled) return;
      if (tasks) setTasks(tasks);
      if (stats) setStats(stats);
      if (queue) setQueue(queue);
    };
    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return { tasks, stats, queue, confirmDelete, error, removeTask, refresh };
}

/** 导入页只需要服务端队列快照：本设备正在处理与排队的任务 */
export function useQueueSnapshot() {
  const [queue, setQueue] = useState<QueueSnapshot | null>(null);
  // 卸载后到达的响应不再写 state；初值 false，effect 挂载后才放开，
  // 避免 StrictMode 的「挂载→卸载→再挂载」间隙里把旧响应写进来
  const mounted = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/queue");
      if (res.ok && mounted.current) setQueue((await res.json()) as QueueSnapshot);
    } catch {
      // 队列接口暂时不可用时保留上一次快照，轮询会重试
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    // 首屏与轮询都走同一个 refresh；setState 发生在 await 之后，不在 effect 同步阶段
    const tick = () => void refresh();
    tick();
    const timer = setInterval(tick, POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [refresh]);

  return { queue, refresh };
}
