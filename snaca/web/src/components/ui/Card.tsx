import { clsx } from "clsx";
import type { HTMLAttributes, ReactNode } from "react";

type CardProps = HTMLAttributes<HTMLDivElement> & {
  title?: ReactNode;
  description?: ReactNode;
};

export function Card({
  title,
  description,
  className,
  children,
  ...rest
}: CardProps) {
  return (
    <section
      {...rest}
      className={clsx(
        "rounded-xl border border-ink-200/70 bg-white shadow-sm dark:border-ink-800 dark:bg-ink-900",
        className,
      )}
    >
      {(title || description) && (
        <header className="border-b border-ink-200/70 px-5 py-3 dark:border-ink-800">
          {title && (
            <h2 className="text-base font-semibold text-ink-900 dark:text-ink-50">
              {title}
            </h2>
          )}
          {description && (
            <p className="mt-1 text-xs text-ink-500 dark:text-ink-400">
              {description}
            </p>
          )}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}
