/**
 * @file EditorService - Core editor state management
 * @description Event-driven architecture inspired by VS Code. All state changes propagate via events.
 * @depends WorkingCopyService, BackupService, ProjectService
 */

import {
  DisposableStore,
  Emitter,
  Event,
  type IDisposable,
  Relay,
} from '../../../../../shared/utils';
import type { Diagnostic, EditorTab } from '../../types';
import { getBackupService } from './BackupService';
import { getProjectService } from './ServiceRegistry';
import { getWorkingCopyService } from './WorkingCopyService';

// ====== Types ======

export interface TabChangeEvent {
  readonly tab: EditorTab;
  readonly type: 'added' | 'removed' | 'updated' | 'activated';
}

export interface ContentChangeEvent {
  readonly path: string;
  readonly content: string;
  readonly isDirty: boolean;
  /** Programmatic replacement (e.g., polish, refactor) - forces Monaco Editor update */
  readonly forceUpdate?: boolean;
}

export interface DiagnosticsChangeEvent {
  readonly path: string;
  readonly diagnostics: Diagnostic[];
}

export interface CursorChangeEvent {
  readonly line: number;
  readonly column: number;
}

export interface SelectionChangeEvent {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

// ====== EditorService Implementation ======

export class EditorService implements IDisposable {
  private readonly _disposables = new DisposableStore();

  // ====== State ======
  private _tabsById: Map<string, EditorTab> = new Map();
  private _tabOrder: string[] = [];
  private _activeTabPath: string | null = null;
  private _diagnosticsById: Map<string, Diagnostic[]> = new Map();
  private _cursorPosition = { line: 1, column: 1 };
  private _selection: SelectionChangeEvent | null = null;

  // Version tracking for save race condition prevention
  private _contentVersions: Map<string, number> = new Map();
  private _savingVersions: Map<string, number> = new Map();
  // File mtime tracking for VSCode-style conflict detection
  private _fileMtimes: Map<string, number> = new Map();

  // Cached for useSyncExternalStore stable reference
  private _cachedTabs: EditorTab[] = [];
  private _cachedActiveTab: EditorTab | null = null;

  // ====== Events ======

  private readonly _onDidAddTab = new Emitter<TabChangeEvent>();
  readonly onDidAddTab: Event<TabChangeEvent> = this._onDidAddTab.event;

  private readonly _onDidRemoveTab = new Emitter<TabChangeEvent>();
  readonly onDidRemoveTab: Event<TabChangeEvent> = this._onDidRemoveTab.event;

  private readonly _onDidChangeActiveTab = new Emitter<EditorTab | null>();
  readonly onDidChangeActiveTab: Event<EditorTab | null> = this._onDidChangeActiveTab.event;

  private readonly _onDidChangeContent = new Emitter<ContentChangeEvent>();
  readonly onDidChangeContent: Event<ContentChangeEvent> = this._onDidChangeContent.event;

  private readonly _onDidChangeDiagnostics = new Emitter<DiagnosticsChangeEvent>();
  readonly onDidChangeDiagnostics: Event<DiagnosticsChangeEvent> =
    this._onDidChangeDiagnostics.event;

  private readonly _onDidChangeCursor = new Emitter<CursorChangeEvent>();
  readonly onDidChangeCursor: Event<CursorChangeEvent> = this._onDidChangeCursor.event;

  private readonly _onDidChangeSelection = new Emitter<SelectionChangeEvent | null>();
  readonly onDidChangeSelection: Event<SelectionChangeEvent | null> =
    this._onDidChangeSelection.event;

  private readonly _onDidMarkClean = new Emitter<string>();
  readonly onDidMarkClean: Event<string> = this._onDidMarkClean.event;

  // Only fires when isDirty state actually changes (false→true or true→false)
  // Performance critical: avoids UI re-renders on every content change
  private readonly _onDidChangeDirtyState = new Emitter<{ path: string; isDirty: boolean }>();
  readonly onDidChangeDirtyState: Event<{ path: string; isDirty: boolean }> =
    this._onDidChangeDirtyState.event;

  // ====== Relay Events (Active Editor Only) ======
  //
  // Relay pattern benefits:
  // 1. Consumers subscribe once, no re-subscription on tab switch
  // 2. Automatic cleanup of old event sources, prevents memory leaks
  // 3. Simplifies UI component logic, reduces useEffect dependencies

  /**
   * Active editor content change relay.
   * Automatically switches to new tab's events when user switches tabs.
   */
  private readonly _activeEditorContentRelay = new Relay<ContentChangeEvent>();
  readonly onActiveEditorContentChanged: Event<ContentChangeEvent> =
    this._activeEditorContentRelay.event;

  /** Active editor diagnostics change relay */
  private readonly _activeEditorDiagnosticsRelay = new Relay<DiagnosticsChangeEvent>();
  readonly onActiveEditorDiagnosticsChanged: Event<DiagnosticsChangeEvent> =
    this._activeEditorDiagnosticsRelay.event;

  constructor() {
    // Register emitters for disposal
    this._disposables.add(this._onDidAddTab);
    this._disposables.add(this._onDidRemoveTab);
    this._disposables.add(this._onDidChangeActiveTab);
    this._disposables.add(this._onDidChangeContent);
    this._disposables.add(this._onDidChangeDiagnostics);
    this._disposables.add(this._onDidChangeCursor);
    this._disposables.add(this._onDidChangeSelection);
    this._disposables.add(this._onDidMarkClean);
    this._disposables.add(this._onDidChangeDirtyState);

    this._disposables.add(this._activeEditorContentRelay);
    this._disposables.add(this._activeEditorDiagnosticsRelay);

    this._setupActiveEditorRelays();
  }

  /**
   * Setup relay inputs filtered to active editor only.
   * Filter conditions auto-update when active tab changes.
   */
  private _setupActiveEditorRelays(): void {
    this._activeEditorContentRelay.input = Event.filter(
      this._onDidChangeContent.event,
      (e) => e.path === this._activeTabPath
    );

    this._activeEditorDiagnosticsRelay.input = Event.filter(
      this._onDidChangeDiagnostics.event,
      (e) => e.path === this._activeTabPath
    );
  }

  // ====== Getters ======

  get tabs(): EditorTab[] {
    return this._cachedTabs;
  }

  get activeTab(): EditorTab | null {
    return this._cachedActiveTab;
  }

  get activeTabPath(): string | null {
    return this._activeTabPath;
  }

  get cursorPosition(): { line: number; column: number } {
    return this._cursorPosition;
  }

  get selection(): SelectionChangeEvent | null {
    return this._selection;
  }

  // ====== Cache Updates ======

  private _updateTabsCache(): void {
    this._cachedTabs = this._tabOrder.map((path) => this._tabsById.get(path)!).filter(Boolean);
  }

  private _updateActiveTabCache(): void {
    this._cachedActiveTab = this._activeTabPath
      ? (this._tabsById.get(this._activeTabPath) ?? null)
      : null;
  }

  getTab(path: string): EditorTab | undefined {
    return this._tabsById.get(path);
  }

  getDiagnostics(path: string): Diagnostic[] {
    return this._diagnosticsById.get(path) ?? [];
  }

  hasTab(path: string): boolean {
    return this._tabsById.has(path);
  }

  hasDirtyTabs(): boolean {
    for (const tab of this._tabsById.values()) {
      if (tab.isDirty) return true;
    }
    return false;
  }

  // ====== Tab Operations ======

  addTab(tab: EditorTab): void {
    const existingTab = this._tabsById.get(tab.path);
    if (existingTab) {
      if (!existingTab.isDirty && tab.content !== existingTab.content) {
        // Tab not dirty but content differs: update from disk (external modification)
        console.log('[EditorService] Tab exists, updating content from disk:', tab.path);
        existingTab.content = tab.content;

        // Sync to WorkingCopyService
        const workingCopy = getWorkingCopyService().get(tab.path);
        if (workingCopy) {
          workingCopy.originalContent = tab.content;
          workingCopy.content = tab.content;
        }

        this._onDidChangeContent.fire({ path: tab.path, content: tab.content, isDirty: false });
      }
      this.setActiveTab(tab.path);
      return;
    }

    this._tabsById.set(tab.path, tab);
    this._tabOrder.push(tab.path);
    this._activeTabPath = tab.path;

    getWorkingCopyService().register(tab.path, tab.content);
    this._updateTabsCache();
    this._updateActiveTabCache();

    this._onDidAddTab.fire({ tab, type: 'added' });
    this._onDidChangeActiveTab.fire(this._cachedActiveTab);
  }

  closeTab(path: string): void {
    const tab = this._tabsById.get(path);
    if (!tab) return;

    const idx = this._tabOrder.indexOf(path);
    if (idx === -1) return;

    getWorkingCopyService().unregister(path);

    // Discard backup async, ignore errors
    const projectPath = getProjectService().projectPath;
    if (projectPath) {
      getBackupService()
        .discardBackup(path, projectPath)
        .catch(() => {});
    }

    this._tabsById.delete(path);
    this._tabOrder.splice(idx, 1);
    this._diagnosticsById.delete(path);
    this._updateTabsCache();

    this._onDidRemoveTab.fire({ tab, type: 'removed' });

    if (this._activeTabPath === path) {
      const newActivePath = this._tabOrder[this._tabOrder.length - 1] ?? null;
      this._activeTabPath = newActivePath;
      this._updateActiveTabCache();
      this._onDidChangeActiveTab.fire(this._cachedActiveTab);
    }
  }

  setActiveTab(path: string): void {
    if (!this._tabsById.has(path) || this._activeTabPath === path) return;

    this._activeTabPath = path;
    this._updateActiveTabCache();

    // Update relay filters to match new active tab
    this._setupActiveEditorRelays();

    this._onDidChangeActiveTab.fire(this._cachedActiveTab);
  }

  closeAllTabs(): void {
    const tabs = [...this._tabsById.values()];
    const projectPath = getProjectService().projectPath;

    // Unregister all WorkingCopies and discard backups
    for (const tab of tabs) {
      getWorkingCopyService().unregister(tab.path);

      if (projectPath) {
        getBackupService()
          .discardBackup(tab.path, projectPath)
          .catch(() => {});
      }
    }

    this._tabsById.clear();
    this._tabOrder = [];
    this._activeTabPath = null;
    this._diagnosticsById.clear();

    this._contentVersions.clear();
    this._savingVersions.clear();
    this._fileMtimes.clear();

    this._cachedTabs = [];
    this._cachedActiveTab = null;

    // Clear relay inputs (no active editor)
    this._activeEditorContentRelay.input = undefined;
    this._activeEditorDiagnosticsRelay.input = undefined;

    for (const tab of tabs) {
      this._onDidRemoveTab.fire({ tab, type: 'removed' });
    }
    this._onDidChangeActiveTab.fire(null);
  }

  // ====== Content Operations ======

  updateContent(path: string, content: string): void {
    const tab = this._tabsById.get(path);
    if (!tab) return;

    const wasDirty = tab.isDirty;

    tab.content = content;
    tab.isDirty = true;

    // Increment version for race condition detection during save
    const currentVersion = (this._contentVersions.get(path) ?? 0) + 1;
    this._contentVersions.set(path, currentVersion);

    getWorkingCopyService().update(path, content);

    // Trigger auto-backup
    const projectPath = getProjectService().projectPath;
    if (projectPath) {
      getBackupService().scheduleBackup(path, content, projectPath);
    }

    // Performance: only update cache when isDirty state changes
    // Avoids component re-renders on every keystroke
    if (!wasDirty) {
      this._updateTabsCache();
      this._onDidChangeDirtyState.fire({ path, isDirty: true });
    }

    this._onDidChangeContent.fire({ path, content, isDirty: true });
  }

  /**
   * Programmatic content replacement (e.g., polish, refactor).
   * @remarks Unlike updateContent, sets forceUpdate=true to trigger Monaco Editor refresh
   */
  replaceContent(path: string, content: string): void {
    const tab = this._tabsById.get(path);
    if (!tab) return;

    const wasDirty = tab.isDirty;

    tab.content = content;
    tab.isDirty = true;

    const currentVersion = (this._contentVersions.get(path) ?? 0) + 1;
    this._contentVersions.set(path, currentVersion);

    getWorkingCopyService().update(path, content);

    const projectPath = getProjectService().projectPath;
    if (projectPath) {
      getBackupService().scheduleBackup(path, content, projectPath);
    }

    if (!wasDirty) {
      this._updateTabsCache();
      this._onDidChangeDirtyState.fire({ path, isDirty: true });
    }

    // forceUpdate: true notifies Monaco Editor to refresh (not user input)
    this._onDidChangeContent.fire({ path, content, isDirty: true, forceUpdate: true });
  }

  /**
   * Set content from external source (e.g., file watcher detected modification).
   * @remarks Does not increment version (not user edit), does not trigger backup, marks clean
   */
  setContentFromExternal(path: string, content: string): void {
    const tab = this._tabsById.get(path);
    if (!tab) return;

    const wasDirty = tab.isDirty;

    // Set content without incrementing version (external content, not user edit)
    tab.content = content;
    tab.isDirty = false;

    getWorkingCopyService().markSaved(path, content);

    // Discard backup (content already synced to disk)
    const projectPath = getProjectService().projectPath;
    if (projectPath) {
      getBackupService()
        .discardBackup(path, projectPath)
        .catch(() => {});
    }

    if (wasDirty) {
      this._updateTabsCache();
      this._onDidChangeDirtyState.fire({ path, isDirty: false });
    }

    this._onDidChangeContent.fire({ path, content, isDirty: false });
  }

  /** Get current content version (for recording before save) */
  getContentVersion(path: string): number {
    return this._contentVersions.get(path) ?? 0;
  }

  /**
   * Begin save operation (records version at save time).
   * @returns content, version, and mtime for conflict detection
   */
  beginSave(path: string): { content: string; version: number; mtime?: number } | null {
    const tab = this._tabsById.get(path);
    if (!tab) return null;

    const version = this._contentVersions.get(path) ?? 0;
    this._savingVersions.set(path, version);
    const mtime = this._fileMtimes.get(path);

    return { content: tab.content, version, mtime };
  }

  /** Get file mtime (for conflict detection) */
  getFileMtime(path: string): number | undefined {
    return this._fileMtimes.get(path);
  }

  /** Update file mtime (called after opening file or successful save) */
  updateFileMtime(path: string, mtime: number): void {
    this._fileMtimes.set(path, mtime);
  }

  /**
   * Complete save operation with version check.
   * Only marks clean if no edits occurred during save.
   * @returns true if marked clean, false if edits occurred during save
   */
  completeSave(path: string, savedVersion: number): boolean {
    const tab = this._tabsById.get(path);
    if (!tab) return false;

    const currentVersion = this._contentVersions.get(path) ?? 0;
    this._savingVersions.delete(path);

    // Check if edits occurred during save
    if (currentVersion > savedVersion) {
      console.debug(
        `[EditorService] Save completed but content changed (v${savedVersion} → v${currentVersion}), keeping dirty`
      );
      return false;
    }

    if (!tab.isDirty) return true;

    tab.isDirty = false;

    getWorkingCopyService().markSaved(path, tab.content);

    const projectPath = getProjectService().projectPath;
    if (projectPath) {
      getBackupService()
        .discardBackup(path, projectPath)
        .catch(() => {});
    }

    // Update cache to trigger React re-render
    this._updateTabsCache();

    this._onDidChangeDirtyState.fire({ path, isDirty: false });
    this._onDidMarkClean.fire(path);

    return true;
  }

  /** @deprecated Use beginSave + completeSave to avoid race conditions */
  markClean(path: string): void {
    const tab = this._tabsById.get(path);
    if (!tab || !tab.isDirty) return;

    tab.isDirty = false;

    getWorkingCopyService().markSaved(path, tab.content);

    const projectPath = getProjectService().projectPath;
    if (projectPath) {
      getBackupService()
        .discardBackup(path, projectPath)
        .catch(() => {});
    }

    this._updateTabsCache();
    this._onDidChangeDirtyState.fire({ path, isDirty: false });
    this._onDidMarkClean.fire(path);
  }

  // ====== Diagnostics Operations ======

  setDiagnostics(path: string, diagnostics: Diagnostic[]): void {
    this._diagnosticsById.set(path, diagnostics);
    this._onDidChangeDiagnostics.fire({ path, diagnostics });
  }

  clearDiagnostics(path: string): void {
    if (!this._diagnosticsById.has(path)) return;
    this._diagnosticsById.delete(path);
    this._onDidChangeDiagnostics.fire({ path, diagnostics: [] });
  }

  // ====== Cursor & Selection ======

  setCursorPosition(line: number, column: number): void {
    if (this._cursorPosition.line === line && this._cursorPosition.column === column) return;
    this._cursorPosition = { line, column };
    this._onDidChangeCursor.fire({ line, column });
  }

  setSelection(selection: SelectionChangeEvent | null): void {
    this._selection = selection;
    this._onDidChangeSelection.fire(selection);
  }

  // ====== Backup & Recovery ======

  /** Check if file has unsaved backup, returns backup content or null */
  async checkBackup(path: string): Promise<string | null> {
    const projectPath = getProjectService().projectPath;
    if (!projectPath) return null;

    return await getBackupService().restore(path, projectPath);
  }

  /** Open file with backup check. If backup exists, uses backup content and marks dirty. */
  async openFileWithBackupCheck(
    path: string,
    originalContent: string,
    language: string
  ): Promise<{ content: string; fromBackup: boolean }> {
    const backupContent = await this.checkBackup(path);

    if (backupContent && backupContent !== originalContent) {
      // Backup exists and differs, use backup content
      const tab: EditorTab = {
        path,
        name: path.split(/[/\\]/).pop() || path,
        content: backupContent,
        language,
        isDirty: true, // Dirty because restored from backup
      };
      this.addTab(tab);

      // Sync WorkingCopyService: set originalContent to disk content
      const workingCopy = getWorkingCopyService().get(path);
      if (workingCopy) {
        workingCopy.originalContent = originalContent;
        workingCopy.content = backupContent;
      }

      return { content: backupContent, fromBackup: true };
    }

    // No backup or same content, use original
    const tab: EditorTab = {
      path,
      name: path.split(/[/\\]/).pop() || path,
      content: originalContent,
      language,
      isDirty: false,
    };
    this.addTab(tab);

    return { content: originalContent, fromBackup: false };
  }

  // ====== Memory Management ======

  /**
   * Cleanup inactive tabs to release memory.
   * Keeps the most recently used `keepCount` tabs' content.
   * @remarks Sets needsReload flag instead of clearing content (content kept as fallback)
   */
  cleanupInactiveTabs(keepCount = 5): void {
    if (this._tabOrder.length <= keepCount) return;

    // Get tabs to clean (exclude active and most recent keepCount)
    const tabsToClean = this._tabOrder.slice(0, -keepCount);

    for (const path of tabsToClean) {
      if (path === this._activeTabPath) continue;

      const tab = this._tabsById.get(path);
      if (tab && !tab.isDirty && !tab.isRemote) {
        // Mark for reload, keep content as fallback
        // Remote files skipped (can't read from disk)
        tab.needsReload = true;
      }
    }
  }

  /** Reload tab content (for tabs marked with needsReload) */
  async reloadTabContent(path: string): Promise<boolean> {
    const tab = this._tabsById.get(path);
    if (!tab || !tab.needsReload) return false;

    try {
      // Dynamic import to avoid circular dependency
      const { api } = await import('../../api');
      const result = await api.file.read(path);

      if (result?.content !== undefined) {
        tab.content = result.content;
        tab.needsReload = false;

        const workingCopy = getWorkingCopyService().get(path);
        if (workingCopy) {
          workingCopy.originalContent = result.content;
          workingCopy.content = result.content;
        }

        this._updateTabsCache();
        this._updateActiveTabCache();

        return true;
      }
    } catch (error) {
      console.error('[EditorService] Failed to reload tab content:', path, error);
    }
    return false;
  }

  // ====== Lifecycle ======

  dispose(): void {
    this._tabsById.clear();
    this._tabOrder = [];
    this._diagnosticsById.clear();

    this._contentVersions.clear();
    this._savingVersions.clear();

    this._cachedTabs = [];
    this._cachedActiveTab = null;
    this._activeTabPath = null;

    this._activeEditorContentRelay.input = undefined;
    this._activeEditorDiagnosticsRelay.input = undefined;

    this._disposables.dispose();
  }
}
