/** 预设文案模板的元信息——客户端 chips 与服务端 PRESET_TEMPLATES 的唯一来源 */
export const TEMPLATE_META = [
  { id: "refine", label: "全文精炼" },
  { id: "xhs", label: "小红书笔记" },
  { id: "article", label: "公众号长文" },
  { id: "brief", label: "三句话速览" },
] as const;

export type TemplateId = (typeof TEMPLATE_META)[number]["id"];
