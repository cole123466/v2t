/**
 * 浏览器这边的上传队列（纯函数，不碰 XHR）。
 *
 * 服务端队列只排「已经传完的文件」；用户在上传第一个文件时又选了第二个，
 * 第二个既不能丢，也不该同时往服务端灌两个大包（上传带宽与内存都吃不消）。
 * 所以页面按这里的顺序一个一个传：length 里最多 1 个 uploading，其余 waiting。
 */
export interface UploadItem {
  id: string;
  name: string;
  sizeBytes: number;
  pct: number;
  state: "waiting" | "uploading";
}

export interface NewUpload {
  id: string;
  name: string;
  sizeBytes: number;
}

/** 追加待传文件，统一从 0% 的 waiting 起步 */
export function addUploads(list: UploadItem[], files: NewUpload[]): UploadItem[] {
  return [
    ...list,
    ...files.map((file) => ({
      id: file.id,
      name: file.name,
      sizeBytes: file.sizeBytes,
      pct: 0,
      state: "waiting" as const,
    })),
  ];
}

/** 没有在传的文件时取下一个待传项；有在传的则返回 null（串行） */
export function startNext(list: UploadItem[]): { list: UploadItem[]; next: UploadItem | null } {
  if (list.some((item) => item.state === "uploading")) return { list, next: null };
  const next = list.find((item) => item.state === "waiting");
  if (!next) return { list, next: null };
  return {
    list: list.map((item) =>
      item.id === next.id ? { ...item, state: "uploading" as const, pct: 0 } : item,
    ),
    next,
  };
}

export function setUploadProgress(list: UploadItem[], id: string, pct: number): UploadItem[] {
  const clamped = Math.min(100, Math.max(0, Math.round(pct)));
  return list.map((item) => (item.id === id ? { ...item, pct: clamped } : item));
}

/** 传完（成功或失败）后出列，接着由 startNext 拉起下一个 */
export function removeUpload(list: UploadItem[], id: string): UploadItem[] {
  return list.filter((item) => item.id !== id);
}

export function uploadSummary(list: UploadItem[]): {
  active: UploadItem | null;
  waiting: UploadItem[];
} {
  return {
    active: list.find((item) => item.state === "uploading") ?? null,
    waiting: list.filter((item) => item.state === "waiting"),
  };
}
