import type { OverleafLiveBridge } from '../overleaf-gateway/core/index.js';
import type {
  OverleafLiveConfigureParams,
  OverleafLiveConnectionStateDTO,
  OverleafLiveDocStateDTO,
  OverleafLiveEntityResultDTO,
  OverleafLiveJoinDocParams,
  OverleafLiveRemotePatchDTO,
  OverleafLiveStateChangedDTO,
  OverleafLiveSubmitPatchesParams,
  OverleafLiveCreateEntityParams,
  OverleafLiveDeleteEntityParams,
  OverleafLiveMoveEntityParams,
  OverleafLiveRenameEntityParams,
  OverleafLiveUploadFileParams,
} from '../../../../shared/api-types';
import { createLogger } from '../LoggerService';
import type { OverleafLiveBackend, OverleafLiveBackendObserver } from './OverleafLiveBackend';

const logger = createLogger('EmbeddedOverleafLiveBackend');

function emptyState(): OverleafLiveStateChangedDTO {
  return {
    projectId: null,
    docId: null,
    version: 0,
    content: '',
  };
}

export class EmbeddedOverleafLiveBackend implements OverleafLiveBackend {
  private config: OverleafLiveConfigureParams | null = null;
  private sessionId: string | null = null;
  /** Per-doc state keyed by docId, so patches for inactive docs cannot clobber the active one. */
  private readonly docStates = new Map<string, OverleafLiveStateChangedDTO>();
  private activeDocId: string | null = null;
  private _lastConfigureError: string | null = null;

  private readonly onRemotePatch = (payload: Record<string, unknown>) => {
    if (!this.matchesSession(payload.sessionId)) return;
    const update = payload as unknown as OverleafLiveRemotePatchDTO;
    const docState: OverleafLiveStateChangedDTO = {
      projectId: update.projectId,
      docId: update.docId,
      version: update.version,
      content: update.content,
    };
    this.docStates.set(update.docId, docState);
    this.observer.handleRemotePatch(update);
  };

  private readonly onTreeChanged = (payload: Record<string, unknown>) => {
    if (!this.matchesSession(payload.sessionId)) return;
    this.observer.handleTreeChanged(
      payload as unknown as import('../../../../shared/api-types').OverleafLiveTreeChangedDTO
    );
  };

  private readonly onDisconnected = (payload: Record<string, unknown>) => {
    if (!this.matchesSession(payload.sessionId)) return;
    this.sessionId = null;
    this.observer.handleConnectionChanged({
      state: 'read_only_disconnected',
      projectId: this.config?.projectId ?? null,
      sessionId: null,
    });
  };

  private readonly onError = (payload: Record<string, unknown>) => {
    if (!this.matchesSession(payload.sessionId)) return;
    this.observer.handleError({
      scope: 'ws',
      message:
        typeof payload.message === 'string'
          ? payload.message
          : 'Unknown embedded collaboration error',
    });
  };

  constructor(
    private readonly bridge: OverleafLiveBridge,
    private readonly observer: OverleafLiveBackendObserver
  ) {
    this.bridge.on('doc.remote_patch', this.onRemotePatch);
    this.bridge.on('tree.changed', this.onTreeChanged);
    this.bridge.on('session.disconnected', this.onDisconnected);
    this.bridge.on('doc.error', this.onError);
  }

  getLastConfigureError(): string | null {
    return this._lastConfigureError;
  }

  async configure(config: OverleafLiveConfigureParams): Promise<OverleafLiveConnectionStateDTO> {
    this.disconnect();
    this.config = config;
    this._lastConfigureError = null;
    this.observer.handleConnectionChanged({
      state: 'connecting',
      projectId: config.projectId,
      sessionId: null,
    });

    try {
      const connection = await this.bridge.connectSession({
        serverUrl: config.serverUrl,
        projectId: config.projectId,
        cookies: config.cookies,
        clientInstanceId: config.clientInstanceId,
        sessionType: config.sessionType,
      });
      this.sessionId = connection.sessionId;
      const state = {
        state: 'connected' as const,
        projectId: connection.projectId,
        sessionId: connection.sessionId,
      };
      this.observer.handleConnectionChanged(state);
      return state;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this._lastConfigureError = message;
      logger.error(`[EmbeddedOverleafLiveBackend] configure failed: ${message}`);
      this.observer.handleError({ scope: 'configure', message });
      const state = {
        state: 'read_only_disconnected' as const,
        projectId: config.projectId,
        sessionId: null,
      };
      this.observer.handleConnectionChanged(state);
      return state;
    }
  }

  disconnect(): void {
    const sessionId = this.sessionId;
    this.sessionId = null;
    this.config = null;
    this.activeDocId = null;
    this.docStates.clear();
    this.observer.handleConnectionChanged({
      state: 'disconnected',
      projectId: null,
      sessionId: null,
    });
    this.observer.handleStateChanged(emptyState());
    if (sessionId) {
      try {
        this.bridge.disconnectSession(sessionId);
      } catch {}
    }
  }

  getState(): OverleafLiveStateChangedDTO {
    if (this.activeDocId) {
      const docState = this.docStates.get(this.activeDocId);
      if (docState) return { ...docState };
    }
    return emptyState();
  }

  async joinDoc(params: OverleafLiveJoinDocParams): Promise<OverleafLiveDocStateDTO> {
    const doc = await this.bridge.joinDoc({
      sessionId: this.requireSessionId(),
      projectId: params.projectId,
      docId: params.docId,
      fromVersion: params.fromVersion,
    });
    const docState: OverleafLiveStateChangedDTO = {
      projectId: doc.projectId,
      docId: doc.docId,
      version: doc.version,
      content: doc.content,
    };
    this.activeDocId = doc.docId;
    this.docStates.set(doc.docId, docState);
    this.observer.handleStateChanged(docState);
    return doc;
  }

  async submitPatches(
    params: OverleafLiveSubmitPatchesParams
  ): Promise<OverleafLiveRemotePatchDTO> {
    const result = await this.bridge.submitPatches({
      sessionId: this.requireSessionId(),
      projectId: params.projectId,
      docId: params.docId,
      baseVersion: params.baseVersion,
      patches: params.patches,
      requestId: params.requestId,
    });
    const docState: OverleafLiveStateChangedDTO = {
      projectId: result.projectId,
      docId: result.docId,
      version: result.version,
      content: result.content,
    };
    this.docStates.set(result.docId, docState);
    this.observer.handleStateChanged(docState);
    return result as OverleafLiveRemotePatchDTO;
  }

  async createEntity(params: OverleafLiveCreateEntityParams): Promise<OverleafLiveEntityResultDTO> {
    return (await this.bridge.createEntity({
      sessionId: this.requireSessionId(),
      projectId: params.projectId,
      entityType: params.entityType,
      parentFolderId: params.parentFolderId,
      name: params.name,
    })) as OverleafLiveEntityResultDTO;
  }

  async renameEntity(params: OverleafLiveRenameEntityParams): Promise<OverleafLiveEntityResultDTO> {
    try {
      return (await this.bridge.patchEntity({
        sessionId: this.requireSessionId(),
        projectId: params.projectId,
        entityId: params.entityId,
        entityType: params.entityType,
        action: 'rename',
        newName: params.newName,
      })) as OverleafLiveEntityResultDTO;
    } catch (error: unknown) {
      logger.error(
        '[renameEntity] bridge.patchEntity failed:',
        error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      );
      throw error;
    }
  }

  async moveEntity(params: OverleafLiveMoveEntityParams): Promise<OverleafLiveEntityResultDTO> {
    return (await this.bridge.patchEntity({
      sessionId: this.requireSessionId(),
      projectId: params.projectId,
      entityId: params.entityId,
      entityType: params.entityType,
      action: 'move',
      targetFolderId: params.targetFolderId,
    })) as OverleafLiveEntityResultDTO;
  }

  async deleteEntity(params: OverleafLiveDeleteEntityParams): Promise<OverleafLiveEntityResultDTO> {
    return (await this.bridge.deleteEntity({
      sessionId: this.requireSessionId(),
      projectId: params.projectId,
      entityId: params.entityId,
      entityType: params.entityType,
    })) as OverleafLiveEntityResultDTO;
  }

  async uploadFile(params: OverleafLiveUploadFileParams): Promise<OverleafLiveEntityResultDTO> {
    return (await this.bridge.uploadFile({
      sessionId: this.requireSessionId(),
      projectId: params.projectId,
      parentFolderId: params.parentFolderId,
      fileName: params.fileName,
      mimeType: params.mimeType,
      fileDataBase64: Buffer.from(params.data).toString('base64'),
    })) as OverleafLiveEntityResultDTO;
  }

  async getProjectSnapshot(
    projectId: string
  ): Promise<{ projectId: string; project: unknown } | null> {
    try {
      return this.bridge.getProjectSnapshot({
        sessionId: this.requireSessionId(),
        projectId,
      });
    } catch {
      return null;
    }
  }

  dispose(): void {
    this.disconnect();
    this.bridge.off('doc.remote_patch', this.onRemotePatch);
    this.bridge.off('tree.changed', this.onTreeChanged);
    this.bridge.off('session.disconnected', this.onDisconnected);
    this.bridge.off('doc.error', this.onError);
  }

  hasActiveSession(): boolean {
    return this.sessionId !== null;
  }

  isConfiguredForProject(projectId: string): boolean {
    return this.config?.projectId === projectId && this.sessionId !== null;
  }

  private requireSessionId(): string {
    if (!this.sessionId) {
      throw new Error('Overleaf Live session not available');
    }
    return this.sessionId;
  }

  private matchesSession(sessionId: unknown): boolean {
    return typeof sessionId === 'string' && sessionId.length > 0 && sessionId === this.sessionId;
  }
}
