/**
 * @file researchWorkspaceHelpers.tsx
 * @description Layout helpers used by ResearchWorkspaceShell. The error-
 *   injection prompt builders that fed the legacy builtin chat input went
 *   away with the builtin chat path; SNACA's ChatSidebar listens to the same
 *   UIService events directly and seeds its own input.
 */

import { PanelResizeHandle } from 'react-resizable-panels';

export function getChatPanelDefaultSize(
  workspaceMode: 'chat' | 'chat-editor' | 'chat-editor-preview'
): number {
  if (workspaceMode === 'chat-editor-preview') return 24;
  if (workspaceMode === 'chat-editor') return 28;
  return 100;
}

// ─── Small components ──────────────────────────────

export const WorkspaceResizeHandle = () => (
  <PanelResizeHandle className="group relative w-2 bg-transparent transition-colors">
    <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[var(--color-border-subtle)] transition-colors group-hover:bg-[var(--color-accent)]" />
    <div className="absolute left-1/2 top-1/2 h-10 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-transparent transition-colors group-hover:bg-[var(--color-accent-muted)]" />
  </PanelResizeHandle>
);
