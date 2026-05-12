import { Emitter, type Event } from '../../../../../shared/utils';
import type {
  OverleafLiveConnectionStateDTO,
  OverleafLiveEntityResultDTO,
  OverleafLiveErrorDTO,
  OverleafLiveStateChangedDTO,
  OverleafLiveCreateEntityParams,
  OverleafLiveDeleteEntityParams,
  OverleafLiveMoveEntityParams,
  OverleafLiveRenameEntityParams,
  OverleafLiveUploadFileParams,
  StudioOverleafOffsetPatchDTO,
} from '../../../../../shared/api-types';
import { api } from '../../api';
import { getProjectRuntimeContext, getSettingsService } from './ServiceRegistry';

export interface OverleafLiveRemoteUpdate {
  projectId: string;
  docId: string;
  version: number;
  content: string;
  patches: StudioOverleafOffsetPatchDTO[];
  /** Session type initiating this operation ('user' | 'bot') */
  sessionType?: string;
}

/** Live session state for a single document */
interface DocSessionState {
  version: number;
  content: string;
}

export class OverleafLiveService {
  private connectionState: OverleafLiveConnectionStateDTO = {
    state: 'disconnected',
    projectId: null,
    sessionId: null,
  };
  /** Per-doc state map (key = docId); prevents inactive doc patches clobbering active version/content */
  private readonly docStates = new Map<string, DocSessionState>();
  /** Active document id (set by joinDoc) */
  private activeDocId: string | null = null;
  /** Active project id */
  private activeProjectId: string | null = null;

  private pending: Promise<void> = Promise.resolve();
  private configuredKey = '';
  private latestJoinRequestId = 0;
  private inflightJoinKey: string | null = null;
  private inflightJoinPromise: Promise<void> | null = null;
  private readonly disposables: Array<() => void> = [];

  private readonly _onDidChangeConnection = new Emitter<OverleafLiveConnectionStateDTO>();
  readonly onDidChangeConnection: Event<OverleafLiveConnectionStateDTO> =
    this._onDidChangeConnection.event;

  private readonly _onDidChangeState = new Emitter<OverleafLiveStateChangedDTO>();
  readonly onDidChangeState: Event<OverleafLiveStateChangedDTO> = this._onDidChangeState.event;

  private readonly _onDidReceiveRemotePatch = new Emitter<OverleafLiveRemoteUpdate>();
  readonly onDidReceiveRemotePatch: Event<OverleafLiveRemoteUpdate> =
    this._onDidReceiveRemotePatch.event;

  private readonly _onDidReceiveTree = new Emitter<{
    projectId: string;
    event: Record<string, unknown>;
  }>();
  readonly onDidReceiveTree: Event<{ projectId: string; event: Record<string, unknown> }> =
    this._onDidReceiveTree.event;

  private readonly _onDidError = new Emitter<OverleafLiveErrorDTO>();
  readonly onDidError: Event<OverleafLiveErrorDTO> = this._onDidError.event;

  /** Live session connected with an active document */
  get isActive(): boolean {
    return this.connectionState.state === 'connected' && this.activeDocId !== null;
  }

  /** Live WebSocket is connected (no active document required) */
  get isConnected(): boolean {
    return this.connectionState.state === 'connected';
  }

  constructor() {
    this.disposables.push(
      api.overleafLive.onConnectionChanged((payload: OverleafLiveConnectionStateDTO) => {
        this.connectionState = payload;
        this._onDidChangeConnection.fire(payload);
      })
    );
    this.disposables.push(
      api.overleafLive.onStateChanged((payload: OverleafLiveStateChangedDTO) => {
        // Update per-doc state by docId; avoid clobbering other documents
        if (payload.docId) {
          this.docStates.set(payload.docId, { version: payload.version, content: payload.content });
        }
        if (payload.docId === this.activeDocId) {
          this._onDidChangeState.fire(payload);
        }
      })
    );
    this.disposables.push(
      api.overleafLive.onRemotePatch((payload) => {
        // Update per-doc state by docId; do not pollute other docs' version/content
        this.docStates.set(payload.docId, { version: payload.version, content: payload.content });
        // Only fire state-change events for the active document
        if (payload.docId === this.activeDocId) {
          this._onDidChangeState.fire({
            projectId: payload.projectId,
            docId: payload.docId,
            version: payload.version,
            content: payload.content,
          });
        }
        // Always forward remotePatch (DiffReviewBridge needs bot edits on inactive docs too)
        this._onDidReceiveRemotePatch.fire({
          projectId: payload.projectId,
          docId: payload.docId,
          version: payload.version,
          content: payload.content,
          patches: payload.patches,
          sessionType: payload.sessionType,
        });
      })
    );
    this.disposables.push(
      api.overleafLive.onError((payload: OverleafLiveErrorDTO) => {
        this._onDidError.fire(payload);
      })
    );
    this.disposables.push(
      api.overleafLive.onTreeChanged((payload) => {
        this._onDidReceiveTree.fire(payload);
      })
    );
  }

  dispose(): void {
    for (const cleanup of this.disposables) cleanup();
    this.disposables.length = 0;
    this._onDidChangeConnection.dispose();
    this._onDidChangeState.dispose();
    this._onDidReceiveRemotePatch.dispose();
    this._onDidReceiveTree.dispose();
    this._onDidError.dispose();
  }

  get currentProjectId(): string | null {
    return this.activeProjectId;
  }

  get currentDocId(): string | null {
    return this.activeDocId;
  }

  get currentVersion(): number {
    const docState = this.activeDocId ? this.docStates.get(this.activeDocId) : null;
    return docState?.version ?? 0;
  }

  /** Get live session state (version + content) for a specific document */
  getDocState(docId: string): DocSessionState | null {
    return this.docStates.get(docId) ?? null;
  }

  async ensureConfigured(projectId: string): Promise<boolean> {
    const settings = getSettingsService().settings;
    const runtime = getProjectRuntimeContext();
    const serverUrl = runtime.overleafServerUrl || settings.compiler.overleaf?.serverUrl;
    if (!runtime.overleafProjectId || !serverUrl) {
      return false;
    }

    const configKey = [serverUrl, projectId].join('|');
    if (this.configuredKey === configKey && this.connectionState.state === 'connected') {
      return true;
    }

    // cookies injected by main process via OverleafAuthService; renderer never touches credentials
    const result = await api.overleafLive.configure({
      serverUrl,
      cookies: '',
      projectId,
      clientInstanceId: globalThis.crypto.randomUUID(),
      sessionType: 'user',
    });

    if (result.state !== 'connected') {
      this._onDidError.fire({
        scope: 'configure',
        message: `Overleaf Live configure failed: ${result.state}`,
      });
      return false;
    }
    this.configuredKey = configKey;
    return true;
  }

  async joinDoc(projectId: string, docId: string): Promise<void> {
    const configured = await this.ensureConfigured(projectId);
    if (!configured) {
      return;
    }

    if (
      this.connectionState.state === 'connected' &&
      this.activeProjectId === projectId &&
      this.activeDocId === docId
    ) {
      return;
    }

    const joinKey = `${projectId}:${docId}`;
    if (this.inflightJoinKey === joinKey && this.inflightJoinPromise) {
      await this.inflightJoinPromise;
      return;
    }

    const joinRequestId = ++this.latestJoinRequestId;
    const joinPromise = (async () => {
      const state = await api.overleafLive.joinDoc({ projectId, docId, fromVersion: -1 });
      if (joinRequestId !== this.latestJoinRequestId) {
        return;
      }
      this.activeProjectId = state.projectId;
      this.activeDocId = state.docId;
      this.docStates.set(state.docId, { version: state.version, content: state.content });
      this._onDidChangeState.fire({
        projectId: state.projectId,
        docId: state.docId,
        version: state.version,
        content: state.content,
      });
    })().finally(() => {
      if (this.inflightJoinKey === joinKey) {
        this.inflightJoinKey = null;
        this.inflightJoinPromise = null;
      }
    });

    this.inflightJoinKey = joinKey;
    this.inflightJoinPromise = joinPromise;
    await joinPromise;
  }

  applyLocalChange(changes: { rangeOffset: number; rangeLength: number; text: string }[]): void {
    if (!this.activeProjectId || !this.activeDocId || this.connectionState.state !== 'connected') {
      return;
    }
    const patches = [...changes]
      .map((change) => ({
        offset: change.rangeOffset,
        deleteCount: change.rangeLength,
        insertText: change.text,
      }))
      .sort((left, right) => right.offset - left.offset);
    if (patches.length === 0) {
      return;
    }

    // Snapshot active projectId/docId into closure; prevents doc switch mid-pending chain
    const projectId = this.activeProjectId;
    const docId = this.activeDocId;
    if (!this.docStates.has(docId)) return;

    this.pending = this.pending
      .then(async () => {
        // Read latest version inside the pending chain to avoid reusing stale baseVersion
        const latestState = this.docStates.get(docId);
        if (!latestState) return;
        const result = await api.overleafLive.submitPatches({
          projectId,
          docId,
          baseVersion: latestState.version,
          requestId: globalThis.crypto.randomUUID(),
          patches,
        });
        // Write back to per-doc map
        this.docStates.set(result.docId, { version: result.version, content: result.content });
        if (result.docId === this.activeDocId) {
          this._onDidChangeState.fire({
            projectId: result.projectId,
            docId: result.docId,
            version: result.version,
            content: result.content,
          });
        }
      })
      .catch((error: unknown) => {
        this._onDidError.fire({
          scope: 'submit',
          message: error instanceof Error ? error.message : String(error),
        });
        throw error; // Re-throw so saveViaLive's `await this.pending` can observe it
      });
  }

  /**
   * Save a document via the live channel. If docId is not the active doc, joinDoc first.
   * If live content already matches the target, returns true without submitting.
   * Only call when live is connected — the caller is responsible for connection checks.
   */
  async saveViaLive(projectId: string, docId: string, content: string): Promise<boolean> {
    if (this.connectionState.state !== 'connected') return false;

    // Ensure the target document is joined
    if (this.activeDocId !== docId) {
      await this.joinDoc(projectId, docId);
    }

    const docState = this.docStates.get(docId);
    if (docState && docState.content === content) {
      return true; // Already in sync
    }

    // Full replace: simple and reliable; save flow does not need incremental patches
    const currentContent = docState?.content ?? '';
    this.applyLocalChange([
      {
        rangeOffset: 0,
        rangeLength: currentContent.length,
        text: content,
      },
    ]);
    // Wait for pending chain so submitPatches has actually landed before returning
    try {
      await this.pending;
      return true;
    } catch {
      return false;
    }
  }

  disconnect(): void {
    this.configuredKey = '';
    this.latestJoinRequestId = 0;
    this.inflightJoinKey = null;
    this.inflightJoinPromise = null;
    this.activeDocId = null;
    this.activeProjectId = null;
    this.docStates.clear();
    this.connectionState = {
      state: 'disconnected',
      projectId: null,
      sessionId: null,
    };
    void api.overleafLive.disconnect();
  }

  async createEntity(params: OverleafLiveCreateEntityParams): Promise<OverleafLiveEntityResultDTO> {
    const configured = await this.ensureConfigured(params.projectId);
    if (!configured) return { success: false, error: 'Overleaf Live is not configured' };
    return await api.overleafLive.createEntity(params);
  }

  async renameEntity(params: OverleafLiveRenameEntityParams): Promise<OverleafLiveEntityResultDTO> {
    const configured = await this.ensureConfigured(params.projectId);
    if (!configured) return { success: false, error: 'Overleaf Live is not configured' };
    return await api.overleafLive.renameEntity(params);
  }

  async moveEntity(params: OverleafLiveMoveEntityParams): Promise<OverleafLiveEntityResultDTO> {
    const configured = await this.ensureConfigured(params.projectId);
    if (!configured) return { success: false, error: 'Overleaf Live is not configured' };
    return await api.overleafLive.moveEntity(params);
  }

  async deleteEntity(params: OverleafLiveDeleteEntityParams): Promise<OverleafLiveEntityResultDTO> {
    const configured = await this.ensureConfigured(params.projectId);
    if (!configured) return { success: false, error: 'Overleaf Live is not configured' };
    return await api.overleafLive.deleteEntity(params);
  }

  async uploadFile(params: OverleafLiveUploadFileParams): Promise<OverleafLiveEntityResultDTO> {
    const configured = await this.ensureConfigured(params.projectId);
    if (!configured) return { success: false, error: 'Overleaf Live is not configured' };
    return await api.overleafLive.uploadFile(params);
  }
}

let overleafLiveService: OverleafLiveService | null = null;

export function getOverleafLiveService(): OverleafLiveService {
  if (!overleafLiveService) {
    overleafLiveService = new OverleafLiveService();
  }
  return overleafLiveService;
}
