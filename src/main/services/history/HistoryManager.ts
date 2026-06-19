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
import { createHistoryService, type HistoryService } from './HistoryService';
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
  /**
   * If set, schedule an orphan-blob sweep this often (ms) across every open
   * HistoryService. Defaults to 24h. Set to 0 to disable the timer (tests).
   */
  sweepIntervalMs?: number;
  /** Forwarded to BlobStore.sweepOrphans — min age before a row is reaped. */
  sweepMinAgeMs?: number;
}

/**
 * Limits `projectId` to a single path segment of bounded length. Keeps the
 * `path.join(baseDir, 'projects', projectId, 'history')` resolution inside
 * the base — `..`, `/`, `\` and similar separators are excluded.
 */
const PROJECT_ID_RX = /^[A-Za-z0-9_-]{1,128}$/;

export class HistoryManager {
  private readonly services = new Map<string, HistoryService>();
  private readonly blobStores = new Map<
    string,
    { sweep: () => Promise<{ rows: number; files: number }> }
  >();
  private sweepTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(private readonly opts: HistoryManagerOptions) {
    this.armSweepTimer();
  }

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
    this.blobStores.set(projectId, {
      sweep: () => blobStore.sweepOrphans(this.opts.sweepMinAgeMs),
    });
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
    this.blobStores.delete(projectId);
    await svc.dispose();
    logger.info('closed HistoryService', { projectId });
  }

  /** IDisposable for ServiceContainer auto-cleanup on app quit. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    const all = Array.from(this.services.values());
    this.services.clear();
    this.blobStores.clear();
    await Promise.all(all.map((s) => s.dispose()));
    logger.info('disposed HistoryManager', { closedCount: all.length });
  }

  /**
   * Trigger an orphan sweep across every currently-open project. Returns the
   * aggregated counts. Public so tests / admin actions can force a sweep
   * without waiting for the daily timer.
   *
   * Also folds long chunk chains via `mergeAllChunks` so the GC cycle does
   * both cleanups in one pass — chunk merging produces fresh orphan blobs
   * (intermediate base/target hashes), and the sweep that follows reaps them.
   */
  async sweepAll(): Promise<{ rows: number; files: number; chunksMerged: number }> {
    if (this.disposed) return { rows: 0, files: 0, chunksMerged: 0 };
    let chunksMerged = 0;
    // Merge first, sweep after — merging decRefs intermediate blobs and the
    // sweep then reaps them within the same cycle.
    for (const [projectId, _store] of this.blobStores) {
      const svc = this.services.get(projectId);
      if (!svc) continue;
      try {
        const result = await svc.mergeAllChunks();
        chunksMerged += result.merged;
      } catch (err) {
        logger.warn('mergeAllChunks failed for one project', {
          projectId,
          error: (err as Error).message,
        });
      }
      void _store;
    }
    let rows = 0;
    let files = 0;
    for (const store of this.blobStores.values()) {
      try {
        const result = await store.sweep();
        rows += result.rows;
        files += result.files;
      } catch (err) {
        logger.warn('sweep failed for one project', { error: (err as Error).message });
      }
    }
    return { rows, files, chunksMerged };
  }

  private armSweepTimer(): void {
    const interval = this.opts.sweepIntervalMs ?? 24 * 60 * 60 * 1000;
    if (interval <= 0) return;
    this.sweepTimer = setInterval(() => void this.sweepAll(), interval);
    // Don't keep the event loop alive purely for the sweep timer.
    if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref();
  }
}

export function createHistoryManager(opts: HistoryManagerOptions): HistoryManager {
  return new HistoryManager(opts);
}
