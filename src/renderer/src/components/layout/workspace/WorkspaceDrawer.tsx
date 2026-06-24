/**
 * @file WorkspaceDrawer.tsx - Workspace sliding drawer
 * @description framer-motion backdrop + drawer panel pair.
 *              Positioned absolute; must live inside a relative parent
 *              (WorkspaceShell's body area provides this by default).
 */

import { clsx } from 'clsx';
import { AnimatePresence, motion } from 'framer-motion';
import type React from 'react';
import { useCallback, useEffect, useRef } from 'react';

const focusableSelector =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

export interface WorkspaceDrawerProps {
  open: boolean;
  onClose: () => void;
  /** Drawer side — left or right; defaults to left */
  side?: 'left' | 'right';
  /** Accessible name for the backdrop close button */
  closeAriaLabel: string;
  /** Drawer width in px; defaults to 320 */
  width?: number;
  children: React.ReactNode;
}

export const WorkspaceDrawer: React.FC<WorkspaceDrawerProps> = ({
  open,
  onClose,
  side = 'left',
  closeAriaLabel,
  width = 320,
  children,
}) => {
  const isLeft = side === 'left';
  const drawerRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key === 'Tab') {
        const focusableElements = Array.from(
          drawerRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? []
        );

        if (focusableElements.length === 0) {
          event.preventDefault();
          drawerRef.current?.focus();
          return;
        }

        const firstElement = focusableElements[0];
        const lastElement = focusableElements[focusableElements.length - 1];

        if (event.shiftKey && document.activeElement === firstElement) {
          event.preventDefault();
          lastElement.focus();
        } else if (!event.shiftKey && document.activeElement === lastElement) {
          event.preventDefault();
          firstElement.focus();
        }
      }
    },
    [onClose]
  );

  useEffect(() => {
    if (!open) return;

    previouslyFocusedRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.addEventListener('keydown', handleKeyDown);
    const focusTarget = drawerRef.current?.querySelector<HTMLElement>(focusableSelector);
    (focusTarget ?? drawerRef.current)?.focus();

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocusedRef.current?.focus();
      previouslyFocusedRef.current = null;
    };
  }, [open, handleKeyDown]);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.button
            type="button"
            aria-label={closeAriaLabel}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
            className={clsx(
              'absolute inset-0 z-10 cursor-pointer backdrop-blur-[1px]',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)]',
              'bg-[color-mix(in_srgb,var(--color-backdrop)_24%,transparent)]'
            )}
            onClick={onClose}
          />
          <motion.div
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label={closeAriaLabel}
            tabIndex={-1}
            initial={{ x: isLeft ? -24 : 24, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: isLeft ? -24 : 24, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className={clsx(
              'absolute inset-y-0 z-20 overflow-hidden shadow-[var(--shadow-lg)]',
              isLeft
                ? 'left-0 rounded-r-[24px] border-r border-r-[var(--color-border)]'
                : 'right-0 rounded-l-[24px] border-l border-l-[var(--color-border)]',
              'bg-[color-mix(in_srgb,var(--color-bg-elevated)_96%,transparent)]'
            )}
            style={{ width }}
          >
            {children}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
};
