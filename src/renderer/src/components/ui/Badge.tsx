/**
 * @file Badge.tsx - Badge component
 * @description Small badge component for displaying status, labels, or counts
 */

import { clsx } from 'clsx';
import type React from 'react';
import { forwardRef } from 'react';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Badge variant */
  variant?: 'default' | 'primary' | 'secondary' | 'success' | 'warning' | 'error' | 'ai';
  /** Badge size */
  size?: 'sm' | 'md' | 'lg';
  /** Left icon */
  icon?: React.ReactNode;
  /** Dot style (no text) */
  dot?: boolean;
}

/**
 * Badge component - SciPen Studio unified badge
 *
 * Variants:
 * - default: Default gray
 * - primary: Primary color (Sky)
 * - secondary: Secondary color
 * - success: Success state (Emerald)
 * - warning: Warning state (Amber)
 * - error: Error state (Rose)
 * - ai: AI feature (Violet)
 */
export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant = 'default', size = 'md', icon, dot, children, ...props }, ref) => {
    const sizeStyles = {
      sm: 'px-1.5 py-0.5 text-[10px]',
      md: 'px-2 py-0.5 text-xs',
      lg: 'px-2.5 py-1 text-sm',
    };

    const dotSizes = {
      sm: 'w-1.5 h-1.5',
      md: 'w-2 h-2',
      lg: 'w-2.5 h-2.5',
    };

    const variantStyles = {
      default: 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]',
      primary: 'bg-[var(--color-accent-muted)] text-[var(--color-accent)]',
      secondary: 'bg-[var(--color-bg-hover)] text-[var(--color-text-primary)]',
      success: 'bg-[var(--color-success-muted)] text-[var(--color-success)]',
      warning: 'bg-[var(--color-warning-muted)] text-[var(--color-warning)]',
      error: 'bg-[var(--color-error-muted)] text-[var(--color-error)]',
      ai: 'bg-[var(--color-info-muted)] text-[var(--color-info)]',
    };

    const dotColorStyles = {
      default: 'bg-[var(--color-text-muted)]',
      primary: 'bg-[var(--color-accent)]',
      secondary: 'bg-[var(--color-text-secondary)]',
      success: 'bg-[var(--color-success)]',
      warning: 'bg-[var(--color-warning)]',
      error: 'bg-[var(--color-error)]',
      ai: 'bg-[var(--color-info)]',
    };

    if (dot) {
      return (
        <span
          ref={ref}
          className={clsx(
            'inline-block rounded-full',
            dotSizes[size],
            dotColorStyles[variant],
            className
          )}
          {...props}
        />
      );
    }

    return (
      <span
        ref={ref}
        className={clsx(
          'inline-flex items-center gap-1 rounded-full font-medium',
          sizeStyles[size],
          variantStyles[variant],
          className
        )}
        {...props}
      >
        {icon && <span className="flex-shrink-0">{icon}</span>}
        {children}
      </span>
    );
  }
);

Badge.displayName = 'Badge';

export default Badge;
