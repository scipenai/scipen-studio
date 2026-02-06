/**
 * @file editorSetup.ts - Editor Initialization Config
 * @description Editor mount setup functions including cursor tracking, scroll sync features
 */

import type { Monaco } from '@monaco-editor/react';
import type * as monaco from 'monaco-editor';
import { startTransition } from 'react';
import { api } from '../../../api';
import { t } from '../../../locales';
import {
  getNextWordFromSuggestion,
  resetPartialAccept,
  updateFileIndex,
} from '../../../services/InlineCompletionService';
import {
  LSPService,
  getLanguageId,
  isLSPSupportedFile,
  normalizeModelPath,
} from '../../../services/LSPService';
import { createLogger } from '../../../services/LogService';
import {
  getEditorService,
  getProjectService,
  getSettingsService,
  getShortcutService,
  getUIService,
} from '../../../services/core';
import type { EditorTab } from '../../../types';

const logger = createLogger('EditorSetup');

type Editor = monaco.editor.IStandaloneCodeEditor;

export function setupCursorTracking(editor: Editor): void {
  // Why: Use startTransition to avoid blocking input during cursor position updates
  editor.onDidChangeCursorPosition((e) => {
    startTransition(() => {
      getEditorService().setCursorPosition(e.position.lineNumber, e.position.column);
    });
  });

  editor.onDidChangeCursorSelection((e) => {
    const sel = e.selection;
    startTransition(() => {
      if (sel.isEmpty()) {
        getEditorService().setSelection(null);
      } else {
        getEditorService().setSelection({
          startLine: sel.startLineNumber,
          startColumn: sel.startColumn,
          endLine: sel.endLineNumber,
          endColumn: sel.endColumn,
        });
      }
    });
  });
}

/**
 * Setup scroll event listeners (LSP performance optimization)
 */
export function setupScrollTracking(editor: Editor): void {
  editor.onDidScrollChange(() => {
    LSPService.notifyScrollStart();
    LSPService.notifyScrollEnd();
  });
}

/**
 * Setup file content change tracking
 * Note: Does not depend on external activeTabPath, dynamically gets path from model URI
 */
export function setupContentChangeTracking(editor: Editor): void {
  editor.onDidChangeModelContent((event) => {
    const model = editor.getModel();
    if (!model) return;

    // Why: Normalize model URI path for consistent file path handling
    const filePath = normalizeModelPath(model.uri.path);
    const content = model.getValue();

    updateFileIndex(filePath, content);

    if (LSPService.isRunning() && isLSPSupportedFile(filePath)) {
      const changes = event.changes.map((change) => ({
        range: change.range,
        rangeLength: change.rangeLength,
        text: change.text,
      }));
      LSPService.updateDocumentIncremental(filePath, changes);
    }

    resetPartialAccept();
  });
}

// Why: Debounce timer prevents rapid repeated SyncTeX triggers (e.g., double-click or duplicate events)
let syncTexDebounceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Performs SyncTeX forward sync (from source code to PDF)
 */
function performSyncTexForward(lineNumber: number, column: number): void {
  if (syncTexDebounceTimer) {
    clearTimeout(syncTexDebounceTimer);
  }

  syncTexDebounceTimer = setTimeout(() => {
    PerformSyncTexForwardFormatted(lineNumber, column);
  }, 300);
}

function PerformSyncTexForwardFormatted(lineNumber: number, column: number): void {
  const uiService = getUIService();
  const settingsService = getSettingsService();
  const projectService = getProjectService();
  const projectPath = projectService.projectPath;

  if (!uiService.pdfData && !uiService.pdfPath) {
    uiService.addCompilationLog({ type: 'warning', message: t('syncTeX.compilePdfFirst') });
    return;
  }

  const isRemote = projectPath?.startsWith('overleaf://') || projectPath?.startsWith('overleaf:');

  if (isRemote) {
    performRemoteSyncTeX(lineNumber, column, uiService, settingsService);
  } else {
    performLocalSyncTeX(lineNumber, column, uiService);
  }
}

function performRemoteSyncTeX(
  lineNumber: number,
  column: number,
  uiService: ReturnType<typeof getUIService>,
  settingsService: ReturnType<typeof getSettingsService>
): void {
  const remoteBuildId = uiService.remoteBuildId;
  if (!remoteBuildId) {
    uiService.addCompilationLog({ type: 'warning', message: t('syncTeX.compileFirst') });
    return;
  }

  const editorService = getEditorService();
  const currentPath = editorService.activeTabPath;
  if (!currentPath) return;

  const projectId = settingsService.compiler.overleaf?.projectId;
  if (!projectId) {
    uiService.addCompilationLog({ type: 'warning', message: t('syncTeX.missingProjectId') });
    return;
  }

  let filePath = currentPath;
  const match = currentPath.match(/^overleaf:\/\/[^/]+\/(.+)$/);
  if (match) {
    filePath = match[1];
  }

  api.overleaf.syncCode(projectId, filePath, lineNumber, column, remoteBuildId).then((result) => {
    if (result && result.length > 0) {
      const pos = result[0];
      uiService.setPdfHighlight({
        page: pos.page || 1,
        x: pos.h,
        y: pos.v,
        width: pos.width || 50,
        height: pos.height || 20,
      });
      uiService.addCompilationLog({
        type: 'info',
        message: t('syncTeX.jumpToPage', { page: String(pos.page) }),
      });
    }
  });
}

function performLocalSyncTeX(
  lineNumber: number,
  column: number,
  uiService: ReturnType<typeof getUIService>
): void {
  const synctexPath = uiService.synctexPath;
  const editorService = getEditorService();
  const currentPath = editorService.activeTabPath;

  if (!currentPath || !synctexPath) {
    uiService.addCompilationLog({ type: 'warning', message: t('syncTeX.compileFirst') });
    return;
  }

  api.synctex.forward(currentPath, lineNumber, column, synctexPath).then((result) => {
    if (result) {
      uiService.setPdfHighlight({
        page: result.page || 1,
        x: result.x || 0,
        y: result.y || 0,
        width: result.width || 50,
        height: result.height || 20,
      });
      uiService.addCompilationLog({
        type: 'info',
        message: t('syncTeX.jumpToPage', { page: String(result.page) }),
      });
    }
  });
}

export function setupSyncTexClick(editor: Editor): void {
  editor.onMouseDown((e: monaco.editor.IEditorMouseEvent) => {
    if (e.event.ctrlKey && e.target.position) {
      const { lineNumber, column } = e.target.position;
      performSyncTexForward(lineNumber, column);
    }
  });
}

/**
 * Setup keyboard shortcuts
 *
 * Uses ShortcutService to register configurable shortcuts,
 * while keeping some fixed editor shortcuts (e.g., partial accept, SyncTeX).
 *
 * Note: These shortcuts take effect when editor is focused.
 * Global shortcuts are handled by useGlobalShortcuts hook (when editor is not focused).
 */
export function setupShortcuts(editor: Editor, monacoInstance: Monaco): void {
  const shortcutService = getShortcutService();
  const settingsService = getSettingsService();
  const uiService = getUIService();

  shortcutService.initialize(monacoInstance, editor);

  // ====== Register Shortcut Handlers ======

  shortcutService.registerHandler('save', handleSaveCommand);

  shortcutService.registerHandler('compile', () => {
    const compileButton = document.querySelector('[data-compile-button]') as HTMLButtonElement;
    compileButton?.click();
  });

  shortcutService.registerHandler('commandPalette', () => {
    uiService.setCommandPaletteOpen(true);
  });

  shortcutService.registerHandler('aiPolish', () => {
    window.dispatchEvent(new CustomEvent('trigger-ai-polish'));
  });

  shortcutService.registerHandler('aiChat', () => {
    uiService.setSidebarTab('ai');
    uiService.setSidebarCollapsed(false);
  });

  shortcutService.registerHandler('togglePreview', () => {
    const currentCollapsed = uiService.isRightPanelCollapsed;
    uiService.setRightPanelCollapsed(!currentCollapsed);
  });

  shortcutService.registerHandler('newWindow', () => {
    api.win.newWindow();
    logger.info('New window created');
  });

  // ====== Register Shortcut Bindings ======

  // Read shortcuts from settings and register them
  const shortcuts = settingsService.shortcuts;
  shortcutService.registerShortcuts(shortcuts);

  // Fixed shortcut: Ctrl+Right for partial AI suggestion acceptance (not configurable)
  editor.addCommand(monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.RightArrow, () => {
    handlePartialAccept(editor);
  });

  // Fixed shortcut: Ctrl+Shift+J for SyncTeX jump (not configurable)
  editor.addCommand(
    monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyMod.Shift | monacoInstance.KeyCode.KeyJ,
    () => {
      const position = editor.getPosition();
      if (position) {
        performSyncTexForward(position.lineNumber, position.column);
      }
    }
  );

  // Listen for settings changes and dynamically update shortcuts
  settingsService.onDidChangeSettings((newSettings) => {
    shortcutService.registerShortcuts(newSettings.shortcuts);
  });
}

async function handleSaveCommand(): Promise<void> {
  const editorService = getEditorService();
  const settingsService = getSettingsService();
  const uiService = getUIService();
  const currentTab = editorService.tabs.find((t) => t.path === editorService.activeTabPath);

  if (!currentTab || !editorService.activeTabPath) return;

  try {
    const isRemoteFile =
      editorService.activeTabPath.startsWith('overleaf://') ||
      editorService.activeTabPath.startsWith('overleaf:');

    if (isRemoteFile) {
      await saveRemoteFile(currentTab, editorService, settingsService, uiService);
    } else {
      await saveLocalFile(currentTab, editorService, uiService);
    }
  } catch (error) {
    logger.error(t('syncTeX.saveFailed'), error);
    uiService.addCompilationLog({
      type: 'error',
      message: t('syncTeX.saveFailedDetail', {
        error: error instanceof Error ? error.message : t('syncTeX.saveFailedUnknown'),
      }),
    });
  }
}

/**
 * Save remote file (versioned save to prevent race conditions)
 *
 * 🔧 P3 fix: Uses beginSave/completeSave instead of deprecated markClean
 */
async function saveRemoteFile(
  currentTab: EditorTab,
  editorService: ReturnType<typeof getEditorService>,
  settingsService: ReturnType<typeof getSettingsService>,
  uiService: ReturnType<typeof getUIService>
): Promise<void> {
  const projectId = settingsService.compiler.overleaf?.projectId;
  if (!projectId) {
    uiService.addCompilationLog({ type: 'error', message: t('syncTeX.remoteProjectIdNotFound') });
    return;
  }

  const docId = currentTab._id;
  if (!docId) {
    uiService.addCompilationLog({ type: 'error', message: t('syncTeX.docIdNotFound') });
    return;
  }

  const path = editorService.activeTabPath!;

  if (!currentTab.isDirty) {
    return;
  }

  // Why: Version tracking prevents race conditions when user continues editing during async save
  const saveInfo = editorService.beginSave(path);
  if (!saveInfo) {
    return;
  }

  // Why: Async save allows user to continue editing during save operation
  const result = await api.overleaf.updateDoc(projectId, docId, saveInfo.content);
  if (!result?.success) {
    throw new Error(result?.error || 'Failed to save remote file');
  }

  // Why: Only mark as clean if no new edits occurred during save
  const wasClean = editorService.completeSave(path, saveInfo.version);

  if (wasClean) {
    uiService.addCompilationLog({
      type: 'success',
      message: t('syncTeX.savedRemote', { name: currentTab.name }),
    });
  } else {
    uiService.addCompilationLog({
      type: 'info',
      message: t('syncTeX.savedRemoteWithEdits', { name: currentTab.name }),
    });
  }
}

/**
 * Save local file (versioned save to prevent race conditions)
 */
async function saveLocalFile(
  currentTab: EditorTab,
  editorService: ReturnType<typeof getEditorService>,
  uiService: ReturnType<typeof getUIService>
): Promise<void> {
  const path = editorService.activeTabPath!;

  if (!currentTab.isDirty) {
    return;
  }

  // Why: Version tracking prevents race conditions when user continues editing during async save
  const saveInfo = editorService.beginSave(path);
  if (!saveInfo) {
    return;
  }

  // Why: Async save allows user to continue editing during save operation
  await api.file.write(path, saveInfo.content);

  // Why: Only mark as clean if no new edits occurred during save
  const wasClean = editorService.completeSave(path, saveInfo.version);

  if (wasClean) {
    uiService.addCompilationLog({
      type: 'success',
      message: t('syncTeX.savedLocal', { name: currentTab.name }),
    });
  } else {
    uiService.addCompilationLog({
      type: 'info',
      message: t('syncTeX.savedLocalWithEdits', { name: currentTab.name }),
    });
  }
}

function handlePartialAccept(editor: Editor): void {
  const word = getNextWordFromSuggestion();
  if (word) {
    const position = editor.getPosition();
    if (position) {
      editor.executeEdits('partial-accept', [
        {
          range: {
            startLineNumber: position.lineNumber,
            startColumn: position.column,
            endLineNumber: position.lineNumber,
            endColumn: position.column,
          },
          text: word,
        },
      ]);
      editor.setPosition({
        lineNumber: position.lineNumber,
        column: position.column + word.length,
      });
    }
  } else {
    editor.trigger('keyboard', 'cursorWordEndRight', null);
  }
}

/**
 * Initialize LSP document synchronization
 * Dynamically gets file path from model URI
 */
export function initializeLSPDocument(editor: Editor): void {
  const model = editor.getModel();
  if (!model || !LSPService.isRunning()) return;

  const filePath = normalizeModelPath(model.uri.path);
  if (isLSPSupportedFile(filePath)) {
    LSPService.openDocument(filePath, model.getValue(), getLanguageId(filePath));
  }
}
