/**
 * @file File operation IPC handlers - Entry point
 * @description Delegates to domain-specific sub-modules:
 *   - fileReadWriteHandlers: read/write/create/delete/rename/copy/move
 *   - fileTreeHandlers: project open, file tree, metadata, file watcher
 *   - fileBatchHandlers: batch read/stat/exists/write/delete
 *   - fileDialogHandlers: shell operations, dialogs, clipboard
 *   - fileCacheHandlers: inline below (small enough to stay in entry)
 * @security All path operations delegated to sub-modules via shared assertPathSecurity.
 */

import { IpcChannel } from '../../../shared/ipc/channels';
import { getFileCacheService } from '../services/FileCacheService';
import { registerFileBatchHandlers } from './fileBatchHandlers';
import { registerFileDialogHandlers } from './fileDialogHandlers';
import { assertPathSecurity, logger, type FileHandlersDeps } from './fileHandlerHelpers';
import { registerFileReadWriteHandlers } from './fileReadWriteHandlers';
import { registerFileTreeHandlers } from './fileTreeHandlers';
import { createTypedHandlers } from './typedIpc';

// Re-export types for external consumers
export type { FileHandlersDeps } from './fileHandlerHelpers';

/**
 * Register all file operation IPC handlers.
 * @sideeffect Registers ipcMain handlers and forwards file watcher events to windows.
 */
export function registerFileHandlers(deps: FileHandlersDeps): void {
  registerFileReadWriteHandlers(deps);
  registerFileTreeHandlers(deps);
  registerFileBatchHandlers(deps);
  registerFileDialogHandlers(deps);
  registerFileCacheHandlers();

  logger.info('[IPC] File handlers registered (type-safe)');
}

// ============ File Cache Handlers ============

/**
 * @sideeffect Registers ipcMain handlers for file cache operations.
 */
function registerFileCacheHandlers(): void {
  createTypedHandlers({
    [IpcChannel.FileCache_Stats]: async () => {
      const fileCache = getFileCacheService();
      return fileCache.getStats();
    },
    [IpcChannel.FileCache_Clear]: async () => {
      const fileCache = getFileCacheService();
      fileCache.clear();
      return { success: true };
    },
    [IpcChannel.FileCache_Warmup]: async (filePaths: string[]) => {
      const safePaths = filePaths.map((p) => assertPathSecurity(p, 'read'));
      const fileCache = getFileCacheService();
      const count = await fileCache.warmup(safePaths);
      return { success: true, cachedCount: count };
    },
    [IpcChannel.FileCache_Invalidate]: async (filePath: string) => {
      const safePath = assertPathSecurity(filePath, 'read');
      const fileCache = getFileCacheService();
      fileCache.invalidate(safePath);
      return { success: true };
    },
  }).registerAll();
}
