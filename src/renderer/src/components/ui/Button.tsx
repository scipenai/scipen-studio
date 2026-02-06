/**
 * @file Button.tsx - Button component
 * @description Generic button component supporting multiple variants, sizes, and loading states
 */

import { clsx } from 'clsx';
import type React from 'react';
import { forwardRef } from 'react';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Button variant */
  variant?: 'primary' | 'secondary' | 'ghost' | 'destructive' | 'magic' | 'link';
  /** Button size */
  size?: 'sm' | 'md' | 'lg' | 'icon';
  /** Loading state */
  loading?: boolean;
  /** Left icon */
  leftIcon?: React.ReactNode;
  /** Right icon */
  rightIcon?: React.ReactNode;
  /** Full width */
  fullWidth?: boolean;
}

/**
 * Button component - SciPen Studio unified button
 *
 * Variants:
 * - primary: Primary action (Sky -> Violet gradient)
 * - secondary: Secondary action (bordered)
 * - ghost: Ghost button (transparent)
 * - destructive: Dangerous action (red)
 * - magic: AI feature (Violet gradient)
 * - link: Link style
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant = 'primary',
      size = 'md',
      loading = false,
      disabled,
      leftIcon,
      rightIcon,
      fullWidth,
      children,
      ...props
    },
    ref
  ) => {
    const baseStyles = `
      inline-flex items-center justify-center gap-2 
      rounded-lg font-medium cursor-pointer
      transition-all duration-200
      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2
      disabled:pointer-events-none disabled:opacity-50
    `;

    const variantStyles = {
      primary: `
        text-white
        shadow-[var(--shadow-md),var(--shadow-glow)]
        hover:brightness-110
      `,
      secondary: `
        bg-[var(--color-bg-elevated)] text-[var(--color-text-primary)]
        border border-[var(--color-border)]
        hover:bg-[var(--color-bg-hover)] hover:border-[var(--color-border-strong)]
      `,
      ghost: `
        bg-transparent text-[var(--color-text-secondary)]
        hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]
      `,
      destructive: `
        bg-[var(--color-error-muted)] text-[var(--color-error)]
        border border-[rgba(244,63,94,0.3)]
        hover:bg-[rgba(244,63,94,0.25)]
      `,
      magic: `
        text-white
        shadow-[var(--shadow-md),0_0_20px_rgba(139,92,246,0.2)]
        hover:brightness-110
      `,
      link: `
        bg-transparent text-[var(--color-accent)] underline-offset-4
        hover:underline
      `,
    };

    const sizeStyles = {
      sm: 'h-8 px-3 text-xs',
      md: 'h-9 px-4 text-sm',
      lg: 'h-10 px-6 text-base',
      icon: 'h-9 w-9 p-0',
    };

    const gradientStyle: React.CSSProperties = {};
    if (variant === 'primary') {
      gradientStyle.background = 'var(--gradient-accent)';
    } else if (variant === 'magic') {
      gradientStyle.background =
        'linear-gradient(135deg, var(--violet-500) 0%, var(--violet-600) 100%)';
    }

    return (
      <button
        ref={ref}
        className={clsx(
          baseStyles,
          variantStyles[variant],
          sizeStyles[size],
          fullWidth && 'w-full',
          loading && 'cursor-wait',
          className
        )}
        style={gradientStyle}
        disabled={disabled || loading}
        {...props}
      >
        {loading ? (
          <LoadingSpinner size={size === 'sm' ? 14 : size === 'lg' ? 18 : 16} />
        ) : (
          leftIcon
        )}
        {children}
        {!loading && rightIcon}
      </button>
    );
  }
);

Button.displayName = 'Button';

const LoadingSpinner: React.FC<{ size?: number }> = ({ size = 16 }) => (
  <svg
    className="animate-spin"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
    <path
      className="opacity-75"
      fill="currentColor"
      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
    />
  </svg>
);

export default Button;
