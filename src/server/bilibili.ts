import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * B 站 API 兜底通道。
 *
 * 机房出口 IP 访问 www.bilibili.com/video/* 与 wbi/playurl 常被风控直接返回 412
 * （网页是验证码页），yt-dlp 第一步抓网页就失败。官方的 view / player(platform=html5)
 * 接口在没有登录态时仍可用，能拿到 720P 单文件 mp4，足够抽帧与转写。
 * 因此仅在 yt-dlp 失败时作为兜底，不改变正常路径。
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const REFERER = "https://www.bilibili.com/";

export interface BilibiliMeta {
  title: string;
  durationSec: number | null;
  thumbnailUrl: string | null;
}

export interface BilibiliDownload {
  file: string;
  ext: string;
  sizeBytes: number;
}

interface ViewPage {
  page: number;
  cid: number;
  part: string;
  duration: number;
}

interface ViewData {
  bvid: string;
  aid: number;
  title: string;
  duration: number;
  pic?: string;
  cid: number;
  pages?: ViewPage[];
}

interface ApiEnvelope<T> {
  code: number;
  message?: string;
  data?: T;
}

export function isBilibiliUrl(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host === "bilibili.com" || host.endsWith(".bilibili.com") || host === "b23.tv" || host.endsWith(".b23.tv");
  } catch {
    return false;
  }
}

/** b23.tv 短链先展开成带 BV 号的正式地址 */
async function expandShortLink(url: string): Promise<string> {
  if (!/(^|\.)b23\.tv$/i.test(new URL(url).hostname)) return url;
  const res = await fetch(url, { redirect: "follow", headers: { "user-agent": UA } });
  return res.url || url;
}

/** 未登录访问内容接口需要 buvid 指纹 cookie，spi 接口可匿名领取 */
async function getBuvidCookie(): Promise<string> {
  const res = await fetch("https://api.bilibili.com/x/frontend/finger/spi", {
    headers: { "user-agent": UA, referer: REFERER },
  });
  if (!res.ok) return "";
  const json = (await res.json().catch(() => null)) as ApiEnvelope<{ b_3?: string; b_4?: string }> | null;
  const parts: string[] = [];
  if (json?.data?.b_3) parts.push(`buvid3=${json.data.b_3}`);
  if (json?.data?.b_4) parts.push(`buvid4=${json.data.b_4}`);
  return parts.join("; ");
}

async function apiGet<T>(url: URL, cookie: string): Promise<T> {
  const res = await fetch(url, {
    headers: { "user-agent": UA, referer: REFERER, ...(cookie ? { cookie } : {}) },
  });
  if (!res.ok) throw new Error(`B 站接口 HTTP ${res.status}`);
  const json = (await res.json().catch(() => null)) as ApiEnvelope<T> | null;
  if (!json) throw new Error("B 站接口返回非 JSON");
  if (json.code !== 0 || !json.data) {
    throw new Error(`B 站接口返回 ${json.code}：${json.message ?? "无数据"}`);
  }
  return json.data;
}

async function fetchView(url: string, cookie: string): Promise<{ data: ViewData; page: number }> {
  const parsed = new URL(url);
  const bvid = /\/video\/(BV[0-9A-Za-z]{10})/i.exec(parsed.pathname)?.[1];
  const aid = /\/video\/av(\d+)/i.exec(parsed.pathname)?.[1];
  if (!bvid && !aid) throw new Error("未能从链接中解析出 BV 号");

  const api = new URL("https://api.bilibili.com/x/web-interface/view");
  if (bvid) api.searchParams.set("bvid", bvid);
  else api.searchParams.set("aid", aid as string);

  const data = await apiGet<ViewData>(api, cookie);
  const page = Number(parsed.searchParams.get("p") ?? "1") || 1;
  return { data, page };
}

function pickPage(data: ViewData, page: number): ViewPage | undefined {
  if (!data.pages || data.pages.length === 0) return undefined;
  return data.pages.find((p) => p.page === page) ?? data.pages[0];
}

function pageTitle(data: ViewData, target: ViewPage | undefined): string {
  if (!target || !data.pages || data.pages.length <= 1) return data.title;
  return `${data.title} - P${target.page} ${target.part}`;
}

/** 只取元数据：标题、时长、封面 */
export async function probeBilibili(url: string): Promise<BilibiliMeta> {
  const cookie = await getBuvidCookie();
  const { data, page } = await fetchView(await expandShortLink(url), cookie);
  const target = pickPage(data, page);
  return {
    title: pageTitle(data, target).trim() || "未命名视频",
    durationSec: Number.isFinite(target?.duration) ? Number(target?.duration) : Number.isFinite(data.duration) ? data.duration : null,
    thumbnailUrl: data.pic ?? null,
  };
}

async function fetchStreamUrl(
  bvid: string,
  aid: number,
  cid: number,
  cookie: string,
): Promise<{ url: string; sizeBytes: number }> {
  const api = new URL("https://api.bilibili.com/x/player/playurl");
  api.searchParams.set("cid", String(cid));
  api.searchParams.set("qn", "64");
  api.searchParams.set("platform", "html5");
  api.searchParams.set("high_quality", "1");
  if (bvid) api.searchParams.set("bvid", bvid);
  else api.searchParams.set("avid", String(aid));

  const data = await apiGet<{ durl?: Array<{ url: string; size: number }> }>(api, cookie);
  const segments = data.durl ?? [];
  if (segments.length === 0) throw new Error("B 站未返回可下载的视频流");
  if (segments.length > 1) throw new Error("B 站返回了分段流，暂不支持自动合并");
  return { url: segments[0].url, sizeBytes: segments[0].size };
}

/** 下载到 destDir/media.mp4，并按字节回报进度 */
export async function downloadBilibili(
  rawUrl: string,
  destDir: string,
  onProgress?: (p: { downloadedBytes: number; totalBytes: number }) => void,
): Promise<BilibiliDownload> {
  const cookie = await getBuvidCookie();
  const url = await expandShortLink(rawUrl);
  const { data, page } = await fetchView(url, cookie);
  const target = pickPage(data, page);
  const cid = target?.cid ?? data.cid;
  const stream = await fetchStreamUrl(data.bvid, data.aid, cid, cookie);

  await mkdir(destDir, { recursive: true });
  const file = path.join(destDir, "media.mp4");
  const res = await fetch(stream.url, {
    headers: { "user-agent": UA, referer: REFERER },
  });
  if (!res.ok || !res.body) throw new Error(`下载视频流失败（HTTP ${res.status}）`);

  const total = Number(res.headers.get("content-length")) || stream.sizeBytes;
  let downloaded = 0;
  const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  source.on("data", (chunk: Buffer) => {
    downloaded += chunk.length;
    if (total > 0) onProgress?.({ downloadedBytes: downloaded, totalBytes: total });
  });
  await pipeline(source, createWriteStream(file));

  return { file, ext: ".mp4", sizeBytes: (await stat(file)).size };
}
