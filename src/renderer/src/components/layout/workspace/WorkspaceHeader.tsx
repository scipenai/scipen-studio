/**
 * @file WorkspaceHeader.tsx - Workspace header
 * @description Title, optional context line, and right-side toolbar.
 */

import type React from 'react';

export interface WorkspaceHeaderProps {
  title: string;
  subtitle?: string;
  toolbar?: React.ReactNode;
}

export const WorkspaceHeader: React.FC<WorkspaceHeaderProps> = ({ title, subtitle, toolbar }) => {
  return (
    <div className="flex items-center justify-between gap-4 border-b px-4 py-3 border-b-[var(--color-border-subtle)]">
      <div className="min-w-0">
        <h2 className="truncate text-[15px] font-medium text-[var(--color-text-primary)]">
          {title}
        </h2>
        {subtitle && (
          <p className="mt-0.5 truncate text-[11px] text-[var(--color-text-muted)]">{subtitle}</p>
        )}
      </div>
      {toolbar}
    </div>
  );
};
