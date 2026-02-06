/**
 * @file Input.tsx - Input component
 * @description Generic input and textarea components supporting icons, password visibility toggle, and error states
 */

import { clsx } from 'clsx';
import { Eye, EyeOff } from 'lucide-react';
import type React from 'react';
import { forwardRef, useState } from 'react';

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** Input size */
  size?: 'sm' | 'md' | 'lg';
  /** Left icon */
  leftIcon?: React.ReactNode;
  /** Right icon */
  rightIcon?: React.ReactNode;
  /** Has error */
  error?: boolean;
  /** Error message */
  errorMessage?: string;
  /** Input label */
  label?: string;
  /** Helper text */
  helperText?: string;
}

/**
 * Input component - SciPen Studio unified input
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(
  (
    {
      className,
      size = 'md',
      type = 'text',
      leftIcon,
      rightIcon,
      error,
      errorMessage,
      label,
      helperText,
      disabled,
      ...props
    },
    ref
  ) => {
    const [showPassword, setShowPassword] = useState(false);
    const isPassword = type === 'password';
    const inputType = isPassword ? (showPassword ? 'text' : 'password') : type;

    const sizeStyles = {
      sm: 'h-8 text-xs px-2.5',
      md: 'h-9 text-sm px-3',
      lg: 'h-10 text-base px-4',
    };

    const iconSizes = {
      sm: 14,
      md: 16,
      lg: 18,
    };

    return (
      <div className="w-full">
        {label && (
          <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1.5">
            {label}
          </label>
        )}
        <div className="relative">
          {leftIcon && (
            <div
              className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] pointer-events-none"
              style={{ width: iconSizes[size], height: iconSizes[size] }}
            >
              {leftIcon}
            </div>
          )}
          <input
            ref={ref}
            type={inputType}
            disabled={disabled}
            className={clsx(
              'w-full rounded-lg border bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)]',
              'placeholder:text-[var(--color-text-muted)]',
              'focus:border-[var(--color-accent)] focus:shadow-[0_0_0_3px_var(--color-accent-muted)] focus:outline-none',
              'disabled:cursor-not-allowed disabled:opacity-50',
              'transition-colors duration-200',
              sizeStyles[size],
              leftIcon && 'pl-9',
              (rightIcon || isPassword) && 'pr-9',
              error
                ? 'border-[var(--color-error)] focus:border-[var(--color-error)] focus:shadow-[0_0_0_3px_var(--color-error-muted)]'
                : 'border-[var(--color-border)]',
              className
            )}
            {...props}
          />
          {isPassword && (
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
              tabIndex={-1}
            >
              {showPassword ? <EyeOff size={iconSizes[size]} /> : <Eye size={iconSizes[size]} />}
            </button>
          )}
          {rightIcon && !isPassword && (
            <div
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] pointer-events-none"
              style={{ width: iconSizes[size], height: iconSizes[size] }}
            >
              {rightIcon}
            </div>
          )}
        </div>
        {(errorMessage || helperText) && (
          <p
            className={clsx(
              'mt-1.5 text-xs',
              error ? 'text-[var(--color-error)]' : 'text-[var(--color-text-muted)]'
            )}
          >
            {errorMessage || helperText}
          </p>
        )}
      </div>
    );
  }
);

Input.displayName = 'Input';

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Textarea size */
  size?: 'sm' | 'md' | 'lg';
  /** Has error */
  error?: boolean;
  /** Error message */
  errorMessage?: string;
  /** Textarea label */
  label?: string;
  /** Helper text */
  helperText?: string;
  /** Auto resize height */
  autoResize?: boolean;
}

/**
 * Textarea component - SciPen Studio unified textarea
 */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  (
    {
      className,
      size = 'md',
      error,
      errorMessage,
      label,
      helperText,
      autoResize,
      disabled,
      onInput,
      ...props
    },
    ref
  ) => {
    const sizeStyles = {
      sm: 'text-xs px-2.5 py-1.5',
      md: 'text-sm px-3 py-2',
      lg: 'text-base px-4 py-3',
    };

    const handleInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
      if (autoResize) {
        const target = e.currentTarget;
        target.style.height = 'auto';
        target.style.height = `${target.scrollHeight}px`;
      }
      onInput?.(e);
    };

    return (
      <div className="w-full">
        {label && (
          <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1.5">
            {label}
          </label>
        )}
        <textarea
          ref={ref}
          disabled={disabled}
          onInput={handleInput}
          className={clsx(
            'w-full rounded-lg border bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)]',
            'placeholder:text-[var(--color-text-muted)]',
            'focus:border-[var(--color-accent)] focus:shadow-[0_0_0_3px_var(--color-accent-muted)] focus:outline-none',
            'disabled:cursor-not-allowed disabled:opacity-50',
            'transition-colors duration-200 resize-y min-h-[80px]',
            sizeStyles[size],
            error
              ? 'border-[var(--color-error)] focus:border-[var(--color-error)] focus:shadow-[0_0_0_3px_var(--color-error-muted)]'
              : 'border-[var(--color-border)]',
            autoResize && 'resize-none overflow-hidden',
            className
          )}
          {...props}
        />
        {(errorMessage || helperText) && (
          <p
            className={clsx(
              'mt-1.5 text-xs',
              error ? 'text-[var(--color-error)]' : 'text-[var(--color-text-muted)]'
            )}
          >
            {errorMessage || helperText}
          </p>
        )}
      </div>
    );
  }
);

Textarea.displayName = 'Textarea';

export default Input;
