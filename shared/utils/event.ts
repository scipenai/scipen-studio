/**
 * @file Event Utilities
 * @description Prevents event storms from freezing the UI, especially during heavy operations like npm install or file watching
 * @depends lifecycle
 *
 * Borrowed from VS Code's event patterns (src/vs/base/common/event.ts).
 * This file is shared between Main and Renderer processes.
 * React hooks are kept in the renderer's hooks directory.
 */

import { Disposable, DisposableStore, type IDisposable, combinedDisposable } from './lifecycle';

// ============ Symbol for Microtask Delay ============

export const MicrotaskDelay = Symbol('MicrotaskDelay');

// ============ Types ============

/**
 * A function that handles events.
 */
export type EventHandler<T> = (event: T) => void;

/**
 * An event interface that can be subscribed to.
 */
export type IEvent<T> = (
  listener: (e: T) => unknown,
  thisArgs?: unknown,
  disposables?: IDisposable[] | DisposableStore
) => IDisposable;

// Alias for compatibility
export type Event<T> = IEvent<T>;

// ============ Emitter Options ============

/**
 * Global error handler for Emitter events.
 * This allows centralized error reporting/logging in production.
 *
 * @example
 * ```typescript
 * // In your app initialization
 * setEmitterErrorHandler((error, emitter, event) => {
 *   logger.error('Event listener error', { error, event });
 *   Sentry.captureException(error);
 * });
 * ```
 */
export type EmitterErrorHandler = (
  error: unknown,
  emitter?: Emitter<unknown>,
  event?: unknown
) => void;

let GlobalEmitterErrorHandler: EmitterErrorHandler | undefined;

/**
 * Set a global error handler for all Emitter instances.
 * When set, this handler is called whenever a listener throws an error.
 * The default behavior (console.error) is still executed after the handler.
 *
 * @param handler The error handler function, or undefined to clear
 */
export function setEmitterErrorHandler(handler: EmitterErrorHandler | undefined): void {
  GlobalEmitterErrorHandler = handler;
}

/**
 * Get the current global error handler
 */
export function getEmitterErrorHandler(): EmitterErrorHandler | undefined {
  return GlobalEmitterErrorHandler;
}

/**
 * Emitter constructor options
 * Used for listener lifecycle management
 */
export interface EmitterOptions {
  /** Called before adding the first listener */
  onWillAddFirstListener?: () => void;
  /** Called after adding the first listener */
  onDidAddFirstListener?: () => void;
  /** Called before removing a listener */
  onWillRemoveListener?: () => void;
  /** Called after removing the last listener */
  onDidRemoveLastListener?: () => void;
  /**
   * Custom error handler for this specific emitter instance.
   * If provided, this is called instead of the global handler.
   */
  onListenerError?: (error: unknown, event?: unknown) => void;
}

// ============ Emitter ============

/**
 * Simple event emitter implementation.
 * Use this to create custom events in your components.
 *
 * @example
 * ```typescript
 * class FileWatcher {
 *   private _onDidChange = new Emitter<string>();
 *   readonly onDidChange = this._onDidChange.event;
 *
 *   private handleFileChange(path: string) {
 *     this._onDidChange.fire(path);
 *   }
 * }
 * ```
 */
export class Emitter<T> implements IDisposable {
  private _listeners = new Set<{ listener: (e: T) => unknown; thisArgs?: unknown }>();
  private _disposed = false;
  private _options?: EmitterOptions;
  private _event?: IEvent<T>;

  constructor(options?: EmitterOptions) {
    this._options = options;
  }

  /**
   * The event that can be subscribed to.
   */
  get event(): IEvent<T> {
    if (!this._event) {
      this._event = (
        listener: (e: T) => unknown,
        thisArgs?: unknown,
        disposables?: IDisposable[] | DisposableStore
      ): IDisposable => {
        if (this._disposed) {
          return Disposable.None;
        }

        const firstListener = this._listeners.size === 0;

        if (firstListener && this._options?.onWillAddFirstListener) {
          this._options.onWillAddFirstListener();
        }

        const entry = { listener, thisArgs };
        this._listeners.add(entry);

        if (firstListener && this._options?.onDidAddFirstListener) {
          this._options.onDidAddFirstListener();
        }

        const result: IDisposable = {
          dispose: () => {
            if (this._disposed) {
              return;
            }

            if (this._options?.onWillRemoveListener) {
              this._options.onWillRemoveListener();
            }

            this._listeners.delete(entry);

            if (this._listeners.size === 0 && this._options?.onDidRemoveLastListener) {
              this._options.onDidRemoveLastListener();
            }
          },
        };

        if (disposables) {
          if (disposables instanceof DisposableStore) {
            disposables.add(result);
          } else {
            disposables.push(result);
          }
        }

        return result;
      };
    }
    return this._event;
  }

  /**
   * Fire the event, notifying all listeners.
   *
   * Errors in listeners are caught and handled via:
   * 1. Instance-level onListenerError (if provided in EmitterOptions)
   * 2. Global error handler (if set via setEmitterErrorHandler)
   * 3. Console.error (always, as fallback)
   */
  fire(event: T): void {
    if (this._disposed) return;

    // Create a copy to prevent modification during iteration
    const listeners = [...this._listeners];
    for (const { listener, thisArgs } of listeners) {
      try {
        listener.call(thisArgs, event);
      } catch (e) {
        // Call instance-level error handler if provided
        if (this._options?.onListenerError) {
          try {
            this._options.onListenerError(e, event);
          } catch (handlerError) {
            console.error('[Emitter] Error in onListenerError handler:', handlerError);
          }
        }
        // Call global error handler if set
        else if (GlobalEmitterErrorHandler) {
          try {
            GlobalEmitterErrorHandler(e, this as unknown as Emitter<unknown>, event);
          } catch (handlerError) {
            console.error('[Emitter] Error in global error handler:', handlerError);
          }
        }
        // Always log to console as fallback
        console.error('[Emitter] Listener threw error:', e);
      }
    }
  }

  /**
   * Check if there are any listeners.
   */
  hasListeners(): boolean {
    return this._listeners.size > 0;
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._listeners.clear();
    this._options = undefined;
  }
}

// ============ Event Namespace ============

/**
 * Event namespace provides a series of event handling utility functions
 *
 * Borrowed from VS Code's Event namespace (src/vs/base/common/event.ts)
 */
export namespace Event {
  /**
   * Empty event, never fires
   */
  export const None: IEvent<unknown> = () => Disposable.None;

  /**
   * Add IDisposable to storage
   */
  function addAndReturnDisposable<T extends IDisposable>(
    d: T,
    store: DisposableStore | IDisposable[] | undefined
  ): T {
    if (store instanceof Array) {
      store.push(d);
    } else if (store) {
      store.add(d);
    }
    return d;
  }

  /**
   * Event that only fires once
   *
   * @example
   * ```typescript
   * Event.once(button.onClick)(() => {
   *   console.log('Button clicked for the first time!');
   * });
   * ```
   */
  export function once<T>(event: IEvent<T>): IEvent<T> {
    return (listener, thisArgs = null, disposables?) => {
      let didFire = false;
      let result: IDisposable | undefined = undefined;

      result = event(
        (e) => {
          if (didFire) {
            return;
          } else if (result) {
            result.dispose();
          } else {
            didFire = true;
          }
          return listener.call(thisArgs, e);
        },
        null,
        disposables
      );

      if (didFire) {
        result.dispose();
      }

      return result;
    };
  }

  /**
   * Transform event data
   *
   * @example
   * ```typescript
   * const onNameChange = Event.map(onPersonChange, person => person.name);
   * ```
   */
  export function map<I, O>(
    event: IEvent<I>,
    mapFn: (i: I) => O,
    disposable?: DisposableStore
  ): IEvent<O> {
    const result: IEvent<O> = (listener, thisArgs = null, disposables?) => {
      return event((i) => listener.call(thisArgs, mapFn(i)), null, disposables);
    };

    if (disposable) {
      const emitter = new Emitter<O>();
      const subscription = event((i) => emitter.fire(mapFn(i)));
      disposable.add(emitter);
      disposable.add(subscription);
      return emitter.event;
    }

    return result;
  }

  /**
   * Filter events
   *
   * @example
   * ```typescript
   * const onErrorLog = Event.filter(onLog, entry => entry.level === 'error');
   * ```
   */
  export function filter<T>(
    event: IEvent<T>,
    filterFn: (e: T) => boolean,
    disposable?: DisposableStore
  ): IEvent<T>;
  export function filter<T, R extends T>(
    event: IEvent<T>,
    filterFn: (e: T) => e is R,
    disposable?: DisposableStore
  ): IEvent<R>;
  export function filter<T>(
    event: IEvent<T>,
    filterFn: (e: T) => boolean,
    disposable?: DisposableStore
  ): IEvent<T> {
    const result: IEvent<T> = (listener, thisArgs = null, disposables?) => {
      return event((e) => filterFn(e) && listener.call(thisArgs, e), null, disposables);
    };

    if (disposable) {
      const emitter = new Emitter<T>();
      const subscription = event((e) => {
        if (filterFn(e)) {
          emitter.fire(e);
        }
      });
      disposable.add(emitter);
      disposable.add(subscription);
      return emitter.event;
    }

    return result;
  }

  /**
   * Merge multiple events into one
   *
   * @example
   * ```typescript
   * const onAnyFileChange = Event.any(
   *   fileWatcher.onDidCreate,
   *   fileWatcher.onDidChange,
   *   fileWatcher.onDidDelete
   * );
   * ```
   */
  export function any<T>(...events: IEvent<T>[]): IEvent<T>;
  export function any(...events: IEvent<unknown>[]): IEvent<void>;
  export function any<T>(...events: IEvent<T>[]): IEvent<T> {
    return (listener, thisArgs = null, disposables?) => {
      const disposable = combinedDisposable(
        ...events.map((event) => event((e) => listener.call(thisArgs, e)))
      );
      return addAndReturnDisposable(disposable, disposables);
    };
  }

  /**
   * Convert event to signal (void event)
   */
  export function signal<T>(event: IEvent<T>): IEvent<void> {
    return event as IEvent<unknown> as IEvent<void>;
  }

  /**
   * Reduce operation on events
   *
   * @example
   * ```typescript
   * const onTotalChange = Event.reduce(
   *   onValueChange,
   *   (total, value) => total + value,
   *   0
   * );
   * ```
   */
  export function reduce<I, O>(
    event: IEvent<I>,
    merge: (last: O | undefined, current: I) => O,
    initial?: O,
    disposable?: DisposableStore
  ): IEvent<O> {
    let output: O | undefined = initial;
    return map<I, O>(
      event,
      (e) => {
        output = merge(output, e);
        return output;
      },
      disposable
    );
  }

  /**
   * Debounce event with merge function support
   *
   * @example
   * ```typescript
   * const debouncedFileChanges = Event.debounce(
   *   fileWatcher.onDidChange,
   *   (paths, path) => paths ? [...paths, path] : [path],
   *   { delay: 100 }
   * );
   *
   * debouncedFileChanges(paths => {
   *   console.log('Changed files:', paths);
   * });
   * ```
   */
  export function debounce<T>(
    event: IEvent<T>,
    merge: (last: T | undefined, current: T) => T,
    options?: {
      delay?: number | typeof MicrotaskDelay;
      leading?: boolean;
      flushOnListenerRemove?: boolean;
    },
    disposable?: DisposableStore
  ): IEvent<T>;
  export function debounce<I, O>(
    event: IEvent<I>,
    merge: (last: O | undefined, current: I) => O,
    options?: {
      delay?: number | typeof MicrotaskDelay;
      leading?: boolean;
      flushOnListenerRemove?: boolean;
    },
    disposable?: DisposableStore
  ): IEvent<O>;
  export function debounce<I, O>(
    event: IEvent<I>,
    merge: (last: O | undefined, current: I) => O,
    options: {
      delay?: number | typeof MicrotaskDelay;
      leading?: boolean;
      flushOnListenerRemove?: boolean;
    } = {},
    disposable?: DisposableStore
  ): IEvent<O> {
    const { delay = 100, leading = false, flushOnListenerRemove = false } = options;

    let subscription: IDisposable;
    let output: O | undefined = undefined;
    let handle: ReturnType<typeof setTimeout> | undefined | null = undefined;
    let numDebouncedCalls = 0;
    let doFire: (() => void) | undefined;

    const emitter = new Emitter<O>({
      onWillAddFirstListener() {
        subscription = event((cur) => {
          numDebouncedCalls++;
          output = merge(output, cur);

          if (leading && !handle) {
            emitter.fire(output);
            output = undefined;
          }

          doFire = () => {
            const Output = output;
            output = undefined;
            handle = undefined;
            if (!leading || numDebouncedCalls > 1) {
              emitter.fire(Output!);
            }
            numDebouncedCalls = 0;
          };

          if (typeof delay === 'number') {
            if (handle) {
              clearTimeout(handle);
            }
            handle = setTimeout(doFire, delay);
          } else {
            // MicrotaskDelay
            if (handle === undefined) {
              handle = null;
              queueMicrotask(doFire);
            }
          }
        });
      },
      onWillRemoveListener() {
        if (flushOnListenerRemove && numDebouncedCalls > 0) {
          doFire?.();
        }
      },
      onDidRemoveLastListener() {
        subscription?.dispose();
        if (handle !== undefined && handle !== null) {
          clearTimeout(handle);
        }
        handle = undefined;
        output = undefined;
      },
    });

    disposable?.add(emitter);

    return emitter.event;
  }

  /**
   * Defer event (convert to void signal)
   * Postpone event to next macrotask
   */
  export function defer(event: IEvent<unknown>, disposable?: DisposableStore): IEvent<void> {
    return debounce<unknown, void>(event, () => void 0, { delay: 0 }, disposable);
  }

  /**
   * Buffer events
   *
   * On first listener addition, all buffered events are fired first,
   * then subsequent events are forwarded normally.
   *
   * @example
   * ```typescript
   * // Even if event fires before adding listener, listener will receive it
   * const bufferedEvent = Event.buffer(someAsyncEvent);
   *
   * // Add listener later
   * bufferedEvent(value => console.log(value));
   * ```
   */
  export function buffer<T>(
    event: IEvent<T>,
    flushAfterTimeout = false,
    _buffer: T[] = [],
    disposable?: DisposableStore
  ): IEvent<T> {
    let buffer: T[] | null = _buffer.slice();
    let listener: IDisposable | null = event((e) => {
      if (buffer) {
        buffer.push(e);
      } else {
        emitter.fire(e);
      }
    });

    // Track the flush timeout so we can cancel it on dispose
    let flushTimeoutId: ReturnType<typeof setTimeout> | undefined;
    // Track if emitter is disposed to prevent firing after cleanup
    let isDisposed = false;

    if (flushAfterTimeout && buffer.length > 0) {
      flushTimeoutId = setTimeout(() => {
        flushTimeoutId = undefined;
        // Don't fire events if already disposed
        if (!isDisposed && buffer) {
          buffer.forEach((e) => emitter.fire(e));
          buffer = null;
        }
      });
    }

    const emitter = new Emitter<T>({
      onWillAddFirstListener() {
        if (!listener) {
          listener = event((e) => emitter.fire(e));
        }
      },
      onDidAddFirstListener() {
        if (buffer) {
          buffer.forEach((e) => emitter.fire(e));
          buffer = null;
        }
        // Clear the timeout since we've flushed manually
        if (flushTimeoutId !== undefined) {
          clearTimeout(flushTimeoutId);
          flushTimeoutId = undefined;
        }
      },
      onDidRemoveLastListener() {
        isDisposed = true;
        listener?.dispose();
        listener = null;
        // Clean up any pending timeout
        if (flushTimeoutId !== undefined) {
          clearTimeout(flushTimeoutId);
          flushTimeoutId = undefined;
        }
      },
    });

    disposable?.add(emitter);

    return emitter.event;
  }

  /**
   * Create an event that fires once when condition is met
   */
  export function onceIf<T>(event: IEvent<T>, condition: (e: T) => boolean): IEvent<T> {
    return once(filter(event, condition));
  }
}

// ============ Re-exports from event-buffers.ts ============

export { debounceEvent, EventBuffer, EventCoalescer, Relay } from './event-buffers';
export type { DebounceOptions } from './event-buffers';
