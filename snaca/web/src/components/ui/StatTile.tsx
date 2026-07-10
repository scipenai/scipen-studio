import type { ReactNode } from "react";

export function StatTile({
  label,
  value,
  hint,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-ink-200/70 bg-white p-4 shadow-sm dark:border-ink-800 dark:bg-ink-900">
      <div className="text-xs font-medium uppercase tracking-wide text-ink-500 dark:text-ink-400">
        {label}
      </div>
      <div className="mt-1 text-xl font-semibold text-ink-900 dark:text-ink-50">
        {value}
      </div>
      {hint && (
        <div className="mt-1 text-xs text-ink-500 dark:text-ink-400">{hint}</div>
      )}
    </div>
  );
}
