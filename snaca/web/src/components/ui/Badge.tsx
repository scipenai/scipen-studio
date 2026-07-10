import { clsx } from "clsx";
import type { ReactNode } from "react";

type Tone = "neutral" | "success" | "danger" | "warning" | "info";

const toneClass: Record<Tone, string> = {
  neutral:
    "bg-ink-100 text-ink-700 dark:bg-ink-800 dark:text-ink-200",
  success:
    "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  danger: "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300",
  warning:
    "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  info: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300",
};

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: Tone;
  children: ReactNode;
}) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium",
        toneClass[tone],
      )}
    >
      {children}
    </span>
  );
}
