/**
 * @file FileExplorerService.ts - File Explorer Service
 * @description Manages file explorer business logic, including file operations, clipboard, and drag-and-drop
 * @depends IPC (api.file), shared/utils (Event)
 */

import { Disposable, Emitter, Event } from '../../../../../shared/utils';
import { api } from '../../api';
import type { FileNode } from '../../types';
import { findAvailableFileName } from '../../utils/fileNaming';

// ====== Type Definitions ======

export interface FileOperationResult {
  success: boolean;
  error?: string;
}

export interface ClipboardItem {
  path: string;
  type: 'file' | 'directory';
  operation: 'copy' | 'cut';
}

// ====== Service Implementation ======

class FileExplorerService extends Disposable {
  private static _instance: FileExplorerService | null = null;

  private readonly _onFileTreeChanged = this._register(new Emitter<FileNode | null>());
  readonly onFileTreeChanged = this._onFileTreeChanged.event;

  /**
   * Debounced event - triggers only once for batch file changes
   *
   * Use cases:
   * - Large file changes during git checkout / git pull
   * - node_modules updates during npm install
   * - External tools batch modifying files
   *
   * Debounce delay 100ms, multiple triggers within the delay window only emit the last value
   */
  readonly onFileTreeChangedDebounced = Event.debounce(
    this._onFileTreeChanged.event,
    (_, current) => current,
    { delay: 100 }
  );

  private readonly _onOperationError = this._register(new Emitter<string>());
  readonly onOperationError = this._onOperationError.event;

  private _clipboard: ClipboardItem[] = [];
  private _isRefreshing = false;

  /**
   * Batch operation flag - suppresses individual events during batch operations
   *
   * Uses Event.buffer concept: collects events during batch operations,
   * triggers only once after operations complete
   */
  private _batchOperationInProgress = false;
  private _pendingBatchEvents: FileNode[] = [];

  private constructor() {
    super();
  }

  static getInstance(): FileExplorerService {
    if (!FileExplorerService._instance) {
      FileExplorerService._instance = new FileExplorerService();
    }
    return FileExplorerService._instance;
  }

  // ====== Batch Operations (Event.buffer mode) ======

  /**
   * Begin batch operation
   *
   * During batch operations, file tree change events are collected instead of immediately triggered.
   * Used for scenarios like pasting multiple files, batch deletion, etc.
   */
  beginBatchOperation(): void {
    this._batchOperationInProgress = true;
    this._pendingBatchEvents = [];
  }

  async endBatchOperation(projectPath: string | null): Promise<void> {
    this._batchOperationInProgress = false;
    const hadPendingEvents = this._pendingBatchEvents.length > 0;
    this._pendingBatchEvents = [];

    if (hadPendingEvents && projectPath) {
      await this.refreshFileTree(projectPath);
    }
  }

  private _fireFileTreeChanged(tree: FileNode | null): void {
    if (this._batchOperationInProgress) {
      if (tree) {
        this._pendingBatchEvents.push(tree);
      }
    } else {
      this._onFileTreeChanged.fire(tree);
    }
  }

  // ====== File Tree Operations ======

  private _pendingRefresh: { path: string; resolve: (value: FileNode | null) => void }[] = [];
  private _refreshTimeoutId: ReturnType<typeof setTimeout> | null = null;

  private readonly _refreshDebounceMs = 100;

  /**
   * Refresh file tree (with debounce)
   *
   * When called multiple times in a short period (e.g., batch file changes), only executes the last refresh,
   * all pending Promises receive the same result.
   */
  async refreshFileTree(projectPath: string): Promise<FileNode | null> {
    return new Promise((resolve) => {
      this._pendingRefresh.push({ path: projectPath, resolve });

      if (this._refreshTimeoutId) {
        clearTimeout(this._refreshTimeoutId);
      }

      this._refreshTimeoutId = setTimeout(async () => {
        this._refreshTimeoutId = null;

        const pending = [...this._pendingRefresh];
        this._pendingRefresh = [];

        const lastPath = pending[pending.length - 1]?.path || projectPath;

        const result = await this._doRefreshFileTree(lastPath);

        for (const { resolve: res } of pending) {
          res(result);
        }
      }, this._refreshDebounceMs);
    });
  }

  private async _doRefreshFileTree(projectPath: string): Promise<FileNode | null> {
    if (this._isRefreshing) return null;

    this._isRefreshing = true;
    try {
      const result = await api.file.refreshTree(projectPath);
      if (result.success && result.fileTree) {
        this._fireFileTreeChanged(result.fileTree);
        return result.fileTree;
      }
      return null;
    } catch (error) {
      this._onOperationError.fire(`Refresh failed: ${error}`);
      return null;
    } finally {
      this._isRefreshing = false;
    }
  }

  // ====== File/Folder Creation ======

  async createFile(parentPath: string, fileName: string): Promise<FileOperationResult> {
    const newPath = `${parentPath}/${fileName}`;
    try {
      await api.file.create(newPath, '');
      return { success: true };
    } catch (error) {
      const message = `Failed to create file: ${error}`;
      this._onOperationError.fire(message);
      return { success: false, error: message };
    }
  }

  async createFolder(parentPath: string, folderName: string): Promise<FileOperationResult> {
    const newPath = `${parentPath}/${folderName}`;
    try {
      await api.file.createFolder(newPath);
      return { success: true };
    } catch (error) {
      const message = `Failed to create folder: ${error}`;
      this._onOperationError.fire(message);
      return { success: false, error: message };
    }
  }

  // ====== Delete Operations ======

  /**
   * Delete node (permanent deletion)
   *
   * Use this method for remote files or scenarios requiring permanent deletion.
   * For local files, prefer trashNode() to support recovery.
   */
  async deleteNode(
    node: { path: string; name: string; type: string; _id?: string },
    entityType?: 'doc' | 'file' | 'folder'
  ): Promise<FileOperationResult> {
    const confirmed = await api.dialog.confirm(
      `Are you sure you want to delete "${node.name}"?${node.type === 'directory' ? ' All contents in the folder will also be deleted.' : ''}`,
      'Confirm Deletion'
    );

    if (!confirmed) {
      return { success: false, error: 'User cancelled' };
    }

    try {
      if (entityType && node._id) {
        await api.file.delete(node.path, entityType, node._id);
      } else {
        await api.file.delete(node.path);
      }
      return { success: true };
    } catch (error) {
      const message = `Deletion failed: ${error}`;
      this._onOperationError.fire(message);
      return { success: false, error: message };
    }
  }

  /**
   * Move node to trash (recoverable deletion, VS Code default behavior)
   *
   * Only supports local files. For remote files, use deleteNode().
   */
  async trashNode(
    node: { path: string; name: string; type: string },
    options?: { skipConfirm?: boolean; hasDirtyContent?: boolean }
  ): Promise<FileOperationResult> {
    let confirmMessage = `Are you sure you want to delete "${node.name}"?`;

    if (node.type === 'directory') {
      confirmMessage += '\nAll contents in the folder will also be deleted.';
    }

    if (options?.hasDirtyContent) {
      confirmMessage += '\n\n⚠️ This file has unsaved changes, deletion will lose these changes.';
    }

    confirmMessage += '\n\nCan be recovered from system trash.';

    if (!options?.skipConfirm) {
      const confirmed = await api.dialog.confirm(confirmMessage, 'Move to Trash');

      if (!confirmed) {
        return { success: false, error: 'User cancelled' };
      }
    }

    try {
      await api.file.trash(node.path);
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      const usePermanentDelete = await api.dialog.confirm(
        `Failed to move to trash: ${errorMessage}\n\nPermanently delete? (Cannot be recovered)`,
        'Deletion Failed'
      );

      if (usePermanentDelete) {
        try {
          await api.file.delete(node.path);
          return { success: true };
        } catch (deleteError) {
          const message = `Permanent deletion also failed: ${deleteError}`;
          this._onOperationError.fire(message);
          return { success: false, error: message };
        }
      }

      return { success: false, error: 'User cancelled' };
    }
  }

  // ====== Rename Operations ======

  async renameNode(
    oldPath: string,
    newName: string,
    entityType?: 'doc' | 'file' | 'folder',
    entityId?: string
  ): Promise<FileOperationResult> {
    const normalizedPath = oldPath.replace(/\\/g, '/');
    const lastSlashIndex = normalizedPath.lastIndexOf('/');
    const parentPath =
      lastSlashIndex > 0 ? normalizedPath.substring(0, lastSlashIndex) : normalizedPath;
    const newPath = `${parentPath}/${newName}`;

    if (oldPath === newPath) {
      return { success: true };
    }

    try {
      if (entityType && entityId) {
        await api.file.rename(oldPath, newPath, entityType, entityId);
      } else {
        await api.file.rename(oldPath, newPath);
      }
      return { success: true };
    } catch (error) {
      const message = `Rename failed: ${error}`;
      this._onOperationError.fire(message);
      return { success: false, error: message };
    }
  }

  // ====== Clipboard Operations ======

  copyToClipboard(items: ClipboardItem[]): void {
    this._clipboard = items.map((item) => ({ ...item, operation: 'copy' }));
  }

  cutToClipboard(items: ClipboardItem[]): void {
    this._clipboard = items.map((item) => ({ ...item, operation: 'cut' }));
  }

  getClipboard(): ClipboardItem[] {
    return [...this._clipboard];
  }

  clearClipboard(): void {
    this._clipboard = [];
  }

  /**
   * Paste files from internal clipboard
   *
   * If pasting multiple files (>= 3), uses batch mode to avoid triggering multiple UI updates.
   * Batch mode triggers only one file tree refresh after all operations complete.
   *
   * VS Code behavior: When file already exists, automatically uses incremental naming (e.g., test copy.txt)
   */
  async pasteFromClipboard(targetPath: string, projectPath?: string): Promise<FileOperationResult> {
    if (this._clipboard.length === 0) {
      return { success: false, error: 'Clipboard is empty' };
    }

    const useBatchMode = this._clipboard.length >= 3;
    if (useBatchMode) {
      this.beginBatchOperation();
    }

    const errors: string[] = [];
    const usedNames: string[] = [];

    try {
      for (const item of this._clipboard) {
        const originalFileName = item.path.split('/').pop() || item.path.split('\\').pop() || '';
        const isFolder = item.type === 'directory';

        let existingNames: string[] = [];
        try {
          const targetStats = await api.file.stats(targetPath);
          if (targetStats?.isDirectory) {
            const treeResult = await api.file.refreshTree(targetPath);
            if (treeResult.success && treeResult.fileTree?.children) {
              existingNames = treeResult.fileTree.children.map((c) => c.name);
            }
          }
        } catch {
          // Cannot get directory contents, continue with original name
        }

        const allExistingNames = [...existingNames, ...usedNames];

        const finalFileName = findAvailableFileName(
          originalFileName,
          allExistingNames,
          isFolder,
          'simple'
        );

        const destPath = `${targetPath}/${finalFileName}`;

        try {
          if (item.operation === 'copy') {
            await api.file.copy(item.path, destPath);
          } else {
            await api.file.move(item.path, destPath);
          }
          usedNames.push(finalFileName);
        } catch (error) {
          errors.push(`${originalFileName}: ${error}`);
        }
      }

      if (this._clipboard.some((item) => item.operation === 'cut')) {
        this.clearClipboard();
      }
    } finally {
      if (useBatchMode) {
        await this.endBatchOperation(projectPath || null);
      }
    }

    if (errors.length > 0) {
      const message = `Some operations failed:\n${errors.join('\n')}`;
      this._onOperationError.fire(message);
      return { success: false, error: message };
    }

    return { success: true };
  }

  // ====== System Clipboard ======

  /**
   * Paste files from system clipboard
   *
   * VS Code behavior: When file already exists, automatically uses incremental naming
   */
  async pasteFromSystemClipboard(targetPath: string): Promise<FileOperationResult> {
    try {
      const result = await api.file.getClipboard();
      if (!result.success || !result.files || result.files.length === 0) {
        return { success: false, error: 'No files in system clipboard' };
      }

      let existingNames: string[] = [];
      try {
        const treeResult = await api.file.refreshTree(targetPath);
        if (treeResult.success && treeResult.fileTree?.children) {
          existingNames = treeResult.fileTree.children.map((c) => c.name);
        }
      } catch {
        // Cannot get directory contents, continue
      }

      const errors: string[] = [];
      const usedNames: string[] = [];

      for (const srcPath of result.files) {
        const originalFileName = srcPath.split('/').pop() || srcPath.split('\\').pop() || '';

        let isFolder = false;
        try {
          const stats = await api.file.stats(srcPath);
          isFolder = stats?.isDirectory ?? false;
        } catch {
          // Cannot get stats, assume file
        }

        const allExistingNames = [...existingNames, ...usedNames];
        const finalFileName = findAvailableFileName(
          originalFileName,
          allExistingNames,
          isFolder,
          'simple'
        );

        const destPath = `${targetPath}/${finalFileName}`;

        try {
          await api.file.copy(srcPath, destPath);
          usedNames.push(finalFileName);
        } catch (error) {
          errors.push(`${originalFileName}: ${error}`);
        }
      }

      if (errors.length > 0) {
        return { success: false, error: errors.join('\n') };
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: `Paste failed: ${error}` };
    }
  }

  // ====== File Drag and Drop ======

  /**
   * Handle file drop
   *
   * If dropping multiple files (>= 3), uses batch mode to avoid triggering multiple UI updates.
   * VS Code behavior: When file already exists, automatically uses incremental naming
   */
  async handleFileDrop(
    files: File[],
    targetPath: string,
    projectPath?: string
  ): Promise<FileOperationResult> {
    const useBatchMode = files.length >= 3;
    if (useBatchMode) {
      this.beginBatchOperation();
    }

    let existingNames: string[] = [];
    try {
      const treeResult = await api.file.refreshTree(targetPath);
      if (treeResult.success && treeResult.fileTree?.children) {
        existingNames = treeResult.fileTree.children.map((c) => c.name);
      }
    } catch {
      // Cannot get directory contents, continue
    }

    const errors: string[] = [];
    const usedNames: string[] = [];

    try {
      for (const file of files) {
        const allExistingNames = [...existingNames, ...usedNames];
        const finalFileName = findAvailableFileName(file.name, allExistingNames, false, 'simple');

        const destPath = `${targetPath}/${finalFileName}`;

        try {
          const content = await file.text();
          await api.file.write(destPath, content);
          usedNames.push(finalFileName);
        } catch (error) {
          errors.push(`${file.name}: ${error}`);
        }
      }
    } finally {
      if (useBatchMode) {
        await this.endBatchOperation(projectPath || null);
      }
    }

    if (errors.length > 0) {
      return { success: false, error: errors.join('\n') };
    }
    return { success: true };
  }

  // ====== Show in System ======

  showInFolder(path: string): void {
    api.file.showInFolder(path).catch((error) => {
      this._onOperationError.fire(`Failed to show in folder: ${error}`);
    });
  }
}

// ====== Exports ======

let fileExplorerService: FileExplorerService | null = null;

export function getFileExplorerService(): FileExplorerService {
  if (!fileExplorerService) {
    fileExplorerService = FileExplorerService.getInstance();
  }
  return fileExplorerService;
}

export function useFileExplorerService(): FileExplorerService {
  return getFileExplorerService();
}
