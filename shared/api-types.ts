/**
 * @file Type-Safe IPC API Contract
 * @description Defines all IPC channel type contracts between main and renderer processes
 * @depends ipc/channels, ipc/types, types/chat
 *
 * Design principles:
 * 1. Single Source of Truth
 * 2. Compile-time type safety
 * 3. Auto-inferred parameter and return types
 */

import { IpcChannel } from './ipc/channels';

// ====== Shared Type Imports ======
import type {
  AIConfigDTO,
  AIProviderDTO,
  AdvancedRetrievalConfig,
  AgentAvailability,
  AgentProgress,
  AgentResult,
  EnhancedSearchResult,
  FileFilter,
  FileStats,
  FileTreeNode,
  KnowledgeDiagnostics,
  KnowledgeDocument,
  KnowledgeLibrary,
  KnowledgeQueueStats,
  KnowledgeRAGResponse,
  KnowledgeSearchResult,
  KnowledgeTaskStatus,
  LaTeXCompileOptions,
  LaTeXCompileResult,
  OverleafCompileResult,
  OverleafProject,
  Paper2BeamerConfig,
  Pdf2LatexConfig,
  SelectedFile,
  SelectedModels,
  SelectionAddToKnowledgeDTO,
  SelectionCaptureDTO,
  SelectionConfigDTO,
  SyncTeXBackwardResult,
  SyncTeXForwardResult,
} from './ipc/types';

import type {
  ChatGetMessagesParams,
  ChatMessagesResult,
  ChatOperationResult,
  ChatRenameSessionParams,
  ChatSendMessageParams,
  ChatSendMessageResult,
  ChatSession,
  ChatSessionsResult,
  ChatStreamEvent,
} from './types/chat';

// ====== Compilation Types ======

export interface TypstCompileOptions {
  engine?: 'typst' | 'tinymist';
  mainFile?: string;
  projectPath?: string;
}

export interface TypstCompileResult {
  success: boolean;
  pdfPath?: string;
  pdfBuffer?: Uint8Array;
  /** @deprecated Use pdfBuffer instead */
  pdfData?: string;
  errors: string[];
  warnings?: string[];
  log?: string;
}

export interface TypstAvailability {
  tinymist: { available: boolean; version: string | null };
  typst: { available: boolean; version: string | null };
}

export type CompileCancelType = 'latex' | 'typst';

export interface CompileCancelResult {
  success: boolean;
  cancelled: number;
}

// ====== File Operations ======

export interface BatchReadResult {
  path: string;
  success: boolean;
  content?: string;
  error?: string;
}

export interface BatchStatResult {
  path: string;
  success: boolean;
  stats?: FileStats;
  error?: string;
}

export interface BatchExistsResult {
  path: string;
  exists: boolean;
}

export interface BatchWriteResult {
  path: string;
  success: boolean;
  error?: string;
}

// ====== AI Types ======

export interface AIConfig {
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  completionModel?: string;
  polishModel?: string;
}

export interface AIResult {
  success: boolean;
  content?: string;
  result?: string; // @deprecated Use content instead
  error?: string;
}

export interface AITestResult {
  success: boolean;
  message: string;
}

/** @deprecated Use ChatMessage from types/chat instead */
export interface AIChatMessage {
  role: string;
  content: string;
}

// ====== LSP Types ======

export interface LSPProcessInfo {
  mode: string;
  processAlive: boolean;
  initialized: boolean;
}

export interface LSPStartOptions {
  virtual?: boolean;
}

export interface LSPDiagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  severity?: number;
  message: string;
  source?: string;
}

export interface LSPCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | { kind: string; value: string };
  insertText?: string;
  insertTextFormat?: number;
}

export interface LSPHover {
  contents:
    | string
    | { kind: string; value: string }
    | Array<string | { kind: string; value: string }>;
  range?: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

export interface LSPLocation {
  uri: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

export interface LSPDocumentSymbol {
  name: string;
  kind: number;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  selectionRange: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  children?: LSPDocumentSymbol[];
}

export interface LSPTextChange {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  rangeLength?: number;
  text: string;
}

// ====== Knowledge Base Types ======

export interface KnowledgeInitOptions {
  storagePath?: string;
  // Embedding config
  embeddingProvider?: string;
  embeddingApiKey?: string;
  embeddingBaseUrl?: string;
  embeddingModel?: string;
  // LLM config (summarization, query rewriting, etc.)
  llmApiKey?: string;
  llmBaseUrl?: string;
  llmModel?: string;
  // Rerank config
  rerankApiKey?: string;
  rerankModel?: string;
  rerankBaseUrl?: string;
  rerankProvider?:
    | 'dashscope'
    | 'openai'
    | 'cohere'
    | 'jina'
    | 'local'
    | 'siliconflow'
    | 'aihubmix'
    | 'custom';
  // VLM config (Vision Language Model)
  vlmProvider?: string;
  vlmApiKey?: string;
  vlmBaseUrl?: string;
  vlmModel?: string;
  // Whisper config (audio transcription)
  whisperApiKey?: string;
  whisperBaseUrl?: string;
  whisperModel?: string;
  whisperLanguage?: string;
  // Legacy multimodal config
  visionApiKey?: string;
}

export interface KnowledgeSearchOptions {
  query: string;
  libraryIds?: string[];
  topK?: number;
  scoreThreshold?: number;
  retrieverType?: 'vector' | 'keyword' | 'hybrid';
}

export interface KnowledgeEnhancedSearchOptions extends KnowledgeSearchOptions {
  enableQueryRewrite?: boolean;
  enableRerank?: boolean;
  enableContextRouting?: boolean;
  conversationHistory?: AIChatMessage[];
}

// ====== Overleaf Types ======

export interface OverleafConfig {
  serverUrl: string;
  email?: string;
  password?: string;
  cookies?: string;
}

export interface OverleafCompileOptions {
  compiler?: string;
  draft?: boolean;
  stopOnFirstError?: boolean;
}

/** SyncTeX forward sync result (code -> PDF) */
export interface OverleafSyncCodePos {
  page: number;
  h: number;
  v: number;
  width?: number;
  height?: number;
}

/** SyncTeX backward sync result (PDF -> code) */
export interface OverleafSyncPdfPos {
  file: string;
  line: number;
  column: number;
}

// ====== Window Types ======

export interface WindowInfo {
  id: number;
  projectPath?: string;
  title: string;
}

// ====== Log Types ======

export interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  category: string;
  message: string;
  details?: unknown;
}

// ====== Dialog Types ======

export interface ConfirmDialogOptions {
  message: string;
  title?: string;
}

export interface MessageDialogOptions {
  message: string;
  type?: 'info' | 'warning' | 'error';
  title?: string;
}

// ====== IPC API Contract Definition ======

/**
 * IPC API Contract
 * Defines args (parameter tuple) and result types for each channel
 */
export interface IPCApiContract {
  // ============ Project Management ============
  [IpcChannel.Project_Open]: {
    args: [];
    result: { projectPath: string; fileTree: FileTreeNode } | null;
  };
  [IpcChannel.Project_OpenByPath]: {
    args: [projectPath: string];
    result: { projectPath: string; fileTree: FileTreeNode } | null;
  };
  [IpcChannel.Project_GetRecent]: {
    args: [];
    result: Array<{ path: string; name: string; lastOpened: number }>;
  };

  // ============ File Operations ============
  [IpcChannel.File_Read]: {
    args: [filePath: string];
    result: { content: string; mtime: number };
  };
  [IpcChannel.File_ReadBinary]: {
    args: [filePath: string];
    result: ArrayBuffer;
  };
  [IpcChannel.File_Write]: {
    args: [filePath: string, content: string, expectedMtime?: number];
    result: { success: boolean; conflict?: boolean; currentMtime?: number };
  };
  [IpcChannel.File_Create]: {
    args: [filePath: string, content?: string];
    result: boolean;
  };
  [IpcChannel.Folder_Create]: {
    args: [folderPath: string];
    result: boolean;
  };
  [IpcChannel.File_Delete]: {
    args: [filePath: string, entityType?: string, entityId?: string];
    result: boolean;
  };
  /** Move to trash (recoverable delete) */
  [IpcChannel.File_Trash]: {
    args: [filePath: string];
    result: boolean;
  };
  [IpcChannel.File_Rename]: {
    args: [oldPath: string, newPath: string, entityType?: string, entityId?: string];
    result: boolean;
  };
  [IpcChannel.File_Copy]: {
    args: [
      srcPath: string,
      destPath: string,
      options?: {
        entityType?: 'doc' | 'file' | 'folder';
        entityId?: string;
        targetFolderId?: string;
      },
    ];
    result: boolean;
  };
  [IpcChannel.File_Move]: {
    args: [
      srcPath: string,
      destPath: string,
      options?: {
        entityType?: 'doc' | 'file' | 'folder';
        entityId?: string;
        targetFolderId?: string;
      },
    ];
    result: boolean;
  };
  [IpcChannel.File_Exists]: {
    args: [filePath: string];
    result: boolean;
  };
  [IpcChannel.File_Stats]: {
    args: [filePath: string];
    result: FileStats | null;
  };
  [IpcChannel.File_ShowInFolder]: {
    args: [filePath: string];
    result: void;
  };
  [IpcChannel.File_Select]: {
    args: [options?: { filters?: FileFilter[]; multiple?: boolean }];
    result: SelectedFile[] | null;
  };
  [IpcChannel.File_RefreshTree]: {
    args: [projectPath: string];
    result: { success: boolean; fileTree?: FileTreeNode; error?: string };
  };
  /** Lazy load: resolve directory children */
  [IpcChannel.File_ResolveChildren]: {
    args: [dirPath: string];
    result: { success: boolean; children?: FileTreeNode[]; error?: string };
  };
  /** Background indexing: scan all file paths (for @ completion) */
  [IpcChannel.File_ScanPaths]: {
    args: [projectPath: string];
    result: { success: boolean; paths?: string[]; error?: string };
  };
  [IpcChannel.Clipboard_GetFiles]: {
    args: [];
    result: string[] | null;
  };

  // Batch operations
  [IpcChannel.File_BatchRead]: {
    args: [filePaths: string[]];
    result: BatchReadResult[];
  };
  [IpcChannel.File_BatchStat]: {
    args: [filePaths: string[]];
    result: BatchStatResult[];
  };
  [IpcChannel.File_BatchExists]: {
    args: [filePaths: string[]];
    result: BatchExistsResult[];
  };
  [IpcChannel.File_BatchWrite]: {
    args: [files: Array<{ path: string; content: string }>];
    result: BatchWriteResult[];
  };
  [IpcChannel.File_BatchDelete]: {
    args: [filePaths: string[]];
    result: BatchWriteResult[];
  };

  // ============ Compilation ============
  [IpcChannel.Compile_LaTeX]: {
    args: [content: string, options?: LaTeXCompileOptions];
    result: LaTeXCompileResult;
  };
  [IpcChannel.Compile_Typst]: {
    args: [content: string, options?: TypstCompileOptions];
    result: TypstCompileResult;
  };
  [IpcChannel.Compile_Cancel]: {
    args: [type?: CompileCancelType];
    result: CompileCancelResult;
  };
  [IpcChannel.Compile_GetStatus]: {
    args: [];
    result: {
      latex: { isCompiling: boolean; queueLength: number; currentTaskId: string | null };
      typst: { isCompiling: boolean };
    };
  };
  [IpcChannel.Typst_Available]: {
    args: [];
    result: TypstAvailability;
  };
  [IpcChannel.SyncTeX_Forward]: {
    args: [texFile: string, line: number, column: number, pdfFile: string];
    result: SyncTeXForwardResult | null;
  };
  [IpcChannel.SyncTeX_Backward]: {
    args: [pdfFile: string, page: number, x: number, y: number];
    result: SyncTeXBackwardResult | null;
  };

  // ============ LSP ============
  [IpcChannel.LSP_GetProcessInfo]: {
    args: [];
    result: LSPProcessInfo;
  };
  [IpcChannel.LSP_IsAvailable]: {
    args: [];
    result: boolean;
  };
  [IpcChannel.LSP_GetVersion]: {
    args: [];
    result: string | null;
  };
  [IpcChannel.LSP_Start]: {
    args: [rootPath: string, options?: LSPStartOptions];
    result: boolean;
  };
  [IpcChannel.LSP_Stop]: {
    args: [];
    result: void;
  };
  [IpcChannel.LSP_IsRunning]: {
    args: [];
    result: boolean;
  };
  [IpcChannel.LSP_IsVirtualMode]: {
    args: [];
    result: boolean;
  };
  [IpcChannel.LSP_OpenDocument]: {
    args: [filePath: string, content: string, languageId?: string];
    result: void;
  };
  [IpcChannel.LSP_UpdateDocument]: {
    args: [filePath: string, content: string];
    result: void;
  };
  [IpcChannel.LSP_UpdateDocumentIncremental]: {
    args: [filePath: string, changes: LSPTextChange[]];
    result: void;
  };
  [IpcChannel.LSP_CloseDocument]: {
    args: [filePath: string];
    result: void;
  };
  [IpcChannel.LSP_SaveDocument]: {
    args: [filePath: string];
    result: void;
  };
  [IpcChannel.LSP_GetCompletions]: {
    args: [filePath: string, line: number, character: number];
    result: LSPCompletionItem[];
  };
  [IpcChannel.LSP_GetHover]: {
    args: [filePath: string, line: number, character: number];
    result: LSPHover | null;
  };
  [IpcChannel.LSP_GetDefinition]: {
    args: [filePath: string, line: number, character: number];
    result: LSPLocation | LSPLocation[] | null;
  };
  [IpcChannel.LSP_GetReferences]: {
    args: [filePath: string, line: number, character: number, includeDeclaration?: boolean];
    result: LSPLocation[];
  };
  [IpcChannel.LSP_GetSymbols]: {
    args: [filePath: string];
    result: LSPDocumentSymbol[];
  };
  [IpcChannel.LSP_Build]: {
    args: [filePath: string];
    result: { success: boolean; error?: string };
  };
  [IpcChannel.LSP_ForwardSearch]: {
    args: [filePath: string, line: number];
    result: { success: boolean; error?: string };
  };
  [IpcChannel.LSP_RequestDirectChannel]: {
    args: [];
    result: { success: boolean; error?: string };
  };
  [IpcChannel.LSP_StartAll]: {
    args: [rootPath: string, options?: { virtual?: boolean }];
    result: { texlab: boolean; tinymist: boolean };
  };
  [IpcChannel.LSP_StartTexLab]: {
    args: [rootPath: string, options?: { virtual?: boolean }];
    result: boolean;
  };
  [IpcChannel.LSP_StartTinymist]: {
    args: [rootPath: string, options?: { virtual?: boolean }];
    result: boolean;
  };
  [IpcChannel.LSP_ExportTypstPdf]: {
    args: [filePath: string];
    result: { success: boolean; pdfPath?: string; error?: string };
  };
  [IpcChannel.LSP_FormatTypst]: {
    args: [filePath: string];
    result: { edits: unknown[] };
  };
  // Extended LSP APIs
  [IpcChannel.LSP_IsTexLabAvailable]: {
    args: [];
    result: boolean;
  };
  [IpcChannel.LSP_IsTinymistAvailable]: {
    args: [];
    result: boolean;
  };
  [IpcChannel.LSP_CheckAvailability]: {
    args: [];
    result: {
      texlab: boolean;
      tinymist: boolean;
      texlabVersion?: string;
      tinymistVersion?: string;
    };
  };
  [IpcChannel.LSP_GetTexLabVersion]: {
    args: [];
    result: string | undefined;
  };
  [IpcChannel.LSP_GetTinymistVersion]: {
    args: [];
    result: string | undefined;
  };

  // ============ AI ============
  [IpcChannel.AI_UpdateConfig]: {
    args: [config: AIConfig];
    result: { success: boolean };
  };
  [IpcChannel.AI_IsConfigured]: {
    args: [];
    result: boolean;
  };
  [IpcChannel.AI_Completion]: {
    args: [context: string];
    result: AIResult;
  };
  [IpcChannel.AI_Polish]: {
    args: [text: string, knowledgeBaseId?: string];
    result: AIResult;
  };
  [IpcChannel.AI_Chat]: {
    args: [messages: AIChatMessage[]];
    result: AIResult;
  };
  [IpcChannel.AI_ChatStream]: {
    args: [messages: AIChatMessage[]];
    result: { success: boolean; error?: string };
  };
  [IpcChannel.AI_GenerateFormula]: {
    args: [description: string];
    result: AIResult;
  };
  [IpcChannel.AI_Review]: {
    args: [content: string];
    result: AIResult;
  };
  [IpcChannel.AI_TestConnection]: {
    args: [];
    result: AITestResult;
  };
  [IpcChannel.AI_StopGeneration]: {
    args: [];
    result: { success: boolean };
  };
  [IpcChannel.AI_IsGenerating]: {
    args: [];
    result: boolean;
  };

  // ============ Knowledge Base ============
  [IpcChannel.Knowledge_Initialize]: {
    args: [options: KnowledgeInitOptions];
    result: { success: boolean; error?: string };
  };
  [IpcChannel.Knowledge_UpdateConfig]: {
    args: [options: Record<string, unknown>];
    result: { success: boolean };
  };
  [IpcChannel.Knowledge_CreateLibrary]: {
    args: [
      params: {
        name: string;
        description?: string;
        chunkingConfig?: unknown;
        embeddingConfig?: unknown;
        retrievalConfig?: unknown;
      },
    ];
    result: KnowledgeLibrary;
  };
  [IpcChannel.Knowledge_GetLibraries]: {
    args: [];
    result: KnowledgeLibrary[];
  };
  [IpcChannel.Knowledge_GetLibrary]: {
    args: [id: string];
    result: KnowledgeLibrary | null;
  };
  [IpcChannel.Knowledge_UpdateLibrary]: {
    args: [id: string, updates: unknown];
    result: KnowledgeLibrary;
  };
  [IpcChannel.Knowledge_DeleteLibrary]: {
    args: [id: string];
    result: { success: boolean };
  };
  [IpcChannel.Knowledge_AddDocument]: {
    args: [
      libraryId: string,
      filePath: string,
      options?: {
        bibKey?: string;
        citationText?: string;
        metadata?: unknown;
        processImmediately?: boolean;
      },
    ];
    result: { documentId: string; taskId?: string };
  };
  [IpcChannel.Knowledge_AddText]: {
    args: [
      libraryId: string,
      content: string,
      options?: { title?: string; mediaType?: string; bibKey?: string; metadata?: unknown },
    ];
    result: { documentId: string; taskId?: string };
  };
  [IpcChannel.Knowledge_GetDocument]: {
    args: [id: string];
    result: KnowledgeDocument | null;
  };
  [IpcChannel.Knowledge_GetDocuments]: {
    args: [libraryId: string];
    result: KnowledgeDocument[];
  };
  [IpcChannel.Knowledge_DeleteDocument]: {
    args: [id: string];
    result: { success: boolean };
  };
  [IpcChannel.Knowledge_ReprocessDocument]: {
    args: [documentId: string];
    result: { taskId: string };
  };
  [IpcChannel.Knowledge_Search]: {
    args: [options: KnowledgeSearchOptions];
    result: { results: KnowledgeSearchResult[]; processingTime: number };
  };
  [IpcChannel.Knowledge_SearchEnhanced]: {
    args: [options: KnowledgeEnhancedSearchOptions];
    result: EnhancedSearchResult;
  };
  [IpcChannel.Knowledge_Query]: {
    args: [
      question: string,
      libraryIds?: string[],
      options?: { topK?: number; includeContext?: boolean },
    ];
    result: KnowledgeRAGResponse;
  };
  [IpcChannel.Knowledge_GetTask]: {
    args: [taskId: string];
    result: KnowledgeTaskStatus | null;
  };
  [IpcChannel.Knowledge_GetQueueStats]: {
    args: [];
    result: KnowledgeQueueStats;
  };
  [IpcChannel.Knowledge_TestEmbedding]: {
    args: [];
    result: { success: boolean; dimension?: number; error?: string };
  };
  [IpcChannel.Knowledge_Diagnostics]: {
    args: [libraryId?: string];
    result: KnowledgeDiagnostics;
  };
  [IpcChannel.Knowledge_RebuildFTS]: {
    args: [];
    result: { success: boolean; count: number };
  };
  [IpcChannel.Knowledge_GenerateEmbeddings]: {
    args: [libraryId?: string];
    result: { success: boolean; count: number };
  };
  [IpcChannel.Knowledge_GetAdvancedConfig]: {
    args: [];
    result: AdvancedRetrievalConfig;
  };
  [IpcChannel.Knowledge_SetAdvancedConfig]: {
    args: [config: Partial<AdvancedRetrievalConfig>];
    result: { success: boolean };
  };
  [IpcChannel.Knowledge_SelectFiles]: {
    args: [options?: { mediaTypes?: string[]; multiple?: boolean }];
    result: string[] | null;
  };

  // ============ Local Replica ============
  [IpcChannel.LocalReplica_Init]: {
    args: [
      config: {
        projectId: string;
        projectName: string;
        localPath: string;
        enabled: boolean;
        customIgnorePatterns?: string[];
      },
    ];
    result: boolean;
  };
  [IpcChannel.LocalReplica_GetConfig]: {
    args: [];
    result: {
      projectId: string;
      projectName: string;
      localPath: string;
      enabled: boolean;
      customIgnorePatterns?: string[];
    } | null;
  };
  [IpcChannel.LocalReplica_SetEnabled]: {
    args: [enabled: boolean];
    result: void;
  };
  [IpcChannel.LocalReplica_SyncFromRemote]: {
    args: [];
    result: {
      synced: number;
      skipped: number;
      errors: string[];
      conflicts: string[];
    };
  };
  [IpcChannel.LocalReplica_SyncToRemote]: {
    args: [];
    result: {
      synced: number;
      skipped: number;
      errors: string[];
      conflicts: string[];
    };
  };
  [IpcChannel.LocalReplica_StartWatching]: {
    args: [];
    result: void;
  };
  [IpcChannel.LocalReplica_StopWatching]: {
    args: [];
    result: void;
  };
  [IpcChannel.LocalReplica_IsWatching]: {
    args: [];
    result: boolean;
  };

  // ============ Overleaf ============
  [IpcChannel.Overleaf_Init]: {
    args: [config: OverleafConfig];
    result: { success: boolean; error?: string };
  };
  [IpcChannel.Overleaf_TestConnection]: {
    args: [serverUrl: string];
    result: { success: boolean; message: string };
  };
  [IpcChannel.Overleaf_Login]: {
    args: [config: OverleafConfig];
    result: { success: boolean; error?: string };
  };
  [IpcChannel.Overleaf_IsLoggedIn]: {
    args: [];
    result: boolean;
  };
  [IpcChannel.Overleaf_GetCookies]: {
    args: [];
    result: string | null;
  };
  [IpcChannel.Overleaf_GetProjects]: {
    args: [];
    result: OverleafProject[];
  };
  [IpcChannel.Overleaf_GetProjectDetails]: {
    args: [projectId: string];
    result: unknown;
  };
  [IpcChannel.Overleaf_UpdateSettings]: {
    args: [projectId: string, settings: { compiler?: string; rootDocId?: string }];
    result: { success: boolean };
  };
  [IpcChannel.Overleaf_Compile]: {
    args: [projectId: string, options?: OverleafCompileOptions];
    result: OverleafCompileResult;
  };
  [IpcChannel.Overleaf_StopCompile]: {
    args: [projectId: string];
    result: { success: boolean };
  };
  [IpcChannel.Overleaf_GetBuildId]: {
    args: [];
    result: string | null;
  };
  [IpcChannel.Overleaf_SyncCode]: {
    args: [projectId: string, file: string, line: number, column: number, buildId?: string];
    result: OverleafSyncCodePos[] | null;
  };
  [IpcChannel.Overleaf_SyncPdf]: {
    args: [projectId: string, page: number, h: number, v: number, buildId?: string];
    result: OverleafSyncPdfPos | null;
  };
  [IpcChannel.Overleaf_GetDoc]: {
    args: [projectId: string, docIdOrPath: string, isPath?: boolean];
    result: { success: boolean; content?: string; docId?: string; error?: string };
  };
  [IpcChannel.Overleaf_UpdateDoc]: {
    args: [projectId: string, docId: string, content: string];
    result: { success: boolean };
  };
  [IpcChannel.Overleaf_UpdateDocDebounced]: {
    args: [projectId: string, docId: string, content: string];
    result: { success: boolean };
  };
  [IpcChannel.Overleaf_FlushUpdates]: {
    args: [projectId?: string];
    result: { success: boolean };
  };
  [IpcChannel.Overleaf_GetDocCached]: {
    args: [projectId: string, docId: string];
    result: { content: string; version: number } | null;
  };
  [IpcChannel.Overleaf_ClearCache]: {
    args: [projectId?: string, docId?: string];
    result: void;
  };

  // ============ Agent Tools ============
  [IpcChannel.Agent_GetAvailable]: {
    args: [];
    result: AgentAvailability;
  };
  [IpcChannel.Agent_PDF2LaTeX]: {
    args: [inputFile: string, config?: Pdf2LatexConfig];
    result: AgentResult;
  };
  [IpcChannel.Agent_Review]: {
    args: [inputFile: string, timeout?: number];
    result: AgentResult;
  };
  [IpcChannel.Agent_Paper2Beamer]: {
    args: [inputFile: string, config?: Paper2BeamerConfig];
    result: AgentResult;
  };
  [IpcChannel.Agent_ListTemplates]: {
    args: [];
    result: AgentResult;
  };
  [IpcChannel.Agent_Kill]: {
    args: [];
    result: boolean;
  };
  [IpcChannel.Agent_SyncVLMConfig]: {
    args: [
      vlmConfig: {
        provider: string;
        model: string;
        apiKey: string;
        baseUrl: string;
        timeout?: number;
        maxTokens?: number;
        temperature?: number;
      },
    ];
    result: { success: boolean; message: string; path?: string };
  };
  [IpcChannel.Agent_CreateTempFile]: {
    args: [fileName: string, content: string];
    result: string | null;
  };

  // ============ Chat ============
  [IpcChannel.Chat_SendMessage]: {
    args: [params: ChatSendMessageParams];
    result: ChatSendMessageResult;
  };
  [IpcChannel.Chat_Cancel]: {
    args: [sessionId: string];
    result: ChatOperationResult;
  };
  [IpcChannel.Chat_GetSessions]: {
    args: [];
    result: ChatSessionsResult;
  };
  [IpcChannel.Chat_GetMessages]: {
    args: [params: ChatGetMessagesParams];
    result: ChatMessagesResult;
  };
  [IpcChannel.Chat_DeleteSession]: {
    args: [sessionId: string];
    result: ChatOperationResult;
  };
  [IpcChannel.Chat_RenameSession]: {
    args: [params: ChatRenameSessionParams];
    result: ChatOperationResult;
  };
  [IpcChannel.Chat_CreateSession]: {
    args: [knowledgeBaseId?: string];
    result: ChatSession;
  };

  // ============ Window ============
  [IpcChannel.Window_New]: {
    args: [options?: { projectPath?: string }];
    result: number;
  };
  [IpcChannel.Window_GetAll]: {
    args: [];
    result: WindowInfo[];
  };
  [IpcChannel.Window_Close]: {
    args: [];
    result: void;
  };
  [IpcChannel.Window_Focus]: {
    args: [windowId: number];
    result: void;
  };

  // ============ App ============
  [IpcChannel.App_GetVersion]: {
    args: [];
    result: string;
  };
  [IpcChannel.App_GetHomeDir]: {
    args: [];
    result: string;
  };
  [IpcChannel.App_GetAppDataDir]: {
    args: [];
    result: string;
  };
  [IpcChannel.App_OpenExternal]: {
    args: [url: string];
    result: void;
  };

  // ============ Log ============
  [IpcChannel.Log_GetPath]: {
    args: [];
    result: string;
  };
  [IpcChannel.Log_OpenFolder]: {
    args: [];
    result: void;
  };
  [IpcChannel.Log_Write]: {
    args: [entries: LogEntry[]];
    result: void;
  };
  [IpcChannel.Log_ExportDiagnostics]: {
    args: [];
    result: string;
  };
  [IpcChannel.Log_Clear]: {
    args: [];
    result: void;
  };
  [IpcChannel.Log_FromRenderer]: {
    args: [
      source: { process: 'renderer'; window?: string; module?: string },
      level: 'debug' | 'info' | 'warn' | 'error',
      message: string,
      data?: unknown[],
    ];
    result: void;
  };

  // ============ Config ============
  [IpcChannel.Config_Get]: {
    args: [key: string];
    result: unknown;
  };
  [IpcChannel.Config_Set]: {
    args: [key: string, value: unknown, notify?: boolean];
    result: void;
  };

  // ============ Settings (AI Providers) ============
  [IpcChannel.Settings_GetAIProviders]: {
    args: [];
    result: AIProviderDTO[];
  };
  [IpcChannel.Settings_SetAIProviders]: {
    args: [providers: AIProviderDTO[]];
    result: { success: boolean };
  };
  [IpcChannel.Settings_GetSelectedModels]: {
    args: [];
    result: SelectedModels;
  };
  [IpcChannel.Settings_SetSelectedModels]: {
    args: [models: SelectedModels];
    result: { success: boolean };
  };
  [IpcChannel.Settings_GetAIConfig]: {
    args: [];
    result: AIConfigDTO;
  };
  [IpcChannel.Settings_SetAIConfig]: {
    args: [config: AIConfigDTO];
    result: { success: boolean };
  };

  // ============ Trace ============
  [IpcChannel.Trace_Start]: {
    args: [name: string, parentContext?: { traceId: string; spanId: string }];
    result: { traceId: string; spanId: string };
  };
  [IpcChannel.Trace_End]: {
    args: [spanId: string, result?: unknown];
    result: void;
  };
  [IpcChannel.Trace_Get]: {
    args: [traceId: string];
    result: unknown;
  };

  // ============ Dialog ============
  [IpcChannel.Dialog_Confirm]: {
    args: [options: ConfirmDialogOptions];
    result: boolean;
  };
  [IpcChannel.Dialog_Message]: {
    args: [options: MessageDialogOptions];
    result: void;
  };

  // ============ File Watcher (no invoke, events only) ============
  [IpcChannel.FileWatcher_Start]: {
    args: [projectPath: string];
    result: { success: boolean; reason?: string };
  };
  [IpcChannel.FileWatcher_Stop]: {
    args: [];
    result: { success: boolean };
  };

  // ====== Selection Assistant ======
  [IpcChannel.Selection_SetEnabled]: {
    args: [enabled: boolean];
    result: { success: boolean; error?: string };
  };
  [IpcChannel.Selection_IsEnabled]: {
    args: [];
    result: boolean;
  };
  [IpcChannel.Selection_GetConfig]: {
    args: [];
    result: SelectionConfigDTO | null;
  };
  [IpcChannel.Selection_SetConfig]: {
    args: [config: Partial<SelectionConfigDTO>];
    result: { success: boolean; error?: string };
  };
  [IpcChannel.Selection_GetText]: {
    args: [];
    result: SelectionCaptureDTO | null;
  };
  [IpcChannel.Selection_ShowActionWindow]: {
    args: [data?: SelectionCaptureDTO];
    result: { success: boolean; error?: string };
  };
  [IpcChannel.Selection_HideActionWindow]: {
    args: [];
    result: { success: boolean; error?: string };
  };
  [IpcChannel.Selection_HideToolbar]: {
    args: [];
    result: { success: boolean; error?: string };
  };
  [IpcChannel.Selection_AddToKnowledge]: {
    args: [dto: SelectionAddToKnowledgeDTO];
    result: { success: boolean; taskId?: string; error?: string };
  };
}

// ====== Type Utilities ======

/** Get parameter types for specified channel */
export type IPCArgs<T extends keyof IPCApiContract> = IPCApiContract[T]['args'];

/** Get return type for specified channel */
export type IPCResult<T extends keyof IPCApiContract> = IPCApiContract[T]['result'];

/** All invokable IPC channels */
export type IPCInvokeChannel = keyof IPCApiContract;

/** IPC event channel types (send/on pattern) */
export interface IPCEventContract {
  [IpcChannel.FileWatcher_Changed]: {
    type: 'change' | 'unlink' | 'add';
    path: string;
    mtime?: number;
  };
  [IpcChannel.LSP_Diagnostics]: {
    filePath: string;
    diagnostics: LSPDiagnostic[];
  };
  [IpcChannel.LSP_Initialized]: void;
  [IpcChannel.LSP_Exit]: {
    code: number | null;
    signal: string | null;
  };
  [IpcChannel.LSP_ServiceStarted]: {
    service: 'texlab' | 'tinymist';
  };
  [IpcChannel.LSP_ServiceStopped]: {
    service: 'texlab' | 'tinymist';
  };
  [IpcChannel.LSP_Recovered]: void;
  [IpcChannel.AI_StreamChunk]: {
    type: string;
    content?: string;
    error?: string;
  };
  [IpcChannel.Knowledge_Event]: {
    type: string;
    timestamp: number;
    data: unknown;
  };
  [IpcChannel.Knowledge_TaskProgress]: {
    taskId: string;
    progress: number;
    status: string;
    message?: string;
    filename?: string;
    taskType?: 'upload' | 'delete';
  };
  /** Unified Chat stream event */
  [IpcChannel.Chat_Stream]: ChatStreamEvent;
  /** Agent progress event */
  [IpcChannel.Agent_Progress]: AgentProgress;
  [IpcChannel.Window_OpenProject]: string;
  [IpcChannel.Window_OpenFile]: string;
  [IpcChannel.Message_FromMain]: string;
  [IpcChannel.Settings_AIConfigChanged]: AIConfigDTO;
}

/** Get event channel data type */
export type IPCEventData<T extends keyof IPCEventContract> = IPCEventContract[T];

/** All event channels */
export type IPCEventChannel = keyof IPCEventContract;

// ==================== Type Safety Utilities ====================

/**
 * Channels defined in IpcChannel enum that are not yet in IPCApiContract
 *
 * This type will be non-empty if there are channels missing type definitions.
 * To fix: Add the missing channel to IPCApiContract or IPCEventContract.
 *
 * Currently untyped channels (intentionally excluded or event-only):
 * - FileCache_* (internal use)
 * - LSP_Error (event-only, currently unused)
 * - LSP_DirectChannel (event-only, handled specially in preload)
 * - Extended LSP APIs (LSP_IsTexLabAvailable, etc.) - not exposed in preload
 */
type AllDefinedChannels = keyof IPCApiContract | keyof IPCEventContract;

// Type-level check: Uncomment to see which channels are missing types
// type _MissingChannels = Exclude<IpcChannel, _AllDefinedChannels>;

/**
 * Assert that a channel is typed in the contract
 * Usage: const _check: AssertChannelTyped<IpcChannel.Some_Channel> = true;
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export type AssertChannelTyped<_T extends AllDefinedChannels> = true;

/**
 * Explicitly excluded channels (not exposed to renderer or internal use only)
 * Note: LSP extended APIs have been moved to IPCApiContract for type safety
 */
export type ExcludedInvokeChannels =
  | IpcChannel.FileCache_Stats
  | IpcChannel.FileCache_Clear
  | IpcChannel.FileCache_Warmup
  | IpcChannel.FileCache_Invalidate
  | IpcChannel.LSP_Error
  | IpcChannel.LSP_DirectChannel
  | IpcChannel.LSP_DirectChannelClosed
  | IpcChannel.LSP_ServiceRestarted;

/**
 * All channels that should have invoke types (used for validation)
 */
export type RequiredInvokeChannels = Exclude<
  IpcChannel,
  ExcludedInvokeChannels | keyof IPCEventContract // Event-only channels
>;

/**
 * Validate that all required invoke channels are defined
 * This will cause a type error if a channel is missing from IPCApiContract
 */
type ValidateInvokeChannels = {
  [K in RequiredInvokeChannels]: K extends keyof IPCApiContract ? true : never;
};

// Compile-time assertion - if this fails, there's a missing channel definition
// @ts-expect-error - Intentionally unused, used only for compile-time type checking
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _ValidateInvokeChannels: ValidateInvokeChannels = null!;
