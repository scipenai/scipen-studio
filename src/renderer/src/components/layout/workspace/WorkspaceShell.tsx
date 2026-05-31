/**
 * @file WorkspaceShell.tsx - 工作台外壳容器
 * @description 承担 ResearchWorkspaceShell 的"外壳 + 主卡片"视觉职责,
 *              提供 header slot 与 body 区(自动 flex-1 + relative + overflow-hidden)
 */

import { clsx } from 'clsx';
import type React from 'react';

export interface WorkspaceShellProps {
  /** Header slot — 通常传 <WorkspaceHeader /> */
  header?: React.ReactNode;
  /** Body 内容(会被包在 relative flex-1 容器内,用于承载抽屉与主面板) */
  children: React.ReactNode;
  /** 自定义 className 透传到外层容器 */
  className?: string;
}

export const WorkspaceShell: React.FC<WorkspaceShellProps> = ({
  header,
  children,
  className,
}) => {
  return (
    <div
      className={clsx(
        'h-full overflow-hidden p-2 bg-[var(--color-bg-void)]',
        className
      )}
    >
      <div
        className={clsx(
          'flex h-full flex-col overflow-hidden rounded-[20px] border shadow-[var(--shadow-lg)]',
          'border-[var(--color-border-subtle)]',
          'bg-[color-mix(in_srgb,var(--color-bg-primary)_94%,transparent)]'
        )}
      >
        {header}
        <div className="relative flex-1 min-h-0 overflow-hidden">{children}</div>
      </div>
    </div>
  );
};
