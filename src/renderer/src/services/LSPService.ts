/**
 * @file LSPService.ts - Frontend LSP Service
 * @description Encapsulates communication with LSP server, providing language features such as diagnostics, completion, and hover hints
 * @depends IPC (api.lsp), TexLab, Tinymist
 */

import type * as monaco from 'monaco-editor';
import { CancellationError, Delayer, Throttler } from '../../../../shared/utils';
import { api } from '../api';
import { TaskPriority, cancelIdleTask, scheduleIdleTask } from './core/IdleTaskScheduler';

// ====== Supported File Types ======

const LATEX_EXTENSIONS = ['.tex', '.latex', '.ltx', '.sty', '.cls', '.bib'];
const TYPST_EXTENSIONS = ['.typ'];
const ALL_LSP_EXTENSIONS = [...LATEX_EXTENSIONS, ...TYPST_EXTENSIONS];

/**
 * Check if file is supported by LSP
 */
export function isLSPSupportedFile(filePath: string): boolean {
  const ext = filePath.match(/\.[^.]+$/)?.[0]?.toLowerCase() || '';
  return ALL_LSP_EXTENSIONS.includes(ext);
}

/**
 * Check if file is LaTeX
 */
export function isLatexFile(filePath: string): boolean {
  const ext = filePath.match(/\.[^.]+$/)?.[0]?.toLowerCase() || '';
  return LATEX_EXTENSIONS.includes(ext);
}

/**
 * Check if file is Typst
 */
export function isTypstFile(filePath: string): boolean {
  const ext = filePath.match(/\.[^.]+$/)?.[0]?.toLowerCase() || '';
  return TYPST_EXTENSIONS.includes(ext);
}

/**
 * Get language ID for file
 */
export function getLanguageId(filePath: string): string {
  if (isLatexFile(filePath)) return 'latex';
  if (isTypstFile(filePath)) return 'typst';
  return 'plaintext';
}

/**
 * Normalize Monaco model URI path for cross-platform consistency
 * Windows: /C:/path/file.tex -> C:/path/file.tex
 * Unix: /home/user/file.tex -> unchanged
 */
export function normalizeModelPath(uriPath: string): string {
  const normalized = uriPath.replace(/\\/g, '/');
  const withoutLeading = normalized.replace(/^\/+/, '');

  // Overleaf virtual paths
  if (withoutLeading.startsWith('overleaf://') || withoutLeading.startsWith('overleaf:')) {
    return withoutLeading;
  }

  // Windows drive letter pattern: /C:/ or /D:/
  if (/^\/[A-Za-z]:/.test(normalized)) {
    return normalized.slice(1);
  }
  return normalized;
}

// ====== LSP Type Definitions ======

export interface LSPPosition {
  line: number;
  character: number;
}

export interface LSPRange {
  start: LSPPosition;
  end: LSPPosition;
}

export interface LSPDiagnostic {
  range: LSPRange;
  severity?: 1 | 2 | 3 | 4; // Error, Warning, Information, Hint
  code?: string | number;
  source?: string;
  message: string;
}

export interface LSPCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | { kind: string; value: string };
  insertText?: string;
  insertTextFormat?: 1 | 2;
  textEdit?: {
    range: LSPRange;
    newText: string;
  };
  sortText?: string;
  filterText?: string;
}

export interface LSPHover {
  contents:
    | string
    | { kind: string; value: string }
    | Array<string | { kind: string; value: string }>;
  range?: LSPRange;
}

export interface LSPLocation {
  uri: string;
  range: LSPRange;
}

export interface LSPDocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: LSPRange;
  selectionRange: LSPRange;
  children?: LSPDocumentSymbol[];
}

// ====== Monaco Conversion Utilities ======

/**
 * Monaco Position -> LSP Position
 */
function monacoPositionToLsp(pos: monaco.IPosition): LSPPosition {
  return {
    line: pos.lineNumber - 1,
    character: pos.column - 1,
  };
}

/**
 * LSP Range -> Monaco Range
 */
function lspRangeToMonaco(range: LSPRange): monaco.IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

/** Monaco: 1=Hint, 2=Info, 4=Warning, 8=Error. LSP: 1=Error, 2=Warning, 3=Info, 4=Hint */
function lspSeverityToMonaco(severity?: number): monaco.MarkerSeverity {
  switch (severity) {
    case 1:
      return 8; // Error
    case 2:
      return 4; // Warning
    case 3:
      return 2; // Info
    case 4:
      return 1; // Hint
    default:
      return 2; // Default to Info
  }
}

/** LSP and Monaco CompletionItemKind values are roughly equivalent */
function lspCompletionKindToMonaco(kind?: number): monaco.languages.CompletionItemKind {
  if (!kind) return 0;
  if (kind <= 25) return kind;
  return 0;
}

/** LSP and Monaco SymbolKind values are identical */
function lspSymbolKindToMonaco(kind: number): monaco.languages.SymbolKind {
  return kind as monaco.languages.SymbolKind;
}

// ============ LSP Incremental Change Type Definitions ============

/**
 * LSP TextDocumentContentChangeEvent
 * Incremental change format conforming to LSP specification
 */
export interface LSPTextDocumentContentChangeEvent {
  range: LSPRange;
  rangeLength?: number;
  text: string;
}

// ====== LSP Service Class ======

const UPDATE_DEBOUNCE_MS = 300;
// Typst (Tinymist) needs longer debounce than LaTeX (TexLab)
const INCREMENTAL_UPDATE_DEBOUNCE_MS_LATEX = 100;
const INCREMENTAL_UPDATE_DEBOUNCE_MS_TYPST = 250;

// Inspired by VS Code's LanguageFeatureDebounceService
const DIAGNOSTICS_DEBOUNCE_MS = 200;
const SCROLL_PAUSE_MS = 150;

interface PendingUpdate {
  content: string;
  timeoutId: ReturnType<typeof setTimeout>;
}

interface PendingIncrementalUpdate {
  changes: LSPTextDocumentContentChangeEvent[];
  delayer: Delayer<void>;
}

class LSPServiceClass {
  private initialized = false;
  private available: boolean | null = null;
  private version: string | null = null;
  private diagnosticsCallbacks: Array<(filePath: string, diagnostics: LSPDiagnostic[]) => void> =
    [];
  private cleanupFunctions: Array<() => void> = [];

  // Virtual mode for remote projects (e.g. Overleaf) - doc content passed via LSP
  private virtualMode = false;

  private pendingUpdates: Map<string, PendingUpdate> = new Map();
  private pendingIncrementalUpdates: Map<string, PendingIncrementalUpdate> = new Map();

  private pendingDiagnostics: Map<
    string,
    {
      diagnostics: LSPDiagnostic[];
      timeoutId: ReturnType<typeof setTimeout>;
    }
  > = new Map();

  private isScrolling = false;
  private scrollEndTimer: ReturnType<typeof setTimeout> | null = null;

  // Throttlers per file path
  private completionThrottlers: Map<string, Throttler> = new Map();
  private hoverThrottlers: Map<string, Throttler> = new Map();

  // Buffered updates during scroll (flushed when scroll ends)
  private scrollPendingUpdates: Array<{
    filePath: string;
    changes: Array<{
      range: monaco.IRange;
      rangeLength?: number;
      text: string;
    }>;
  }> = [];

  /**
   * Check if LSP is available
   */
  async isAvailable(): Promise<boolean> {
    if (this.available !== null) return this.available;

    try {
      this.available = (await api.lsp.isAvailable()) ?? false;
      if (this.available) {
        this.version = (await api.lsp.getVersion()) ?? null;
        console.log('[LSP] TexLab available, version:', this.version);
      }
      return this.available;
    } catch (error) {
      console.error('[LSP] Failed to check availability:', error);
      this.available = false;
      return false;
    }
  }

  /**
   * Get TexLab version
   */
  getVersion(): string | null {
    return this.version;
  }

  /**
   * Start LSP service
   * @param rootPath Project root path (local mode) or virtual root identifier (virtual mode)
   * @param options Startup options
   * @param options.virtual Whether to use virtual mode (for remote projects like Overleaf)
   */
  async start(rootPath: string, options?: { virtual?: boolean }): Promise<boolean> {
    if (!(await this.isAvailable())) {
      console.warn('[LSP] TexLab not available');
      return false;
    }

    try {
      this.setupEventListeners();
      this.virtualMode = options?.virtual ?? false;

      const success = (await api.lsp.start(rootPath, options)) ?? false;
      if (success) {
        this.initialized = true;
        console.log(
          '[LSP] Started successfully',
          this.virtualMode ? '(virtual mode)' : '(local mode)'
        );
      }
      return success;
    } catch (error) {
      console.error('[LSP] Failed to start:', error);
      return false;
    }
  }

  /**
   * Check if in virtual mode
   */
  isVirtualMode(): boolean {
    return this.virtualMode;
  }

  /**
   * Stop LSP service
   */
  async stop(): Promise<void> {
    try {
      for (const pending of this.pendingUpdates.values()) {
        clearTimeout(pending.timeoutId);
      }
      this.pendingUpdates.clear();

      for (const pending of this.pendingIncrementalUpdates.values()) {
        pending.delayer.dispose();
      }
      this.pendingIncrementalUpdates.clear();

      for (const throttler of this.completionThrottlers.values()) {
        throttler.dispose();
      }
      this.completionThrottlers.clear();
      for (const throttler of this.hoverThrottlers.values()) {
        throttler.dispose();
      }
      this.hoverThrottlers.clear();

      this.scrollPendingUpdates = [];

      await api.lsp.stop();
      this.initialized = false;
      this.virtualMode = false;
      this.cleanupEventListeners();
      console.log('[LSP] Stopped');
    } catch (error) {
      console.error('[LSP] Failed to stop:', error);
    }
  }

  /**
   * Check if service is running (synchronous)
   * Note: Only checks frontend initialized state, which is set to true only after backend successfully starts
   */
  isRunning(): boolean {
    return this.initialized;
  }

  /**
   * Setup event listeners
   */
  private setupEventListeners(): void {
    // Diagnostics event - debounced, inspired by VS Code's LanguageFeatureDebounceService
    const cleanupDiagnostics = api.lsp.onDiagnostics((data) => {
      const diagnostics: LSPDiagnostic[] = data.diagnostics.map((d) => ({
        range: d.range,
        severity: d.severity as 1 | 2 | 3 | 4 | undefined,
        message: d.message,
        source: d.source,
      }));

      // Debounce diagnostics updates to avoid UI lag from high-frequency updates
      this.debounceDiagnostics(data.filePath, diagnostics);
    });
    if (cleanupDiagnostics) this.cleanupFunctions.push(cleanupDiagnostics);

    const cleanupInitialized = api.lsp.onInitialized(() => {
      console.log('[LSP] Server initialized');
    });
    if (cleanupInitialized) this.cleanupFunctions.push(cleanupInitialized);

    const cleanupExit = api.lsp.onExit((data) => {
      console.log('[LSP] Server exited:', data);
      this.initialized = false;
    });
    if (cleanupExit) this.cleanupFunctions.push(cleanupExit);

    // Recovery event - UtilityProcess auto-restart completed after crash
    const cleanupRecovered = api.lsp.onRecovered(() => {
      console.log('[LSP] UtilityProcess recovered after crash');
      this.initialized = true;
      this.resyncOpenDocuments();
    });
    if (cleanupRecovered) this.cleanupFunctions.push(cleanupRecovered);

    // Service restart event - TexLab/Tinymist auto-restart completed after crash
    const cleanupServiceRestarted = api.lsp.onServiceRestarted((data) => {
      console.log(`[LSP] Service ${data.service} restarted after crash`);
      // Resync documents after restart, otherwise LSP won't know about open files
      this.resyncOpenDocuments();
    });
    if (cleanupServiceRestarted) this.cleanupFunctions.push(cleanupServiceRestarted);
  }

  /**
   * Resync all open documents (used after LSP recovery)
   * Get all open models from Monaco editor and resend didOpen
   */
  private async resyncOpenDocuments(): Promise<void> {
    try {
      const monaco = await import('monaco-editor');
      const models = monaco.editor.getModels();

      let resyncCount = 0;
      for (const model of models) {
        const filePath = normalizeModelPath(model.uri.path);
        if (!isLSPSupportedFile(filePath)) continue;

        try {
          const languageId = getLanguageId(filePath);
          await this.openDocument(filePath, model.getValue(), languageId);
          resyncCount++;
          console.log(`[LSP] Resynced document: ${filePath} (${languageId})`);
        } catch (error) {
          console.error(`[LSP] Failed to resync document: ${filePath}`, error);
        }
      }

      if (resyncCount > 0) {
        console.log(`[LSP] Successfully resynced ${resyncCount} document(s)`);
      }
    } catch (error) {
      console.error('[LSP] Failed to resync documents:', error);
    }
  }

  /**
   * Debounce diagnostics updates
   * Inspired by VS Code's LanguageFeatureDebounceService, uses sliding window average
   */
  private debounceDiagnostics(filePath: string, diagnostics: LSPDiagnostic[]): void {
    const existing = this.pendingDiagnostics.get(filePath);
    if (existing) {
      clearTimeout(existing.timeoutId);
    }

    // Use longer delay if scrolling
    const delay = this.isScrolling ? DIAGNOSTICS_DEBOUNCE_MS * 2 : DIAGNOSTICS_DEBOUNCE_MS;

    const timeoutId = setTimeout(() => {
      this.pendingDiagnostics.delete(filePath);
      // Use unified scheduler to avoid multiple tasks executing simultaneously when switching back
      scheduleIdleTask(
        () => {
          this.diagnosticsCallbacks.forEach((cb) => cb(filePath, diagnostics));
        },
        {
          id: `lsp-diagnostics-${filePath}`,
          priority: TaskPriority.High,
          timeout: 100,
        }
      );
    }, delay);

    this.pendingDiagnostics.set(filePath, { diagnostics, timeoutId });
  }

  /**
   * Cleanup event listeners
   */
  private cleanupEventListeners(): void {
    this.cleanupFunctions.forEach((fn) => fn());
    this.cleanupFunctions = [];
    for (const [path, pending] of this.pendingDiagnostics.entries()) {
      clearTimeout(pending.timeoutId);
      cancelIdleTask(`lsp-diagnostics-${path}`);
    }
    this.pendingDiagnostics.clear();
  }

  /**
   * Register diagnostics callback
   */
  onDiagnostics(callback: (filePath: string, diagnostics: LSPDiagnostic[]) => void): () => void {
    this.diagnosticsCallbacks.push(callback);
    return () => {
      const index = this.diagnosticsCallbacks.indexOf(callback);
      if (index > -1) this.diagnosticsCallbacks.splice(index, 1);
    };
  }

  // ====== Scroll State Management (Performance Optimization) ======

  /**
   * Notify scroll start
   * Reduces LSP response priority during scrolling
   */
  notifyScrollStart(): void {
    this.isScrolling = true;
    if (this.scrollEndTimer) {
      clearTimeout(this.scrollEndTimer);
    }
  }

  /**
   * Notify scroll end
   */
  notifyScrollEnd(): void {
    if (this.scrollEndTimer) {
      clearTimeout(this.scrollEndTimer);
    }
    this.scrollEndTimer = setTimeout(() => {
      this.isScrolling = false;
      this.scrollEndTimer = null;
      this.flushScrollPendingUpdates();
    }, SCROLL_PAUSE_MS);
  }

  /**
   * Flush cached incremental updates during scroll
   */
  private flushScrollPendingUpdates(): void {
    if (this.scrollPendingUpdates.length === 0) return;

    const updates = this.scrollPendingUpdates;
    this.scrollPendingUpdates = [];

    for (const { filePath, changes } of updates) {
      // Use Promise.resolve().then() to avoid blocking
      this.updateDocumentIncremental(filePath, changes).catch((error) => {
        console.error(`[LSP] Failed to flush scroll-pending update for ${filePath}:`, error);
      });
    }
  }

  /**
   * Check if currently scrolling
   */
  isCurrentlyScrolling(): boolean {
    return this.isScrolling;
  }

  // ====== Document Operations ======

  /**
   * Open document
   */
  async openDocument(filePath: string, content: string, languageId = 'latex'): Promise<void> {
    if (!this.initialized) return;
    await api.lsp.openDocument(filePath, content, languageId);
  }

  /**
   * Update document (debounced to reduce IPC churn during high-frequency input)
   * Uses 300ms debounce window, sends update after user stops typing
   */
  async updateDocument(filePath: string, content: string): Promise<void> {
    if (!this.initialized) return;

    const existing = this.pendingUpdates.get(filePath);
    if (existing) {
      clearTimeout(existing.timeoutId);
    }

    const timeoutId = setTimeout(async () => {
      this.pendingUpdates.delete(filePath);
      try {
        await api.lsp.updateDocument(filePath, content);
      } catch (error) {
        console.error('[LSP] Update document error:', error);
      }
    }, UPDATE_DEBOUNCE_MS);

    this.pendingUpdates.set(filePath, { content, timeoutId });
  }

  /**
   * Immediately flush all pending document updates
   * Call before save or compile to ensure LSP has latest content
   */
  async flushPendingUpdates(filePath?: string): Promise<void> {
    if (!this.initialized) return;

    if (filePath) {
      const pending = this.pendingUpdates.get(filePath);
      if (pending) {
        clearTimeout(pending.timeoutId);
        this.pendingUpdates.delete(filePath);
        await api.lsp.updateDocument(filePath, pending.content);
      }
    } else {
      const updates = Array.from(this.pendingUpdates.entries());
      for (const [path, pending] of updates) {
        clearTimeout(pending.timeoutId);
        this.pendingUpdates.delete(path);
        await api.lsp.updateDocument(path, pending.content);
      }
    }
  }

  /**
   * Update document immediately (no debounce, for scenarios requiring instant response)
   */
  async updateDocumentImmediate(filePath: string, content: string): Promise<void> {
    if (!this.initialized) return;

    const existing = this.pendingUpdates.get(filePath);
    if (existing) {
      clearTimeout(existing.timeoutId);
      this.pendingUpdates.delete(filePath);
    }

    await api.lsp.updateDocument(filePath, content);
  }

  /**
   * Incrementally update document (debounced, only sends changed content)
   * Significantly reduces IPC data transfer when editing large files
   *
   * Different debounce times for different LSPs:
   * - LaTeX (TexLab): 100ms, faster response
   * - Typst (Tinymist): 250ms, needs more processing time
   *
   * @param filePath File path
   * @param changes Monaco change event list
   */
  async updateDocumentIncremental(
    filePath: string,
    changes: Array<{
      range: monaco.IRange;
      rangeLength?: number;
      text: string;
    }>
  ): Promise<void> {
    if (!this.initialized) return;

    // Cache updates during scroll instead of discarding
    if (this.isScrolling) {
      this.scrollPendingUpdates.push({ filePath, changes });
      return;
    }

    const lspChanges: LSPTextDocumentContentChangeEvent[] = changes.map((change) => ({
      range: {
        start: { line: change.range.startLineNumber - 1, character: change.range.startColumn - 1 },
        end: { line: change.range.endLineNumber - 1, character: change.range.endColumn - 1 },
      },
      rangeLength: change.rangeLength,
      text: change.text,
    }));

    let pending = this.pendingIncrementalUpdates.get(filePath);
    if (pending) {
      pending.changes.push(...lspChanges);
    } else {
      const debounceMs = isTypstFile(filePath)
        ? INCREMENTAL_UPDATE_DEBOUNCE_MS_TYPST
        : INCREMENTAL_UPDATE_DEBOUNCE_MS_LATEX;

      pending = {
        changes: lspChanges,
        delayer: new Delayer<void>(debounceMs),
      };
      this.pendingIncrementalUpdates.set(filePath, pending);
    }

    // Use Delayer to trigger debounced update
    // Note: Must catch cancellation errors, as flushIncrementalUpdates calls dispose()
    pending.delayer
      .trigger(async () => {
        const toSend = this.pendingIncrementalUpdates.get(filePath);
        if (!toSend) return;

        this.pendingIncrementalUpdates.delete(filePath);
        try {
          await api.lsp.updateDocumentIncremental(filePath, toSend.changes);
        } catch (error) {
          console.error('[LSP] Incremental update error:', error);
        }
      })
      .catch((error) => {
        // Ignore cancellation errors (triggered by flushIncrementalUpdates)
        if (error?.name !== 'CancellationError') {
          console.error('[LSP] Delayer error:', error);
        }
      });
  }

  /**
   * Check if there are pending incremental updates
   * Used to check before calling flush to avoid unnecessary function call overhead
   */
  hasPendingIncrementalUpdates(filePath?: string): boolean {
    if (filePath) {
      return this.pendingIncrementalUpdates.has(filePath);
    }
    return this.pendingIncrementalUpdates.size > 0;
  }

  /**
   * Immediately flush incremental updates (no debounce)
   */
  async flushIncrementalUpdates(filePath?: string): Promise<void> {
    if (!this.initialized) return;

    if (filePath) {
      const pending = this.pendingIncrementalUpdates.get(filePath);
      if (pending) {
        pending.delayer.dispose();
        this.pendingIncrementalUpdates.delete(filePath);
        await api.lsp.updateDocumentIncremental(filePath, pending.changes);
      }
    } else {
      const updates = Array.from(this.pendingIncrementalUpdates.entries());
      for (const [path, pending] of updates) {
        pending.delayer.dispose();
        this.pendingIncrementalUpdates.delete(path);
        await api.lsp.updateDocumentIncremental(path, pending.changes);
      }
    }
  }

  /**
   * Close document
   */
  async closeDocument(filePath: string): Promise<void> {
    if (!this.initialized) return;
    await api.lsp.closeDocument(filePath);
  }

  /**
   * Save document
   */
  async saveDocument(filePath: string): Promise<void> {
    if (!this.initialized) return;
    await api.lsp.saveDocument(filePath);
  }

  // ====== Language Features ======

  /**
   * Get completion suggestions (throttled)
   * Uses Throttler to ensure only the latest request is kept during high-frequency requests
   */
  async getCompletions(
    filePath: string,
    position: monaco.IPosition
  ): Promise<monaco.languages.CompletionItem[]> {
    if (!this.initialized) return [];

    let throttler = this.completionThrottlers.get(filePath);
    if (!throttler) {
      throttler = new Throttler();
      this.completionThrottlers.set(filePath, throttler);
    }

    try {
      return await throttler.queue(async (token) => {
        if (token.isCancellationRequested) return [];

        const lspPos = monacoPositionToLsp(position);
        const items = (await api.lsp.getCompletions(filePath, lspPos.line, lspPos.character)) as
          | LSPCompletionItem[]
          | undefined;

        if (token.isCancellationRequested) return [];

        if (!items) return [];
        return items.map((item) => this.convertCompletionItem(item));
      });
    } catch (error) {
      // CancellationError is expected behavior, silently handle
      if (error instanceof CancellationError) return [];
      console.error('[LSP] Completion error:', error);
      return [];
    }
  }

  /**
   * Convert completion item
   */
  private convertCompletionItem(item: LSPCompletionItem): monaco.languages.CompletionItem {
    let range: monaco.IRange | undefined;
    let insertText = item.insertText || item.label;

    if (item.textEdit) {
      range = lspRangeToMonaco(item.textEdit.range);
      insertText = item.textEdit.newText;
    }

    const result: monaco.languages.CompletionItem = {
      label: item.label,
      kind: lspCompletionKindToMonaco(item.kind),
      insertText,
      insertTextRules:
        item.insertTextFormat === 2
          ? 4 // InsertAsSnippet
          : undefined,
      detail: item.detail,
      sortText: item.sortText,
      filterText: item.filterText,
      // Monaco CompletionItem.range type requires IRange, but runtime accepts undefined
      // When range is undefined, Monaco automatically uses current word range
      range: range!,
    };

    if (item.documentation) {
      if (typeof item.documentation === 'string') {
        result.documentation = item.documentation;
      } else {
        result.documentation = {
          value: item.documentation.value,
        };
      }
    }

    return result;
  }

  /**
   * Get hover hint (throttled)
   * Uses Throttler to ensure only the latest request is kept during high-frequency requests
   */
  async getHover(
    filePath: string,
    position: monaco.IPosition
  ): Promise<monaco.languages.Hover | null> {
    if (!this.initialized) return null;

    let throttler = this.hoverThrottlers.get(filePath);
    if (!throttler) {
      throttler = new Throttler();
      this.hoverThrottlers.set(filePath, throttler);
    }

    try {
      return await throttler.queue(async (token) => {
        if (token.isCancellationRequested) return null;

        const lspPos = monacoPositionToLsp(position);
        const hover = (await api.lsp.getHover(filePath, lspPos.line, lspPos.character)) as
          | LSPHover
          | null
          | undefined;

        if (token.isCancellationRequested) return null;

        if (!hover) return null;
        return this.convertHover(hover);
      });
    } catch (error) {
      // CancellationError is expected behavior, silently handle
      if (error instanceof CancellationError) return null;
      console.error('[LSP] Hover error:', error);
      return null;
    }
  }

  /**
   * Convert hover hint
   */
  private convertHover(hover: LSPHover): monaco.languages.Hover {
    const contents: monaco.IMarkdownString[] = [];

    if (typeof hover.contents === 'string') {
      contents.push({ value: hover.contents });
    } else if (Array.isArray(hover.contents)) {
      for (const content of hover.contents) {
        if (typeof content === 'string') {
          contents.push({ value: content });
        } else {
          contents.push({ value: content.value });
        }
      }
    } else {
      contents.push({ value: hover.contents.value });
    }

    return {
      contents,
      range: hover.range ? lspRangeToMonaco(hover.range) : undefined,
    };
  }

  /**
   * Go to definition
   */
  async getDefinition(
    filePath: string,
    position: monaco.IPosition
  ): Promise<monaco.languages.Location[]> {
    if (!this.initialized) return [];

    try {
      const lspPos = monacoPositionToLsp(position);
      const result = (await api.lsp.getDefinition(filePath, lspPos.line, lspPos.character)) as
        | LSPLocation
        | LSPLocation[]
        | null
        | undefined;

      if (!result) return [];

      const locations = Array.isArray(result) ? result : [result];
      return locations.map((loc) => ({
        uri: { path: this.uriToPath(loc.uri) } as monaco.Uri,
        range: lspRangeToMonaco(loc.range),
      }));
    } catch (error) {
      console.error('[LSP] Definition error:', error);
      return [];
    }
  }

  /**
   * Find references
   */
  async getReferences(
    filePath: string,
    position: monaco.IPosition,
    includeDeclaration = true
  ): Promise<monaco.languages.Location[]> {
    if (!this.initialized) return [];

    try {
      const lspPos = monacoPositionToLsp(position);
      const result = (await api.lsp.getReferences(
        filePath,
        lspPos.line,
        lspPos.character,
        includeDeclaration
      )) as LSPLocation[] | undefined;

      if (!result) return [];

      return result.map((loc) => ({
        uri: { path: this.uriToPath(loc.uri) } as monaco.Uri,
        range: lspRangeToMonaco(loc.range),
      }));
    } catch (error) {
      console.error('[LSP] References error:', error);
      return [];
    }
  }

  /**
   * Get document symbols
   */
  async getDocumentSymbols(filePath: string): Promise<monaco.languages.DocumentSymbol[]> {
    if (!this.initialized) return [];

    try {
      const result = (await api.lsp.getSymbols(filePath)) as LSPDocumentSymbol[] | undefined;

      if (!result) return [];

      return this.convertDocumentSymbols(result);
    } catch (error) {
      console.error('[LSP] Document symbols error:', error);
      return [];
    }
  }

  /**
   * Convert document symbols
   */
  private convertDocumentSymbols(symbols: LSPDocumentSymbol[]): monaco.languages.DocumentSymbol[] {
    return symbols.map((sym) => ({
      name: sym.name,
      detail: sym.detail || '',
      kind: lspSymbolKindToMonaco(sym.kind),
      range: lspRangeToMonaco(sym.range),
      selectionRange: lspRangeToMonaco(sym.selectionRange),
      children: sym.children ? this.convertDocumentSymbols(sym.children) : undefined,
      tags: [],
    }));
  }

  // ====== Diagnostics Conversion ======

  convertDiagnosticsToMarkers(
    diagnostics: LSPDiagnostic[],
    _model?: monaco.editor.ITextModel
  ): monaco.editor.IMarkerData[] {
    return diagnostics.map((diag) => ({
      severity: lspSeverityToMonaco(diag.severity),
      message: diag.message,
      startLineNumber: diag.range.start.line + 1,
      startColumn: diag.range.start.character + 1,
      endLineNumber: diag.range.end.line + 1,
      endColumn: diag.range.end.character + 1,
      source: diag.source || 'texlab',
      code: diag.code?.toString(),
    }));
  }

  // ====== Utility Methods ======

  /** Convert URI to file path (supports file:// and virtual:// schemes) */
  private uriToPath(uri: string): string {
    if (uri.startsWith('virtual://')) {
      return uri.replace(/^virtual:\/\/\/?/, '');
    }

    let filePath = uri.replace(/^file:\/\/\/?/, '');
    if (process.platform === 'win32' && filePath.startsWith('/')) {
      filePath = filePath.slice(1);
    }
    return filePath.replace(/\//g, '\\');
  }
}

// Export singleton
export const LSPService = new LSPServiceClass();
