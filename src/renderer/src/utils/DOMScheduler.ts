/**
 * @file DOMScheduler.ts - Batch DOM update scheduler
 * @description Batches multiple state updates into single DOM operations using requestAnimationFrame
 *              and requestIdleCallback. Inspired by VS Code's batch processing patterns.
 * @depends React hooks (for convenience wrappers)
 */

type ScheduledCallback = () => void;

/**
 * Update priority levels (lower number = higher priority)
 */
export enum SchedulePriority {
  /** Critical - user input response, must execute immediately */
  Critical = 0,
  /** High - execute on next frame */
  High = 1,
  /** Normal - default priority */
  Normal = 2,
  /** Low - can be delayed */
  Low = 3,
  /** Idle - only execute when browser is idle */
  Idle = 4,
}

interface ScheduledTask {
  callback: ScheduledCallback;
  priority: SchedulePriority;
  timestamp: number;
}

// Why 8ms: Reserve ~8ms for browser rendering to maintain 60fps (16ms frame budget)
const MAX_FRAME_TIME = 8;

// ====== DOMScheduler Implementation ======

class DOMSchedulerImpl {
  private static instance: DOMSchedulerImpl;

  private pendingUpdates: Map<string, ScheduledTask> = new Map();
  private idleUpdates: Map<string, ScheduledTask> = new Map();
  private rafId: number | null = null;
  private idleId: number | null = null;
  private isFlushing = false;

  private stats = {
    scheduledCount: 0,
    executedCount: 0,
    mergedCount: 0,
    idleExecutedCount: 0,
    yieldedFrames: 0,
  };

  private constructor() {
    // Private constructor enforces singleton
  }

  /**
   * Gets the singleton instance.
   */
  public static getInstance(): DOMSchedulerImpl {
    if (!DOMSchedulerImpl.instance) {
      DOMSchedulerImpl.instance = new DOMSchedulerImpl();
    }
    return DOMSchedulerImpl.instance;
  }

  /**
   * Schedules a DOM update. Updates with the same key are merged (last wins).
   */
  public schedule(
    key: string,
    callback: ScheduledCallback,
    priority: SchedulePriority = SchedulePriority.Normal
  ): void {
    this.stats.scheduledCount++;

    const task: ScheduledTask = {
      callback,
      priority,
      timestamp: performance.now(),
    };

    if (priority === SchedulePriority.Idle) {
      if (this.idleUpdates.has(key)) {
        this.stats.mergedCount++;
      }
      this.idleUpdates.set(key, task);
      this.scheduleIdleFlush();
      return;
    }

    if (this.pendingUpdates.has(key)) {
      this.stats.mergedCount++;
    }

    this.pendingUpdates.set(key, task);
    this.scheduleFlush();
  }

  /**
   * Schedules a microtask for updates that must complete in current event loop.
   */
  public scheduleMicrotask(key: string, callback: ScheduledCallback): void {
    this.stats.scheduledCount++;

    // Use queueMicrotask to ensure execution before current event loop ends
    queueMicrotask(() => {
      try {
        callback();
        this.stats.executedCount++;
      } catch (error) {
        console.error(`[DOMScheduler] Error executing microtask "${key}":`, error);
      }
    });
  }

  /**
   * Synchronously executes all pending updates.
   * Use for scenarios requiring immediate effect, e.g., before window close.
   */
  public flushSync(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.idleId !== null) {
      cancelIdleCallback(this.idleId);
      this.idleId = null;
    }
    this.flush();
    this.flushIdle();
  }

  /**
   * Cancels a pending update by key.
   */
  public cancel(key: string): boolean {
    const normalCancelled = this.pendingUpdates.delete(key);
    const idleCancelled = this.idleUpdates.delete(key);
    return normalCancelled || idleCancelled;
  }

  /**
   * Cancels all pending updates.
   */
  public cancelAll(): void {
    this.pendingUpdates.clear();
    this.idleUpdates.clear();
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.idleId !== null) {
      cancelIdleCallback(this.idleId);
      this.idleId = null;
    }
  }

  /**
   * Gets execution statistics.
   */
  public getStats(): Readonly<typeof this.stats> {
    return { ...this.stats };
  }

  /**
   * Resets execution statistics.
   */
  public resetStats(): void {
    this.stats = {
      scheduledCount: 0,
      executedCount: 0,
      mergedCount: 0,
      idleExecutedCount: 0,
      yieldedFrames: 0,
    };
  }

  /**
   * Checks if there are pending updates.
   */
  public hasPendingUpdates(): boolean {
    return this.pendingUpdates.size > 0 || this.idleUpdates.size > 0;
  }

  /**
   * Gets count of pending updates.
   */
  public getPendingCount(): number {
    return this.pendingUpdates.size + this.idleUpdates.size;
  }

  private scheduleFlush(): void {
    if (this.rafId === null && !this.isFlushing) {
      this.rafId = requestAnimationFrame(() => this.flush());
    }
  }

  private scheduleIdleFlush(): void {
    if (this.idleId === null) {
      this.idleId = requestIdleCallback(
        (deadline) => this.flushIdleWithDeadline(deadline),
        { timeout: 5000 } // Max wait 5 seconds before forcing execution
      );
    }
  }

  /**
   * Executes pending updates with time-slicing to avoid blocking main thread.
   */
  private flush(): void {
    this.rafId = null;

    if (this.pendingUpdates.size === 0) {
      return;
    }

    this.isFlushing = true;
    const frameStart = performance.now();

    try {
      const tasks = Array.from(this.pendingUpdates.entries()).sort(
        (a, b) => a[1].priority - b[1].priority
      );

      this.pendingUpdates.clear();

      for (const [key, task] of tasks) {
        // Time-slice: yield to browser for low priority tasks if frame budget exceeded
        if (task.priority >= SchedulePriority.Low) {
          const elapsed = performance.now() - frameStart;
          if (elapsed > MAX_FRAME_TIME) {
            this.stats.yieldedFrames++;
            const remainingIndex = tasks.indexOf([key, task]);
            for (let i = remainingIndex; i < tasks.length; i++) {
              const [k, t] = tasks[i];
              this.pendingUpdates.set(k, t);
            }
            break;
          }
        }

        try {
          task.callback();
          this.stats.executedCount++;
        } catch (error) {
          console.error(`[DOMScheduler] Error executing update "${key}":`, error);
        }
      }
    } finally {
      this.isFlushing = false;
    }

    if (this.pendingUpdates.size > 0) {
      this.scheduleFlush();
    }
  }

  /**
   * Executes idle tasks respecting the idle deadline.
   */
  private flushIdleWithDeadline(deadline: IdleDeadline): void {
    this.idleId = null;

    if (this.idleUpdates.size === 0) {
      return;
    }

    const tasks = Array.from(this.idleUpdates.entries()).sort(
      (a, b) => a[1].timestamp - b[1].timestamp
    );

    this.idleUpdates.clear();

    for (const [key, task] of tasks) {
      if (deadline.timeRemaining() < 1 && !deadline.didTimeout) {
        // No time remaining - requeue remaining tasks
        const remainingIndex = tasks.indexOf([key, task]);
        for (let i = remainingIndex; i < tasks.length; i++) {
          const [k, t] = tasks[i];
          this.idleUpdates.set(k, t);
        }
        this.scheduleIdleFlush();
        break;
      }

      try {
        task.callback();
        this.stats.idleExecutedCount++;
      } catch (error) {
        console.error(`[DOMScheduler] Error executing idle update "${key}":`, error);
      }
    }
  }

  /**
   * Force-executes all idle tasks synchronously.
   */
  private flushIdle(): void {
    if (this.idleUpdates.size === 0) {
      return;
    }

    const tasks = Array.from(this.idleUpdates.entries());
    this.idleUpdates.clear();

    for (const [key, task] of tasks) {
      try {
        task.callback();
        this.stats.idleExecutedCount++;
      } catch (error) {
        console.error(`[DOMScheduler] Error executing idle update "${key}":`, error);
      }
    }
  }
}

export const DOMScheduler = DOMSchedulerImpl.getInstance();

// Export class for testing
export { DOMSchedulerImpl };

// ====== React Hook Wrappers ======

import { useCallback, useEffect, useRef } from 'react';

/**
 * React Hook for scheduling DOM updates via DOMScheduler.
 * Automatically cancels pending updates on unmount.
 *
 * @example
 * ```tsx
 * const scheduleUpdate = useScheduledUpdate('statusBar');
 * scheduleUpdate(() => updateDOM());
 * ```
 */
export function useScheduledUpdate(key: string) {
  const keyRef = useRef(key);
  keyRef.current = key;

  useEffect(() => {
    return () => {
      DOMScheduler.cancel(keyRef.current);
    };
  }, []);

  return useCallback((callback: ScheduledCallback, priority?: SchedulePriority) => {
    DOMScheduler.schedule(keyRef.current, callback, priority);
  }, []);
}

/**
 * React Hook for debounced DOM updates.
 * Merges high-frequency updates into low-frequency execution.
 */
export function useDebouncedUpdate(
  callback: ScheduledCallback,
  key: string,
  delay = 16 // Default frame time
) {
  const timeoutRef = useRef<number | null>(null);
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
      }
      DOMScheduler.cancel(key);
    };
  }, [key]);

  return useCallback(() => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
    }

    timeoutRef.current = window.setTimeout(() => {
      timeoutRef.current = null;
      DOMScheduler.schedule(key, callbackRef.current);
    }, delay);
  }, [key, delay]);
}
