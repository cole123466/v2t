import type { TaskDetailLevel } from "@/server/tasks";

/** 文章深度选项：导入页（选默认值）与任务页文章面板（仍可改）共用同一套文案 */
export const DETAIL_OPTIONS: Array<{ value: TaskDetailLevel; label: string; hint: string }> = [
  { value: "concise", label: "速览", hint: "800 字内，只留核心" },
  { value: "standard", label: "标准", hint: "信息完整而克制" },
  { value: "detailed", label: "深入", hint: "展开推导与细节" },
];
