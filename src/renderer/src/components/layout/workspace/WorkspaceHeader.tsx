/**
 * @file WorkspaceHeader.tsx - 工作台头部
 * @description title(左)+ toolbar(右)的两段式 header,含 border-bottom 分隔条
 */

import type React from 'react';

export interface WorkspaceHeaderProps {
  title: string;
  /** Toolbar slot — 通常传 <WorkspaceToolbar>...</WorkspaceToolbar> */
  toolbar?: React.ReactNode;
}

export const WorkspaceHeader: React.FC<WorkspaceHeaderProps> = ({ title, toolbar }) => {
  return (
    <div className="flex items-center justify-between border-b px-4 py-3 border-b-[var(--color-border-subtle)]">
      <div className="min-w-0">
        <h2 className="truncate text-[15px] font-medium tracking-[-0.02em] text-[var(--color-text-primary)]">
          {title}
        </h2>
      </div>
      {toolbar}
    </div>
  );
};
