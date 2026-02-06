/**
 * @file FileExplorer.tsx - File Explorer
 * @description Project file tree browsing with create, rename, delete, upload operations. Supports both local and Overleaf remote projects
 * @depends api, services/core, VirtualizedFileTree, framer-motion
 */

import { clsx } from 'clsx';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Clipboard,
  Cloud,
  Copy,
  Download,
  Edit3,
  ExternalLink,
  File,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import type React from 'react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FileNode } from '../types';

// ====== Overleaf Types ======

interface OverleafDoc {
  _id: string;
  name: string;
}

interface OverleafFileRef {
  _id: string;
  name: string;
}

interface OverleafFolder {
  _id?: string;
  name: string;
  docs?: OverleafDoc[];
  fileRefs?: OverleafFileRef[];
  folders?: OverleafFolder[];
}
import { api } from '../api';
import { useClickOutside, useEscapeKey, useInterval, useRequestAnimationFrame } from '../hooks';
import { updateFileIndex } from '../services/InlineCompletionService';
import {
  Commands,
  TaskPriority,
  cancelIdleTask,
  cancelIdleTasksByPrefix,
  getCommandService,
  getEditorService,
  getFileExplorerService,
  getKeybindingService,
  getProjectService,
  getUIService,
  scheduleIdleTask,
  useFileTree,
  useProjectPath,
} from '../services/core';
import { validateFileName } from '../utils/fileValidation';
import { VirtualizedFileTree } from './VirtualizedFileTree';
import { useTranslation } from '../locales';
import { FileTreeSkeleton } from './ui/Skeleton';

// ====== Path Utilities ======

/**
 * Checks if path is an Overleaf remote path.
 * @sideeffect None
 */
const isRemotePath = (path: string): boolean => {
  if (!path) return false;
  return path.startsWith('overleaf://') || path.startsWith('overleaf:');
};

/**
 * Extracts project ID from Overleaf path.
 * Why: Windows path separator may convert overleaf://id to overleaf:\id
 */
const getProjectIdFromPath = (path: string): string | null => {
  if (!isRemotePath(path)) return null;
  let match = path.match(/^overleaf:\/\/([^/]+)/);
  if (match) return match[1];
  match = path.match(/^overleaf:[\\/]?([^\\/]+)/);
  return match ? match[1] : null;
};

// ====== Clipboard State ======

// Why: Module-level state for internal copy/cut operations (not system clipboard)
let clipboardItem: {
  path: string;
  name: string;
  type: 'file' | 'directory';
  operation: 'copy' | 'cut';
} | null = null;

// ====== Context Menu Component ======

interface ContextMenuProps {
  x: number;
  y: number;
  node: FileNode | null;
  isRoot: boolean;
  isRemote: boolean;
  onClose: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
  onRename: () => void;
  onDelete: () => void;
  onCopy: () => void;
  onCut: () => void;
  onPaste: () => void;
  onOpenInExplorer: () => void;
  onRefresh: () => void;
}

const ContextMenu = memo<ContextMenuProps>(
  ({
    x,
    y,
    isRoot,
    isRemote,
    onClose,
    onNewFile,
    onNewFolder,
    onRename,
    onDelete,
    onCopy,
    onCut,
    onPaste,
    onOpenInExplorer,
    onRefresh,
  }) => {
    const menuRef = useRef<HTMLDivElement>(null);
    const { t } = useTranslation();

    useClickOutside(menuRef, onClose);
    useEscapeKey(onClose);

    // Why: Prevent menu from overflowing viewport
    const adjustedY = Math.min(y, window.innerHeight - 300);
    const adjustedX = Math.min(x, window.innerWidth - 200);

    const MenuItem: React.FC<{
      icon: React.ReactNode;
      label: string;
      onClick: () => void;
      danger?: boolean;
      disabled?: boolean;
    }> = ({ icon, label, onClick, danger, disabled }) => (
      <button
        onClick={() => {
          onClick();
          onClose();
        }}
        disabled={disabled}
        className={clsx(
          'w-full flex items-center gap-2 px-3 py-1.5 text-[13px] transition-all duration-150 cursor-pointer',
          disabled && 'opacity-30 cursor-not-allowed'
        )}
        style={{
          color: danger ? 'var(--color-error)' : 'var(--color-text-primary)',
          background: 'transparent',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = danger
            ? 'var(--color-error-muted)'
            : 'var(--color-bg-hover)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
        }}
      >
        <span
          style={{ color: danger ? 'var(--color-error)' : 'var(--color-text-muted)', opacity: 0.7 }}
        >
          {icon}
        </span>
        <span className="flex-1 text-left">{label}</span>
      </button>
    );

    const Divider = () => (
      <div className="h-px my-1 mx-1" style={{ background: 'var(--color-border-subtle)' }} />
    );

    return (
      <motion.div
        ref={menuRef}
        initial={{ opacity: 0, scale: 0.98, y: -5 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.98, y: -5 }}
        transition={{ duration: 0.15, type: 'spring', stiffness: 400, damping: 30 }}
        className="fixed z-[100] backdrop-blur-md rounded-xl shadow-2xl py-1.5 min-w-[200px] overflow-hidden"
        style={{
          left: adjustedX,
          top: adjustedY,
          background: 'var(--color-bg-elevated)',
          border: '1px solid var(--color-border)',
        }}
      >
        <MenuItem
          icon={<Plus size={14} />}
          label={t('fileExplorerMenu.newFile')}
          onClick={onNewFile}
        />
        <MenuItem
          icon={<FolderPlus size={14} />}
          label={t('fileExplorerMenu.newFolder')}
          onClick={onNewFolder}
        />
        <Divider />
        {!isRoot && (
          <>
            <MenuItem
              icon={<Edit3 size={14} />}
              label={t('fileExplorerMenu.rename')}
              onClick={onRename}
            />
            <MenuItem
              icon={<Copy size={14} />}
              label={t('fileExplorerMenu.copy')}
              onClick={onCopy}
            />
            <MenuItem icon={<Copy size={14} />} label={t('fileExplorerMenu.cut')} onClick={onCut} />
          </>
        )}
        <MenuItem
          icon={<Clipboard size={14} />}
          label={t('fileExplorerMenu.paste')}
          onClick={onPaste}
          disabled={!clipboardItem}
        />
        {!isRoot && (
          <>
            <Divider />
            <MenuItem
              icon={<Trash2 size={14} />}
              label={t('fileExplorerMenu.delete')}
              onClick={onDelete}
              danger
            />
          </>
        )}
        <Divider />
        {!isRemote && (
          <MenuItem
            icon={<ExternalLink size={14} />}
            label={t('fileExplorerMenu.openInExplorer')}
            onClick={onOpenInExplorer}
          />
        )}
        <MenuItem
          icon={<RefreshCw size={14} />}
          label={t('fileExplorerMenu.refresh')}
          onClick={onRefresh}
        />
      </motion.div>
    );
  }
);
ContextMenu.displayName = 'ContextMenu';

// ====== Inline Edit Input ======

const InlineInput: React.FC<{
  defaultValue: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  placeholder?: string;
}> = ({ defaultValue, onSubmit, onCancel, placeholder }) => {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const isSubmittedRef = useRef(false);
  const scheduleFrame = useRequestAnimationFrame();

  useEffect(() => {
    const focusInput = () => {
      if (inputRef.current) {
        inputRef.current.focus();
        inputRef.current.select();
      }
    };

    focusInput();
    // Why: rAF backup ensures focus after animation frame completes
    scheduleFrame(focusInput);
  }, [scheduleFrame]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation(); // Prevent triggering other shortcuts
    if (e.key === 'Enter') {
      if (value.trim() && !isSubmittedRef.current) {
        isSubmittedRef.current = true;
        onSubmit(value.trim());
      }
    } else if (e.key === 'Escape') {
      isSubmittedRef.current = true;
      onCancel();
    }
  };

  const handleBlur = () => {
    // Why: Delay prevents race condition with Enter key handler
    setTimeout(() => {
      if (!isSubmittedRef.current) {
        if (value.trim()) {
          onSubmit(value.trim());
        } else {
          onCancel();
        }
      }
    }, 100);
  };

  return (
    <input
      ref={inputRef}
      type="text"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      placeholder={placeholder}
      className="w-full rounded px-2 py-0.5 text-sm outline-none"
      style={{
        background: 'var(--color-bg-tertiary)',
        border: '1px solid var(--color-accent)',
        color: 'var(--color-text-primary)',
      }}
      autoFocus
    />
  );
};

// ====== Main Component ======

export const FileExplorer: React.FC = () => {
  const fileTree = useFileTree();
  const projectPath = useProjectPath();
  const projectService = getProjectService();
  const editorService = getEditorService();
  const uiService = getUIService();
  const commandService = getCommandService();
  const keybindingService = getKeybindingService();
  const { t } = useTranslation();

  // Why: Refs avoid stale closure in command callbacks
  const selectedNodeRef = useRef<FileNode | null>(null);
  const projectPathRef = useRef<string | null>(null);
  const refreshFileTreeRef = useRef<(() => Promise<void>) | null>(null);

  // Why: Index cache prevents re-reading unchanged files
  const indexedMtimeRef = useRef<Map<string, number>>(new Map());
  const lastIndexedProjectRef = useRef<string | null>(null);
  const indexRunIdRef = useRef(0);

  const remoteProjectId = useMemo(() => {
    if (projectPath && isRemotePath(projectPath)) {
      return getProjectIdFromPath(projectPath);
    }
    return null;
  }, [projectPath]);

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    node: FileNode | null;
  } | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [creatingIn, setCreatingIn] = useState<{ path: string; type: 'file' | 'folder' } | null>(
    null
  );
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [selectedNode, setSelectedNode] = useState<FileNode | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // ====== Overleaf Tree Conversion ======

  /**
   * Converts Overleaf nested structure (folders/docs/fileRefs) to flat FileNode tree.
   */
  const convertOverleafToFileTree = useCallback(
    (folders: OverleafFolder[], projectName: string, projectId: string): FileNode => {
      const convertFolder = (items: OverleafFolder[], parentPath: string): FileNode[] => {
        const result: FileNode[] = [];

        for (const item of items) {
          if (item.docs !== undefined) {
            result.push({
              name: item.name,
              path: `${parentPath}/${item.name}`,
              type: 'directory',
              _id: item._id,
              children: [
                ...(item.docs || []).map((doc: OverleafDoc) => ({
                  name: doc.name,
                  path: `${parentPath}/${item.name}/${doc.name}`,
                  type: 'file' as const,
                  _id: doc._id,
                })),
                ...(item.fileRefs || []).map((file: OverleafFileRef) => ({
                  name: file.name,
                  path: `${parentPath}/${item.name}/${file.name}`,
                  type: 'file' as const,
                  _id: file._id,
                  isFileRef: true,
                })),
                ...convertFolder(item.folders || [], `${parentPath}/${item.name}`),
              ],
            });
          }
        }

        return result;
      };

      const rootFolder = folders[0] || { docs: [], fileRefs: [], folders: [] };
      const basePath = `overleaf://${projectId}`;
      const children: FileNode[] = [
        ...(rootFolder.docs || []).map((doc: OverleafDoc) => ({
          name: doc.name,
          path: `${basePath}/${doc.name}`,
          type: 'file' as const,
          _id: doc._id,
        })),
        ...(rootFolder.fileRefs || []).map((file: OverleafFileRef) => ({
          name: file.name,
          path: `${basePath}/${file.name}`,
          type: 'file' as const,
          _id: file._id,
          isFileRef: true,
        })),
        ...convertFolder(rootFolder.folders || [], basePath),
      ];

      return {
        name: projectName,
        path: basePath,
        type: 'directory',
        children,
        isRemote: true,
      };
    },
    []
  );

  // ====== Ref Sync Effects ======

  useEffect(() => {
    selectedNodeRef.current = selectedNode;
  }, [selectedNode]);

  useEffect(() => {
    projectPathRef.current = projectPath;
    if (!projectPath) {
      lastIndexedProjectRef.current = null;
      indexedMtimeRef.current.clear();
    }
  }, [projectPath]);

  // ====== File Indexing ======

  const collectIndexablePaths = useCallback((node: FileNode | null): string[] => {
    if (!node) return [];
    const targets: string[] = [];

    const visit = (item: FileNode) => {
      if (isRemotePath(item.path)) return;
      if (item.type === 'file') {
        const ext = item.name.split('.').pop()?.toLowerCase();
        if (ext === 'bib' || ext === 'tex' || ext === 'typ') {
          targets.push(item.path);
        }
        return;
      }
      if (item.children) {
        for (const child of item.children) {
          visit(child);
        }
      }
    };

    visit(node);
    return targets;
  }, []);

  const scheduleIndexing = useCallback(
    (tree: FileNode | null, reason: string) => {
      if (!tree || !projectPath || isRemotePath(projectPath)) return;

      const indexablePaths = collectIndexablePaths(tree);
      if (indexablePaths.length === 0) return;

      // Clean up cache entries for deleted files
      const activeSet = new Set(indexablePaths);
      for (const cachedPath of indexedMtimeRef.current.keys()) {
        if (!activeSet.has(cachedPath)) {
          indexedMtimeRef.current.delete(cachedPath);
        }
      }

      cancelIdleTasksByPrefix('file-index-batch-');
      const runId = ++indexRunIdRef.current;
      const batchSize = 25;

      const processBatch = async (startIndex: number) => {
        if (runId !== indexRunIdRef.current) return;
        const batch = indexablePaths.slice(startIndex, startIndex + batchSize);
        if (batch.length === 0) return;

        try {
          const stats = await api.file.batchStat(batch);
          const toRead = batch.filter((path) => {
            const info = stats[path];
            if (!info) return false;
            const lastMtime = indexedMtimeRef.current.get(path);
            return lastMtime === undefined || info.mtime > lastMtime;
          });

          if (toRead.length > 0) {
            const contents = await api.file.batchRead(toRead);
            for (const path of toRead) {
              const content = contents[path];
              if (content !== undefined) {
                updateFileIndex(path, content);
                const info = stats[path];
                if (info) {
                  indexedMtimeRef.current.set(path, info.mtime);
                }
              }
            }
          }
        } catch (error) {
          console.warn('[FileExplorer] File index update failed:', reason, error);
        }

        if (startIndex + batchSize < indexablePaths.length) {
          // Why: Unique ID per batch prevents dedup from discarding subsequent batches
          scheduleIdleTask(
            () => {
              void processBatch(startIndex + batchSize);
            },
            {
              id: `file-index-batch-${runId}-${startIndex + batchSize}`,
              priority: TaskPriority.Low,
              timeout: 1000,
            }
          );
        }
      };

      scheduleIdleTask(
        () => {
          void processBatch(0);
        },
        {
          id: `file-index-batch-${runId}-0`,
          priority: TaskPriority.Low,
          timeout: 1000,
        }
      );
    },
    [collectIndexablePaths, projectPath]
  );

  // ====== File Tree Refresh ======

  type RefreshReason = 'manual' | 'focus' | 'auto';

  const refreshRemoteFileTree = useCallback(async () => {
    if (!projectPath || !remoteProjectId) return;

    setIsRefreshing(true);
    try {
      const result = await api.overleaf.getProjectDetails(remoteProjectId);
      if (result?.success && result.details?.rootFolder) {
        const projectName = result.details.name || 'Remote Project';
        const newFileTree = convertOverleafToFileTree(
          result.details.rootFolder as OverleafFolder[],
          projectName,
          remoteProjectId
        );
        projectService.setProject(projectPath, newFileTree, { rebuildIndex: false });
        uiService.addCompilationLog({ type: 'success', message: 'Remote file tree refreshed' });
      } else {
        console.error('[FileExplorer] Failed to get remote project details:', result?.error);
        uiService.addCompilationLog({
          type: 'error',
          message: `Failed to refresh remote file tree: ${result?.error || 'Unknown error'}`,
        });
      }
    } catch (error) {
      console.error('[FileExplorer] Failed to refresh remote file tree:', error);
      uiService.addCompilationLog({
        type: 'error',
        message: `Failed to refresh remote tree: ${error}`,
      });
    } finally {
      setIsRefreshing(false);
    }
  }, [projectPath, remoteProjectId, projectService, uiService, convertOverleafToFileTree]);

  const refreshFileTree = useCallback(
    async (reason: RefreshReason = 'manual') => {
      if (!projectPath) return;

      if (isRemotePath(projectPath)) {
        await refreshRemoteFileTree();
        return;
      }

      const shouldRebuildIndex = reason === 'manual';

      setIsRefreshing(true);
      try {
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
            const result = await api.file.read(activeTab.path);
            if (result !== undefined && result.content !== activeTab.content) {
              console.log('[FileExplorer] Refreshing file content:', activeTab.path);
              editorService.setContentFromExternal(activeTab.path, result.content);
              editorService.updateFileMtime(activeTab.path, result.mtime);
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
    [projectPath, projectService, uiService, editorService, refreshRemoteFileTree, scheduleIndexing]
  );

  useEffect(() => {
    refreshFileTreeRef.current = refreshFileTree;
  }, [refreshFileTree]);

  // Index files on first project load (only once per project)
  useEffect(() => {
    if (!projectPath || !fileTree || isRemotePath(projectPath)) return;
    if (lastIndexedProjectRef.current === projectPath) return;
    lastIndexedProjectRef.current = projectPath;
    indexedMtimeRef.current.clear();
    scheduleIndexing(fileTree, 'project-open');
  }, [projectPath, fileTree, scheduleIndexing]);

  // ====== Auto Refresh ======

  // Why: Only local projects auto-refresh; remote would disrupt Socket.IO
  // Why: Long interval as fallback since incremental updates handle most changes
  const shouldAutoRefresh = projectPath && !isRemotePath(projectPath) && !isRefreshing;
  useInterval(
    () => {
      refreshFileTree('auto');
    },
    shouldAutoRefresh ? 60000 : null
  );

  // Why: 15s min interval prevents excessive refresh on rapid window switching
  // Why: Fixed task ID means only last refresh request survives
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

  // ====== Command Registration ======

  useEffect(() => {
    const disposables = [
      commandService.registerCommand(Commands.FILE_RENAME, () => {
        const currentNode = selectedNodeRef.current;
        const currentProjectPath = projectPathRef.current;
        if (currentNode && currentNode.path !== currentProjectPath) {
          setRenamingPath(currentNode.path);
        }
      }),

      commandService.registerCommand(Commands.FILE_DELETE, () => {
        const currentNode = selectedNodeRef.current;
        const currentProjectPath = projectPathRef.current;
        if (currentNode && currentNode.path !== currentProjectPath) {
          void handleDeleteSelected();
        }
      }),

      commandService.registerCommand(Commands.EDIT_COPY, () => {
        const currentNode = selectedNodeRef.current;
        if (currentNode) {
          clipboardItem = {
            path: currentNode.path,
            name: currentNode.name,
            type: currentNode.type,
            operation: 'copy',
          };
          getUIService().addCompilationLog({
            type: 'info',
            message: t('fileExplorerMenu.copied', { name: currentNode.name }),
          });
        }
      }),

      commandService.registerCommand(Commands.EDIT_CUT, () => {
        const currentNode = selectedNodeRef.current;
        if (currentNode) {
          clipboardItem = {
            path: currentNode.path,
            name: currentNode.name,
            type: currentNode.type,
            operation: 'cut',
          };
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
    // TODO: Implement setContext
    // keybindingService.setContext('filesExplorerFocus', true);
  }, []);

  const handleBlur = useCallback(() => {
    // keybindingService.setContext('filesExplorerFocus', false);
  }, []);

  // ====== Delete Operations ======

  const handleDeleteSelected = async () => {
    const currentNode = selectedNodeRef.current;
    const currentProjectPath = projectPathRef.current;
    if (!currentNode) return;
    if (currentNode.path === currentProjectPath) return;

    const fileService = getFileExplorerService();
    const isRemote = isRemotePath(currentNode.path);

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
        if (n.children) {
          return n.children.some(checkDirtyInDir);
        }
        return false;
      };
      hasDirtyContent = checkDirtyInDir(currentNode);
    }

    let result;

    if (isRemote) {
      // Why: Overleaf doesn't support trash, only permanent delete
      const entityType =
        currentNode.type === 'directory' ? 'folder' : currentNode.isFileRef ? 'file' : 'doc';

      result = await fileService.deleteNode(
        {
          path: currentNode.path,
          name: currentNode.name,
          type: currentNode.type,
          _id: currentNode._id,
        },
        entityType as 'doc' | 'file' | 'folder'
      );
    } else {
      result = await fileService.trashNode(
        { path: currentNode.path, name: currentNode.name, type: currentNode.type },
        { hasDirtyContent }
      );
    }

    if (result.success) {
      if (currentNode.type === 'file') {
        if (editorService.hasTab(currentNode.path)) {
          editorService.closeTab(currentNode.path);
        }
      } else if (currentNode.type === 'directory' && currentNode.children) {
        const closeTabsInDir = (n: FileNode) => {
          if (n.type === 'file' && editorService.hasTab(n.path)) {
            editorService.closeTab(n.path);
          }
          if (n.children) {
            n.children.forEach(closeTabsInDir);
          }
        };
        closeTabsInDir(currentNode);
      }

      const actionText = isRemote ? 'Deleted' : 'Moved to trash';
      uiService.addCompilationLog({
        type: 'success',
        message: `${actionText}: ${currentNode.name}`,
      });
      setSelectedNode(null);
      await refreshFileTreeRef.current?.();
    } else if (result.error !== 'User cancelled') {
      uiService.addCompilationLog({ type: 'error', message: result.error || 'Delete failed' });
    }
  };

  // ====== Paste Operations ======

  const handlePasteToSelected = async () => {
    const currentNode = selectedNodeRef.current;
    const currentProjectPath = projectPathRef.current;
    const targetPath =
      currentNode?.type === 'directory'
        ? currentNode.path
        : currentNode
          ? getParentPath(currentNode.path)
          : currentProjectPath;

    if (!targetPath) return;

    const isRemote = isRemotePath(targetPath);
    const fileService = getFileExplorerService();

    try {
      if (clipboardItem) {
        fileService.copyToClipboard([
          {
            path: clipboardItem.path,
            type: clipboardItem.type === 'directory' ? 'directory' : 'file',
            operation: clipboardItem.operation,
          },
        ]);
        const result = await fileService.pasteFromClipboard(targetPath);
        if (result.success) {
          uiService.addCompilationLog({
            type: 'success',
            message:
              clipboardItem.operation === 'copy'
                ? `Copied: ${clipboardItem.name}`
                : `Moved: ${clipboardItem.name}`,
          });
          if (clipboardItem.operation === 'cut') clipboardItem = null;
          await refreshFileTreeRef.current?.();
        } else if (result.error) {
          uiService.addCompilationLog({ type: 'error', message: result.error });
        }
        return;
      }

      if (!isRemote) {
        const result = await fileService.pasteFromSystemClipboard(targetPath);
        if (result.success) {
          uiService.addCompilationLog({
            type: 'success',
            message: 'Pasted files from system clipboard',
          });
          await refreshFileTreeRef.current?.();
        } else if (result.error && result.error !== 'No files in system clipboard') {
          uiService.addCompilationLog({ type: 'error', message: result.error });
        }
        return;
      }

      uiService.addCompilationLog({ type: 'info', message: 'Nothing to paste in clipboard' });
    } catch (error) {
      uiService.addCompilationLog({ type: 'error', message: `Paste failed: ${error}` });
    }
  };

  // ====== File Selection ======

  const handleFileSelect = async (node: FileNode) => {
    setSelectedNode(node);

    if (node.type === 'file') {
      if (node.isFileRef) {
        uiService.addCompilationLog({
          type: 'info',
          message: `${node.name} is a binary file and cannot be opened in editor`,
        });
        return;
      }

      // Why: Normalize paths to forward slashes for cross-platform consistency
      const normalizedPath = node.path.replace(/\\/g, '/');
      console.log('[FileExplorer] handleFileSelect:', {
        originalPath: node.path,
        normalizedPath,
        name: node.name,
        _id: node._id,
      });

      try {
        let content = '';
        let docId = node._id;

        if (isRemotePath(normalizedPath)) {
          const projectId = getProjectIdFromPath(normalizedPath);

          if (!projectId) {
            throw new Error('Cannot get remote project ID');
          }

          const relativePath = normalizedPath.replace(`overleaf://${projectId}/`, '');
          const docIdOrPath = node._id || relativePath;
          const isPath = !node._id;

          // Why: Retry for newly created files that may need Overleaf sync time
          const maxRetries = 3;
          const retryDelay = 1000;
          let lastError: Error | null = null;

          for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
              const result = await api.overleaf.getDoc(projectId, docIdOrPath, isPath);
              if (result?.success) {
                content = result.content || '';
                if (result.docId) {
                  docId = result.docId;
                  node._id = result.docId;
                }
                break;
              } else {
                lastError = new Error(result?.error || 'Failed to read remote file');
              }
            } catch (e) {
              lastError = e instanceof Error ? e : new Error('Failed to read remote file');
            }

            if (attempt < maxRetries) {
              uiService.addCompilationLog({
                type: 'info',
                message: `Waiting for file sync... (${attempt}/${maxRetries})`,
              });
              await new Promise((resolve) => setTimeout(resolve, retryDelay));
            }
          }

          if (lastError && !content && content !== '') {
            throw lastError;
          }
        } else {
          if (api.file.read) {
            console.log('[FileExplorer] Reading local file:', normalizedPath);
            const result = await api.file.read(normalizedPath);
            content = result.content;
            console.log('[FileExplorer] File content read success:', {
              path: normalizedPath,
              contentLength: content?.length || 0,
              mtime: result.mtime,
            });

            editorService.updateFileMtime(normalizedPath, result.mtime);
          } else {
            console.error('[FileExplorer] api.file.read not available');
            throw new Error('Electron API not available, ensure running in Electron environment');
          }
        }

        const ext = node.name.split('.').pop()?.toLowerCase();
        let language = 'plaintext';
        if (ext === 'tex' || ext === 'latex') language = 'latex';
        else if (ext === 'bib') language = 'bibtex';
        else if (ext === 'md') language = 'markdown';
        else if (ext === 'json') language = 'json';
        else if (ext === 'js' || ext === 'jsx') language = 'javascript';
        else if (ext === 'ts' || ext === 'tsx') language = 'typescript';
        else if (ext === 'sty' || ext === 'cls') language = 'latex';
        else if (ext === 'typ') language = 'typst';

        if (ext === 'bib' || ext === 'tex' || ext === 'typ') {
          updateFileIndex(normalizedPath, content);
        }

        console.log('[FileExplorer] 调用 addTab:', {
          path: normalizedPath,
          name: node.name,
          language,
        });
        editorService.addTab({
          path: normalizedPath,
          name: node.name,
          content,
          isDirty: false,
          language,
          _id: docId,
          isRemote: isRemotePath(normalizedPath),
        });
      } catch (error) {
        console.error('[FileExplorer] Failed to read file:', error);
        uiService.addCompilationLog({
          type: 'error',
          message: `Cannot read file: ${node.name} - ${error instanceof Error ? error.message : 'Unknown error'}`,
        });
      }
    }
  };

  // ====== Context Menu ======

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

  const getParentPath = (path: string): string => {
    const parts = path.replace(/\\/g, '/').split('/');
    parts.pop();
    return parts.join('/') || path;
  };

  // ====== Create Operations ======

  const handleNewFile = async () => {
    const targetPath =
      contextMenu?.node?.type === 'directory'
        ? contextMenu.node.path
        : contextMenu?.node
          ? getParentPath(contextMenu.node.path)
          : projectPath;

    if (!targetPath) return;
    setCreatingIn({ path: targetPath, type: 'file' });
  };

  const handleNewFolder = async () => {
    const targetPath =
      contextMenu?.node?.type === 'directory'
        ? contextMenu.node.path
        : contextMenu?.node
          ? getParentPath(contextMenu.node.path)
          : projectPath;

    if (!targetPath) return;
    setCreatingIn({ path: targetPath, type: 'folder' });
  };

  const handleCreateSubmit = async (name: string) => {
    if (!creatingIn) return;

    const siblingNames: string[] = [];
    if (fileTree) {
      const findParentChildren = (nodes: FileNode[], targetPath: string): FileNode[] => {
        for (const node of nodes) {
          if (node.path === targetPath && node.children) {
            return node.children;
          }
          if (node.children) {
            const found = findParentChildren(node.children, targetPath);
            if (found.length > 0) return found;
          }
        }
        return [];
      };
      const siblings = findParentChildren([fileTree], creatingIn.path);
      siblingNames.push(...siblings.map((s) => s.name));
    }

    const validation = validateFileName(name, siblingNames);
    if (!validation.valid) {
      uiService.addCompilationLog({
        type: 'error',
        message: validation.error || 'Invalid file name',
      });
      return;
    }
    if (validation.warning) {
      uiService.addCompilationLog({ type: 'warning', message: validation.warning });
    }

    const newPath = `${creatingIn.path}/${name}`.replace(/\\/g, '/');
    const createType = creatingIn.type;
    const isRemote = isRemotePath(newPath);

    setCreatingIn(null);

    try {
      const fileService = getFileExplorerService();

      if (createType === 'file') {
        const result = await fileService.createFile(creatingIn.path, name);
        if (!result.success) throw new Error(result.error);
        uiService.addCompilationLog({ type: 'success', message: `Created file: ${name}` });
      } else {
        const result = await fileService.createFolder(creatingIn.path, name);
        if (!result.success) throw new Error(result.error);
        uiService.addCompilationLog({ type: 'success', message: `Created folder: ${name}` });
      }

      refreshFileTree();

      if (createType === 'file') {
        // Why: Remote files need sync delay before opening
        if (isRemote) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }

        const ext = name.split('.').pop()?.toLowerCase();
        let language = 'plaintext';
        if (ext === 'tex' || ext === 'latex') language = 'latex';
        else if (ext === 'bib') language = 'bibtex';
        else if (ext === 'md') language = 'markdown';
        else if (ext === 'sty' || ext === 'cls') language = 'latex';
        else if (ext === 'typ') language = 'typst';

        editorService.addTab({
          path: newPath,
          name,
          content: '',
          isDirty: false,
          language,
          isRemote,
        });
      }
    } catch (error) {
      uiService.addCompilationLog({ type: 'error', message: `Create failed: ${error}` });
    }
  };

  // ====== Rename Operations ======

  const handleRename = () => {
    if (contextMenu?.node) {
      setRenamingPath(contextMenu.node.path);
    }
  };

  const handleRenameSubmit = async (oldPath: string, newName: string) => {
    const findNode = (nodes: FileNode[], path: string): FileNode | null => {
      for (const node of nodes) {
        if (node.path === path) return node;
        if (node.children) {
          const found = findNode(node.children, path);
          if (found) return found;
        }
      }
      return null;
    };

    const node = fileTree ? findNode([fileTree], oldPath) : null;
    const oldName = node?.name || oldPath.split('/').pop() || '';

    if (newName === oldName) {
      setRenamingPath(null);
      return;
    }

    const siblingNames: string[] = [];
    if (fileTree && node) {
      const parentPath = oldPath.substring(0, oldPath.lastIndexOf('/'));
      const findParentChildren = (nodes: FileNode[], targetPath: string): FileNode[] => {
        for (const n of nodes) {
          if (n.path === targetPath && n.children) {
            return n.children;
          }
          if (n.children) {
            const found = findParentChildren(n.children, targetPath);
            if (found.length > 0) return found;
          }
        }
        return [];
      };
      const siblings = findParentChildren([fileTree], parentPath);
      siblingNames.push(...siblings.map((s) => s.name));
    }

    const validation = validateFileName(newName, siblingNames, oldName);
    if (!validation.valid) {
      uiService.addCompilationLog({
        type: 'error',
        message: validation.error || 'Invalid file name',
      });
      return;
    }
    if (validation.warning) {
      uiService.addCompilationLog({ type: 'warning', message: validation.warning });
    }

    setRenamingPath(null);

    const entityType =
      isRemotePath(oldPath) && node
        ? node.type === 'directory'
          ? 'folder'
          : node.isFileRef
            ? 'file'
            : 'doc'
        : undefined;

    const result = await getFileExplorerService().renameNode(
      oldPath,
      newName,
      entityType as 'doc' | 'file' | 'folder' | undefined,
      node?._id
    );

    if (result.success) {
      uiService.addCompilationLog({ type: 'success', message: `Renamed to: ${newName}` });
    } else if (result.error) {
      uiService.addCompilationLog({ type: 'error', message: result.error });
    }

    refreshFileTree();
  };

  // ====== Lazy Loading ======

  /**
   * Resolves directory children on-demand when user expands folder.
   * @throws Logs error to UI on failure
   */
  const handleResolveChildren = useCallback(
    async (dirPath: string) => {
      if (!projectPath) return;

      try {
        const result = await api.file.resolveChildren(dirPath);
        if (result.success && result.children) {
          projectService.updateNodeChildren(dirPath, result.children);
        }
      } catch (error) {
        console.error('Failed to resolve children:', error);
        uiService.addCompilationLog({
          type: 'error',
          message: `Failed to load directory: ${error instanceof Error ? error.message : 'Unknown error'}`,
        });
      }
    },
    [projectPath, projectService, uiService]
  );

  // ====== Context Menu Actions ======

  const handleDelete = async () => {
    if (!contextMenu?.node) return;

    const node = contextMenu.node;
    const fileService = getFileExplorerService();
    const isRemote = isRemotePath(node.path);

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
        if (n.children) {
          return n.children.some(checkDirtyInDir);
        }
        return false;
      };
      hasDirtyContent = checkDirtyInDir(node);
    }

    let result;

    if (isRemote) {
      const entityType = node.type === 'directory' ? 'folder' : node.isFileRef ? 'file' : 'doc';

      result = await fileService.deleteNode(
        { path: node.path, name: node.name, type: node.type, _id: node._id },
        entityType as 'doc' | 'file' | 'folder'
      );
    } else {
      result = await fileService.trashNode(
        { path: node.path, name: node.name, type: node.type },
        { hasDirtyContent }
      );
    }

    if (result.success) {
      if (node.type === 'file') {
        if (editorService.hasTab(node.path)) {
          editorService.closeTab(node.path);
        }
      } else if (node.type === 'directory' && node.children) {
        const closeTabsInDir = (n: FileNode) => {
          if (n.type === 'file' && editorService.hasTab(n.path)) {
            editorService.closeTab(n.path);
          }
          if (n.children) {
            n.children.forEach(closeTabsInDir);
          }
        };
        closeTabsInDir(node);
      }

      const actionText = isRemote ? 'Deleted' : 'Moved to trash';
      uiService.addCompilationLog({ type: 'success', message: `${actionText}: ${node.name}` });
      await refreshFileTree();
    } else if (result.error !== 'User cancelled') {
      uiService.addCompilationLog({ type: 'error', message: result.error || 'Delete failed' });
    }
  };

  const handleCopy = () => {
    if (!contextMenu?.node) return;
    clipboardItem = {
      path: contextMenu.node.path,
      name: contextMenu.node.name,
      type: contextMenu.node.type,
      operation: 'copy',
    };
    uiService.addCompilationLog({ type: 'info', message: `Copied: ${contextMenu.node.name}` });
  };

  const handleCut = () => {
    if (!contextMenu?.node) return;
    clipboardItem = {
      path: contextMenu.node.path,
      name: contextMenu.node.name,
      type: contextMenu.node.type,
      operation: 'cut',
    };
    uiService.addCompilationLog({ type: 'info', message: `Cut: ${contextMenu.node.name}` });
  };

  const handlePaste = async () => {
    const targetPath =
      contextMenu?.node?.type === 'directory'
        ? contextMenu.node.path
        : contextMenu?.node
          ? getParentPath(contextMenu.node.path)
          : projectPath;

    if (!targetPath) return;

    const isRemote = isRemotePath(targetPath);

    try {
      if (clipboardItem) {
        const destPath = `${targetPath}/${clipboardItem.name}`.replace(/\\/g, '/');
        const exists = await api.file.exists(destPath);
        if (exists) {
          const overwrite = await api.dialog.confirm(
            `"${clipboardItem.name}" already exists. Overwrite?`,
            'Confirm Overwrite'
          );
          if (!overwrite) return;
        }

        if (clipboardItem.operation === 'copy') {
          await api.file.copy(clipboardItem.path, destPath);
          uiService.addCompilationLog({
            type: 'success',
            message: `Copied: ${clipboardItem.name}`,
          });
        } else {
          await api.file.move(clipboardItem.path, destPath);
          uiService.addCompilationLog({
            type: 'success',
            message: `Moved: ${clipboardItem.name}`,
          });
          clipboardItem = null;
        }
        await refreshFileTree();
        return;
      }

      if (!isRemote && api.file.getClipboard) {
        const result = await api.file.getClipboard();
        if (result?.success && result.files && result.files.length > 0) {
          let successCount = 0;
          let failCount = 0;

          for (const srcPath of result.files) {
            try {
              const fileName = srcPath.split(/[/\\]/).pop() || 'file';
              const destPath = `${targetPath}/${fileName}`.replace(/\\/g, '/');
              const exists = await api.file.exists(destPath);
              if (exists) {
                const overwrite = await api.dialog.confirm(
                  `"${fileName}" already exists. Overwrite?`,
                  'Confirm Overwrite'
                );
                if (!overwrite) {
                  failCount++;
                  continue;
                }
              }

              await api.file.copy(srcPath, destPath);
              successCount++;
            } catch (e) {
              console.error('Failed to paste file:', srcPath, e);
              failCount++;
            }
          }

          if (successCount > 0) {
            uiService.addCompilationLog({
              type: 'success',
              message: `Pasted ${successCount} file(s) from clipboard${failCount > 0 ? `, ${failCount} failed` : ''}`,
            });
            await refreshFileTree();
          } else if (failCount > 0) {
            uiService.addCompilationLog({
              type: 'error',
              message: `Paste failed: ${failCount} file(s)`,
            });
          }
          return;
        }
      }

      uiService.addCompilationLog({ type: 'info', message: 'Nothing to paste in clipboard' });
    } catch (error) {
      uiService.addCompilationLog({ type: 'error', message: `Paste failed: ${error}` });
    }
  };

  const handleOpenInExplorer = () => {
    const targetPath = contextMenu?.node?.path || projectPath;
    if (!targetPath) return;
    getFileExplorerService().showInFolder(targetPath);
  };

  // ====== Render ======

  if (!projectPath) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-6">
        <div
          className="w-20 h-20 rounded-2xl flex items-center justify-center mb-6"
          style={{
            background:
              'linear-gradient(135deg, rgba(34, 211, 238, 0.1) 0%, rgba(56, 189, 248, 0.1) 100%)',
          }}
        >
          <FolderOpen size={36} style={{ color: 'var(--color-text-muted)' }} />
        </div>
        <h3 className="text-sm font-medium mb-2" style={{ color: 'var(--color-text-secondary)' }}>
          No project open
        </h3>
        <p
          className="text-xs text-center max-w-[200px] mb-6"
          style={{ color: 'var(--color-text-muted)' }}
        >
          Open a folder to start editing, or select from recent projects
        </p>
        <div className="flex flex-col gap-2 w-full max-w-[180px]">
          <button
            onClick={async () => {
              const result = await api.project.open();
              if (result) {
                projectService.setProject(result.projectPath, result.fileTree as FileNode);
              }
            }}
            className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-all cursor-pointer"
            style={{
              background: 'var(--color-accent-muted)',
              color: 'var(--color-accent)',
              border: '1px solid var(--color-accent)',
            }}
          >
            <FolderOpen size={16} />
            Open Folder
          </button>
        </div>
      </div>
    );
  }

  if (!fileTree && projectPath) {
    return (
      <div className="h-full flex flex-col">
        <div
          className="flex items-center justify-between px-3 py-2"
          style={{ borderBottom: '1px solid var(--color-border-subtle)' }}
        >
          <div className="flex items-center gap-2">
            <div
              className="w-16 h-4 rounded animate-pulse"
              style={{ background: 'var(--color-bg-tertiary)' }}
            />
          </div>
          <div className="flex items-center gap-1">
            <div
              className="w-6 h-6 rounded animate-pulse"
              style={{ background: 'var(--color-bg-tertiary)' }}
            />
            <div
              className="w-6 h-6 rounded animate-pulse"
              style={{ background: 'var(--color-bg-tertiary)' }}
            />
            <div
              className="w-6 h-6 rounded animate-pulse"
              style={{ background: 'var(--color-bg-tertiary)' }}
            />
          </div>
        </div>
        <FileTreeSkeleton rows={10} />
      </div>
    );
  }

  if (!fileTree) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-6">
        <div
          className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4"
          style={{
            background:
              'linear-gradient(135deg, rgba(34, 211, 238, 0.1) 0%, rgba(56, 189, 248, 0.1) 100%)',
          }}
        >
          <FileText size={28} style={{ color: 'var(--color-text-muted)' }} />
        </div>
        <p className="text-sm font-medium mb-2" style={{ color: 'var(--color-text-secondary)' }}>
          Loading project...
        </p>
        <p className="text-xs text-center" style={{ color: 'var(--color-text-muted)' }}>
          Please wait
        </p>
      </div>
    );
  }

  // ====== Drag & Drop ======

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (isRemotePath(projectPath || '')) {
        uiService.addCompilationLog({
          type: 'warning',
          message: 'Remote projects do not support drag-and-drop file import',
        });
        return;
      }

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
        // Why: Electron extends File object with path property for native file access
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
    },
    [projectPath, selectedNode, refreshFileTree, uiService]
  );

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
      {/* Toolbar */}
      <div
        className="flex items-center justify-between px-3 py-2"
        style={{ borderBottom: '1px solid var(--color-border-subtle)' }}
      >
        <div className="flex items-center gap-2 min-w-0">
          {isRemotePath(projectPath || '') && (
            <div
              className="flex items-center gap-1 px-1.5 py-0.5 rounded"
              title="Remote Project (Overleaf)"
              style={{ background: 'var(--color-success-muted)', color: 'var(--color-success)' }}
            >
              <Cloud size={12} />
            </div>
          )}
          <span
            className="text-xs truncate font-medium"
            style={{
              color: isRemotePath(projectPath || '')
                ? 'var(--color-text-primary)'
                : 'var(--color-text-muted)',
            }}
          >
            {isRemotePath(projectPath || '')
              ? fileTree?.name || 'Remote Project'
              : projectPath?.split(/[/\\]/).pop()}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => {
              const targetPath =
                selectedNode?.type === 'directory'
                  ? selectedNode.path
                  : selectedNode
                    ? getParentPath(selectedNode.path)
                    : projectPath || '';
              setCreatingIn({ path: targetPath, type: 'file' });
            }}
            className="p-1 rounded transition-colors cursor-pointer"
            style={{ color: 'var(--color-text-muted)' }}
            title="New File"
          >
            <Plus size={14} />
          </button>
          <button
            onClick={() => {
              const targetPath =
                selectedNode?.type === 'directory'
                  ? selectedNode.path
                  : selectedNode
                    ? getParentPath(selectedNode.path)
                    : projectPath || '';
              setCreatingIn({ path: targetPath, type: 'folder' });
            }}
            className="p-1 rounded transition-colors cursor-pointer"
            style={{ color: 'var(--color-text-muted)' }}
            title="New Folder"
          >
            <FolderPlus size={14} />
          </button>
          <button
            onClick={() => refreshFileTree('manual')}
            disabled={isRefreshing}
            className={clsx(
              'p-1 rounded transition-colors cursor-pointer',
              isRefreshing && 'animate-spin'
            )}
            style={{ color: 'var(--color-text-muted)' }}
            title="Refresh"
          >
            <RefreshCw size={14} />
          </button>
          {isRemotePath(projectPath || '') && (
            <button
              onClick={async () => {
                try {
                  const config = await api.localReplica.getConfig();
                  if (!config) {
                    uiService.addCompilationLog({
                      type: 'warning',
                      message: 'Please configure local replica sync directory in settings first',
                    });
                    return;
                  }
                  uiService.addCompilationLog({ type: 'info', message: 'Syncing to local...' });
                  const result = await api.localReplica.syncFromRemote();
                  if (result.errors.length > 0) {
                    uiService.addCompilationLog({
                      type: 'error',
                      message: `Sync failed: ${result.errors[0]}`,
                    });
                  } else {
                    uiService.addCompilationLog({
                      type: 'success',
                      message: `Synced ${result.synced} file(s) to local`,
                    });
                  }
                } catch (error) {
                  uiService.addCompilationLog({
                    type: 'error',
                    message: `Sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
                  });
                }
              }}
              className="p-1 rounded transition-colors cursor-pointer"
              style={{ color: 'var(--color-text-muted)' }}
              title="Sync to Local Replica"
            >
              <Download size={14} />
            </button>
          )}
        </div>
      </div>

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
              onSubmit={handleCreateSubmit}
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
            isRoot={contextMenu.node?.path === projectPath}
            isRemote={isRemotePath(projectPath || '')}
            onClose={() => setContextMenu(null)}
            onNewFile={handleNewFile}
            onNewFolder={handleNewFolder}
            onRename={handleRename}
            onDelete={handleDelete}
            onCopy={handleCopy}
            onCut={handleCut}
            onPaste={handlePaste}
            onOpenInExplorer={handleOpenInExplorer}
            onRefresh={refreshFileTree}
          />
        )}
      </AnimatePresence>
    </div>
  );
};
