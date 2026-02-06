/**
 * @file Async Utilities
 * @description Decouples high-frequency user actions from heavy background tasks, ensuring UI remains responsive
 * @depends cancellation, lifecycle
 *
 * Borrowed from VS Code's async patterns (src/vs/base/common/async.ts).
 * Key Classes:
 * - Throttler: Ensures only one async task runs at a time, queuing the latest request
 * - Delayer: Debounces tasks with Promise support (ideal for auto-save/compile)
 * - Sequencer: Ensures tasks run in strict order (ideal for file writes)
 * - RunOnceScheduler: Runs a task once after a delay, cancellable
 * - IdleValue: Computes a value during idle time
 */

import { CancellationError, type CancellationToken, CancellationTokenSource } from './cancellation';
import type { IDisposable } from './lifecycle';

// Re-export for convenience
export { CancellationToken, CancellationTokenSource, CancellationError } from './cancellation';

// ============ Node.js/Browser Compatibility ============

// Polyfill for queueMicrotask (Node.js < 11)
const QueueMicrotask: (fn: () => void) => void =
  typeof queueMicrotask !== 'undefined' ? queueMicrotask : (fn) => Promise.resolve().then(fn);

// Polyfill for requestIdleCallback (Node.js)
interface IdleDeadline {
  didTimeout: boolean;
  timeRemaining(): number;
}

// Type guard for browser environment
const HasRequestIdleCallback =
  typeof globalThis !== 'undefined' && 'requestIdleCallback' in globalThis;

const RequestIdleCallback: (
  callback: (deadline: IdleDeadline) => void,
  options?: { timeout?: number }
) => number = HasRequestIdleCallback
  ? (
      globalThis as unknown as {
        requestIdleCallback: (
          callback: (deadline: IdleDeadline) => void,
          options?: { timeout?: number }
        ) => number;
      }
    ).requestIdleCallback
  : (callback: (deadline: IdleDeadline) => void, options?: { timeout?: number }) => {
      const start = Date.now();
      return setTimeout(() => {
        callback({
          didTimeout: options?.timeout ? Date.now() - start > options.timeout : false,
          timeRemaining: () => Math.max(0, 50 - (Date.now() - start)),
        });
      }, 1) as unknown as number;
    };

const CancelIdleCallback: (handle: number) => void = HasRequestIdleCallback
  ? (globalThis as unknown as { cancelIdleCallback: (handle: number) => void }).cancelIdleCallback
  : (handle: number) => clearTimeout(handle);

// Export polyfilled versions for consistent cross-environment usage
export const safeRequestIdleCallback = RequestIdleCallback;
export const safeCancelIdleCallback = CancelIdleCallback;

// ============ Cancellable Task Interface ============

/**
 * A task factory that accepts a CancellationToken.
 */
export type ICancellableTask<T> = (token: CancellationToken) => Promise<T>;

/**
 * A simple task factory (no cancellation).
 */
export type ITask<T> = () => T;

// ============ Throttler ============

/**
 * Throttler ensures that only one async task is running at a time.
 * If a new task is queued while another is running, only the latest
 * queued task will be executed after the current one completes.
 *
 * Use case: AI completion requests - if user types fast, we only want
 * the latest request to go through.
 *
 * @example
 * ```typescript
 * const throttler = new Throttler();
 *
 * async function requestCompletion(text: string) {
 *   return throttler.queue((token) => fetchAICompletion(text, token));
 * }
 *
 * // Later: cancel all pending requests
 * throttler.dispose();
 * ```
 */
export class Throttler implements IDisposable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Generic internal state requires any for type flexibility
  private activePromise: Promise<any> | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private queuedPromise: Promise<any> | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private queuedPromiseFactory: ICancellableTask<any> | null = null;
  private cancellationTokenSource: CancellationTokenSource;

  constructor() {
    this.cancellationTokenSource = new CancellationTokenSource();
  }

  /**
   * Returns true if a task is currently running or queued.
   * Useful for UI state management (e.g., showing "compiling" indicator).
   */
  get isThrottling(): boolean {
    return this.activePromise !== null;
  }

  /**
   * Queue a task. If a task is already running, queue this one.
   * Only the latest queued task will run after the current one completes.
   *
   * @param promiseFactory Task factory that receives a CancellationToken
   */
  queue<T>(promiseFactory: ICancellableTask<T>): Promise<T> {
    if (this.cancellationTokenSource.token.isCancellationRequested) {
      return Promise.reject(new CancellationError('Throttler is disposed'));
    }

    if (this.activePromise) {
      this.queuedPromiseFactory = promiseFactory;

      if (!this.queuedPromise) {
        const onComplete = () => {
          this.queuedPromise = null;

          if (this.cancellationTokenSource.token.isCancellationRequested) {
            return Promise.reject(new CancellationError('Throttler is disposed'));
          }

          const result = this.queue(this.queuedPromiseFactory!);
          this.queuedPromiseFactory = null;
          return result;
        };

        this.queuedPromise = new Promise((resolve, reject) => {
          this.activePromise!.then(onComplete, onComplete).then(resolve, reject);
        });
      }

      return new Promise((resolve, reject) => {
        this.queuedPromise!.then(resolve, reject);
      });
    }

    // Pass CancellationToken to task factory
    this.activePromise = promiseFactory(this.cancellationTokenSource.token);

    return new Promise((resolve, reject) => {
      this.activePromise!.then(
        (result: T) => {
          this.activePromise = null;
          resolve(result);
        },
        (err: unknown) => {
          this.activePromise = null;
          reject(err);
        }
      );
    });
  }

  /**
   * Cancel all pending tasks and dispose the throttler.
   */
  dispose(): void {
    this.cancellationTokenSource.cancel();
    this.cancellationTokenSource.dispose();
  }
}

// ============ Sequencer ============

/**
 * Sequencer ensures that async tasks run in strict sequential order.
 * Each queued task waits for the previous one to complete before starting.
 *
 * Use case: File write operations - ensure writes happen in order.
 *
 * @example
 * ```typescript
 * const sequencer = new Sequencer();
 *
 * async function saveFile(content: string) {
 *   return sequencer.queue(() => writeFile(path, content));
 * }
 * ```
 */
export class Sequencer {
  private current: Promise<unknown> = Promise.resolve(null);

  queue<T>(promiseTask: () => Promise<T>): Promise<T> {
    return (this.current = this.current.then(
      () => promiseTask(),
      () => promiseTask()
    )) as Promise<T>;
  }
}

/**
 * SequencerByKey is like Sequencer but maintains separate queues per key.
 * Useful when you have multiple independent streams of sequential operations.
 *
 * Use case: Multiple files being saved simultaneously, each in order.
 */
export class SequencerByKey<TKey> {
  private promiseMap = new Map<TKey, Promise<unknown>>();

  queue<T>(key: TKey, promiseTask: () => Promise<T>): Promise<T> {
    const runningPromise = this.promiseMap.get(key) ?? Promise.resolve();
    const newPromise = runningPromise
      .catch(() => {})
      .then(promiseTask)
      .finally(() => {
        if (this.promiseMap.get(key) === newPromise) {
          this.promiseMap.delete(key);
        }
      });
    this.promiseMap.set(key, newPromise);
    return newPromise;
  }

  peek(key: TKey): Promise<unknown> | undefined {
    return this.promiseMap.get(key);
  }

  keys(): IterableIterator<TKey> {
    return this.promiseMap.keys();
  }
}

// ============ Delayer ============

/**
 * Symbol to indicate microtask delay (next microtask, not setTimeout).
 */
export const MicrotaskDelay = Symbol('MicrotaskDelay');

interface IScheduledLater extends IDisposable {
  isTriggered(): boolean;
}

const timeoutDeferred = (timeout: number, fn: () => void): IScheduledLater => {
  let scheduled = true;
  const handle = setTimeout(() => {
    scheduled = false;
    fn();
  }, timeout);
  return {
    isTriggered: () => scheduled,
    dispose: () => {
      clearTimeout(handle);
      scheduled = false;
    },
  };
};

const microtaskDeferred = (fn: () => void): IScheduledLater => {
  let scheduled = true;
  QueueMicrotask(() => {
    if (scheduled) {
      scheduled = false;
      fn();
    }
  });
  return {
    isTriggered: () => scheduled,
    dispose: () => {
      scheduled = false;
    },
  };
};

/**
 * Delayer is an advanced debounce that returns a Promise.
 * It delays execution until a period of inactivity, then runs the latest task.
 *
 * Use case: Auto-save - wait for user to stop typing, then save.
 * Use case: Compile trigger - wait for user to stop typing, then compile.
 *
 * @example
 * ```typescript
 * const saveDelayer = new Delayer(500);
 *
 * function onContentChange(content: string) {
 *   saveDelayer.trigger(() => saveFile(content));
 * }
 *
 * // Dynamically adjust delay (e.g., increase when network is slow)
 * saveDelayer.setDelay(1000);
 *
 * // Execute immediately (e.g., user presses Ctrl+S)
 * saveDelayer.flush();
 *
 * // Cancel pending task
 * saveDelayer.cancel();
 * ```
 */
export class Delayer<T> implements IDisposable {
  private deferred: IScheduledLater | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Generic internal state requires any for type flexibility
  private completionPromise: Promise<any> | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private doResolve: ((value?: any) => void) | null = null;
  private doReject: ((err: unknown) => void) | null = null;
  private task: (() => T | Promise<T>) | null = null;
  private _defaultDelay: number | typeof MicrotaskDelay;

  constructor(defaultDelay: number | typeof MicrotaskDelay) {
    this._defaultDelay = defaultDelay;
  }

  /**
   * Get current default delay
   */
  get defaultDelay(): number | typeof MicrotaskDelay {
    return this._defaultDelay;
  }

  /**
   * Dynamically modify default delay time
   */
  setDelay(delay: number | typeof MicrotaskDelay): void {
    this._defaultDelay = delay;
  }

  /**
   * Trigger a task. If there's a pending task, cancel it and schedule this one.
   * Returns a Promise that resolves when the task completes.
   */
  trigger(task: () => T | Promise<T>, delay = this._defaultDelay): Promise<T> {
    this.task = task;
    this.cancelTimeout();

    if (!this.completionPromise) {
      this.completionPromise = new Promise((resolve, reject) => {
        this.doResolve = resolve;
        this.doReject = reject;
      }).then(() => {
        this.completionPromise = null;
        this.doResolve = null;
        if (this.task) {
          const task = this.task;
          this.task = null;
          return task();
        }
        return undefined;
      });
    }

    const fn = () => {
      this.deferred = null;
      this.doResolve?.(null);
    };

    this.deferred =
      delay === MicrotaskDelay ? microtaskDeferred(fn) : timeoutDeferred(delay as number, fn);

    return this.completionPromise;
  }

  /**
   * Check if a task is scheduled.
   */
  isTriggered(): boolean {
    return !!this.deferred?.isTriggered();
  }

  /**
   * Execute pending task immediately (without waiting for delay).
   *
   * Use case: User presses Ctrl+S to save immediately instead of waiting for debounce
   */
  flush(): Promise<T> | undefined {
    if (!this.isTriggered()) {
      return undefined;
    }

    this.cancelTimeout();

    if (this.doResolve) {
      this.doResolve(null);
    }

    return this.completionPromise ?? undefined;
  }

  /**
   * Cancel the pending task.
   */
  cancel(): void {
    this.cancelTimeout();
    if (this.completionPromise) {
      this.doReject?.(new CancellationError('Delayer cancelled'));
      this.completionPromise = null;
    }
  }

  private cancelTimeout(): void {
    this.deferred?.dispose();
    this.deferred = null;
  }

  dispose(): void {
    this.cancel();
  }
}

// ============ RunOnceScheduler ============

/**
 * RunOnceScheduler schedules a callback to run once after a delay.
 * The schedule can be cancelled or rescheduled.
 *
 * Use case: Delayed operations that can be cancelled (e.g., tooltip display).
 *
 * @example
 * ```typescript
 * const scheduler = new RunOnceScheduler(() => {
 *   showTooltip();
 * }, 500);
 *
 * scheduler.schedule();
 * // User moves mouse away:
 * scheduler.cancel();
 * ```
 */
export class RunOnceScheduler implements IDisposable {
  protected runner: ((...args: unknown[]) => void) | null;
  private timeoutToken: ReturnType<typeof setTimeout> | undefined;
  private timeout: number;
  private timeoutHandler: () => void;

  constructor(runner: (...args: unknown[]) => void, delay: number) {
    this.timeoutToken = undefined;
    this.runner = runner;
    this.timeout = delay;
    this.timeoutHandler = this.onTimeout.bind(this);
  }

  dispose(): void {
    this.cancel();
    this.runner = null;
  }

  cancel(): void {
    if (this.isScheduled()) {
      clearTimeout(this.timeoutToken);
      this.timeoutToken = undefined;
    }
  }

  schedule(delay = this.timeout): void {
    this.cancel();
    this.timeoutToken = setTimeout(this.timeoutHandler, delay);
  }

  get delay(): number {
    return this.timeout;
  }

  set delay(value: number) {
    this.timeout = value;
  }

  isScheduled(): boolean {
    return this.timeoutToken !== undefined;
  }

  flush(): void {
    if (this.isScheduled()) {
      this.cancel();
      this.doRun();
    }
  }

  private onTimeout() {
    this.timeoutToken = undefined;
    if (this.runner) {
      this.doRun();
    }
  }

  protected doRun(): void {
    this.runner?.();
  }
}

// ============ IdleValue ============

/**
 * IdleValue computes a value during browser/Node idle time.
 * The value is computed lazily when first accessed, or during idle.
 *
 * Use case: Heavy computation that can be deferred.
 *
 * @example
 * ```typescript
 * const expensiveData = new IdleValue(() => {
 *   return computeExpensiveData();
 * });
 *
 * // Value computed during idle, or on first access
 * const data = expensiveData.value;
 * ```
 */
export class IdleValue<T> implements IDisposable {
  private readonly _executor: () => T;
  private _handle: number | undefined;
  private _didRun = false;
  private _value?: T;
  private _error: unknown;

  constructor(executor: () => T) {
    this._executor = executor;
    this._handle = RequestIdleCallback(() => this._doRun());
  }

  private _doRun(): void {
    if (this._didRun) return;
    this._didRun = true;

    try {
      this._value = this._executor();
    } catch (err) {
      this._error = err;
    }
  }

  get value(): T {
    if (!this._didRun) {
      if (this._handle !== undefined) {
        CancelIdleCallback(this._handle);
        this._handle = undefined;
      }
      this._doRun();
    }
    if (this._error) {
      throw this._error;
    }
    return this._value!;
  }

  get isResolved(): boolean {
    return this._didRun;
  }

  dispose(): void {
    if (this._handle !== undefined) {
      CancelIdleCallback(this._handle);
      this._handle = undefined;
    }
  }
}

// ============ SimpleThrottle (Lightweight alternative for IPC throttling) ============

/**
 * SimpleThrottle - Rate-limits function calls.
 *
 * Unlike Throttler (which is for async task queuing), SimpleThrottle
 * simply limits how often a synchronous function can be called.
 *
 * Use case: Rate-limiting IPC events to prevent UI flooding.
 *
 * @example
 * ```typescript
 * const throttle = new SimpleThrottle(200);
 * const sendProgress = throttle.wrap((data: ProgressEvent) => {
 *   mainWindow.webContents.send('progress', data);
 * });
 *
 * // Can be called frequently - will be throttled
 * sendProgress({ progress: 10 });
 * sendProgress({ progress: 20 });
 *
 * // Cleanup
 * throttle.dispose();
 * ```
 */
export class SimpleThrottle implements IDisposable {
  private lastTime = 0;
  private pendingArgs: unknown[] | null = null;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly interval: number) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Generic wrapper requires any for arbitrary function signatures
  wrap<T extends (...args: any[]) => void>(fn: T): T {
    return ((...args: Parameters<T>) => {
      const now = Date.now();

      if (now - this.lastTime >= this.interval) {
        this.lastTime = now;
        fn(...args);
      } else {
        this.pendingArgs = args;
        if (!this.timeoutId) {
          const remaining = this.interval - (now - this.lastTime);
          this.timeoutId = setTimeout(() => {
            if (this.pendingArgs) {
              this.lastTime = Date.now();
              fn(...(this.pendingArgs as Parameters<T>));
              this.pendingArgs = null;
            }
            this.timeoutId = null;
          }, remaining);
        }
      }
    }) as T;
  }

  cancel(): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    this.pendingArgs = null;
  }

  dispose(): void {
    this.cancel();
  }
}

// ============ SimpleDelayer (Lightweight debounce for main process) ============

/**
 * SimpleDelayer - Lightweight debounce for the main process.
 *
 * @example
 * ```typescript
 * const delayer = new SimpleDelayer<void>(500);
 * delayer.trigger(() => saveFile(content));
 * ```
 */
export class SimpleDelayer<T> implements IDisposable {
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private resolve: ((value: T) => void) | null = null;
  private reject: ((err: unknown) => void) | null = null;
  private task: (() => T | Promise<T>) | null = null;

  constructor(private defaultDelay: number) {}

  trigger(task: () => T | Promise<T>, delay = this.defaultDelay): Promise<T> {
    this.cancel();
    this.task = task;

    return new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;

      this.timeoutId = setTimeout(async () => {
        this.timeoutId = null;
        const currentTask = this.task;
        this.task = null;

        if (currentTask) {
          try {
            const result = await currentTask();
            this.resolve?.(result);
          } catch (err) {
            this.reject?.(err);
          }
        }

        this.resolve = null;
        this.reject = null;
      }, delay);
    });
  }

  isTriggered(): boolean {
    return this.timeoutId !== null;
  }

  /**
   * Cancel the pending task.
   *
   * If there's a pending Promise from trigger(), it will be rejected
   * with a CancellationError to notify waiters that the task was cancelled.
   */
  cancel(): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    this.task = null;

    // Save reject reference before clearing
    const pendingReject = this.reject;
    this.resolve = null;
    this.reject = null;

    // Notify any waiting callers that the task was cancelled
    if (pendingReject) {
      pendingReject(new CancellationError('SimpleDelayer task cancelled'));
    }
  }

  dispose(): void {
    this.cancel();
  }
}

// ============ Utility Functions ============

/**
 * Creates a promise that resolves after a delay.
 */
export function timeout(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Type guard for browser environment
const HasRequestAnimationFrame =
  typeof globalThis !== 'undefined' && 'requestAnimationFrame' in globalThis;

/**
 * Creates a promise that resolves on the next animation frame (browser only).
 * In Node.js, uses setImmediate/setTimeout as fallback.
 */
export function nextAnimationFrame(): Promise<number> {
  if (HasRequestAnimationFrame) {
    return new Promise((resolve) =>
      (
        globalThis as unknown as { requestAnimationFrame: (fn: (time: number) => void) => number }
      ).requestAnimationFrame(resolve)
    );
  }
  return new Promise((resolve) => {
    const start = Date.now();
    const schedule =
      typeof setImmediate !== 'undefined' ? setImmediate : (fn: () => void) => setTimeout(fn, 0);
    schedule(() => resolve(Date.now() - start));
  });
}

/**
 * Creates a promise that resolves during idle time.
 */
export function nextIdleFrame(options?: { timeout?: number }): Promise<IdleDeadline> {
  return new Promise((resolve) => RequestIdleCallback(resolve, options));
}

/**
 * Retry an async operation with exponential backoff.
 */
export async function retry<T>(
  factory: () => Promise<T>,
  options: { retries: number; delay: number; multiplier?: number } = {
    retries: 3,
    delay: 100,
    multiplier: 2,
  }
): Promise<T> {
  const { retries, delay, multiplier = 2 } = options;
  let lastError: unknown;

  for (let i = 0; i <= retries; i++) {
    try {
      return await factory();
    } catch (err) {
      lastError = err;
      if (i < retries) {
        await timeout(delay * Math.pow(multiplier, i));
      }
    }
  }

  throw lastError;
}
