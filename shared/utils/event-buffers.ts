/**
 * @file Event Buffers & Utilities
 * @description Event buffering, coalescing, debouncing and relay utilities.
 * @depends emitter from event.ts, lifecycle
 */

import type { IDisposable } from './lifecycle';
import { Emitter, type EventHandler, type IEvent } from './event';

// ============ Debounce Event (Legacy - backward compatible) ============

/**
 * Options for debouncing events.
 */
export interface DebounceOptions {
  /** Delay in milliseconds */
  delay: number;
  /** If true, fire on the leading edge instead of trailing */
  leading?: boolean;
  /** Maximum time to wait before forcing a fire */
  maxWait?: number;
}

/**
 * Debounces an event, merging rapid fires into one.
 *
 * Use case: File watcher events - many changes in quick succession
 * should be merged into one "files changed" event.
 *
 * @example
 * ```typescript
 * const debouncedFileChange = debounceEvent(
 *   fileWatcher.onDidChange,
 *   (paths) => paths, // merge function: collect all paths
 *   { delay: 100 }
 * );
 *
 * debouncedFileChange((paths) => {
 *   console.log('Files changed:', paths);
 * });
 * ```
 */
export function debounceEvent<T, R>(
  event: IEvent<T>,
  merge: (last: R | undefined, current: T) => R,
  options: DebounceOptions
): IEvent<R> {
  const { delay, leading = false, maxWait } = options;

  return (listener: EventHandler<R>): IDisposable => {
    let merged: R | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let maxTimeout: ReturnType<typeof setTimeout> | undefined;
    let hasLeadingFired = false;

    const flush = () => {
      if (merged !== undefined) {
        const toFire = merged;
        merged = undefined;
        hasLeadingFired = false;
        listener(toFire);
      }
    };

    const eventDisposable = event((e) => {
      merged = merge(merged, e);

      // Leading edge fire
      if (leading && !hasLeadingFired) {
        hasLeadingFired = true;
        flush();
        return;
      }

      if (timeout !== undefined) {
        clearTimeout(timeout);
      }

      timeout = setTimeout(() => {
        timeout = undefined;
        if (maxTimeout !== undefined) {
          clearTimeout(maxTimeout);
          maxTimeout = undefined;
        }
        flush();
      }, delay);

      if (maxWait !== undefined && maxTimeout === undefined) {
        maxTimeout = setTimeout(() => {
          maxTimeout = undefined;
          if (timeout !== undefined) {
            clearTimeout(timeout);
            timeout = undefined;
          }
          flush();
        }, maxWait);
      }
    });

    return {
      dispose: () => {
        eventDisposable.dispose();
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
        if (maxTimeout !== undefined) {
          clearTimeout(maxTimeout);
        }
      },
    };
  };
}

// ============ Event Buffer ============

/**
 * Buffers events and releases them in animation frames (browser only).
 * In Node.js, uses setImmediate/setTimeout as fallback.
 *
 * Use case: Log panel updates - hundreds of log lines arriving rapidly
 * should be batched and rendered in one go.
 *
 * @example
 * ```typescript
 * const logBuffer = new EventBuffer<LogEntry>();
 *
 * compilerOutput.onLog((entry) => {
 *   logBuffer.push(entry);
 * });
 *
 * logBuffer.onFlush((entries) => {
 *   // Update UI with all entries at once
 *   appendToLogPanel(entries);
 * });
 * ```
 */
export class EventBuffer<T> implements IDisposable {
  private _buffer: T[] = [];
  private _scheduled = false;
  private _disposed = false;
  private _onFlush = new Emitter<T[]>();

  /**
   * Event fired when the buffer is flushed.
   */
  readonly onFlush = this._onFlush.event;

  /**
   * Push an item to the buffer.
   * The buffer will be flushed on the next animation frame (or setImmediate in Node).
   */
  push(item: T): void {
    if (this._disposed) return;

    this._buffer.push(item);

    if (!this._scheduled) {
      this._scheduled = true;
      // Use requestAnimationFrame in browser, setImmediate/setTimeout in Node.js
      const hasRAF = typeof globalThis !== 'undefined' && 'requestAnimationFrame' in globalThis;
      const schedule = hasRAF
        ? (fn: () => void) =>
            (
              globalThis as unknown as { requestAnimationFrame: (fn: () => void) => number }
            ).requestAnimationFrame(fn)
        : typeof setImmediate !== 'undefined'
          ? setImmediate
          : (fn: () => void) => setTimeout(fn, 0);

      schedule(() => {
        if (this._disposed) return;
        this._scheduled = false;
        this.flush();
      });
    }
  }

  /**
   * Push multiple items to the buffer.
   */
  pushMany(items: T[]): void {
    for (const item of items) {
      this.push(item);
    }
  }

  /**
   * Manually flush the buffer.
   */
  flush(): void {
    if (this._buffer.length === 0) return;

    const toFlush = this._buffer;
    this._buffer = [];
    this._onFlush.fire(toFlush);
  }

  /**
   * Get the current buffer size.
   */
  get size(): number {
    return this._buffer.length;
  }

  dispose(): void {
    this._disposed = true;
    this._buffer = [];
    this._onFlush.dispose();
  }
}

// ============ Event Coalescer ============

/**
 * Collects events over a time window and emits them as a batch.
 * Unlike EventBuffer, this has a configurable flush interval.
 *
 * Use case: Network request batching - collect multiple API calls
 * and send them as one batched request.
 *
 * @example
 * ```typescript
 * const requestCoalescer = new EventCoalescer<APIRequest>(100);
 *
 * requestCoalescer.onFlush((requests) => {
 *   sendBatchedRequest(requests);
 * });
 *
 * // These will be batched together
 * requestCoalescer.add(request1);
 * requestCoalescer.add(request2);
 * requestCoalescer.add(request3);
 * ```
 */
export class EventCoalescer<T> implements IDisposable {
  private _buffer: T[] = [];
  private _timeout: ReturnType<typeof setTimeout> | undefined;
  private _disposed = false;
  private _onFlush = new Emitter<T[]>();

  readonly onFlush = this._onFlush.event;

  constructor(private readonly _delay: number) {}

  /**
   * Add an item to be coalesced.
   */
  add(item: T): void {
    if (this._disposed) return;

    this._buffer.push(item);

    if (this._timeout !== undefined) {
      clearTimeout(this._timeout);
    }

    this._timeout = setTimeout(() => {
      this.flush();
    }, this._delay);
  }

  /**
   * Manually flush all coalesced items.
   */
  flush(): void {
    if (this._timeout !== undefined) {
      clearTimeout(this._timeout);
      this._timeout = undefined;
    }

    if (this._buffer.length === 0) return;

    const toFlush = this._buffer;
    this._buffer = [];
    this._onFlush.fire(toFlush);
  }

  dispose(): void {
    this._disposed = true;
    if (this._timeout !== undefined) {
      clearTimeout(this._timeout);
    }
    this._buffer = [];
    this._onFlush.dispose();
  }
}

// ============ Relay ============

/**
 * Relays events from a source to multiple listeners.
 * Useful when you want to switch the source dynamically.
 *
 * @example
 * ```typescript
 * const relay = new Relay<FileChange>();
 *
 * // Subscribe to relay
 * relay.event((change) => handleFileChange(change));
 *
 * // Switch source
 * relay.input = localFileWatcher.onDidChange;
 * // Later...
 * relay.input = remoteFileWatcher.onDidChange;
 * ```
 */
export class Relay<T> implements IDisposable {
  private _inputDisposable: IDisposable | undefined;
  private _emitter = new Emitter<T>();
  private _disposed = false;

  readonly event = this._emitter.event;

  set input(event: IEvent<T> | undefined) {
    this._inputDisposable?.dispose();
    this._inputDisposable = event?.((e) => {
      if (!this._disposed) {
        this._emitter.fire(e);
      }
    });
  }

  dispose(): void {
    this._disposed = true;
    this._inputDisposable?.dispose();
    this._emitter.dispose();
  }
}
