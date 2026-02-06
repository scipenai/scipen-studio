/**
 * @file useAsync.ts - Async utility Hooks
 * @description React Hook wrappers for async utilities like debounce, throttle, idle callbacks
 * @depends shared/utils/async
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Delayer, type ICancellableTask, Throttler } from '../../../../shared/utils/async';

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

// ============ useThrottler ============

/**
 * React Hook: useThrottler
 *
 * Returns a queue function that ensures only one async task runs at a time.
 *
 * @example
 * ```tsx
 * const queue = useThrottler<ResponseData>();
 *
 * const handleRequest = async () => {
 *   const result = await queue((token) => fetchData(token));
 *   setData(result);
 * };
 * ```
 */
export function useThrottler<T>() {
  const throttlerRef = useRef<Throttler | null>(null);

  if (!throttlerRef.current) {
    throttlerRef.current = new Throttler();
  }

  useEffect(() => {
    return () => {
      throttlerRef.current?.dispose();
    };
  }, []);

  const queue = useCallback((factory: ICancellableTask<T>): Promise<T> => {
    return throttlerRef.current!.queue(factory);
  }, []);

  return queue;
}

// ============ useIdleCallback ============

/**
 * React Hook: useIdleCallback
 *
 * Schedules a callback to run during browser idle time.
 * Returns a schedule function. Automatically cancels on unmount.
 *
 * @example
 * ```tsx
 * const schedule = useIdleCallback();
 *
 * useEffect(() => {
 *   const cancel = schedule((deadline) => {
 *     while (deadline.timeRemaining() > 0) {
 *       doSomeWork();
 *     }
 *   });
 *   return cancel;
 * }, []);
 * ```
 */
export function useIdleCallback(options?: IdleRequestOptions) {
  const schedule = useCallback(
    (callback: (deadline: IdleDeadline) => void): (() => void) => {
      const handle = requestIdleCallback(callback, options);
      return () => cancelIdleCallback(handle);
    },
    [options]
  );

  return schedule;
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
