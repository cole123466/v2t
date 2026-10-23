"use client";

import { Cat } from "lucide-react";
import { openPetPicker, usePetPrefs } from "./pet-store";

/** header 里的桌宠入口：打开选择面板，不再需要先找到宠物本体 */
export function PetToggle({ className = "" }: { className?: string }) {
  const prefs = usePetPrefs();
  return (
    <button
      type="button"
      onClick={openPetPicker}
      title="桌宠"
      aria-label="桌宠设置"
      aria-pressed={prefs.enabled}
      className={
        "relative inline-flex size-7 items-center justify-center rounded-full border border-tint/15 transition-colors " +
        (prefs.enabled ? "text-gold hover:bg-gold/10" : "text-paper-faint hover:text-paper") +
        (className ? " " + className : "")
      }
    >
      <Cat className="size-3.5" strokeWidth={1.75} />
      {prefs.enabled ? (
        <span aria-hidden className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-gold" />
      ) : null}
    </button>
  );
}
