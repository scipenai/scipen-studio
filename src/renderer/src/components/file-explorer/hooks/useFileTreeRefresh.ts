/**
 * @file useFileTreeRefresh.ts - File tree refresh hook
 * @description Handles manual/auto/focus-triggered refresh of the file tree from local FS or OT.
 * Also refreshes active tab content when externally modified.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../../api';
import {
  TaskPriority,
  cancelIdleTask,
  getEditorService,
  getOTService,
  getUIService,
  scheduleIdleTask,
} from '../../../services/core';
import { useInterval } from '../../../hooks';

export type RefreshReason = 'manual' | 'focus' | 'auto';

interface UseFileTreeRefreshOptions {
  projectPath: string | null;
  collaborationProjectId: string | null;
  scheduleIndexing: (tree: import('../../../types').FileNode | null, reason: string) => void;
}

export function useFileTreeRefresh({
  projectPath,
  collaborationProjectId,
  scheduleIndexing,
}: UseFileTreeRefreshOptions) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshFileTreeRef = useRef<(() => Promise<void>) | null>(null);
  const editorService = getEditorService();
  const uiService = getUIService();

  const refreshFileTree = useCallback(
    async (reason: RefreshReason = 'manual') => {
      if (!projectPath) return;
      const projectService = (await import('../../../services/core')).getProjectService();
      const shouldRebuildIndex = reason === 'manual';

      setIsRefreshing(true);
      try {
        if (collaborationProjectId) {
          const tree = await getOTService().getProjectTree(projectPath, collaborationProjectId);
          projectService.setProject(projectPath, tree, { rebuildIndex: shouldRebuildIndex });
          scheduleIndexing(tree, 'refresh');
          return;
        }

        if (!api.file.refreshTree) return;

        const result = await api.file.refreshTree(projectPath);
        if (result.success && result.fileTree) {
          projectService.setProject(projectPath, result.fileTree, {
            rebuildIndex: shouldRebuildIndex,
          });
          scheduleIndexing(result.fileTree, 'refresh');
        }

        // Refresh active tab content if externally modified
        const activeTab = editorService.activeTab;

        if (activeTab && !activeTab.isDirty) {
          try {
            if (collaborationProjectId && activeTab._id) {
              const file = await getOTService().getProjectFile(
                collaborationProjectId,
                activeTab._id
              );
              if (file.content !== activeTab.content) {
                editorService.setContentFromExternal(activeTab.path, file.content);
              }
            } else {
              const result = await api.file.read(activeTab.path);
              if (result !== undefined && result.content !== activeTab.content) {
                console.info('[FileExplorer] Refreshing file content:', activeTab.path);
                editorService.setContentFromExternal(activeTab.path, result.content);
                editorService.updateFileMtime(activeTab.path, result.mtime);
              }
            }
          } catch (e) {
            console.warn('[FileExplorer] Failed to refresh file content:', e);
          }
        }
      } catch (error) {
        console.error('Refresh failed:', error);
        uiService.addCompilationLog({
          type: 'error',
          message: `Failed to refresh file tree: ${error}`,
        });
      } finally {
        setIsRefreshing(false);
      }
    },
    [collaborationProjectId, projectPath, uiService, editorService, scheduleIndexing]
  );

  useEffect(() => {
    refreshFileTreeRef.current = refreshFileTree;
  }, [refreshFileTree]);

  // OT file event listener
  useEffect(() => {
    const otService = getOTService();
    const disposable = otService.onDidReceiveFileEvent((event) => {
      if (event.projectId === collaborationProjectId) {
        refreshFileTreeRef.current?.();
      }
    });
    return () => {
      disposable.dispose();
    };
  }, [collaborationProjectId]);

  // Local-first: Overleaf projects run on local OT, so tree refreshes ride the standard OT pipeline.
  // We no longer subscribe to OverleafLiveService.onDidReceiveTree.

  // ====== Auto Refresh ======

  // Long interval as fallback; incremental updates cover most changes.
  const shouldAutoRefresh = projectPath && !isRefreshing;
  useInterval(
    () => {
      refreshFileTree('auto');
    },
    shouldAutoRefresh ? 60000 : null
  );

  const lastFocusRefreshRef = useRef<number>(0);
  useEffect(() => {
    const handleFocus = () => {
      const now = Date.now();
      const MIN_FOCUS_REFRESH_INTERVAL = 15000;

      if (shouldAutoRefresh && now - lastFocusRefreshRef.current > MIN_FOCUS_REFRESH_INTERVAL) {
        lastFocusRefreshRef.current = now;

        scheduleIdleTask(
          () => {
            refreshFileTree('focus');
          },
          {
            id: 'file-tree-focus-refresh',
            priority: TaskPriority.Normal,
            timeout: 5000,
          }
        );
      }
    };

    window.addEventListener('focus', handleFocus);
    return () => {
      window.removeEventListener('focus', handleFocus);
      cancelIdleTask('file-tree-focus-refresh');
    };
  }, [shouldAutoRefresh, refreshFileTree]);

  return {
    isRefreshing,
    refreshFileTree,
    refreshFileTreeRef,
  };
}
