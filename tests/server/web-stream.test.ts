import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { nodeToWebStream } from "@/server/web-stream";

/** 每次 read 推一块，支持 pause/resume 背压；用于模拟 createReadStream */
function source(chunks = 64, size = 64 * 1024): Readable {
  let sent = 0;
  return new Readable({
    read() {
      if (sent >= chunks) {
        this.push(null);
        return;
      }
      sent += 1;
      this.push(Buffer.alloc(size, sent % 256));
    },
  });
}

describe("nodeToWebStream（替代 Readable.toWeb 的防崩桥）", () => {
  it("正常读完：字节数与顺序完整", async () => {
    const web = nodeToWebStream(source(8, 1024));
    const reader = web.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    expect(chunks.length).toBe(8);
    expect(chunks.reduce((n, c) => n + c.byteLength, 0)).toBe(8 * 1024);
  });

  it("消费端 cancel 时销毁源流并停止写入", async () => {
    const src = source();
    const web = nodeToWebStream(src);
    const reader = web.getReader();
    await reader.read();
    await reader.cancel();
    expect(src.destroyed).toBe(true);
  });

  it("pipeTo abort（客户端断开）不产生未捕获异常", async () => {
    const src = source();
    const web = nodeToWebStream(src);
    const ac = new AbortController();
    const writer = new WritableStream({
      write() {
        return new Promise((resolve) => setTimeout(resolve, 5));
      },
    });
    const piped = web.pipeTo(writer, { signal: ac.signal }).catch((err: Error) => err.name);
    setTimeout(() => ac.abort(), 5);
    expect(await piped).toBe("AbortError");
    // 让源流的 close 事件有机会到达（旧实现是在这里二次 close 已关闭的 controller）
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(src.destroyed).toBe(true);
  });
});
