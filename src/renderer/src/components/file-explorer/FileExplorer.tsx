/** @file FileExplorer.tsx - File Explorer main component (skeleton + hook composition) */

import { AnimatePresence } from 'framer-motion';
import { File, Folder } from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileNode } from '../../types';
import { api } from '../../api';
import {
  Commands,
  getCommandService,
  getEditorService,
  getFileExplorerService,
  getKeybindingService,
  getUIService,
  useFileTree,
  useProjectPath,
} from '../../services/core';
import { VirtualizedFileTree } from '../VirtualizedFileTree';
import { useTranslation } from '../../locales';
import { isSamePath } from '../../utils/pathComparison';

import { getParentPath } from './utils/file-path';
import { ContextMenu } from './ContextMenu';
import { InlineInput } from './InlineInput';
import { setClipboardItem } from './clipboard';
import { useFileIndexing } from './hooks/useFileIndexing';
import { useFileTreeRefresh } from './hooks/useFileTreeRefresh';
import { useFileOperations } from './hooks/useFileOperations';
import { useFileSelection } from './hooks/useFileSelection';
import { NoProjectState, LoadingSkeletonState, LoadingState, Toolbar } from './FileExplorerToolbar';

export const FileExplorer: React.FC = () => {
  const fileTree = useFileTree();
  const projectPath = useProjectPath();
  const editorService = getEditorService();
  const uiService = getUIService();
  const commandService = getCommandService();
  const keybindingService = getKeybindingService();
  const { t } = useTranslation();

  // Refs avoid stale closures inside command callbacks registered once on mount.
  const selectedNodeRef = useRef<FileNode | null>(null);
  const projectPathRef = useRef<string | null>(null);

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    node: FileNode | null;
  } | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [creatingIn, setCreatingIn] = useState<{ path: string; type: 'file' | 'folder' } | null>(
    null
  );
  const [selectedNode, setSelectedNode] = useState<FileNode | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // ====== Ref Sync Effects ======

  useEffect(() => {
    selectedNodeRef.current = selectedNode;
  }, [selectedNode]);

  useEffect(() => {
    projectPathRef.current = projectPath;
  }, [projectPath]);

  // ====== Hooks ======

  const { scheduleIndexing } = useFileIndexing(projectPath, fileTree);

  const { isRefreshing, refreshFileTree, refreshFileTreeRef } = useFileTreeRefresh({
    projectPath,
    scheduleIndexing,
  });

  const {
    handleDeleteSelected,
    handleDelete,
    handlePasteToSelected,
    handlePaste,
    handleCreateSubmit,
    handleRenameSubmit,
  } = useFileOperations({
    projectPath,
    selectedNodeRef,
    projectPathRef,
    refreshFileTreeRef,
    refreshFileTree,
    setSelectedNode,
    setRenamingPath,
  });

  const { handleFileSelect, handleResolveChildren } = useFileSelection({
    projectPath,
    setSelectedNode,
  });

  // ====== Command Registration ======

  useEffect(() => {
    const disposables = [
      commandService.registerCommand(Commands.FILE_RENAME, () => {
        const currentNode = selectedNodeRef.current;
        const currentProjectPath = projectPathRef.current;
        if (currentNode && !isSamePath(currentNode.path, currentProjectPath)) {
          setRenamingPath(currentNode.path);
        }
      }),

      commandService.registerCommand(Commands.FILE_DELETE, () => {
        const currentNode = selectedNodeRef.current;
        const currentProjectPath = projectPathRef.current;
        if (currentNode && !isSamePath(currentNode.path, currentProjectPath)) {
          void handleDeleteSelected();
        }
      }),

      commandService.registerCommand(Commands.EDIT_COPY, () => {
        const currentNode = selectedNodeRef.current;
        if (currentNode) {
          setClipboardItem({
            path: currentNode.path,
            name: currentNode.name,
            type: currentNode.type,
            operation: 'copy',
          });
          getUIService().addCompilationLog({
            type: 'info',
            message: t('fileExplorerMenu.copied', { name: currentNode.name }),
          });
        }
      }),

      commandService.registerCommand(Commands.EDIT_CUT, () => {
        const currentNode = selectedNodeRef.current;
        if (currentNode) {
          setClipboardItem({
            path: currentNode.path,
            name: currentNode.name,
            type: currentNode.type,
            operation: 'cut',
          });
          getUIService().addCompilationLog({
            type: 'info',
            message: t('fileExplorerMenu.cutted', { name: currentNode.name }),
          });
        }
      }),

      commandService.registerCommand(Commands.EDIT_PASTE, () => {
        void handlePasteToSelected();
      }),

      commandService.registerCommand(Commands.WINDOW_RELOAD, () => {
        refreshFileTreeRef.current?.();
      }),
    ];

    const keybindingDisposable = keybindingService.registerKeybindings([
      {
        commandId: Commands.FILE_RENAME,
        key: 'F2',
        when: 'filesExplorerFocus',
      },
    ]);

    return () => {
      disposables.forEach((d) => d.dispose());
      keybindingDisposable.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Command and keybinding services are stable singletons
  }, []);

  const handleFocus = useCallback(() => {
    // Reserved: keybindingService.setContext('filesExplorerFocus', true);
  }, []);

  const handleBlur = useCallback(() => {
    // Reserved: keybindingService.setContext('filesExplorerFocus', false);
  }, []);

  // ====== Context Menu Handlers ======

  const handleContextMenu = (e: React.MouseEvent, node: FileNode | null) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, node });
  };

  const handleRootContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (fileTree) {
      setContextMenu({ x: e.clientX, y: e.clientY, node: fileTree });
    }
  };

  const handleCopy = () => {
    if (!contextMenu?.node) return;
    setClipboardItem({
      path: contextMenu.node.path,
      name: contextMenu.node.name,
      type: contextMenu.node.type,
      operation: 'copy',
    });
    uiService.addCompilationLog({ type: 'info', message: `Copied: ${contextMenu.node.name}` });
  };

  const handleCut = () => {
    if (!contextMenu?.node) return;
    setClipboardItem({
      path: contextMenu.node.path,
      name: contextMenu.node.name,
      type: contextMenu.node.type,
      operation: 'cut',
    });
    uiService.addCompilationLog({ type: 'info', message: `Cut: ${contextMenu.node.name}` });
  };

  // ====== Render ======

  if (!projectPath) return <NoProjectState />;
  if (!fileTree && projectPath) return <LoadingSkeletonState />;
  if (!fileTree) return <LoadingState />;

  // ====== Drag & Drop ======

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;

    const targetDir =
      selectedNode?.type === 'directory'
        ? selectedNode.path
        : selectedNode
          ? getParentPath(selectedNode.path)
          : projectPath || '';
    if (!targetDir) return;

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      // Electron extends the File object with a `path` property for native filesystem access.
      const filePath = (file as File & { path?: string }).path;
      if (!filePath) {
        failCount++;
        continue;
      }

      try {
        const fileName = file.name;
        const destPath = `${targetDir}/${fileName}`.replace(/\\/g, '/');
        const exists = await api.file.exists(destPath);
        if (exists) {
          uiService.addCompilationLog({
            type: 'warning',
            message: `File exists, skipped: ${fileName}`,
          });
          failCount++;
          continue;
        }
        await api.file.copy(filePath, destPath);
        successCount++;
      } catch (error) {
        console.error('Failed to copy file:', error);
        failCount++;
      }
    }

    if (successCount > 0) {
      await refreshFileTree();
      uiService.addCompilationLog({
        type: 'success',
        message: `Imported ${successCount} file(s)${failCount > 0 ? `, ${failCount} failed` : ''}`,
      });
    } else if (failCount > 0) {
      uiService.addCompilationLog({
        type: 'error',
        message: `Import failed: ${failCount} file(s)`,
      });
    }
  };

  // ====== Main UI ======

  return (
    <div
      ref={containerRef}
      className="h-full flex flex-col outline-none"
      onContextMenu={handleRootContextMenu}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onFocus={handleFocus}
      onBlur={handleBlur}
      tabIndex={-1}
    >
      <Toolbar
        projectPath={projectPath}
        selectedNode={selectedNode}
        isRefreshing={isRefreshing}
        onRefresh={refreshFileTree}
        onNewFile={(path) => setCreatingIn({ path, type: 'file' })}
        onNewFolder={(path) => setCreatingIn({ path, type: 'folder' })}
      />

      {/* Create Input */}
      {creatingIn && (
        <div
          className="px-3 py-2"
          style={{
            borderBottom: '1px solid var(--color-border-subtle)',
            background: 'var(--color-bg-tertiary)',
          }}
        >
          <div className="flex items-center gap-2">
            {creatingIn.type === 'file' ? (
              <File size={14} style={{ color: 'var(--color-text-muted)' }} />
            ) : (
              <Folder size={14} style={{ color: 'var(--color-warning)' }} />
            )}
            <InlineInput
              defaultValue=""
              placeholder={creatingIn.type === 'file' ? 'File name...' : 'Folder name...'}
              onSubmit={(name) => {
                handleCreateSubmit(name, creatingIn);
                setCreatingIn(null);
              }}
              onCancel={() => setCreatingIn(null)}
            />
          </div>
        </div>
      )}

      {/* File Tree */}
      <div className="flex-1 overflow-hidden py-2">
        <VirtualizedFileTree
          fileTree={fileTree}
          selectedPath={selectedNode?.path || null}
          activeTabPath={editorService.activeTabPath}
          onSelect={handleFileSelect}
          onContextMenu={handleContextMenu}
          renamingPath={renamingPath}
          onRenameSubmit={handleRenameSubmit}
          onRenameCancel={() => setRenamingPath(null)}
          onResolveChildren={handleResolveChildren}
        />
      </div>

      {/* Context Menu */}
      <AnimatePresence>
        {contextMenu && (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            node={contextMenu.node}
            isRoot={isSamePath(contextMenu.node?.path, projectPath)}
            isRemote={false}
            onClose={() => setContextMenu(null)}
            onNewFile={() => {
              const targetPath =
                contextMenu.node?.type === 'directory'
                  ? contextMenu.node.path
                  : contextMenu.node
                    ? getParentPath(contextMenu.node.path)
                    : projectPath;
              if (targetPath) setCreatingIn({ path: targetPath, type: 'file' });
            }}
            onNewFolder={() => {
              const targetPath =
                contextMenu.node?.type === 'directory'
                  ? contextMenu.node.path
                  : contextMenu.node
                    ? getParentPath(contextMenu.node.path)
                    : projectPath;
              if (targetPath) setCreatingIn({ path: targetPath, type: 'folder' });
            }}
            onRename={() => {
              if (contextMenu.node) setRenamingPath(contextMenu.node.path);
            }}
            onDelete={() => {
              if (contextMenu.node) void handleDelete(contextMenu.node);
            }}
            onCopy={handleCopy}
            onCut={handleCut}
            onPaste={() => void handlePaste(contextMenu.node ?? null)}
            onOpenInExplorer={() => {
              const targetPath = contextMenu.node?.path || projectPath;
              if (targetPath) getFileExplorerService().showInFolder(targetPath);
            }}
            onRefresh={refreshFileTree}
          />
        )}
      </AnimatePresence>
    </div>
  );
};
