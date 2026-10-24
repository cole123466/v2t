import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb, type Db } from "@/server/db";
import { DEVICE_COOKIE, deviceOwner } from "@/server/owner";
import { TaskStore } from "@/server/tasks";

const DEVICE_A = "11111111-2222-4333-8444-555555555555";
const DEVICE_B = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

let dir: string;
let db: Db;
let store: TaskStore;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "v2t-owner-"));
  db = openDb(path.join(dir, "test.db"));
  store = new TaskStore(db);
});

afterAll(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

function reqWithCookie(cookie?: string) {
  return new Request("http://localhost/api/tasks", {
    headers: cookie ? { cookie } : undefined,
  });
}

describe("设备归属解析", () => {
  it("从 cookie 头里取设备 ID，非法值当作没有", () => {
    expect(deviceOwner(reqWithCookie(`theme=dark; ${DEVICE_COOKIE}=${DEVICE_A}`))).toBe(DEVICE_A);
    expect(deviceOwner(reqWithCookie(`${DEVICE_COOKIE}=not-a-uuid`))).toBe("");
    expect(deviceOwner(reqWithCookie("theme=dark"))).toBe("");
    expect(deviceOwner(reqWithCookie())).toBe("");
  });
});

describe("任务按设备隔离", () => {
  it("列表与 getOwned 只认自己的任务", () => {
    const mine = store.create({
      originalName: "mine.mp4",
      ext: ".mp4",
      sizeBytes: 1,
      owner: DEVICE_A,
    });
    const theirs = store.create({
      originalName: "theirs.mp4",
      ext: ".mp4",
      sizeBytes: 1,
      owner: DEVICE_B,
    });

    expect(store.list(DEVICE_A).map((t) => t.id)).toEqual([mine.id]);
    expect(store.list(DEVICE_B).map((t) => t.id)).toEqual([theirs.id]);
    expect(store.getOwned(theirs.id, DEVICE_A)).toBeUndefined();
    expect(store.getOwned(mine.id, DEVICE_A)?.id).toBe(mine.id);
    // 内部调用（清理 / 统计）仍可拿到全部
    expect(store.list().length).toBeGreaterThanOrEqual(2);
  });

  it("历史任务（owner 为空）被第一台访问的设备认领一次", () => {
    const legacy = store.create({ originalName: "legacy.mp4", ext: ".mp4", sizeBytes: 1 });
    expect(legacy.owner).toBe("");

    expect(store.claimLegacy(DEVICE_B)).toBeGreaterThanOrEqual(1);
    expect(store.getOwned(legacy.id, DEVICE_B)?.id).toBe(legacy.id);

    // 已经有主之后再认领不该抢走别人的任务
    expect(store.claimLegacy(DEVICE_A)).toBe(0);
    expect(store.getOwned(legacy.id, DEVICE_A)).toBeUndefined();
  });
});
