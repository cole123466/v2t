"use client";

import { useSyncExternalStore } from "react";

/** 桌宠动效偏好：auto 跟随系统 reduced-motion，still 强制静止 */
export type PetMotion = "auto" | "still";

export type PetPrefs = {
  /** 是否显示桌宠 */
  enabled: boolean;
  /** 当前宠物 id，对应 public/pets/index.json */
  petId: string;
  motion: PetMotion;
};

/** 偏好存储键；位置由 <pet-avatar storage-key> 单独存 v2t-pet:pos */
export const PET_PREFS_STORAGE_KEY = "v2t-pet-prefs";

/** 传给 <pet-avatar> 的 storage-key，位置存在 v2t-pet:pos */
export const PET_POSITION_KEY = "v2t-pet";

export const DEFAULT_PET_PREFS: PetPrefs = {
  enabled: true,
  petId: "saber",
  motion: "auto",
};

function parsePrefs(raw: string | null): PetPrefs {
  if (!raw) return DEFAULT_PET_PREFS;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return DEFAULT_PET_PREFS;
    const record = value as Record<string, unknown>;
    return {
      enabled: typeof record.enabled === "boolean" ? record.enabled : DEFAULT_PET_PREFS.enabled,
      petId: typeof record.petId === "string" && record.petId ? record.petId : DEFAULT_PET_PREFS.petId,
      motion: record.motion === "still" ? "still" : "auto",
    };
  } catch {
    return DEFAULT_PET_PREFS;
  }
}

let snapshot: PetPrefs = DEFAULT_PET_PREFS;
let hydrated = false;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function readFromStorage() {
  try {
    snapshot = parsePrefs(localStorage.getItem(PET_PREFS_STORAGE_KEY));
  } catch {
    snapshot = DEFAULT_PET_PREFS;
  }
}

function getSnapshot(): PetPrefs {
  if (!hydrated && typeof window !== "undefined") {
    hydrated = true;
    readFromStorage();
  }
  return snapshot;
}

/** 服务端固定使用默认值，hydration 后 useSyncExternalStore 会自动对齐真实偏好 */
function getServerSnapshot(): PetPrefs {
  return DEFAULT_PET_PREFS;
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== PET_PREFS_STORAGE_KEY) return;
    readFromStorage();
    emit();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function setPetPrefs(patch: Partial<PetPrefs>) {
  const current = getSnapshot();
  const next: PetPrefs = {
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
    petId: typeof patch.petId === "string" && patch.petId ? patch.petId : current.petId,
    motion: patch.motion === "still" ? "still" : patch.motion === "auto" ? "auto" : current.motion,
  };
  if (next.enabled === current.enabled && next.petId === current.petId && next.motion === current.motion) return;
  snapshot = next;
  try {
    localStorage.setItem(PET_PREFS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 隐私模式不可写时本次会话内仍然生效
  }
  emit();
}

export function usePetPrefs(): PetPrefs {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** 打开桌宠选择面板的全局事件（header 按钮与宠物自身工具条都会触发） */
export const OPEN_PET_PICKER_EVENT = "v2t:open-pet-picker";

export function openPetPicker() {
  window.dispatchEvent(new Event(OPEN_PET_PICKER_EVENT));
}
