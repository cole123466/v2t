#!/usr/bin/env node
/**
 * 部署通知：把文本发到飞书。
 *
 * 配置优先级：
 *   1. 环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_NOTIFY_CHAT_ID / FEISHU_BASE_URL
 *   2. 仓库内 agent/.env（与 agent 的审查通知共用一套应用凭证）
 *   3. 会话 id 回退到 agent/state/last-chat.json（agent 记录的最近会话）
 *
 * 用法：
 *   node scripts/feishu-notify.mjs "文本"
 *   node scripts/feishu-notify.mjs --check     # 只校验配置，不发送
 *
 * 退出码：0 成功；2 配置缺失；1 发送失败。部署脚本只记日志，不因通知失败回滚。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readAgentEnv() {
  const file = path.join(repoRoot, "agent", ".env");
  if (!existsSync(file)) return {};
  const values = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function resolveChatId() {
  if (process.env.FEISHU_NOTIFY_CHAT_ID) return process.env.FEISHU_NOTIFY_CHAT_ID;
  const file = path.join(repoRoot, "agent", "state", "last-chat.json");
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    return typeof data.chatId === "string" ? data.chatId : "";
  } catch {
    return "";
  }
}

const fileEnv = readAgentEnv();
const appId = process.env.FEISHU_APP_ID || fileEnv.FEISHU_APP_ID || "";
const appSecret = process.env.FEISHU_APP_SECRET || fileEnv.FEISHU_APP_SECRET || "";
const baseUrl = (process.env.FEISHU_BASE_URL || fileEnv.FEISHU_BASE_URL || "https://open.feishu.cn").replace(/\/+$/, "");
const chatId = resolveChatId();

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const text = args.filter((arg) => arg !== "--check").join(" ").trim();

function bail(code, message) {
  process.stderr.write(message + "\n");
  process.exit(code);
}

if (!appId || !appSecret) bail(2, "飞书通知跳过：缺少 FEISHU_APP_ID / FEISHU_APP_SECRET");
if (!chatId) bail(2, "飞书通知跳过：缺少 FEISHU_NOTIFY_CHAT_ID，且没有 agent/state/last-chat.json");

if (checkOnly) {
  console.log("feishu-notify 配置可用：app_id 与 chat_id 已解析");
  process.exit(0);
}
if (!text) bail(2, "飞书通知跳过：没有要发送的文本");

async function tenantToken() {
  const res = await fetch(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`获取 tenant_access_token 失败：${data.msg || res.status}`);
  }
  return data.tenant_access_token;
}

try {
  const token = await tenantToken();
  const res = await fetch(`${baseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text: text.slice(0, 4000) }),
    }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.code !== 0) throw new Error(`发送失败：${data.msg || res.status}`);
  console.log("feishu-notify 已发送");
} catch (error) {
  bail(1, "飞书通知失败：" + (error instanceof Error ? error.message : String(error)));
}
