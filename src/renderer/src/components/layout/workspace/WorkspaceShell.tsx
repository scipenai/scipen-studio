/**
 * @file WorkspaceShell.tsx - 工作台外壳容器
 * @description 承担 ResearchWorkspaceShell 的"画布(canvas)+ header"职责。
 *   现代 AI 工具观感:外壳本身是 canvas(bg-void),三面板各自作为浮动卡片
 *   悬浮其上(卡片样式由 ResearchWorkspaceShell 在 Panel 内层施加),此处不再
 *   是一张包裹全部的大卡片。提供 header slot 与 body 区(flex-1 + relative,
 *   relative 供 WorkspaceDrawer 绝对定位叠加)。
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

export const WorkspaceShell: React.FC<WorkspaceShellProps> = ({ header, children, className }) => {
  return (
    <div
      className={clsx(
        'flex h-full flex-col overflow-hidden bg-[var(--color-bg-void)]',
        className
      )}
    >
      {header}
      <div className="relative flex-1 min-h-0 overflow-hidden">{children}</div>
    </div>
  );
};
