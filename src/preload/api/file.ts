/**
 * @file File API - File Operations API Module
 * @description Provides IPC interfaces for file read/write, directory operations, file watching
 * @depends electron.ipcRenderer
 */

import { ipcRenderer } from 'electron';
import { IpcChannel } from '../../../shared/ipc/channels';
import { createSafeListener, isPathSafe } from './_shared';

export const fileApi = {
  readFile: (filePath: string) => ipcRenderer.invoke(IpcChannel.File_Read, filePath),
  /**
   * Read file as binary ArrayBuffer
   * @sideeffect More efficient for large binary files (PDF, images) than text-based IPC
   */
  readFileBinary: (filePath: string): Promise<ArrayBuffer> =>
    ipcRenderer.invoke(IpcChannel.File_ReadBinary, filePath),

  /**
   * Get custom protocol URL for local file
   * Uses scipen-file:// protocol to efficiently load local files, avoiding IPC transfer of large binary files
   * @throws {Error} If the path contains potentially dangerous patterns
   */
  getLocalFileUrl: (filePath: string): string => {
    // Security: Validate path before generating URL
    if (!isPathSafe(filePath)) {
      console.error('[Preload] Blocked unsafe file path:', filePath);
      throw new Error('Access to this file path is not allowed for security reasons');
    }
    // Normalize path separators and encode
    const normalized = filePath.replace(/\\/g, '/');
    const encoded = encodeURIComponent(normalized).replace(/%2F/g, '/');
    return `scipen-file:///${encoded}`;
  },
  writeFile: (filePath: string, content: string) =>
    ipcRenderer.invoke(IpcChannel.File_Write, filePath, content),
  createFile: (filePath: string, content?: string) =>
    ipcRenderer.invoke(IpcChannel.File_Create, filePath, content),
  createFolder: (folderPath: string) => ipcRenderer.invoke(IpcChannel.Folder_Create, folderPath),
  deleteFile: (filePath: string, entityType?: string, entityId?: string) =>
    ipcRenderer.invoke(IpcChannel.File_Delete, filePath, entityType, entityId),
  /**
   * Move file to trash (recoverable deletion, VS Code default behavior)
   * @sideeffect File moved to system trash instead of permanent deletion
   */
  trashFile: (filePath: string) => ipcRenderer.invoke(IpcChannel.File_Trash, filePath),
  renameFile: (oldPath: string, newPath: string, entityType?: string, entityId?: string) =>
    ipcRenderer.invoke(IpcChannel.File_Rename, oldPath, newPath, entityType, entityId),
  copyFile: (srcPath: string, destPath: string) =>
    ipcRenderer.invoke(IpcChannel.File_Copy, srcPath, destPath),
  moveFile: (srcPath: string, destPath: string) =>
    ipcRenderer.invoke(IpcChannel.File_Move, srcPath, destPath),
  refreshFileTree: (projectPath: string) =>
    ipcRenderer.invoke(IpcChannel.File_RefreshTree, projectPath),
  /**
   * Resolve directory children (lazy loading)
   * @sideeffect Updates file tree with resolved children
   */
  resolveChildren: (dirPath: string) =>
    ipcRenderer.invoke(IpcChannel.File_ResolveChildren, dirPath),
  /**
   * Scan all file paths (flat list for @ completion index)
   * @sideeffect Builds file path index for autocomplete
   */
  scanFilePaths: (projectPath: string) =>
    ipcRenderer.invoke(IpcChannel.File_ScanPaths, projectPath),
  pathExists: (filePath: string) => ipcRenderer.invoke(IpcChannel.File_Exists, filePath),
  getFileStats: (filePath: string) => ipcRenderer.invoke(IpcChannel.File_Stats, filePath),
  showItemInFolder: (filePath: string) =>
    ipcRenderer.invoke(IpcChannel.File_ShowInFolder, filePath),
  openPath: (filePath: string) => ipcRenderer.invoke(IpcChannel.File_OpenPath, filePath),
  selectFiles: (options?: {
    filters?: Array<{ name: string; extensions: string[] }>;
    multiple?: boolean;
  }) => ipcRenderer.invoke(IpcChannel.File_Select, options),
  getClipboardFiles: () => ipcRenderer.invoke(IpcChannel.Clipboard_GetFiles),

  // ====== Batch File Operations ======
  /**
   * Batch read multiple files (reduces IPC round trips)
   */
  batchReadFiles: (
    filePaths: string[]
  ): Promise<
    Array<{
      path: string;
      success: boolean;
      content?: string;
      error?: string;
    }>
  > => ipcRenderer.invoke(IpcChannel.File_BatchRead, filePaths),

  batchStatFiles: (
    filePaths: string[]
  ): Promise<
    Array<{
      path: string;
      success: boolean;
      stats?: {
        isFile: boolean;
        isDirectory: boolean;
        size: number;
        mtime: string;
        ctime: string;
      };
      error?: string;
    }>
  > => ipcRenderer.invoke(IpcChannel.File_BatchStat, filePaths),

  batchPathExists: (
    filePaths: string[]
  ): Promise<
    Array<{
      path: string;
      exists: boolean;
    }>
  > => ipcRenderer.invoke(IpcChannel.File_BatchExists, filePaths),

  batchWriteFiles: (
    files: Array<{ path: string; content: string }>
  ): Promise<
    Array<{
      path: string;
      success: boolean;
      error?: string;
    }>
  > => ipcRenderer.invoke(IpcChannel.File_BatchWrite, files),

  batchDeleteFiles: (
    filePaths: string[]
  ): Promise<
    Array<{
      path: string;
      success: boolean;
      error?: string;
    }>
  > => ipcRenderer.invoke(IpcChannel.File_BatchDelete, filePaths),
};

// ====== File Watcher API ======
export const fileWatcherApi = {
  /**
   * Start file watching for a project
   * @sideeffect Registers file system watchers
   */
  start: (projectPath: string) => ipcRenderer.invoke(IpcChannel.FileWatcher_Start, projectPath),
  /**
   * Stop file watching
   * @sideeffect Unregisters file system watchers
   */
  stop: () => ipcRenderer.invoke(IpcChannel.FileWatcher_Stop),
  /**
   * Listen to external file change events
   * @returns Unsubscribe function
   * @sideeffect Registers IPC event listener that must be cleaned up
   */
  onFileChanged: createSafeListener<{
    type: 'change' | 'unlink' | 'add';
    path: string;
    mtime?: number;
  }>(IpcChannel.FileWatcher_Changed),
};
