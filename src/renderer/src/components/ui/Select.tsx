/**
 * @file Select.tsx - Select component
 * @description Custom dropdown selector supporting icons and disabled options
 */

import { clsx } from 'clsx';
import { Check, ChevronDown } from 'lucide-react';
import type React from 'react';
import { forwardRef, useEffect, useRef, useState } from 'react';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  icon?: React.ReactNode;
}

export interface SelectProps {
  /** Options list */
  options: SelectOption[];
  /** Current value */
  value?: string;
  /** Value change callback */
  onChange?: (value: string) => void;
  /** Placeholder text */
  placeholder?: string;
  /** Select size */
  size?: 'sm' | 'md' | 'lg';
  /** Whether disabled */
  disabled?: boolean;
  /** Label text */
  label?: string;
  /** Has error */
  error?: boolean;
  /** Error message */
  errorMessage?: string;
  /** Custom class name */
  className?: string;
  /** Full width */
  fullWidth?: boolean;
}

/**
 * Select component - SciPen Studio unified dropdown
 */
export const Select = forwardRef<HTMLButtonElement, SelectProps>(
  (
    {
      options,
      value,
      onChange,
      placeholder = 'Select...',
      size = 'md',
      disabled,
      label,
      error,
      errorMessage,
      className,
      fullWidth = true,
    },
    ref
  ) => {
    const [isOpen, setIsOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    const selectedOption = options.find((opt) => opt.value === value);

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

    useEffect(() => {
      const handleClickOutside = (e: MouseEvent) => {
        if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
          setIsOpen(false);
        }
      };

      if (isOpen) {
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
      }
    }, [isOpen]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
      if (disabled) return;

      switch (e.key) {
        case 'Enter':
        case ' ':
          e.preventDefault();
          setIsOpen(!isOpen);
          break;
        case 'Escape':
          setIsOpen(false);
          break;
        case 'ArrowDown':
          e.preventDefault();
          if (!isOpen) {
            setIsOpen(true);
          } else {
            const currentIndex = options.findIndex((opt) => opt.value === value);
            const nextIndex = Math.min(currentIndex + 1, options.length - 1);
            if (!options[nextIndex].disabled) {
              onChange?.(options[nextIndex].value);
            }
          }
          break;
        case 'ArrowUp':
          e.preventDefault();
          if (isOpen) {
            const currentIndex = options.findIndex((opt) => opt.value === value);
            const prevIndex = Math.max(currentIndex - 1, 0);
            if (!options[prevIndex].disabled) {
              onChange?.(options[prevIndex].value);
            }
          }
          break;
      }
    };

    const handleSelect = (optValue: string) => {
      onChange?.(optValue);
      setIsOpen(false);
    };

    return (
      <div className={clsx(fullWidth ? 'w-full' : 'inline-block', className)} ref={containerRef}>
        {label && (
          <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1.5">
            {label}
          </label>
        )}
        <div className="relative">
          <button
            ref={ref}
            type="button"
            disabled={disabled}
            onClick={() => !disabled && setIsOpen(!isOpen)}
            onKeyDown={handleKeyDown}
            className={clsx(
              'w-full flex items-center justify-between gap-2 rounded-lg border',
              'bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)]',
              'focus:border-[var(--color-accent)] focus:shadow-[0_0_0_3px_var(--color-accent-muted)] focus:outline-none',
              'disabled:cursor-not-allowed disabled:opacity-50',
              'transition-colors duration-200',
              sizeStyles[size],
              error
                ? 'border-[var(--color-error)]'
                : isOpen
                  ? 'border-[var(--color-accent)]'
                  : 'border-[var(--color-border)]'
            )}
          >
            <span className={clsx('truncate', !selectedOption && 'text-[var(--color-text-muted)]')}>
              {selectedOption?.icon && (
                <span className="mr-2 inline-flex">{selectedOption.icon}</span>
              )}
              {selectedOption?.label || placeholder}
            </span>
            <ChevronDown
              size={iconSizes[size]}
              className={clsx(
                'text-[var(--color-text-muted)] transition-transform duration-200 flex-shrink-0',
                isOpen && 'rotate-180'
              )}
            />
          </button>

          {isOpen && (
            <div
              className={clsx(
                'absolute z-50 mt-1 w-full rounded-lg border',
                'bg-[var(--color-bg-elevated)] border-[var(--color-border)]',
                'shadow-[var(--shadow-lg)] py-1',
                'max-h-60 overflow-y-auto',
                'animate-slide-down'
              )}
            >
              {options.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  disabled={option.disabled}
                  onClick={() => !option.disabled && handleSelect(option.value)}
                  className={clsx(
                    'w-full flex items-center gap-2 px-3 py-2 text-left',
                    'transition-colors duration-150',
                    option.disabled
                      ? 'text-[var(--color-text-disabled)] cursor-not-allowed'
                      : 'text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] cursor-pointer',
                    option.value === value && 'bg-[var(--color-accent-muted)]',
                    size === 'sm' ? 'text-xs' : size === 'lg' ? 'text-base' : 'text-sm'
                  )}
                >
                  {option.icon && <span className="flex-shrink-0">{option.icon}</span>}
                  <span className="flex-1 truncate">{option.label}</span>
                  {option.value === value && (
                    <Check
                      size={iconSizes[size]}
                      className="text-[var(--color-accent)] flex-shrink-0"
                    />
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
        {errorMessage && <p className="mt-1.5 text-xs text-[var(--color-error)]">{errorMessage}</p>}
      </div>
    );
  }
);

Select.displayName = 'Select';

export default Select;
