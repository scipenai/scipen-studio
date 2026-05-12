/**
 * @file OTService.ts - OT Collaboration Service
 * @description Bridges Studio OT IPC APIs with editor/file tree consumers.
 */

import { TextOperation } from '@scipen/ot-protocol/ot';
import type {
  CollaborativeApplyOutcomeDTO,
  OTConnectionStateDTO,
  OTErrorDTO,
  OTFileEventDTO,
  OTApplyBotEditParams,
  OTRemoteUpdateDTO,
  OTStateChangedDTO,
  StudioOTProjectFileDTO,
  StudioOTProjectFolderDTO,
  StudioOTProjectSnapshotDTO,
  StudioOTRawOp,
} from '../../../../../shared/api-types';
import type { FileNode } from '../../types';
import { api } from '../../api';
import { Emitter, type Event, type IDisposable } from '../../../../../shared/utils';
import { isSamePath } from '../../utils/pathComparison';
import { getSettingsService } from './ServiceRegistry';

const ALLOWED_PROJECT_EXTENSIONS = new Set([
  'tex',
  'bib',
  'sty',
  'cls',
  'bst',
  'md',
  'txt',
  'yaml',
  'yml',
  'json',
  'typ',
]);
const IGNORED_SEGMENTS = new Set(['node_modules', '.git', 'dist', 'build']);

export interface OTRemoteUpdate {
  content: string;
  projectId: string;
  fileId: string;
  version: number;
  /** Incremental ops (post-transform RawOps) for precise editor application */
  ops?: StudioOTRawOp[];
  /** User id that initiated the op (used to distinguish human vs AI bot) */
  userId?: string;
}

function normalizeOTJSONOps(value: unknown): StudioOTRawOp[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: StudioOTRawOp[] = [];
  for (const item of value) {
    if (typeof item === 'number') {
      if (item > 0) {
        normalized.push({ retain: item });
      } else if (item < 0) {
        normalized.push({ delete: Math.abs(item) });
      }
      continue;
    }

    if (typeof item === 'string') {
      if (item.length > 0) {
        normalized.push({ insert: item });
      }
      continue;
    }

    if (item && typeof item === 'object') {
      const op = item as { retain?: unknown; insert?: unknown; delete?: unknown };
      const next: StudioOTRawOp = {};
      if (typeof op.retain === 'number' && op.retain > 0) {
        next.retain = op.retain;
      }
      if (typeof op.insert === 'string' && op.insert.length > 0) {
        next.insert = op.insert;
      }
      if (typeof op.delete === 'number' && op.delete > 0) {
        next.delete = op.delete;
      }
      if (next.retain !== undefined || next.insert !== undefined || next.delete !== undefined) {
        normalized.push(next);
      }
    }
  }

  return normalized;
}

function getPathSeparator(projectPath: string): string {
  return projectPath.includes('\\') ? '\\' : '/';
}

function joinProjectPath(projectPath: string, relativePath: string): string {
  const separator = getPathSeparator(projectPath);
  const normalizedRelative = relativePath.replace(/[\\/]/g, separator);
  return `${projectPath}${separator}${normalizedRelative}`;
}

function toRelativeProjectPath(projectPath: string, filePath: string): string {
  const normalizedProject = projectPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedPath = filePath.replace(/\\/g, '/');
  if (!normalizedPath.startsWith(normalizedProject)) {
    throw new Error(`Path ${filePath} is outside project ${projectPath}`);
  }
  return normalizedPath.slice(normalizedProject.length).replace(/^\/+/, '');
}

function shouldIncludeRelativePath(relativePath: string): boolean {
  if (!relativePath) return false;
  const segments = relativePath.split('/').filter(Boolean);
  if (segments.some((segment) => IGNORED_SEGMENTS.has(segment))) {
    return false;
  }
  const ext = relativePath.split('.').pop()?.toLowerCase() ?? '';
  return ALLOWED_PROJECT_EXTENSIONS.has(ext);
}

function collectFolderPathsFromTree(
  node: FileNode | null,
  projectPath: string,
  folders = new Set<string>()
): string[] {
  if (!node) {
    return [];
  }

  const walk = (current: FileNode) => {
    if (current.type === 'directory' && !isSamePath(current.path, projectPath)) {
      folders.add(toRelativeProjectPath(projectPath, current.path));
    }
    current.children?.forEach(walk);
  };

  walk(node);
  return Array.from(folders).sort((a, b) => a.localeCompare(b));
}

function buildFileTreeFromSnapshot(
  projectPath: string,
  snapshot: StudioOTProjectSnapshotDTO
): FileNode {
  const root: FileNode = {
    name: projectPath.split(/[\\/]/).pop() || projectPath,
    path: projectPath,
    type: 'directory',
    children: [],
    isExpanded: true,
    isResolved: true,
    projectId: snapshot.project.id,
  };

  const nodeMap = new Map<string, FileNode>([[projectPath.replace(/\\/g, '/'), root]]);
  const ensureDirectory = (relativePath: string): FileNode => {
    const normalizedRelative = relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!normalizedRelative) {
      return root;
    }

    const absolutePath = joinProjectPath(projectPath, normalizedRelative);
    const normalizedAbsolute = absolutePath.replace(/\\/g, '/');
    const existing = nodeMap.get(normalizedAbsolute);
    if (existing) {
      return existing;
    }

    const parentRelative = normalizedRelative.includes('/')
      ? normalizedRelative.slice(0, normalizedRelative.lastIndexOf('/'))
      : '';
    const parent = ensureDirectory(parentRelative);
    const dirNode: FileNode = {
      name: normalizedRelative.split('/').pop() || normalizedRelative,
      path: absolutePath,
      type: 'directory',
      children: [],
      isExpanded: false,
      isResolved: true,
      projectId: snapshot.project.id,
    };
    parent.children = parent.children || [];
    parent.children.push(dirNode);
    nodeMap.set(normalizedAbsolute, dirNode);
    return dirNode;
  };

  for (const folder of snapshot.folders.filter(
    (entry: StudioOTProjectFolderDTO) => !entry.deleted_at
  )) {
    ensureDirectory(folder.folder_path);
  }

  for (const file of snapshot.files.filter((entry: StudioOTProjectFileDTO) => !entry.deleted_at)) {
    const parent = ensureDirectory(
      file.file_path.includes('/') ? file.file_path.slice(0, file.file_path.lastIndexOf('/')) : ''
    );
    parent.children = parent.children || [];
    parent.children.push({
      name: file.title,
      path: joinProjectPath(projectPath, file.file_path),
      type: 'file',
      _id: file.id,
      projectId: snapshot.project.id,
      isRemote: false,
    });
  }

  const sortTree = (node: FileNode) => {
    if (!node.children) return;
    node.children.sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === 'directory' ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });
    node.children.forEach(sortTree);
  };
  sortTree(root);
  return root;
}

export class OTService implements IDisposable {
  private readonly _onDidChangeState = new Emitter<OTStateChangedDTO['state']>();
  readonly onDidChangeState: Event<OTStateChangedDTO['state']> = this._onDidChangeState.event;

  private readonly _onDidChangeConnection = new Emitter<OTConnectionStateDTO['state']>();
  readonly onDidChangeConnection: Event<OTConnectionStateDTO['state']> =
    this._onDidChangeConnection.event;

  private readonly _onDidReceiveRemoteOp = new Emitter<OTRemoteUpdate>();
  readonly onDidReceiveRemoteOp: Event<OTRemoteUpdate> = this._onDidReceiveRemoteOp.event;

  private readonly _onDidReceiveFileEvent = new Emitter<OTFileEventDTO>();
  readonly onDidReceiveFileEvent: Event<OTFileEventDTO> = this._onDidReceiveFileEvent.event;

  private readonly _onDidError = new Emitter<Error>();
  readonly onDidError: Event<Error> = this._onDidError.event;

  private _isActive = false;
  private connectionState: OTConnectionStateDTO['state'] = 'disconnected';
  private otState: OTStateChangedDTO['state'] = 'DISCONNECTED';
  private content = '';
  private version = 0;
  private currentProjectId: string | null = null;
  private currentFileId: string | null = null;
  /** Bumped on every joinFile to cancel stale submitFileOp IPCs after tab switches */
  private joinEpoch = 0;
  private configurePromise: Promise<void> | null = null;
  private configuredKey: string | null = null;
  private readonly disposables: Array<() => void> = [];

  private _preJoinState: { fileId: string; content: string; isDirty: boolean } | null = null;

  constructor() {
    this.disposables.push(
      api.ot.onConnectionChanged((payload: OTConnectionStateDTO) => {
        this.connectionState = payload.state;
        this._onDidChangeConnection.fire(payload.state);
      })
    );
    this.disposables.push(
      api.ot.onStateChanged((payload: OTStateChangedDTO) => {
        this.otState = payload.state;
        this.version = payload.version;
        this.currentProjectId = payload.projectId;
        this.currentFileId = payload.fileId;
        this._onDidChangeState.fire(payload.state);
      })
    );
    this.disposables.push(
      api.ot.onRemoteUpdate((payload: OTRemoteUpdateDTO) => {
        this.content = payload.content;
        this.version = payload.version;
        this.currentProjectId = payload.projectId;
        this.currentFileId = payload.fileId;

        // One-shot reconciliation after joinFile: local dirty content wins over stale server content
        if (this._reconcileJoinUpdate(payload)) return;

        this._onDidReceiveRemoteOp.fire(payload);
      })
    );
    this.disposables.push(
      api.ot.onFileEvent((payload) => this._onDidReceiveFileEvent.fire(payload))
    );
    this.disposables.push(
      api.ot.onError((payload: OTErrorDTO) => {
        const err = new Error(`[${payload.scope}] ${payload.message}`);
        if (payload.code) (err as Error & { code?: string }).code = payload.code;
        this._onDidError.fire(err);
      })
    );
  }

  get isActive(): boolean {
    return this._isActive;
  }

  getOTState(): OTStateChangedDTO['state'] {
    return this.otState;
  }

  getConnectionState(): OTConnectionStateDTO['state'] {
    return this.connectionState;
  }

  getContent(): string {
    return this.content;
  }

  getVersion(): number {
    return this.version;
  }

  getProjectId(): string | null {
    return this.currentProjectId;
  }

  getFileId(): string | null {
    return this.currentFileId;
  }

  private async ensureConfigured(): Promise<void> {
    const settings = getSettingsService().settings.collaboration;
    if (!settings.enabled || !settings.serverUrl || !settings.token) {
      throw new Error('OT collaboration is not configured');
    }

    const nextKey = `${settings.serverUrl}::${settings.token}`;
    if (this.configuredKey === nextKey && this._isActive) {
      return;
    }

    if (this.configurePromise) {
      return this.configurePromise;
    }

    this.configurePromise = api.ot
      .configure({ baseUrl: settings.serverUrl, token: settings.token })
      .then(() => {
        this._isActive = true;
        this.configuredKey = nextKey;
      })
      .finally(() => {
        this.configurePromise = null;
      });

    return this.configurePromise;
  }

  connect(config: { baseUrl: string; token: string }): void {
    const nextKey = `${config.baseUrl}::${config.token}`;
    if (this.configuredKey === nextKey && this._isActive) {
      return; // Already connected with the same config; skip reconnect
    }
    this.disconnect();
    // Do not optimistically set _isActive — flip it only after configure succeeds
    this.configuredKey = nextKey;
    void api.ot
      .configure(config)
      .then(() => {
        // Only mark active if this is still the current config (guards against disconnect races)
        if (this.configuredKey === nextKey) {
          this._isActive = true;
        }
      })
      .catch((error: unknown) => {
        // Roll back so the next call retries
        if (this.configuredKey === nextKey) {
          this._isActive = false;
          this.configuredKey = null;
        }
        this._onDidError.fire(error instanceof Error ? error : new Error(String(error)));
      });
  }

  async openLocalProject(
    projectPath: string,
    localTree: FileNode,
    workspace?: string
  ): Promise<StudioOTProjectSnapshotDTO> {
    const scanned = await api.file.scanFilePaths(projectPath);
    if (!scanned.success || !scanned.paths) {
      throw new Error(scanned.error || 'Failed to scan local project files');
    }

    const projectFiles = scanned.paths
      .map((absolutePath) => ({
        absolutePath,
        relativePath: toRelativeProjectPath(projectPath, absolutePath),
      }))
      .filter((entry) => shouldIncludeRelativePath(entry.relativePath));
    const contents = await api.file.batchRead(projectFiles.map((entry) => entry.absolutePath));
    const files = projectFiles
      .filter((entry) => Object.prototype.hasOwnProperty.call(contents, entry.absolutePath))
      .map((entry) => ({
        file_path: entry.relativePath,
        content: contents[entry.absolutePath],
      }));

    const snapshot = await api.ot.openLocalProject({
      root_path: projectPath,
      name: projectPath.split(/[\\/]/).pop() || projectPath,
      files,
      folders: collectFolderPathsFromTree(localTree, projectPath),
      workspace,
    });
    this.currentProjectId = snapshot.project.id;
    return snapshot;
  }

  async getProjectSnapshot(projectId: string): Promise<StudioOTProjectSnapshotDTO> {
    await this.ensureConfigured();
    return api.ot.getProjectSnapshot(projectId);
  }

  async getProjectTree(projectPath: string, projectId: string): Promise<FileNode> {
    return buildFileTreeFromSnapshot(projectPath, await this.getProjectSnapshot(projectId));
  }

  async listProjects(
    workspace?: string
  ): Promise<import('../../../../../shared/api-types').StudioOTProjectSummaryDTO[]> {
    await this.ensureConfigured();
    return api.ot.listProjects(workspace ?? undefined);
  }

  async getProjectFile(projectId: string, fileId: string): Promise<StudioOTProjectFileDTO> {
    await this.ensureConfigured();
    return api.ot.getProjectFile(projectId, fileId);
  }

  async createProjectFile(
    projectId: string,
    projectPath: string,
    parentPath: string,
    fileName: string
  ): Promise<StudioOTProjectFileDTO> {
    await this.ensureConfigured();
    const absolutePath = `${parentPath.replace(/[\\/]+$/, '')}/${fileName}`;
    const relativePath = toRelativeProjectPath(projectPath, absolutePath);
    return api.ot.createFile({ projectId, file_path: relativePath, content: '' });
  }

  async createProjectFolder(
    projectId: string,
    projectPath: string,
    parentPath: string,
    folderName: string
  ) {
    await this.ensureConfigured();
    const absolutePath = `${parentPath.replace(/[\\/]+$/, '')}/${folderName}`;
    const relativePath = toRelativeProjectPath(projectPath, absolutePath);
    return api.ot.createFolder({ projectId, folder_path: relativePath });
  }

  async renameProjectEntry(
    projectId: string,
    projectPath: string,
    entryId: string,
    entryType: 'file' | 'directory',
    oldPath: string,
    newName: string
  ) {
    await this.ensureConfigured();
    const normalizedOldPath = oldPath.replace(/\\/g, '/');
    const parentPath = normalizedOldPath.includes('/')
      ? normalizedOldPath.slice(0, normalizedOldPath.lastIndexOf('/'))
      : normalizedOldPath;
    const nextRelativePath = toRelativeProjectPath(projectPath, `${parentPath}/${newName}`);
    if (entryType === 'directory') {
      return api.ot.renameFolder({ projectId, folderId: entryId, folder_path: nextRelativePath });
    }
    return api.ot.renameFile({ projectId, fileId: entryId, file_path: nextRelativePath });
  }

  async deleteProjectEntry(
    projectId: string,
    entryId: string,
    entryType: 'file' | 'directory'
  ): Promise<void> {
    await this.ensureConfigured();
    if (entryType === 'directory') {
      await api.ot.deleteFolder(projectId, entryId);
      return;
    }
    await api.ot.deleteFile(projectId, entryId);
  }

  joinFile(projectId: string, fileId: string): void {
    this.joinEpoch++;
    const epoch = this.joinEpoch;
    this.currentProjectId = projectId;
    this.currentFileId = fileId;
    void this.ensureConfigured()
      .then(() => api.ot.joinFile({ projectId, fileId }))
      .then((file: StudioOTProjectFileDTO) => {
        // Ignore stale responses when joinFile was called again (user switched tabs)
        if (this.joinEpoch !== epoch) return;
        this.content = file.content;
        this.version = file.version;
        this.otState = 'SYNCHRONIZED';
        this._onDidChangeState.fire(this.otState);
      })
      .catch((error: unknown) => {
        if (this.joinEpoch !== epoch) return; // Silently ignore stale errors
        this._onDidError.fire(error instanceof Error ? error : new Error(String(error)));
      });
  }

  applyLocalChange(
    changes: { rangeOffset: number; rangeLength: number; text: string }[],
    modelValueLengthBefore: number
  ): void {
    if (!this.currentProjectId || !this.currentFileId) return;
    const op = monacoChangesToOT(changes, modelValueLengthBefore);
    if (op.isNoop()) return;
    const normalizedOps = normalizeOTJSONOps(op.toJSON());
    if (normalizedOps.length === 0) return;
    const epoch = this.joinEpoch;
    void api.ot
      .submitFileOp({
        projectId: this.currentProjectId,
        fileId: this.currentFileId,
        version: this.version,
        ops: normalizedOps,
      })
      .then((result) => {
        if (this.joinEpoch !== epoch) return;
        if (result.status === 'desynced') {
          this._onDidError.fire(new Error('Content desync detected, resyncing...'));
        }
        // 'applied' → normal; 'buffered' → offline queue succeeded. Neither needs action.
      })
      .catch((error: unknown) => {
        // joinFile has been re-invoked (tab switch); ignore op errors for the old file
        if (this.joinEpoch !== epoch) return;
        this._onDidError.fire(error instanceof Error ? error : new Error(String(error)));
      });
  }

  // ====== Pre-join state reconciliation ======

  /**
   * Called by useOTCollaboration before joinFile to snapshot the current tab's local state.
   * OTCore only supports single-file sessions — joinFile calls resetSession and drops pending ops.
   * With the snapshot, we can reconcile with the first remoteUpdate after the join.
   */
  setPreJoinState(fileId: string, content: string, isDirty: boolean): void {
    this._preJoinState = { fileId, content, isDirty };
  }

  /**
   * One-shot reconciliation: compare the first remoteUpdate after joinFile with preJoinState.
   * @returns true = reconciled (remote update suppressed); false = pass through.
   */
  private _reconcileJoinUpdate(payload: OTRemoteUpdateDTO): boolean {
    const saved = this._preJoinState;
    if (!saved || saved.fileId !== payload.fileId) return false;

    // One-shot: always clear preJoinState regardless of outcome
    this._preJoinState = null;

    // Not dirty locally → pass through and let the server content update the editor
    if (!saved.isDirty) return false;

    // Same content → no conflict, pass through
    if (saved.content === payload.content) return false;

    // Dirty locally and server content differs → local wins; resubmit to the server
    this._resubmitAsReplaceAll(saved.content);
    return true;
  }

  /**
   * Submit the local content as a replace-all op to the OT server.
   * Builds delete+insert against the server content at the current version.
   */
  private _resubmitAsReplaceAll(localContent: string): void {
    if (!this.currentProjectId || !this.currentFileId) return;
    const serverLen = this.content.length;
    const ops: StudioOTRawOp[] = [];
    if (serverLen > 0) ops.push({ delete: serverLen });
    if (localContent.length > 0) ops.push({ insert: localContent });
    if (ops.length === 0) return;

    const epoch = this.joinEpoch;
    void api.ot
      .submitFileOp({
        projectId: this.currentProjectId,
        fileId: this.currentFileId,
        version: this.version,
        ops,
      })
      .then((result) => {
        if (this.joinEpoch !== epoch) return;
        if (result.status === 'applied') {
          this.content = localContent;
        }
      })
      .catch(() => {
        // Submit failed — the next user edit will resync
      });
  }

  async applyBotEdit(params: OTApplyBotEditParams): Promise<CollaborativeApplyOutcomeDTO> {
    await this.ensureConfigured();
    return api.ot.applyBotEdit(params);
  }

  /**
   * Force-align the final content to the OT source of truth after save.
   */
  async syncSavedContent(projectId: string, fileId: string, newContent: string): Promise<boolean> {
    await this.ensureConfigured();

    const current = await this.getProjectFile(projectId, fileId);
    if (current.content === newContent) {
      if (this.currentProjectId === projectId && this.currentFileId === fileId) {
        this.content = newContent;
        this.version = current.version;
      }
      return true;
    }

    const outcome = await api.ot.applyBotEdit({
      projectId,
      fileId,
      newContent,
      originalContent: current.content,
      pollTimeoutMs: 4000,
      pollIntervalMs: 100,
    });

    if (outcome.status !== 'applied') {
      return false;
    }

    if (this.currentProjectId === projectId && this.currentFileId === fileId) {
      this.content = newContent;
      if (typeof outcome.version === 'number') {
        this.version = outcome.version;
      }
    }
    return true;
  }

  /**
   * Reset only the renderer-local state; does not disconnect in the main process.
   * Used on bootstrap failure to avoid disrupting the shared OT connection for other windows.
   */
  resetLocal(): void {
    this.content = '';
    this.version = 0;
    this.currentProjectId = null;
    this.currentFileId = null;
    this.configurePromise = null;
    this.configuredKey = null;
    this.connectionState = 'disconnected';
    this.otState = 'DISCONNECTED';
    this._isActive = false;
  }

  disconnect(): void {
    this.resetLocal();
    void api.ot.disconnect();
  }

  dispose(): void {
    this.disconnect();
    for (const dispose of this.disposables) {
      dispose();
    }
    this._onDidChangeState.dispose();
    this._onDidChangeConnection.dispose();
    this._onDidReceiveRemoteOp.dispose();
    this._onDidReceiveFileEvent.dispose();
    this._onDidError.dispose();
  }
}

function monacoChangesToOT(
  changes: { rangeOffset: number; rangeLength: number; text: string }[],
  baseLength: number
): TextOperation {
  const sorted = [...changes].sort((a, b) => a.rangeOffset - b.rangeOffset);
  const op = new TextOperation();
  let cursor = 0;

  for (const change of sorted) {
    if (change.rangeOffset > cursor) {
      op.retain(change.rangeOffset - cursor);
    }
    if (change.rangeLength > 0) {
      op.remove(change.rangeLength);
    }
    if (change.text.length > 0) {
      op.insert(change.text);
    }
    cursor = change.rangeOffset + change.rangeLength;
  }

  if (cursor < baseLength) {
    op.retain(baseLength - cursor);
  }

  return op;
}

let otService: OTService | null = null;

export function getOTService(): OTService {
  if (!otService) {
    otService = new OTService();
  }
  return otService;
}

export { buildFileTreeFromSnapshot, toRelativeProjectPath };
