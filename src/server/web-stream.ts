import type { Readable } from "node:stream";

/**
 * Node Readable → Web ReadableStream 的桥，替代 `Readable.toWeb`。
 *
 * 为什么不用 `Readable.toWeb`：Node 22 的适配器在消费端中断时（Next 用
 * `response.pipeTo(writer, {signal})`，客户端断开即 abort → cancel）会先
 * cancel 掉 web 流，随后源流被销毁时适配器仍收到 `close` 并调用
 * `controller.close()`；此时 controller 已关闭，抛 `ERR_INVALID_STATE`
 * （`TypeError: Invalid state: Controller is already closed`）。异常发生在
 * 适配器内部回调里，业务层 try/catch 拦不住，最终变成进程级
 * uncaughtException（2026-10 至今线上 350+ 次，视频拖动进度条即触发）。
 *
 * 这里自己持有 controller：所有写入/关闭都先看 `finished`，保证幂等；
 * `cancel()` 主动销毁源流，`pull()` 恢复背压暂停的读取。
 */
export function nodeToWebStream(source: Readable): ReadableStream<Uint8Array> {
  let finished = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const finish = (error?: unknown) => {
        if (finished) return;
        finished = true;
        try {
          if (error) controller.error(error);
          else controller.close();
        } catch {
          // 消费端已关闭（abort）：忽略
        }
      };

      source.on("data", (chunk: Buffer) => {
        if (finished) return;
        try {
          controller.enqueue(chunk);
        } catch {
          // 消费端已取消：停止读取并释放文件句柄
          finished = true;
          source.destroy();
          return;
        }
        if ((controller.desiredSize ?? 1) <= 0) source.pause();
      });
      source.on("end", () => finish());
      source.on("close", () => finish());
      source.on("error", (error) => finish(error));
    },
    pull() {
      if (!finished) source.resume();
    },
    cancel() {
      finished = true;
      source.destroy();
    },
  });

  return stream;
}
