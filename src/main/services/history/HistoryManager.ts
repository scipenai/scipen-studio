/**
 * @file HistoryManager - per-project HistoryService lifecycle.
 *
 * One `HistoryService` per `projectId` (each owns its own SQLite file + blobs/
 * directory). The manager lazy-creates instances on first access and disposes
 * them on `close(projectId)` or process exit (via `IDisposable.dispose`).
 *
 * Multi-project hosts (the main electron process) get a single manager from
 * the DI container; renderer IPC handlers route the active project id to it.
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '../LoggerService';
import { createBlobStore } from './BlobStore';
import { createHistoryService, HistoryService } from './HistoryService';
import { createMetaDb } from './MetaDb';

const logger = createLogger('HistoryManager');

export interface HistoryManagerOptions {
  /**
   * Absolute base directory under which every project's history root is
   * created (e.g. `{userData}/scipen-studio`). Per-project subdir is
   * `{baseDir}/projects/{projectId}/history`.
   */
  baseDir: string;
  /** Forwarded to each BlobStore instance the manager creates. */
  inlineMaxBytes: number;
}

/**
 * Limits `projectId` to a single path segment of bounded length. Keeps the
 * `path.join(baseDir, 'projects', projectId, 'history')` resolution inside
 * the base — `..`, `/`, `\` and similar separators are excluded.
 */
const PROJECT_ID_RX = /^[A-Za-z0-9_-]{1,128}$/;

export class HistoryManager {
  private readonly services = new Map<string, HistoryService>();
  private disposed = false;

  constructor(private readonly opts: HistoryManagerOptions) {}

  /**
   * Lazy: return the existing HistoryService for `projectId` or build one.
   * Subsequent calls for the same id alias to the same instance — the
   * underlying SQLite handle is single-writer, so sharing is mandatory.
   */
  getOrCreate(projectId: string): HistoryService {
    if (this.disposed) throw new Error('HistoryManager has been disposed');
    if (!PROJECT_ID_RX.test(projectId)) {
      throw new Error(`Invalid projectId: ${JSON.stringify(projectId)}`);
    }
    const existing = this.services.get(projectId);
    if (existing) return existing;
    const rootDir = path.join(this.opts.baseDir, 'projects', projectId, 'history');
    mkdirSync(rootDir, { recursive: true });
    const metaDb = createMetaDb({ rootDir });
    const blobStore = createBlobStore({
      rootDir,
      inlineMaxBytes: this.opts.inlineMaxBytes,
      metaDb,
    });
    const svc = createHistoryService({ metaDb, blobStore });
    this.services.set(projectId, svc);
    logger.info('opened HistoryService', { projectId, rootDir });
    return svc;
  }

  /** True if a HistoryService is currently open for `projectId`. */
  has(projectId: string): boolean {
    return this.services.has(projectId);
  }

  async close(projectId: string): Promise<void> {
    const svc = this.services.get(projectId);
    if (!svc) return;
    this.services.delete(projectId);
    await svc.dispose();
    logger.info('closed HistoryService', { projectId });
  }

  /** IDisposable for ServiceContainer auto-cleanup on app quit. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const all = Array.from(this.services.values());
    this.services.clear();
    await Promise.all(all.map((s) => s.dispose()));
    logger.info('disposed HistoryManager', { closedCount: all.length });
  }
}

export function createHistoryManager(opts: HistoryManagerOptions): HistoryManager {
  return new HistoryManager(opts);
}
