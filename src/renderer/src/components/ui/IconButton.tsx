/**
 * @file IconButton.tsx - Icon button component
 * @description Icon-only button supporting tooltips and active states
 */

import { clsx } from 'clsx';
import type React from 'react';
import { forwardRef } from 'react';

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Button variant
   *  - default/ghost/solid/destructive:通用图标按钮(走 size + active/idle ternary)
   *  - rail:Sidebar 导航专用(44×44,rounded-2xl,active glow,hover 联动)
   */
  variant?: 'default' | 'ghost' | 'solid' | 'destructive' | 'rail';
  /** Button size(rail variant 忽略此 prop,固定 44×44) */
  size?: 'sm' | 'md' | 'lg';
  /** Active state */
  active?: boolean;
  /** Loading state */
  loading?: boolean;
  /** Tooltip text */
  tooltip?: string;
}

/**
 * IconButton component - SciPen Studio unified icon button
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  (
    {
      className,
      variant = 'default',
      size = 'md',
      active,
      loading,
      disabled,
      children,
      tooltip,
      ...props
    },
    ref
  ) => {
    const sizeStyles = {
      sm: 'w-7 h-7',
      md: 'w-8 h-8',
      lg: 'w-10 h-10',
    };

    const iconSizes = {
      sm: '[&>svg]:w-3.5 [&>svg]:h-3.5',
      md: '[&>svg]:w-4 [&>svg]:h-4',
      lg: '[&>svg]:w-5 [&>svg]:h-5',
    };

    const variantStyles = {
      default: `
        text-[var(--color-text-muted)]
        hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]
      `,
      ghost: `
        text-[var(--color-text-secondary)]
        hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]
      `,
      solid: `
        bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]
        border border-[var(--color-border)]
        hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]
      `,
      destructive: `
        text-[var(--color-text-muted)]
        hover:text-[var(--color-error)] hover:bg-[var(--color-error-muted)]
      `,
      // Rail variant: Sidebar 导航专用,自带 border 开关 + hover 联动 + accent-muted bg
      rail: `
        border-transparent
        bg-[color-mix(in_srgb,var(--color-bg-elevated)_88%,transparent)]
        text-[var(--color-text-muted)]
        hover:border-[var(--color-border-subtle)]
        hover:bg-[color-mix(in_srgb,var(--color-bg-primary)_92%,transparent)]
        hover:text-[var(--color-text-primary)]
      `,
    };

    const activeStyles = {
      default: 'text-[var(--color-accent)] bg-[var(--color-accent-muted)]',
      ghost: 'text-[var(--color-accent)] bg-[var(--color-accent-muted)]',
      solid:
        'text-[var(--color-accent)] bg-[var(--color-accent-muted)] border-[var(--color-accent)]',
      destructive: 'text-[var(--color-error)] bg-[var(--color-error-muted)]',
      // Rail active: accent glow + 24% 混合边框 + accent-muted bg
      rail: `
        border-[color-mix(in_srgb,var(--color-accent)_24%,transparent)]
        bg-[var(--color-accent-muted)]
        text-[var(--color-accent)]
        shadow-[0_10px_24px_color-mix(in_srgb,var(--color-accent)_14%,transparent)]
      `,
    };

    // Rail 走独立形状(44×44 + rounded-2xl + border 开关),其他 variant 走通用 size/iconSize 矩阵
    const isRail = variant === 'rail';
    const shapeStyles = isRail
      ? 'w-11 h-11 rounded-2xl border [&>svg]:w-[17px] [&>svg]:h-[17px]'
      : clsx('rounded-lg', sizeStyles[size], iconSizes[size]);

    return (
      <button
        ref={ref}
        type="button"
        disabled={disabled || loading}
        title={tooltip}
        className={clsx(
          'relative inline-flex items-center justify-center',
          'transition-all duration-200',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2',
          'disabled:pointer-events-none disabled:opacity-50',
          shapeStyles,
          active ? activeStyles[variant] : variantStyles[variant],
          loading && 'cursor-wait',
          className
        )}
        {...props}
      >
        {loading ? (
          <svg
            className="animate-spin"
            width={size === 'sm' ? 14 : size === 'lg' ? 20 : 16}
            height={size === 'sm' ? 14 : size === 'lg' ? 20 : 16}
            viewBox="0 0 24 24"
            fill="none"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
        ) : (
          children
        )}
      </button>
    );
  }
);

IconButton.displayName = 'IconButton';

export default IconButton;
