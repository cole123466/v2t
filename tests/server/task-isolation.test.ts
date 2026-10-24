import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getRuntime: vi.fn() }));
vi.mock("@/server/runtime", () => ({ getRuntime: mocks.getRuntime }));

import { GET as taskGet } from "@/app/api/tasks/[id]/route";

const DEVICE = "11111111-2222-4333-8444-555555555555";

function call(id: string, cookie?: string) {
  const request = new Request(`http://localhost/api/tasks/${id}`, {
    headers: cookie ? { cookie } : undefined,
  });
  return taskGet(request, { params: Promise.resolve({ id }) });
}

describe("任务详情按设备隔离", () => {
  beforeEach(() => {
    mocks.getRuntime.mockReset();
  });

  it("只查当前设备名下的任务，别人的按不存在处理", async () => {
    const seen: Array<[string, string]> = [];
    mocks.getRuntime.mockReturnValue({
      store: {
        getOwned: (id: string, owner: string) => {
          seen.push([id, owner]);
          return owner === DEVICE ? { id, owner, status: "ready" } : undefined;
        },
      },
    });

    const mine = await call("task-1", `v2t-device=${DEVICE}`);
    expect(mine.status).toBe(200);
    expect(seen).toEqual([["task-1", DEVICE]]);

    const theirs = await call("task-1", "v2t-device=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    expect(theirs.status).toBe(404);
    expect(await theirs.json()).toEqual({ error: "任务不存在" });
  });
});
