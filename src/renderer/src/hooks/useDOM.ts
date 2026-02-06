/**
 * @file useDOM.ts - DOM manipulation Hooks
 * @description Declarative React Hooks for browser/DOM APIs, automatically handles cleanup on unmount
 */

import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';

// ============ useWindowEvent ============

/**
 * React Hook: useWindowEvent
 *
 * Declaratively subscribe to window events.
 * The listener is automatically removed on unmount.
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   useWindowEvent('resize', () => {
 *     console.log('Window resized');
 *   });
 *
 *   useWindowEvent('focus', () => {
 *     console.log('Window focused');
 *   });
 *
 *   return <div>...</div>;
 * }
 * ```
 */
export function useWindowEvent<K extends keyof WindowEventMap>(
  eventName: K,
  handler: (event: WindowEventMap[K]) => void,
  options?: boolean | AddEventListenerOptions
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const listener = (event: WindowEventMap[K]) => {
      handlerRef.current(event);
    };

    window.addEventListener(eventName, listener, options);
    return () => window.removeEventListener(eventName, listener, options);
  }, [eventName, options]);
}

// ============ useDocumentEvent ============

/**
 * React Hook: useDocumentEvent
 *
 * Declaratively subscribe to document events.
 * The listener is automatically removed on unmount.
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   useDocumentEvent('mousedown', (e) => {
 *     console.log('Clicked at', e.clientX, e.clientY);
 *   });
 *
 *   useDocumentEvent('keydown', (e) => {
 *     if (e.key === 'Escape') {
 *       closeModal();
 *     }
 *   });
 *
 *   return <div>...</div>;
 * }
 * ```
 */
export function useDocumentEvent<K extends keyof DocumentEventMap>(
  eventName: K,
  handler: (event: DocumentEventMap[K]) => void,
  options?: boolean | AddEventListenerOptions
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const listener = (event: DocumentEventMap[K]) => {
      handlerRef.current(event);
    };

    document.addEventListener(eventName, listener, options);
    return () => document.removeEventListener(eventName, listener, options);
  }, [eventName, options]);
}

// ============ useInterval ============

/**
 * React Hook: useInterval
 *
 * Declarative setInterval that automatically clears on unmount.
 * Pass `null` as delay to pause the interval.
 *
 * @example
 * ```tsx
 * function AutoRefresh() {
 *   const [count, setCount] = useState(0);
 *
 *   // Refresh every 30 seconds
 *   useInterval(() => {
 *     setCount(c => c + 1);
 *     refreshData();
 *   }, 30000);
 *
 *   // Conditionally pause
 *   useInterval(() => {
 *     tick();
 *   }, isPaused ? null : 1000);
 *
 *   return <div>Refreshed {count} times</div>;
 * }
 * ```
 */
export function useInterval(callback: () => void, delay: number | null): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (delay === null) return;

    const id = setInterval(() => {
      callbackRef.current();
    }, delay);

    return () => clearInterval(id);
  }, [delay]);
}

// ============ useTimeout ============

/**
 * React Hook: useTimeout
 *
 * Declarative setTimeout that automatically clears on unmount.
 * Returns a reset function to restart the timer.
 * Pass `null` as delay to disable.
 *
 * @example
 * ```tsx
 * function Notification({ message }) {
 *   const [visible, setVisible] = useState(true);
 *
 *   // Auto-hide after 3 seconds
 *   useTimeout(() => {
 *     setVisible(false);
 *   }, 3000);
 *
 *   return visible ? <div>{message}</div> : null;
 * }
 * ```
 */
export function useTimeout(
  callback: () => void,
  delay: number | null
): { reset: () => void; clear: () => void } {
  const callbackRef = useRef(callback);
  const timeoutIdRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  callbackRef.current = callback;

  const clear = useCallback(() => {
    if (timeoutIdRef.current !== null) {
      clearTimeout(timeoutIdRef.current);
      timeoutIdRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    clear();
    if (delay !== null) {
      timeoutIdRef.current = setTimeout(() => {
        callbackRef.current();
      }, delay);
    }
  }, [delay, clear]);

  useEffect(() => {
    reset();
    return clear;
  }, [delay, reset, clear]);

  return { reset, clear };
}

// ============ useClickOutside ============

/**
 * React Hook: useClickOutside
 *
 * Detects clicks outside a referenced element.
 * Useful for closing dropdowns, modals, and context menus.
 *
 * @example
 * ```tsx
 * function Dropdown() {
 *   const [isOpen, setIsOpen] = useState(false);
 *   const dropdownRef = useRef<HTMLDivElement>(null);
 *
 *   useClickOutside(dropdownRef, () => {
 *     setIsOpen(false);
 *   });
 *
 *   return (
 *     <div ref={dropdownRef}>
 *       <button onClick={() => setIsOpen(!isOpen)}>Toggle</button>
 *       {isOpen && <ul>...</ul>}
 *     </div>
 *   );
 * }
 * ```
 */
export function useClickOutside<T extends HTMLElement = HTMLElement>(
  ref: RefObject<T | null>,
  handler: (event: MouseEvent | TouchEvent) => void,
  enabled = true
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!enabled) return;

    const listener = (event: MouseEvent | TouchEvent) => {
      const el = ref.current;
      // Do nothing if clicking ref's element or its descendants
      if (!el || el.contains(event.target as Node)) {
        return;
      }
      handlerRef.current(event);
    };

    document.addEventListener('mousedown', listener);
    document.addEventListener('touchstart', listener);

    return () => {
      document.removeEventListener('mousedown', listener);
      document.removeEventListener('touchstart', listener);
    };
  }, [ref, enabled]);
}

// ============ useEscapeKey ============

/**
 * React Hook: useEscapeKey
 *
 * Calls handler when Escape key is pressed.
 * Commonly used alongside useClickOutside for modals/dropdowns.
 *
 * @example
 * ```tsx
 * function Modal({ onClose }) {
 *   useEscapeKey(onClose);
 *
 *   return <div className="modal">...</div>;
 * }
 * ```
 */
export function useEscapeKey(handler: () => void, enabled = true): void {
  useDocumentEvent('keydown', (e) => {
    if (enabled && e.key === 'Escape') {
      handler();
    }
  });
}

// ============ useIntersectionObserver ============

/**
 * React Hook: useIntersectionObserver
 *
 * Wrapper for IntersectionObserver to track element visibility.
 * Automatically disconnects on unmount.
 *
 * @example
 * ```tsx
 * function LazyImage({ src }) {
 *   const imgRef = useRef<HTMLImageElement>(null);
 *   const { isIntersecting, entry } = useIntersectionObserver(imgRef, {
 *     rootMargin: '200px',
 *     threshold: 0.1,
 *   });
 *
 *   return (
 *     <img
 *       ref={imgRef}
 *       src={isIntersecting ? src : placeholder}
 *       alt="Lazy loaded"
 *     />
 *   );
 * }
 * ```
 */
export function useIntersectionObserver<T extends HTMLElement = HTMLElement>(
  ref: RefObject<T | null>,
  options?: IntersectionObserverInit
): {
  isIntersecting: boolean;
  entry: IntersectionObserverEntry | null;
} {
  const [entry, setEntry] = useState<IntersectionObserverEntry | null>(null);

  // Memoize options to prevent infinite re-subscription when caller passes inline object
  // Note: threshold can be a number or array, so we JSON.stringify it for stable comparison
  const memoizedOptions = useMemo(
    () => options,
    [
      options?.root,
      options?.rootMargin,
      // eslint-disable-next-line react-hooks/exhaustive-deps
      JSON.stringify(options?.threshold),
    ]
  );

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const observer = new IntersectionObserver(([entry]) => {
      setEntry(entry);
    }, memoizedOptions);

    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [ref, memoizedOptions]);

  return {
    isIntersecting: entry?.isIntersecting ?? false,
    entry,
  };
}

// ============ useAnimationFrame ============

/**
 * React Hook: useAnimationFrame
 *
 * Runs a callback on every animation frame.
 * Automatically cancels on unmount.
 *
 * @example
 * ```tsx
 * function AnimatedComponent() {
 *   const [position, setPosition] = useState(0);
 *
 *   useAnimationFrame((deltaTime) => {
 *     setPosition(p => p + deltaTime * 0.1);
 *   });
 *
 *   return <div style={{ transform: `translateX(${position}px)` }} />;
 * }
 * ```
 */
export function useAnimationFrame(callback: (deltaTime: number) => void, enabled = true): void {
  const callbackRef = useRef(callback);
  const frameRef = useRef<number | null>(null);
  const previousTimeRef = useRef<number | null>(null);

  callbackRef.current = callback;

  useEffect(() => {
    if (!enabled) return;

    const animate = (time: number) => {
      if (previousTimeRef.current !== null) {
        const deltaTime = time - previousTimeRef.current;
        callbackRef.current(deltaTime);
      }
      previousTimeRef.current = time;
      frameRef.current = requestAnimationFrame(animate);
    };

    frameRef.current = requestAnimationFrame(animate);

    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
      }
    };
  }, [enabled]);
}

// ============ useRequestAnimationFrame ============

/**
 * React Hook: useRequestAnimationFrame
 *
 * Returns a function that schedules a callback to run on the next animation frame.
 * Automatically cancels pending frames on unmount.
 * Useful for throttling DOM updates.
 *
 * @example
 * ```tsx
 * function ScrollTracker() {
 *   const scheduleUpdate = useRequestAnimationFrame();
 *
 *   const handleScroll = () => {
 *     scheduleUpdate(() => {
 *       // This runs on next frame, automatically deduped
 *       updatePosition();
 *     });
 *   };
 *
 *   return <div onScroll={handleScroll}>...</div>;
 * }
 * ```
 */
export function useRequestAnimationFrame(): (callback: () => void) => void {
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
      }
    };
  }, []);

  return useCallback((callback: () => void) => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
    }
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      callback();
    });
  }, []);
}
