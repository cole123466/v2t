import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdir, readdir, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { getDownloaderConfig } from "./config";
import { downloadBilibili, isBilibiliUrl, probeBilibili } from "./bilibili";
import { errorFields, logInfo, logWarn } from "./log";

const run = promisify(execFile);

/** 链接来源的元数据（下载前即可从提取器拿到） */
export interface SourceMeta {
  title: string;
  durationSec: number | null;
  thumbnailUrl: string | null;
  /** 来源降级说明（如 B 站风控），有值时前端需要提示 */
  notice?: string;
}

export interface FetchedMedia {
  /** 落盘后的媒体文件绝对路径（作为任务 source.<ext>） */
  file: string;
  ext: string;
  sizeBytes: number;
  /** 来源降级说明（如 B 站风控），有值时写入任务并提示用户 */
  notice?: string;
}

export interface FetchProgress {
  downloadedBytes: number;
  totalBytes: number;
}

export interface SourceProvider {
  /** 只取元数据，不下载 */
  probe(url: string): Promise<SourceMeta>;
  /** 下载媒体到目标目录，进度回调可缺省 */
  fetch(url: string, destDir: string, onProgress?: (p: FetchProgress) => void): Promise<FetchedMedia>;
}

const SUPPORTED_LINK =
  /^https?:\/\/([a-z0-9-]+\.)*(bilibili\.com|b23\.tv|youtube\.com|youtu\.be)\//i;

export function isSupportedLink(url: string): boolean {
  try {
    return SUPPORTED_LINK.test(new URL(url).toString());
  } catch {
    return false;
  }
}

const MISSING_YTDLP = "未找到 yt-dlp，请先运行 scripts/setup 脚本安装下载器";

/** B 站风控后官方接口兜底：任务页会持久展示，避免用户误以为拿到原清晰度 */
export const BILIBILI_FALLBACK_NOTICE =
  "B 站触发了风控限制，已改用官方接口获取 720P 单文件；清晰度可能低于原片，平台字幕可能不可用。";

const SIZE_UNIT: Record<string, number> = {
  KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4,
  KB: 1000, MB: 1000 ** 2, GB: 1000 ** 3, TB: 1000 ** 4,
};

/** 从 yt-dlp 的 [download] 行解析进度 */
function parseProgressLine(line: string): FetchProgress | null {
  const match = /\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+)\s*(KiB|MiB|GiB|TiB|KB|MB|GB|TB)/.exec(
    line,
  );
  if (!match) return null;
  const total = Number(match[2]) * (SIZE_UNIT[match[3]] ?? 1);
  const pct = Number(match[1]);
  if (!Number.isFinite(total) || !Number.isFinite(pct)) return null;
  return { downloadedBytes: Math.round((total * pct) / 100), totalBytes: Math.round(total) };
}

/**
 * yt-dlp 下载实现：免登录 Cookie 下载完整视频。
 * 视频供全景帧抽帧使用，音频由既有 ffmpeg 管线抽取——因此取"可得的最高清晰度"。
 * 更高清晰度或平台字幕需要在 .env 指向可选 Cookie 文件。
 */
export function createYtDlpProvider(): SourceProvider {
  const cookieArgs = (): string[] => {
    const { cookiesFile } = getDownloaderConfig();
    return cookiesFile ? ["--cookies", cookiesFile] : [];
  };

  return {
    async probe(url: string): Promise<SourceMeta> {
      let stdout: string;
      try {
        ({ stdout } = await run(
          "yt-dlp",
          ["--dump-single-json", "--no-playlist", "--no-warnings", ...cookieArgs(), url],
          { maxBuffer: 32 * 1024 * 1024 },
        ));
      } catch (err) {
        if ((err as { code?: string }).code === "ENOENT") throw new Error(MISSING_YTDLP);
        const message = toolErrorMessage(url, (err as { stderr?: string }).stderr);
        if (isBilibiliUrl(url)) {
          // 机房 IP 常被 B 站风控拦住网页，此时改走官方内容接口
          logWarn("link probe fallback to bilibili api", { host: new URL(url).host });
          try {
            const meta = await probeBilibili(url);
            return { ...meta, notice: BILIBILI_FALLBACK_NOTICE };
          } catch (fallbackError) {
            throw new Error(`${message}（API 兜底失败：${(fallbackError as Error).message}）`);
          }
        }
        throw new Error(message);
      }
      const info = JSON.parse(stdout) as {
        title?: string;
        duration?: number;
        thumbnail?: string;
      };
      return {
        title: info.title?.trim() || "未命名视频",
        durationSec: Number.isFinite(info.duration) ? Number(info.duration) : null,
        thumbnailUrl: info.thumbnail ?? null,
      };
    },

    async fetch(url, destDir, onProgress): Promise<FetchedMedia> {
      await mkdir(destDir, { recursive: true });
      const args = [
        "-f", "bv*+ba/b",
        "--no-playlist",
        "--no-warnings",
        "--newline",
        "--no-part",
        ...cookieArgs(),
        "-o", `${destDir}/media.%(ext)s`,
        url,
      ];

      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn("yt-dlp", args, { windowsHide: true });
          let stderr = "";
          let buffer = "";
          child.stdout.setEncoding("utf8");
          child.stdout.on("data", (chunk: string) => {
            buffer += chunk;
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              const progress = parseProgressLine(line);
              if (progress) onProgress?.(progress);
            }
          });
          child.stderr.setEncoding("utf8");
          child.stderr.on("data", (chunk: string) => {
            stderr += chunk;
          });
          child.on("error", (err) => {
            reject(
              (err as NodeJS.ErrnoException).code === "ENOENT"
                ? new Error(MISSING_YTDLP)
                : new Error(`下载失败：${err.message}`),
            );
          });
          child.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(toolErrorMessage(url, stderr)));
          });
        });
      } catch (err) {
        // yt-dlp 被 B 站风控（412）时，改走官方内容接口取 720P 单文件
        if (isBilibiliUrl(url)) {
          logWarn("media download fallback to bilibili api", {
            host: new URL(url).host,
            ...errorFields(err),
          });
          const media = await downloadBilibili(url, destDir, onProgress);
          logInfo("media download completed", {
            host: new URL(url).host,
            ext: media.ext,
            bytes: media.sizeBytes,
            fallback: true,
          });
          return { ...media, notice: BILIBILI_FALLBACK_NOTICE };
        }
        throw err;
      }

      const files = (await readdir(destDir)).filter((n) => n.startsWith("media."));
      if (files.length === 0) throw new Error(`下载完成但未找到媒体文件（${url}）`);
      const file = `${destDir}/${files[0]}`;
      const ext = `.${files[0].split(".").pop()}`;
      const sizeBytes = (await stat(file)).size;
      logInfo("media download completed", {
        host: new URL(url).host,
        ext,
        bytes: sizeBytes,
        fallback: false,
      });
      return { file, ext, sizeBytes };
    },
  };
}

function toolErrorMessage(target: string, stderr: unknown): string {
  const text = typeof stderr === "string" && stderr.trim() ? stderr : String(stderr ?? "");
  const detail = text.split(/\r?\n/).filter(Boolean).slice(-4).join(" | ") || "无输出";
  const hint = /HTTP Error 412/.test(text)
    ? "（B 站风控拦截，可配置 .env 的 DOWNLOADER_COOKIES_FILE 或更换出口网络）"
    : "";
  return `下载失败（${target}）：${detail}${hint}`;
}
