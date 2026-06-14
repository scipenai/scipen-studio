/**
 * @file WorkspaceToolbar.tsx - Workspace toolbar container
 * @description Lightweight inline button group (no border / no pill background), placed
 *              in WorkspaceHeader's toolbar slot.
 */

import type React from 'react';

export interface WorkspaceToolbarProps {
  children: React.ReactNode;
}

export const WorkspaceToolbar: React.FC<WorkspaceToolbarProps> = ({ children }) => {
  return <div className="flex items-center gap-0.5">{children}</div>;
};
