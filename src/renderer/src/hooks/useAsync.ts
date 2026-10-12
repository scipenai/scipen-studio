/**
 * @file useAsync.ts - Async utility Hooks
 * @description React Hook wrappers for async utilities like debounce/delayer
 * @depends shared/utils/async
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Delayer } from '../../../../shared/utils/async';

// ============ useDelayer ============

/**
 * React Hook: useDelayer
 *
 * Returns a trigger function that debounces with Promise support.
 * The task is cancelled on unmount.
 *
 * @example
 * ```tsx
 * const { trigger, cancel } = useDelayer<void>(500);
 *
 * const handleChange = (content: string) => {
 *   trigger(() => saveFile(content));
 * };
 * ```
 */
export function useDelayer<T>(delay: number) {
  const delayerRef = useRef<Delayer<T> | null>(null);

  if (!delayerRef.current) {
    delayerRef.current = new Delayer<T>(delay);
  }

  useEffect(() => {
    return () => {
      delayerRef.current?.dispose();
    };
  }, []);

  const trigger = useCallback((task: () => T | Promise<T>, customDelay?: number): Promise<T> => {
    return delayerRef.current!.trigger(task, customDelay);
  }, []);

  const cancel = useCallback(() => {
    delayerRef.current?.cancel();
  }, []);

  const flush = useCallback(() => {
    return delayerRef.current?.flush();
  }, []);

  return useMemo(() => ({ trigger, cancel, flush }), [trigger, cancel, flush]);
}

// ============ useDebounce ============

/**
 * React Hook: useDebounce
 *
 * Returns a debounced version of a value. Useful for search inputs.
 *
 * @example
 * ```tsx
 * const [searchTerm, setSearchTerm] = useState('');
 * const debouncedSearch = useDebounce(searchTerm, 300);
 *
 * useEffect(() => {
 *   if (debouncedSearch) {
 *     performSearch(debouncedSearch);
 *   }
 * }, [debouncedSearch]);
 * ```
 */
export function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => {
      clearTimeout(timer);
    };
  }, [value, delay]);

  return debouncedValue;
}
