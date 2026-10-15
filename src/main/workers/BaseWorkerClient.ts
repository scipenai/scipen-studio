/**
 * @file BaseWorkerClient - shared worker-thread RPC pipeline
 * @description Owns the request/response machinery every worker client
 * needs: lazy worker boot (optional ping probe), pending-request map with
 * per-request timeouts, crash rejection, back-off restarts, and shutdown.
 * Subclasses only declare their config and translate worker events.
 * @depends worker_threads, workerUtils
 */

import { EventEmitter } from 'events';
import { Worker } from 'worker_threads';
import { WorkerRestartManager, createWorkerLogger, delay, getWorkerPath } from './workerUtils';

export interface BaseWorkerClientOptions {
  /** Log + restart-manager label, e.g. "FileWorkerClient". */
  name: string;
  /** Worker file key for getWorkerPath ('file' | 'pdf' | 'compile'). */
  workerKind: string;
  /** Request-id prefix; ids are `${idPrefix}-${n}`. */
  idPrefix: string;
  /** Default per-request timeout in ms; 0 disables timeouts. */
  defaultTimeout: number;
  /** Probe the worker with a `ping` request before marking it ready. */
  pingOnInit: boolean;
  /** Reject all pending requests when the worker exits abnormally
   * (compile does this so callers fail fast on a crashed compiler). */
  rejectPendingOnAbnormalExit: boolean;
}

interface WorkerResponse {
  id: string;
  success: boolean;
  data?: unknown;
  error?: string;
  isResponse?: boolean;
}

export type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout?: NodeJS.Timeout;
};

function isWorkerResponse(message: unknown): message is WorkerResponse {
  if (typeof message !== 'object' || message === null) return false;
  const m = message as Record<string, unknown>;
  // FileWorker tags responses explicitly; untagged id+success messages
  // (pdf / compile) are responses too. Events/progress carry an id but no
  // `success` field.
  return 'id' in m && 'success' in m && m.isResponse !== false;
}

export abstract class BaseWorkerClient extends EventEmitter {
  protected worker: Worker | null = null;
  protected pendingRequests: Map<string, PendingRequest> = new Map();
  protected isInitialized = false;
  protected initPromise: Promise<void> | null = null;

  private requestId = 0;
  private restartManager: WorkerRestartManager;
  private isRestarting = false;
  private readonly opts: BaseWorkerClientOptions;
  protected readonly log;

  protected constructor(opts: BaseWorkerClientOptions) {
    super();
    this.opts = opts;
    this.restartManager = new WorkerRestartManager(opts.name);
    this.log = createWorkerLogger(opts.name);
  }

  /**
   * Handle a non-response worker message (events, progress, logs).
   * Return true when the message was consumed; otherwise the message is
   * routed to the pending-request response path.
   */
  protected abstract tryHandleMessage(message: unknown): boolean;

  /**
   * Restore subclass state after a crash restart (e.g. re-arm the file
   * watcher). Runs after the worker is back up; errors are logged, never
   * propagated.
   */
  protected async onRestarted(): Promise<void> {}

  // ====== Lifecycle ======

  protected async initialize(): Promise<void> {
    if (this.isInitialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = new Promise<void>((resolve, reject) => {
      try {
        const workerPath = getWorkerPath(this.opts.workerKind);
        this.log.debug('Worker path:', workerPath);

        this.worker = new Worker(workerPath);

        this.worker.on('message', (message: unknown) => {
          if (this.tryHandleMessage(message)) return;
          if (isWorkerResponse(message)) {
            this.handleResponse(message);
          }
        });

        this.worker.on('error', (error) => {
          this.log.error('Worker error:', error);
          this.rejectAllPendingRequests(error);
          this.emit('error', error);
        });

        this.worker.on('exit', (code) => {
          if (code !== 0) {
            this.log.error(`Worker exited with code ${code}`);
            if (this.opts.rejectPendingOnAbnormalExit) {
              this.rejectAllPendingRequests(new Error(`Worker exited with code ${code}`));
            }
            this.attemptRestart();
          }
          this.isInitialized = false;
          this.worker = null;
          this.initPromise = null;
        });

        if (this.opts.pingOnInit) {
          this.sendRequest('ping', {})
            .then(() => {
              this.isInitialized = true;
              this.restartManager.reset();
              this.log.debug('Worker initialized successfully');
              resolve();
            })
            .catch(reject);
        } else {
          this.isInitialized = true;
          this.restartManager.reset();
          this.log.debug('Worker initialized successfully');
          resolve();
        }
      } catch (error) {
        reject(error);
      }
    });

    return this.initPromise;
  }

  /** Auto-restart the worker after a crash, then let the subclass recover. */
  private async attemptRestart(): Promise<void> {
    if (this.isRestarting) {
      return;
    }

    if (!this.restartManager.canRestart()) {
      this.log.error('Max restart attempts reached');
      this.emit('maxRestartsReached');
      return;
    }

    this.isRestarting = true;
    const waitTime = this.restartManager.recordRestart();

    if (waitTime > 0) {
      await delay(waitTime);
    }

    try {
      this.log.info('Attempting Worker restart...');
      await this.initialize();
      this.log.info('✓ Worker restart successful');
      await this.onRestarted();
    } catch (error) {
      this.log.error('Worker restart failed:', error);
    } finally {
      this.isRestarting = false;
    }
  }

  // ====== Message Handling ======

  private handleResponse(response: WorkerResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      this.log.warn(`Received response for unknown request: ${response.id}`);
      return;
    }

    this.pendingRequests.delete(response.id);

    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }

    if (response.success) {
      pending.resolve(response.data);
    } else {
      pending.reject(new Error(response.error || 'Unknown error'));
    }
  }

  protected rejectAllPendingRequests(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      if (pending.timeout) {
        clearTimeout(pending.timeout);
      }
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  // ====== Requests ======

  protected sendRequest<T>(type: string, payload: unknown, timeout?: number): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new Error('Worker not initialized'));
        return;
      }

      const id = `${this.opts.idPrefix}-${++this.requestId}`;
      const timeoutMs = timeout ?? this.opts.defaultTimeout;

      const pending: PendingRequest = {
        resolve: (value) => resolve(value as T),
        reject,
      };

      if (timeoutMs > 0) {
        pending.timeout = setTimeout(() => {
          this.pendingRequests.delete(id);
          reject(new Error(`Request ${type} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }

      this.pendingRequests.set(id, pending);

      this.worker.postMessage({ id, type, payload });
    });
  }

  /** Terminate the worker. `rejectMessage` settles in-flight requests when
   * set; when null they are dropped silently (compile semantics). */
  protected async closeWorker(rejectMessage: string | null): Promise<void> {
    this.restartManager.dispose();

    if (this.worker) {
      if (rejectMessage !== null) {
        this.rejectAllPendingRequests(new Error(rejectMessage));
      } else {
        this.pendingRequests.clear();
      }

      await this.worker.terminate();
      this.worker = null;
      this.isInitialized = false;
      this.initPromise = null;
      this.log.debug('Worker closed');
    }
  }
}
