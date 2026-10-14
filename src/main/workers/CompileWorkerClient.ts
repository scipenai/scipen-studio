/**
 * @file CompileWorkerClient - Compile Worker Client
 * @description Provides async interface for compile.worker communication, executes LaTeX compilation
 * @depends worker_threads, workerUtils, BaseWorkerClient
 */

import { BaseWorkerClient, type PendingRequest } from './BaseWorkerClient';

// ====== Type Definitions ======

/** LaTeX compilation request payload */
interface CompileLatexPayload {
  content: string;
  options?: CompilationOptions;
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
  | { id: string; type: 'cleanup'; payload: CleanupPayload }
  | { id: string; type: 'abort'; payload: AbortPayload };

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

/** Pending entry enriched with the compile-specific streaming callbacks. */
interface CompilePendingRequest extends PendingRequest {
  onProgress?: (progress: CompileProgress) => void;
  onLog?: (log: CompileLog) => void;
}

// ====== Singleton Client ======

class CompileWorkerClient extends BaseWorkerClient {
  private static instance: CompileWorkerClient | null = null;

  private constructor() {
    super({
      name: 'CompileWorkerClient',
      workerKind: 'compile',
      idPrefix: 'compile',
      // Compile manages timeouts per request (abort-on-timeout), so the
      // base default is only a backstop.
      defaultTimeout: 0,
      pingOnInit: false,
      rejectPendingOnAbnormalExit: true,
    });
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

  /** Route per-request progress/log streams; responses fall through. */
  protected tryHandleMessage(message: unknown): boolean {
    if (typeof message !== 'object' || message === null) return false;
    const m = message as ProgressMessage | LogMessage;
    if (!('type' in m) || (m.type !== 'progress' && m.type !== 'log')) return false;

    const pending = this.pendingRequests.get(m.id) as CompilePendingRequest | undefined;
    if (!pending) return true; // stream for an unknown/finished request — drop

    if (m.type === 'progress') {
      pending.onProgress?.({ progress: m.progress, message: m.message });
      this.emit('progress', m.id, m.progress, m.message);
    } else {
      pending.onLog?.({ level: m.level, message: m.message });
      this.emit('log', m.id, m.level, m.message);
    }
    return true;
  }

  /** Public initialize — LaTeXCompiler boots the worker explicitly. */
  public override initialize(): Promise<void> {
    return super.initialize();
  }

  /**
   * Send request to Worker (compile-flavoured: streaming callbacks +
   * abort-on-timeout + caller-supplied request id).
   *
   * `requestId` lets the caller (LaTeXCompiler) use ITS task id on the wire
   * so a later `abortTask(taskId)` hits the exact pending entry — the old
   * prefix-matching fallback in the worker silently killed the wrong task.
   */
  private async sendCompileRequest<T>(
    type: WorkerMessage['type'],
    payload: WorkerMessage['payload'],
    options: {
      timeout?: number;
      onProgress?: (progress: CompileProgress) => void;
      onLog?: (log: CompileLog) => void;
      requestId?: string;
    } = {}
  ): Promise<T> {
    if (!this.worker || !this.isInitialized) {
      await this.initialize();
    }

    const { timeout = DEFAULT_COMPILE_TIMEOUT, onProgress, onLog } = options;

    return new Promise((resolve, reject) => {
      const id =
        options.requestId ?? `compile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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

      const entry: CompilePendingRequest = {
        resolve: (value) => resolve(value as T),
        reject,
        onProgress,
        onLog,
        timeout: timeoutHandle,
      };
      this.pendingRequests.set(id, entry);

      const message = { id, type, payload } as WorkerMessage;
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
    timeout?: number,
    requestId?: string
  ): Promise<CompilationResult> {
    return this.sendCompileRequest<CompilationResult>(
      'compile',
      { content, options },
      {
        timeout,
        onProgress,
        onLog,
        requestId,
      }
    );
  }

  /**
   * Cleanup temporary files
   */
  public async cleanup(): Promise<void> {
    return this.sendCompileRequest<void>('cleanup', {}, { timeout: CLEANUP_TIMEOUT });
  }

  /**
   * Close Worker
   */
  public async close(): Promise<void> {
    // In-flight compiles are dropped, not rejected — matches the original
    // semantics (close happens during app shutdown).
    await this.closeWorker(null);
    console.info('[CompileWorkerClient] ✓ Worker closed');
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
