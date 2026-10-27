"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { PetToggle } from "@/components/pet/pet-toggle";

const TABS = [
  { href: "/studio", label: "导入" },
  { href: "/studio/tasks", label: "任务列表" },
] as const;

/** /studio 下所有子页的共享外壳：标题 + 分区导航 + 全局开关 */
export function StudioShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <main className="mx-auto flex min-h-svh w-full max-w-5xl flex-col px-6 pb-16">
      <header className="flex flex-wrap items-center justify-between gap-4 py-6">
        <div>
          <h1 className="font-display text-3xl font-semibold">工作台</h1>
          <p className="mt-1 font-mono text-[11px] tracking-widest text-paper-faint">
            UPLOAD / EXTRACT / TRANSCRIBE
          </p>
        </div>
        <div className="flex items-center gap-4">
          <PetToggle />
          <ThemeToggle />
          <Link
            href="/"
            className="inline-flex items-center gap-2 font-mono text-xs tracking-widest text-paper-faint transition-colors hover:text-gold"
          >
            <ArrowLeft className="size-3.5" strokeWidth={1.5} />
            V2T
          </Link>
        </div>
      </header>

      <nav className="mb-6 flex gap-1 border-b border-tint/10">
        {TABS.map(({ href, label }) => {
          const active = href === "/studio" ? pathname === href : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={`-mb-px border-b px-4 py-2.5 font-mono text-[11px] tracking-widest transition-colors ${
                active
                  ? "border-gold text-gold"
                  : "border-transparent text-paper-faint hover:text-paper-dim"
              }`}
            >
              {label}
            </Link>
          );
        })}
      </nav>

      {children}
    </main>
  );
}
