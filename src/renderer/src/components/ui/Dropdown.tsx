/**
 * @file Dropdown.tsx - Dropdown menu component
 * @description Configurable dropdown menu supporting multi-level submenus and keyboard shortcut hints
 */

import { clsx } from 'clsx';
import { ChevronRight } from 'lucide-react';
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';

export interface DropdownItem {
  /** Unique identifier */
  id: string;
  /** Display label */
  label: React.ReactNode;
  /** Icon */
  icon?: React.ReactNode;
  /** Right side content */
  suffix?: React.ReactNode;
  /** Keyboard shortcut */
  shortcut?: string;
  /** Whether disabled */
  disabled?: boolean;
  /** Danger action */
  danger?: boolean;
  /** Divider line */
  divider?: boolean;
  /** Click callback */
  onClick?: () => void;
  /** Submenu items */
  children?: DropdownItem[];
}

export interface DropdownProps {
  /** Trigger element */
  trigger: React.ReactElement;
  /** Menu items */
  items: DropdownItem[];
  /** Alignment */
  align?: 'start' | 'center' | 'end';
  /** Position side */
  side?: 'top' | 'bottom' | 'left' | 'right';
  /** Custom class name */
  className?: string;
}

/**
 * Dropdown component - SciPen Studio unified dropdown menu
 */
export const Dropdown: React.FC<DropdownProps> = ({
  trigger,
  items,
  align = 'start',
  side = 'bottom',
  className,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [coords, setCoords] = useState({ x: 0, y: 0 });
  const triggerRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const updatePosition = useCallback(() => {
    if (!triggerRef.current || !menuRef.current) return;

    const triggerRect = triggerRef.current.getBoundingClientRect();
    const menuRect = menuRef.current.getBoundingClientRect();
    const gap = 4;

    let x = 0;
    let y = 0;

    if (side === 'bottom') {
      y = triggerRect.bottom + gap;
    } else if (side === 'top') {
      y = triggerRect.top - menuRect.height - gap;
    }

    if (align === 'start') {
      x = triggerRect.left;
    } else if (align === 'center') {
      x = triggerRect.left + triggerRect.width / 2 - menuRect.width / 2;
    } else {
      x = triggerRect.right - menuRect.width;
    }

    const padding = 8;
    x = Math.max(padding, Math.min(x, window.innerWidth - menuRect.width - padding));
    y = Math.max(padding, Math.min(y, window.innerHeight - menuRect.height - padding));

    setCoords({ x, y });
  }, [align, side]);

  useEffect(() => {
    if (isOpen) {
      updatePosition();
      const handleClickOutside = (e: MouseEvent) => {
        if (
          menuRef.current &&
          !menuRef.current.contains(e.target as Node) &&
          triggerRef.current &&
          !triggerRef.current.contains(e.target as Node)
        ) {
          setIsOpen(false);
        }
      };
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen, updatePosition]);

  const handleItemClick = (item: DropdownItem) => {
    if (item.disabled) return;
    item.onClick?.();
    if (!item.children) {
      setIsOpen(false);
    }
  };

  const triggerElement = React.cloneElement(
    trigger as React.ReactElement<{
      ref?: React.Ref<HTMLElement>;
      onClick?: (e: React.MouseEvent) => void;
    }>,
    {
      ref: triggerRef,
      onClick: (e: React.MouseEvent) => {
        e.stopPropagation();
        setIsOpen(!isOpen);
        (
          trigger as React.ReactElement<{ onClick?: (e: React.MouseEvent) => void }>
        ).props.onClick?.(e);
      },
    }
  );

  return (
    <>
      {triggerElement}
      {isOpen &&
        createPortal(
          <div
            ref={menuRef}
            className={clsx(
              'fixed z-50 min-w-[160px] py-1 rounded-lg',
              'bg-[var(--color-bg-elevated)] border border-[var(--color-border)]',
              'shadow-[var(--shadow-lg)]',
              'animate-slide-down',
              className
            )}
            style={{ left: coords.x, top: coords.y }}
          >
            {items.map((item, index) => {
              if (item.divider) {
                return (
                  <div key={`divider-${index}`} className="h-px my-1 bg-[var(--color-border)]" />
                );
              }

              return (
                <button
                  key={item.id}
                  type="button"
                  disabled={item.disabled}
                  onClick={() => handleItemClick(item)}
                  className={clsx(
                    'w-full flex items-center gap-2 px-3 py-2 text-sm text-left',
                    'transition-colors duration-150',
                    item.disabled
                      ? 'text-[var(--color-text-disabled)] cursor-not-allowed'
                      : item.danger
                        ? 'text-[var(--color-error)] hover:bg-[var(--color-error-muted)]'
                        : 'text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]'
                  )}
                >
                  {item.icon && (
                    <span className="flex-shrink-0 w-4 h-4 flex items-center justify-center">
                      {item.icon}
                    </span>
                  )}
                  <span className="flex-1 truncate">{item.label}</span>
                  {item.shortcut && (
                    <span className="text-xs text-[var(--color-text-muted)] ml-auto">
                      {item.shortcut}
                    </span>
                  )}
                  {item.suffix}
                  {item.children && (
                    <ChevronRight size={14} className="text-[var(--color-text-muted)]" />
                  )}
                </button>
              );
            })}
          </div>,
          document.body
        )}
    </>
  );
};

Dropdown.displayName = 'Dropdown';

export default Dropdown;
