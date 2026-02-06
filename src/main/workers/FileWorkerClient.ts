/**
 * @file FileWorkerClient - File Worker Client
 * @description Wraps file.worker communication, provides Promise API for file tree scanning and watching
 * @depends worker_threads, workerUtils
 */

import { EventEmitter } from 'events';
import { Worker } from 'worker_threads';
import { WorkerRestartManager, createWorkerLogger, delay, getWorkerPath } from './workerUtils';

const logger = createWorkerLogger('FileWorkerClient');

// ====== Types ======

export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
  /** Whether directory children have been resolved (lazy-load flag) */
  isResolved?: boolean;
}

export interface FileChangeEvent {
  type: 'change' | 'unlink' | 'add';
  path: string;
  mtime?: number;
}

interface WorkerResponse {
  id: string;
  success: boolean;
  data?: any;
  error?: string;
  isResponse?: boolean;
}

interface WorkerEvent {
  type: 'file-change' | 'watcher-error' | 'scan-progress';
  data: any;
  isEvent?: boolean;
}

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeout?: NodeJS.Timeout;
};

// ====== FileWorkerClient ======

export class FileWorkerClient extends EventEmitter {
  private worker: Worker | null = null;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private requestId = 0;
  private isInitialized = false;
  private initPromise: Promise<void> | null = null;
  private restartManager = new WorkerRestartManager('FileWorkerClient');
  private isRestarting = false;

  // 2 minutes - large directory scans may need more time
  private defaultTimeout = 2 * 60 * 1000;

  // Cache watcher state for recovery after crash restart
  private watcherState: {
    dirPath: string;
    ignorePatterns?: string[];
  } | null = null;

  // ====== Initialization ======

  private async initialize(): Promise<void> {
    if (this.isInitialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = new Promise<void>((resolve, reject) => {
      try {
        const workerPath = getWorkerPath('file');
        logger.debug('Worker path:', workerPath);

        this.worker = new Worker(workerPath);

        this.worker.on('message', (message: WorkerResponse | WorkerEvent) => {
          if ('isResponse' in message && message.isResponse) {
            this.handleResponse(message as WorkerResponse);
          } else if ('isEvent' in message && message.isEvent) {
            this.handleWorkerEvent(message as WorkerEvent);
          }
        });

        this.worker.on('error', (error) => {
          logger.error('Worker error:', error);
          this.handleWorkerError(error);
        });

        this.worker.on('exit', (code) => {
          if (code !== 0) {
            logger.error(`Worker exited with code ${code}`);
            this.attemptRestart();
          }
          this.isInitialized = false;
          this.worker = null;
          this.initPromise = null;
        });

        this.sendRequest('ping', {})
          .then(() => {
            this.isInitialized = true;
            this.restartManager.reset();
            logger.debug('Worker initialized successfully');
            resolve();
          })
          .catch(reject);
      } catch (error) {
        reject(error);
      }
    });

    return this.initPromise;
  }

  /** Auto-restart Worker and recover watcher state on success */
  private async attemptRestart(): Promise<void> {
    if (this.isRestarting) {
      return;
    }

    if (!this.restartManager.canRestart()) {
      logger.error('Max restart attempts reached');
      this.emit('maxRestartsReached');
      return;
    }

    this.isRestarting = true;
    const waitTime = this.restartManager.recordRestart();

    if (waitTime > 0) {
      await delay(waitTime);
    }

    try {
      logger.info('Attempting Worker restart...');
      await this.initialize();
      logger.info('✓ Worker restart successful');

      if (this.watcherState) {
        logger.info('Restoring watcher state:', this.watcherState.dirPath);
        try {
          await this.sendRequest('startWatching', {
            dirPath: this.watcherState.dirPath,
            ignorePatterns: this.watcherState.ignorePatterns,
          });
          logger.info('✓ Watcher restored');
          this.emit('watcherRestored', this.watcherState.dirPath);
        } catch (watchError) {
          logger.error('Watcher restore failed:', watchError);
          this.watcherState = null;
          this.emit('watcherRestoreFailed', watchError);
        }
      }
    } catch (error) {
      logger.error('Worker restart failed:', error);
    } finally {
      this.isRestarting = false;
    }
  }

  // ====== Message Handling ======

  private handleResponse(response: WorkerResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      logger.warn(`Received response for unknown request: ${response.id}`);
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

  private handleWorkerEvent(event: WorkerEvent): void {
    switch (event.type) {
      case 'file-change':
        const events = event.data as FileChangeEvent[];
        for (const e of events) {
          this.emit('file-changed', e);
        }
        break;

      case 'watcher-error':
        this.emit('watcher-error', event.data);
        break;

      case 'scan-progress':
        this.emit('scan-progress', event.data);
        break;
    }
  }

  private handleWorkerError(error: Error): void {
    for (const [, pending] of this.pendingRequests) {
      if (pending.timeout) {
        clearTimeout(pending.timeout);
      }
      pending.reject(error);
    }
    this.pendingRequests.clear();

    this.emit('error', error);
  }

  private sendRequest<T>(type: string, payload: any, timeout?: number): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new Error('Worker not initialized'));
        return;
      }

      const id = `file-${++this.requestId}`;
      const timeoutMs = timeout ?? this.defaultTimeout;

      const pending: PendingRequest = { resolve, reject };

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

  // ====== Public API ======

  /**
   * Scan directory with depth limit.
   * @param depth Scan depth (default 1 = first level only, subdirs lazy-loaded)
   */
  async scanDirectory(
    dirPath: string,
    ignorePatterns?: string[],
    abortId?: string,
    depth = 1
  ): Promise<FileNode> {
    await this.initialize();

    return this.sendRequest<FileNode>('scanDirectory', {
      dirPath,
      ignorePatterns,
      abortId,
      depth,
    });
  }

  /** Resolve immediate children of a directory (lazy-load on expand) */
  async resolveChildren(dirPath: string, ignorePatterns?: string[]): Promise<FileNode[]> {
    await this.initialize();

    return this.sendRequest<FileNode[]>('resolveChildren', {
      dirPath,
      ignorePatterns,
    });
  }

  /**
   * Scan all file paths as flat list (for @ completion index).
   *
   * Why separate method? Lightweight scan: collects path strings only,
   * no tree structure. Faster and lower memory than scanDirectory.
   */
  async scanFilePaths(
    dirPath: string,
    ignorePatterns?: string[],
    abortId?: string
  ): Promise<string[]> {
    await this.initialize();

    return this.sendRequest<string[]>('scanFilePaths', {
      dirPath,
      ignorePatterns,
      abortId,
    });
  }

  async abortScan(abortId: string): Promise<void> {
    if (!this.isInitialized) return;

    return this.sendRequest('abort', { abortId });
  }

  /** Start watching directory. State is cached for recovery after crash restart. */
  async startWatching(dirPath: string, ignorePatterns?: string[]): Promise<void> {
    await this.initialize();

    this.watcherState = { dirPath, ignorePatterns };

    return this.sendRequest('startWatching', {
      dirPath,
      ignorePatterns,
    });
  }

  async stopWatching(): Promise<void> {
    this.watcherState = null;

    if (!this.isInitialized) return;

    return this.sendRequest('stopWatching', {});
  }

  async findFiles(
    dirPath: string,
    extension: string,
    ignorePatterns?: string[]
  ): Promise<string[]> {
    await this.initialize();

    return this.sendRequest<string[]>('findFiles', {
      dirPath,
      extension,
      ignorePatterns,
    });
  }

  async close(): Promise<void> {
    this.restartManager.dispose();
    await this.stopWatching();
    this.watcherState = null;

    if (this.worker) {
      for (const [, pending] of this.pendingRequests) {
        if (pending.timeout) {
          clearTimeout(pending.timeout);
        }
        pending.reject(new Error('Worker is closing'));
      }
      this.pendingRequests.clear();

      await this.worker.terminate();
      this.worker = null;
      this.isInitialized = false;
      this.initPromise = null;
      logger.debug('Worker closed');
    }
  }

  getWatcherState(): { dirPath: string; ignorePatterns?: string[] } | null {
    return this.watcherState;
  }
}

// ====== Singleton Instance ======

let fileWorkerClientInstance: FileWorkerClient | null = null;

export function getFileWorkerClient(): FileWorkerClient {
  if (!fileWorkerClientInstance) {
    fileWorkerClientInstance = new FileWorkerClient();
  }
  return fileWorkerClientInstance;
}

export async function closeFileWorkerClient(): Promise<void> {
  if (fileWorkerClientInstance) {
    await fileWorkerClientInstance.close();
    fileWorkerClientInstance = null;
  }
}
