"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, LoaderCircle, RotateCcw, X } from "lucide-react";
import {
  OPEN_PET_PICKER_EVENT,
  PET_POSITION_KEY,
  setPetPrefs,
  usePetPrefs,
} from "./pet-store";
import { PET_SIGNAL_EVENT, type PetSignalDetail } from "./pet-flow";
import {
  registerPet,
  type PetAvatarElement,
} from "../../../packages/pet-avatar/index.js";

/** public/pets/index.json 里的一项 */
type PetEntry = {
  id: string;
  displayName: string;
  description: string;
  src: string;
  thumb: string;
};

const PET_INDEX_URL = "/pets/index.json";

let petsPromise: Promise<PetEntry[]> | null = null;

function isPetEntry(value: unknown): value is PetEntry {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.displayName === "string" &&
    typeof record.src === "string" &&
    typeof record.thumb === "string"
  );
}

function loadPets(): Promise<PetEntry[]> {
  if (!petsPromise) {
    petsPromise = fetch(PET_INDEX_URL, { credentials: "same-origin" })
      .then((res) => {
        if (!res.ok) throw new Error("pets index " + res.status);
        return res.json() as Promise<{ pets?: unknown }>;
      })
      .then((data) => (Array.isArray(data.pets) ? data.pets.filter(isPetEntry) : []))
      .catch((error: unknown) => {
        petsPromise = null;
        throw error;
      });
  }
  return petsPromise;
}

function Switch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={onChange}
      className={
        "flex w-full items-center justify-between rounded-lg px-1 py-2 text-left text-[13px] transition-colors " +
        (disabled ? "opacity-40" : "hover:bg-tint/5")
      }
    >
      <span className="text-paper-dim">{label}</span>
      <span
        aria-hidden
        className={
          "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors " +
          (checked ? "bg-gold" : "bg-tint/15")
        }
      >
        <span
          className={
            "size-4 rounded-full bg-ink-950 shadow-sm transition-transform " +
            (checked ? "translate-x-4" : "translate-x-0")
          }
        />
      </span>
    </button>
  );
}

/**
 * 桌宠宿主层：只负责「加载运行时 + 创建 <pet-avatar> + 选择面板」。
 * 渲染逻辑全部在 public/pet-embed/pet.js，其他项目可以直接复用它。
 */
export function PetLayer() {
  const prefs = usePetPrefs();
  const [pets, setPets] = useState<PetEntry[] | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const petRef = useRef<PetAvatarElement | null>(null);

  const selected = pets?.find((pet) => pet.id === prefs.petId) ?? pets?.[0] ?? null;

  // 面板可以在任何页面通过全局事件打开（header 按钮 / 宠物工具条）
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_PET_PICKER_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_PET_PICKER_EVENT, onOpen);
  }, []);

  // 索引很小（~1KB），启动即取，保证默认宠物不用等面板打开
  useEffect(() => {
    let alive = true;
    loadPets()
      .then((list) => {
        if (!alive) return;
        if (!list.length) setError("没有可用的宠物资源");
        else setPets(list);
      })
      .catch(() => {
        if (alive) setError("宠物列表加载失败");
      });
    return () => {
      alive = false;
    };
  }, []);

  // 存量的 petId 失效时回落到第一只
  useEffect(() => {
    if (!pets?.length) return;
    if (!pets.some((pet) => pet.id === prefs.petId)) setPetPrefs({ petId: pets[0].id });
  }, [pets, prefs.petId]);

  useEffect(() => {
    if (!prefs.enabled) {
      petRef.current?.setAttribute("hidden", "");
      return;
    }
    if (!selected) return;

    let alive = true;
    registerPet()
      .then((api) => {
        if (!alive) return;
        if (!api) {
          setError("桌宠运行时未注册");
          return;
        }
        let element = petRef.current;
        if (!element) {
          element = document.createElement("pet-avatar") as PetAvatarElement;
          element.setAttribute("storage-key", PET_POSITION_KEY);
          element.setAttribute("size", "132");
          // 在 append 之前写好 src，避免连接时先按默认宠物加载一次
          element.setAttribute("src", selected.src);
          element.setAttribute("motion", prefs.motion);
          element.addEventListener("pet-request-picker", () => setOpen(true));
          element.addEventListener("pet-dismiss", () => {
            setOpen(false);
            setPetPrefs({ enabled: false });
          });
          element.addEventListener("pet-error", (event) => {
            const detail = (event as CustomEvent<{ error?: string }>).detail;
            setError(detail?.error ?? "桌宠加载失败");
          });
          document.body.appendChild(element);
          petRef.current = element;
          return;
        }
        element.removeAttribute("hidden");
        element.setAttribute("src", selected.src);
        element.setAttribute("motion", prefs.motion);
      })
      .catch(() => {
        if (alive) setError("桌宠运行时未注册");
      });

    return () => {
      alive = false;
    };
  }, [prefs.enabled, prefs.motion, selected]);

  // 卸载时把宿主元素一起带走，避免热更新后叠出多只
  useEffect(() => {
    return () => {
      petRef.current?.remove();
      petRef.current = null;
    };
  }, []);

  // 业务状态信号：页面只负责“发生了什么”，桌宠自己决定动作
  useEffect(() => {
    const onSignal = (event: Event) => {
      const detail = (event as CustomEvent<PetSignalDetail>).detail;
      const element = petRef.current;
      if (!element || !detail || !prefs.enabled) return;
      if (detail.state) element.setState(detail.state);
      if (detail.pulse) element.pulse(detail.pulse);
    };
    window.addEventListener(PET_SIGNAL_EVENT, onSignal);
    return () => window.removeEventListener(PET_SIGNAL_EVENT, onSignal);
  }, [prefs.enabled]);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, close]);

  return (
    <>
      {error ? (
        <div className="fixed bottom-5 right-5 z-[96] flex items-center gap-2 rounded-full border border-danger/40 bg-ink-900/95 px-4 py-2 text-xs text-danger shadow-xl">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="关闭提示" className="text-danger/70 hover:text-danger">
            <X className="size-3.5" strokeWidth={1.75} />
          </button>
        </div>
      ) : null}

      {open ? (
        <>
          <div className="fixed inset-0 z-[94]" onClick={close} aria-hidden />
          <section
            role="dialog"
            aria-modal="true"
            aria-label="桌宠设置"
            className="fixed bottom-5 right-5 z-[95] flex max-h-[min(78vh,560px)] w-[326px] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-2xl border border-tint/15 bg-ink-900/95 shadow-2xl backdrop-blur-xl"
          >
            <header className="flex items-center justify-between border-b border-tint/10 px-4 py-3">
              <div>
                <h2 className="font-display text-base font-semibold">桌宠</h2>
                <p className="mt-0.5 font-mono text-[10px] tracking-[0.18em] text-paper-faint">COMPANION</p>
              </div>
              <button
                type="button"
                onClick={close}
                aria-label="关闭"
                className="inline-flex size-7 items-center justify-center rounded-full text-paper-faint transition-colors hover:bg-tint/10 hover:text-paper"
              >
                <X className="size-4" strokeWidth={1.75} />
              </button>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {pets ? (
                <ul className="space-y-1">
                  {pets.map((pet) => {
                    const active = selected?.id === pet.id;
                    return (
                      <li key={pet.id}>
                        <button
                          type="button"
                          onClick={() => setPetPrefs({ petId: pet.id, enabled: true })}
                          aria-pressed={active}
                          className={
                            "flex w-full items-center gap-3 rounded-xl border p-2 text-left transition-colors " +
                            (active
                              ? "border-gold/45 bg-gold/10"
                              : "border-transparent hover:bg-tint/5")
                          }
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={pet.thumb}
                            alt=""
                            width={36}
                            height={39}
                            loading="lazy"
                            className="h-10 w-9 shrink-0 rounded-lg bg-tint/5 object-contain"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] text-paper">{pet.displayName}</span>
                            <span className="mt-0.5 block truncate text-[11px] text-paper-faint">
                              {pet.description}
                            </span>
                          </span>
                          {active ? <Check className="size-4 shrink-0 text-gold" strokeWidth={2} /> : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="flex items-center justify-center gap-2 py-10 text-xs text-paper-faint">
                  <LoaderCircle className="size-3.5 animate-spin" strokeWidth={1.75} />
                  正在载入…
                </div>
              )}
            </div>

            <footer className="space-y-0.5 border-t border-tint/10 px-3 py-2">
              <Switch
                label="显示桌宠"
                checked={prefs.enabled}
                onChange={() => setPetPrefs({ enabled: !prefs.enabled })}
              />
              <Switch
                label="减少动画"
                checked={prefs.motion === "still"}
                disabled={!prefs.enabled}
                onChange={() => setPetPrefs({ motion: prefs.motion === "still" ? "auto" : "still" })}
              />
              <button
                type="button"
                disabled={!prefs.enabled}
                onClick={() => petRef.current?.resetPosition()}
                className="flex w-full items-center justify-between rounded-lg px-1 py-2 text-[13px] text-paper-dim transition-colors hover:bg-tint/5 disabled:opacity-40"
              >
                <span>回到右下角</span>
                <RotateCcw className="size-3.5" strokeWidth={1.75} />
              </button>
              <p className="px-1 pb-1 pt-1 text-[10px] leading-relaxed text-paper-faint">
                拖动可移动，单击挥手，双击跳跃；右键也可唤出本面板。
              </p>
            </footer>
          </section>
        </>
      ) : null}
    </>
  );
}
