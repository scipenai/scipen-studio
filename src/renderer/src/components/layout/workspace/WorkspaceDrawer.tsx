/**
 * @file WorkspaceDrawer.tsx - Workspace sliding drawer
 * @description framer-motion backdrop + drawer panel pair.
 *              Positioned absolute; must live inside a relative parent
 *              (WorkspaceShell's body area provides this by default).
 */

import { clsx } from 'clsx';
import { AnimatePresence, motion } from 'framer-motion';
import type React from 'react';

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
              'absolute inset-0 z-10 backdrop-blur-[1px]',
              'bg-[color-mix(in_srgb,var(--color-backdrop)_24%,transparent)]'
            )}
            onClick={onClose}
          />
          <motion.div
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
