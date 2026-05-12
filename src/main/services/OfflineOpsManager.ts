/**
 * @file OfflineOpsManager - Offline operation manager
 * @description Wires OfflineOpsStore into the scipen-ot code path.
 *
 * Rules:
 * - Only OT-managed text files support offline editing.
 * - Edits continue while offline; ops land in pendingOpsStore.
 * - After reconnect, fetch the latest file state once and replay pending ops.
 * - If transform still yields a submittable op, advance the version; otherwise enter conflict.
 * - Sessions older than 24h are treated as stale - refresh is forced before replay.
 *
 * @depends StudioOTService, OfflineOpsStore
 */

import { createHash } from 'crypto';
import { Emitter, type Event } from '../../../shared/utils';
import type {
  StudioOTRawOp,
  OTConnectionStateDTO,
  StudioOTSubmitFileOpResult,
} from '../../../shared/api-types';
import type { OfflineOpsStore, PendingOperation, ReplayResult } from './OfflineOpsStore';
import type { StudioOTService } from './StudioOTService';
import type { IDisposable } from './ServiceContainer';
import { createLogger } from './LoggerService';

const logger = createLogger('OfflineOpsManager');

/** Default stale-session threshold: 24 hours */
const DEFAULT_STALE_SESSION_MS = 24 * 60 * 60 * 1000;
/** Default warning ratio: fires at 80% of the threshold */
const DEFAULT_STALE_WARNING_RATIO = 0.8;

export type OfflineManagerState = 'online' | 'offline' | 'replaying' | 'conflict';

export interface OfflineConflict {
  fileId: string;
  reason: string;
  pendingOps: PendingOperation[];
}

function computeContentHash(content: string): string {
  return createHash('md5').update(content).digest('hex').slice(0, 8);
}

export interface OfflineOpsManagerOptions {
  /** Stale-session threshold in ms (default 24h) */
  staleSessionMs?: number;
  /** Warning ratio (default 0.8: fires at 80% of the threshold) */
  staleWarningRatio?: number;
}

export interface StaleWarningEvent {
  elapsedMs: number;
  thresholdMs: number;
}

export class OfflineOpsManager implements IDisposable {
  private _state: OfflineManagerState = 'online';
  private _offlineSince: number | null = null;
  private _activeProjectId: string | null = null;
  private _conflicts: OfflineConflict[] = [];
  private staleWarningTimer: ReturnType<typeof setTimeout> | null = null;
  private _replayInProgress = false;

  private readonly staleSessionMs: number;
  private readonly staleWarningRatio: number;

  private readonly _onStateChanged = new Emitter<OfflineManagerState>();
  readonly onStateChanged: Event<OfflineManagerState> = this._onStateChanged.event;

  private readonly _onConflict = new Emitter<OfflineConflict>();
  readonly onConflict: Event<OfflineConflict> = this._onConflict.event;

  private readonly _onReplayComplete = new Emitter<ReplayResult>();
  readonly onReplayComplete: Event<ReplayResult> = this._onReplayComplete.event;

  /** T12: stale warning - fires when offline duration is about to exceed the threshold */
  private readonly _onStaleWarning = new Emitter<StaleWarningEvent>();
  readonly onStaleWarning: Event<StaleWarningEvent> = this._onStaleWarning.event;

  private readonly disposables: IDisposable[] = [];

  constructor(
    private readonly otService: StudioOTService,
    private readonly store: OfflineOpsStore,
    options?: OfflineOpsManagerOptions
  ) {
    this.staleSessionMs = options?.staleSessionMs ?? DEFAULT_STALE_SESSION_MS;
    this.staleWarningRatio = options?.staleWarningRatio ?? DEFAULT_STALE_WARNING_RATIO;
    // Track OT connection state transitions
    this.disposables.push(
      otService.onDidChangeConnection((conn) => {
        void this.handleConnectionChange(conn);
      })
    );
  }

  get state(): OfflineManagerState {
    return this._state;
  }

  get conflicts(): ReadonlyArray<OfflineConflict> {
    return this._conflicts;
  }

  /**
   * Sets the active project id (called by ProjectSessionManager).
   */
  setActiveProject(projectId: string | null): void {
    this._activeProjectId = projectId;
  }

  /**
   * Submits ops - sends directly while online, persists while offline.
   * Called by DocumentSession or the editor instead of StudioOTService.submitFileOp directly.
   */
  async submitOps(
    projectId: string,
    fileId: string,
    version: number,
    ops: StudioOTRawOp[],
    localContent: string
  ): Promise<StudioOTSubmitFileOpResult> {
    if (this._state === 'online') {
      try {
        return await this.otService.submitForegroundFileOp({
          projectId,
          fileId,
          version,
          ops,
        });
      } catch (error) {
        // Connection error - fall back to offline buffering
        logger.warn(
          `submitOps online submit failed, falling back to offline storage: ${error instanceof Error ? error.message : String(error)}`
        );
        await this.store.save(projectId, fileId, version, ops, computeContentHash(localContent));
        return { status: 'buffered', version };
      }
    }

    // Offline: persist to SQLite
    await this.store.save(projectId, fileId, version, ops, computeContentHash(localContent));
    logger.info(`Offline ops buffered: ${fileId} v${version} (${ops.length} ops)`);
    return { status: 'buffered', version };
  }

  /**
   * Returns whether any offline ops are awaiting replay for a project.
   */
  async hasPendingOps(projectId: string): Promise<boolean> {
    return this.store.hasPending(projectId);
  }

  /**
   * Triggers replay manually (for dev/debug or explicit user action).
   */
  async replayPendingOps(projectId: string): Promise<ReplayResult> {
    return this.doReplay(projectId);
  }

  /**
   * Clears conflict state and pending ops for a file (user chose to discard local edits).
   */
  async discardPendingOps(projectId: string, fileId: string): Promise<void> {
    await this.store.clearByFile(projectId, fileId);
    this._conflicts = this._conflicts.filter((c) => c.fileId !== fileId);
    if (this._conflicts.length === 0 && this._state === 'conflict') {
      this.setState('online');
    }
    logger.info(`Discarded offline ops: ${fileId}`);
  }

  // ====== Internals ======

  private async handleConnectionChange(conn: OTConnectionStateDTO): Promise<void> {
    if (conn.state === 'disconnected' || conn.state === 'reconnecting') {
      if (this._state === 'online') {
        this._offlineSince = Date.now();
        this.setState('offline');
        this.startStaleWarningTimer();
        logger.info('OT connection lost, switching to offline mode');
      }
    } else if (conn.state === 'connected') {
      this.clearStaleWarningTimer();
      if (this._state === 'offline') {
        logger.info('OT connection restored, checking offline ops');
        if (this._activeProjectId) {
          const hasPending = await this.store.hasPending(this._activeProjectId);
          if (hasPending) {
            await this.doReplay(this._activeProjectId);
          } else {
            this.setState('online');
          }
        } else {
          this.setState('online');
        }
        this._offlineSince = null;
      }
    }
  }

  private async doReplay(projectId: string): Promise<ReplayResult> {
    if (this._replayInProgress) {
      logger.warn('doReplay is already running, skipping duplicate invocation');
      return {
        success: false,
        replayed: 0,
        conflicts: [{ fileId: '*', reason: 'Replay already in progress' }],
      };
    }
    this._replayInProgress = true;
    this.setState('replaying');
    const result: ReplayResult = { success: true, replayed: 0, conflicts: [] };

    try {
      // Detect stale sessions
      const isStale =
        this._offlineSince !== null && Date.now() - this._offlineSince > this.staleSessionMs;

      if (isStale) {
        logger.warn('Offline session exceeded 24h, marking it stale before replay');
      }

      // Group every pending op by file
      const allOps = await this.store.getByProject(projectId);
      const fileGroups = new Map<string, PendingOperation[]>();
      for (const op of allOps) {
        const list = fileGroups.get(op.fileId) ?? [];
        list.push(op);
        fileGroups.set(op.fileId, list);
      }

      for (const [fileId, ops] of fileGroups) {
        try {
          if (isStale) {
            // Stale session: force-discard local edits and keep the remote state
            logger.warn(`Stale session discarded offline ops: ${fileId} (${ops.length} ops)`);
            await this.store.clearByFile(projectId, fileId);
            result.conflicts.push({
              fileId,
              reason: 'Offline for more than 24h; local edits discarded',
            });
            continue;
          }

          // Replay ops one by one via submitReplayFileOp so the target file is set correctly
          for (const op of ops) {
            try {
              const submitResult = await this.otService.submitReplayFileOp(
                projectId,
                fileId,
                op.ops
              );

              if (submitResult.status === 'applied') {
                await this.store.remove(op.id);
                result.replayed++;
              } else if (submitResult.status === 'desynced') {
                // Keep the record - mark as conflict and stop replaying this file
                logger.warn(`Replay desync detected: ${fileId} v${op.baseVersion}`);
                result.conflicts.push({ fileId, reason: `desync at version ${op.baseVersion}` });
                result.success = false;
                break;
              }
            } catch (submitError) {
              const reason =
                submitError instanceof Error ? submitError.message : String(submitError);
              logger.error(`Replay failed: ${fileId} v${op.baseVersion}: ${reason}`);
              result.conflicts.push({ fileId, reason });
              result.success = false;
              break;
            }
          }
        } catch (fileError) {
          const reason = fileError instanceof Error ? fileError.message : String(fileError);
          logger.error(`Failed to fetch latest file state: ${fileId}: ${reason}`);
          result.conflicts.push({ fileId, reason });
          result.success = false;
        }
      }
    } catch (error) {
      logger.error('Replay pipeline error', error);
      result.success = false;
    }

    // Update conflict state
    if (result.conflicts.length > 0) {
      for (const c of result.conflicts) {
        const ops = await this.store.getByFile(projectId, c.fileId);
        this._conflicts.push({ fileId: c.fileId, reason: c.reason, pendingOps: ops });
        this._onConflict.fire(this._conflicts[this._conflicts.length - 1]);
      }
      this.setState('conflict');
    } else {
      this._conflicts = [];
      this.setState('online');
    }

    this._replayInProgress = false;
    this._onReplayComplete.fire(result);
    logger.info(
      `Replay completed: ${result.replayed} succeeded, ${result.conflicts.length} conflicts`
    );
    return result;
  }

  private setState(state: OfflineManagerState): void {
    if (this._state !== state) {
      this._state = state;
      this._onStateChanged.fire(state);
    }
  }

  // ====== T12: stale warning timer ======

  private startStaleWarningTimer(): void {
    this.clearStaleWarningTimer();
    const warningMs = this.staleSessionMs * this.staleWarningRatio;
    this.staleWarningTimer = setTimeout(() => {
      this.staleWarningTimer = null;
      if (this._offlineSince !== null) {
        const elapsedMs = Date.now() - this._offlineSince;
        logger.warn(
          `Offline session nearing stale threshold: ${Math.round(elapsedMs / 1000)}s / ${Math.round(this.staleSessionMs / 1000)}s`
        );
        this._onStaleWarning.fire({ elapsedMs, thresholdMs: this.staleSessionMs });
      }
    }, warningMs);
  }

  private clearStaleWarningTimer(): void {
    if (this.staleWarningTimer) {
      clearTimeout(this.staleWarningTimer);
      this.staleWarningTimer = null;
    }
  }

  dispose(): void {
    this.clearStaleWarningTimer();
    for (const d of this.disposables) d.dispose();
    this._onStateChanged.dispose();
    this._onConflict.dispose();
    this._onReplayComplete.dispose();
    this._onStaleWarning.dispose();
  }
}
