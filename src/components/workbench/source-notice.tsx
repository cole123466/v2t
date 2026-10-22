import { Info } from "lucide-react";

/** 来源降级提示：B 站风控等场景下，任务仍可继续但清晰度/字幕可能受影响 */
export function SourceNotice({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <div className="mt-4 flex items-start gap-2 rounded-xl border border-gold/25 bg-gold/[0.06] px-4 py-3 text-xs leading-relaxed text-gold/90">
      <Info className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.5} />
      <span>{text}</span>
    </div>
  );
}
