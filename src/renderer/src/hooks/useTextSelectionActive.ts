/**
 * @file useTextSelectionActive - true while a non-collapsed text selection
 *   exists anywhere in the document.
 *
 * Used by hover-revealed action buttons (e.g. the per-message Rollback icon)
 * to step aside while the user drags across multiple messages to copy text.
 * Without this guard the button's pointer-events area splits the selection
 * where the cursor crosses it.
 *
 * `selectionchange` can fire on every mouse move during a drag, so the
 * handler is kept dead-simple — just check `isCollapsed`. setState
 * short-circuits when the boolean is unchanged, so React only re-renders
 * consumers on the transitions (drag starts / drag stops), not on every
 * intermediate mouse move.
 */
import { useEffect, useState } from 'react';

export function useTextSelectionActive(): boolean {
  const [active, setActive] = useState(false);
  useEffect(() => {
    const handler = (): void => {
      // Avoid `sel.toString()` — on multi-kilobyte selections it walks the
      // entire range each invocation. `isCollapsed` is the cheap equivalent
      // for the only thing we care about here.
      const sel = document.getSelection();
      const isActive = !!sel && !sel.isCollapsed;
      setActive((prev) => (prev === isActive ? prev : isActive));
    };
    document.addEventListener('selectionchange', handler);
    return () => document.removeEventListener('selectionchange', handler);
  }, []);
  return active;
}
