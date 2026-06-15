/**
 * @file useTextSelectionActive - true while a non-collapsed text selection
 *   exists anywhere in the document.
 *
 * Used by hover-revealed action buttons (e.g. the per-message Rollback icon)
 * to step aside while the user is dragging across multiple messages to copy
 * text. Without this guard the button's hover/pointer-events area can split
 * the selection mid-drag.
 *
 * Subscribes to `selectionchange` on `document` (the only event that fires
 * synchronously while a selection is being extended via mouse drag). Cheap
 * to share across many components — a single subscriber writes a window-
 * scoped flag, but for now the React-y approach (each consumer subscribes)
 * is fine: `selectionchange` fires at most once per animation frame and the
 * setState short-circuits when the value is unchanged.
 */
import { useEffect, useState } from 'react';

export function useTextSelectionActive(): boolean {
  const [active, setActive] = useState(false);
  useEffect(() => {
    const handler = (): void => {
      const sel = document.getSelection();
      const isActive = !!sel && !sel.isCollapsed && sel.toString().length > 0;
      setActive((prev) => (prev === isActive ? prev : isActive));
    };
    document.addEventListener('selectionchange', handler);
    return () => document.removeEventListener('selectionchange', handler);
  }, []);
  return active;
}
