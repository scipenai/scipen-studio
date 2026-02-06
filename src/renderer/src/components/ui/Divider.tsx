/**
 * @file Divider.tsx - Divider component
 * @description Horizontal or vertical divider supporting text labels
 */

import { clsx } from 'clsx';
import type React from 'react';
import { forwardRef } from 'react';

export interface DividerProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Orientation */
  orientation?: 'horizontal' | 'vertical';
  /** Line variant */
  variant?: 'solid' | 'dashed' | 'dotted';
  /** Label (for dividers with text) */
  label?: React.ReactNode;
  /** Label position */
  labelPosition?: 'left' | 'center' | 'right';
}

/**
 * Divider component - SciPen Studio unified divider
 */
export const Divider = forwardRef<HTMLDivElement, DividerProps>(
  (
    {
      className,
      orientation = 'horizontal',
      variant = 'solid',
      label,
      labelPosition = 'center',
      ...props
    },
    ref
  ) => {
    const borderStyles = {
      solid: 'border-solid',
      dashed: 'border-dashed',
      dotted: 'border-dotted',
    };

    const isHorizontal = orientation === 'horizontal';

    if (label && isHorizontal) {
      return (
        <div ref={ref} className={clsx('flex items-center gap-3 my-4', className)} {...props}>
          <div
            className={clsx(
              'h-px bg-[var(--color-border)]',
              labelPosition === 'left' ? 'w-8' : 'flex-1',
              borderStyles[variant]
            )}
          />
          <span className="text-xs text-[var(--color-text-muted)] whitespace-nowrap">{label}</span>
          <div
            className={clsx(
              'h-px bg-[var(--color-border)]',
              labelPosition === 'right' ? 'w-8' : 'flex-1',
              borderStyles[variant]
            )}
          />
        </div>
      );
    }

    return (
      <div
        ref={ref}
        className={clsx(
          isHorizontal ? 'w-full h-px my-3' : 'h-full w-px mx-3',
          'bg-[var(--color-border)]',
          borderStyles[variant],
          className
        )}
        {...props}
      />
    );
  }
);

Divider.displayName = 'Divider';

export default Divider;
