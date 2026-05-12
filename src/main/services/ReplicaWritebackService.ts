/**
 * @file ReplicaWritebackService - Local replica writeback service
 * @description Writes state from the cloud OT source of truth back to the local disk replica.
 *
 * Responsibilities:
 * - Manages the writeback task queue (1s debounce for the active file, 10s for others).
 * - Propagates remote create/delete/rename events to the local filesystem.
 * - Registers writes with EchoSuppressor so the watcher does not flag them as external edits.
 *
 * @depends EchoSuppressor, StudioOTService, FileSystemService
 */

import path from 'path';
import fs from 'fs-extra';
import { Emitter, type Event } from '../../../shared/utils';
import type { OTFileEventDTO, OTRemoteUpdateDTO } from '../../../shared/api-types';
import { EchoSuppressor } from './EchoSuppressor';
import { createLogger } from './LoggerService';
import { ServiceNames, getServiceContainer } from './ServiceContainer';
import type { StudioOTService } from './StudioOTService';
import type { IDisposable } from './ServiceContainer';

const logger = createLogger('ReplicaWritebackService');

// ====== Constants ======

const ACTIVE_FILE_DEBOUNCE_MS = 1000;
const INACTIVE_FILE_DEBOUNCE_MS = 10_000;
const IDLE_FLUSH_DELAY_MS = 5000;
const TRASH_DIR = '.scipen/.trash';
const MAX_WRITE_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

// ====== Types ======

interface WritebackTask {
  /** Relative file path */
  filePath: string;
  /** Content to write */
  content: string;
  /** Debounce timer */
  timer: ReturnType<typeof setTimeout>;
  /** Enqueue timestamp */
  queuedAt: number;
}

/** Writeback success event */
export interface WritebackCompleteEvent {
  filePath: string;
  absolutePath: string;
  action: 'write' | 'create' | 'delete' | 'rename';
}

/** Writeback failure event (fired after retries are exhausted) */
export interface WritebackErrorEvent {
  filePath: string;
  absolutePath: string;
  error: unknown;
}

// ====== Service implementation ======

export class ReplicaWritebackService implements IDisposable {
  private projectRootPath: string | null = null;
  private activeFilePath: string | null = null;
  private pendingWrites = new Map<string, WritebackTask>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimers = new Set<ReturnType<typeof setTimeout>>();
  private disposed = false;

  readonly echoSuppressor = new EchoSuppressor();

  private readonly _onWritebackComplete = new Emitter<WritebackCompleteEvent>();
  readonly onWritebackComplete: Event<WritebackCompleteEvent> = this._onWritebackComplete.event;

  private readonly _onWritebackError = new Emitter<WritebackErrorEvent>();
  readonly onWritebackError: Event<WritebackErrorEvent> = this._onWritebackError.event;

  private eventListeners: Array<IDisposable> = [];

  /**
   * Binds to a collaborative project and starts listening for OT events.
   */
  bind(projectRootPath: string): void {
    this.unbind();
    this.projectRootPath = projectRootPath;

    const otService = getServiceContainer().get<StudioOTService>(ServiceNames.STUDIO_OT);

    // Subscribe to remote content updates (remote edits)
    this.eventListeners.push(
      otService.onDidReceiveRemoteUpdate((update) => {
        this.enqueueContentWrite(update);
      })
    );

    // Subscribe to file create/delete/rename events
    this.eventListeners.push(
      otService.onDidReceiveFileEvent((event) => {
        void this.handleFileEvent(event);
      })
    );

    logger.info(`Writeback service bound: ${projectRootPath}`);
  }

  /**
   * Unbinds and flushes every pending writeback.
   */
  unbind(): void {
    // Flush all pending writebacks synchronously
    this.flushAll();

    for (const listener of this.eventListeners) {
      listener.dispose();
    }
    this.eventListeners = [];

    this.projectRootPath = null;
    this.activeFilePath = null;
  }

  /**
   * Sets the currently active file (affects debounce window).
   */
  setActiveFile(relativeFilePath: string | null): void {
    this.activeFilePath = relativeFilePath;
  }

  /**
   * Flushes a specific file immediately (used when the user saves).
   */
  async flushFile(relativeFilePath: string): Promise<void> {
    const task = this.pendingWrites.get(relativeFilePath);
    if (task) {
      clearTimeout(task.timer);
      this.pendingWrites.delete(relativeFilePath);
      await this.executeWrite(relativeFilePath, task.content);
    }
  }

  /**
   * Flushes every pending writeback immediately.
   */
  flushAll(): void {
    for (const [filePath, task] of this.pendingWrites) {
      clearTimeout(task.timer);
      // Fall back to a synchronous write so shutdown does not drop data
      if (this.projectRootPath) {
        try {
          const absolutePath = path.join(this.projectRootPath, filePath);
          this.echoSuppressor.register(absolutePath, task.content);
          fs.ensureDirSync(path.dirname(absolutePath));
          fs.writeFileSync(absolutePath, task.content, 'utf-8');
        } catch (err) {
          logger.error(`flushAll synchronous writeback failed: ${filePath}`, err);
        }
      }
    }
    this.pendingWrites.clear();

    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
    this.unbind();
    this.echoSuppressor.dispose();
    this._onWritebackComplete.dispose();
    this._onWritebackError.dispose();
  }

  // ====== Private helpers ======

  /**
   * Enqueues a remote content update onto the writeback queue.
   */
  private enqueueContentWrite(update: OTRemoteUpdateDTO): void {
    if (!this.projectRootPath || this.disposed) return;

    const filePath = update.filePath;
    if (!filePath) return;

    // Cancel any prior timer for the same file
    const existing = this.pendingWrites.get(filePath);
    if (existing) {
      clearTimeout(existing.timer);
    }

    const debounceMs =
      filePath === this.activeFilePath ? ACTIVE_FILE_DEBOUNCE_MS : INACTIVE_FILE_DEBOUNCE_MS;

    const timer = setTimeout(() => {
      this.pendingWrites.delete(filePath);
      void this.executeWrite(filePath, update.content);
    }, debounceMs);

    this.pendingWrites.set(filePath, {
      filePath,
      content: update.content,
      timer,
      queuedAt: Date.now(),
    });

    // Reset the idle flush timer
    this.resetIdleTimer();
  }

  /**
   * Performs the actual disk write for a single file, with exponential backoff retries.
   */
  private async executeWrite(
    relativeFilePath: string,
    content: string,
    retryCount = 0
  ): Promise<void> {
    if (!this.projectRootPath) return;

    const absolutePath = path.join(this.projectRootPath, relativeFilePath);

    try {
      this.echoSuppressor.register(absolutePath, content);
      await fs.ensureDir(path.dirname(absolutePath));
      await fs.writeFile(absolutePath, content, 'utf-8');

      this._onWritebackComplete.fire({
        filePath: relativeFilePath,
        absolutePath,
        action: 'write',
      });
    } catch (err) {
      if (retryCount < MAX_WRITE_RETRIES && !this.disposed) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, retryCount);
        logger.warn(
          `Writeback failed, retrying in ${delay}ms (${retryCount + 1}/${MAX_WRITE_RETRIES}): ${absolutePath}`
        );
        const timer = setTimeout(() => {
          this.retryTimers.delete(timer);
          if (!this.disposed) void this.executeWrite(relativeFilePath, content, retryCount + 1);
        }, delay);
        this.retryTimers.add(timer);
      } else {
        logger.error(`Writeback failed after ${MAX_WRITE_RETRIES} retries: ${absolutePath}`, err);
        this._onWritebackError.fire({ filePath: relativeFilePath, absolutePath, error: err });
      }
    }
  }

  /**
   * Handles a remote file structure event (create/delete/rename).
   */
  private async handleFileEvent(event: OTFileEventDTO): Promise<void> {
    if (!this.projectRootPath || this.disposed) return;

    const absolutePath = path.join(this.projectRootPath, event.filePath);

    switch (event.action) {
      case 'created':
        await this.handleRemoteCreate(event, absolutePath);
        break;
      case 'deleted':
        await this.handleRemoteDelete(event, absolutePath);
        break;
      case 'renamed':
        // Rename = delete old path + create new path. The OT server splits it into two
        // events, so here we only process the new-path created event.
        await this.handleRemoteCreate(event, absolutePath);
        break;
    }
  }

  /**
   * Remote created a file - create the matching local file (with exponential backoff retries).
   */
  private async handleRemoteCreate(
    event: OTFileEventDTO,
    absolutePath: string,
    retryCount = 0
  ): Promise<void> {
    try {
      if (event.entityType === 'folder') {
        this.echoSuppressor.register(absolutePath, '');
        await fs.ensureDir(absolutePath);
      } else {
        const otService = getServiceContainer().get<StudioOTService>(ServiceNames.STUDIO_OT);
        if (!event.fileId) return;

        const file = await otService.getProjectFile(event.projectId, event.fileId);
        this.echoSuppressor.register(absolutePath, file.content);
        await fs.ensureDir(path.dirname(absolutePath));
        await fs.writeFile(absolutePath, file.content, 'utf-8');
      }

      this._onWritebackComplete.fire({
        filePath: event.filePath,
        absolutePath,
        action: 'create',
      });
      logger.info(`Remote create -> local: ${event.filePath}`);
    } catch (err) {
      if (retryCount < MAX_WRITE_RETRIES) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, retryCount);
        logger.warn(
          `Remote create writeback failed, retrying in ${delay}ms (${retryCount + 1}/${MAX_WRITE_RETRIES}): ${event.filePath}`
        );
        const timer = setTimeout(() => {
          this.retryTimers.delete(timer);
          if (!this.disposed) void this.handleRemoteCreate(event, absolutePath, retryCount + 1);
        }, delay);
        this.retryTimers.add(timer);
      } else {
        logger.error(
          `Remote create writeback failed after ${MAX_WRITE_RETRIES} retries: ${event.filePath}`,
          err
        );
        this._onWritebackError.fire({ filePath: event.filePath, absolutePath, error: err });
      }
    }
  }

  /**
   * Remote deleted a file - move the local copy to .scipen/.trash/ (soft delete, with retries).
   */
  private async handleRemoteDelete(
    event: OTFileEventDTO,
    absolutePath: string,
    retryCount = 0
  ): Promise<void> {
    try {
      if (!(await fs.pathExists(absolutePath))) return;

      const trashDir = path.join(this.projectRootPath!, TRASH_DIR);
      const trashPath = path.join(trashDir, `${Date.now()}_${path.basename(event.filePath)}`);

      this.echoSuppressor.register(absolutePath, '');
      await fs.ensureDir(trashDir);
      await fs.move(absolutePath, trashPath);

      this._onWritebackComplete.fire({
        filePath: event.filePath,
        absolutePath,
        action: 'delete',
      });
      logger.info(`Remote delete -> moved local file to trash: ${event.filePath}`);
    } catch (err) {
      if (retryCount < MAX_WRITE_RETRIES) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, retryCount);
        logger.warn(
          `Remote delete handling failed, retrying in ${delay}ms (${retryCount + 1}/${MAX_WRITE_RETRIES}): ${event.filePath}`
        );
        const timer = setTimeout(() => {
          this.retryTimers.delete(timer);
          if (!this.disposed) void this.handleRemoteDelete(event, absolutePath, retryCount + 1);
        }, delay);
        this.retryTimers.add(timer);
      } else {
        logger.error(
          `Remote delete handling failed after ${MAX_WRITE_RETRIES} retries: ${event.filePath}`,
          err
        );
        this._onWritebackError.fire({ filePath: event.filePath, absolutePath, error: err });
      }
    }
  }

  /**
   * Idle timer: flushes every pending writeback after a period of inactivity.
   */
  private resetIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => {
      this.flushAll();
    }, IDLE_FLUSH_DELAY_MS);
  }
}
