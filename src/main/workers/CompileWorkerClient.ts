/**
 * @file CompileWorkerClient - Compile Worker Client
 * @description Provides async interface for compile.worker communication, executes LaTeX/Typst compilation
 * @depends worker_threads, workerUtils
 */

import { EventEmitter } from 'events';
import { Worker } from 'worker_threads';
import { WorkerRestartManager, delay, getWorkerPath } from './workerUtils';

// ====== Type Definitions ======

/** LaTeX compilation request payload */
interface CompileLatexPayload {
  content: string;
  options?: CompilationOptions;
}

/** Typst compilation request payload */
interface CompileTypstPayload {
  content: string;
  options?: TypstCompilationOptions;
}

/** Cleanup request payload */
type CleanupPayload = {};

/** Abort request payload */
interface AbortPayload {
  abortId: string;
}

/** Worker message - uses Discriminated Union for type safety */
type WorkerMessage =
  | { id: string; type: 'compile'; payload: CompileLatexPayload }
  | { id: string; type: 'compileTypst'; payload: CompileTypstPayload }
  | { id: string; type: 'cleanup'; payload: CleanupPayload }
  | { id: string; type: 'abort'; payload: AbortPayload };

interface WorkerResponse {
  id: string;
  success: boolean;
  data?: any;
  error?: string;
}

interface ProgressMessage {
  id: string;
  type: 'progress';
  progress: number;
  message: string;
}

interface LogMessage {
  id: string;
  type: 'log';
  level: 'info' | 'warning' | 'error';
  message: string;
}

export interface CompileProgress {
  progress: number;
  message: string;
}

export interface CompileLog {
  level: 'info' | 'warning' | 'error';
  message: string;
}

export interface CompilationOptions {
  engine?: 'tectonic' | 'pdflatex' | 'xelatex' | 'lualatex';
  mainFile?: string;
  projectPath?: string;
}

export interface TypstCompilationOptions {
  engine?: 'typst' | 'tinymist';
  mainFile?: string;
  projectPath?: string;
}

export interface CompilationResult {
  success: boolean;
  pdfPath?: string;
  /** PDF file binary data - for zero-copy transfer to renderer process */
  pdfBuffer?: Uint8Array;
  synctexPath?: string;
  errors?: string[];
  warnings?: string[];
  log?: string;
}

// ====== Timeout Configuration ======

/** Default compilation timeout (ms) - 2 minutes */
const DEFAULT_COMPILE_TIMEOUT = 2 * 60 * 1000;

/** Cleanup operation timeout (ms) - 30 seconds */
const CLEANUP_TIMEOUT = 30 * 1000;

// ====== Singleton Client ======

class CompileWorkerClient extends EventEmitter {
  private static instance: CompileWorkerClient | null = null;

  private worker: Worker | null = null;
  private pendingRequests: Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      onProgress?: (progress: CompileProgress) => void;
      onLog?: (log: CompileLog) => void;
      timeout?: NodeJS.Timeout;
    }
  > = new Map();
  private requestIdCounter = 0;
  private isInitialized = false;
  private restartManager = new WorkerRestartManager('CompileWorkerClient');
  private isRestarting = false;

  private constructor() {
    super();
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): CompileWorkerClient {
    if (!CompileWorkerClient.instance) {
      CompileWorkerClient.instance = new CompileWorkerClient();
    }
    return CompileWorkerClient.instance;
  }

  /**
   * Initialize Worker
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized && this.worker) {
      return;
    }

    return new Promise((resolve, reject) => {
      try {
        // Use unified path resolution utility
        const workerPath = getWorkerPath('compile');
        console.info('[CompileWorkerClient] Worker path:', workerPath);

        this.worker = new Worker(workerPath);

        this.worker.on('message', (message: WorkerResponse | ProgressMessage | LogMessage) => {
          this.handleMessage(message);
        });

        this.worker.on('error', (error) => {
          console.error('[CompileWorkerClient] Worker error:', error);
          // Reject all pending requests
          this.rejectAllPendingRequests(error);
          this.emit('error', error);
        });

        this.worker.on('exit', (code) => {
          console.info(`[CompileWorkerClient] Worker exited, code: ${code}`);
          // If abnormal exit, reject all pending requests
          if (code !== 0) {
            this.rejectAllPendingRequests(new Error(`Worker exited with code ${code}`));
            // Attempt auto-restart
            this.attemptRestart();
          }
          this.isInitialized = false;
          this.worker = null;
        });

        this.isInitialized = true;
        // Worker successfully initialized, reset restart count
        this.restartManager.reset();
        console.info('[CompileWorkerClient] ✓ Worker initialization successful');
        resolve();
      } catch (error) {
        console.error('[CompileWorkerClient] Initialization failed:', error);
        reject(error);
      }
    });
  }

  /**
   * Attempt to auto-restart Worker
   */
  private async attemptRestart(): Promise<void> {
    if (this.isRestarting) {
      return;
    }

    if (!this.restartManager.canRestart()) {
      console.error(
        '[CompileWorkerClient] Reached max restart attempts, no longer attempting restart'
      );
      this.emit('maxRestartsReached');
      return;
    }

    this.isRestarting = true;
    const waitTime = this.restartManager.recordRestart();

    if (waitTime > 0) {
      await delay(waitTime);
    }

    try {
      console.info('[CompileWorkerClient] Attempting to restart Worker...');
      await this.initialize();
      console.info('[CompileWorkerClient] ✓ Worker restart successful');
    } catch (error) {
      console.error('[CompileWorkerClient] Worker restart failed:', error);
    } finally {
      this.isRestarting = false;
    }
  }

  /**
   * Reject all pending requests (called when Worker crashes)
   */
  private rejectAllPendingRequests(error: Error): void {
    for (const [, pending] of this.pendingRequests) {
      if (pending.timeout) {
        clearTimeout(pending.timeout);
      }
      pending.reject(error);
    }
    this.pendingRequests.clear();
    console.info('[CompileWorkerClient] Rejected all pending requests');
  }

  /**
   * Handle Worker message
   */
  private handleMessage(message: WorkerResponse | ProgressMessage | LogMessage): void {
    const pending = this.pendingRequests.get(message.id);
    if (!pending) {
      return;
    }

    // Progress message
    if ('type' in message && message.type === 'progress') {
      if (pending.onProgress) {
        pending.onProgress({
          progress: (message as ProgressMessage).progress,
          message: (message as ProgressMessage).message,
        });
      }
      this.emit(
        'progress',
        message.id,
        (message as ProgressMessage).progress,
        (message as ProgressMessage).message
      );
      return;
    }

    // Log message
    if ('type' in message && message.type === 'log') {
      if (pending.onLog) {
        pending.onLog({
          level: (message as LogMessage).level,
          message: (message as LogMessage).message,
        });
      }
      this.emit('log', message.id, (message as LogMessage).level, (message as LogMessage).message);
      return;
    }

    // Completion response
    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }
    this.pendingRequests.delete(message.id);

    if ((message as WorkerResponse).success) {
      pending.resolve((message as WorkerResponse).data);
    } else {
      pending.reject(new Error((message as WorkerResponse).error || 'Unknown error'));
    }
  }

  /**
   * Send request to Worker
   *
   * Adds timeout mechanism, attempts to cancel task in Worker after timeout
   */
  private async sendRequest<T>(
    type: WorkerMessage['type'],
    payload: any,
    options: {
      timeout?: number;
      onProgress?: (progress: CompileProgress) => void;
      onLog?: (log: CompileLog) => void;
    } = {}
  ): Promise<T> {
    if (!this.worker || !this.isInitialized) {
      await this.initialize();
    }

    const { timeout = DEFAULT_COMPILE_TIMEOUT, onProgress, onLog } = options;

    return new Promise((resolve, reject) => {
      const id = `compile-${++this.requestIdCounter}-${Date.now()}`;

      let timeoutHandle: NodeJS.Timeout | undefined;
      if (timeout > 0) {
        timeoutHandle = setTimeout(() => {
          const pending = this.pendingRequests.get(id);
          if (pending) {
            this.pendingRequests.delete(id);
            console.error(`[CompileWorkerClient] Request ${id} timed out (${timeout}ms)`);
            this.abortTask(id).catch(() => {
              // Ignore cancellation failure
            });
            reject(
              new Error(
                `Compilation timeout (${timeout / 1000}s). Possible causes: LaTeX document has infinite loop, missing required packages, or compiler waiting for input.`
              )
            );
          }
        }, timeout);
      }

      this.pendingRequests.set(id, {
        resolve,
        reject,
        onProgress,
        onLog,
        timeout: timeoutHandle,
      });

      const message: WorkerMessage = { id, type, payload };
      this.worker!.postMessage(message);
    });
  }

  /**
   * Cancel task in Worker
   */
  public async abortTask(abortId: string): Promise<void> {
    if (!this.worker || !this.isInitialized) {
      return;
    }

    const message: WorkerMessage = {
      id: `abort-${Date.now()}`,
      type: 'abort',
      payload: { abortId },
    };
    this.worker.postMessage(message);
    console.info(`[CompileWorkerClient] Sent abort request: ${abortId}`);
  }

  /**
   * Compile LaTeX document
   */
  public async compileLatex(
    content: string,
    options: CompilationOptions = {},
    onProgress?: (progress: CompileProgress) => void,
    onLog?: (log: CompileLog) => void,
    timeout?: number
  ): Promise<CompilationResult> {
    return this.sendRequest<CompilationResult>(
      'compile',
      { content, options },
      {
        timeout,
        onProgress,
        onLog,
      }
    );
  }

  /**
   * Compile Typst document
   */
  public async compileTypst(
    content: string,
    options: TypstCompilationOptions = {},
    onProgress?: (progress: CompileProgress) => void,
    onLog?: (log: CompileLog) => void,
    timeout?: number
  ): Promise<CompilationResult> {
    return this.sendRequest<CompilationResult>(
      'compileTypst',
      { content, options },
      {
        timeout,
        onProgress,
        onLog,
      }
    );
  }

  /**
   * Cleanup temporary files
   */
  public async cleanup(): Promise<void> {
    return this.sendRequest<void>('cleanup', {}, { timeout: CLEANUP_TIMEOUT });
  }

  /**
   * Close Worker
   */
  public async close(): Promise<void> {
    // Cleanup restart manager
    this.restartManager.dispose();

    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
      this.isInitialized = false;
      this.pendingRequests.clear();
      console.info('[CompileWorkerClient] ✓ Worker closed');
    }
  }

  /**
   * Check if Worker is running
   */
  public isRunning(): boolean {
    return this.isInitialized && this.worker !== null;
  }
}

// Export singleton instance
export const compileWorkerClient = CompileWorkerClient.getInstance();

// Export class for testing
export { CompileWorkerClient };
