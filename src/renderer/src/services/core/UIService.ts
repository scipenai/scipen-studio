/**
 * @file UIService.ts - UI State Service
 * @description Event-driven UI state management, including sidebars, panels, and command palette
 * @depends StorageService, CompileService
 */

import {
  DisposableStore,
  Emitter,
  type Event,
  type IDisposable,
} from '../../../../../shared/utils';
import type { CompilationResult, FilePdfPreviewState, ParsedLogEntry } from '../../types';
import { getStorageService } from '../StorageService';
import { type CompileResult, getCompileServiceAsync } from './CompileService';
import {
  type EditorToPreviewEvent,
  type PreviewMode,
  type PreviewToEditorEvent,
  resolvePreviewMode,
} from './PreviewTypes';

// ====== Type Definitions ======

// SidebarTab changed to string to support dynamically registered view IDs
// Built-in view IDs: 'im' | 'files' | 'settings'
export type SidebarTab = string;
export type RightPanelTab = 'preview' | 'paper';
export type WorkspaceMode = 'chat' | 'chat-editor' | 'chat-editor-preview';
export type LogsSurface = 'hidden' | 'drawer';
export type ResearchLayoutFocus = 'balanced' | 'files' | 'chat' | 'preview';

function normalizeRightPanelTab(tab: string): RightPanelTab {
  return tab === 'paper' ? 'paper' : 'preview';
}

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
  /** Heading summary */
  summaryTitle?: string;
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
  /** Structured error entries */
  relatedEntries?: ParsedLogEntry[];
  /** Full raw log */
  rawLog?: string;
}

/**
 * Agent tool execution state
 */
export interface AgentState {
  /** Whether running */
  isRunning: boolean;
  /** Active tool */
  activeTool: string | null;
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
  WORKSPACE_MODE: 'ui.workspaceMode',
  RESEARCH_LAYOUT_FOCUS: 'ui.researchLayoutFocus',
  ACTIVE_ARTIFACT_PATH: 'ui.activeArtifactPath',
  ACTIVE_ARTIFACT_ID: 'ui.activeArtifactId',
  LOGS_SURFACE: 'ui.logsSurface',
  PREVIEW_VISIBLE: 'ui.previewVisible',
};

function normalizeSidebarTab(tab: string): SidebarTab {
  if (tab === 'ai' || tab === 'chat') {
    return 'im';
  }
  return tab as SidebarTab;
}

// ====== UIService Implementation ======

export class UIService implements IDisposable {
  private readonly _disposables = new DisposableStore();
  private readonly _storage = getStorageService();

  // Sidebar state
  private _sidebarTab: SidebarTab = normalizeSidebarTab(
    this._storage.getString(STORAGE_KEYS.SIDEBAR_TAB, 'im')
  );
  private _isSidebarCollapsed = this._storage.getBoolean(STORAGE_KEYS.SIDEBAR_COLLAPSED, false);

  // Layout dimensions
  private _sidebarWidth = this._storage.getNumber(STORAGE_KEYS.SIDEBAR_WIDTH, 260);

  // Right panel state
  private _rightPanelTab: RightPanelTab = normalizeRightPanelTab(
    this._storage.getString(STORAGE_KEYS.RIGHT_PANEL_TAB, 'preview')
  );
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
  private _filePdfPreviews = new Map<string, FilePdfPreviewState>();

  // SyncTeX
  private _synctexPath: string | null = null;
  private _remoteBuildId: string | null = null;
  private _pdfHighlight: PdfHighlight | null = null;

  // Zotero 论文 PDF(右栏「论文」tab)—— 与编译产物 _pdfData 独立,互不 clobber。
  private _zoteroPdf: { itemKey: string; pdfBytes: Uint8Array } | null = null;

  // Agent state
  private _agentState: AgentState = {
    isRunning: false,
    activeTool: null,
    startTime: 0,
    progress: '',
    message: '',
  };

  // Preview mode state
  private _previewMode: PreviewMode = 'none';
  private _workspaceMode = this._storage.getString(
    STORAGE_KEYS.WORKSPACE_MODE,
    'chat'
  ) as WorkspaceMode;
  private _researchLayoutFocus = this._storage.getString(
    STORAGE_KEYS.RESEARCH_LAYOUT_FOCUS,
    'balanced'
  ) as ResearchLayoutFocus;
  private _activeArtifactPath =
    this._storage.get<string | null>(STORAGE_KEYS.ACTIVE_ARTIFACT_PATH, null) ?? null;
  private _activeArtifactId =
    this._storage.get<string | null>(STORAGE_KEYS.ACTIVE_ARTIFACT_ID, null) ?? null;
  private _logsSurface = this._storage.getString(
    STORAGE_KEYS.LOGS_SURFACE,
    'hidden'
  ) as LogsSurface;
  private _isPreviewVisible = this._storage.getBoolean(STORAGE_KEYS.PREVIEW_VISIBLE, false);

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

  private readonly _onDidChangeZoteroPdf = new Emitter<{
    itemKey: string;
    pdfBytes: Uint8Array;
  } | null>();
  readonly onDidChangeZoteroPdf: Event<{ itemKey: string; pdfBytes: Uint8Array } | null> =
    this._onDidChangeZoteroPdf.event;

  private readonly _onDidChangeFilePdfPreview = new Emitter<{
    filePath: string;
    state: FilePdfPreviewState | null;
  }>();
  readonly onDidChangeFilePdfPreview: Event<{
    filePath: string;
    state: FilePdfPreviewState | null;
  }> = this._onDidChangeFilePdfPreview.event;

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

  private readonly _onDidChangePreviewMode = new Emitter<PreviewMode>();
  readonly onDidChangePreviewMode: Event<PreviewMode> = this._onDidChangePreviewMode.event;

  private readonly _onDidChangeWorkspaceMode = new Emitter<WorkspaceMode>();
  readonly onDidChangeWorkspaceMode: Event<WorkspaceMode> = this._onDidChangeWorkspaceMode.event;

  private readonly _onDidChangeResearchLayoutFocus = new Emitter<ResearchLayoutFocus>();
  readonly onDidChangeResearchLayoutFocus: Event<ResearchLayoutFocus> =
    this._onDidChangeResearchLayoutFocus.event;

  private readonly _onDidChangeActiveArtifactPath = new Emitter<string | null>();
  readonly onDidChangeActiveArtifactPath: Event<string | null> =
    this._onDidChangeActiveArtifactPath.event;

  private readonly _onDidChangeActiveArtifactId = new Emitter<string | null>();
  readonly onDidChangeActiveArtifactId: Event<string | null> =
    this._onDidChangeActiveArtifactId.event;

  private readonly _onDidChangeLogsSurface = new Emitter<LogsSurface>();
  readonly onDidChangeLogsSurface: Event<LogsSurface> = this._onDidChangeLogsSurface.event;

  private readonly _onDidChangePreviewVisible = new Emitter<boolean>();
  readonly onDidChangePreviewVisible: Event<boolean> = this._onDidChangePreviewVisible.event;

  private readonly _onDidEditorToPreview = new Emitter<EditorToPreviewEvent>();
  readonly onDidEditorToPreview: Event<EditorToPreviewEvent> = this._onDidEditorToPreview.event;

  private readonly _onDidPreviewToEditor = new Emitter<PreviewToEditorEvent>();
  readonly onDidPreviewToEditor: Event<PreviewToEditorEvent> = this._onDidPreviewToEditor.event;

  private readonly _onDidRequestChatWithText = new Emitter<{
    text: string;
    source: 'editor' | 'selection';
  }>();
  readonly onDidRequestChatWithText: Event<{ text: string; source: 'editor' | 'selection' }> =
    this._onDidRequestChatWithText.event;

  constructor() {
    this._disposables.add(this._onDidChangeSidebarTab);
    this._disposables.add(this._onDidChangeSidebarCollapsed);
    this._disposables.add(this._onDidChangeRightPanelTab);
    this._disposables.add(this._onDidChangeRightPanelCollapsed);
    this._disposables.add(this._onDidChangeCommandPalette);
    this._disposables.add(this._onDidChangeCompiling);
    this._disposables.add(this._onDidChangeCompilationResult);
    this._disposables.add(this._onDidChangePdf);
    this._disposables.add(this._onDidChangeZoteroPdf);
    this._disposables.add(this._onDidChangeFilePdfPreview);
    this._disposables.add(this._onDidAddCompilationLog);
    this._disposables.add(this._onDidChangePdfHighlight);
    this._disposables.add(this._onDidRequestAIErrorAnalysis);
    this._disposables.add(this._onDidChangeAgentState);
    this._disposables.add(this._onDidChangePreviewMode);
    this._disposables.add(this._onDidChangeWorkspaceMode);
    this._disposables.add(this._onDidChangeResearchLayoutFocus);
    this._disposables.add(this._onDidChangeActiveArtifactPath);
    this._disposables.add(this._onDidChangeActiveArtifactId);
    this._disposables.add(this._onDidChangeLogsSurface);
    this._disposables.add(this._onDidChangePreviewVisible);
    this._disposables.add(this._onDidEditorToPreview);
    this._disposables.add(this._onDidPreviewToEditor);
    this._disposables.add(this._onDidRequestChatWithText);

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

            // Auto-resolve preview mode based on active tab's file type
            const activeTabPath = editorService.activeTabPath;
            this.setPreviewMode(resolvePreviewMode(activeTabPath));
            this.syncPdfPreviewForFile(activeTabPath);
          })
        );

        this._disposables.add(
          editorService.onDidChangeDirtyState(({ path, isDirty }) => {
            if (isDirty && path.toLowerCase().endsWith('.typ')) {
              this.markFilePdfPreviewStale(path, true);
              if (editorService.activeTabPath === path) {
                this.syncPdfPreviewForFile(path);
              }
            }
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
  get zoteroPdf(): { itemKey: string; pdfBytes: Uint8Array } | null {
    return this._zoteroPdf;
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
  get workspaceMode(): WorkspaceMode {
    return this._workspaceMode;
  }
  get researchLayoutFocus(): ResearchLayoutFocus {
    return this._researchLayoutFocus;
  }
  get activeArtifactPath(): string | null {
    return this._activeArtifactPath;
  }
  get activeArtifactId(): string | null {
    return this._activeArtifactId;
  }
  get logsSurface(): LogsSurface {
    return this._logsSurface;
  }
  get isPreviewVisible(): boolean {
    return this._isPreviewVisible;
  }
  // ============ Sidebar Operations ============

  setSidebarTab(tab: SidebarTab): void {
    const normalizedTab = normalizeSidebarTab(tab);
    if (this._sidebarTab === normalizedTab) return;
    this._sidebarTab = normalizedTab;
    this._storage.store(STORAGE_KEYS.SIDEBAR_TAB, normalizedTab);
    this._onDidChangeSidebarTab.fire(normalizedTab);

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
    const nextTab = normalizeRightPanelTab(tab);
    if (this._rightPanelTab === nextTab) return;
    this._rightPanelTab = nextTab;
    this._storage.store(STORAGE_KEYS.RIGHT_PANEL_TAB, nextTab);
    this._onDidChangeRightPanelTab.fire(nextTab);

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

  setWorkspaceMode(mode: WorkspaceMode): void {
    if (this._workspaceMode === mode) return;
    this._workspaceMode = mode;
    this._storage.store(STORAGE_KEYS.WORKSPACE_MODE, mode);
    this._onDidChangeWorkspaceMode.fire(mode);
  }

  setResearchLayoutFocus(focus: ResearchLayoutFocus): void {
    if (this._researchLayoutFocus === focus) return;
    this._researchLayoutFocus = focus;
    this._storage.store(STORAGE_KEYS.RESEARCH_LAYOUT_FOCUS, focus);
    this._onDidChangeResearchLayoutFocus.fire(focus);
  }

  setActiveArtifactPath(path: string | null): void {
    if (this._activeArtifactPath === path) return;
    this._activeArtifactPath = path;
    this._storage.store(STORAGE_KEYS.ACTIVE_ARTIFACT_PATH, path);
    this._onDidChangeActiveArtifactPath.fire(path);
  }

  setActiveArtifactId(id: string | null): void {
    if (this._activeArtifactId === id) return;
    this._activeArtifactId = id;
    this._storage.store(STORAGE_KEYS.ACTIVE_ARTIFACT_ID, id);
    this._onDidChangeActiveArtifactId.fire(id);
  }

  setLogsSurface(surface: LogsSurface): void {
    if (this._logsSurface === surface) return;
    this._logsSurface = surface;
    this._storage.store(STORAGE_KEYS.LOGS_SURFACE, surface);
    this._onDidChangeLogsSurface.fire(surface);
  }

  setPreviewVisible(visible: boolean): void {
    if (this._isPreviewVisible === visible) return;
    this._isPreviewVisible = visible;
    this._storage.store(STORAGE_KEYS.PREVIEW_VISIBLE, visible);
    this._onDidChangePreviewVisible.fire(visible);
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

  setZoteroPdf(value: { itemKey: string; pdfBytes: Uint8Array } | null): void {
    this._zoteroPdf = value;
    this._onDidChangeZoteroPdf.fire(value);
  }

  /**
   * 一步加载 Zotero 论文 PDF 并切到右栏「论文」tab。收口右栏可见性 ——
   * immersive 布局右栏受 previewVisible 控制,这里一并确保展开。
   */
  loadZoteroPaper(itemKey: string, pdfBytes: Uint8Array): void {
    this.setZoteroPdf({ itemKey, pdfBytes });
    this.setRightPanelTab('paper');
    this.setPreviewVisible(true);
    if (this._isRightPanelCollapsed) {
      this.setRightPanelCollapsed(false);
    }
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

  getFilePdfPreview(filePath: string | null): FilePdfPreviewState | null {
    if (!filePath) return null;
    return this._filePdfPreviews.get(filePath) ?? null;
  }

  updateFilePdfPreview(
    filePath: string,
    preview: { pdfPath: string | null; pdfData: ArrayBuffer | null; isStale?: boolean }
  ): void {
    const nextState: FilePdfPreviewState = {
      filePath,
      pdfPath: preview.pdfPath,
      pdfData: preview.pdfData,
      isStale: preview.isStale ?? false,
      updatedAt: Date.now(),
    };

    this._filePdfPreviews.set(filePath, nextState);
    this._onDidChangeFilePdfPreview.fire({ filePath, state: nextState });
  }

  markFilePdfPreviewStale(filePath: string, isStale: boolean): void {
    const current = this._filePdfPreviews.get(filePath);
    if (!current || current.isStale === isStale) return;

    const nextState: FilePdfPreviewState = {
      ...current,
      isStale,
    };
    this._filePdfPreviews.set(filePath, nextState);
    this._onDidChangeFilePdfPreview.fire({ filePath, state: nextState });
  }

  private syncPdfPreviewForFile(filePath: string | null): void {
    if (!filePath) {
      this.setPdfPath(null);
      this.setPdfData(null);
      this.setPdfUrl(null);
      return;
    }

    const preview = this._filePdfPreviews.get(filePath);
    if (!preview || preview.isStale) {
      this.setPdfPath(null);
      this.setPdfData(null);
      this.setPdfUrl(null);
      return;
    }

    this.setPdfPath(preview.pdfPath);
    this.setPdfData(preview.pdfData);
    this.setPdfUrl(null);
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

  // ====== Preview Mode ======

  get previewMode(): PreviewMode {
    return this._previewMode;
  }

  setPreviewMode(mode: PreviewMode): void {
    if (this._previewMode === mode) return;
    this._previewMode = mode;
    this._onDidChangePreviewMode.fire(mode);
    if (mode === 'none') {
      this.setPreviewVisible(false);
    }
  }

  fireEditorToPreview(event: EditorToPreviewEvent): void {
    this._onDidEditorToPreview.fire(event);
  }

  firePreviewToEditor(event: PreviewToEditorEvent): void {
    this._onDidPreviewToEditor.fire(event);
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
   * Automatically switches to AI chat panel and keeps current editor/preview layout
   */
  requestAIErrorAnalysis(request: AskAIAboutErrorRequest): void {
    this.setSidebarTab('im');
    this._onDidRequestAIErrorAnalysis.fire(request);
  }

  // ====== Chat With Text (Ctrl+L) ======

  /**
   * Send text to the IM input (triggered by Ctrl+L or global selection).
   */
  requestChatWithText(text: string, source: 'editor' | 'selection' = 'editor'): void {
    this.setSidebarTab('im');
    this.setSidebarCollapsed(false);
    this._onDidRequestChatWithText.fire({ text, source });
  }

  // ====== Lifecycle ======

  dispose(): void {
    this._compilationLogs = [];
    this._pdfData = null;
    this._zoteroPdf = null;
    this._disposables.dispose();
  }
}
