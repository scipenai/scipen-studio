/**
 * @file WorkspaceToolbar.tsx - 工作台 toolbar 容器
 * @description 轻量内联按钮组(无边框/无底色胶囊),放在 WorkspaceHeader 的 toolbar slot
 */

import type React from 'react';

export interface WorkspaceToolbarProps {
  children: React.ReactNode;
}

export const WorkspaceToolbar: React.FC<WorkspaceToolbarProps> = ({ children }) => {
  return <div className="flex items-center gap-0.5">{children}</div>;
};
