import { clsx } from "clsx";
import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
};

const variantClass: Record<Variant, string> = {
  primary:
    "bg-indigo-600 text-white hover:bg-indigo-500 disabled:bg-indigo-400 focus:ring-indigo-500",
  secondary:
    "bg-ink-100 text-ink-900 hover:bg-ink-200 disabled:opacity-50 dark:bg-ink-800 dark:text-ink-100 dark:hover:bg-ink-700 focus:ring-ink-400",
  ghost:
    "text-ink-600 hover:bg-ink-100 disabled:opacity-50 dark:text-ink-300 dark:hover:bg-ink-800 focus:ring-ink-400",
  danger:
    "bg-rose-600 text-white hover:bg-rose-500 disabled:bg-rose-400 focus:ring-rose-500",
};

const sizeClass: Record<Size, string> = {
  sm: "px-2.5 py-1 text-xs",
  md: "px-3.5 py-1.5 text-sm",
};

export function Button({
  variant = "secondary",
  size = "md",
  className,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-md font-medium transition focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-offset-transparent disabled:cursor-not-allowed",
        variantClass[variant],
        sizeClass[size],
        className,
      )}
    />
  );
}
