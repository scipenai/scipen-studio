/// <reference types="vite/client" />

/**
 * SciPen Studio - Renderer Process Type Definitions
 *
 * Import from shared type modules to ensure consistency between main and renderer processes
 */

import type {
  FileTreeNode,
  FileStats,
  SelectedFile,
  FileFilter,
  LaTeXCompileOptions,
  LaTeXCompileResult,
  LaTeXError,
  LaTeXWarning,
  SyncTeXForwardResult,
  SyncTeXBackwardResult,
  KnowledgeBaseInfo,
  OverleafConfig,
  OverleafProject,
  OverleafCompileOptions,
  OverleafCompileResult,
  MediaType,
  ProcessStatus,
  RetrieverType,
  EmbeddingProvider,
  ChunkingConfig,
  EmbeddingConfig,
  RetrievalConfig,
  KnowledgeLibrary,
  KnowledgeDocument,
  ChunkMetadata,
  KnowledgeSearchResult,
  KnowledgeCitation,
  KnowledgeRAGResponse,
  AdvancedRetrievalConfig,
  RewrittenQuery,
  ContextDecision,
  EnhancedSearchResult,
  KnowledgeInitOptions,
  KnowledgeTaskStatus,
  KnowledgeQueueStats,
  KnowledgeDiagnostics,
  KnowledgeEvent,
} from '../shared/ipc/types';

export type {
  FileTreeNode,
  FileStats,
  SelectedFile,
  FileFilter,
  LaTeXCompileOptions,
  LaTeXCompileResult,
  LaTeXError,
  LaTeXWarning,
  SyncTeXForwardResult,
  SyncTeXBackwardResult,
  KnowledgeBaseInfo,
  OverleafConfig,
  OverleafProject,
  OverleafCompileOptions,
  OverleafCompileResult,
  MediaType,
  ProcessStatus,
  RetrieverType,
  EmbeddingProvider,
  ChunkingConfig,
  EmbeddingConfig,
  RetrievalConfig,
  KnowledgeLibrary,
  KnowledgeDocument,
  ChunkMetadata,
  KnowledgeSearchResult,
  KnowledgeCitation,
  KnowledgeRAGResponse,
  AdvancedRetrievalConfig,
  RewrittenQuery,
  ContextDecision,
  EnhancedSearchResult,
  KnowledgeInitOptions,
  KnowledgeTaskStatus,
  KnowledgeQueueStats,
  KnowledgeDiagnostics,
  KnowledgeEvent,
};

// ==================== ElectronAPI Interface Definitions ====================

/**
 * Electron API interface
 * Uses types imported from shared modules
 */
interface ElectronAPI {
  // ============ Project Management ============
  openProject: () => Promise<{ projectPath: string; fileTree: FileTreeNode } | null>;
  getRecentProjects: () => Promise<Array<{
    id: string;
    name: string;
    path: string;
    lastOpened: string;
    isRemote?: boolean;
  }>>;
  openProjectByPath: (path: string) => Promise<{ projectPath: string; fileTree: FileTreeNode } | null>;

  // ============ File Operations ============
  readFile: (filePath: string) => Promise<string>;
  /** Read binary file (efficient transfer for PDF, images, etc.) */
  readFileBinary: (filePath: string) => Promise<ArrayBuffer>;
  writeFile: (filePath: string, content: string) => Promise<void>;
  createFile: (filePath: string, content?: string) => Promise<{ success: boolean; path: string; docId?: string }>;
  createFolder: (folderPath: string) => Promise<{ success: boolean; path: string }>;
  deleteFile: (filePath: string, entityType?: string, entityId?: string) => Promise<{ success: boolean }>;
  renameFile: (oldPath: string, newPath: string, entityType?: string, entityId?: string) => Promise<{ success: boolean; newPath: string }>;
  copyFile: (srcPath: string, destPath: string) => Promise<{ success: boolean; destPath: string }>;
  moveFile: (srcPath: string, destPath: string) => Promise<{ success: boolean; destPath: string }>;
  refreshFileTree: (projectPath: string) => Promise<{ success: boolean; fileTree: FileTreeNode }>;
  pathExists: (filePath: string) => Promise<boolean>;
  getFileStats: (filePath: string) => Promise<FileStats>;
  showItemInFolder: (filePath: string) => Promise<{ success: boolean }>;
  openPath: (filePath: string) => Promise<boolean>;
  selectFiles: (options?: {
    filters?: FileFilter[];
    multiple?: boolean;
  }) => Promise<SelectedFile[] | null>;
  /** Read file paths from system clipboard (for pasting external files) */
  getClipboardFiles: () => Promise<{ success: boolean; files: string[]; message?: string }>;
  /** Get custom protocol URL for local files (for efficient loading of large files like PDF) */
  getLocalFileUrl: (filePath: string) => string;

  // ============ LaTeX Compilation ============
  compileLatex: (content: string, options?: LaTeXCompileOptions) => Promise<LaTeXCompileResult>;

  // ============ Typst Compilation ============
  compileTypst: (content: string, options?: {
    engine?: 'typst' | 'tinymist';
    mainFile?: string;
    projectPath?: string;
  }) => Promise<{
    success: boolean;
    pdfPath?: string;
    pdfData?: string;
    errors?: string[];
    warnings?: string[];
    log?: string;
    time?: number;
  }>;
  getTypstAvailability: () => Promise<{
    tinymist: { available: boolean; version: string | null };
    typst: { available: boolean; version: string | null };
  }>;

  // ============ SyncTeX Bidirectional Sync ============
  synctexForward: (texFile: string, line: number, column: number, pdfFile: string) => Promise<SyncTeXForwardResult | null>;
  synctexBackward: (pdfFile: string, page: number, x: number, y: number) => Promise<SyncTeXBackwardResult | null>;

  // ============ External Links ============
  openExternal: (url: string) => Promise<void>;

  // ============ Application Info ============
  getAppVersion: () => Promise<string>;
  platform: string;
  getHomeDir: () => Promise<string>;
  getAppDataDir: () => Promise<string>;

  // ============ Multi-Window Management ============
  window: {
    newWindow: (options?: { projectPath?: string }) => Promise<{ success: boolean; windowId: number }>;
    getWindows: () => Promise<Array<{ id: number; title: string; focused: boolean }>>;
    closeWindow: () => Promise<{ success: boolean }>;
    focusWindow: (windowId: number) => Promise<{ success: boolean }>;
    onOpenProject: (callback: (projectPath: string) => void) => () => void;
    /** Listen for file association open events (e.g., double-click .tex file) */
    onOpenFile: (callback: (filePath: string) => void) => () => void;
  };

  // ============ Overleaf API ============
  overleaf: {
    // Initialization and authentication
    init: (config: OverleafConfig) => Promise<{ success: boolean }>;
    testConnection: (serverUrl: string) => Promise<{ success: boolean; message: string }>;
    login: (config: OverleafConfig) => Promise<{ success: boolean; message: string; userId?: string }>;
    isLoggedIn: () => Promise<boolean>;
    getCookies: () => Promise<string | null>;
    
    // Project management
    getProjects: () => Promise<{ success: boolean; projects?: OverleafProject[]; message?: string }>;
    getProjectDetails: (projectId: string) => Promise<{ success: boolean; details?: any; error?: string }>;
    updateSettings: (projectId: string, settings: { compiler?: string; rootDocId?: string }) => Promise<{ success: boolean; error?: string }>;
    
    // Compilation
    compile: (projectId: string, options?: OverleafCompileOptions) => Promise<OverleafCompileResult>;
    stopCompile: (projectId: string) => Promise<boolean>;
    getBuildId: () => Promise<string | null>;
    
    // SyncTeX sync
    syncCode: (projectId: string, file: string, line: number, column: number, buildId: string) => Promise<Array<{ page: number; h: number; v: number; width: number; height: number }> | null>;
    syncPdf: (projectId: string, page: number, h: number, v: number, buildId: string) => Promise<Array<{ file: string; line: number; column: number }> | null>;
    
    // Document operations
    getDoc: (projectId: string, docIdOrPath: string, isPath?: boolean) => Promise<{ success: boolean; content?: string; docId?: string; error?: string }>;
    updateDoc: (projectId: string, docId: string, content: string) => Promise<{ success: boolean; error?: string }>;

    // Optimized document operations (debounced + cached)
    updateDocDebounced: (projectId: string, docId: string, content: string) => Promise<{ success: boolean; error?: string }>;
    flushUpdates: (projectId?: string) => Promise<{ success: boolean; error?: string }>;
    getDocCached: (projectId: string, docId: string) => Promise<{ success: boolean; content?: string; fromCache: boolean }>;
    clearCache: (projectId?: string, docId?: string) => Promise<{ success: boolean }>;
  };

  // ============ Multimodal Knowledge Base API (V2) ============
  knowledge: {
    // Initialization
    initialize: (options: KnowledgeInitOptions) => Promise<boolean>;
    updateConfig: (options: Partial<KnowledgeInitOptions>) => Promise<{ success: boolean; error?: string }>;

    // Knowledge base management
    createLibrary: (params: {
      name: string;
      description?: string;
      chunkingConfig?: Partial<ChunkingConfig>;
      embeddingConfig?: Partial<EmbeddingConfig>;
      retrievalConfig?: Partial<RetrievalConfig>;
    }) => Promise<KnowledgeLibrary>;
    getLibraries: () => Promise<KnowledgeLibrary[]>;
    getLibrary: (id: string) => Promise<KnowledgeLibrary | null>;
    updateLibrary: (id: string, updates: Partial<KnowledgeLibrary>) => Promise<boolean>;
    deleteLibrary: (id: string) => Promise<boolean>;

    // Document management
    addDocument: (libraryId: string, filePath: string, options?: {
      bibKey?: string;
      citationText?: string;
      metadata?: Record<string, unknown>;
      processImmediately?: boolean;
    }) => Promise<KnowledgeDocument & { taskId?: string }>;
    addText: (libraryId: string, content: string, options?: {
      title?: string;
      mediaType?: MediaType;
      bibKey?: string;
      metadata?: Record<string, unknown>;
    }) => Promise<KnowledgeDocument & { taskId?: string }>;
    getDocument: (id: string) => Promise<KnowledgeDocument | null>;
    getDocuments: (libraryId: string) => Promise<KnowledgeDocument[]>;
    deleteDocument: (id: string) => Promise<boolean>;
    reprocessDocument: (documentId: string) => Promise<{ success: boolean; taskId?: string }>;

    // Retrieval
    search: (options: {
      query: string;
      libraryIds?: string[];
      topK?: number;
      scoreThreshold?: number;
      retrieverType?: RetrieverType;
    }) => Promise<KnowledgeSearchResult[]>;
    query: (question: string, libraryIds?: string[], options?: {
      topK?: number;
      includeContext?: boolean;
    }) => Promise<KnowledgeRAGResponse>;

    // Task management
    getTask: (taskId: string) => Promise<KnowledgeTaskStatus | undefined>;
    getQueueStats: () => Promise<KnowledgeQueueStats>;

    // Testing
    testEmbedding: () => Promise<{ success: boolean; message: string; dimensions?: number }>;

    // Advanced retrieval configuration
    getAdvancedConfig: () => Promise<AdvancedRetrievalConfig>;
    setAdvancedConfig: (config: Partial<AdvancedRetrievalConfig>) => Promise<{ success: boolean }>;

    // Enhanced search
    searchEnhanced: (options: {
      query: string;
      libraryIds?: string[];
      topK?: number;
      scoreThreshold?: number;
      retrieverType?: RetrieverType;
      enableQueryRewrite?: boolean;
      enableRerank?: boolean;
      enableContextRouting?: boolean;
      conversationHistory?: Array<{ role: string; content: string }>;
    }) => Promise<EnhancedSearchResult>;

    // File selection
    selectFiles: (options?: {
      mediaTypes?: MediaType[];
      multiple?: boolean;
    }) => Promise<string[] | null>;

    // Diagnostics and debugging
    getDiagnostics: (libraryId?: string) => Promise<KnowledgeDiagnostics>;
    rebuildFTSIndex: () => Promise<{ success: boolean; recordCount: number }>;
    generateMissingEmbeddings: (libraryId?: string) => Promise<{ success: boolean; generated: number; errors: number }>;

    // Event listeners
    onEvent: (callback: (event: KnowledgeEvent) => void) => () => void;
    
    // Task progress listener - for upload/delete progress UI
    onTaskProgress: (callback: (event: {
      taskId: string;
      progress: number;
      status: string;
      message?: string;
      filename?: string;
      taskType?: 'upload' | 'delete';
    }) => void) => () => void;
  };

  // ============ AI API (Main Process Secure Calls) ============
  ai: {
    updateConfig: (config: {
      provider: string;
      apiKey: string;
      baseUrl: string;
      model: string;
      temperature: number;
      maxTokens: number;
      completionModel?: string;
      polishModel?: string;
    }) => Promise<{ success: boolean }>;
    isConfigured: () => Promise<boolean>;
    completion: (context: string) => Promise<{ success: boolean; result?: string; error?: string }>;
    polish: (text: string, knowledgeBaseId?: string) => Promise<{ success: boolean; result?: string; error?: string }>;
    chat: (messages: Array<{ role: string; content: string }>) => Promise<{ success: boolean; result?: string; error?: string }>;
    chatStream: (messages: Array<{ role: string; content: string }>) => Promise<{ success: boolean; error?: string }>;
    onStreamChunk: (callback: (chunk: { type: string; content?: string; error?: string }) => void) => () => void;
    generateFormula: (description: string) => Promise<{ success: boolean; result?: string; error?: string }>;
    review: (content: string) => Promise<{ success: boolean; result?: string; error?: string }>;
    testConnection: () => Promise<{ success: boolean; message: string }>;
    stopGeneration: () => Promise<{ success: boolean }>;
    isGenerating: () => Promise<boolean>;
  };

  // ============ Event Listeners ============
  onMessage: (callback: (message: string) => void) => () => void;

  // ============ File Watcher API ============
  fileWatcher: {
    start: (projectPath: string) => Promise<{ success: boolean; reason?: string }>;
    stop: () => Promise<{ success: boolean }>;
    onFileChanged: (callback: (event: {
      type: 'change' | 'unlink' | 'add';
      path: string;
      mtime?: number;
    }) => void) => () => void;
  };

  // ============ Logging System API ============
  log: {
    /** Get log file path */
    getPath: () => Promise<string | null>;
    /** Open log folder */
    openFolder: () => Promise<{ success: boolean; error?: string }>;
    /** Batch write logs to file */
    write: (entries: Array<{
      level: 'debug' | 'info' | 'warn' | 'error';
      category: string;
      message: string;
      details?: unknown;
    }>) => Promise<{ success: boolean }>;
    /** Export diagnostics report */
    exportDiagnostics: () => Promise<{ success: boolean; path?: string; error?: string }>;
    /** Clear log file */
    clear: () => Promise<{ success: boolean; error?: string }>;
  };

  // ============ TexLab LSP API ============
  lsp: {
    /** Get LSP process running mode and status */
    getProcessInfo: () => Promise<{ mode: string; processAlive: boolean; initialized: boolean }>;
    /** Check if texlab is available */
    isAvailable: () => Promise<boolean>;
    /** Get texlab version */
    getVersion: () => Promise<string | null>;
    /** Start LSP server
     * @param rootPath Project root path (local mode) or virtual root identifier (virtual mode)
     * @param options Startup options
     * @param options.virtual Whether virtual mode (for remote projects like Overleaf)
     */
    start: (rootPath: string, options?: { virtual?: boolean }) => Promise<boolean>;
    /** Stop LSP server */
    stop: () => Promise<void>;
    /** Check if running */
    isRunning: () => boolean;
    /** Check if virtual mode */
    isVirtualMode: () => boolean;

    // Document operations
    /** Open document */
    openDocument: (filePath: string, content: string, languageId?: string) => Promise<void>;
    /** Update document content (full) */
    updateDocument: (filePath: string, content: string) => Promise<void>;
    /** Incremental document update (only send changed parts) */
    updateDocumentIncremental: (filePath: string, changes: Array<{
      range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
      rangeLength?: number;
      text: string;
    }>) => Promise<void>;
    /** Close document */
    closeDocument: (filePath: string) => Promise<void>;
    /** Save document */
    saveDocument: (filePath: string) => Promise<void>;

    // Language features
    /** Get completion suggestions */
    getCompletions: (filePath: string, line: number, character: number) => Promise<Array<{
      label: string;
      kind?: number;
      detail?: string;
      documentation?: string | { kind: string; value: string };
      insertText?: string;
      insertTextFormat?: number;
      textEdit?: { range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string };
      sortText?: string;
      filterText?: string;
    }>>;
    /** Get hover information */
    getHover: (filePath: string, line: number, character: number) => Promise<{
      contents: string | { kind: string; value: string } | Array<string | { kind: string; value: string }>;
      range?: { start: { line: number; character: number }; end: { line: number; character: number } };
    } | null>;
    /** Go to definition */
    getDefinition: (filePath: string, line: number, character: number) => Promise<{
      uri: string;
      range: { start: { line: number; character: number }; end: { line: number; character: number } };
    } | Array<{
      uri: string;
      range: { start: { line: number; character: number }; end: { line: number; character: number } };
    }> | null>;
    /** Find references */
    getReferences: (filePath: string, line: number, character: number, includeDeclaration?: boolean) => Promise<Array<{
      uri: string;
      range: { start: { line: number; character: number }; end: { line: number; character: number } };
    }>>;
    /** Get document symbols */
    getDocumentSymbols: (filePath: string) => Promise<Array<{
      name: string;
      detail?: string;
      kind: number;
      range: { start: { line: number; character: number }; end: { line: number; character: number } };
      selectionRange: { start: { line: number; character: number }; end: { line: number; character: number } };
      children?: any[];
    }>>;

    // Build
    /** Build project */
    build: (filePath: string) => Promise<{ status: string }>;
    /** Forward search */
    forwardSearch: (filePath: string, line: number) => Promise<{ status: string }>;

    // Event listeners
    /** Listen for diagnostics events */
    onDiagnostics: (callback: (data: {
      filePath: string;
      diagnostics: Array<{
        range: { start: { line: number; character: number }; end: { line: number; character: number } };
        severity?: number;
        message: string;
        source?: string;
      }>;
    }) => void) => () => void;
    /** Listen for initialization complete event */
    onInitialized: (callback: () => void) => () => void;
    /** Listen for exit event */
    onExit: (callback: (data: { code: number | null; signal: string | null }) => void) => () => void;
    /** Listen for LSP service start event (lazy loading) */
    onServiceStarted: (callback: (data: { service: 'texlab' | 'tinymist' }) => void) => () => void;
    /** Listen for LSP service stop event (auto-sleep) */
    onServiceStopped: (callback: (data: { service: 'texlab' | 'tinymist' }) => void) => () => void;
    /** Listen for LSP service restart event (TexLab/Tinymist individual crash recovery) */
    onServiceRestarted: (
      callback: (data: { service: 'texlab' | 'tinymist' }) => void
    ) => () => void;

    // ============ High-Performance MessagePort Direct Connection API ============
    
    /**
     * Request direct communication channel with LSP process
     * onDirectChannel event will be triggered on success
     */
    requestDirectChannel: () => Promise<{ success: boolean; error?: string }>;
    
    /**
     * Listen for direct channel establishment event
     * Callback receives MessagePort for direct communication with LSP process
     * Note: Type is unknown for preload compatibility, convert to MessagePort when using
     */
    onDirectChannel: (callback: (port: unknown) => void) => () => void;

    /** Listen for MessagePort direct connection close event (can re-request requestDirectChannel) */
    onDirectChannelClosed: (callback: () => void) => () => void;

    /** Listen for LSP process recovery event (auto-restart after crash) */
    onRecovered: (callback: () => void) => () => void;
  };

  // ============ Dialog API ============
  dialog: {
    /**
     * Show confirmation dialog using Electron native dialog (prevents focus loss)
     * @param message Dialog message
     * @param title 对话框标题（可选）
     * @returns 用户是否确认
     */
    confirm: (message: string, title?: string) => Promise<boolean>;
    
    /**
     * Show message dialog
     * @param message Message content
     * @param type 类型：info, warning, error
     * @param title 标题（可选）
     */
    message: (message: string, type?: 'info' | 'warning' | 'error', title?: string) => Promise<void>;
  };
}

declare global {
  interface Window {
    electron?: ElectronAPI;
  }
}

export {};
