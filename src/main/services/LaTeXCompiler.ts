/**
 * @file LaTeXCompiler - Local LaTeX Compiler
 * @description Implements ICompiler interface with multi-engine support (pdflatex/xelatex/lualatex/tectonic)
 * @depends CompileWorkerClient, LoggerService
 */

import { execFile } from 'child_process';
import { EventEmitter } from 'events';
import { promisify } from 'util';
import {
  type CompileLog,
  type CompileProgress,
  compileWorkerClient,
} from '../workers/CompileWorkerClient';
import { createLogger } from './LoggerService';
import type {
  CompileLogEntry,
  CompileOptions,
  CompileResult,
  CompileProgress as ICompileProgress,
  ICompiler,
} from './compiler/interfaces';

const execFileAsync = promisify(execFile);

// ==================== Configuration Constants ====================

const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB - prevents memory exhaustion
const MAX_LOG_ENTRIES = 10000;
const DEFAULT_COMPILE_TIMEOUT = 60 * 1000; // 60s
const MAX_COMPILE_TIMEOUT = 5 * 60 * 1000; // 5min
const MAX_QUEUE_LENGTH = 5;

// Re-export for backwards compatibility
export type { CompileProgress, CompileLog };

/**
 * @deprecated Use CompileOptions from './compiler/interfaces' instead
 */
export interface CompilationOptions {
  engine?: 'tectonic' | 'pdflatex' | 'xelatex' | 'lualatex';
  outputDir?: string;
  mainFile?: string;
  projectPath?: string;
}

/**
 * @deprecated Use CompileResult from './compiler/interfaces' instead
 */
export interface CompilationResult {
  success: boolean;
  pdfPath?: string;
  pdfData?: string;
  pdfBuffer?: Uint8Array;
  synctexPath?: string;
  errors?: string[];
  warnings?: string[];
  log?: string;
  time?: number;
}

// ==================== Compile Task Queue ====================

interface CompileTask {
  id: string;
  content: string | null;
  options?: CompileOptions;
  resolve: (result: CompileResult) => void;
  reject: (error: Error) => void;
  createdAt: number;
}

/**
 * LaTeX Compiler - Implements ICompiler interface
 *
 * 🛡️ Concurrency Protection:
 * - Only ONE compilation can run at a time per document
 * - Additional requests are queued (max 5 pending)
 * - Timeout protection prevents infinite hangs
 *
 * Uses Worker thread for compilation to avoid blocking the main process.
 * Supports multiple engines: pdflatex, xelatex, lualatex, tectonic
 */
export class LaTeXCompiler extends EventEmitter implements ICompiler {
  // ================= ICompiler Properties =================
  private logger = createLogger('LaTeXCompiler');

  readonly id = 'latex-local';
  readonly name = 'Local LaTeX';
  readonly extensions = ['.tex', '.ltx', '.sty', '.cls'];
  readonly engines = ['pdflatex', 'xelatex', 'lualatex', 'tectonic'];
  readonly isRemote = false;

  // ================= Concurrency Control =================

  /** Only ONE compilation at a time to prevent resource conflicts */
  private _isCompiling = false;

  /** Queued requests when user clicks "compile" during active compilation */
  private _compileQueue: CompileTask[] = [];

  private _timeoutHandle: NodeJS.Timeout | null = null;
  private _currentTaskId: string | null = null;

  // ================= Internal State =================

  private _abortController: AbortController | null = null;
  private onProgress?: (progress: CompileProgress) => void;
  private onLog?: (log: CompileLog) => void;

  // Log tracking for large log handling
  private _logEntryCount = 0;
  private _logTruncated = false;

  // ================= ICompiler Methods =================

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync('pdflatex', ['--version']);
      return true;
    } catch {
      // Try tectonic as fallback
      try {
        await execFileAsync('tectonic', ['--version']);
        return true;
      } catch {
        return false;
      }
    }
  }

  async getVersion(): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('pdflatex', ['--version']);
      const match = stdout.match(/pdfTeX [^\n]+/);
      return match ? match[0] : stdout.split('\n')[0] || null;
    } catch {
      try {
        const { stdout } = await execFileAsync('tectonic', ['--version']);
        return stdout.trim();
      } catch {
        return null;
      }
    }
  }

  async getAvailableEngines(): Promise<
    Array<{ engine: string; available: boolean; version?: string }>
  > {
    const results = await Promise.all(
      this.engines.map(async (engine) => {
        try {
          const { stdout } = await execFileAsync(engine, ['--version']);
          return { engine, available: true, version: stdout.split('\n')[0] };
        } catch {
          return { engine, available: false };
        }
      })
    );
    return results;
  }

  /**
   * Concurrency safe: queues requests if already compiling (max 5 pending).
   * Each compilation has a timeout (default 60s).
   */
  async compile(content: string | null, options?: CompileOptions): Promise<CompileResult> {
    const taskId = this.generateTaskId();
    const timeout = this.getTimeout(options);

    // 🔒 Check if we should queue or reject
    if (this._isCompiling) {
      // Already compiling - queue this request
      if (this._compileQueue.length >= MAX_QUEUE_LENGTH) {
        this.logger.warn(`Queue full (${MAX_QUEUE_LENGTH}), rejecting request`);
        return {
          success: false,
          errors: ['Compilation queue full. Please wait for current compilation to finish.'],
          warnings: [],
        };
      }

      this.logger.info(
        `Compilation in progress, queuing task ${taskId} (queue size: ${this._compileQueue.length + 1})`
      );

      // Return a promise that resolves when this task is processed
      return new Promise<CompileResult>((resolve, reject) => {
        this._compileQueue.push({
          id: taskId,
          content,
          options,
          resolve,
          reject,
          createdAt: Date.now(),
        });
      });
    }

    // 🚀 No compilation running - execute immediately
    return this.executeCompilation(taskId, content, options, timeout);
  }

  private async executeCompilation(
    taskId: string,
    content: string | null,
    options: CompileOptions | undefined,
    timeout: number
  ): Promise<CompileResult> {
    // 🔒 Acquire mutex
    this._isCompiling = true;
    this._currentTaskId = taskId;
    this._abortController = new AbortController();
    this._logEntryCount = 0;
    this._logTruncated = false;
    const startTime = Date.now();

    // ⏱️ Set timeout - compiler can't run forever
    const timeoutPromise = this.createTimeoutPromise(timeout, taskId);

    // Emit start event
    this.emit('start', { mainFile: options?.mainFile || 'untitled.tex', options: options || {} });

    try {
      this.logger.info(`Task ${taskId}: Starting compilation`);
      this.logger.info(`mainFile: ${options?.mainFile} timeout: ${timeout}ms`);

      // 🏎️ Race between compilation and timeout
      const result = await Promise.race([
        this.runWorkerCompilation(content, options, taskId, timeout),
        timeoutPromise,
      ]);

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(`Task ${taskId}: Failed after ${duration}ms`, error);

      const result: CompileResult = {
        success: false,
        errors: [error instanceof Error ? error.message : 'Unknown compilation error'],
        warnings: [],
        duration,
      };
      this.emit('complete', result);
      return result;
    } finally {
      // 🔓 Release mutex and cleanup
      this.clearTimeout();
      this._isCompiling = false;
      this._currentTaskId = null;
      this._abortController = null;
      this._logEntryCount = 0;
      this._logTruncated = false;

      // 📋 Process next item in queue
      this.processQueue();
    }
  }

  private async runWorkerCompilation(
    content: string | null,
    options: CompileOptions | undefined,
    taskId: string,
    timeout: number
  ): Promise<CompileResult> {
    const startTime = Date.now();
    this.logger.info(`Task ${taskId}: Using Worker thread`);

    const workerResult = await compileWorkerClient.compileLatex(
      content || '',
      {
        engine: options?.engine as 'tectonic' | 'pdflatex' | 'xelatex' | 'lualatex' | undefined,
        mainFile: options?.mainFile,
        projectPath: options?.projectPath,
      },
      (progress) => {
        // Map worker progress to ICompiler progress format
        const iProgress: ICompileProgress = {
          percent: progress.progress,
          stage: progress.message,
          message: progress.message,
        };
        this.onProgress?.(progress);
        this.emit('progress', iProgress);
      },
      (log) => {
        // 🛡️ Limit log entries to prevent performance issues
        this._logEntryCount++;

        if (this._logEntryCount > MAX_LOG_ENTRIES) {
          if (!this._logTruncated) {
            this._logTruncated = true;
            console.warn(`[LaTeXCompiler] Log output truncated at ${MAX_LOG_ENTRIES} entries`);

            const truncateEntry: CompileLogEntry = {
              timestamp: Date.now(),
              level: 'warning',
              message: `[Log truncated] Output exceeded ${MAX_LOG_ENTRIES} entries.`,
            };
            this.onLog?.({ level: 'warning', message: truncateEntry.message });
            this.emit('log', truncateEntry);
          }
          return;
        }

        const entry: CompileLogEntry = {
          timestamp: Date.now(),
          level: log.level as 'info' | 'warning' | 'error' | 'debug',
          message: log.message,
        };
        this.onLog?.(log);
        this.emit('log', entry);
      },
      timeout
    );

    const duration = Date.now() - startTime;
    this.logger.info(`Task ${taskId}: Completed in ${duration}ms`);

    // 🛡️ Truncate large logs to prevent memory issues
    let processedLog = workerResult.log;
    if (processedLog && processedLog.length > MAX_LOG_SIZE) {
      this.logger.warn(`Log truncated from ${processedLog.length} to ${MAX_LOG_SIZE} bytes`);
      processedLog = `${processedLog.slice(0, MAX_LOG_SIZE)}\n\n[Log truncated at ${MAX_LOG_SIZE / 1024 / 1024}MB]`;
    }

    const result: CompileResult = {
      success: workerResult.success,
      outputPath: workerResult.pdfPath,
      outputBuffer: workerResult.pdfBuffer,
      synctexPath: workerResult.synctexPath,
      errors: workerResult.errors || [],
      warnings: this._logTruncated
        ? [...(workerResult.warnings || []), 'Log output was truncated due to size']
        : workerResult.warnings || [],
      log: processedLog,
      duration,
    };

    this.emit('complete', result);
    return result;
  }

  /** LaTeX can hang on infinite loops or missing files - fail fast */
  private createTimeoutPromise(timeout: number, taskId: string): Promise<CompileResult> {
    return new Promise((resolve) => {
      this._timeoutHandle = setTimeout(() => {
        this.logger.error(`Task ${taskId}: TIMEOUT after ${timeout}ms`);

        // Cancel the worker if possible
        this._abortController?.abort();
        compileWorkerClient.abortTask(taskId).catch((error) => {
          this.logger.warn('Failed to abort worker task on timeout:', error);
        });

        resolve({
          success: false,
          errors: [
            `Compilation timed out after ${timeout / 1000} seconds.`,
            'This usually means:',
            '  1. The LaTeX document has an infinite loop',
            '  2. A required package is not installed',
            '  3. The compiler is waiting for input',
            'Try simplifying your document or checking for errors.',
          ],
          warnings: [],
          duration: timeout,
        });
      }, timeout);
    });
  }

  private clearTimeout(): void {
    if (this._timeoutHandle) {
      clearTimeout(this._timeoutHandle);
      this._timeoutHandle = null;
    }
  }

  private getTimeout(options?: CompileOptions): number {
    const requestedTimeout = options?.timeout;

    if (typeof requestedTimeout === 'number' && requestedTimeout > 0) {
      // Clamp to reasonable bounds
      return Math.min(Math.max(requestedTimeout, 1000), MAX_COMPILE_TIMEOUT);
    }

    return DEFAULT_COMPILE_TIMEOUT;
  }

  private generateTaskId(): string {
    return `compile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /** Called after each compilation completes to drain the queue */
  private processQueue(): void {
    if (this._compileQueue.length === 0) {
      return;
    }

    if (this._isCompiling) {
      // Shouldn't happen, but be safe
      return;
    }

    const nextTask = this._compileQueue.shift()!;
    const queueTime = Date.now() - nextTask.createdAt;
    this.logger.info(
      `Processing queued task ${nextTask.id} (waited ${queueTime}ms, remaining: ${this._compileQueue.length})`
    );

    // Check if task has been waiting too long (might be stale)
    if (queueTime > MAX_COMPILE_TIMEOUT) {
      this.logger.warn(`Task ${nextTask.id} expired in queue`);
      nextTask.resolve({
        success: false,
        errors: ['Compilation request expired while waiting in queue'],
        warnings: [],
      });
      // Try next task
      this.processQueue();
      return;
    }

    // Execute the queued task
    const timeout = this.getTimeout(nextTask.options);
    this.executeCompilation(nextTask.id, nextTask.content, nextTask.options, timeout)
      .then(nextTask.resolve)
      .catch(nextTask.reject);
  }

  cancel(): boolean {
    if (!this._isCompiling) {
      return false;
    }

    this.logger.info(`Cancelling task ${this._currentTaskId}`);
    if (this._currentTaskId) {
      compileWorkerClient.abortTask(this._currentTaskId).catch((error) => {
        this.logger.warn('Failed to abort worker task:', error);
      });
    }
    this._abortController?.abort();
    this.clearTimeout();
    this.emit('cancel');

    // Note: _isCompiling will be set to false in the finally block of executeCompilation
    return true;
  }

  cancelAll(): number {
    const cancelled = this._compileQueue.length;

    // Reject all queued tasks
    for (const task of this._compileQueue) {
      task.resolve({
        success: false,
        errors: ['Compilation cancelled'],
        warnings: [],
      });
    }
    this._compileQueue = [];

    // Cancel current task
    if (this._isCompiling) {
      this.cancel();
    }

    this.logger.info(`Cancelled ${cancelled} queued tasks + current task`);
    return cancelled + (this._isCompiling ? 1 : 0);
  }

  isCompiling(): boolean {
    return this._isCompiling;
  }

  /**
   * Get queue status
   */
  getQueueStatus(): { isCompiling: boolean; queueLength: number; currentTaskId: string | null } {
    return {
      isCompiling: this._isCompiling,
      queueLength: this._compileQueue.length,
      currentTaskId: this._currentTaskId,
    };
  }

  async clean(options?: Pick<CompileOptions, 'projectPath' | 'mainFile'>): Promise<void> {
    try {
      await compileWorkerClient.cleanup();
      this.logger.info('Cleaned up auxiliary files', options);
    } catch (error) {
      this.logger.error('Failed to cleanup:', error);
    }
  }

  /** Alias for clean() */
  async cleanup(): Promise<void> {
    return this.clean();
  }
}
