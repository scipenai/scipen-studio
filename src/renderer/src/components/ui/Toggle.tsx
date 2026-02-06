/**
 * @file Toggle.tsx - Toggle component
 * @description Toggle switch and checkbox component supporting labels and descriptive text
 */

import { clsx } from 'clsx';
import type React from 'react';
import { forwardRef } from 'react';

export interface ToggleProps {
  /** Whether checked */
  checked?: boolean;
  /** Value change callback */
  onChange?: (checked: boolean) => void;
  /** Toggle size */
  size?: 'sm' | 'md' | 'lg';
  /** Whether disabled */
  disabled?: boolean;
  /** Label text */
  label?: string;
  /** Label position */
  labelPosition?: 'left' | 'right';
  /** Description text */
  description?: string;
  /** Custom class name */
  className?: string;
}

/**
 * Toggle component - SciPen Studio unified switch
 */
export const Toggle = forwardRef<HTMLButtonElement, ToggleProps>(
  (
    {
      checked = false,
      onChange,
      size = 'md',
      disabled,
      label,
      labelPosition = 'right',
      description,
      className,
    },
    ref
  ) => {
    const sizes = {
      sm: {
        track: 'w-8 h-4',
        thumb: 'w-3 h-3',
        translate: 'translate-x-4',
        offset: 'translate-x-0.5',
      },
      md: {
        track: 'w-10 h-5',
        thumb: 'w-4 h-4',
        translate: 'translate-x-5',
        offset: 'translate-x-0.5',
      },
      lg: {
        track: 'w-12 h-6',
        thumb: 'w-5 h-5',
        translate: 'translate-x-6',
        offset: 'translate-x-0.5',
      },
    };

    const handleClick = () => {
      if (!disabled) {
        onChange?.(!checked);
      }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleClick();
      }
    };

    const toggleSwitch = (
      <button
        ref={ref}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        className={clsx(
          'relative inline-flex items-center rounded-full transition-colors duration-200',
          'focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[var(--color-accent)]',
          'disabled:cursor-not-allowed disabled:opacity-50',
          sizes[size].track,
          checked
            ? 'bg-[var(--color-accent)]'
            : 'bg-[var(--color-bg-tertiary)] border border-[var(--color-border)]'
        )}
      >
        <span
          className={clsx(
            'inline-block rounded-full bg-white shadow-sm transition-transform duration-200',
            sizes[size].thumb,
            checked ? sizes[size].translate : sizes[size].offset
          )}
        />
      </button>
    );

    if (!label) {
      return <div className={className}>{toggleSwitch}</div>;
    }

    return (
      <div
        className={clsx(
          'flex items-start gap-3',
          labelPosition === 'left' && 'flex-row-reverse',
          disabled && 'opacity-50 cursor-not-allowed',
          className
        )}
      >
        {toggleSwitch}
        <div className="flex-1">
          <label
            className={clsx(
              'text-sm font-medium cursor-pointer',
              disabled ? 'text-[var(--color-text-disabled)]' : 'text-[var(--color-text-primary)]'
            )}
            onClick={handleClick}
          >
            {label}
          </label>
          {description && (
            <p className="text-xs text-[var(--color-text-muted)] mt-0.5">{description}</p>
          )}
        </div>
      </div>
    );
  }
);

Toggle.displayName = 'Toggle';

export interface CheckboxProps {
  /** Whether checked */
  checked?: boolean;
  /** Indeterminate state */
  indeterminate?: boolean;
  /** Value change callback */
  onChange?: (checked: boolean) => void;
  /** Checkbox size */
  size?: 'sm' | 'md' | 'lg';
  /** Whether disabled */
  disabled?: boolean;
  /** Label text */
  label?: string;
  /** Description text */
  description?: string;
  /** Custom class name */
  className?: string;
}

/**
 * Checkbox component - SciPen Studio unified checkbox
 */
export const Checkbox = forwardRef<HTMLButtonElement, CheckboxProps>(
  (
    {
      checked = false,
      indeterminate = false,
      onChange,
      size = 'md',
      disabled,
      label,
      description,
      className,
    },
    ref
  ) => {
    const sizes = {
      sm: 'w-4 h-4',
      md: 'w-5 h-5',
      lg: 'w-6 h-6',
    };

    const iconSizes = {
      sm: 12,
      md: 14,
      lg: 16,
    };

    const handleClick = () => {
      if (!disabled) {
        onChange?.(!checked);
      }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleClick();
      }
    };

    const checkbox = (
      <button
        ref={ref}
        type="button"
        role="checkbox"
        aria-checked={indeterminate ? 'mixed' : checked}
        disabled={disabled}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        className={clsx(
          'flex items-center justify-center rounded-md border transition-all duration-150',
          'focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[var(--color-accent)]',
          'disabled:cursor-not-allowed disabled:opacity-50',
          sizes[size],
          checked || indeterminate
            ? 'bg-[var(--color-accent)] border-[var(--color-accent)] text-white'
            : 'bg-[var(--color-bg-tertiary)] border-[var(--color-border)] hover:border-[var(--color-border-strong)]'
        )}
      >
        {checked && (
          <svg
            width={iconSizes[size]}
            height={iconSizes[size]}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        )}
        {indeterminate && !checked && (
          <svg
            width={iconSizes[size]}
            height={iconSizes[size]}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
          >
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        )}
      </button>
    );

    if (!label) {
      return <div className={className}>{checkbox}</div>;
    }

    return (
      <div
        className={clsx(
          'flex items-start gap-3',
          disabled && 'opacity-50 cursor-not-allowed',
          className
        )}
      >
        {checkbox}
        <div className="flex-1">
          <label
            className={clsx(
              'text-sm font-medium cursor-pointer',
              disabled ? 'text-[var(--color-text-disabled)]' : 'text-[var(--color-text-primary)]'
            )}
            onClick={handleClick}
          >
            {label}
          </label>
          {description && (
            <p className="text-xs text-[var(--color-text-muted)] mt-0.5">{description}</p>
          )}
        </div>
      </div>
    );
  }
);

Checkbox.displayName = 'Checkbox';

export default Toggle;
