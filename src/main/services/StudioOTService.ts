import { randomUUID } from 'node:crypto';
import { createLogger } from './LoggerService';
import { ReconnectManager } from '../utils/ReconnectManager';
import { Emitter, type Event } from '../../../shared/utils';
import WebSocketImpl from '../utils/ws';
import { OTCore, OTCoreApi, type RawOp } from '@scipen/ot-core';
import { TextOperation } from '@scipen/ot-protocol/ot';
import type { OTProject } from '@scipen/ot-protocol';
import { createElectronMainOTAdapter } from '@scipen/ot-adapter-electron-main';
import type {
  CollaborativeApplyOutcomeDTO,
  OTConnectionStateDTO,
  OTErrorDTO,
  OTFileEventDTO,
  OTApplyBotEditParams,
  OTRemoteUpdateDTO,
  OTStateChangedDTO,
  StudioOTClientState,
  StudioOTConfigureParams,
  StudioOTCreateFileParams,
  StudioOTCreateFolderParams,
  StudioOTJoinFileParams,
  StudioOTProjectFileDTO,
  StudioOTProjectFolderDTO,
  StudioOTProjectSnapshotDTO,
  StudioOTRawOp,
  StudioOTRenameFileParams,
  StudioOTRenameFolderParams,
  StudioOTSubmitFileOpParams,
  StudioOTSubmitFileOpResult,
} from '../../../shared/api-types';

const logger = createLogger('StudioOTService');
const PROJECT_POLL_INTERVAL_MS = 60_000;
const MAX_OT_RECONNECT_ATTEMPTS = 5;
const BASE_OT_RECONNECT_DELAY_MS = 3000;
const MAX_OT_RECONNECT_DELAY_MS = 30_000;
const DEFAULT_BOT_EDIT_POLL_TIMEOUT_MS = 3000;
const DEFAULT_BOT_EDIT_POLL_INTERVAL_MS = 200;

function sortSnapshot(snapshot: StudioOTProjectSnapshotDTO): StudioOTProjectSnapshotDTO {
  return {
    project: snapshot.project,
    folders: [...snapshot.folders].sort((a, b) => a.folder_path.localeCompare(b.folder_path)),
    files: [...snapshot.files].sort((a, b) => a.file_path.localeCompare(b.file_path)),
  };
}

function diffSnapshots(
  previous: StudioOTProjectSnapshotDTO | null,
  current: StudioOTProjectSnapshotDTO
): OTFileEventDTO[] {
  if (!previous) return [];

  const events: OTFileEventDTO[] = [];
  const prevFiles = new Map(previous.files.map((f) => [f.id, f]));
  const nextFiles = new Map(current.files.map((f) => [f.id, f]));
  const prevFolders = new Map(previous.folders.map((f) => [f.id, f]));
  const nextFolders = new Map(current.folders.map((f) => [f.id, f]));

  for (const file of current.files) {
    const prev = prevFiles.get(file.id);
    if (!prev) {
      events.push({
        projectId: current.project.id,
        action: 'created',
        entityType: 'file',
        userId: 'remote',
        fileId: file.id,
        filePath: file.file_path,
      });
    } else if (prev.file_path !== file.file_path) {
      events.push({
        projectId: current.project.id,
        action: 'renamed',
        entityType: 'file',
        userId: 'remote',
        fileId: file.id,
        filePath: file.file_path,
      });
    }
  }
  for (const file of previous.files) {
    if (!nextFiles.has(file.id)) {
      events.push({
        projectId: current.project.id,
        action: 'deleted',
        entityType: 'file',
        userId: 'remote',
        fileId: file.id,
        filePath: file.file_path,
      });
    }
  }
  for (const folder of current.folders) {
    const prev = prevFolders.get(folder.id);
    if (!prev) {
      events.push({
        projectId: current.project.id,
        action: 'created',
        entityType: 'folder',
        userId: 'remote',
        folderId: folder.id,
        filePath: folder.folder_path,
      });
    } else if (prev.folder_path !== folder.folder_path) {
      events.push({
        projectId: current.project.id,
        action: 'renamed',
        entityType: 'folder',
        userId: 'remote',
        folderId: folder.id,
        filePath: folder.folder_path,
      });
    }
  }
  for (const folder of previous.folders) {
    if (!nextFolders.has(folder.id)) {
      events.push({
        projectId: current.project.id,
        action: 'deleted',
        entityType: 'folder',
        userId: 'remote',
        folderId: folder.id,
        filePath: folder.folder_path,
      });
    }
  }

  return events;
}

function toTextOperationFromStudioOps(ops: Array<StudioOTRawOp | RawOp>): TextOperation {
  const operation = new TextOperation();

  for (const op of ops) {
    if (typeof op === 'number') {
      if (op > 0) {
        operation.retain(op);
      } else if (op < 0) {
        operation.remove(Math.abs(op));
      }
      continue;
    }

    if (typeof op === 'string') {
      if (op.length > 0) {
        operation.insert(op);
      }
      continue;
    }

    if (op && typeof op === 'object') {
      if (typeof op.retain === 'number' && op.retain > 0) {
        operation.retain(op.retain);
      } else if (typeof op.insert === 'string' && op.insert.length > 0) {
        operation.insert(op.insert);
      } else if (typeof op.delete === 'number' && op.delete > 0) {
        operation.remove(op.delete);
      }
    }
  }

  return operation;
}

function toStudioRawOps(ops?: RawOp[]): StudioOTRawOp[] | undefined {
  if (!ops || ops.length === 0) {
    return undefined;
  }

  const normalized: StudioOTRawOp[] = [];
  for (const op of ops) {
    if (typeof op === 'number') {
      if (op > 0) {
        normalized.push({ retain: op });
      } else if (op < 0) {
        normalized.push({ delete: Math.abs(op) });
      }
      continue;
    }

    if (typeof op === 'string' && op.length > 0) {
      normalized.push({ insert: op });
    }
  }

  return normalized.length > 0 ? normalized : undefined;
}

function buildFullReplaceOps(currentContent: string, nextContent: string): StudioOTRawOp[] {
  const ops: StudioOTRawOp[] = [];
  if (currentContent.length > 0) {
    ops.push({ delete: currentContent.length });
  }
  if (nextContent.length > 0) {
    ops.push({ insert: nextContent });
  }
  return ops;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class StudioOTService {
  private adapter: ReturnType<typeof createElectronMainOTAdapter> | null = null;
  private api: OTCoreApi | null = null;
  private core: OTCore | null = null;
  private activeProjectSnapshot: StudioOTProjectSnapshotDTO | null = null;
  private projectPollTimer: ReturnType<typeof setInterval> | null = null;
  /** projectId:fileId -> filePath cache used for remote update events. */
  private filePathCache = new Map<string, string>();
  private hasWarnedAboutLegacyProjectList = false;
  private hasWarnedAboutUnconfiguredProjectList = false;
  private lastConfig: { baseUrl: string; token: string } | null = null;
  private isDisconnecting = false;
  /** Bot user id used to identify genuine remote bot operations. */
  private botUserId: string | null = null;
  private readonly reconnect = new ReconnectManager({
    maxAttempts: MAX_OT_RECONNECT_ATTEMPTS,
    baseDelayMs: BASE_OT_RECONNECT_DELAY_MS,
    maxDelayMs: MAX_OT_RECONNECT_DELAY_MS,
    label: 'StudioOTService',
    logger,
    onReconnect: () => this.performReconnect(),
  });

  private readonly _onDidChangeConnection = new Emitter<OTConnectionStateDTO>();
  readonly onDidChangeConnection: Event<OTConnectionStateDTO> = this._onDidChangeConnection.event;

  private readonly _onDidChangeState = new Emitter<OTStateChangedDTO>();
  readonly onDidChangeState: Event<OTStateChangedDTO> = this._onDidChangeState.event;

  private readonly _onDidReceiveRemoteUpdate = new Emitter<OTRemoteUpdateDTO>();
  readonly onDidReceiveRemoteUpdate: Event<OTRemoteUpdateDTO> =
    this._onDidReceiveRemoteUpdate.event;

  private readonly _onDidReceiveFileEvent = new Emitter<OTFileEventDTO>();
  readonly onDidReceiveFileEvent: Event<OTFileEventDTO> = this._onDidReceiveFileEvent.event;

  private readonly _onDidError = new Emitter<OTErrorDTO>();
  readonly onDidError: Event<OTErrorDTO> = this._onDidError.event;

  // ====== Public API ======

  setBotUserId(id: string): void {
    this.botUserId = id || null;
    logger.info(`botUserId set: ${this.botUserId}`);
  }

  async configure(
    config: StudioOTConfigureParams & { botUserId?: string }
  ): Promise<OTConnectionStateDTO> {
    const baseUrl = config.baseUrl.replace(/\/+$/, '');
    const token = config.token.trim();

    // Idempotent: skip reconnect when config is unchanged and connection is live.
    if (this.lastConfig?.baseUrl === baseUrl && this.lastConfig?.token === token && this.core) {
      // Only update botUserId when explicitly provided (undefined means caller does not care).
      if (config.botUserId !== undefined && config.botUserId !== this.botUserId) {
        this.botUserId = config.botUserId || null;
        logger.info(`botUserId updated via configure: ${this.botUserId}`);
      }
      return { state: this.core.getConnectionState() };
    }

    this.disconnect();

    this.adapter = this.adapter ?? createElectronMainOTAdapter(WebSocketImpl);
    this.api = new OTCoreApi(baseUrl, token, this.adapter.http);

    this.core = new OTCore({ baseUrl, token, debounceInterval: 100 }, this.adapter);
    this.bindCoreEvents(this.core);

    try {
      await this.adapter.http.request(`${baseUrl}/health`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      this.core.connect();
      this.lastConfig = { baseUrl, token };
      this.reconnect.reset();
      return { state: this.core.getConnectionState() };
    } catch (error) {
      this.emitError('configure', error);
      // Previously connected: schedule auto-reconnect to recover from transient network faults.
      if (this.lastConfig && !this.reconnect.pending) {
        this.reconnect.schedule();
      }
      throw error;
    }
  }

  disconnect(): void {
    this.isDisconnecting = true;
    this.reconnect.cancel();
    if (this.core) {
      this.core.destroy();
      this.core = null;
    }
    if (this.adapter) {
      // Adapter is a stateless factory (ws/http); core.destroy() already frees its resources.
      this.adapter = null;
    }
    if (this.projectPollTimer) {
      clearInterval(this.projectPollTimer);
      this.projectPollTimer = null;
    }
    this.activeProjectSnapshot = null;
    this.api = null;
    this.lastConfig = null;
    this.reconnect.reset();
    this.filePathCache.clear();
    this._onDidChangeConnection.fire({ state: 'disconnected' });
    this._onDidChangeState.fire({
      state: 'DISCONNECTED',
      projectId: null,
      fileId: null,
      version: 0,
    });
    this.isDisconnecting = false;
    this.reconnect.enable();
  }

  async openLocalProject(params: {
    root_path: string;
    name?: string;
    files: Array<{ file_path: string; content: string }>;
    folders?: string[];
    workspace?: string;
  }): Promise<StudioOTProjectSnapshotDTO> {
    if (!this.api) throw new Error('OT is not configured');
    const snapshot = sortSnapshot(
      (await this.api.openLocalProject(params)) as StudioOTProjectSnapshotDTO
    );
    this.activeProjectSnapshot = snapshot;
    this.startProjectPolling(snapshot.project.id);
    return snapshot;
  }

  /** Returns the content of OT Core's current file (used for offline hash storage). */
  getContent(): string {
    return this.core?.getContent() ?? '';
  }

  async getProjectSnapshot(projectId: string): Promise<StudioOTProjectSnapshotDTO> {
    if (!this.api) throw new Error('OT is not configured');
    const snapshot = sortSnapshot(
      (await this.api.getProject(projectId)) as StudioOTProjectSnapshotDTO
    );
    if (this.activeProjectSnapshot?.project.id === projectId) {
      this.activeProjectSnapshot = snapshot;
    }
    return snapshot;
  }

  async getProjectFile(projectId: string, fileId: string): Promise<StudioOTProjectFileDTO> {
    if (!this.api) throw new Error('OT is not configured');
    return this.api.getProjectFile(projectId, fileId) as Promise<StudioOTProjectFileDTO>;
  }

  async createFile(params: StudioOTCreateFileParams): Promise<StudioOTProjectFileDTO> {
    if (!this.api) throw new Error('OT is not configured');
    return this.api.createProjectFile(params.projectId, {
      file_path: params.file_path,
      content: params.content ?? '',
    }) as Promise<StudioOTProjectFileDTO>;
  }

  async createFolder(params: StudioOTCreateFolderParams): Promise<StudioOTProjectFolderDTO> {
    if (!this.api) throw new Error('OT is not configured');
    return this.api.createProjectFolder(params.projectId, {
      folder_path: params.folder_path,
    }) as Promise<StudioOTProjectFolderDTO>;
  }

  async renameFile(params: StudioOTRenameFileParams): Promise<StudioOTProjectFileDTO> {
    if (!this.api) throw new Error('OT is not configured');
    return this.api.renameProjectFile(params.projectId, params.fileId, {
      file_path: params.file_path,
    }) as Promise<StudioOTProjectFileDTO>;
  }

  async renameFolder(params: StudioOTRenameFolderParams): Promise<StudioOTProjectFolderDTO> {
    if (!this.api) throw new Error('OT is not configured');
    return this.api.renameProjectFolder(params.projectId, params.folderId, {
      folder_path: params.folder_path,
    }) as Promise<StudioOTProjectFolderDTO>;
  }

  async deleteFile(projectId: string, fileId: string): Promise<{ success: boolean }> {
    if (!this.api) throw new Error('OT is not configured');
    return this.api.deleteProjectFile(projectId, fileId);
  }

  async deleteFolder(projectId: string, folderId: string): Promise<{ success: boolean }> {
    if (!this.api) throw new Error('OT is not configured');
    return this.api.deleteProjectFolder(projectId, folderId);
  }

  async listProjects(
    workspace?: string
  ): Promise<import('../../../shared/api-types').StudioOTProjectSummaryDTO[]> {
    if (!this.api) {
      if (!this.hasWarnedAboutUnconfiguredProjectList) {
        logger.warn('[StudioOTService] OT is not configured; returning an empty project list');
        this.hasWarnedAboutUnconfiguredProjectList = true;
      }
      return [];
    }
    try {
      return await this.api.listProjects(workspace);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('/api/projects failed: 404')) {
        if (!this.hasWarnedAboutLegacyProjectList) {
          logger.warn(
            '[StudioOTService] Current OT service does not support project listing yet; using an empty-list fallback'
          );
          this.hasWarnedAboutLegacyProjectList = true;
        }
        return [];
      }
      throw error;
    }
  }

  async updateProject(
    projectId: string,
    updates: { name?: string; workspace?: string }
  ): Promise<{ project: OTProject }> {
    if (!this.api) throw new Error('OT is not configured');
    return this.api.updateProject(projectId, updates);
  }

  async addProjectMember(
    projectId: string,
    userId: string,
    role: 'editor' | 'viewer' = 'editor'
  ): Promise<{ success: boolean }> {
    if (!this.api) throw new Error('OT is not configured');
    return this.api.addProjectMember(projectId, userId, role);
  }

  async joinFile(params: StudioOTJoinFileParams): Promise<StudioOTProjectFileDTO> {
    if (!this.core || !this.api) throw new Error('OT is not configured');
    const file = await this.getProjectFile(params.projectId, params.fileId);
    this.filePathCache.set(`${params.projectId}:${params.fileId}`, file.file_path);

    this.core.joinFile(params.projectId, params.fileId);
    return file;
  }

  /**
   * Foreground submit: enforces current-file guard and desync rejoin semantics for the
   * normal editing path.
   */
  async submitForegroundFileOp(
    params: StudioOTSubmitFileOpParams
  ): Promise<StudioOTSubmitFileOpResult> {
    if (!this.core) throw new Error('OT is not configured');

    // Guard 1: drop ops that do not belong to the current file (stale IPC after tab switch).
    const currentFileId = this.core.getCurrentFileId();
    if (params.fileId && params.fileId !== currentFileId) {
      logger.warn(
        `[submitForegroundFileOp] Dropping cross-file op: params.fileId=${params.fileId} vs current=${currentFileId}`
      );
      return { status: 'applied', version: this.core.getVersion() };
    }

    const op = toTextOperationFromStudioOps(params.ops as Array<StudioOTRawOp | RawOp>);

    // Guard 2: validate content length; trigger rejoin to recover from desync.
    const coreContentLen = this.core.getContent().length;
    if (op.baseLength !== coreContentLen) {
      logger.warn(
        `[submitForegroundFileOp] Content desync: op.baseLength=${op.baseLength} vs core=${coreContentLen}, fileId=${params.fileId} - triggering rejoin`
      );
      this.emitError(
        'submitFileOp',
        new Error(`Content desync: op.baseLength=${op.baseLength} vs core=${coreContentLen}`)
      );
      const projectId = this.core.getCurrentProjectId();
      const fileId = this.core.getCurrentFileId();
      if (projectId && fileId) {
        this.core.joinFile(projectId, fileId);
      }
      return { status: 'desynced', version: this.core.getVersion() };
    }

    this.core.applyLocal(op);
    return { status: 'applied', version: this.core.getVersion() };
  }

  /**
   * Wait for OT Core to switch to the target file via the state:change event (no sleep).
   */
  private async ensureJoinedFile(
    projectId: string,
    fileId: string,
    timeoutMs = 5000
  ): Promise<void> {
    if (!this.core) throw new Error('OT is not configured');
    if (this.core.getCurrentFileId() === fileId) return;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`ensureJoinedFile timed out after ${timeoutMs}ms for fileId=${fileId}`));
      }, timeoutMs);

      // Subscribe before joinFile so the sync-complete event cannot fire before we listen.
      const disposable = this.onDidChangeState(() => {
        if (this.core?.getCurrentFileId() === fileId) {
          cleanup();
          resolve();
        }
      });

      const cleanup = () => {
        clearTimeout(timeout);
        disposable.dispose();
      };

      this.core!.joinFile(projectId, fileId);

      // Check immediately: joinFile may complete synchronously in the same tick.
      if (this.core?.getCurrentFileId() === fileId) {
        cleanup();
        resolve();
      }
    });
  }

  /**
   * Replay submit for OfflineOpsManager.doReplay(). No current-file guard:
   * ensureJoinedFile switches to the target file before submitting.
   */
  async submitReplayFileOp(
    projectId: string,
    fileId: string,
    ops: StudioOTRawOp[]
  ): Promise<StudioOTSubmitFileOpResult> {
    if (!this.core) throw new Error('OT is not configured');

    await this.ensureJoinedFile(projectId, fileId);

    const op = toTextOperationFromStudioOps(ops as Array<StudioOTRawOp | RawOp>);
    const coreContentLen = this.core.getContent().length;

    if (op.baseLength !== coreContentLen) {
      logger.warn(
        `[submitReplayFileOp] Content desync: op.baseLength=${op.baseLength} vs core=${coreContentLen}, fileId=${fileId}`
      );
      return { status: 'desynced', version: this.core.getVersion() };
    }

    this.core.applyLocal(op);
    return { status: 'applied', version: this.core.getVersion() };
  }

  async applyBotEdit(params: OTApplyBotEditParams): Promise<CollaborativeApplyOutcomeDTO> {
    if (!this.api) {
      throw new Error('OT is not configured');
    }

    const pollTimeoutMs = params.pollTimeoutMs ?? DEFAULT_BOT_EDIT_POLL_TIMEOUT_MS;
    const pollIntervalMs = params.pollIntervalMs ?? DEFAULT_BOT_EDIT_POLL_INTERVAL_MS;
    const current = await this.api.getProjectFile(params.projectId, params.fileId);
    this.filePathCache.set(`${params.projectId}:${params.fileId}`, current.file_path);

    if (current.content === params.newContent) {
      return {
        backend: 'scipen-ot',
        status: 'applied',
        changed: false,
        projectId: params.projectId,
        fileId: params.fileId,
        filePath: current.file_path,
        version: current.version,
        reason: null,
      };
    }

    const ops = buildFullReplaceOps(current.content, params.newContent);
    try {
      const submit = await this.api.submitProjectFileOp(params.projectId, params.fileId, {
        version: current.version,
        ops: ops.map((op) => {
          if (op.retain !== undefined) return op.retain;
          if (op.insert !== undefined) return op.insert;
          return -(op.delete ?? 0);
        }),
        sourceId: randomUUID(),
      });

      const deadline = Date.now() + pollTimeoutMs;
      while (Date.now() <= deadline) {
        const file = await this.api.getProjectFile(params.projectId, params.fileId);
        this.filePathCache.set(`${params.projectId}:${params.fileId}`, file.file_path);
        if (file.content === params.newContent) {
          return {
            backend: 'scipen-ot',
            status: 'applied',
            changed: true,
            projectId: params.projectId,
            fileId: params.fileId,
            filePath: file.file_path,
            version: file.version,
            reason: null,
          };
        }
        await sleep(pollIntervalMs);
      }

      return {
        backend: 'scipen-ot',
        status: 'transport_failed',
        changed: false,
        projectId: params.projectId,
        fileId: params.fileId,
        filePath: current.file_path,
        version: submit.version,
        reason: 'OT edit confirmation timed out',
      };
    } catch (error) {
      return {
        backend: 'scipen-ot',
        status: 'transport_failed',
        changed: false,
        projectId: params.projectId,
        fileId: params.fileId,
        filePath: current.file_path,
        version: current.version,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  dispose(): void {
    this.disconnect();
    this._onDidChangeConnection.dispose();
    this._onDidChangeState.dispose();
    this._onDidReceiveRemoteUpdate.dispose();
    this._onDidReceiveFileEvent.dispose();
    this._onDidError.dispose();
  }

  // ====== OTCore event bridging ======

  private bindCoreEvents(core: OTCore): void {
    core.on('connection:change', (state) => {
      this._onDidChangeConnection.fire({ state });
      if (state === 'connected') {
        this.reconnect.reset();
      } else if (state === 'disconnected' && !this.isDisconnecting) {
        this.reconnect.schedule();
      }
    });

    core.on('state:change', (state) => {
      this._onDidChangeState.fire({
        state: state as StudioOTClientState,
        projectId: core.getCurrentProjectId(),
        fileId: core.getCurrentFileId(),
        version: core.getVersion(),
      });
    });

    core.on('content:change', (content, source, ops, metadata) => {
      if (source === 'remote') {
        const projectId = core.getCurrentProjectId();
        const fileId = core.getCurrentFileId();
        if (!projectId || !fileId) return;
        this._onDidReceiveRemoteUpdate.fire({
          projectId,
          fileId,
          filePath: this.filePathCache.get(`${projectId}:${fileId}`) ?? '',
          content,
          version: core.getVersion(),
          ops: toStudioRawOps(ops),
          userId: metadata?.userId,
        });
      }
    });

    core.on('file:event', (event) => {
      this._onDidReceiveFileEvent.fire({
        projectId: event.projectId,
        action: event.action,
        entityType: event.entityType,
        userId: event.userId,
        fileId: event.fileId,
        folderId: event.folderId,
        filePath: event.filePath,
      });
    });

    core.on('error', (error) => {
      this.emitError('poll', error);
    });
  }

  // ====== Reconnect ======

  private async performReconnect(): Promise<void> {
    if (!this.lastConfig || this.isDisconnecting) return;
    const config = this.lastConfig;

    logger.info('[StudioOTService] Starting OT reconnect...');

    try {
      if (this.core) {
        this.core.destroy();
        this.core = null;
      }
      if (this.adapter) {
        this.adapter = null;
      }
      this.api = null;

      this.adapter = createElectronMainOTAdapter(WebSocketImpl);
      this.api = new OTCoreApi(config.baseUrl, config.token, this.adapter.http);
      this.core = new OTCore(
        { baseUrl: config.baseUrl, token: config.token, debounceInterval: 100 },
        this.adapter
      );
      this.bindCoreEvents(this.core);

      await this.adapter.http.request(`${config.baseUrl}/health`, {
        headers: { Authorization: `Bearer ${config.token}` },
      });
      this.core.connect();
      this.reconnect.reset();
      logger.info('[StudioOTService] OT reconnect succeeded');
    } catch (error) {
      this.emitError('reconnect', error);
      this.reconnect.schedule();
    }
  }

  // ====== Project polling (fallback; WS file_event covers real-time updates) ======

  private startProjectPolling(projectId: string): void {
    if (this.projectPollTimer) clearInterval(this.projectPollTimer);
    this.projectPollTimer = setInterval(() => {
      const previousSnapshot = this.activeProjectSnapshot;
      void this.getProjectSnapshot(projectId)
        .then((snapshot) => {
          const events = diffSnapshots(previousSnapshot, snapshot);
          this.activeProjectSnapshot = snapshot;
          for (const event of events) {
            // Keep filePathCache in sync: rename/create updates, delete clears.
            if (event.entityType === 'file' && event.fileId) {
              const cacheKey = `${event.projectId}:${event.fileId}`;
              if (event.action === 'deleted') {
                this.filePathCache.delete(cacheKey);
              } else {
                this.filePathCache.set(cacheKey, event.filePath);
              }
            }
            this._onDidReceiveFileEvent.fire(event);
          }
        })
        .catch((error) => {
          this.emitError('poll', error);
          if (!this.reconnect.pending && this.lastConfig) {
            this.reconnect.schedule();
          }
        });
    }, PROJECT_POLL_INTERVAL_MS);
  }

  // ====== Emitters ======

  private emitError(scope: OTErrorDTO['scope'], error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof Error ? (error as Error & { code?: string }).code : undefined;
    logger.error(`[StudioOTService] ${scope} failed: ${message}`);
    this._onDidError.fire({ scope, message, code });
  }
}
