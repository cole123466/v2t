import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getRuntime, RUNTIME_VERSION, type Runtime } from "@/server/runtime";

// 与 src/server/runtime.ts 共用同一个 globalThis 槽位，用于模拟 dev 下的 HMR 残留
const globalForV2t = globalThis as {
  __v2tRuntime?: { version: number; runtime: Runtime };
  __v2tPurgeTimer?: ReturnType<typeof setInterval>;
};

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "v2t-runtime-"));
  process.env.DATA_DIR = dir;
});

afterAll(async () => {
  globalForV2t.__v2tRuntime?.runtime.db.close();
  globalForV2t.__v2tRuntime = undefined;
  if (globalForV2t.__v2tPurgeTimer) clearInterval(globalForV2t.__v2tPurgeTimer);
  globalForV2t.__v2tPurgeTimer = undefined;
  await rm(dir, { recursive: true, force: true });
});

describe("运行时单例的版本校验", () => {
  it("丢弃 HMR 残留的旧实例，新实例带有 isQueueFull", () => {
    // 模拟「代码已更新、globalThis 里还是旧 runner」：旧 runner 没有队列方法
    const close = vi.fn();
    const staleRunner = { enqueue: vi.fn(), subscribe: vi.fn() };
    globalForV2t.__v2tRuntime = {
      version: RUNTIME_VERSION - 1,
      runtime: { db: { close }, runner: staleRunner } as unknown as Runtime,
    };

    const runtime = getRuntime();

    expect(runtime.runner).not.toBe(staleRunner);
    expect(typeof runtime.runner.isQueueFull).toBe("function");
    expect(runtime.runner.isQueueFull()).toBe(false);
    expect(runtime.runner.queueLimit).toBe(3);
    // 旧连接被释放，避免与新建连接争用同一个 DB 文件
    expect(close).toHaveBeenCalledOnce();
    expect(globalForV2t.__v2tRuntime?.version).toBe(RUNTIME_VERSION);
  });

  it("版本一致时复用同一实例", () => {
    const first = getRuntime();
    const second = getRuntime();
    expect(second).toBe(first);
  });
});
