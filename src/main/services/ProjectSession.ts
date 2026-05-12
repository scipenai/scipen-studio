/**
 * @file ProjectSession - Project-level collaboration session state
 * @description Collects the implicit state of openLocalProject (project-level) into an explicit
 *   object. Each ProjectSession corresponds to one active remote project connection and carries
 *   file-tree, connection-state, and other project-level data.
 *
 *   Does not change the behavioral semantics of StudioOTService / StudioOverleafLiveService;
 *   provides a unified state-query and event-dispatch layer only.
 */

import { Emitter, type Event } from '../../../shared/utils';
import type { RemoteProjectBackend } from '../../../shared/api-types';
import type {
  IRemoteProjectBridge,
  BridgeConnectionState,
  BridgeProjectSnapshot,
  BridgeFileEntry,
  BridgeFolderEntry,
  BridgeTreeChangeEvent,
} from './interfaces/IRemoteProjectBridge';
import type { IDisposable } from './ServiceContainer';
import { createLogger } from './LoggerService';

const logger = createLogger('ProjectSession');

// ====== Project session state ======

export interface ProjectSessionState {
  /** Binding ID (from ProjectBindingService) */
  bindingId: string | null;
  /** Backend type */
  backend: RemoteProjectBackend;
  /** Remote project ID */
  projectId: string;
  /** Local project root path */
  rootPath: string;
  /** Project display name */
  projectName: string;
  /** Project-level connection state */
  connectionState: BridgeConnectionState;
  /** File-tree snapshot */
  files: BridgeFileEntry[];
  folders: BridgeFolderEntry[];
}

// ====== ProjectSession implementation ======

export class ProjectSession implements IDisposable {
  private _state: ProjectSessionState;

  private readonly _onStateChanged = new Emitter<ProjectSessionState>();
  readonly onStateChanged: Event<ProjectSessionState> = this._onStateChanged.event;

  private readonly _onTreeChanged = new Emitter<BridgeTreeChangeEvent>();
  readonly onTreeChanged: Event<BridgeTreeChangeEvent> = this._onTreeChanged.event;

  private readonly disposables: IDisposable[] = [];

  constructor(
    private readonly bridge: IRemoteProjectBridge,
    init: {
      bindingId: string | null;
      projectId: string;
      rootPath: string;
      projectName: string;
    }
  ) {
    this._state = {
      bindingId: init.bindingId,
      backend: bridge.backend,
      projectId: init.projectId,
      rootPath: init.rootPath,
      projectName: init.projectName,
      connectionState: 'disconnected',
      files: [],
      folders: [],
    };

    // Forward bridge events up to the session layer
    this.disposables.push(
      bridge.onConnectionChanged((conn) => {
        this._state = { ...this._state, connectionState: conn.state };
        this._onStateChanged.fire(this._state);
      })
    );

    this.disposables.push(
      bridge.onTreeChanged((event) => {
        this._onTreeChanged.fire(event);
      })
    );
  }

  get state(): Readonly<ProjectSessionState> {
    return this._state;
  }

  /**
   * Loads the project snapshot from the remote and refreshes the file tree.
   */
  async loadSnapshot(): Promise<BridgeProjectSnapshot | null> {
    const snapshot = await this.bridge.getProjectSnapshot(this._state.projectId);
    if (!snapshot) {
      logger.warn(
        `Project snapshot unavailable (backend may not support it): ${this._state.projectId}`
      );
      return null;
    }
    this._state = {
      ...this._state,
      projectName: snapshot.projectName || this._state.projectName,
      files: snapshot.files,
      folders: snapshot.folders,
    };
    this._onStateChanged.fire(this._state);
    logger.info(
      `Project snapshot loaded: ${this._state.projectId} (${snapshot.files.length} files)`
    );
    return snapshot;
  }

  /**
   * Updates the connection state (for external callers setting it directly).
   */
  setConnectionState(state: BridgeConnectionState): void {
    if (this._state.connectionState !== state) {
      this._state = { ...this._state, connectionState: state };
      this._onStateChanged.fire(this._state);
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this._onStateChanged.dispose();
    this._onTreeChanged.dispose();
  }
}
