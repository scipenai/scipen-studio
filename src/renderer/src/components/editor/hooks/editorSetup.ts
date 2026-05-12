/**
 * @file editorSetup.ts - Editor Initialization Config
 * @description Editor mount setup functions including cursor tracking, scroll sync features
 */

import type { Monaco } from '@monaco-editor/react';
import type * as monaco from 'monaco-editor';
import { startTransition } from 'react';
import { api } from '../../../api';
import { t } from '../../../locales';
import { triggerOverleafSyncAfterSave } from '../../../utils/overleaf-sync-helper';
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
import { getSyncTeXService } from '../../../services/SyncTeXService';
import {
  getEditorService,
  getOTService,
  getSettingsService,
  getShortcutService,
  getUIService,
} from '../../../services/core';
import { SyncEventType } from '../../../services/core/PreviewTypes';

const logger = createLogger('EditorSetup');

type Editor = monaco.editor.IStandaloneCodeEditor;

export function setupCursorTracking(editor: Editor): void {
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
 * Setup scroll event listeners (LSP performance optimization + preview scroll sync)
 * @returns Disposable for the preview-to-editor listener (must be disposed when editor is destroyed)
 */
export function setupScrollTracking(editor: Editor): { dispose: () => void } {
  editor.onDidScrollChange(() => {
    LSPService.notifyScrollStart();
    LSPService.notifyScrollEnd();

    // Fire scroll-to-line event for Markdown preview sync
    const uiService = getUIService();
    if (uiService.previewMode === 'markdown') {
      const visibleRange = editor.getVisibleRanges()[0];
      if (visibleRange) {
        uiService.fireEditorToPreview({
          type: SyncEventType.SCROLL_TO_LINE,
          line: visibleRange.startLineNumber,
        });
      }
    }
  });

  // Listen for preview-to-editor click events
  const uiService = getUIService();
  const previewDisposable = uiService.onDidPreviewToEditor((event) => {
    if (event.type === SyncEventType.CLICK_TO_SOURCE && event.line != null) {
      editor.revealLineInCenter(event.line);
      editor.setPosition({ lineNumber: event.line, column: event.column ?? 1 });
      editor.focus();
    }
  });

  return previewDisposable;
}

/**
 * Setup file content change tracking
 * Note: Does not depend on external activeTabPath, dynamically gets path from model URI
 */
export function setupContentChangeTracking(
  editor: Editor,
  isProgrammaticUpdateRef?: { readonly current: boolean }
): void {
  editor.onDidChangeModelContent((event) => {
    const model = editor.getModel();
    if (!model) return;

    // Skip OT and content updates during programmatic changes (e.g. remote OT)
    if (isProgrammaticUpdateRef?.current) return;

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

    // Forward changes to OT service when collaboration is active
    const otService = getOTService();

    if (otService.isActive) {
      const changes = event.changes.map((change) => ({
        rangeOffset: change.rangeOffset,
        rangeLength: change.rangeLength,
        text: change.text,
      }));
      // modelValueLengthBefore = content length before changes
      // event.changes describe what changed in the original text, so baseLength = current - net delta
      const netDelta = event.changes.reduce((sum, c) => sum + c.text.length - c.rangeLength, 0);
      const baseLength = content.length - netDelta;
      otService.applyLocalChange(changes, baseLength);
    }

    resetPartialAccept();
  });
}

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

  if (!uiService.pdfData && !uiService.pdfPath) {
    uiService.addCompilationLog({ type: 'warning', message: t('syncTeX.compilePdfFirst') });
    return;
  }

  performLocalSyncTeX(lineNumber, column, uiService);
}

function performLocalSyncTeX(
  lineNumber: number,
  column: number,
  uiService: ReturnType<typeof getUIService>
): void {
  const editorService = getEditorService();
  const currentPath = editorService.activeTabPath;
  const synctexPath = uiService.synctexPath;

  if (!currentPath) {
    uiService.addCompilationLog({ type: 'warning', message: t('syncTeX.compileFirst') });
    return;
  }

  const syncTeXService = getSyncTeXService();
  syncTeXService.forward(currentPath, lineNumber, column, synctexPath).then((result) => {
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

  shortcutService.registerHandler('chatWithSelection', () => {
    const selection = editor.getSelection();
    const model = editor.getModel();
    const selectedText =
      selection && !selection.isEmpty() && model ? model.getValueInRange(selection) : '';
    getUIService().requestChatWithText(selectedText, 'editor');
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

/**
 * Save current file (local-first: every file goes through local save + Overleaf sync).
 */
async function handleSaveCommand(): Promise<void> {
  const editorService = getEditorService();
  const uiService = getUIService();
  const currentTab = editorService.tabs.find((tab) => tab.path === editorService.activeTabPath);

  if (!currentTab || !editorService.activeTabPath) return;

  const path = editorService.activeTabPath;

  if (!currentTab.isDirty) return;

  try {
    const saveInfo = editorService.beginSave(path);
    if (!saveInfo) return;

    await api.file.write(path, saveInfo.content);

    let otSynced = true;
    if (currentTab._id) {
      const otProjectId = currentTab.projectId || getOTService().getProjectId();
      if (otProjectId) {
        otSynced = await getOTService().syncSavedContent(
          otProjectId,
          currentTab._id,
          saveInfo.content
        );
      }
    }

    let wasClean = false;
    if (otSynced) {
      wasClean = editorService.completeSave(path, saveInfo.version);
    } else {
      editorService.finalizeSaveKeepingDirty(path);
    }

    if (!otSynced) {
      uiService.addCompilationLog({
        type: 'warning',
        message: t('syncTeX.savedLocalWithEdits', { name: currentTab.name }),
      });
    } else if (wasClean) {
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

    // Overleaf local-first: push the saved content to Overleaf
    triggerOverleafSyncAfterSave({
      filePath: path,
      content: saveInfo.content,
      fileName: currentTab.name,
      addLog: (type, message) => uiService.addCompilationLog({ type, message }),
    });
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
