import { clsx } from "clsx";
import type { ReactNode, TdHTMLAttributes, ThHTMLAttributes } from "react";

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="-mx-2 overflow-x-auto">
      <table className="min-w-full divide-y divide-ink-200 text-sm dark:divide-ink-800">
        {children}
      </table>
    </div>
  );
}

export function Th({
  className,
  ...rest
}: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      {...rest}
      className={clsx(
        "px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-ink-500 dark:text-ink-400",
        className,
      )}
    />
  );
}

export function Td({
  className,
  ...rest
}: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td
      {...rest}
      className={clsx(
        "px-3 py-2 align-top text-ink-700 dark:text-ink-200",
        className,
      )}
    />
  );
}

export function Tr({
  className,
  ...rest
}: { className?: string; children: ReactNode }) {
  return (
    <tr
      {...rest}
      className={clsx(
        "border-b border-ink-100/70 last:border-0 hover:bg-ink-50 dark:border-ink-800 dark:hover:bg-ink-800/40",
        className,
      )}
    />
  );
}

export function EmptyRow({ colSpan, message }: { colSpan: number; message: string }) {
  return (
    <tr>
      <td
        colSpan={colSpan}
        className="px-3 py-8 text-center text-sm text-ink-400 dark:text-ink-500"
      >
        {message}
      </td>
    </tr>
  );
}
