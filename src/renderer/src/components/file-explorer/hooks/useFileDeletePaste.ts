/** @file useFileDeletePaste.ts - Delete and paste file operations */

import { useCallback, type MutableRefObject } from 'react';
import type { FileNode } from '../../../types';
import { getEditorService, getFileExplorerService, getUIService } from '../../../services/core';
import { t } from '../../../locales';
import { triggerOverleafNewFileSync } from '../../../utils/overleaf-sync-helper';
import { isSameOrChildPath } from '../../../utils/pathComparison';
import { getParentPath } from '../utils/file-path';
import { cleanupOverleafDocMapOnDelete, updateOverleafDocMapOnMove } from '../utils/overleaf-sync';
import { getClipboardItem, setClipboardItem } from '../clipboard';

interface UseFileDeletePasteOptions {
  projectPath: string | null;
  selectedNodeRef: MutableRefObject<FileNode | null>;
  projectPathRef: MutableRefObject<string | null>;
  refreshFileTreeRef: MutableRefObject<(() => Promise<void>) | null>;
  refreshFileTree: (reason?: 'manual' | 'focus' | 'auto') => Promise<void>;
  setSelectedNode: (node: FileNode | null) => void;
}

export function useFileDeletePaste({
  projectPath,
  selectedNodeRef,
  projectPathRef,
  refreshFileTreeRef,
  refreshFileTree,
  setSelectedNode,
}: UseFileDeletePasteOptions) {
  const editorService = getEditorService();
  const uiService = getUIService();

  const moveOpenTabsAfterPathMove = useCallback(
    (oldBasePath: string, newBasePath: string) => {
      const affectedTabs = editorService.tabs
        .filter((tab) => isSameOrChildPath(tab.path, oldBasePath))
        .sort((left, right) => left.path.length - right.path.length);

      for (const tab of affectedTabs) {
        const normalizedTabPath = tab.path.replace(/\\/g, '/');
        const normalizedOldBase = oldBasePath.replace(/\\/g, '/');
        const normalizedNewBase = newBasePath.replace(/\\/g, '/');
        const suffix =
          normalizedTabPath === normalizedOldBase
            ? ''
            : normalizedTabPath.slice(normalizedOldBase.length + 1);
        const nextPath = suffix ? `${normalizedNewBase}/${suffix}` : normalizedNewBase;
        editorService.moveTabPath(tab.path, nextPath);
      }
    },
    [editorService]
  );

  // ====== Delete (command-driven, operates on selectedNodeRef) ======

  const handleDeleteSelected = useCallback(async () => {
    const currentNode = selectedNodeRef.current;
    const currentProjectPath = projectPathRef.current;
    if (!currentNode) return;
    if (currentNode.path === currentProjectPath) return;

    const fileService = getFileExplorerService();

    let hasDirtyContent = false;
    if (currentNode.type === 'file') {
      const tab = editorService.getTab(currentNode.path);
      hasDirtyContent = tab?.isDirty ?? false;
    } else if (currentNode.type === 'directory') {
      const checkDirtyInDir = (n: FileNode): boolean => {
        if (n.type === 'file') {
          const tab = editorService.getTab(n.path);
          return tab?.isDirty ?? false;
        }
        return n.children ? n.children.some(checkDirtyInDir) : false;
      };
      hasDirtyContent = checkDirtyInDir(currentNode);
    }

    const result = await fileService.trashNode(
      { path: currentNode.path, name: currentNode.name, type: currentNode.type },
      { hasDirtyContent }
    );

    if (result.success) {
      if (currentNode.type === 'file') {
        if (editorService.hasTab(currentNode.path)) editorService.closeTab(currentNode.path);
      } else if (currentNode.type === 'directory' && currentNode.children) {
        const closeTabsInDir = (n: FileNode) => {
          if (n.type === 'file' && editorService.hasTab(n.path)) editorService.closeTab(n.path);
          n.children?.forEach(closeTabsInDir);
        };
        closeTabsInDir(currentNode);
      }

      uiService.addCompilationLog({
        type: 'success',
        message: t('fileOperation.movedToTrash', { name: currentNode.name }),
      });
      await cleanupOverleafDocMapOnDelete(currentNode, (type, msg) =>
        uiService.addCompilationLog({ type, message: msg })
      );
      setSelectedNode(null);
      await refreshFileTreeRef.current?.();
    } else if (result.error !== 'User cancelled') {
      uiService.addCompilationLog({
        type: 'error',
        message: result.error || t('fileOperation.deleteFailed'),
      });
    }
  }, [
    editorService,
    uiService,
    selectedNodeRef,
    projectPathRef,
    refreshFileTreeRef,
    setSelectedNode,
  ]);

  // ====== Delete (context menu, operates on given node) ======

  const handleDelete = useCallback(
    async (node: FileNode) => {
      const fileService = getFileExplorerService();

      let hasDirtyContent = false;
      if (node.type === 'file') {
        const tab = editorService.getTab(node.path);
        hasDirtyContent = tab?.isDirty ?? false;
      } else if (node.type === 'directory') {
        const checkDirtyInDir = (n: FileNode): boolean => {
          if (n.type === 'file') {
            const tab = editorService.getTab(n.path);
            return tab?.isDirty ?? false;
          }
          return n.children ? n.children.some(checkDirtyInDir) : false;
        };
        hasDirtyContent = checkDirtyInDir(node);
      }

      let result;
      result = await fileService.trashNode(
        { path: node.path, name: node.name, type: node.type },
        { hasDirtyContent }
      );

      if (result.success) {
        if (node.type === 'file') {
          if (editorService.hasTab(node.path)) editorService.closeTab(node.path);
        } else if (node.type === 'directory' && node.children) {
          const closeTabsInDir = (n: FileNode) => {
            if (n.type === 'file' && editorService.hasTab(n.path)) editorService.closeTab(n.path);
            n.children?.forEach(closeTabsInDir);
          };
          closeTabsInDir(node);
        }

        uiService.addCompilationLog({
          type: 'success',
          message: t('fileOperation.movedToTrash', { name: node.name }),
        });
        await cleanupOverleafDocMapOnDelete(node, (type, msg) =>
          uiService.addCompilationLog({ type, message: msg })
        );
        await refreshFileTree();
      } else if (result.error !== 'User cancelled') {
        uiService.addCompilationLog({
          type: 'error',
          message: result.error || t('fileOperation.deleteFailed'),
        });
      }
    },
    [editorService, uiService, refreshFileTree]
  );

  // ====== Paste (shared logic) ======

  const executePaste = useCallback(
    async (targetPath: string, refreshFn: () => Promise<void>) => {
      const fileService = getFileExplorerService();
      const currentClipboard = getClipboardItem();

      try {
        if (currentClipboard) {
          const savedItem = currentClipboard;
          const clipboardItems = [
            {
              path: savedItem.path,
              type: (savedItem.type === 'directory' ? 'directory' : 'file') as 'file' | 'directory',
              operation: savedItem.operation,
            },
          ];
          if (savedItem.operation === 'cut') {
            fileService.cutToClipboard(clipboardItems);
          } else {
            fileService.copyToClipboard(clipboardItems);
          }
          const result = await fileService.pasteFromClipboard(targetPath);
          if (result.success) {
            uiService.addCompilationLog({
              type: 'success',
              message:
                savedItem.operation === 'copy'
                  ? t('fileOperation.copied', { name: savedItem.name })
                  : t('fileOperation.moved', { name: savedItem.name }),
            });
            for (const warning of result.warnings || []) {
              uiService.addCompilationLog({ type: 'warning', message: warning });
            }
            for (const transfer of result.transferred || []) {
              if (transfer.operation !== 'cut') continue;
              moveOpenTabsAfterPathMove(transfer.sourcePath, transfer.destPath);
              if (projectPath && isSameOrChildPath(transfer.sourcePath, projectPath)) {
                const syncResult = await updateOverleafDocMapOnMove(
                  transfer.sourcePath,
                  transfer.destPath,
                  transfer.type,
                  (type, msg) => uiService.addCompilationLog({ type, message: msg })
                );
                if (!syncResult.success && !syncResult.skipped) {
                  uiService.addCompilationLog({
                    type: 'warning',
                    message: t('fileOperation.overleafMoveNotSynced', {
                      name: savedItem.name,
                      error: syncResult.error || '',
                    }),
                  });
                }
              } else {
                const syncResult = await triggerOverleafNewFileSync(
                  transfer.destPath,
                  transfer.type === 'directory'
                );
                if (!syncResult.success && !syncResult.skipped) {
                  uiService.addCompilationLog({
                    type: 'warning',
                    message: t('fileOperation.overleafNewNotSynced', {
                      name: savedItem.name,
                      error: syncResult.error || '',
                    }),
                  });
                }
              }
            }
            if (savedItem.operation === 'cut') {
              setClipboardItem(null);
            }
            await refreshFn();
          } else if (result.error) {
            uiService.addCompilationLog({ type: 'error', message: result.error });
          }
          return;
        }

        const result = await fileService.pasteFromSystemClipboard(targetPath);
        if (result.success) {
          uiService.addCompilationLog({
            type: 'success',
            message: t('fileOperation.pastedFromClipboard'),
          });
          for (const warning of result.warnings || []) {
            uiService.addCompilationLog({ type: 'warning', message: warning });
          }
          await refreshFn();
        } else if (result.error && result.error !== 'No files in system clipboard') {
          uiService.addCompilationLog({ type: 'error', message: result.error });
          for (const warning of result.warnings || []) {
            uiService.addCompilationLog({ type: 'warning', message: warning });
          }
        } else {
          uiService.addCompilationLog({ type: 'info', message: t('fileOperation.nothingToPaste') });
        }
      } catch (error) {
        uiService.addCompilationLog({
          type: 'error',
          message: t('fileOperation.pasteFailed', { error: String(error) }),
        });
      }
    },
    [uiService, moveOpenTabsAfterPathMove, projectPath]
  );

  // ====== Paste (command-driven, operates on selectedNodeRef) ======

  const handlePasteToSelected = useCallback(async () => {
    const currentNode = selectedNodeRef.current;
    const currentProjectPath = projectPathRef.current;
    const targetPath =
      currentNode?.type === 'directory'
        ? currentNode.path
        : currentNode
          ? getParentPath(currentNode.path)
          : currentProjectPath;
    if (!targetPath) return;
    await executePaste(targetPath, async () => {
      await refreshFileTreeRef.current?.();
    });
  }, [selectedNodeRef, projectPathRef, refreshFileTreeRef, executePaste]);

  // ====== Paste (context menu, operates on given node/path) ======

  const handlePaste = useCallback(
    async (contextNode: FileNode | null) => {
      const targetPath =
        contextNode?.type === 'directory'
          ? contextNode.path
          : contextNode
            ? getParentPath(contextNode.path)
            : projectPath;
      if (!targetPath) return;
      await executePaste(targetPath, async () => {
        await refreshFileTree();
      });
    },
    [projectPath, executePaste, refreshFileTree]
  );

  return {
    handleDeleteSelected,
    handleDelete,
    handlePasteToSelected,
    handlePaste,
  };
}
