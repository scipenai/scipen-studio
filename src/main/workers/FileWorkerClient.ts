/**
 * @file FileWorkerClient - File Worker Client
 * @description Wraps file.worker communication, provides Promise API for file tree scanning and watching
 * @depends worker_threads, workerUtils, BaseWorkerClient
 */

import { BaseWorkerClient } from './BaseWorkerClient';

import type { FileNode, FileChangeEvent } from '../services/interfaces/IFileSystemService';

export type { FileNode, FileChangeEvent };

interface WorkerEvent {
  type: 'file-change' | 'watcher-error' | 'scan-progress';
  data: unknown;
  isEvent?: boolean;
}

// ====== FileWorkerClient ======

export class FileWorkerClient extends BaseWorkerClient {
  // 2 minutes - large directory scans may need more time
  private static readonly DEFAULT_TIMEOUT = 2 * 60 * 1000;

  // Cache watcher state for recovery after crash restart
  private watcherState: {
    dirPath: string;
    ignorePatterns?: string[];
  } | null = null;

  constructor() {
    super({
      name: 'FileWorkerClient',
      workerKind: 'file',
      idPrefix: 'file',
      defaultTimeout: FileWorkerClient.DEFAULT_TIMEOUT,
      pingOnInit: true,
      rejectPendingOnAbnormalExit: false,
    });
  }

  /** Route worker-pushed events; responses fall through to the base. */
  protected tryHandleMessage(message: unknown): boolean {
    if (typeof message !== 'object' || message === null) return false;
    const event = message as WorkerEvent;
    if (!event.isEvent) return false;

    switch (event.type) {
      case 'file-change': {
        const events = event.data as FileChangeEvent[];
        for (const e of events) {
          this.emit('file-changed', e);
        }
        break;
      }

      case 'watcher-error':
        this.emit('watcher-error', event.data);
        break;

      case 'scan-progress':
        this.emit('scan-progress', event.data);
        break;
    }
    return true;
  }

  /** Re-arm the directory watcher after a crash restart. */
  protected override async onRestarted(): Promise<void> {
    if (!this.watcherState) return;
    this.log.info('Restoring watcher state:', this.watcherState.dirPath);
    try {
      await this.sendRequest('startWatching', {
        dirPath: this.watcherState.dirPath,
        ignorePatterns: this.watcherState.ignorePatterns,
      });
      this.log.info('✓ Watcher restored');
      this.emit('watcherRestored', this.watcherState.dirPath);
    } catch (watchError) {
      this.log.error('Watcher restore failed:', watchError);
      this.watcherState = null;
      this.emit('watcherRestoreFailed', watchError);
    }
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
    await this.stopWatching();
    this.watcherState = null;
    await this.closeWorker('Worker is closing');
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
