import type { SQLInputValue } from "node:sqlite";

/**
 * node:sqlite 的类型要求参数是 SQLInputValue 记录，业务对象（Task/Generation）
 * 结构上兼容但缺少索引签名。集中在这里断言，避免每个调用点重复 as。
 */
export function bind<T extends object>(params: T): Record<string, SQLInputValue> {
  return params as unknown as Record<string, SQLInputValue>;
}

/** 查询结果按行类型断言（SQLite 返回 Record<string, SQLOutputValue>） */
export function rows<T>(result: unknown[]): T[] {
  return result as unknown as T[];
}

/** 单行查询结果断言 */
export function row<T>(result: unknown): T | undefined {
  return (result ?? undefined) as T | undefined;
}
