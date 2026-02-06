/**
 * @file LogParserClient - Log Parser Worker Client
 * @description Provides async interface for logParser.worker communication
 * @depends worker_threads, workerUtils
 */

import { Worker } from 'worker_threads';
import { WorkerRestartManager, delay, getWorkerPath } from './workerUtils';

// ============ Type Definitions ============

interface WorkerMessage {
  id: string;
  type: 'parse';
  payload: {
    content: string;
  };
}

interface WorkerResponse {
  id: string;
  success: boolean;
  data?: ParseResult;
  error?: string;
}

/** Parsed log entry */
export interface ParsedLogEntry {
  line: number | null;
  file: string;
  level: 'error' | 'warning' | 'info';
  message: string;
  content: string;
  raw: string;
}

export interface ParseResult {
  errors: ParsedLogEntry[];
  warnings: ParsedLogEntry[];
  info: ParsedLogEntry[];
}

// ============ Timeout Configuration ============

/** Default parse timeout (30 seconds) */
const PARSE_TIMEOUT = 30000;

// ============ Singleton Client ============

class LogParserClientImpl {
  private static instance: LogParserClientImpl | null = null;

  private worker: Worker | null = null;
  private pendingRequests: Map<
    string,
    {
      resolve: (value: ParseResult) => void;
      reject: (error: Error) => void;
      timeout?: ReturnType<typeof setTimeout>;
    }
  > = new Map();
  private requestIdCounter = 0;
  private isInitialized = false;
  private restartManager = new WorkerRestartManager('LogParserClient');
  private isRestarting = false;

  private constructor() {}

  /**
   * Get singleton instance
   */
  public static getInstance(): LogParserClientImpl {
    if (!LogParserClientImpl.instance) {
      LogParserClientImpl.instance = new LogParserClientImpl();
    }
    return LogParserClientImpl.instance;
  }

  /**
   * Initialize worker
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    // Use unified path resolution utility
    const workerPath = getWorkerPath('logParser');
    console.info('[LogParserClient] Worker path:', workerPath);

    try {
      this.worker = new Worker(workerPath);

      this.worker.on('message', (message: WorkerResponse) => {
        this.handleWorkerMessage(message);
      });

      this.worker.on('error', (error) => {
        console.error('[LogParserClient] Worker error:', error);
        // Reject all pending requests and clear timeouts
        for (const [id, pending] of this.pendingRequests) {
          if (pending.timeout) {
            clearTimeout(pending.timeout);
          }
          pending.reject(error);
          this.pendingRequests.delete(id);
        }
      });

      this.worker.on('exit', (code) => {
        console.info(`[LogParserClient] Worker exited with code: ${code}`);
        this.isInitialized = false;
        this.worker = null;
        // If abnormal exit, attempt auto-restart
        if (code !== 0) {
          this.attemptRestart();
        }
      });

      this.isInitialized = true;
      // Worker successfully initialized, reset restart count
      this.restartManager.reset();
      console.info('[LogParserClient] Worker initialized');
    } catch (error) {
      console.error('[LogParserClient] Failed to initialize worker:', error);
      throw error;
    }
  }

  /**
   * Attempt to auto-restart Worker
   */
  private async attemptRestart(): Promise<void> {
    if (this.isRestarting) {
      return;
    }

    if (!this.restartManager.canRestart()) {
      console.error('[LogParserClient] Reached max restart attempts, no longer attempting restart');
      return;
    }

    this.isRestarting = true;
    const waitTime = this.restartManager.recordRestart();

    if (waitTime > 0) {
      await delay(waitTime);
    }

    try {
      console.info('[LogParserClient] Attempting to restart Worker...');
      await this.initialize();
      console.info('[LogParserClient] ✓ Worker restart successful');
    } catch (error) {
      console.error('[LogParserClient] Worker restart failed:', error);
    } finally {
      this.isRestarting = false;
    }
  }

  /**
   * Handle worker message
   */
  private handleWorkerMessage(message: WorkerResponse): void {
    const pending = this.pendingRequests.get(message.id);
    if (!pending) {
      console.warn('[LogParserClient] Received response for unknown request:', message.id);
      return;
    }

    // Clear timeout
    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }
    this.pendingRequests.delete(message.id);

    if (message.success && message.data) {
      pending.resolve(message.data);
    } else {
      pending.reject(new Error(message.error || 'Unknown error'));
    }
  }

  /**
   * Generate unique request ID
   */
  private generateId(): string {
    return `logparse-${Date.now()}-${++this.requestIdCounter}`;
  }

  /**
   * Parse LaTeX log content
   *
   * @param content Raw log content
   * @param timeout Optional custom timeout in ms (default: 30s)
   * @returns Parsed result with errors, warnings, and info
   */
  public async parse(content: string, timeout: number = PARSE_TIMEOUT): Promise<ParseResult> {
    if (!this.isInitialized || !this.worker) {
      await this.initialize();
    }

    const id = this.generateId();

    return new Promise((resolve, reject) => {
      // Set up timeout
      const timeoutHandle = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Log parsing timed out after ${timeout}ms`));
        }
      }, timeout);

      this.pendingRequests.set(id, { resolve, reject, timeout: timeoutHandle });

      const message: WorkerMessage = {
        id,
        type: 'parse',
        payload: { content },
      };

      this.worker!.postMessage(message);
    });
  }

  /**
   * Terminate worker
   */
  public async terminate(): Promise<void> {
    // Cleanup restart manager
    this.restartManager.dispose();

    if (this.worker) {
      // Clear timeout timers for all pending requests
      for (const pending of this.pendingRequests.values()) {
        if (pending.timeout) {
          clearTimeout(pending.timeout);
        }
      }
      this.pendingRequests.clear();

      await this.worker.terminate();
      this.worker = null;
      this.isInitialized = false;
      console.info('[LogParserClient] Worker terminated');
    }
  }

  /**
   * Check if worker is available
   */
  public isAvailable(): boolean {
    return this.isInitialized && this.worker !== null;
  }
}

// Export singleton getter
export function getLogParserClient(): LogParserClientImpl {
  return LogParserClientImpl.getInstance();
}

// Export type for external use
export type LogParserClient = LogParserClientImpl;
