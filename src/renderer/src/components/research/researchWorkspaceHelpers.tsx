/**
 * @file researchWorkspaceHelpers.tsx
 * @description Small layout helpers for ResearchWorkspaceShell. Once the main page was flattened to a
 *   single layer of three panels (chat / editor / preview), only the light resize handle and the default
 *   size constants remain here; the old workspaceMode-derived width logic was removed along with the
 *   linear mode machine.
 */

import { PanelResizeHandle } from 'react-resizable-panels';

/** Default size ratios for the three panels (autoSaveId persistence takes precedence once stored). */
export const PANEL_DEFAULT_SIZE = {
  chat: 30,
  editor: 44,
  preview: 26,
} as const;

/**
 * Card-gap resize handle: in the floating-card layout the handle *is* the gap — transparent so the
 * underlying canvas shows through, no longer drawing a 1px seam line (each card carries its own border).
 * A short accent grip only appears on hover to signal it's draggable.
 *
 * Only rendered between two **visible** panels (declaratively inserted by ResearchWorkspaceShell based on
 * the visible-panel list) — handles always stay consistent with panel add/remove, no permanent presence
 * or active toggle needed.
 */
export const WorkspaceResizeHandle = () => (
  <PanelResizeHandle className="group relative w-3 bg-transparent transition-colors">
    <div className="absolute left-1/2 top-1/2 h-10 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-transparent transition-colors group-hover:bg-[var(--color-accent-muted)]" />
  </PanelResizeHandle>
);
