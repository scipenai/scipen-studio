/**
 * @file WorkspaceDrawer.tsx - 工作台侧滑抽屉
 * @description backdrop + drawer panel 的 framer-motion 双子元素封装。
 *              定位为 absolute,需放在 relative 父容器内(WorkspaceShell 的 body 区自带)
 */

import { clsx } from 'clsx';
import { AnimatePresence, motion } from 'framer-motion';
import type React from 'react';

export interface WorkspaceDrawerProps {
  open: boolean;
  onClose: () => void;
  /** 抽屉位于左侧或右侧,默认左 */
  side?: 'left' | 'right';
  /** Backdrop 的 aria-label(关闭按钮的无障碍名) */
  closeAriaLabel: string;
  /** 抽屉宽度,默认 320px */
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
