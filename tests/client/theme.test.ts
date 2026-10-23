import { describe, expect, it } from "vitest";
import {
  DARK_CLASS,
  parseThemePreference,
  resolveTheme,
  serializeThemePreference,
  THEME_INIT_SCRIPT,
  THEME_STORAGE_KEY,
} from "@/lib/theme";

describe("主题偏好", () => {
  it("只接受 light / dark，其余一律回落到 system", () => {
    expect(parseThemePreference("light")).toBe("light");
    expect(parseThemePreference("dark")).toBe("dark");
    expect(parseThemePreference("system")).toBe("system");
    expect(parseThemePreference(null)).toBe("system");
    expect(parseThemePreference("sepia")).toBe("system");
  });

  it("system 按系统媒体查询折算，显式偏好不受系统影响", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("system 不落存储，显式偏好原样序列化", () => {
    expect(serializeThemePreference("system")).toBeNull();
    expect(serializeThemePreference("light")).toBe("light");
    expect(serializeThemePreference("dark")).toBe("dark");
  });

  it("首屏脚本使用与组件一致的存储键与类名", () => {
    expect(THEME_INIT_SCRIPT).toContain(JSON.stringify(THEME_STORAGE_KEY));
    expect(THEME_INIT_SCRIPT).toContain(JSON.stringify(DARK_CLASS));
    expect(THEME_INIT_SCRIPT).toContain("prefers-color-scheme: dark");
  });
});
