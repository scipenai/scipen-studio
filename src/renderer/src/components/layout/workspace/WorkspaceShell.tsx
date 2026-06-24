/**
 * @file WorkspaceShell.tsx - Workspace shell container
 * @description Carries the "canvas + header" responsibility of ResearchWorkspaceShell.
 *   Modern AI-tool aesthetic: the shell itself is a canvas (bg-void); the three
 *   panels each act as floating cards hovering on top (card styling is applied by
 *   ResearchWorkspaceShell inside each Panel). The shell is no longer a single
 *   large card wrapping everything. Provides a header slot and a body area
 *   (flex-1 + relative; relative is required for WorkspaceDrawer's absolute
 *   positioning overlay).
 */

import { clsx } from 'clsx';
import type React from 'react';

export interface WorkspaceShellProps {
  /** Header slot — typically receives <WorkspaceHeader /> */
  header?: React.ReactNode;
  /** Body content (wrapped in a relative flex-1 container that hosts the drawer and main panels) */
  children: React.ReactNode;
  /** Custom className forwarded to the outer container */
  className?: string;
}

export const WorkspaceShell: React.FC<WorkspaceShellProps> = ({ header, children, className }) => {
  return (
    <div
      className={clsx('flex h-full flex-col overflow-hidden bg-[var(--color-bg-void)]', className)}
    >
      {header}
      <div className="relative flex-1 min-h-0 overflow-hidden">{children}</div>
    </div>
  );
};
