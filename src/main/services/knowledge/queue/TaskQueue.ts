/**
 * @file TaskQueue - Knowledge Base Task Queue
 * @description Manages async document processing tasks with priority, retry, progress callbacks and timeout circuit breaker
 * @depends EventEmitter, ProcessTask
 */

import { EventEmitter } from 'events';
import { createLogger } from '../../LoggerService';
import type {
  EventType,
  KnowledgeEvent,
  KnowledgeEventData,
  ProcessTask,
  TaskPayload,
  TaskType,
} from '../types';

const logger = createLogger('TaskQueue');

// ====== Types ======

export type TaskHandler = (task: ProcessTask) => Promise<unknown>;
export type ProgressCallback = (taskId: string, progress: number, message?: string) => void;

// ====== Timeout Configuration ======

/**
 * Task timeout configuration (ms).
 *
 * Why different timeouts? Different tasks have vastly different execution times:
 * - Embedding: may involve multiple external API calls
 * - PDF parsing: depends on file size
 * - Audio/Image: may require heavy processing
 */
const TASK_TIMEOUTS: Partial<Record<TaskType, number>> = {
  generate_embedding: 10 * 60 * 1000,
  process_document: 5 * 60 * 1000,
  process_audio: 10 * 60 * 1000,
  process_image: 5 * 60 * 1000,
  reindex_library: 15 * 60 * 1000,
};

const DEFAULT_TASK_TIMEOUT = 3 * 60 * 1000;

/** Distinguishes timeout errors from other errors for retry logic */
class TaskTimeoutError extends Error {
  constructor(taskId: string, timeoutMs: number) {
    super(`Task ${taskId} timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.name = 'TaskTimeoutError';
  }
}

// ====== Main Class ======

export class TaskQueue extends EventEmitter {
  private tasks: Map<string, ProcessTask> = new Map();
  private queue: string[] = [];
  private handlers: Map<TaskType, TaskHandler> = new Map();
  private isProcessing = false;
  private concurrency: number;
  private activeCount = 0;

  constructor(concurrency = 2) {
    super();
    this.concurrency = concurrency;
  }

  // ====== Public API ======

  registerHandler(type: TaskType, handler: TaskHandler): void {
    this.handlers.set(type, handler);
  }

  addTask(type: TaskType, payload: TaskPayload, priority = 5, maxRetries = 3): ProcessTask {
    const task: ProcessTask = {
      id: this.generateTaskId(),
      type,
      status: 'pending',
      priority,
      payload,
      progress: 0,
      createdAt: Date.now(),
      retryCount: 0,
      maxRetries,
    };

    this.tasks.set(task.id, task);
    this.enqueue(task.id, priority);
    this.processQueue();

    return task;
  }

  addTasks(
    items: Array<{ type: TaskType; payload: TaskPayload; priority?: number }>
  ): ProcessTask[] {
    return items.map((item) => this.addTask(item.type, item.payload, item.priority));
  }

  cancelTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    if (task.status === 'pending') {
      task.status = 'cancelled';
      this.removeFromQueue(taskId);
      this.emitEvent('task:failed', { taskId, reason: 'cancelled' });
      return true;
    }

    return false;
  }

  getTask(taskId: string): ProcessTask | undefined {
    return this.tasks.get(taskId);
  }

  getAllTasks(): ProcessTask[] {
    return Array.from(this.tasks.values());
  }

  getPendingCount(): number {
    return this.queue.length;
  }

  getActiveCount(): number {
    return this.activeCount;
  }

  updateProgress(taskId: string, progress: number, message?: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.progress = Math.min(100, Math.max(0, progress));
      task.message = message;
      const filename = task.payload?.filename;
      this.emitEvent('task:progress', {
        taskId,
        progress: task.progress,
        message,
        status: task.status,
        filename,
        taskType: 'upload',
      });
    }
  }

  clearCompleted(): void {
    for (const [id, task] of this.tasks) {
      if (task.status === 'completed' || task.status === 'cancelled') {
        this.tasks.delete(id);
      }
    }
  }

  // ====== Private Methods ======

  /** Enqueue task sorted by priority (higher priority first) */
  private enqueue(taskId: string, priority: number): void {
    let insertIndex = this.queue.length;
    for (let i = 0; i < this.queue.length; i++) {
      const existingTask = this.tasks.get(this.queue[i]);
      if (existingTask && existingTask.priority < priority) {
        insertIndex = i;
        break;
      }
    }
    this.queue.splice(insertIndex, 0, taskId);
  }

  private removeFromQueue(taskId: string): void {
    const index = this.queue.indexOf(taskId);
    if (index > -1) {
      this.queue.splice(index, 1);
    }
  }

  /**
   * Process queue with synchronous activeCount updates to prevent over-concurrency.
   */
  private processQueue(): void {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      while (this.queue.length > 0 && this.activeCount < this.concurrency) {
        const taskId = this.queue.shift();
        if (!taskId) continue;

        const task = this.tasks.get(taskId);
        if (!task || task.status !== 'pending') continue;

        const handler = this.handlers.get(task.type);
        if (!handler) {
          task.status = 'failed';
          task.error = `No handler registered for task type: ${task.type}`;
          this.emitEvent('task:failed', { taskId: task.id, error: task.error });
          continue;
        }

        this.activeCount++;

        this.executeTask(task, handler).catch((err) => {
          console.error(`[TaskQueue] Unexpected error in executeTask for ${task.id}:`, err);
        });
      }
    } finally {
      this.isProcessing = false;
    }
  }

  private getTaskTimeout(type: TaskType): number {
    return TASK_TIMEOUTS[type] ?? DEFAULT_TASK_TIMEOUT;
  }

  private createTimeoutPromise(taskId: string, timeoutMs: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new TaskTimeoutError(taskId, timeoutMs));
      }, timeoutMs);
    });
  }

  /**
   * Execute task with timeout circuit breaker.
   *
   * @sideeffect Assumes activeCount was incremented before call; decrements in finally.
   *
   * Why Promise.race for timeout? JS cannot truly cancel a Promise, but we stop waiting
   * for it. The original handler may continue running in background.
   */
  private async executeTask(task: ProcessTask, handler: TaskHandler): Promise<void> {
    task.status = 'running';
    task.startedAt = Date.now();

    const timeoutMs = this.getTaskTimeout(task.type);

    try {
      // Use Promise.race for timeout circuit breaker
      const result = await Promise.race([
        handler(task),
        this.createTimeoutPromise(task.id, timeoutMs),
      ]);

      task.status = 'completed';
      task.result = result;
      task.progress = 100;
      task.completedAt = Date.now();

      this.emitEvent('task:completed', {
        taskId: task.id,
        result,
        duration: task.completedAt - task.startedAt!,
        filename: task.payload?.filename,
        taskType: 'upload',
      });
    } catch (error) {
      if (error instanceof TaskTimeoutError) {
        console.warn(`[TaskQueue] ${error.message}`);
      }
      this.handleTaskError(task, error);
    } finally {
      this.activeCount--;
      // Why setImmediate? Avoids deep recursion when many tasks complete quickly
      setImmediate(() => this.processQueue());
    }
  }

  /**
   * Handle task errors with retry logic.
   *
   * Why exponential backoff for timeouts? Immediate retries during high load
   * would worsen the situation. Backoff gives the system time to recover.
   */
  private handleTaskError(task: ProcessTask, error: unknown): void {
    task.retryCount++;
    const isTimeout = error instanceof TaskTimeoutError;

    if (task.retryCount < task.maxRetries) {
      task.status = 'pending';

      if (isTimeout) {
        // Exponential backoff: 5s, 10s, 20s...
        const backoffMs = 5000 * Math.pow(2, task.retryCount - 1);
        logger.info(
          `[TaskQueue] Task ${task.id} timed out, retrying in ${backoffMs / 1000}s (${task.retryCount}/${task.maxRetries})`
        );

        setTimeout(() => {
          if (task.status === 'pending') {
            this.enqueue(task.id, task.priority);
            this.processQueue();
          }
        }, backoffMs);
      } else {
        logger.info(`[TaskQueue] Retrying task ${task.id} (${task.retryCount}/${task.maxRetries})`);
        this.enqueue(task.id, task.priority);
      }
    } else {
      task.status = 'failed';
      task.error = error instanceof Error ? error.message : 'Unknown error';
      task.completedAt = Date.now();

      this.emitEvent('task:failed', {
        taskId: task.id,
        error: task.error,
      });
    }
  }

  private generateTaskId(): string {
    return `task-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  private emitEvent(type: EventType, data: KnowledgeEventData): void {
    const event: KnowledgeEvent = {
      type,
      timestamp: Date.now(),
      data,
    };
    this.emit(type, event);
    this.emit('event', event);
  }

  // ====== Lifecycle ======

  async waitForAll(): Promise<void> {
    return new Promise((resolve) => {
      const checkComplete = () => {
        if (this.queue.length === 0 && this.activeCount === 0) {
          resolve();
        } else {
          setTimeout(checkComplete, 100);
        }
      };
      checkComplete();
    });
  }

  pause(): void {
    this.concurrency = 0;
  }

  resume(concurrency?: number): void {
    this.concurrency = concurrency || 2;
    this.processQueue();
  }

  getStats(): {
    pending: number;
    running: number;
    completed: number;
    failed: number;
    cancelled: number;
  } {
    const stats = {
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };

    for (const task of this.tasks.values()) {
      stats[task.status]++;
    }

    return stats;
  }
}
