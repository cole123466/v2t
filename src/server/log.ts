/**
 * 结构化应用日志：logfmt 单行输出到 stdout/stderr，对齐参考工程的 slog 用法。
 * - 只写事件与上下文字段，不写提示词、转写稿或 API Key
 * - LOG_LEVEL=debug|info|warn|error 控制级别，默认 info；测试环境默认静默
 * - 生产部署交给 systemd/journald 或终端重定向收集，应用自身不做文件轮转
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, string | number | boolean | null | undefined>;

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function threshold(): number {
  const configured = process.env.LOG_LEVEL?.toLowerCase();
  if (configured && Object.prototype.hasOwnProperty.call(LEVELS, configured)) {
    return LEVELS[configured as LogLevel];
  }
  // 测试默认静默；显式设置 LOG_LEVEL 时仍按设置输出
  if (process.env.NODE_ENV === "test") return Number.POSITIVE_INFINITY;
  return LEVELS.info;
}

function formatValue(value: Exclude<LogFields[string], undefined>): string {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return /^[A-Za-z0-9_./:@+-]+$/.test(value) ? value : JSON.stringify(value);
}

/** 纯函数：便于单测在固定时钟下断言格式 */
export function formatLogLine(
  level: LogLevel,
  message: string,
  fields: LogFields = {},
  now: Date = new Date(),
): string {
  const parts = [now.toISOString(), `level=${level.toUpperCase()}`, `msg=${formatValue(message)}`];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    parts.push(`${key}=${formatValue(value)}`);
  }
  return parts.join(" ");
}

function write(level: LogLevel, message: string, fields: LogFields): void {
  if (LEVELS[level] < threshold()) return;
  const line = formatLogLine(level, message, fields) + "\n";
  if (level === "error" || level === "warn") process.stderr.write(line);
  else process.stdout.write(line);
}

export function logDebug(message: string, fields: LogFields = {}): void {
  write("debug", message, fields);
}

export function logInfo(message: string, fields: LogFields = {}): void {
  write("info", message, fields);
}

export function logWarn(message: string, fields: LogFields = {}): void {
  write("warn", message, fields);
}

export function logError(message: string, fields: LogFields = {}): void {
  write("error", message, fields);
}

/** 错误对象转日志字段：默认只留 message；排查堆栈时设 LOG_STACK=1 */
export function errorFields(error: unknown): LogFields {
  const message = error instanceof Error ? error.message : String(error);
  if (process.env.LOG_STACK === "1" && error instanceof Error && error.stack) {
    return { error: message, stack: error.stack };
  }
  return { error: message };
}

export function elapsedMs(startedAt: number): number {
  return Date.now() - startedAt;
}
