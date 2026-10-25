/** play() 被 pause()/换源/卸载打断时浏览器以 AbortError reject，这是预期的竞态信号 */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** 安全调用 play()：AbortError 静默返回 false，其他错误原样抛出 */
export async function safePlay(media: HTMLMediaElement): Promise<boolean> {
  try {
    await media.play();
    return true;
  } catch (error) {
    if (isAbortError(error)) return false;
    throw error;
  }
}
