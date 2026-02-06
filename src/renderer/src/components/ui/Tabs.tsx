/**
 * @file Tabs.tsx - Tabs component
 * @description Tab switching component supporting controlled and uncontrolled modes
 */

import { clsx } from 'clsx';
import type React from 'react';
import { createContext, forwardRef, useContext, useState } from 'react';

interface TabsContextValue {
  value: string;
  onChange: (value: string) => void;
}

const TabsContext = createContext<TabsContextValue | null>(null);

export interface TabsProps {
  /** Current value */
  value?: string;
  /** Default value */
  defaultValue?: string;
  /** Value change callback */
  onChange?: (value: string) => void;
  /** Children elements */
  children: React.ReactNode;
  /** Custom class name */
  className?: string;
}

/**
 * Tabs component - SciPen Studio unified tabs
 */
export const Tabs: React.FC<TabsProps> = ({
  value: controlledValue,
  defaultValue,
  onChange,
  children,
  className,
}) => {
  const [internalValue, setInternalValue] = useState(defaultValue || '');
  const value = controlledValue !== undefined ? controlledValue : internalValue;

  const handleChange = (newValue: string) => {
    if (controlledValue === undefined) {
      setInternalValue(newValue);
    }
    onChange?.(newValue);
  };

  return (
    <TabsContext.Provider value={{ value, onChange: handleChange }}>
      <div className={className}>{children}</div>
    </TabsContext.Provider>
  );
};

export interface TabsListProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Tab list variant */
  variant?: 'default' | 'pills' | 'underline';
}

/**
 * TabsList component - tab list container
 */
export const TabsList = forwardRef<HTMLDivElement, TabsListProps>(
  ({ className, variant = 'default', children, ...props }, ref) => {
    const variantStyles = {
      default: 'bg-[var(--color-bg-tertiary)] rounded-lg p-1 gap-1',
      pills: 'gap-2',
      underline: 'border-b border-[var(--color-border)] gap-4',
    };

    return (
      <div
        ref={ref}
        role="tablist"
        className={clsx('flex items-center', variantStyles[variant], className)}
        {...props}
      >
        {children}
      </div>
    );
  }
);

TabsList.displayName = 'TabsList';

export interface TabsTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Corresponding tab value */
  value: string;
  /** Variant (inherited from TabsList) */
  variant?: 'default' | 'pills' | 'underline';
  /** Left icon */
  icon?: React.ReactNode;
}

/**
 * TabsTrigger component - tab trigger button
 */
export const TabsTrigger = forwardRef<HTMLButtonElement, TabsTriggerProps>(
  ({ className, value, variant = 'default', icon, children, disabled, ...props }, ref) => {
    const context = useContext(TabsContext);
    if (!context) {
      throw new Error('TabsTrigger must be used within a Tabs component');
    }

    const isActive = context.value === value;

    const baseStyles = `
      inline-flex items-center justify-center gap-2 
      text-sm font-medium transition-all duration-200
      focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]
      disabled:pointer-events-none disabled:opacity-50
    `;

    const variantStyles = {
      default: clsx(
        'px-3 py-1.5 rounded-md',
        isActive
          ? 'bg-[var(--color-bg-elevated)] text-[var(--color-text-primary)] shadow-sm'
          : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'
      ),
      pills: clsx(
        'px-4 py-2 rounded-lg',
        isActive
          ? 'bg-[var(--color-accent)] text-white'
          : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]'
      ),
      underline: clsx(
        'px-1 py-2 relative',
        isActive
          ? 'text-[var(--color-accent)]'
          : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]',
        isActive &&
          'after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:bg-[var(--color-accent)]'
      ),
    };

    return (
      <button
        ref={ref}
        type="button"
        role="tab"
        aria-selected={isActive}
        disabled={disabled}
        onClick={() => context.onChange(value)}
        className={clsx(baseStyles, variantStyles[variant], className)}
        {...props}
      >
        {icon}
        {children}
      </button>
    );
  }
);

TabsTrigger.displayName = 'TabsTrigger';

export interface TabsContentProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Corresponding tab value */
  value: string;
}

/**
 * TabsContent component - tab content panel
 */
export const TabsContent = forwardRef<HTMLDivElement, TabsContentProps>(
  ({ className, value, children, ...props }, ref) => {
    const context = useContext(TabsContext);
    if (!context) {
      throw new Error('TabsContent must be used within a Tabs component');
    }

    if (context.value !== value) {
      return null;
    }

    return (
      <div ref={ref} role="tabpanel" className={clsx('mt-4 animate-fade-in', className)} {...props}>
        {children}
      </div>
    );
  }
);

TabsContent.displayName = 'TabsContent';

export default Tabs;
