/**
 * @file useEvent.ts - Event subscription Hooks
 * @description Declarative React Hook for service event subscriptions, automatically manages subscription lifecycle
 */

import { useEffect, useRef } from 'react';
import type { IEvent } from '../../../../shared/utils';

// ============ useEvent ============

/**
 * React Hook: useEvent
 *
 * Subscribe to an event and call a handler when it fires.
 * The subscription is automatically cleaned up on unmount.
 *
 * @example
 * ```tsx
 * function StatusBar({ editorService }) {
 *   const [isDirty, setIsDirty] = useState(false);
 *
 *   useEvent(editorService.onDidChangeIsDirty, (dirty) => {
 *     setIsDirty(dirty);
 *   }, []);
 *
 *   return <span>{isDirty ? 'Modified' : 'Saved'}</span>;
 * }
 * ```
 */
export function useEvent<T>(
  event: IEvent<T>,
  handler: (value: T) => void,
  deps: React.DependencyList = []
): void {
  const handlerRef = useRef(handler);

  // Always keep the latest handler
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    const disposable = event((value) => {
      handlerRef.current(value);
    });

    return () => disposable.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event, ...deps]);
}

// ============ useIpcEvent ============

/**
 * React Hook: useIpcEvent
 *
 * Subscribe to an IPC event that returns a cleanup function.
 * This is specifically for Electron IPC event listeners that use the pattern:
 * `api.xxx.onYYY((data) => { ... })` which returns `() => void`
 *
 * @example
 * ```tsx
 * function ExamplePanel() {
 *   useIpcEvent(
 *     api.chat.onStream,
 *     (event) => {
 *       console.log('Stream event:', event);
 *     }
 *   );
 *
 *   return <div>...</div>;
 * }
 * ```
 */
export function useIpcEvent<T>(
  subscribe: ((handler: (value: T) => void) => () => void) | undefined,
  handler: (value: T) => void
): void {
  const handlerRef = useRef(handler);

  // Always keep the latest handler
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    if (!subscribe) return;

    const cleanup = subscribe((value) => {
      handlerRef.current(value);
    });

    return cleanup;
  }, [subscribe]);
}
