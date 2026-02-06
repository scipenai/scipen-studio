/**
 * @file index.ts - Unified API Entry
 * @description IPC communication entry point for main process, provides type-safe call interfaces
 * @depends shared/ipc/channels, shared/types/config-keys
 */

import { IpcChannel } from '../../../../shared/ipc/channels';
import { type ConfigKey, ConfigKeys } from '../../../../shared/types/config-keys';
import type { FileNode } from '../types';

export { ConfigKeys, type ConfigKey };

// ==================== Import types from shared (single source of truth) ====================
import type {
  AIChatMessage,
  AIConfig,
  AIResult,
  AITestResult,
  KnowledgeEnhancedSearchOptions,
  KnowledgeInitOptions,
  KnowledgeSearchOptions,
  LSPCompletionItem,
  LSPDiagnostic,
  LSPDocumentSymbol,
  LSPHover,
  LSPLocation,
  LogEntry,
  OverleafCompileOptions,
  OverleafConfig,
  OverleafSyncCodePos,
  OverleafSyncPdfPos,
  TypstCompileOptions,
  TypstCompileResult,
} from '../../../../shared/api-types';

export type {
  AIConfig,
  AIResult,
  AITestResult,
  AIChatMessage,
  TypstCompileOptions,
  TypstCompileResult,
  OverleafConfig,
  OverleafCompileOptions,
  OverleafSyncCodePos,
  OverleafSyncPdfPos,
  KnowledgeInitOptions,
  KnowledgeSearchOptions,
  KnowledgeEnhancedSearchOptions,
  LSPDiagnostic,
  LSPCompletionItem,
  LSPHover,
  LSPLocation,
  LSPDocumentSymbol,
  LogEntry,
};

import type {
  AdvancedRetrievalConfig,
  EnhancedSearchResult,
  KnowledgeDocument,
  KnowledgeLibrary,
  KnowledgeRAGResponse,
  KnowledgeSearchResult,
  LaTeXCompileResult,
  OverleafCompileResult,
  OverleafProject,
  SyncTeXBackwardResult,
  SyncTeXForwardResult,
} from '../../../../shared/ipc/types';

import type {
  ChatGetMessagesParams,
  ChatMessage,
  ChatMessagesResult,
  ChatOperationResult,
  ChatRenameSessionParams,
  ChatSendMessageParams,
  ChatSendMessageResult,
  ChatSession,
  ChatSessionsResult,
  ChatStreamEvent,
  SendMessageOptions,
} from '../../../../shared/types/chat';

export type {
  ChatMessage,
  ChatSession,
  ChatStreamEvent,
  SendMessageOptions,
  ChatSendMessageParams,
  ChatSendMessageResult,
  ChatOperationResult,
  ChatMessagesResult,
  ChatSessionsResult,
};

export type {
  KnowledgeLibrary,
  KnowledgeDocument,
  KnowledgeSearchResult,
  KnowledgeRAGResponse,
  AdvancedRetrievalConfig,
  EnhancedSearchResult,
  LaTeXCompileResult,
  SyncTeXForwardResult,
  SyncTeXBackwardResult,
  OverleafProject,
  OverleafCompileResult,
};

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

function on(channel: IpcChannel, listener: (...args: unknown[]) => void): () => void {
  const ipc = getIpcRenderer();
  // Use the cleanup function returned by preload directly
  return ipc.on(channel, listener);
}

// ==================== File API ====================

export const file = {
  read: (path: string) => invoke<{ content: string; mtime: number }>(IpcChannel.File_Read, path),
  readBinary: (path: string) => invoke<ArrayBuffer>(IpcChannel.File_ReadBinary, path),
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
  openPath: (path: string) => invoke<void>(IpcChannel.File_OpenPath, path),
  select: (options?: {
    filters?: Array<{ name: string; extensions: string[] }>;
    multiple?: boolean;
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
    // Handler returns Array<{ path, success, content?, error? }>
    // Convert to Record for easier usage
    const results = await invoke<
      Array<{ path: string; success: boolean; content?: string; error?: string }>
    >(IpcChannel.File_BatchRead, paths);
    const record: Record<string, string> = {};
    for (const r of results) {
      if (r.success && r.content !== undefined) {
        record[r.path] = r.content;
      }
    }
    return record;
  },
  batchStat: async (paths: string[]) => {
    // Handler returns Array<{ path, success, stats?, error? }>
    // Convert to Record for easier usage
    const results = await invoke<
      Array<{
        path: string;
        success: boolean;
        stats?: { size: number; mtime: string };
        error?: string;
      }>
    >(IpcChannel.File_BatchStat, paths);
    const record: Record<string, { size: number; mtime: number }> = {};
    for (const r of results) {
      if (r.success && r.stats) {
        record[r.path] = { size: r.stats.size, mtime: new Date(r.stats.mtime).getTime() };
      }
    }
    return record;
  },
  batchExists: async (paths: string[]) => {
    // Handler returns Array<{ path, exists }>
    // Convert to Record for easier usage
    const results = await invoke<Array<{ path: string; exists: boolean }>>(
      IpcChannel.File_BatchExists,
      paths
    );
    const record: Record<string, boolean> = {};
    for (const r of results) {
      record[r.path] = r.exists;
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
    invoke<Array<{ path: string; name: string; lastOpened: number }>>(IpcChannel.Project_GetRecent),
};

// ==================== Compile API ====================

interface LaTeXOptions {
  engine?: 'pdflatex' | 'xelatex' | 'lualatex' | 'tectonic' | 'overleaf';
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
  polish: (text: string, knowledgeBaseId?: string) =>
    invoke<AIResult>(IpcChannel.AI_Polish, text, knowledgeBaseId),
  chat: (messages: AIMessage[]) => invoke<AIResult>(IpcChannel.AI_Chat, messages),
  chatStream: (messages: AIMessage[]) => invoke<AIResult>(IpcChannel.AI_ChatStream, messages),
  generateFormula: (description: string) =>
    invoke<AIResult>(IpcChannel.AI_GenerateFormula, description),
  review: (content: string) => invoke<AIResult>(IpcChannel.AI_Review, content),
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

// ==================== Knowledge Base API ====================

type KnowledgeConfig = import('../../../../shared/api-types').KnowledgeInitOptions;

interface SearchResult {
  results: Array<{
    chunkId: string;
    content: string;
    score: number;
    metadata?: Record<string, unknown>;
    filename?: string;
    source?: string;
    chunkMetadata?: {
      page?: number;
      startTime?: number;
    };
  }>;
  processingTime?: number;
}

export const knowledge = {
  initialize: (options: { dataPath: string }) =>
    invoke<void>(IpcChannel.Knowledge_Initialize, options),
  updateConfig: (config: KnowledgeConfig) =>
    invoke<void>(IpcChannel.Knowledge_UpdateConfig, config),
  createLibrary: (params: { name: string; description?: string; chunkingConfig?: unknown }) =>
    invoke<KnowledgeLibrary>(IpcChannel.Knowledge_CreateLibrary, params),
  getLibraries: () => invoke<KnowledgeLibrary[]>(IpcChannel.Knowledge_GetLibraries),
  getLibrary: (id: string) => invoke<KnowledgeLibrary | null>(IpcChannel.Knowledge_GetLibrary, id),
  updateLibrary: (id: string, updates: Partial<KnowledgeLibrary>) =>
    invoke<void>(IpcChannel.Knowledge_UpdateLibrary, id, updates),
  deleteLibrary: (id: string) => invoke<void>(IpcChannel.Knowledge_DeleteLibrary, id),
  addDocument: (libraryId: string, filePath: string, options?: { processImmediately?: boolean }) =>
    invoke<{ taskId: string }>(IpcChannel.Knowledge_AddDocument, libraryId, filePath, options),
  addText: (libraryId: string, content: string, options?: { title?: string }) =>
    invoke<{ documentId: string }>(IpcChannel.Knowledge_AddText, libraryId, content, options),
  getDocument: (id: string) =>
    invoke<KnowledgeDocument | null>(IpcChannel.Knowledge_GetDocument, id),
  getDocuments: (libraryId: string) =>
    invoke<KnowledgeDocument[]>(IpcChannel.Knowledge_GetDocuments, libraryId),
  deleteDocument: (id: string) => invoke<void>(IpcChannel.Knowledge_DeleteDocument, id),
  reprocessDocument: (documentId: string) =>
    invoke<{ taskId: string }>(IpcChannel.Knowledge_ReprocessDocument, documentId),
  search: (options: {
    query: string;
    libraryIds?: string[];
    topK?: number;
    scoreThreshold?: number;
    retrieverType?: 'vector' | 'keyword' | 'hybrid';
  }) => invoke<SearchResult>(IpcChannel.Knowledge_Search, options),
  searchEnhanced: (options: {
    query: string;
    libraryIds?: string[];
    topK?: number;
    scoreThreshold?: number;
    retrieverType?: 'vector' | 'keyword' | 'hybrid';
    enableQueryRewrite?: boolean;
    enableRerank?: boolean;
    enableContextRouting?: boolean;
    conversationHistory?: Array<{ role: string; content: string }>;
  }) =>
    invoke<SearchResult & { rewrittenQuery?: string }>(
      IpcChannel.Knowledge_SearchEnhanced,
      options
    ),
  query: (question: string, libraryIds?: string[], options?: { maxResults?: number }) =>
    invoke<{ answer: string; citations: unknown[] }>(
      IpcChannel.Knowledge_Query,
      question,
      libraryIds,
      options
    ),
  getTask: (taskId: string) =>
    invoke<{ status: string; progress: number }>(IpcChannel.Knowledge_GetTask, taskId),
  getQueueStats: () =>
    invoke<{ pending: number; processing: number }>(IpcChannel.Knowledge_GetQueueStats),
  testEmbedding: () =>
    invoke<{ success: boolean; message: string }>(IpcChannel.Knowledge_TestEmbedding),
  getDiagnostics: (libraryId?: string) =>
    invoke<{
      totalChunks: number;
      totalEmbeddings: number;
      ftsRecords: number;
      embeddingDimensions?: number[];
      libraryStats?: Array<{ libraryId: string; chunks: number; embeddings: number }>;
    }>(IpcChannel.Knowledge_Diagnostics, libraryId),
  rebuildFTS: () =>
    invoke<{ success: boolean; recordCount: number }>(IpcChannel.Knowledge_RebuildFTS),
  generateEmbeddings: (libraryId?: string) =>
    invoke<{ success: boolean; processed: number }>(
      IpcChannel.Knowledge_GenerateEmbeddings,
      libraryId
    ),
  getAdvancedConfig: () => invoke<AdvancedRetrievalConfig>(IpcChannel.Knowledge_GetAdvancedConfig),
  setAdvancedConfig: (config: AdvancedRetrievalConfig) =>
    invoke<void>(IpcChannel.Knowledge_SetAdvancedConfig, config),
  selectFiles: (options?: { mediaTypes?: string[] }) =>
    invoke<string[]>(IpcChannel.Knowledge_SelectFiles, options),
  onEvent: (callback: (event: { type: string; timestamp: number; data: unknown }) => void) =>
    on(IpcChannel.Knowledge_Event, (data) =>
      callback(data as { type: string; timestamp: number; data: unknown })
    ),
  onTaskProgress: (
    callback: (event: {
      taskId: string;
      progress: number;
      status: string;
      message?: string;
    }) => void
  ) =>
    on(IpcChannel.Knowledge_TaskProgress, (data) =>
      callback(data as { taskId: string; progress: number; status: string; message?: string })
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
  onServiceStarted: (callback: (data: { service: 'texlab' | 'tinymist' }) => void) =>
    on(IpcChannel.LSP_ServiceStarted, (data) =>
      callback(data as { service: 'texlab' | 'tinymist' })
    ),
  onServiceStopped: (callback: (data: { service: 'texlab' | 'tinymist' }) => void) =>
    on(IpcChannel.LSP_ServiceStopped, (data) =>
      callback(data as { service: 'texlab' | 'tinymist' })
    ),
  onServiceRestarted: (callback: (data: { service: 'texlab' | 'tinymist' }) => void) =>
    on(IpcChannel.LSP_ServiceRestarted, (data) =>
      callback(data as { service: 'texlab' | 'tinymist' })
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
  init: (config: OverleafConfig) => invoke<void>(IpcChannel.Overleaf_Init, config),
  testConnection: (serverUrl: string) =>
    invoke<{ success: boolean; message: string }>(IpcChannel.Overleaf_TestConnection, serverUrl),
  login: (config: OverleafConfig) =>
    invoke<{ success: boolean; message?: string }>(IpcChannel.Overleaf_Login, config),
  isLoggedIn: () => invoke<boolean>(IpcChannel.Overleaf_IsLoggedIn),
  getCookies: () => invoke<string>(IpcChannel.Overleaf_GetCookies),
  getProjects: () => invoke<OverleafProject[]>(IpcChannel.Overleaf_GetProjects),
  getProjectDetails: (projectId: string) =>
    invoke<{
      success: boolean;
      details?: { name?: string; rootFolder?: unknown[]; compiler?: string; rootDoc_id?: string };
      error?: string;
    }>(IpcChannel.Overleaf_GetProjectDetails, projectId),
  updateSettings: (projectId: string, settings: { compiler?: string; rootDocId?: string }) =>
    invoke<{ success: boolean; error?: string }>(
      IpcChannel.Overleaf_UpdateSettings,
      projectId,
      settings
    ),
  compile: (projectId: string, options?: { compiler?: string; rootDocId?: string }) =>
    invoke<CompileResult>(IpcChannel.Overleaf_Compile, projectId, options),
  stopCompile: (projectId: string) => invoke<void>(IpcChannel.Overleaf_StopCompile, projectId),
  getBuildId: () => invoke<string | null>(IpcChannel.Overleaf_GetBuildId),
  syncCode: (projectId: string, file: string, line: number, column: number, buildId?: string) =>
    invoke<OverleafSyncCodePos[] | null>(
      IpcChannel.Overleaf_SyncCode,
      projectId,
      file,
      line,
      column,
      buildId
    ),
  syncPdf: (projectId: string, page: number, h: number, v: number, buildId?: string) =>
    invoke<{ file: string; line: number; column: number } | null>(
      IpcChannel.Overleaf_SyncPdf,
      projectId,
      page,
      h,
      v,
      buildId
    ),
  getDoc: (projectId: string, docIdOrPath: string, isPath?: boolean) =>
    invoke<{ success: boolean; content?: string; docId?: string; error?: string }>(
      IpcChannel.Overleaf_GetDoc,
      projectId,
      docIdOrPath,
      isPath
    ),
  updateDoc: (projectId: string, docId: string, content: string) =>
    invoke<{ success: boolean; error?: string }>(
      IpcChannel.Overleaf_UpdateDoc,
      projectId,
      docId,
      content
    ),
  updateDocDebounced: (projectId: string, docId: string, content: string) =>
    invoke<{ success: boolean; error?: string }>(
      IpcChannel.Overleaf_UpdateDocDebounced,
      projectId,
      docId,
      content
    ),
  flushUpdates: (projectId?: string) => invoke<void>(IpcChannel.Overleaf_FlushUpdates, projectId),
  getDocCached: (projectId: string, docId: string) =>
    invoke<string | null>(IpcChannel.Overleaf_GetDocCached, projectId, docId),
  clearCache: (projectId?: string, docId?: string) =>
    invoke<void>(IpcChannel.Overleaf_ClearCache, projectId, docId),
};

// ==================== Local Replica API ====================

export interface LocalReplicaConfig {
  projectId: string;
  projectName: string;
  localPath: string;
  enabled: boolean;
  customIgnorePatterns?: string[];
}

export interface SyncResult {
  synced: number;
  skipped: number;
  errors: string[];
  conflicts: string[];
}

export const localReplica = {
  init: (config: LocalReplicaConfig) => invoke<boolean>(IpcChannel.LocalReplica_Init, config),

  getConfig: () => invoke<LocalReplicaConfig | null>(IpcChannel.LocalReplica_GetConfig),

  setEnabled: (enabled: boolean) => invoke<void>(IpcChannel.LocalReplica_SetEnabled, enabled),

  syncFromRemote: () => invoke<SyncResult>(IpcChannel.LocalReplica_SyncFromRemote),

  syncToRemote: () => invoke<SyncResult>(IpcChannel.LocalReplica_SyncToRemote),

  startWatching: () => invoke<void>(IpcChannel.LocalReplica_StartWatching),

  stopWatching: () => invoke<void>(IpcChannel.LocalReplica_StopWatching),

  isWatching: () => invoke<boolean>(IpcChannel.LocalReplica_IsWatching),
};

// ==================== Chat API ====================

export const chat = {
  sendMessage: (params: ChatSendMessageParams) =>
    invoke<ChatSendMessageResult>(IpcChannel.Chat_SendMessage, params),

  cancel: (sessionId: string) => invoke<ChatOperationResult>(IpcChannel.Chat_Cancel, sessionId),

  getSessions: () => invoke<ChatSessionsResult>(IpcChannel.Chat_GetSessions),

  getMessages: (params: ChatGetMessagesParams) =>
    invoke<ChatMessagesResult>(IpcChannel.Chat_GetMessages, params),

  deleteSession: (sessionId: string) =>
    invoke<ChatOperationResult>(IpcChannel.Chat_DeleteSession, sessionId),

  renameSession: (params: ChatRenameSessionParams) =>
    invoke<ChatOperationResult>(IpcChannel.Chat_RenameSession, params),

  createSession: (knowledgeBaseId?: string) =>
    invoke<ChatSession>(IpcChannel.Chat_CreateSession, knowledgeBaseId),

  onStream: (callback: (event: ChatStreamEvent) => void) =>
    on(IpcChannel.Chat_Stream, (data) => callback(data as ChatStreamEvent)),
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
  toMain: (level: string, message: string, context?: string) =>
    invoke<void>(IpcChannel.Log_FromRenderer, level, message, context),
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

// ==================== Agent API (Tools) ====================

import type {
  AgentAvailability,
  AgentProgress,
  AgentResult,
  Paper2BeamerConfig,
  Pdf2LatexConfig,
} from '../../../../shared/ipc/types';

export type { AgentAvailability, AgentResult, AgentProgress, Pdf2LatexConfig, Paper2BeamerConfig };

export const agent = {
  getAvailable: () => invoke<AgentAvailability>(IpcChannel.Agent_GetAvailable),
  pdf2latex: (inputFile: string, config?: Pdf2LatexConfig) =>
    invoke<AgentResult>(IpcChannel.Agent_PDF2LaTeX, inputFile, config),
  reviewPaper: (inputFile: string, timeout?: number) =>
    invoke<AgentResult>(IpcChannel.Agent_Review, inputFile, timeout),
  paper2beamer: (inputFile: string, config?: Paper2BeamerConfig) =>
    invoke<AgentResult>(IpcChannel.Agent_Paper2Beamer, inputFile, config),
  listTemplates: () => invoke<AgentResult>(IpcChannel.Agent_ListTemplates),
  killCurrentProcess: () => invoke<boolean>(IpcChannel.Agent_Kill),
  /** Sync VLM config to CLI tools */
  syncVLMConfig: (vlmConfig: {
    provider: string;
    model: string;
    apiKey: string;
    baseUrl: string;
    timeout?: number;
    maxTokens?: number;
    temperature?: number;
  }) =>
    invoke<{ success: boolean; message: string; path?: string }>(
      IpcChannel.Agent_SyncVLMConfig,
      vlmConfig
    ),
  createTempFile: (fileName: string, content: string) =>
    invoke<string | null>(IpcChannel.Agent_CreateTempFile, fileName, content),
  onProgress: (callback: (data: AgentProgress) => void) =>
    on(IpcChannel.Agent_Progress, (data) => callback(data as AgentProgress)),
};

// ==================== Selection API (Text Selection Assistant) ====================

import type {
  SelectionAddToKnowledgeDTO,
  SelectionCaptureDTO,
  SelectionConfigDTO,
} from '../../../../shared/ipc/types';

export type { SelectionCaptureDTO, SelectionAddToKnowledgeDTO, SelectionConfigDTO };

export const selection = {
  setEnabled: (enabled: boolean) =>
    invoke<{ success: boolean; error?: string }>(IpcChannel.Selection_SetEnabled, enabled),
  isEnabled: () => invoke<boolean>(IpcChannel.Selection_IsEnabled),
  getConfig: () => invoke<SelectionConfigDTO | null>(IpcChannel.Selection_GetConfig),
  setConfig: (config: Partial<SelectionConfigDTO>) =>
    invoke<{ success: boolean; error?: string }>(IpcChannel.Selection_SetConfig, config),
  getText: () => invoke<SelectionCaptureDTO | null>(IpcChannel.Selection_GetText),
  showActionWindow: (data?: SelectionCaptureDTO) =>
    invoke<{ success: boolean; error?: string }>(IpcChannel.Selection_ShowActionWindow, data),
  hideActionWindow: () =>
    invoke<{ success: boolean; error?: string }>(IpcChannel.Selection_HideActionWindow),
  hideToolbar: () => invoke<{ success: boolean; error?: string }>(IpcChannel.Selection_HideToolbar),
  addToKnowledge: (dto: SelectionAddToKnowledgeDTO) =>
    invoke<{ success: boolean; taskId?: string; error?: string }>(
      IpcChannel.Selection_AddToKnowledge,
      dto
    ),
  onTextCaptured: (callback: (data: SelectionCaptureDTO) => void) =>
    on(IpcChannel.Selection_TextCaptured, (data) => callback(data as SelectionCaptureDTO)),
};

// ==================== Unified exports ====================

export const api = {
  file,
  project,
  compile,
  synctex,
  ai,
  agent,
  knowledge,
  lsp,
  overleaf,
  localReplica,
  chat,
  win,
  app,
  dialog,
  config,
  settings,
  log,
  fileWatcher,
  selection,
};

export default api;
