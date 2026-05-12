/**
 * @file useGlobalShortcuts.ts - Global shortcuts Hook
 * @description Handles application-level keyboard shortcuts. Coordinates with Monaco editor
 *              to avoid duplicate handling. Supports user-customizable keybindings.
 * @depends api, LogService, services/core, useDOM
 */
import { useCallback, useMemo } from 'react';
import { api } from '../api';
import { createLogger } from '../services/LogService';
import { t } from '../locales';
import { triggerOverleafSyncAfterSave } from '../utils/overleaf-sync-helper';
import {
  getEditorService,
  getOTService,
  getProjectService,
  getUIService,
  parseShortcutString,
} from '../services/core';
import { useSettings } from '../services/core/hooks';
import { useWindowEvent } from './useDOM';

const logger = createLogger('Shortcuts');

/**
 * Checks if focus is currently within Monaco editor.
 * Monaco has its own shortcut handling — skip global handling to avoid double-fire.
 */
function isMonacoEditorFocused(): boolean {
  const activeElement = document.activeElement;
  return (
    activeElement?.closest('.monaco-editor') !== null ||
    activeElement?.classList.contains('inputarea') ||
    activeElement?.classList.contains('monaco-mouse-cursor-text')
  );
}

/**
 * Matches a keyboard event against a shortcut string like "Ctrl+Shift+S".
 */
function matchesShortcut(event: KeyboardEvent, shortcutStr: string): boolean {
  const parsed = parseShortcutString(shortcutStr);
  if (!parsed) return false;

  const ctrlOrMeta = event.ctrlKey || event.metaKey;
  const expectedCtrlOrMeta = parsed.ctrl || parsed.meta;

  if (ctrlOrMeta !== expectedCtrlOrMeta) return false;
  if (event.shiftKey !== parsed.shift) return false;
  if (event.altKey !== parsed.alt) return false;

  const eventKey = event.key.toLowerCase();
  return eventKey === parsed.key;
}

// ====== Hook Implementation ======

export function useGlobalShortcuts() {
  const uiService = getUIService();
  const settings = useSettings();

  const shortcuts = useMemo(() => settings.shortcuts, [settings.shortcuts]);

  /**
   * Saves the current file with version-based conflict detection.
   * @sideeffect May show conflict dialog if file was modified externally
   */
  const saveCurrentFile = useCallback(async () => {
    const editorService = getEditorService();
    const activeTabPath = editorService.activeTabPath;

    if (!activeTabPath) return;
    const activeTab = editorService.getTab(activeTabPath);
    if (!activeTab || !activeTab.isDirty) return;

    try {
      // Local-first: every file saves locally first, then syncs to Overleaf if configured.
      const saveInfo = editorService.beginSave(activeTabPath);
      if (!saveInfo) {
        // null means save already in progress or tab doesn't exist
        return;
      }

      const result = await api.file.write(activeTabPath, saveInfo.content, saveInfo.mtime);

      if (result?.conflict) {
        logger.warn('Save conflict: file modified externally', { path: activeTabPath });
        getProjectService().setFileConflict({
          path: activeTabPath,
          type: 'change',
          hasUnsavedChanges: true,
        });
        uiService.addCompilationLog({
          type: 'warning',
          message: t('syncTeX.saveConflict', { name: activeTab.name }),
        });
        return;
      }

      if (result?.currentMtime) {
        editorService.updateFileMtime(activeTabPath, result.currentMtime);
      }

      let otSynced = true;
      if (activeTab._id) {
        const otProjectId = activeTab.projectId || getOTService().getProjectId();
        if (otProjectId) {
          otSynced = await getOTService().syncSavedContent(
            otProjectId,
            activeTab._id,
            saveInfo.content
          );
        }
      }

      let wasClean = false;
      if (otSynced) {
        wasClean = editorService.completeSave(activeTabPath, saveInfo.version);
      } else {
        editorService.finalizeSaveKeepingDirty(activeTabPath);
      }
      logger.info(`File saved: ${activeTabPath}`);

      if (!otSynced) {
        uiService.addCompilationLog({
          type: 'warning',
          message: t('syncTeX.savedOtPending', { name: activeTab.name }),
        });
      } else if (wasClean) {
        uiService.addCompilationLog({
          type: 'success',
          message: t('syncTeX.savedLocal', { name: activeTab.name }),
        });
      } else {
        uiService.addCompilationLog({
          type: 'info',
          message: t('syncTeX.savedLocalWithEdits', { name: activeTab.name }),
        });
      }

      // Overleaf local-first: sync the just-saved file to Overleaf.
      triggerOverleafSyncAfterSave({
        filePath: activeTabPath,
        content: saveInfo.content,
        fileName: activeTab.name,
        addLog: (type, message) => uiService.addCompilationLog({ type, message }),
      });
    } catch (error) {
      logger.error('Failed to save file:', error);
      uiService.addCompilationLog({
        type: 'error',
        message: t('syncTeX.saveFailedDetail', {
          error: error instanceof Error ? error.message : t('syncTeX.saveFailedUnknown'),
        }),
      });
    }
  }, [uiService]);

  const triggerCompile = useCallback(() => {
    window.dispatchEvent(new CustomEvent('trigger-compile'));
  }, []);

  // ====== Configurable Shortcuts (only when Monaco not focused) ======

  useWindowEvent('keydown', (e: KeyboardEvent) => {
    const monacoFocused = isMonacoEditorFocused();

    if (!monacoFocused && matchesShortcut(e, shortcuts.save)) {
      e.preventDefault();
      saveCurrentFile();
      return;
    }

    if (!monacoFocused && matchesShortcut(e, shortcuts.compile)) {
      e.preventDefault();
      triggerCompile();
      return;
    }

    if (!monacoFocused && matchesShortcut(e, shortcuts.commandPalette)) {
      e.preventDefault();
      uiService.setCommandPaletteOpen(true);
      return;
    }

    if (!monacoFocused && matchesShortcut(e, shortcuts.chatWithSelection)) {
      e.preventDefault();
      uiService.requestChatWithText('', 'editor');
      return;
    }

    if (!monacoFocused && matchesShortcut(e, shortcuts.togglePreview)) {
      e.preventDefault();
      const currentCollapsed = getUIService().isRightPanelCollapsed;
      uiService.setRightPanelCollapsed(!currentCollapsed);
      return;
    }

    if (!monacoFocused && matchesShortcut(e, shortcuts.newWindow)) {
      e.preventDefault();
      api.win.newWindow();
      logger.info('New window created');
      return;
    }

    // ====== Fixed Shortcuts (not configurable) ======

    // Escape closes command palette globally (even when Monaco focused)
    if (e.key === 'Escape') {
      uiService.setCommandPaletteOpen(false);
    }
  });
}
