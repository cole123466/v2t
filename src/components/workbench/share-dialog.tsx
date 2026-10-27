"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, ExternalLink, Loader, X } from "lucide-react";

/**
 * 分享对话框（11 号票）：原生 <dialog>。
 * 文案即契约：「追问不会公开」「取消后原链接失效；重新分享会生成新链接」。
 * 后端只返回相对路径 /s/{token}，展示时补全为绝对地址。
 */

interface ShareInfo {
  share: { id: string; token: string; createdAt: string } | null;
  url?: string;
}

export function ShareDialog({
  taskId,
  articleId,
  onClose,
}: {
  taskId: string;
  articleId: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [share, setShare] = useState<ShareInfo["share"]>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
  }, []);

  const absolute = (path: string) => new URL(path, location.origin).href;

  const load = () =>
    fetch(`/api/tasks/${taskId}/articles/${articleId}/share`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<ShareInfo>) : null))
      .then((data) => setShare(data?.share ?? null))
      .finally(() => setLoading(false));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, articleId]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/tasks/${taskId}/articles/${articleId}/share`, {
        method: "PUT",
      });
      const data = (await res.json().catch(() => null)) as (ShareInfo & { error?: string }) | null;
      if (!res.ok || !data?.share) {
        setError(data?.error ?? `创建失败（${res.status}）`);
        return;
      }
      setShare(data.share);
      void copy(data.url ?? `/s/${data.share.token}`);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/tasks/${taskId}/articles/${articleId}/share`, {
        method: "DELETE",
      });
      if (!res.ok) {
        setError(`取消失败（${res.status}）`);
        return;
      }
      setShare(null);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const copy = async (path: string) => {
    const url = absolute(path);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // 剪贴板不可用：退化为手动选中输入框
      const input = ref.current?.querySelector<HTMLInputElement>("input[readonly]");
      input?.focus();
      input?.select();
    }
  };

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="glass w-[30rem] max-w-[calc(100vw-2rem)] rounded-2xl p-5 text-paper backdrop:bg-black/50"
    >
      <div className="flex items-center justify-between">
        <p className="font-mono text-[10px] tracking-widest text-paper-faint">分享这篇图文</p>
        <button
          type="button"
          onClick={onClose}
          className="text-paper-faint transition-colors hover:text-paper"
          aria-label="关闭"
        >
          <X className="size-4" strokeWidth={1.5} />
        </button>
      </div>

      {loading ? (
        <div className="flex h-32 items-center justify-center">
          <Loader className="size-5 animate-spin text-paper-faint" strokeWidth={1.5} />
        </div>
      ) : share ? (
        <div className="mt-4 space-y-3">
          <p className="text-[11px] leading-relaxed text-paper-dim">
            获得链接的人可以查看这篇图文和处理过程。
            <span className="text-gold">追问不会公开</span>。
          </p>
          <div className="flex gap-2">
            <input
              readOnly
              value={share ? absolute(`/s/${share.token}`) : ""}
              onFocus={(e) => e.currentTarget.select()}
              className="min-w-0 flex-1 rounded-xl border border-tint/10 bg-ink-950/60 px-3 py-2 font-mono text-[11px] text-paper-dim outline-none"
            />
            <button
              type="button"
              onClick={() => void copy(`/s/${share.token}`)}
              className="inline-flex shrink-0 items-center gap-1 rounded-xl border border-gold/40 bg-gold/10 px-3 py-2 font-mono text-[10px] text-gold transition-colors hover:bg-gold/20"
            >
              {copied ? <Check className="size-3" strokeWidth={1.5} /> : <Copy className="size-3" strokeWidth={1.5} />}
              {copied ? "已复制" : "复制"}
            </button>
            <a
              href={`/s/${share.token}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex shrink-0 items-center gap-1 rounded-xl border border-tint/10 px-3 py-2 font-mono text-[10px] text-paper-faint transition-colors hover:text-gold"
            >
              <ExternalLink className="size-3" strokeWidth={1.5} />
              打开
            </a>
          </div>
          <p className="text-[11px] leading-relaxed text-paper-faint">
            取消后原链接失效；重新分享会生成新链接。
          </p>
          <button
            type="button"
            onClick={() => void revoke()}
            disabled={busy}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-danger/30 bg-danger/5 px-3 py-2 font-mono text-[10px] tracking-wider text-danger/80 transition-colors hover:bg-danger/15 disabled:opacity-50"
          >
            <X className="size-3" strokeWidth={1.5} />
            取消分享
          </button>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <p className="text-[11px] leading-relaxed text-paper-dim">
            创建一个只读链接：获得链接的人可以查看这篇图文和处理过程。
            <span className="text-gold">追问不会公开</span>。
          </p>
          <button
            type="button"
            onClick={() => void create()}
            disabled={busy}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-gold/40 bg-gold/10 px-3 py-2 font-mono text-[11px] tracking-wider text-gold transition-colors hover:bg-gold/20 disabled:opacity-50"
          >
            {busy ? <Loader className="size-3.5 animate-spin" strokeWidth={1.5} /> : null}
            创建分享链接
          </button>
        </div>
      )}

      {error ? (
        <p className="mt-3 break-words rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-[11px] leading-relaxed text-danger/90">
          {error}
        </p>
      ) : null}
    </dialog>
  );
}
