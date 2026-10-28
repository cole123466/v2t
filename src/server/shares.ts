import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { Db } from "./db";
import { bind, row as one, rows as many } from "./sql";
import type { Activity } from "./activities";
import type { ArticleRecord } from "./articles";
import type { Article } from "./article";
import type { Task } from "./tasks";
import { collectFrameIds } from "./export";

/**
 * 单篇只读分享（11 号票：decision-share-history）。
 *
 * 一行 = 一个有效链接：删行即撤销，重新分享插入新 id 即新链接（旧链接不留痕）。
 * 令牌 = HMAC(secret, "v2t-share:" + id)：DB 只存 id 与 token，拿到库文件也
 * 无法凭 id 伪造链接（能力与存储分离）；secret 派生自设备签名密钥（本工程
 * 没有独立密钥体系，用 SHARE_SECRET 环境变量 + 缺省随机，重启失效可接受）。
 */

export interface Share {
  id: string;
  token: string;
  taskId: string;
  articleId: string;
  createdAt: string;
}

interface ShareRow {
  id: string;
  token: string;
  task_id: string;
  article_id: string;
  created_at: string;
}

function toShare(row: ShareRow): Share {
  return {
    id: row.id,
    token: row.token,
    taskId: row.task_id,
    articleId: row.article_id,
    createdAt: row.created_at,
  };
}

const TOKEN_CONTEXT = "v2t-share:";
const ID_PATTERN = /^[0-9a-f]{32}$/;
const TOKEN_SEPARATOR = ".";
const FRAME_ID_PATTERN = /^[a-z0-9_-]+$/i;

let ephemeralSecret: string | null = null;

function shareSecret(): string {
  const fromEnv = process.env.SHARE_SECRET;
  if (fromEnv) return fromEnv;
  // 缺省随机（见文件头注释）：重启即换、旧链接随之失效。
  // 不能退回源码常量——那等于把伪造令牌的能力公开在仓库里。
  ephemeralSecret ??= randomBytes(32).toString("hex");
  return ephemeralSecret;
}

function hmacFor(id: string): string {
  return createHmac("sha256", shareSecret()).update(TOKEN_CONTEXT + id).digest("base64url");
}

/** 令牌 = 32hex id + "." + HMAC；常量时间比对，格式不对直接失败 */
export function verifyShareToken(token: string): string | null {
  const parts = token.split(TOKEN_SEPARATOR);
  if (parts.length !== 2 || !ID_PATTERN.test(parts[0])) return null;
  const [id, mac] = parts;
  const expected = Buffer.from(hmacFor(id));
  const actual = Buffer.from(mac);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  return id;
}

/** 分享专属钉帧目录：data/shares/{shareId}/frames/{frameId}.jpg */
export function shareDir(dataDir: string, shareId: string): string {
  return path.join(dataDir, "shares", shareId);
}

export function shareFramesDir(dataDir: string, shareId: string): string {
  return path.join(shareDir(dataDir, shareId), "frames");
}

export class ShareStore {
  constructor(private readonly db: Db) {}

  /** 幂等创建：同 task + article 已有分享则原样返回 */
  ensure(input: { taskId: string; articleId: string }): { share: Share; created: boolean } {
    const existing = one<ShareRow>(
      this.db
        .prepare("SELECT * FROM shares WHERE task_id = ? AND article_id = ?")
        .get(input.taskId, input.articleId),
    );
    if (existing) return { share: toShare(existing), created: false };
    const share: Share = {
      id: randomId(),
      token: "",
      taskId: input.taskId,
      articleId: input.articleId,
      createdAt: new Date().toISOString(),
    };
    share.token = `${share.id}${TOKEN_SEPARATOR}${hmacFor(share.id)}`;
    this.db
      .prepare(
        `INSERT INTO shares (id, token, task_id, article_id, created_at)
         VALUES (@id, @token, @taskId, @articleId, @createdAt)`,
      )
      .run(bind(share));
    return { share, created: true };
  }

  /** 按 token 取分享；令牌无效或行不存在（已撤销）都返回 undefined */
  getByToken(token: string): Share | undefined {
    const id = verifyShareToken(token);
    if (!id) return undefined;
    const row = one<ShareRow>(this.db.prepare("SELECT * FROM shares WHERE id = ?").get(id));
    return row ? toShare(row) : undefined;
  }

  get(id: string): Share | undefined {
    const row = one<ShareRow>(this.db.prepare("SELECT * FROM shares WHERE id = ?").get(id));
    return row ? toShare(row) : undefined;
  }

  listForTask(taskId: string): Share[] {
    return many<ShareRow>(
      this.db.prepare("SELECT * FROM shares WHERE task_id = ?").all(taskId),
    ).map(toShare);
  }

  /** 撤销 = 删行 */
  remove(id: string): void {
    this.db.prepare("DELETE FROM shares WHERE id = ?").run(id);
  }

  /** 删除任务时级联：该任务全部分享行（目录由调用方删） */
  removeAllForTask(taskId: string): Share[] {
    const rows = many<ShareRow>(
      this.db.prepare("SELECT * FROM shares WHERE task_id = ?").all(taskId),
    );
    if (rows.length > 0) {
      this.db.prepare("DELETE FROM shares WHERE task_id = ?").run(taskId);
    }
    return rows.map(toShare);
  }
}

function randomId(): string {
  return randomBytes(16).toString("hex");
}

// ---------------------------------------------------------------------------
// 钉帧（S3）：创建分享时把被引帧复制进分享专属目录，媒体清理不碰、撤销时删
// ---------------------------------------------------------------------------

/** 正文 figure 引用 + 步骤里出现过的帧；上限 12 张（全景帧量级） */
export function shareFrameIds(article: Article): string[] {
  return collectFrameIds(article).slice(0, 12);
}

/**
 * 复制钉帧：framesToPin 是 frameId → 任务目录内绝对路径。
 * 命名即 frameId.jpg，公开路由按此约定读取。
 */
export async function pinShareFrames(
  dataDir: string,
  share: Share,
  framesToPin: Map<string, string>,
): Promise<number> {
  const outDir = shareFramesDir(dataDir, share.id);
  await mkdir(outDir, { recursive: true });
  let pinned = 0;
  for (const [frameId, src] of framesToPin) {
    // frameId 来源于文章内容，写文件前与读侧做同一道白名单防穿越
    if (!FRAME_ID_PATTERN.test(frameId)) continue;
    const target = path.join(outDir, `${frameId}.jpg`);
    try {
      await copyFile(src, target);
      pinned += 1;
    } catch (error) {
      console.warn("pinShareFrames failed:", frameId, error);
    }
  }
  return pinned;
}

export async function readPinnedFrame(
  dataDir: string,
  share: Share,
  frameId: string,
): Promise<Buffer | null> {
  // frameId 由路由白名单校验后传入，这里再防一次路径穿越
  if (!FRAME_ID_PATTERN.test(frameId)) return null;
  const file = path.join(shareFramesDir(dataDir, share.id), `${frameId}.jpg`);
  if (!file.startsWith(shareFramesDir(dataDir, share.id) + path.sep)) return null;
  return readFile(file).catch(() => null);
}

export async function removeShareDir(dataDir: string, shareId: string): Promise<void> {
  await rm(shareDir(dataDir, shareId), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 载荷投影（照参考工程脱敏清单）：分享 JSON = 文章全文 + 处理步骤 + 钉帧清单
// 铁律：qa_messages 不进入本模块可达路径；taskId/articleId/owner/error 详情不外泄
// ---------------------------------------------------------------------------

export interface SharePayload {
  /** 只读快照的创建时间（即分享创建时间） */
  sharedAt: string;
  article: {
    title: string | null;
    content: Article | null;
    detailLevel: string;
    purpose: string | null;
    model: string;
    status: string;
    createdAt: string;
  };
  /** 失败步骤只说「这次处理未能完成」，不带原始错误与堆栈 */
  steps: Array<{
    seq: number;
    phase: string | null;
    title: string | null;
    status: string | null;
    message: string | null;
    startedAt: string;
    endedAt: string | null;
    ok: boolean | null;
  }>;
  /** 钉住帧的引用信息（图片走 /api/share/{token}/frames/{frameId}） */
  frames: Array<{ id: string; tSec: number | null }>;
}

/** 步骤 message 脱敏：截断 + 去文件路径与堆栈形状 */
function sanitizeMessage(message: string | null): string | null {
  if (!message) return null;
  const firstLine = message.split("\n")[0].trim();
  const stripped = firstLine
    .replace(/(?:\/|\\)[\w./\\-]+/g, "…")
    .replace(/\s+at\s+[\w.<>/]+/g, "");
  return stripped.slice(0, 160) || null;
}

function toStepProjection(a: Activity): SharePayload["steps"][number] {
  const failed = a.status === "failed" || a.status === "canceled" || a.ok === false;
  return {
    seq: a.seq,
    phase: a.phase,
    title: a.title,
    status: a.status,
    // 失败步骤的 message 一律换成语义占位，不带内部错误原文
    message: failed ? "这次处理未能完成" : sanitizeMessage(a.message),
    startedAt: a.startedAt,
    endedAt: a.endedAt,
    ok: a.ok,
  };
}

/** 供投影使用的最小任务信息（无 owner、无内部 error） */
export interface ShareTaskView {
  title: string;
  sourceUrl: string | null;
}

export function buildSharePayload(input: {
  share: Share;
  task: Task;
  article: ArticleRecord;
  steps: Activity[];
  pinnedFrameIds: string[];
  frameTimes: Map<string, number>;
}): SharePayload {
  const { share, article } = input;
  return {
    sharedAt: share.createdAt,
    article: {
      title: article.title,
      content: article.content,
      detailLevel: article.detailLevel,
      purpose: article.purpose,
      model: article.model,
      status: article.status,
      createdAt: article.createdAt,
    },
    steps: input.steps.filter((s) => s.kind !== "model").map(toStepProjection),
    frames: input.pinnedFrameIds.map((id) => ({ id, tSec: input.frameTimes.get(id) ?? null })),
  };
}
