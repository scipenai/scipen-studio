/**
 * @file ExternalChangeDetector - External modification detector
 * @description Detects local replica edits from external editors/scripts and aggregates them for
 *   the conflict resolution flow.
 *
 * Flow:
 * 1. Receive file change events from FileWorkerClient.
 * 2. Filter out OT writeback-triggered events via EchoSuppressor.
 * 3. Surviving events enter the time-window aggregator.
 * 4. After aggregation, emit a single_external_change or bulk_external_change event.
 *
 * @depends EchoSuppressor, FileWorkerClient
 */

import path from 'path';
import fs from 'fs-extra';
import { Emitter, type Event } from '../../../shared/utils';
import type { EchoSuppressor } from './EchoSuppressor';
import { ALWAYS_IGNORE_DIRS } from './interfaces/IProjectBindingService';
import { createLogger } from './LoggerService';
import type { IDisposable } from './ServiceContainer';

const logger = createLogger('ExternalChangeDetector');

// ====== Constants ======

const AGGREGATION_WINDOW_MS = 3000;
const BULK_THRESHOLD = 5;

// ====== Types ======

/** T7: sync status categories for external file changes */
export type ExternalFileSyncStatus = 'SYNCED' | 'CONFLICT' | 'NEW' | 'DELETED';

export interface ExternalChangeFile {
  /** Relative file path */
  relativePath: string;
  /** Absolute path */
  absolutePath: string;
  /** Change type */
  changeType: 'modified' | 'created' | 'deleted';
  /** File size in bytes; zero for deletions */
  fileSize: number;
  /** T7: sync status after comparison with the cloud snapshot */
  syncStatus: ExternalFileSyncStatus;
}

export interface ExternalChangeBatch {
  /** Batch ID */
  batchId: string;
  /** Project root directory */
  projectRootPath: string;
  /** Changed files */
  files: ExternalChangeFile[];
  /** Whether the batch exceeded the bulk threshold */
  isBulk: boolean;
  /** Detection timestamp */
  detectedAt: number;
}

// ====== Service implementation ======

export class ExternalChangeDetector implements IDisposable {
  private projectRootPath: string | null = null;
  private echoSuppressor: EchoSuppressor | null = null;

  /** Pending events inside the current aggregation window */
  private pendingChanges: ExternalChangeFile[] = [];
  /** Aggregation window timer */
  private aggregationTimer: ReturnType<typeof setTimeout> | null = null;
  /** Batch counter */
  private batchCounter = 0;

  private readonly _onExternalChange = new Emitter<ExternalChangeBatch>();
  readonly onExternalChange: Event<ExternalChangeBatch> = this._onExternalChange.event;

  /**
   * Binds to a collaborative project and starts detecting external changes.
   */
  bind(projectRootPath: string, echoSuppressor: EchoSuppressor): void {
    this.unbind();
    this.projectRootPath = projectRootPath;
    this.echoSuppressor = echoSuppressor;
    logger.info(`External change detector bound: ${projectRootPath}`);
  }

  /**
   * Unbinds and flushes any pending events.
   */
  unbind(): void {
    this.flushPending();
    this.projectRootPath = null;
    this.echoSuppressor = null;
  }

  /**
   * Called by the file watcher to report a change event. Runs echo suppression first; events
   * that pass it enter the aggregation window.
   */
  async reportChange(
    absolutePath: string,
    changeType: 'modified' | 'created' | 'deleted'
  ): Promise<void> {
    if (!this.projectRootPath || !this.echoSuppressor) return;

    // Must be inside the project directory
    const relativePath = path.relative(this.projectRootPath, absolutePath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) return;

    // Skip always-ignored directories (.git, output, build, etc.)
    const pathParts = relativePath.split(/[\\/]/);
    if (pathParts.some((part) => ALWAYS_IGNORE_DIRS.has(part))) return;

    // Echo suppression: discard events caused by our own writeback
    if (changeType !== 'deleted') {
      try {
        const content = await fs.readFile(absolutePath);
        const result = this.echoSuppressor.check(absolutePath, content);
        if (result.suppressed) return;
      } catch {
        // File might have been deleted between events; ignore
        return;
      }
    } else {
      // Deletion: drop the event if the path is registered in the suppressor
      if (this.echoSuppressor.isRegistered(absolutePath)) {
        this.echoSuppressor.clear(absolutePath);
        return;
      }
    }

    // Passed echo suppression - this is a genuine external change
    let fileSize = 0;
    if (changeType !== 'deleted') {
      try {
        const stat = await fs.stat(absolutePath);
        fileSize = stat.size;
      } catch {
        // ignore
      }
    }

    // T7: initial sync status based on change type; "modified" is provisionally marked as
    // conflict and the resolution flow will refine it later.
    const syncStatus: ExternalFileSyncStatus =
      changeType === 'created' ? 'NEW' : changeType === 'deleted' ? 'DELETED' : 'CONFLICT';

    this.pendingChanges.push({
      relativePath: relativePath.replace(/\\/g, '/'),
      absolutePath,
      changeType,
      fileSize,
      syncStatus,
    });

    // Reset the aggregation window timer
    if (this.aggregationTimer) {
      clearTimeout(this.aggregationTimer);
    }
    this.aggregationTimer = setTimeout(() => {
      this.flushPending();
    }, AGGREGATION_WINDOW_MS);
  }

  dispose(): void {
    this.unbind();
    this._onExternalChange.dispose();
  }

  // ====== Private helpers ======

  /**
   * Flushes the aggregation window and emits a batch event.
   */
  private flushPending(): void {
    if (this.aggregationTimer) {
      clearTimeout(this.aggregationTimer);
      this.aggregationTimer = null;
    }

    if (this.pendingChanges.length === 0) return;

    const files = [...this.pendingChanges];
    this.pendingChanges = [];

    const batch: ExternalChangeBatch = {
      batchId: `batch-${++this.batchCounter}`,
      projectRootPath: this.projectRootPath || '',
      files,
      isBulk: files.length >= BULK_THRESHOLD,
      detectedAt: Date.now(),
    };

    logger.info(
      `External change detected: ${batch.isBulk ? 'bulk' : 'single'} (${files.length} files)`
    );

    this._onExternalChange.fire(batch);
  }
}
