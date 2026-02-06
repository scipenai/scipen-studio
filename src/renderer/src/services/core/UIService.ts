/**
 * @file UIService.ts - UI State Service
 * @description Event-driven UI state management, including sidebars, panels, and command palette
 * @depends StorageService, CompileService
 */

import type { AgentToolId } from '../../../../../shared/ipc/types';
import {
  DisposableStore,
  Emitter,
  type Event,
  type IDisposable,
} from '../../../../../shared/utils';
import type { CompilationResult } from '../../types';
import { getStorageService } from '../StorageService';
import { type CompileResult, getCompileServiceAsync } from './CompileService';

// ====== Type Definitions ======

// SidebarTab changed to string to support dynamically registered view IDs
// Built-in view IDs: 'files' | 'knowledge' | 'ai' | 'aiconfig' | 'settings'
export type SidebarTab = string;
export type RightPanelTab = 'preview' | 'review';

export interface CompilationLog {
  id: string;
  type: 'info' | 'warning' | 'error' | 'success';
  message: string;
  timestamp: number;
  details?: string;
}

export interface PdfHighlight {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Compilation error AI analysis request
 */
export interface AskAIAboutErrorRequest {
  /** Error message */
  errorMessage: string;
  /** Detailed content */
  errorContent?: string;
  /** File path */
  file?: string;
  /** Line number */
  line?: number;
  /** Compiler type */
  compilerType: 'LaTeX' | 'Typst';
  /** Source code context (code near error line) */
  sourceContext?: string;
}

/**
 * Agent tool execution state
 */
export interface AgentState {
  /** Whether running */
  isRunning: boolean;
  /** Active tool (for ToolsPanel) */
  activeTool: AgentToolId | null;
  /** Start time */
  startTime: number;
  /** Progress message */
  progress: string;
  /** Status message */
  message: string;
  /** Error information */
  error?: string;
  /** Output result */
  result?: {
    success: boolean;
    outputPath?: string;
    message?: string;
  };
}

// Storage key constants
const STORAGE_KEYS = {
  SIDEBAR_TAB: 'ui.sidebarTab',
  SIDEBAR_COLLAPSED: 'ui.sidebarCollapsed',
  RIGHT_PANEL_TAB: 'ui.rightPanelTab',
  RIGHT_PANEL_COLLAPSED: 'ui.rightPanelCollapsed',
  SIDEBAR_WIDTH: 'ui.sidebarWidth', // Pixel width
  EDITOR_WIDTH: 'ui.editorWidth', // Percentage
};

// ====== UIService Implementation ======

export class UIService implements IDisposable {
  private readonly _disposables = new DisposableStore();
  private readonly _storage = getStorageService();

  // Sidebar state
  private _sidebarTab: SidebarTab = this._storage.getString(
    STORAGE_KEYS.SIDEBAR_TAB,
    'files'
  ) as SidebarTab;
  private _isSidebarCollapsed = this._storage.getBoolean(STORAGE_KEYS.SIDEBAR_COLLAPSED, false);

  // Layout dimensions
  private _sidebarWidth = this._storage.getNumber(STORAGE_KEYS.SIDEBAR_WIDTH, 260);

  // Right panel state
  private _rightPanelTab: RightPanelTab = this._storage.getString(
    STORAGE_KEYS.RIGHT_PANEL_TAB,
    'preview'
  ) as RightPanelTab;
  private _isRightPanelCollapsed = this._storage.getBoolean(
    STORAGE_KEYS.RIGHT_PANEL_COLLAPSED,
    false
  );

  // Command palette
  private _isCommandPaletteOpen = false;

  // Compilation state
  private _isCompiling = false;
  private _compilationResult: CompilationResult | null = null;
  private _pdfPath: string | null = null;
  private _pdfData: ArrayBuffer | null = null;
  private _pdfUrl: string | null = null; // Custom protocol URL for efficient local PDF loading
  private _compilationLogs: CompilationLog[] = [];

  // SyncTeX
  private _synctexPath: string | null = null;
  private _remoteBuildId: string | null = null;
  private _pdfHighlight: PdfHighlight | null = null;

  // Agent state
  private _agentState: AgentState = {
    isRunning: false,
    activeTool: null,
    startTime: 0,
    progress: '',
    message: '',
  };

  // ====== Event Definitions ======

  private readonly _onDidChangeSidebarTab = new Emitter<SidebarTab>();
  readonly onDidChangeSidebarTab: Event<SidebarTab> = this._onDidChangeSidebarTab.event;

  private readonly _onDidChangeSidebarCollapsed = new Emitter<boolean>();
  readonly onDidChangeSidebarCollapsed: Event<boolean> = this._onDidChangeSidebarCollapsed.event;

  private readonly _onDidChangeSidebarWidth = new Emitter<number>();
  readonly onDidChangeSidebarWidth: Event<number> = this._onDidChangeSidebarWidth.event;

  private readonly _onDidChangeRightPanelTab = new Emitter<RightPanelTab>();
  readonly onDidChangeRightPanelTab: Event<RightPanelTab> = this._onDidChangeRightPanelTab.event;

  private readonly _onDidChangeRightPanelCollapsed = new Emitter<boolean>();
  readonly onDidChangeRightPanelCollapsed: Event<boolean> =
    this._onDidChangeRightPanelCollapsed.event;

  private readonly _onDidChangeCommandPalette = new Emitter<boolean>();
  readonly onDidChangeCommandPalette: Event<boolean> = this._onDidChangeCommandPalette.event;

  private readonly _onDidChangeCompiling = new Emitter<boolean>();
  readonly onDidChangeCompiling: Event<boolean> = this._onDidChangeCompiling.event;

  private readonly _onDidChangeCompilationResult = new Emitter<CompilationResult | null>();
  readonly onDidChangeCompilationResult: Event<CompilationResult | null> =
    this._onDidChangeCompilationResult.event;

  private readonly _onDidChangePdf = new Emitter<{
    path: string | null;
    data: ArrayBuffer | null;
  }>();
  readonly onDidChangePdf: Event<{ path: string | null; data: ArrayBuffer | null }> =
    this._onDidChangePdf.event;

  private readonly _onDidAddCompilationLog = new Emitter<CompilationLog>();
  readonly onDidAddCompilationLog: Event<CompilationLog> = this._onDidAddCompilationLog.event;

  private readonly _onDidChangePdfHighlight = new Emitter<PdfHighlight | null>();
  readonly onDidChangePdfHighlight: Event<PdfHighlight | null> =
    this._onDidChangePdfHighlight.event;

  private readonly _onDidRequestAIErrorAnalysis = new Emitter<AskAIAboutErrorRequest>();
  readonly onDidRequestAIErrorAnalysis: Event<AskAIAboutErrorRequest> =
    this._onDidRequestAIErrorAnalysis.event;

  private readonly _onDidChangeAgentState = new Emitter<AgentState>();
  readonly onDidChangeAgentState: Event<AgentState> = this._onDidChangeAgentState.event;

  constructor() {
    this._disposables.add(this._onDidChangeSidebarTab);
    this._disposables.add(this._onDidChangeSidebarCollapsed);
    this._disposables.add(this._onDidChangeRightPanelTab);
    this._disposables.add(this._onDidChangeRightPanelCollapsed);
    this._disposables.add(this._onDidChangeCommandPalette);
    this._disposables.add(this._onDidChangeCompiling);
    this._disposables.add(this._onDidChangeCompilationResult);
    this._disposables.add(this._onDidChangePdf);
    this._disposables.add(this._onDidAddCompilationLog);
    this._disposables.add(this._onDidChangePdfHighlight);
    this._disposables.add(this._onDidRequestAIErrorAnalysis);
    this._disposables.add(this._onDidChangeAgentState);

    this._bindCompileService();

    // Bind editor service events to clear compilation results when switching files
    this._bindEditorService();
  }

  /**
   * Bind editor service events
   * Listen for active tab changes and clear old compilation results
   * Uses async import to avoid circular dependency
   */
  private _bindEditorService(): void {
    // Use dynamic import to avoid circular dependency
    import('./ServiceRegistry')
      .then(({ getEditorService }) => {
        const editorService = getEditorService();

        // Clear compilation results and PDF data when active tab changes
        // Ensures preview panel shows current file's compilation state, not old file's
        this._disposables.add(
          editorService.onDidChangeActiveTab(() => {
            // Clear old compilation results to avoid showing other files' error messages
            this.setCompilationResult(null);
          })
        );
      })
      .catch((err) => {
        console.warn('[UIService] Failed to bind EditorService events:', err);
      });
  }

  /**
   * Bind compilation service events
   * Listen for compilation start, finish, and logs to update UI state
   * Uses async import to avoid circular dependency
   */
  private _bindCompileService(): void {
    // Get CompileService asynchronously to avoid using require at module load time
    getCompileServiceAsync()
      .then((compileService) => {
        // Note: No longer auto-clearing logs, preserving history (consistent with VS Code behavior)
        this._disposables.add(
          compileService.onDidStartCompile(() => {
            this.setCompilationResult(null); // Clear old results to avoid PDF preview showing old errors
            this.setPdfData(null); // Clear preview at compilation start to avoid confusion
            this.setCompiling(true);
          })
        );

        this._disposables.add(
          compileService.onDidFinishCompile((result: CompileResult) => {
            // Note: PDF data is actually processed in EditorPane.handleCompileResult(),
            // here we only store compilation metadata
            const compilationResult: CompilationResult = {
              success: result.success,
              pdfPath: result.pdfPath,
              // pdfData is set separately by EditorPane via setPdfData()
              pdfData:
                result.pdfBuffer instanceof ArrayBuffer
                  ? result.pdfBuffer
                  : result.pdfBuffer instanceof Uint8Array
                    ? (result.pdfBuffer.slice().buffer as ArrayBuffer)
                    : undefined,
              synctexPath: result.synctexPath,
              errors: result.errors,
              warnings: result.warnings,
              log: result.log,
              time: result.time,
              parsedErrors: result.parsedErrors,
              parsedWarnings: result.parsedWarnings,
              parsedInfo: result.parsedInfo,
            };
            this.setCompilationResult(compilationResult);
            this.setCompiling(false);
          })
        );

        this._disposables.add(
          compileService.onDidLog((log) => {
            this.addCompilationLog({
              type: log.type,
              message: log.message,
              details: log.details,
            });
          })
        );
      })
      .catch((err) => {
        console.warn('[UIService] Failed to bind CompileService events:', err);
      });
  }

  // ============ Getters ============

  get sidebarTab(): SidebarTab {
    return this._sidebarTab;
  }
  get isSidebarCollapsed(): boolean {
    return this._isSidebarCollapsed;
  }
  get sidebarWidth(): number {
    return this._sidebarWidth;
  }
  get rightPanelTab(): RightPanelTab {
    return this._rightPanelTab;
  }
  get isRightPanelCollapsed(): boolean {
    return this._isRightPanelCollapsed;
  }
  get isCommandPaletteOpen(): boolean {
    return this._isCommandPaletteOpen;
  }
  get isCompiling(): boolean {
    return this._isCompiling;
  }
  get compilationResult(): CompilationResult | null {
    return this._compilationResult;
  }
  get pdfPath(): string | null {
    return this._pdfPath;
  }
  get pdfData(): ArrayBuffer | null {
    return this._pdfData;
  }
  get compilationLogs(): CompilationLog[] {
    return this._compilationLogs;
  }
  get synctexPath(): string | null {
    return this._synctexPath;
  }
  get remoteBuildId(): string | null {
    return this._remoteBuildId;
  }
  get pdfHighlight(): PdfHighlight | null {
    return this._pdfHighlight;
  }
  // ============ Sidebar Operations ============

  setSidebarTab(tab: SidebarTab): void {
    if (this._sidebarTab === tab) return;
    this._sidebarTab = tab;
    this._storage.store(STORAGE_KEYS.SIDEBAR_TAB, tab);
    this._onDidChangeSidebarTab.fire(tab);

    // Auto-expand sidebar when switching tabs
    if (this._isSidebarCollapsed) {
      this.setSidebarCollapsed(false);
    }
  }

  setSidebarCollapsed(collapsed: boolean): void {
    if (this._isSidebarCollapsed === collapsed) return;
    this._isSidebarCollapsed = collapsed;
    this._storage.store(STORAGE_KEYS.SIDEBAR_COLLAPSED, collapsed);
    this._onDidChangeSidebarCollapsed.fire(collapsed);
  }

  setSidebarWidth(width: number): void {
    if (this._sidebarWidth === width) return;
    this._sidebarWidth = width;
    this._storage.store(STORAGE_KEYS.SIDEBAR_WIDTH, width);
    this._onDidChangeSidebarWidth.fire(width);
  }

  // ====== Right Panel Operations ======

  setRightPanelTab(tab: RightPanelTab): void {
    if (this._rightPanelTab === tab) return;
    this._rightPanelTab = tab;
    this._storage.store(STORAGE_KEYS.RIGHT_PANEL_TAB, tab);
    this._onDidChangeRightPanelTab.fire(tab);

    if (this._isRightPanelCollapsed) {
      this.setRightPanelCollapsed(false);
    }
  }

  setRightPanelCollapsed(collapsed: boolean): void {
    if (this._isRightPanelCollapsed === collapsed) return;
    this._isRightPanelCollapsed = collapsed;
    this._storage.store(STORAGE_KEYS.RIGHT_PANEL_COLLAPSED, collapsed);
    this._onDidChangeRightPanelCollapsed.fire(collapsed);
  }

  // ====== Command Palette ======

  setCommandPaletteOpen(open: boolean): void {
    if (this._isCommandPaletteOpen === open) return;
    this._isCommandPaletteOpen = open;
    this._onDidChangeCommandPalette.fire(open);
  }

  // ====== Compilation Operations ======

  setCompiling(compiling: boolean): void {
    if (this._isCompiling === compiling) return;
    this._isCompiling = compiling;
    this._onDidChangeCompiling.fire(compiling);
  }

  setCompilationResult(result: CompilationResult | null): void {
    this._compilationResult = result;
    this._onDidChangeCompilationResult.fire(result);
  }

  setPdfPath(path: string | null): void {
    this._pdfPath = path;
    this._onDidChangePdf.fire({ path, data: this._pdfData });
  }

  setPdfData(data: ArrayBuffer | null): void {
    this._pdfData = data;
    this._onDidChangePdf.fire({ path: this._pdfPath, data });
  }

  /**
   * Set PDF custom protocol URL (for efficient local PDF loading, avoid IPC transfer)
   */
  setPdfUrl(url: string | null): void {
    this._pdfUrl = url;
    this._onDidChangePdf.fire({ path: this._pdfPath, data: this._pdfData });
  }

  get pdfUrl(): string | null {
    return this._pdfUrl;
  }

  // ====== Compilation Logs ======

  private _generateLogId(): string {
    return `log-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  addCompilationLog(log: Omit<CompilationLog, 'id' | 'timestamp'>): void {
    const newLog: CompilationLog = {
      ...log,
      id: this._generateLogId(),
      timestamp: Date.now(),
    };
    // Create new array to trigger React re-render (useSyncExternalStore uses reference comparison)
    this._compilationLogs = [...this._compilationLogs, newLog];
    // Limit log count
    if (this._compilationLogs.length > 500) {
      this._compilationLogs = this._compilationLogs.slice(-500);
    }
    this._onDidAddCompilationLog.fire(newLog);
  }

  clearCompilationLogs(): void {
    this._compilationLogs = [];
  }

  // ============ SyncTeX ============

  setSynctexPath(path: string | null): void {
    this._synctexPath = path;
  }

  setRemoteBuildId(buildId: string | null): void {
    this._remoteBuildId = buildId;
  }

  setPdfHighlight(highlight: PdfHighlight | null): void {
    this._pdfHighlight = highlight;
    this._onDidChangePdfHighlight.fire(highlight);
  }

  // ====== Agent State ======

  get agentState(): AgentState {
    return this._agentState;
  }

  setAgentState(state: Partial<AgentState>): void {
    this._agentState = { ...this._agentState, ...state };
    this._onDidChangeAgentState.fire(this._agentState);
  }

  resetAgentState(): void {
    this._agentState = {
      isRunning: false,
      activeTool: null,
      startTime: 0,
      progress: '',
      message: '',
    };
    this._onDidChangeAgentState.fire(this._agentState);
  }

  // ====== AI Error Analysis ======

  /**
   * Request AI analysis of compilation error
   * Automatically switches to AI chat panel and pre-fills prompt
   */
  requestAIErrorAnalysis(request: AskAIAboutErrorRequest): void {
    this.setSidebarTab('ai');
    this._onDidRequestAIErrorAnalysis.fire(request);
  }

  // ====== Lifecycle ======

  dispose(): void {
    this._compilationLogs = [];
    this._pdfData = null;
    this._disposables.dispose();
  }
}
