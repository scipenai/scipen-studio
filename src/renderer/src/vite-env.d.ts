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
  OverleafConfig,
  OverleafProjectDTO,
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
  OverleafConfig,
  OverleafProjectDTO,
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
  readFile: (filePath: string) => Promise<{ content: string; mtime: number }>;
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

  // ============ Auto Update ============
  checkUpdate: () => Promise<import('../../../../shared/ipc/app-contract').UpdateStatus>;
  downloadUpdate: () => Promise<void>;
  installUpdate: () => Promise<void>;
  onUpdateStatus: (callback: (status: import('../../../../shared/ipc/app-contract').UpdateStatus) => void) => () => void;

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
    getProjects: () => Promise<{ success: boolean; projects?: OverleafProjectDTO[]; message?: string }>;
    getProjectDetails: (projectId: string) => Promise<{ success: boolean; details?: any; error?: string }>;
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
    }) => Promise<{ success: boolean }>;
    isConfigured: () => Promise<boolean>;
    completion: (context: string) => Promise<{ success: boolean; result?: string; error?: string }>;
    chatStream: (messages: Array<{ role: string; content: string }>) => Promise<{ success: boolean; error?: string }>;
    onStreamChunk: (callback: (chunk: { type: string; content?: string; error?: string }) => void) => () => void;
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
     * @param rootPath Project root path
     * @param options Startup options
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
    /** Get semantic tokens */
    getSemanticTokens: (filePath: string) => Promise<{
      resultId?: string | null;
      data: number[];
      legend: { tokenTypes: string[]; tokenModifiers: string[] };
    } | null>;

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
    onServiceStarted: (callback: (data: { service: 'texlab' | 'tinymist' | 'marksman' }) => void) => () => void;
    /** Listen for LSP service stop event (auto-sleep) */
    onServiceStopped: (callback: (data: { service: 'texlab' | 'tinymist' | 'marksman' }) => void) => () => void;
    /** Listen for LSP service restart event (TexLab/Tinymist/Marksman individual crash recovery) */
    onServiceRestarted: (
      callback: (data: { service: 'texlab' | 'tinymist' | 'marksman' }) => void
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
     * @param title Dialog title (optional)
     * @returns Whether the user confirmed
     */
    confirm: (message: string, title?: string) => Promise<boolean>;

    /**
     * Show message dialog
     * @param message Message content
     * @param type Type: info, warning, error
     * @param title Title (optional)
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
