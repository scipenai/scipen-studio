/**
 * @file ProjectSessionManager - Project session manager
 * @description Manages the currently active ProjectSession and DocumentSession instances.
 *   One window activates a single ProjectSession at a time but may hold multiple DocumentSessions.
 *   The renderer consults this manager for the current bridge and no longer distinguishes
 *   OTService from OverleafLiveService directly.
 *
 * WARNING: This module and the related ProjectSession/DocumentSession/OTProjectBridge/
 *   IRemoteProjectBridge are implemented but not yet wired into the main flow.
 *   They are not registered with ServiceContainer and no IPC handler consumes them.
 *   Runtime still goes through StudioOTService + renderer OTService directly.
 *   To adopt: register with ServiceContainer and replace StudioOTService's current direct
 *   IPC routing.
 */

import { Emitter, type Event } from '../../../shared/utils';
import type { IRemoteProjectBridge } from './interfaces/IRemoteProjectBridge';
import { ProjectSession, type ProjectSessionState } from './ProjectSession';
import { DocumentSession, type DocumentSessionState } from './DocumentSession';
import type { IDisposable } from './ServiceContainer';
import { createLogger } from './LoggerService';

const logger = createLogger('ProjectSessionManager');

export class ProjectSessionManager implements IDisposable {
  private _activeProject: ProjectSession | null = null;
  private readonly _activeDocs = new Map<string, DocumentSession>();
  private _projectEventDisposable: IDisposable | null = null;
  private readonly _docEventDisposables = new Map<string, IDisposable>();

  private readonly _onProjectChanged = new Emitter<ProjectSessionState | null>();
  readonly onProjectChanged: Event<ProjectSessionState | null> = this._onProjectChanged.event;

  private readonly _onDocumentChanged = new Emitter<{
    fileId: string;
    state: DocumentSessionState | null;
  }>();
  readonly onDocumentChanged: Event<{ fileId: string; state: DocumentSessionState | null }> =
    this._onDocumentChanged.event;

  /**
   * Opens a project session. Closes any previously active project.
   */
  openProject(
    bridge: IRemoteProjectBridge,
    init: {
      bindingId: string | null;
      projectId: string;
      rootPath: string;
      projectName: string;
    }
  ): ProjectSession {
    // Close any existing project first
    this.closeProject();

    this._activeProject = new ProjectSession(bridge, init);
    this._bridge = bridge;
    this._projectEventDisposable = this._activeProject.onStateChanged((state) => {
      this._onProjectChanged.fire(state);
    });

    logger.info(`Project session opened: ${init.projectId} (${bridge.backend})`);
    this._onProjectChanged.fire(this._activeProject.state);
    return this._activeProject;
  }

  /**
   * Closes the active project and every associated document session.
   */
  closeProject(): void {
    // Close all document sessions first
    for (const [fileId, doc] of this._activeDocs) {
      this._docEventDisposables.get(fileId)?.dispose();
      doc.dispose();
      this._onDocumentChanged.fire({ fileId, state: null });
    }
    this._activeDocs.clear();
    this._docEventDisposables.clear();

    if (this._activeProject) {
      const projectId = this._activeProject.state.projectId;
      this._projectEventDisposable?.dispose();
      this._projectEventDisposable = null;
      this._activeProject.dispose();
      this._activeProject = null;
      this._bridge = null;
      this._onProjectChanged.fire(null);
      logger.info(`Project session closed: ${projectId}`);
    }
  }

  /**
   * Opens a document edit session. Requires an active project.
   */
  openDocument(fileId: string): DocumentSession {
    if (!this._activeProject) {
      throw new Error('无活跃项目，请先 openProject');
    }

    // Return existing session if already open
    const existing = this._activeDocs.get(fileId);
    if (existing) return existing;

    const bridge = this.getActiveBridge();
    if (!bridge) {
      throw new Error('无可用 Bridge 实例');
    }

    const doc = new DocumentSession(bridge, {
      projectId: this._activeProject.state.projectId,
      fileId,
    });

    const docDisposable = doc.onStateChanged((state) => {
      this._onDocumentChanged.fire({ fileId, state });
    });
    this._docEventDisposables.set(fileId, docDisposable);

    this._activeDocs.set(fileId, doc);
    logger.info(`Document session opened: ${fileId}`);
    return doc;
  }

  /**
   * Closes a document edit session.
   */
  closeDocument(fileId: string): void {
    const doc = this._activeDocs.get(fileId);
    if (doc) {
      this._docEventDisposables.get(fileId)?.dispose();
      this._docEventDisposables.delete(fileId);
      doc.dispose();
      this._activeDocs.delete(fileId);
      this._onDocumentChanged.fire({ fileId, state: null });
      logger.info(`Document session closed: ${fileId}`);
    }
  }

  /**
   * Returns the active project session, if any.
   */
  getActiveProject(): ProjectSession | null {
    return this._activeProject;
  }

  /**
   * Returns the document session for the given file, if any.
   */
  getDocument(fileId: string): DocumentSession | null {
    return this._activeDocs.get(fileId) ?? null;
  }

  /**
   * Returns all active document sessions.
   */
  getActiveDocuments(): ReadonlyMap<string, DocumentSession> {
    return this._activeDocs;
  }

  /**
   * Internal handle to the current bridge. Injected via the constructor when openProject runs.
   */
  private _bridge: IRemoteProjectBridge | null = null;

  setBridge(bridge: IRemoteProjectBridge | null): void {
    this._bridge = bridge;
  }

  getActiveBridge(): IRemoteProjectBridge | null {
    return this._bridge;
  }

  dispose(): void {
    this.closeProject();
    this._onProjectChanged.dispose();
    this._onDocumentChanged.dispose();
  }
}
