/**
 * @file WorkspaceToolbar.tsx - 工作台 chip 状按钮组容器
 * @description 圆角胶囊容器,承载 IconButton/按钮组,放在 WorkspaceHeader 的 toolbar slot
 */

import type React from 'react';

export interface WorkspaceToolbarProps {
  children: React.ReactNode;
}

export const WorkspaceToolbar: React.FC<WorkspaceToolbarProps> = ({ children }) => {
  return (
    <div
      className={
        'flex items-center gap-1 rounded-full border px-1.5 py-0.5 ' +
        'border-[var(--color-border-subtle)] ' +
        'bg-[color-mix(in_srgb,var(--color-bg-elevated)_92%,transparent)]'
      }
    >
      {children}
    </div>
  );
};
