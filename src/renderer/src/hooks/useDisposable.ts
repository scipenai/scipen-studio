/**
 * @file useDisposable.ts - Lifecycle management Hooks
 * @description React Hook wrapper for DisposableStore, automatically manages resource disposal
 */

import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { DisposableStore, type IDisposable } from '../../../../shared/utils/lifecycle';

// ============ useDisposables ============

/**
 * React Hook: useDisposables
 *
 * Creates and returns a DisposableStore that is automatically disposed on unmount.
 * Use this to manage multiple disposables in a component.
 *
 * @example
 * ```tsx
 * function MyComponent({ service }) {
 *   const disposables = useDisposables();
 *
 *   useEffect(() => {
 *     disposables.add(service.onDidChange(() => {
 *       // handle change
 *     }));
 *
 *     disposables.add(service.onDidError((error) => {
 *       // handle error
 *     }));
 *   }, [service, disposables]);
 *
 *   return <div>...</div>;
 * }
 * ```
 */
export function useDisposables(): DisposableStore {
  const store = useRef<DisposableStore>(null!);
  if (!store.current) {
    store.current = new DisposableStore();
  }

  useEffect(() => {
    return () => store.current?.dispose();
  }, []);

  return store.current;
}

// ============ useDisposable ============

/**
 * React Hook: useDisposable
 *
 * Manages a single disposable that is automatically disposed on unmount.
 * The factory is called once on mount and the result is disposed on unmount.
 *
 * @example
 * ```tsx
 * function MyComponent({ service }) {
 *   useDisposable(() => {
 *     return service.onDidChange(() => {
 *       // handle change
 *     });
 *   }, [service]);
 *
 *   return <div>...</div>;
 * }
 * ```
 */
export function useDisposable(
  factory: () => IDisposable | undefined,
  deps: React.DependencyList = []
): void {
  const disposableRef = useRef<IDisposable | undefined>(undefined);

  useEffect(() => {
    // Dispose previous if exists
    disposableRef.current?.dispose();

    // Create new disposable
    disposableRef.current = factory();

    return () => {
      disposableRef.current?.dispose();
      disposableRef.current = undefined;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

// ============ useMutableDisposable ============

/**
 * React Hook: useMutableDisposable
 *
 * Manages a mutable disposable where you can set/change the value.
 * Old values are automatically disposed when a new value is set.
 *
 * @example
 * ```tsx
 * function EditorPanel({ activeFile }) {
 *   const [subscription, setSubscription] = useMutableDisposable<IDisposable>();
 *
 *   useEffect(() => {
 *     if (activeFile) {
 *       setSubscription(editorService.subscribeToFile(activeFile));
 *     } else {
 *       setSubscription(undefined);
 *     }
 *   }, [activeFile, setSubscription]);
 *
 *   return <div>...</div>;
 * }
 * ```
 */
export function useMutableDisposable<T extends IDisposable>(): [
  T | undefined,
  (value: T | undefined) => void,
] {
  const valueRef = useRef<T | undefined>(undefined);
  const [, forceUpdate] = useState({});

  const setValue = useCallback((value: T | undefined) => {
    if (valueRef.current !== value) {
      valueRef.current?.dispose();
      valueRef.current = value;
      forceUpdate({});
    }
  }, []);

  useEffect(() => {
    return () => {
      valueRef.current?.dispose();
      valueRef.current = undefined;
    };
  }, []);

  return [valueRef.current, setValue];
}
