/**
 * @file IdleTaskScheduler.ts - Idle Task Scheduler
 * @description Unified scheduling of idle tasks, supports priority and frame limits, avoids task thundering herd
 * @depends requestIdleCallback
 */

import type { IDisposable } from '../../../../../shared/utils';
import { createLogger } from '../LogService';

const logger = createLogger('IdleTaskScheduler');

// ====== Types & Enums ======

export enum TaskPriority {
  Low = 0,
  Normal = 1,
  High = 2,
  Urgent = 3,
}

interface IdleTask {
  id: string;
  task: () => void | Promise<void>;
  priority: TaskPriority;
  timeout?: number;
  createdAt: number;
}

interface IdleTaskOptions {
  id?: string;
  priority?: TaskPriority;
  /** Force execution after timeout (ms) */
  timeout?: number;
}

// ====== Scheduler Implementation ======

class IdleTaskSchedulerImpl implements IDisposable {
  private _queue: IdleTask[] = [];
  private _isProcessing = false;
  private _isDisposed = false;

  // Limit tasks per idle callback to avoid frame drops
  private readonly _maxTasksPerFrame = 2;
  private readonly _maxQueueSize = 100;
  // Gap between tasks to let UI breathe
  private readonly _taskGapMs = 8;

  private _idleHandle: number | null = null;
  private _taskIdCounter = 0;

  /**
   * Schedule an idle task
   * @returns Task ID for cancellation
   */
  schedule(task: () => void | Promise<void>, options?: IdleTaskOptions): string {
    if (this._isDisposed) {
      logger.warn('Scheduler disposed, task ignored');
      return '';
    }

    const id = options?.id ?? `task-${++this._taskIdCounter}`;
    const priority = options?.priority ?? TaskPriority.Normal;

    // Dedup: remove existing task with same ID
    if (options?.id) {
      this._queue = this._queue.filter((t) => t.id !== id);
    }

    const idleTask: IdleTask = {
      id,
      task,
      priority,
      timeout: options?.timeout,
      createdAt: Date.now(),
    };

    this._queue.push(idleTask);

    this._queue.sort((a, b) => b.priority - a.priority);

    // Overflow protection: drop low-priority tasks when queue exceeds limit
    if (this._queue.length > this._maxQueueSize) {
      const removed = this._queue.splice(this._maxQueueSize);
      if (removed.length > 0) {
        logger.warn(`Queue overflow, dropped ${removed.length} low-priority tasks`);
      }
    }

    this._scheduleProcessing();

    return id;
  }

  cancel(id: string): boolean {
    const before = this._queue.length;
    this._queue = this._queue.filter((t) => t.id !== id);
    return this._queue.length < before;
  }

  cancelByPrefix(prefix: string): number {
    const before = this._queue.length;
    this._queue = this._queue.filter((t) => !t.id.startsWith(prefix));
    return before - this._queue.length;
  }

  clear(): void {
    const count = this._queue.length;
    this._queue = [];
    if (count > 0) {
      logger.debug(`Cleared ${count} pending tasks`);
    }
  }

  get queueLength(): number {
    return this._queue.length;
  }

  get pendingTaskIds(): string[] {
    return this._queue.map((t) => t.id);
  }

  private _scheduleProcessing(): void {
    if (this._isProcessing || this._queue.length === 0 || this._isDisposed) {
      return;
    }

    this._isProcessing = true;

    // Use globalThis for cross-environment compatibility (browser/Node/worker)
    const hasIdleCallback =
      typeof globalThis !== 'undefined' && 'requestIdleCallback' in globalThis;

    if (hasIdleCallback) {
      this._idleHandle = (
        globalThis as unknown as {
          requestIdleCallback: (
            cb: (d: IdleDeadline) => void,
            opts?: { timeout?: number }
          ) => number;
        }
      ).requestIdleCallback((deadline) => this._processQueue(deadline), { timeout: 5000 });
    } else {
      // Fallback: setTimeout for environments without requestIdleCallback
      setTimeout(() => {
        this._processQueue({
          didTimeout: true,
          timeRemaining: () => 10,
        });
      }, 16);
    }
  }

  private async _processQueue(deadline: IdleDeadline): Promise<void> {
    let executed = 0;
    const now = Date.now();

    while (this._queue.length > 0 && executed < this._maxTasksPerFrame && !this._isDisposed) {
      const task = this._queue[0];

      const hasTime = deadline.timeRemaining() > 5 || deadline.didTimeout;
      const isTimedOut = task.timeout && now - task.createdAt > task.timeout;

      if (!hasTime && !isTimedOut) {
        break;
      }

      this._queue.shift();

      try {
        const result = task.task();
        // Fire-and-forget for async tasks to avoid blocking queue,
        // but still catch errors to prevent unhandled rejections
        if (result && typeof result.then === 'function') {
          (result as Promise<unknown>).catch((error) => {
            logger.error(`Async task failed [${task.id}]:`, error);
          });
        }
      } catch (error) {
        logger.error(`Task failed [${task.id}]:`, error);
      }

      executed++;

      // Yield to UI between tasks
      if (executed < this._maxTasksPerFrame && this._queue.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, this._taskGapMs));
      }
    }

    this._isProcessing = false;

    if (this._queue.length > 0 && !this._isDisposed) {
      // Delay one frame before continuing to avoid hogging the thread
      setTimeout(() => this._scheduleProcessing(), 16);
    }
  }

  dispose(): void {
    this._isDisposed = true;
    this.clear();

    const hasIdleCallback = typeof globalThis !== 'undefined' && 'cancelIdleCallback' in globalThis;
    if (this._idleHandle !== null && hasIdleCallback) {
      (globalThis as unknown as { cancelIdleCallback: (h: number) => void }).cancelIdleCallback(
        this._idleHandle
      );
      this._idleHandle = null;
    }
  }
}

// ====== Singleton & Exports ======

let _instance: IdleTaskSchedulerImpl | null = null;

export function getIdleTaskScheduler(): IdleTaskSchedulerImpl {
  if (!_instance) {
    _instance = new IdleTaskSchedulerImpl();
  }
  return _instance;
}

export function scheduleIdleTask(
  task: () => void | Promise<void>,
  options?: IdleTaskOptions
): string {
  return getIdleTaskScheduler().schedule(task, options);
}

export function cancelIdleTask(id: string): boolean {
  return getIdleTaskScheduler().cancel(id);
}

export function cancelIdleTasksByPrefix(prefix: string): number {
  return getIdleTaskScheduler().cancelByPrefix(prefix);
}

export type { IdleTaskOptions };
