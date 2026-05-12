import { OverleafLiveBridge } from './overleaf-gateway/core/index.js';
import { createLogger } from './LoggerService';
import type { OverleafAuthService } from './OverleafAuthService';
import { Emitter, type Event } from '../../../shared/utils';
import type {
  OverleafLiveConfigureParams,
  OverleafLiveConnectionStateDTO,
  OverleafLiveDocStateDTO,
  OverleafLiveEntityResultDTO,
  OverleafLiveErrorDTO,
  OverleafLiveJoinDocParams,
  OverleafLiveCreateEntityParams,
  OverleafLiveDeleteEntityParams,
  OverleafLiveMoveEntityParams,
  OverleafLiveRenameEntityParams,
  OverleafLiveRemotePatchDTO,
  OverleafLiveStateChangedDTO,
  OverleafLiveSubmitPatchesParams,
  OverleafLiveTreeChangedDTO,
  OverleafLiveUploadFileParams,
} from '../../../shared/api-types';
import { EmbeddedOverleafLiveBackend } from './overleaf-live/EmbeddedOverleafLiveBackend';
import type { OverleafLiveBackendObserver } from './overleaf-live/OverleafLiveBackend';

const logger = createLogger('StudioOverleafLiveService');

function emptyState(): OverleafLiveStateChangedDTO {
  return {
    projectId: null,
    docId: null,
    version: 0,
    content: '',
  };
}

export class StudioOverleafLiveService implements OverleafLiveBackendObserver {
  /** Per-doc state map. */
  private readonly docStates = new Map<string, OverleafLiveStateChangedDTO>();
  private activeDocId: string | null = null;
  private configuredServerUrl: string | null = null;
  private auth: OverleafAuthService | null = null;

  private readonly bridge = new OverleafLiveBridge();
  private readonly backend = new EmbeddedOverleafLiveBackend(this.bridge, this);

  private readonly _onDidChangeConnection = new Emitter<OverleafLiveConnectionStateDTO>();
  readonly onDidChangeConnection: Event<OverleafLiveConnectionStateDTO> =
    this._onDidChangeConnection.event;

  private readonly _onDidChangeState = new Emitter<OverleafLiveStateChangedDTO>();
  readonly onDidChangeState: Event<OverleafLiveStateChangedDTO> = this._onDidChangeState.event;

  private readonly _onDidReceiveRemotePatch = new Emitter<OverleafLiveRemotePatchDTO>();
  readonly onDidReceiveRemotePatch: Event<OverleafLiveRemotePatchDTO> =
    this._onDidReceiveRemotePatch.event;

  private readonly _onDidReceiveTree = new Emitter<OverleafLiveTreeChangedDTO>();
  readonly onDidReceiveTree: Event<OverleafLiveTreeChangedDTO> = this._onDidReceiveTree.event;

  private readonly _onDidError = new Emitter<OverleafLiveErrorDTO>();
  readonly onDidError: Event<OverleafLiveErrorDTO> = this._onDidError.event;

  /** Inject auth service after login so LiveService can build bridge connections itself. */
  setAuthService(auth: OverleafAuthService): void {
    this.auth = auth;
  }

  async configure(config: OverleafLiveConfigureParams): Promise<OverleafLiveConnectionStateDTO> {
    this.configuredServerUrl = config.serverUrl;
    return await this.backend.configure(config);
  }

  disconnect(): void {
    this.activeDocId = null;
    this.configuredServerUrl = null;
    // Do not clear auth: it is global state and outlives any single connection.
    this.docStates.clear();
    this.backend.disconnect();
  }

  getState(): OverleafLiveStateChangedDTO {
    if (this.activeDocId) {
      const docState = this.docStates.get(this.activeDocId);
      if (docState) return { ...docState };
    }
    return emptyState();
  }

  async joinDoc(params: OverleafLiveJoinDocParams): Promise<OverleafLiveDocStateDTO> {
    await this.ensureConnected(params.projectId);
    return await this.backend.joinDoc(params);
  }

  async submitPatches(
    params: OverleafLiveSubmitPatchesParams
  ): Promise<OverleafLiveRemotePatchDTO> {
    await this.ensureConnected(params.projectId);
    return await this.backend.submitPatches(params);
  }

  async createEntity(params: OverleafLiveCreateEntityParams): Promise<OverleafLiveEntityResultDTO> {
    await this.ensureConnected(params.projectId);
    return await this.backend.createEntity(params);
  }

  async renameEntity(params: OverleafLiveRenameEntityParams): Promise<OverleafLiveEntityResultDTO> {
    await this.ensureConnected(params.projectId);
    return await this.backend.renameEntity(params);
  }

  async moveEntity(params: OverleafLiveMoveEntityParams): Promise<OverleafLiveEntityResultDTO> {
    await this.ensureConnected(params.projectId);
    return await this.backend.moveEntity(params);
  }

  async deleteEntity(params: OverleafLiveDeleteEntityParams): Promise<OverleafLiveEntityResultDTO> {
    await this.ensureConnected(params.projectId);
    return await this.backend.deleteEntity(params);
  }

  async uploadFile(params: OverleafLiveUploadFileParams): Promise<OverleafLiveEntityResultDTO> {
    await this.ensureConnected(params.projectId);
    return await this.backend.uploadFile(params);
  }

  /** Fetch document content via bridge joinDoc (auto-ensures connection). */
  async getDocContent(projectId: string, docId: string): Promise<string | null> {
    await this.ensureConnected(projectId);
    try {
      const state = await this.backend.joinDoc({ projectId, docId });
      return state.content;
    } catch (error) {
      logger.error(`getDocContent failed: projectId=${projectId}, docId=${docId}`, error);
      return null;
    }
  }

  /** Fetch the project snapshot; auto-connects the bridge when necessary. */
  async getProjectSnapshot(
    projectId: string
  ): Promise<{ projectId: string; project: unknown } | null> {
    await this.ensureConnected(projectId);
    return await this.backend.getProjectSnapshot(projectId);
  }

  /** Ensure the bridge is connected for the given project using the injected AuthService. */
  private async ensureConnected(projectId: string): Promise<void> {
    if (this.backend.isConfiguredForProject(projectId)) return;
    if (!this.auth?.isLoggedIn()) {
      throw new Error('LiveService: AuthService not available or not logged in');
    }
    const serverUrl = this.auth.getServerUrl();
    const cookies = this.auth.getCookies();
    if (!serverUrl || !cookies) {
      throw new Error('LiveService: missing serverUrl or cookies');
    }
    logger.info(`Auto-connecting bridge for project ${projectId}`);
    const result = await this.configure({ serverUrl, cookies, projectId });
    if (result.state !== 'connected') {
      const detail = this.backend.getLastConfigureError() || result.state;
      throw new Error(`Overleaf Live configure failed: ${detail}`);
    }
  }

  isConfiguredForProject(projectId: string): boolean {
    // Delegate to backend: it checks config.projectId and sessionId liveness. Avoid relying
    // on state.projectId, which is only updated on remotePatch (not after configure).
    return this.backend.isConfiguredForProject(projectId);
  }

  async dispose(): Promise<void> {
    this.backend.dispose();
    this._onDidChangeConnection.dispose();
    this._onDidChangeState.dispose();
    this._onDidReceiveRemotePatch.dispose();
    this._onDidReceiveTree.dispose();
    this._onDidError.dispose();
  }

  handleConnectionChanged(payload: OverleafLiveConnectionStateDTO): void {
    this._onDidChangeConnection.fire(payload);
  }

  handleStateChanged(payload: OverleafLiveStateChangedDTO): void {
    if (payload.docId) {
      this.docStates.set(payload.docId, payload);
      this.activeDocId = payload.docId;
    }
    this._onDidChangeState.fire(payload);
  }

  handleRemotePatch(payload: OverleafLiveRemotePatchDTO): void {
    // Update per-doc state keyed by docId without switching activeDocId.
    this.docStates.set(payload.docId, {
      projectId: payload.projectId,
      docId: payload.docId,
      version: payload.version,
      content: payload.content,
    });
    // State-change event still fires; downstream handlers filter by docId.
    this._onDidChangeState.fire({
      projectId: payload.projectId,
      docId: payload.docId,
      version: payload.version,
      content: payload.content,
    });
    this._onDidReceiveRemotePatch.fire(payload);
  }

  handleTreeChanged(payload: OverleafLiveTreeChangedDTO): void {
    this._onDidReceiveTree.fire(payload);
  }

  handleError(payload: OverleafLiveErrorDTO): void {
    logger.error(`[StudioOverleafLiveService] ${payload.scope} failed: ${payload.message}`);
    this._onDidError.fire(payload);
  }

  // ====== Public API for external services ======

  /** Returns the configured Overleaf server URL. */
  getServerUrl(): string | null {
    return this.configuredServerUrl;
  }

  /** Returns whether the given project is currently connected. */
  isProjectConnected(projectId: string): boolean {
    return this.backend.isConfiguredForProject(projectId);
  }
}
