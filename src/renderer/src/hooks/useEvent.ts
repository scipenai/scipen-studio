/**
 * @file useEvent.ts - Event subscription Hooks
 * @description Declarative React Hook for service event subscriptions, automatically manages subscription lifecycle
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type DebounceOptions,
  Emitter,
  EventBuffer,
  type IEvent,
  debounceEvent,
} from '../../../../shared/utils';

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

// ============ useEventValue ============

/**
 * React Hook: useEventValue
 *
 * Subscribe to an event and return the latest value.
 * Returns the initial value until the event fires.
 *
 * @example
 * ```tsx
 * function EditorStatus({ editorService }) {
 *   const lineNumber = useEventValue(
 *     editorService.onDidChangeCursorPosition,
 *     (position) => position.lineNumber,
 *     1 // initial value
 *   );
 *
 *   return <span>Line: {lineNumber}</span>;
 * }
 * ```
 */
export function useEventValue<T, V>(
  event: IEvent<T>,
  selector: (value: T) => V,
  initialValue: V
): V {
  const [value, setValue] = useState<V>(initialValue);

  useEvent(
    event,
    (e) => {
      setValue(selector(e));
    },
    [selector]
  );

  return value;
}

// ============ useDebouncedEvent ============

/**
 * React Hook: useDebouncedEvent
 *
 * Subscribe to a debounced version of an event.
 * Useful for high-frequency events like file changes.
 *
 * @example
 * ```tsx
 * function FileTreePanel({ fileWatcher }) {
 *   useDebouncedEvent(
 *     fileWatcher.onDidChange,
 *     (paths) => {
 *       refreshFileTree(paths);
 *     },
 *     (paths, path) => paths ? [...paths, path] : [path],
 *     { delay: 100 }
 *   );
 *
 *   return <div>...</div>;
 * }
 * ```
 */
export function useDebouncedEvent<T, R>(
  event: IEvent<T>,
  handler: (value: R) => void,
  merge: (last: R | undefined, current: T) => R,
  options: DebounceOptions
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const debouncedEvent = debounceEvent(event, merge, options);
    const disposable = debouncedEvent((value) => {
      handlerRef.current(value);
    });

    return () => {
      disposable.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event, options.delay, options.leading, options.maxWait]);
}

// ============ useEventBuffer ============

/**
 * React Hook: useEventBuffer
 *
 * Buffers events and provides them in batches on animation frames.
 * Useful for high-frequency events that need to update the UI.
 *
 * @example
 * ```tsx
 * function LogPanel() {
 *   const [logs, setLogs] = useState<LogEntry[]>([]);
 *   const pushLog = useEventBuffer<LogEntry>((batch) => {
 *     setLogs(prev => [...prev, ...batch]);
 *   });
 *
 *   useEffect(() => {
 *     const disposable = compiler.onLog((entry) => pushLog(entry));
 *     return () => disposable.dispose();
 *   }, [pushLog]);
 *
 *   return <div>{logs.map(log => <LogLine key={log.id} log={log} />)}</div>;
 * }
 * ```
 */
export function useEventBuffer<T>(onFlush: (items: T[]) => void): (item: T) => void {
  const bufferRef = useRef<EventBuffer<T> | null>(null);
  const onFlushRef = useRef(onFlush);

  onFlushRef.current = onFlush;

  if (!bufferRef.current) {
    bufferRef.current = new EventBuffer<T>();
  }

  useEffect(() => {
    const buffer = bufferRef.current!;
    const disposable = buffer.onFlush((items) => {
      onFlushRef.current(items);
    });

    return () => {
      disposable.dispose();
      buffer.dispose();
    };
  }, []);

  return useCallback((item: T) => {
    bufferRef.current?.push(item);
  }, []);
}

// ============ useEmitter ============

/**
 * React Hook: useEmitter
 *
 * Creates a stable Emitter instance that persists across renders.
 * Useful for creating custom events in a component.
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const { fire, event } = useEmitter<string>();
 *
 *   return (
 *     <div>
 *       <button onClick={() => fire('clicked')}>Click me</button>
 *       <ChildComponent onAction={event} />
 *     </div>
 *   );
 * }
 * ```
 */
export function useEmitter<T>(): {
  fire: (value: T) => void;
  event: IEvent<T>;
} {
  const emitterRef = useRef<Emitter<T> | null>(null);

  if (!emitterRef.current) {
    emitterRef.current = new Emitter<T>();
  }

  useEffect(() => {
    return () => {
      emitterRef.current?.dispose();
    };
  }, []);

  const fire = useCallback((value: T) => {
    emitterRef.current?.fire(value);
  }, []);

  return {
    fire,
    event: emitterRef.current.event,
  };
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
 * function KnowledgePanel() {
 *   useIpcEvent(
 *     api.knowledge.onTaskProgress,
 *     (event) => {
 *       console.log('Task progress:', event.progress);
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
