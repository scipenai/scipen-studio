/**
 * @file useLazyModule.ts - Reliably-committing dynamic component loader (replacement for React.lazy + Suspense).
 * @description React.lazy + Suspense's "first resolve" fails to commit-mount in this app — measured:
 *   the chunk resolves on first click (<12ms), but the component does not mount until the next
 *   interaction (the user-visible "have to click twice" symptom). Root cause: lazy's loader is
 *   inherently async → it always suspends once → after resolve, React schedules the commit on a
 *   low-priority retry lane, which is starved by ongoing high-priority renders until the next
 *   interaction forces a flush.
 *
 *   This hook routes through "dynamic import → setState" instead: setState is a default-priority
 *   update, so the commit is reliable and never starved. Code-splitting is preserved (dynamic
 *   import still emits a separate chunk). With the shell's idle prefetch, the import hits a warm
 *   cache → effectively instant. Static imports (e.g. the file drawer) are the extreme form of
 *   the same idea (zero async) and have been verified reliable.
 */
import { useEffect, useState, type ComponentType } from 'react';

/**
 * Dynamically loads a component and returns it once ready (returns null until ready;
 * caller renders the fallback).
 * @param load Module loader returning the target component, e.g. `() => import('./Heavy').then(m => m.Heavy)`
 */
export function useLazyModule<P = Record<string, never>>(
  load: () => Promise<ComponentType<P>>
): ComponentType<P> | null {
  const [Component, setComponent] = useState<ComponentType<P> | null>(null);

  useEffect(() => {
    let alive = true;
    void load()
      .then((resolved) => {
        // Functional setState: the component itself is a function, so passing it directly
        // would be treated as an updater — wrap it in a returning lambda.
        if (alive) setComponent(() => resolved);
      })
      .catch((err) => {
        // Chunk load failure is rare but severe (component would stay on fallback forever);
        // log for diagnostics. Do not rethrow — keeps the surrounding panel alive (genuine
        // render-time errors are still caught by the upstream ErrorBoundary).
        console.error('[useLazyModule] dynamic component load failed', err);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load is a stable module loader at each call site; load once on mount
  }, []);

  return Component;
}
