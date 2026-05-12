/**
 * @file DocumentSession - File-level collaboration session state
 * @description Collects the implicit state of joinFile (file-level) into an explicit object.
 *   Each DocumentSession corresponds to one remote file currently being edited and carries the
 *   content, version, pending/outstanding op queues, and the offline queue.
 *
 *   Does not alter the underlying OT protocol semantics; provides a unified state-query layer
 *   only.
 */

import { Emitter, type Event } from '../../../shared/utils';
import type {
  IRemoteProjectBridge,
  BridgeDocumentState,
  BridgeRemotePatchEvent,
  BridgeSubmitOpsResult,
} from './interfaces/IRemoteProjectBridge';
import type { IDisposable } from './ServiceContainer';
import { createLogger } from './LoggerService';

const logger = createLogger('DocumentSession');

// ====== Document session state ======

export type DocumentSyncState =
  | 'joining'
  | 'synchronized'
  | 'pending'
  | 'outstanding'
  | 'offline'
  | 'conflict'
  | 'closed';

export interface DocumentSessionState {
  projectId: string;
  fileId: string;
  /** Current editor content (latest version) */
  content: string;
  /** Version acknowledged by the remote */
  version: number;
  /** Sync state */
  syncState: DocumentSyncState;
  /** Local ops waiting to be sent */
  pendingOpsCount: number;
  /** Ops sent but not yet acknowledged */
  outstandingOpsCount: number;
  /** Ops queued while offline */
  offlineQueueCount: number;
}

// ====== DocumentSession implementation ======

export class DocumentSession implements IDisposable {
  private _state: DocumentSessionState;

  private readonly _onStateChanged = new Emitter<DocumentSessionState>();
  readonly onStateChanged: Event<DocumentSessionState> = this._onStateChanged.event;

  private readonly _onRemotePatch = new Emitter<BridgeRemotePatchEvent>();
  readonly onRemotePatch: Event<BridgeRemotePatchEvent> = this._onRemotePatch.event;

  private readonly disposables: IDisposable[] = [];

  constructor(
    private readonly bridge: IRemoteProjectBridge,
    init: { projectId: string; fileId: string }
  ) {
    this._state = {
      projectId: init.projectId,
      fileId: init.fileId,
      content: '',
      version: 0,
      syncState: 'joining',
      pendingOpsCount: 0,
      outstandingOpsCount: 0,
      offlineQueueCount: 0,
    };

    // Forward only remotePatch events for the current file
    this.disposables.push(
      bridge.onRemotePatch((patch) => {
        if (patch.fileId === init.fileId) {
          this._state = {
            ...this._state,
            content: patch.content,
            version: patch.version,
          };
          this._onRemotePatch.fire(patch);
          this._onStateChanged.fire(this._state);
        }
      })
    );

    // Connection-state transitions feed into sync state
    this.disposables.push(
      bridge.onConnectionChanged((conn) => {
        if (conn.state === 'disconnected' || conn.state === 'read_only_disconnected') {
          if (this._state.syncState !== 'closed') {
            this.updateSyncState('offline');
          }
        } else if (conn.state === 'connected') {
          if (this._state.syncState === 'offline') {
            this.updateSyncState('synchronized');
          }
        }
      })
    );
  }

  get state(): Readonly<DocumentSessionState> {
    return this._state;
  }

  /**
   * Joins the document edit session.
   */
  async join(): Promise<BridgeDocumentState> {
    const doc = await this.bridge.joinDocument(this._state.projectId, this._state.fileId);
    this._state = {
      ...this._state,
      content: doc.content,
      version: doc.version,
      syncState: 'synchronized',
    };
    this._onStateChanged.fire(this._state);
    logger.info(`Document session joined: ${this._state.fileId} v${doc.version}`);
    return doc;
  }

  /**
   * Submits local ops to the remote.
   */
  async submitOps(ops: unknown[]): Promise<BridgeSubmitOpsResult> {
    this.updateSyncState('outstanding');
    try {
      const result = await this.bridge.submitOps({
        projectId: this._state.projectId,
        fileId: this._state.fileId,
        version: this._state.version,
        ops,
      });
      this._state = {
        ...this._state,
        version: result.version,
        syncState: 'synchronized',
      };
      this._onStateChanged.fire(this._state);
      return result;
    } catch (error) {
      // Submit failure does not auto-transition to conflict; let the caller decide.
      this.updateSyncState('pending');
      throw error;
    }
  }

  /**
   * Updates local content (called on editor input).
   */
  setLocalContent(content: string): void {
    this._state = { ...this._state, content };
  }

  /**
   * Updates the sync state.
   */
  updateSyncState(state: DocumentSyncState): void {
    if (this._state.syncState !== state) {
      this._state = { ...this._state, syncState: state };
      this._onStateChanged.fire(this._state);
    }
  }

  /**
   * Updates op-queue counts (called by the offline manager).
   */
  updateQueueCounts(counts: {
    pending?: number;
    outstanding?: number;
    offline?: number;
  }): void {
    this._state = {
      ...this._state,
      pendingOpsCount: counts.pending ?? this._state.pendingOpsCount,
      outstandingOpsCount: counts.outstanding ?? this._state.outstandingOpsCount,
      offlineQueueCount: counts.offline ?? this._state.offlineQueueCount,
    };
    this._onStateChanged.fire(this._state);
  }

  /**
   * Leaves the document edit session.
   */
  leave(): void {
    this.bridge.leaveDocument(this._state.projectId, this._state.fileId);
    this.updateSyncState('closed');
    logger.info(`Document session left: ${this._state.fileId}`);
  }

  dispose(): void {
    if (this._state.syncState !== 'closed') {
      this.leave();
    }
    for (const d of this.disposables) d.dispose();
    this._onStateChanged.dispose();
    this._onRemotePatch.dispose();
  }
}
