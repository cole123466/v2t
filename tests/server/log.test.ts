import { afterEach, describe, expect, it } from "vitest";
import { errorDiagnosticFields, errorFields, formatLogLine } from "@/server/log";

const originalStack = process.env.LOG_STACK;

afterEach(() => {
  if (originalStack === undefined) delete process.env.LOG_STACK;
  else process.env.LOG_STACK = originalStack;
});

describe("日志格式", () => {
  it("固定时钟下输出 logfmt 单行", () => {
    expect(
      formatLogLine(
        "info",
        "task ready",
        { task_id: "abc", duration_ms: 12, ok: true },
        new Date("2026-10-22T03:00:00.000Z"),
      ),
    ).toBe(
      '2026-10-22T03:00:00.000Z level=INFO msg="task ready" task_id=abc duration_ms=12 ok=true',
    );
  });

  it("含空格或引号的值加引号，undefined 字段跳过", () => {
    expect(
      formatLogLine(
        "warn",
        "model response empty",
        { operation: "article.section", error: 'bad "json"', missing: undefined },
        new Date("2026-10-22T03:00:00.000Z"),
      ),
    ).toContain('msg="model response empty" operation=article.section error="bad \\"json\\""');
  });

  it("错误对象默认只取 message", () => {
    expect(errorFields(new Error("boom"))).toEqual({ error: "boom" });
    expect(errorFields("plain")).toEqual({ error: "plain" });
  });

  it("fetch 失败时把 cause 链上的真实原因一起记下来", () => {
    const cause = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    const wrapped = Object.assign(new TypeError("fetch failed"), { cause });
    expect(errorFields(wrapped)).toEqual({
      error: "fetch failed",
      cause: "ECONNRESET: read ECONNRESET",
    });
    expect(errorFields(Object.assign(new TypeError("fetch failed"), { cause: "timeout" }))).toEqual({
      error: "fetch failed",
      cause: "timeout",
    });
  });

  it("LOG_STACK=1 时附带堆栈", () => {
    process.env.LOG_STACK = "1";
    const fields = errorFields(new Error("boom"));
    expect(fields.error).toBe("boom");
    expect(String(fields.stack)).toContain("boom");
  });
});

describe("上传中断诊断字段", () => {
  it("记录顶层 name/code/message（pipeline 断连错误 code 在顶层、无 cause）", () => {
    // 复现 harness 实测：name=Error, code=ECONNRESET, message=aborted, 无 cause
    const err = Object.assign(new Error("aborted"), { code: "ECONNRESET" });
    expect(errorDiagnosticFields(err)).toEqual({
      error: "aborted",
      error_name: "Error",
      error_code: "ECONNRESET",
    });
  });

  it("cause 链仍保留，顶层 name/code 一并记下", () => {
    const cause = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    const wrapped = Object.assign(new TypeError("fetch failed"), { cause, code: "UND_ERR" });
    expect(errorDiagnosticFields(wrapped)).toEqual({
      error: "fetch failed",
      error_name: "TypeError",
      error_code: "UND_ERR",
      cause: "ECONNRESET: read ECONNRESET",
    });
  });

  it("非 Error 输入安全降级，不产生 name/code", () => {
    expect(errorDiagnosticFields("plain string")).toEqual({ error: "plain string" });
    expect(errorDiagnosticFields(null)).toEqual({ error: "null" });
  });

  it("无 code 的错误不写空字段", () => {
    expect(errorDiagnosticFields(new Error("boom"))).toEqual({
      error: "boom",
      error_name: "Error",
    });
  });
});
