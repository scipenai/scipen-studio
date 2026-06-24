/**
 * @file ChunkWriter - async batched consumer that turns "an edit happened"
 *   notifications into `history_chunk` rows.
 *
 * Wire-up neutral: any event source (OT op stream, file save, SNACA tool turn
 * applying, Diff Review accept) can call `recordEdit` and forget. The writer
 * batches per-`fileId`, flushing on either an op-count threshold or an idle
 * deadline, whichever fires first. Flushes run on a microtask so the caller's
 * critical path never observes I/O.
 *
 * Errors during a flush are surfaced through the `onError` callback rather
 * than thrown back to the caller — the OT log is the truth, the chunk is the
 * index. A dropped chunk is reconstructable; blocking the editor is not.
 */

import { createLogger } from '../LoggerService';
import type { HistoryManager } from './HistoryManager';
import { DEFAULT_HISTORY_CONFIG, type HistoryConfig } from './types';

const logger = createLogger('ChunkWriter');

export interface RecordEditInput {
  projectId: string;
  fileId: string;
  /** OT version at which `prevContent` is observed. */
  versionFrom: number;
  /** OT version after the ops in this edit are applied; matches `currContent`. */
  versionTo: number;
  prevContent: Uint8Array;
  currContent: Uint8Array;
  opCount: number;
  actor: string | null;
}

interface PendingBatch {
  projectId: string;
  fileId: string;
  /** Earliest unflushed version pair's `versionFrom`. */
  baseVersion: number;
  /** Most recent edit's `versionTo`. */
  headVersion: number;
  /** Snapshot at `baseVersion`. */
  baseContent: Uint8Array;
  /** Snapshot at `headVersion`. */
  headContent: Uint8Array;
  opCount: number;
  actor: string | null;
  /** Wall-clock of the first edit folded into this batch; drives the idle flush. */
  startedAt: number;
}

export interface ChunkWriterOptions {
  historyManager: HistoryManager;
  config?: Partial<Pick<HistoryConfig, 'chunkFlushOps' | 'chunkFlushIdleMs'>>;
  /** Surface flush failures here; defaults to a logger warning. */
  onError?: (err: Error, context: { projectId: string; fileId: string }) => void;
  /** Override the clock for deterministic tests. */
  now?: () => number;
}

export class ChunkWriter {
  private readonly cfg: Pick<HistoryConfig, 'chunkFlushOps' | 'chunkFlushIdleMs'>;
  private readonly pending = new Map<string, PendingBatch>();
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly now: () => number;
  private idleTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(private readonly opts: ChunkWriterOptions) {
    this.cfg = {
      chunkFlushOps: opts.config?.chunkFlushOps ?? DEFAULT_HISTORY_CONFIG.chunkFlushOps,
      chunkFlushIdleMs: opts.config?.chunkFlushIdleMs ?? DEFAULT_HISTORY_CONFIG.chunkFlushIdleMs,
    };
    this.now = opts.now ?? Date.now;
  }

  /**
   * Record an edit. Returns synchronously; the actual chunk write is scheduled
   * on a microtask (or coalesced into a later flush). Idempotent on the (file,
   * version) pair only if the caller serializes its edits — concurrent
   * `recordEdit` calls for the same file race on the in-memory batch and the
   * later call wins.
   */
  recordEdit(input: RecordEditInput): void {
    if (this.disposed) throw new Error('ChunkWriter has been disposed');
    const key = batchKey(input.projectId, input.fileId);
    const existing = this.pending.get(key);
    if (existing) {
      // Extend the head; base stays anchored at the first observed version.
      existing.headVersion = input.versionTo;
      existing.headContent = input.currContent;
      existing.opCount += input.opCount;
      if (input.actor) existing.actor = input.actor;
    } else {
      this.pending.set(key, {
        projectId: input.projectId,
        fileId: input.fileId,
        baseVersion: input.versionFrom,
        headVersion: input.versionTo,
        baseContent: input.prevContent,
        headContent: input.currContent,
        opCount: input.opCount,
        actor: input.actor,
        startedAt: this.now(),
      });
    }

    const batch = this.pending.get(key)!;
    if (batch.opCount >= this.cfg.chunkFlushOps) {
      queueMicrotask(() => void this.flushKey(key));
    } else {
      this.armIdleTimer();
    }
  }

  /** Force-flush every pending batch + await any in-flight work. */
  async flushAll(): Promise<void> {
    const keys = new Set<string>([...this.pending.keys(), ...this.inflight.keys()]);
    await Promise.all(Array.from(keys).map((k) => this.flushKey(k)));
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    await this.flushAll();
  }

  /** Diagnostics: number of pending (un-flushed) batches. Tests rely on this. */
  pendingCount(): number {
    return this.pending.size;
  }

  // ---- internals ----

  private async flushKey(key: string): Promise<void> {
    // Coalesce concurrent flushes for the same key — the later caller awaits
    // the in-flight one, then no-ops because pending has already drained.
    const inflight = this.inflight.get(key);
    if (inflight) return inflight;
    const batch = this.pending.get(key);
    if (!batch) return;
    this.pending.delete(key);

    const work = (async (): Promise<void> => {
      try {
        await this.opts.historyManager.getOrCreate(batch.projectId).recordChunk({
          projectId: batch.projectId,
          fileId: batch.fileId,
          versionFrom: batch.baseVersion,
          versionTo: batch.headVersion,
          baseContent: batch.baseContent,
          targetContent: batch.headContent,
          opCount: batch.opCount,
          primaryActor: batch.actor,
        });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (this.opts.onError) {
          this.opts.onError(error, { projectId: batch.projectId, fileId: batch.fileId });
        } else {
          logger.warn('chunk flush failed', {
            projectId: batch.projectId,
            fileId: batch.fileId,
            error: error.message,
          });
        }
      }
    })();
    this.inflight.set(key, work);
    try {
      await work;
    } finally {
      this.inflight.delete(key);
    }
  }

  private armIdleTimer(): void {
    if (this.idleTimer || this.disposed) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.flushIdle();
    }, this.cfg.chunkFlushIdleMs);
    // Don't keep the event loop alive just for the writer.
    if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref();
  }

  private async flushIdle(): Promise<void> {
    const now = this.now();
    const stale: string[] = [];
    for (const [key, batch] of this.pending) {
      if (now - batch.startedAt >= this.cfg.chunkFlushIdleMs) stale.push(key);
    }
    await Promise.all(stale.map((k) => this.flushKey(k)));
    if (this.pending.size > 0) this.armIdleTimer();
  }
}

export function createChunkWriter(opts: ChunkWriterOptions): ChunkWriter {
  return new ChunkWriter(opts);
}

function batchKey(projectId: string, fileId: string): string {
  return `${projectId}:${fileId}`;
}
