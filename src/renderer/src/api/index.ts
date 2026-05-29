/**
 * @file index.ts - Unified API Entry
 * @description IPC communication entry point for main process, provides type-safe call interfaces
 * @depends shared/ipc/channels, shared/types/config-keys
 */

import { IpcChannel } from '../../../../shared/ipc/channels';

const IPC_BATCH_LIMIT = 100;

function chunkArray<T>(items: T[], size: number): T[][] {
  if (items.length <= size) return [items];

  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
import { type ConfigKey, ConfigKeys } from '../../../../shared/types/config-keys';
import type { FileNode } from '../types';

export { ConfigKeys, type ConfigKey };

// ==================== Import types from shared (single source of truth) ====================
import type {
  AIChatMessage,
  AIConfig,
  AIResult,
  AITestResult,
  LSPCompletionItem,
  LSPDiagnostic,
  LSPDocumentSymbol,
  LSPHover,
  LSPLocation,
  LSPSemanticTokens,
  LogEntry,
  OverleafConfig,
  TypstCompileOptions,
  TypstCompileResult,
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
} from '../../../../shared/api-types';

/** Window-scoped collaboration ownership marker (replaces removed im-contract DTOs). */
export interface CollaborationOwnerClaimDTO {
  backend: 'scipen-ot' | 'overleaf';
  projectId: string;
  rootPath: string | null;
  fileId: string | null;
}

export interface CollaborationOwnerDTO extends CollaborationOwnerClaimDTO {
  windowId: number;
  claimedAt: number;
}

export type {
  AIConfig,
  AIResult,
  AITestResult,
  AIChatMessage,
  TypstCompileOptions,
  TypstCompileResult,
  OverleafConfig,
  LSPDiagnostic,
  LSPCompletionItem,
  LSPHover,
  LSPLocation,
  LSPDocumentSymbol,
  LogEntry,
};

import type {
  LaTeXCompileResult,
  OverleafProjectDTO,
  SyncTeXBackwardResult,
  SyncTeXForwardResult,
} from '../../../../shared/ipc/types';

// Legacy `shared/types/chat` types (ChatMessage / ChatSession / ChatStreamEvent
// / SendMessageOptions) belonged to the deleted builtin chat path; SNACA owns
// its own message shapes via `services/agent/ChatStreamStore`.

export type { LaTeXCompileResult, SyncTeXForwardResult, SyncTeXBackwardResult, OverleafProjectDTO };

// ==================== Local type definitions (file-scoped only) ====================

type IpcRenderer = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  // on returns a cleanup function
  on: (channel: string, listener: (...args: unknown[]) => void) => () => void;
  off: (channel: string, listener: (...args: unknown[]) => void) => void;
};

// ==================== Core invocation functions ====================

function getIpcRenderer(): IpcRenderer {
  const w = window as unknown as { electron?: { ipcRenderer?: IpcRenderer } };
  if (!w.electron?.ipcRenderer) {
    throw new Error('[API] Electron IPC not available');
  }
  return w.electron.ipcRenderer;
}

async function invoke<T>(channel: IpcChannel, ...args: unknown[]): Promise<T> {
  return getIpcRenderer().invoke(channel, ...args) as Promise<T>;
}

function onEvent<T>(channel: IpcChannel, callback: (data: T) => void): () => void {
  const ipc = getIpcRenderer();
  const handler = (...args: unknown[]) => callback(args[1] as T);
  return ipc.on(channel, handler);
}

function on(channel: IpcChannel, listener: (...args: unknown[]) => void): () => void {
  const ipc = getIpcRenderer();
  // Use the cleanup function returned by preload directly
  return ipc.on(channel, listener);
}

// ==================== File API ====================

export const file = {
  read: (path: string) => invoke<{ content: string; mtime: number }>(IpcChannel.File_Read, path),
  readBinary: (path: string) => invoke<ArrayBuffer>(IpcChannel.File_ReadBinary, path),
  getLocalFileUrl: (path: string) => {
    if (!window.electron?.getLocalFileUrl) {
      throw new Error('Local file URL API is not available');
    }
    return window.electron.getLocalFileUrl(path);
  },
  write: (path: string, content: string, expectedMtime?: number) =>
    invoke<{ success: boolean; conflict?: boolean; currentMtime?: number }>(
      IpcChannel.File_Write,
      path,
      content,
      expectedMtime
    ),
  create: (path: string, content?: string) =>
    invoke<boolean>(IpcChannel.File_Create, path, content),
  createFolder: (path: string) => invoke<void>(IpcChannel.Folder_Create, path),
  delete: (path: string, entityType?: string, entityId?: string) =>
    invoke<void>(IpcChannel.File_Delete, path, entityType, entityId),
  /** Move to trash (recoverable deletion, VS Code default behavior) */
  trash: (path: string) => invoke<boolean>(IpcChannel.File_Trash, path),
  rename: (oldPath: string, newPath: string, entityType?: string, entityId?: string) =>
    invoke<void>(IpcChannel.File_Rename, oldPath, newPath, entityType, entityId),
  copy: (src: string, dest: string) => invoke<void>(IpcChannel.File_Copy, src, dest),
  move: (src: string, dest: string) => invoke<void>(IpcChannel.File_Move, src, dest),
  exists: (path: string) => invoke<boolean>(IpcChannel.File_Exists, path),
  stats: (path: string) =>
    invoke<{ size: number; mtime: number; isDirectory: boolean }>(IpcChannel.File_Stats, path),
  showInFolder: (path: string) => invoke<void>(IpcChannel.File_ShowInFolder, path),
  openPath: (path: string) => invoke<boolean>(IpcChannel.File_OpenPath, path),
  select: (options?: {
    filters?: Array<{ name: string; extensions: string[] }>;
    multiple?: boolean;
    directory?: boolean;
  }) =>
    invoke<Array<{ path: string; name: string; ext: string; content: Uint8Array }> | null>(
      IpcChannel.File_Select,
      options
    ),
  refreshTree: (projectPath: string) =>
    invoke<{ success: boolean; fileTree?: FileNode }>(IpcChannel.File_RefreshTree, projectPath),
  /** Resolve directory children (lazy loading) */
  resolveChildren: (dirPath: string) =>
    invoke<{ success: boolean; children?: FileNode[]; error?: string }>(
      IpcChannel.File_ResolveChildren,
      dirPath
    ),
  /** Scan all file paths (flat list, for @ completion indexing) */
  scanFilePaths: (projectPath: string) =>
    invoke<{ success: boolean; paths?: string[]; error?: string }>(
      IpcChannel.File_ScanPaths,
      projectPath
    ),
  getClipboard: async () => {
    const files = await invoke<string[] | null>(IpcChannel.Clipboard_GetFiles);
    return { success: files !== null, files: files ?? undefined };
  },
  batchRead: async (paths: string[]) => {
    const record: Record<string, string> = {};

    for (const chunk of chunkArray(paths, IPC_BATCH_LIMIT)) {
      const results = await invoke<
        Array<{ path: string; success: boolean; content?: string; error?: string }>
      >(IpcChannel.File_BatchRead, chunk);

      for (const result of results) {
        if (result.success && result.content !== undefined) {
          record[result.path] = result.content;
        }
      }
    }

    return record;
  },
  batchStat: async (paths: string[]) => {
    const record: Record<string, { size: number; mtime: number }> = {};

    for (const chunk of chunkArray(paths, IPC_BATCH_LIMIT)) {
      const results = await invoke<
        Array<{
          path: string;
          success: boolean;
          stats?: { size: number; mtime: string };
          error?: string;
        }>
      >(IpcChannel.File_BatchStat, chunk);

      for (const result of results) {
        if (result.success && result.stats) {
          record[result.path] = {
            size: result.stats.size,
            mtime: new Date(result.stats.mtime).getTime(),
          };
        }
      }
    }

    return record;
  },
  batchExists: async (paths: string[]) => {
    const record: Record<string, boolean> = {};

    for (const chunk of chunkArray(paths, IPC_BATCH_LIMIT)) {
      const results = await invoke<Array<{ path: string; exists: boolean }>>(
        IpcChannel.File_BatchExists,
        chunk
      );

      for (const result of results) {
        record[result.path] = result.exists;
      }
    }

    return record;
  },
  batchWrite: async (files: Array<{ path: string; content: string }>) => {
    await invoke<Array<{ path: string; success: boolean; error?: string }>>(
      IpcChannel.File_BatchWrite,
      files
    );
  },
  batchDelete: async (paths: string[]) => {
    await invoke<Array<{ path: string; success: boolean; error?: string }>>(
      IpcChannel.File_BatchDelete,
      paths
    );
  },
};

// ==================== Project API ====================

export const project = {
  open: () => invoke<{ projectPath: string; fileTree: unknown } | null>(IpcChannel.Project_Open),
  openByPath: (path: string) =>
    invoke<{ projectPath: string; fileTree: unknown } | null>(IpcChannel.Project_OpenByPath, path),
  getRecent: () =>
    invoke<Array<{ path: string; name: string; lastOpened: number; isRemote?: boolean }>>(
      IpcChannel.Project_GetRecent
    ),
};

export const collaborationOwner = {
  setActive: (owner: CollaborationOwnerClaimDTO) =>
    invoke<CollaborationOwnerDTO>(IpcChannel.CollaborationOwner_SetActive, owner),
  clear: (params: { backend: 'scipen-ot' | 'overleaf' }) =>
    invoke<void>(IpcChannel.CollaborationOwner_Clear, params),
};

// ==================== Compile API ====================

interface LaTeXOptions {
  engine?: 'pdflatex' | 'xelatex' | 'lualatex' | 'tectonic';
  mainFile?: string;
  outputDirectory?: string;
}

interface CompileResult {
  success: boolean;
  pdfPath?: string;
  pdfData?: string;
  pdfBuffer?: Uint8Array;
  synctexPath?: string;
  log?: string;
  errors?: string[];
  warnings?: string[];
  buildId?: string;
  parsedErrors?: unknown[];
  parsedWarnings?: unknown[];
  parsedInfo?: unknown[];
}

export const compile = {
  latex: (content: string, options?: LaTeXOptions) =>
    invoke<CompileResult>(IpcChannel.Compile_LaTeX, content, options),
  typst: (content: string, options?: TypstCompileOptions) =>
    invoke<CompileResult>(IpcChannel.Compile_Typst, content, options),
  checkTypst: () => invoke<{ available: boolean; version?: string }>(IpcChannel.Typst_Available),
  cancel: (type?: 'latex' | 'typst') =>
    invoke<{ success: boolean; cancelled: number }>(IpcChannel.Compile_Cancel, type),
  getStatus: () =>
    invoke<{
      latex: { isCompiling: boolean; queueLength: number; currentTaskId: string | null };
      typst: { isCompiling: boolean };
    }>(IpcChannel.Compile_GetStatus),
};

// ==================== SyncTeX API ====================

interface ForwardSyncResult {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface InverseSyncResult {
  file: string;
  line: number;
  column: number;
}

export const synctex = {
  forward: (texFile: string, line: number, column: number, pdfFile: string) =>
    invoke<ForwardSyncResult | null>(IpcChannel.SyncTeX_Forward, texFile, line, column, pdfFile),
  backward: (pdfFile: string, page: number, x: number, y: number) =>
    invoke<InverseSyncResult | null>(IpcChannel.SyncTeX_Backward, pdfFile, page, x, y),
};

// ==================== AI API ====================

type AIMessage = import('../../../../shared/api-types').AIChatMessage;

export const ai = {
  updateConfig: (config: AIConfig) => invoke<void>(IpcChannel.AI_UpdateConfig, config),
  isConfigured: () => invoke<boolean>(IpcChannel.AI_IsConfigured),
  completion: (context: string) => invoke<AIResult>(IpcChannel.AI_Completion, context),
  chatStream: (messages: AIMessage[]) => invoke<AIResult>(IpcChannel.AI_ChatStream, messages),
  testConnection: () => invoke<{ success: boolean; message: string }>(IpcChannel.AI_TestConnection),
  stopGeneration: () => invoke<void>(IpcChannel.AI_StopGeneration),
  isGenerating: () => invoke<boolean>(IpcChannel.AI_IsGenerating),
  /** Fetch available models from API */
  fetchModels: (baseUrl: string, apiKey?: string) =>
    invoke<{
      success: boolean;
      models?: Array<{ id: string; object?: string; owned_by?: string; created?: number }>;
      error?: string;
    }>(IpcChannel.AI_FetchModels, baseUrl, apiKey),
  onStreamChunk: (callback: (chunk: { type: string; content?: string; error?: string }) => void) =>
    on(IpcChannel.AI_StreamChunk, (data) =>
      callback(data as { type: string; content?: string; error?: string })
    ),
};

// ==================== LSP API ====================

export const lsp = {
  getProcessInfo: () => invoke<{ pid?: number; memory?: number }>(IpcChannel.LSP_GetProcessInfo),
  isAvailable: () => invoke<boolean>(IpcChannel.LSP_IsAvailable),
  getVersion: () => invoke<string | null>(IpcChannel.LSP_GetVersion),
  start: (rootPath: string, options?: { virtual?: boolean; debug?: boolean }) =>
    invoke<boolean>(IpcChannel.LSP_Start, rootPath, options),
  stop: () => invoke<void>(IpcChannel.LSP_Stop),
  isRunning: () => invoke<boolean>(IpcChannel.LSP_IsRunning),
  isVirtualMode: () => invoke<boolean>(IpcChannel.LSP_IsVirtualMode),
  openDocument: (filePath: string, content: string, languageId?: string) =>
    invoke<void>(IpcChannel.LSP_OpenDocument, filePath, content, languageId),
  updateDocument: (filePath: string, content: string) =>
    invoke<void>(IpcChannel.LSP_UpdateDocument, filePath, content),
  updateDocumentIncremental: (filePath: string, changes: unknown[]) =>
    invoke<void>(IpcChannel.LSP_UpdateDocumentIncremental, filePath, changes),
  closeDocument: (filePath: string) => invoke<void>(IpcChannel.LSP_CloseDocument, filePath),
  saveDocument: (filePath: string) => invoke<void>(IpcChannel.LSP_SaveDocument, filePath),
  getCompletions: (filePath: string, line: number, character: number) =>
    invoke<LSPCompletionItem[]>(IpcChannel.LSP_GetCompletions, filePath, line, character),
  getHover: (filePath: string, line: number, character: number) =>
    invoke<LSPHover | null>(IpcChannel.LSP_GetHover, filePath, line, character),
  getDefinition: (filePath: string, line: number, character: number) =>
    invoke<LSPLocation | LSPLocation[] | null>(
      IpcChannel.LSP_GetDefinition,
      filePath,
      line,
      character
    ),
  getReferences: (
    filePath: string,
    line: number,
    character: number,
    includeDeclaration?: boolean
  ) =>
    invoke<LSPLocation[]>(
      IpcChannel.LSP_GetReferences,
      filePath,
      line,
      character,
      includeDeclaration
    ),
  getSymbols: (filePath: string) =>
    invoke<LSPDocumentSymbol[]>(IpcChannel.LSP_GetSymbols, filePath),
  getSemanticTokens: (filePath: string) =>
    invoke<LSPSemanticTokens | null>(IpcChannel.LSP_GetSemanticTokens, filePath),
  build: (filePath: string) => invoke<void>(IpcChannel.LSP_Build, filePath),
  forwardSearch: (filePath: string, line: number) =>
    invoke<void>(IpcChannel.LSP_ForwardSearch, filePath, line),
  requestDirectChannel: () => invoke<unknown>(IpcChannel.LSP_RequestDirectChannel),
  onDiagnostics: (callback: (data: { filePath: string; diagnostics: LSPDiagnostic[] }) => void) =>
    on(IpcChannel.LSP_Diagnostics, (data) =>
      callback(data as { filePath: string; diagnostics: LSPDiagnostic[] })
    ),
  onInitialized: (callback: () => void) => on(IpcChannel.LSP_Initialized, () => callback()),
  onExit: (callback: (data: { code: number | null; signal: string | null }) => void) =>
    on(IpcChannel.LSP_Exit, (data) =>
      callback(data as { code: number | null; signal: string | null })
    ),
  onServiceStarted: (callback: (data: { service: 'texlab' | 'tinymist' | 'marksman' }) => void) =>
    on(IpcChannel.LSP_ServiceStarted, (data) =>
      callback(data as { service: 'texlab' | 'tinymist' | 'marksman' })
    ),
  onServiceStopped: (callback: (data: { service: 'texlab' | 'tinymist' | 'marksman' }) => void) =>
    on(IpcChannel.LSP_ServiceStopped, (data) =>
      callback(data as { service: 'texlab' | 'tinymist' | 'marksman' })
    ),
  onServiceRestarted: (callback: (data: { service: 'texlab' | 'tinymist' | 'marksman' }) => void) =>
    on(IpcChannel.LSP_ServiceRestarted, (data) =>
      callback(data as { service: 'texlab' | 'tinymist' | 'marksman' })
    ),
  onRecovered: (callback: () => void) => on(IpcChannel.LSP_Recovered, () => callback()),
  /**
   * Listen for direct channel establishment event
   * Callback receives MessagePort for direct communication with LSP process
   * Note: Type is unknown for preload compatibility, cast to MessagePort when using
   */
  onDirectChannel: (callback: (port: unknown) => void) => {
    const w = window as unknown as {
      electron?: {
        lsp?: {
          onDirectChannel?: (cb: (port: unknown) => void) => () => void;
        };
      };
    };
    const onDirectChannel = w.electron?.lsp?.onDirectChannel;
    if (!onDirectChannel) {
      throw new Error('[API] LSP direct channel not available');
    }
    return onDirectChannel(callback);
  },
  onDirectChannelClosed: (callback: () => void) =>
    on(IpcChannel.LSP_DirectChannelClosed, () => callback()),
};

// ==================== Overleaf API ====================

export const overleaf = {
  init: (config: OverleafConfig) =>
    invoke<{ success: boolean; message?: string }>(IpcChannel.OverleafAuth_Init, config),
  testConnection: (serverUrl: string) =>
    invoke<{ success: boolean; message: string }>(
      IpcChannel.OverleafAuth_TestConnection,
      serverUrl
    ),
  login: (config: OverleafConfig) =>
    invoke<{ success: boolean; message?: string }>(IpcChannel.OverleafAuth_Login, config),
  isLoggedIn: () => invoke<boolean>(IpcChannel.OverleafAuth_IsLoggedIn),
  getCookies: () => invoke<string>(IpcChannel.OverleafAuth_GetCookies),
  getProjects: () => invoke<OverleafProjectDTO[]>(IpcChannel.OverleafProject_GetProjects),
  getProjectDetails: (projectId: string) =>
    invoke<{
      success: boolean;
      details?: { name?: string; rootFolder?: unknown[]; compiler?: string; rootDoc_id?: string };
      error?: string;
    }>(IpcChannel.OverleafProject_GetDetails, projectId),
  // Write channels are deprecated — live writes go exclusively through OverleafLive_SubmitPatches (api.overleafLive).

  /** Download an Overleaf project to local disk (local-first mode). */
  downloadProject: (projectId: string, projectName: string) =>
    invoke<{
      success: boolean;
      localPath?: string;
      files?: Array<{ file_path: string; content: string }>;
      folders?: string[];
      meta?: {
        overleafProjectId: string;
        serverUrl: string;
        projectName: string;
        docIdMap: Record<string, string>;
        downloadedAt: string;
      };
      error?: string;
    }>(IpcChannel.OverleafProject_Download, projectId, projectName),

  /** Look up the local path of a previously downloaded project. */
  findLocalPath: (projectId: string) =>
    invoke<string | null>(IpcChannel.OverleafProject_FindLocalPath, projectId),

  /** Read metadata of a downloaded project. */
  getProjectMeta: (localPath: string) =>
    invoke<{
      overleafProjectId: string;
      serverUrl: string;
      projectName: string;
      docIdMap: Record<string, string>;
      downloadedAt: string;
    } | null>(IpcChannel.OverleafProject_GetMeta, localPath),

  /** Persist the docIdMap of a downloaded project. */
  updateDocIdMap: (localPath: string, docIdMap: Record<string, string>) =>
    invoke<boolean>(IpcChannel.OverleafProject_UpdateDocIdMap, localPath, docIdMap),

  /** Sync a single file to Overleaf. */
  syncFile: (
    overleafProjectId: string,
    docId: string,
    localContent: string,
    baseCachePath: string
  ) =>
    invoke<{ status: string; remoteContent?: string; error?: string }>(
      IpcChannel.OverleafProject_SyncFile,
      overleafProjectId,
      docId,
      localContent,
      baseCachePath
    ),

  /** Sync an entire project to Overleaf. */
  syncProject: (overleafProjectId: string, docIdMap: Record<string, string>, localRoot: string) =>
    invoke<Record<string, { status: string; remoteContent?: string; error?: string }>>(
      IpcChannel.OverleafProject_SyncProject,
      overleafProjectId,
      docIdMap,
      localRoot
    ),

  /** Sync a file by its relative path (auto-resolves or creates the docId; creates the file if missing). */
  syncFileByPath: (
    overleafProjectId: string,
    relativePath: string,
    localContent: string,
    localRoot: string,
    docIdMap: Record<string, string>
  ) =>
    invoke<{ status: string; remoteContent?: string; newDocId?: string; error?: string }>(
      IpcChannel.OverleafProject_SyncFileByPath,
      overleafProjectId,
      relativePath,
      localContent,
      localRoot,
      docIdMap
    ),

  /** Create a new Overleaf document and sync the local content. */
  createAndSync: (
    overleafProjectId: string,
    fileName: string,
    parentFolderId: string,
    localContent: string,
    baseCachePath: string
  ) =>
    invoke<{ docId: string } | null>(
      IpcChannel.OverleafProject_CreateAndSync,
      overleafProjectId,
      fileName,
      parentFolderId,
      localContent,
      baseCachePath
    ),
};

export const overleafLive = {
  configure: (config: OverleafLiveConfigureParams) =>
    invoke<OverleafLiveConnectionStateDTO>(IpcChannel.OverleafLive_Configure, config),
  disconnect: () => invoke<void>(IpcChannel.OverleafLive_Disconnect),
  getState: () => invoke<OverleafLiveStateChangedDTO>(IpcChannel.OverleafLive_GetState),
  joinDoc: (params: OverleafLiveJoinDocParams) =>
    invoke<OverleafLiveDocStateDTO>(IpcChannel.OverleafLive_JoinDoc, params),
  submitPatches: (params: OverleafLiveSubmitPatchesParams) =>
    invoke<OverleafLiveRemotePatchDTO>(IpcChannel.OverleafLive_SubmitPatches, params),
  createEntity: (params: OverleafLiveCreateEntityParams) =>
    invoke<OverleafLiveEntityResultDTO>(IpcChannel.OverleafLive_CreateEntity, params),
  renameEntity: (params: OverleafLiveRenameEntityParams) =>
    invoke<OverleafLiveEntityResultDTO>(IpcChannel.OverleafLive_RenameEntity, params),
  moveEntity: (params: OverleafLiveMoveEntityParams) =>
    invoke<OverleafLiveEntityResultDTO>(IpcChannel.OverleafLive_MoveEntity, params),
  deleteEntity: (params: OverleafLiveDeleteEntityParams) =>
    invoke<OverleafLiveEntityResultDTO>(IpcChannel.OverleafLive_DeleteEntity, params),
  uploadFile: (params: OverleafLiveUploadFileParams) =>
    invoke<OverleafLiveEntityResultDTO>(IpcChannel.OverleafLive_UploadFile, params),
  onConnectionChanged: (listener: (payload: OverleafLiveConnectionStateDTO) => void) =>
    on(IpcChannel.OverleafLive_ConnectionChanged, listener as (...args: unknown[]) => void),
  onStateChanged: (listener: (payload: OverleafLiveStateChangedDTO) => void) =>
    on(IpcChannel.OverleafLive_StateChanged, listener as (...args: unknown[]) => void),
  onRemotePatch: (listener: (payload: OverleafLiveRemotePatchDTO) => void) =>
    on(IpcChannel.OverleafLive_RemotePatch, listener as (...args: unknown[]) => void),
  onTreeChanged: (listener: (payload: OverleafLiveTreeChangedDTO) => void) =>
    on(IpcChannel.OverleafLive_TreeChanged, listener as (...args: unknown[]) => void),
  onError: (listener: (payload: OverleafLiveErrorDTO) => void) =>
    on(IpcChannel.OverleafLive_Error, listener as (...args: unknown[]) => void),
};

// ==================== Window API ====================

export const win = {
  newWindow: (options?: { projectPath?: string }) => invoke<void>(IpcChannel.Window_New, options),
  getAll: () => invoke<Array<{ id: number; title: string }>>(IpcChannel.Window_GetAll),
  close: () => invoke<void>(IpcChannel.Window_Close),
  focus: (windowId: number) => invoke<void>(IpcChannel.Window_Focus, windowId),
  onOpenProject: (callback: (projectPath: string) => void) =>
    on(IpcChannel.Window_OpenProject, (path) => callback(path as string)),
  onOpenFile: (callback: (filePath: string) => void) =>
    on(IpcChannel.Window_OpenFile, (path) => callback(path as string)),
};

// ==================== App API ====================

export const app = {
  getVersion: () => invoke<string>(IpcChannel.App_GetVersion),
  openExternal: (url: string) => invoke<void>(IpcChannel.App_OpenExternal, url),
  getHomeDir: () => invoke<string>(IpcChannel.App_GetHomeDir),
  getAppDataDir: () => invoke<string>(IpcChannel.App_GetAppDataDir),
  getPlatform: (): NodeJS.Platform => {
    const w = window as unknown as { electron?: { platform?: NodeJS.Platform } };
    return w.electron?.platform ?? 'linux';
  },
  checkUpdate: () =>
    invoke<import('../../../../shared/ipc/app-contract').UpdateStatus>(IpcChannel.App_CheckUpdate),
  downloadUpdate: () => invoke<void>(IpcChannel.App_DownloadUpdate),
  installUpdate: () => invoke<void>(IpcChannel.App_InstallUpdate),
  onUpdateStatus: (
    callback: (status: import('../../../../shared/ipc/app-contract').UpdateStatus) => void
  ): (() => void) => {
    return onEvent(IpcChannel.App_UpdateStatus, callback);
  },
};

// ==================== Dialog API ====================

export const dialog = {
  confirm: (message: string, title?: string) =>
    invoke<boolean>(IpcChannel.Dialog_Confirm, { message, title }),
  message: (message: string, type?: 'info' | 'warning' | 'error', title?: string) =>
    invoke<void>(IpcChannel.Dialog_Message, { message, type, title }),
};

// ==================== Config API ====================

export const config = {
  get: <T = unknown>(key: ConfigKey | ConfigKeys) => invoke<T>(IpcChannel.Config_Get, key),
  set: (key: ConfigKey | ConfigKeys, value: unknown, notify?: boolean) =>
    invoke<void>(IpcChannel.Config_Set, key, value, notify),
  /** Listen for config change events (broadcast from main process) */
  onChanged: (callback: (data: { key: ConfigKey; value: unknown }) => void) =>
    on(IpcChannel.Config_Changed, (data) => callback(data as { key: ConfigKey; value: unknown })),
};

// ==================== Settings API (AI Providers) ====================

import type { AIConfigDTO, AIProviderDTO, SelectedModels } from '../../../../shared/ipc/types';

export type { AIProviderDTO, SelectedModels, AIConfigDTO };

export const settings = {
  getAIProviders: () => invoke<AIProviderDTO[]>(IpcChannel.Settings_GetAIProviders),
  setAIProviders: (providers: AIProviderDTO[]) =>
    invoke<{ success: boolean }>(IpcChannel.Settings_SetAIProviders, providers),
  getSelectedModels: () => invoke<SelectedModels>(IpcChannel.Settings_GetSelectedModels),
  setSelectedModels: (models: SelectedModels) =>
    invoke<{ success: boolean }>(IpcChannel.Settings_SetSelectedModels, models),
  getAIConfig: () => invoke<AIConfigDTO>(IpcChannel.Settings_GetAIConfig),
  setAIConfig: (config: AIConfigDTO) =>
    invoke<{ success: boolean }>(IpcChannel.Settings_SetAIConfig, config),
  onAIConfigChanged: (callback: (config: AIConfigDTO) => void) =>
    on(IpcChannel.Settings_AIConfigChanged, (data) => callback(data as AIConfigDTO)),
};

// ==================== Log API ====================

export const log = {
  getPath: () => invoke<string>(IpcChannel.Log_GetPath),
  openFolder: () => invoke<void>(IpcChannel.Log_OpenFolder),
  write: (entries: LogEntry[]) => invoke<void>(IpcChannel.Log_Write, entries),
  exportDiagnostics: () => invoke<string>(IpcChannel.Log_ExportDiagnostics),
  clear: () => invoke<void>(IpcChannel.Log_Clear),
  toMain: (
    source: { process: 'renderer'; window?: string; module?: string },
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    data?: unknown[]
  ) => invoke<void>(IpcChannel.Log_FromRenderer, source, level, message, data),
};

// ==================== FileWatcher API ====================

export const fileWatcher = {
  start: (projectPath: string) => invoke<void>(IpcChannel.FileWatcher_Start, projectPath),
  stop: () => invoke<void>(IpcChannel.FileWatcher_Stop),
  onFileChanged: (
    callback: (event: { type: 'change' | 'unlink' | 'add'; path: string; mtime?: number }) => void
  ) =>
    on(IpcChannel.FileWatcher_Changed, (data) =>
      callback(data as { type: 'change' | 'unlink' | 'add'; path: string; mtime?: number })
    ),
};

// ==================== Selection API (Text Selection Assistant) ====================

import type { SelectionCaptureDTO, SelectionConfigDTO } from '../../../../shared/ipc/types';

export type { SelectionCaptureDTO, SelectionConfigDTO };

export const selection = {
  setEnabled: (enabled: boolean) =>
    invoke<{ success: boolean; error?: string }>(IpcChannel.Selection_SetEnabled, enabled),
  isEnabled: () => invoke<boolean>(IpcChannel.Selection_IsEnabled),
  getConfig: () => invoke<SelectionConfigDTO | null>(IpcChannel.Selection_GetConfig),
  setConfig: (config: Partial<SelectionConfigDTO>) =>
    invoke<{ success: boolean; error?: string }>(IpcChannel.Selection_SetConfig, config),
  getText: () => invoke<SelectionCaptureDTO | null>(IpcChannel.Selection_GetText),
  onTextCaptured: (callback: (data: SelectionCaptureDTO) => void) =>
    on(IpcChannel.Selection_TextCaptured, (data) => callback(data as SelectionCaptureDTO)),
};

// ==================== Zotero API ====================

import type {
  ZoteroAnnotationDTO,
  ZoteroDetectionResultDTO,
  ZoteroFullTextResultDTO,
  ZoteroPingResultDTO,
  ZoteroSettingsDTO,
  ZoteroSettingsPatchDTO,
} from '../../../../shared/types/zotero';
import type {
  MinerUContentList,
  MinerUParseStatusDTO,
} from '../../../../shared/types/zotero-mineru';
import type {
  BibTexSyncStatusDTO,
  GetSnapshotRequestDTO,
  GetSnapshotResultDTO,
  RefreshResultDTO,
  ZoteroDiagnosticsDTO,
  ZoteroEventDTO,
} from '../../../../shared/types/zotero-events';

export const zotero = {
  getSettings: () => invoke<ZoteroSettingsDTO>(IpcChannel.Zotero_GetSettings),
  setSettings: (patch: ZoteroSettingsPatchDTO) =>
    invoke<{ success: boolean }>(IpcChannel.Zotero_SetSettings, patch),
  setMinerUApiKey: (token: string) =>
    invoke<{ success: boolean }>(IpcChannel.Zotero_SetMinerUApiKey, token),
  clearMinerUApiKey: () => invoke<{ success: boolean }>(IpcChannel.Zotero_ClearMinerUApiKey),
  setEmbeddingApiKey: (token: string) =>
    invoke<{ success: boolean }>(IpcChannel.Zotero_SetEmbeddingApiKey, token),
  clearEmbeddingApiKey: () => invoke<{ success: boolean }>(IpcChannel.Zotero_ClearEmbeddingApiKey),
  detectInstallation: () =>
    invoke<ZoteroDetectionResultDTO>(IpcChannel.Zotero_DetectInstallation),
  pingLocalApi: () => invoke<ZoteroPingResultDTO>(IpcChannel.Zotero_PingLocalApi),
  getSnapshot: (req: GetSnapshotRequestDTO = {}) =>
    invoke<GetSnapshotResultDTO>(IpcChannel.Zotero_GetSnapshot, req),
  requestRefresh: () => invoke<RefreshResultDTO>(IpcChannel.Zotero_RequestRefresh),
  getDiagnostics: () => invoke<ZoteroDiagnosticsDTO>(IpcChannel.Zotero_GetDiagnostics),
  syncBibTex: () => invoke<BibTexSyncStatusDTO>(IpcChannel.Zotero_SyncBibTex),
  getBibTexSyncStatus: () =>
    invoke<BibTexSyncStatusDTO>(IpcChannel.Zotero_GetBibTexSyncStatus),
  getCslByKey: (citationKey: string) =>
    invoke<unknown | null>(IpcChannel.Zotero_GetCslByKey, citationKey),
  getItemAnnotations: (itemKey: string) =>
    invoke<ZoteroAnnotationDTO[]>(IpcChannel.Zotero_GetItemAnnotations, itemKey),
  getFullText: (itemKey: string) =>
    invoke<ZoteroFullTextResultDTO>(IpcChannel.Zotero_GetFullText, itemKey),
  loadPdf: (itemKey: string) => invoke<ArrayBuffer>(IpcChannel.Zotero_LoadPdf, itemKey),
  parseWithMinerU: (itemKey: string) =>
    invoke<{ started: boolean }>(IpcChannel.Zotero_ParseWithMinerU, itemKey),
  getMinerUStatus: (itemKey: string) =>
    invoke<MinerUParseStatusDTO>(IpcChannel.Zotero_GetMinerUStatus, itemKey),
  getParsedMarkdown: (itemKey: string) =>
    invoke<{ markdown: string; parsedDir: string } | null>(
      IpcChannel.Zotero_GetParsedMarkdown,
      itemKey
    ),
  getContentList: (itemKey: string) =>
    invoke<MinerUContentList | null>(IpcChannel.Zotero_GetContentList, itemKey),
  onSettingsChanged: (callback: (settings: ZoteroSettingsDTO) => void) =>
    on(IpcChannel.Zotero_SettingsChanged, (data) => callback(data as ZoteroSettingsDTO)),
  onEvent: (callback: (event: ZoteroEventDTO) => void) =>
    on(IpcChannel.Zotero_Event, (data) => callback(data as ZoteroEventDTO)),
  onMinerUProgress: (callback: (status: MinerUParseStatusDTO) => void) =>
    on(IpcChannel.Zotero_MinerUProgress, (data) => callback(data as MinerUParseStatusDTO)),
};

// ==================== Unified exports ====================

export const api = {
  file,
  overleafLive,
  project,
  compile,
  synctex,
  ai,
  lsp,
  overleaf,
  collaborationOwner,
  win,
  app,
  dialog,
  config,
  settings,
  log,
  fileWatcher,
  selection,
  zotero,
};

export default api;
