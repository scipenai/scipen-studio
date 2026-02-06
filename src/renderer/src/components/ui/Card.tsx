/**
 * @file Card.tsx - Card component
 * @description Content container card supporting interaction, borders, and selected states
 */

import { clsx } from 'clsx';
import type React from 'react';
import { forwardRef } from 'react';

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Card variant */
  variant?: 'default' | 'interactive' | 'bordered' | 'ghost';
  /** Padding size */
  padding?: 'none' | 'sm' | 'md' | 'lg';
  /** Selected state (for selectable cards) */
  selected?: boolean;
  /** Whether disabled */
  disabled?: boolean;
}

/**
 * Card component - SciPen Studio unified card
 *
 * Variants:
 * - default: Standard card (with background and shadow)
 * - interactive: Interactive card (hover effects)
 * - bordered: Border only card
 * - ghost: Transparent background card
 */
export const Card = forwardRef<HTMLDivElement, CardProps>(
  (
    { className, variant = 'default', padding = 'md', selected, disabled, children, ...props },
    ref
  ) => {
    const paddingStyles = {
      none: '',
      sm: 'p-3',
      md: 'p-4',
      lg: 'p-6',
    };

    const variantStyles = {
      default: `
        bg-[var(--color-bg-elevated)] 
        border border-[var(--color-border)] 
        shadow-[var(--shadow-md)]
      `,
      interactive: `
        bg-[var(--color-bg-elevated)] 
        border border-[var(--color-border)] 
        shadow-[var(--shadow-md)]
        cursor-pointer transition-all duration-200
        hover:border-[var(--color-border-strong)] 
        hover:shadow-[var(--shadow-lg),var(--shadow-glow)]
        hover:-translate-y-0.5
        active:translate-y-0
      `,
      bordered: `
        bg-transparent 
        border border-[var(--color-border)]
      `,
      ghost: `
        bg-transparent
      `,
    };

    return (
      <div
        ref={ref}
        className={clsx(
          'rounded-xl',
          variantStyles[variant],
          paddingStyles[padding],
          selected && 'border-[var(--color-accent)] ring-2 ring-[var(--color-accent-muted)]',
          disabled && 'opacity-50 pointer-events-none',
          className
        )}
        {...props}
      >
        {children}
      </div>
    );
  }
);

Card.displayName = 'Card';

export interface CardHeaderProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  /** Card title */
  title?: React.ReactNode;
  /** Subtitle */
  subtitle?: React.ReactNode;
  /** Right action area */
  action?: React.ReactNode;
  /** Left icon */
  icon?: React.ReactNode;
}

/**
 * CardHeader component - card header section
 */
export const CardHeader = forwardRef<HTMLDivElement, CardHeaderProps>(
  ({ className, title, subtitle, action, icon, children, ...props }, ref) => {
    if (children) {
      return (
        <div ref={ref} className={clsx('mb-4', className)} {...props}>
          {children}
        </div>
      );
    }

    return (
      <div ref={ref} className={clsx('flex items-start gap-3 mb-4', className)} {...props}>
        {icon && <div className="flex-shrink-0 text-[var(--color-accent)]">{icon}</div>}
        <div className="flex-1 min-w-0">
          {title && (
            <h3 className="text-base font-semibold text-[var(--color-text-primary)] truncate">
              {title}
            </h3>
          )}
          {subtitle && (
            <p className="text-sm text-[var(--color-text-secondary)] mt-0.5 truncate">{subtitle}</p>
          )}
        </div>
        {action && <div className="flex-shrink-0">{action}</div>}
      </div>
    );
  }
);

CardHeader.displayName = 'CardHeader';

export interface CardContentProps extends React.HTMLAttributes<HTMLDivElement> {}

/**
 * CardContent component - card content area
 */
export const CardContent = forwardRef<HTMLDivElement, CardContentProps>(
  ({ className, children, ...props }, ref) => {
    return (
      <div ref={ref} className={clsx('text-[var(--color-text-secondary)]', className)} {...props}>
        {children}
      </div>
    );
  }
);

CardContent.displayName = 'CardContent';

export interface CardFooterProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Add top divider line */
  divider?: boolean;
}

/**
 * CardFooter component - card footer section
 */
export const CardFooter = forwardRef<HTMLDivElement, CardFooterProps>(
  ({ className, divider, children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={clsx(
          'mt-4 flex items-center gap-3',
          divider && 'pt-4 border-t border-[var(--color-border)]',
          className
        )}
        {...props}
      >
        {children}
      </div>
    );
  }
);

CardFooter.displayName = 'CardFooter';

export default Card;
