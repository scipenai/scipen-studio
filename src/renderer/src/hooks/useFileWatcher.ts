/**
 * @file useFileWatcher.ts - File watcher Hook
 * @description Watches for external file modifications and handles conflicts.
 *              Uses debounce strategy and version tracking to protect data integrity.
 * @depends api, LogService, EditorService, ProjectService, useEvent
 */
import { startTransition, useCallback, useEffect, useRef } from 'react';
import { api } from '../api';
import { createLogger } from '../services/LogService';
import { getEditorService, getProjectService } from '../services/core';
import { useEvent, useIpcEvent } from './useEvent';

const logger = createLogger('FileWatcher');

// Why 500ms: Matches VSCode's EXPLORER_FILE_CHANGES_REACT_DELAY to batch rapid file events
const FILE_CHANGE_DEBOUNCE_MS = 500;

// Prevents duplicate reloads when multiple change events fire for the same file
const reloadingFiles = new Set<string>();

/**
 * Safely reloads a file from disk with race condition protection.
 *
 * @sideeffect May show conflict dialog if user edited during reload
 * @sideeffect Updates editor content and mtime on success
 *
 * Why version checking: During async file read, user may continue typing.
 * Without this check, we'd silently overwrite their unsaved changes - data loss risk.
 */
async function safeReloadFile(
  filePath: string,
  editorService: ReturnType<typeof getEditorService>,
  log: typeof logger
): Promise<void> {
  if (reloadingFiles.has(filePath)) {
    log.debug('File reload already in progress, skipping:', filePath);
    return;
  }

  reloadingFiles.add(filePath);

  try {
    const versionBeforeReload = editorService.getContentVersion(filePath);

    const result = await api.file.read(filePath);
    if (result === undefined) {
      log.warn('Failed to read file content:', filePath);
      return;
    }
    const content = result.content;

    const versionAfterReload = editorService.getContentVersion(filePath);
    const tab = editorService.getTab(filePath);

    if (versionAfterReload > versionBeforeReload || tab?.isDirty) {
      // User edited during reload - show conflict dialog instead of silent overwrite
      log.warn('Edit detected during reload, showing conflict dialog:', filePath);
      startTransition(() => {
        getProjectService().setFileConflict({
          path: filePath,
          type: 'change',
          hasUnsavedChanges: true,
        });
      });
      return;
    }

    // Safe to reload - no concurrent edits detected
    startTransition(() => {
      editorService.setContentFromExternal(filePath, content);
      // Update mtime to prevent false conflict on next save
      if (result.mtime) {
        editorService.updateFileMtime(filePath, result.mtime);
      }
    });

    log.info('File safely reloaded:', filePath);
  } catch (error) {
    log.error('Silent file reload failed:', error);
  } finally {
    reloadingFiles.delete(filePath);
  }
}

// ====== Hook Implementation ======

export function useFileWatcher() {
  const projectService = getProjectService();
  const editorService = getEditorService();
  const projectPath = projectService.projectPath;

  // Why ref: Avoid re-subscribing to events when tabs change - handlers read latest value
  const openTabsRef = useRef(editorService.tabs);

  // Why batching: Prevents UI thrashing when returning to window with many pending changes
  const pendingChangesRef = useRef<Map<string, { type: string; path: string }>>(new Map());
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEvent(editorService.onDidAddTab, () => {
    openTabsRef.current = editorService.tabs;
  });

  useEvent(editorService.onDidRemoveTab, () => {
    openTabsRef.current = editorService.tabs;
  });

  const processPendingChanges = useCallback(() => {
    const changes = Array.from(pendingChangesRef.current.values());
    pendingChangesRef.current.clear();

    if (changes.length === 0) return;

    logger.info(`Batch processing ${changes.length} file change events`);

    // Process file tree updates first - single UI update after batching
    const treeChanges = changes.filter((c) => c.type === 'add' || c.type === 'unlink');
    for (const change of treeChanges) {
      projectService.applyFileChange({
        type: change.type as 'add' | 'unlink',
        path: change.path,
      });
    }

    const currentOpenTabs = openTabsRef.current;

    for (const change of changes) {
      const { type, path: changedPath } = change;
      const affectedTab = currentOpenTabs.find((tab) => tab.path === changedPath);

      if (!affectedTab) continue;

      if (type === 'unlink') {
        startTransition(() => {
          projectService.setFileConflict({
            path: changedPath,
            type: 'unlink',
            hasUnsavedChanges: affectedTab.isDirty,
          });
        });
      } else if (type === 'change') {
        if (affectedTab.isDirty) {
          // Has unsaved local changes - let user decide via conflict dialog
          startTransition(() => {
            projectService.setFileConflict({
              path: changedPath,
              type: 'change',
              hasUnsavedChanges: true,
            });
          });
        } else {
          safeReloadFile(changedPath, editorService, logger);
        }
      }
    }
  }, [projectService, editorService]);

  const handleFileChanged = useCallback(
    (event: { type: string; path: string }) => {
      // Skip Overleaf projects - they have their own sync mechanism
      if (
        !projectPath ||
        projectPath.startsWith('overleaf://') ||
        projectPath.startsWith('overleaf:')
      ) {
        return;
      }

      logger.debug('Received file change event:', event);

      // Dedupe by path - later events overwrite earlier ones
      pendingChangesRef.current.set(event.path, event);

      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }

      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        processPendingChanges();
      }, FILE_CHANGE_DEBOUNCE_MS);
    },
    [projectPath, processPendingChanges]
  );

  useEffect(() => {
    const pendingChanges = pendingChangesRef.current;
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      pendingChanges.clear();
    };
  }, []);

  useIpcEvent(api.fileWatcher.onFileChanged, handleFileChanged);
}
