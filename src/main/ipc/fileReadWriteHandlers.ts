/**
 * @file File read/write and lifecycle IPC handlers
 * @description Handles File_Read, File_ReadBinary, File_Write, File_Create, Folder_Create,
 *              File_Delete, File_Trash, File_Rename, File_Copy, File_Move, and FileCache_* channels.
 * @security All path operations go through assertPathSecurity.
 */

import { shell } from 'electron';
import fs from 'fs-extra';
import { IpcChannel } from '../../../shared/ipc/channels';
import { getFileCacheService } from '../services/FileCacheService';
import { createTypedHandlers } from './typedIpc';
import { type FileHandlersDeps, assertPathSecurity, logger } from './fileHandlerHelpers';

// ============ Registration ============

export function registerFileReadWriteHandlers(deps: FileHandlersDeps): void {
  const { fileSystemService } = deps;

  createTypedHandlers(
    {
      // VSCode-style: returns content+mtime in one call
      [IpcChannel.File_Read]: async (filePath) => {
        const safePath = assertPathSecurity(filePath, 'read');
        const fileCache = getFileCacheService();

        let currentMtime: number;
        try {
          const stats = await fs.stat(safePath);
          currentMtime = stats.mtimeMs;
        } catch {
          currentMtime = Date.now();
        }

        const cached = await fileCache.get(safePath);
        if (cached) {
          const cachedMtime = fileSystemService.getCachedMtime(safePath);
          if (cachedMtime !== undefined) {
            if (Math.abs(currentMtime - cachedMtime) < 100) {
              return { content: cached.content, mtime: currentMtime };
            }
            logger.info('[FileRead] Cache stale, mtime changed:', safePath);
            fileCache.invalidate(safePath);
          } else {
            fileSystemService.updateFileMtime(safePath, currentMtime);
            return { content: cached.content, mtime: currentMtime };
          }
        }

        const content = await fs.readFile(safePath, 'utf-8');
        fileSystemService.updateFileMtime(safePath, currentMtime);
        await fileCache.set(safePath, content);

        return { content, mtime: currentMtime };
      },

      [IpcChannel.File_ReadBinary]: async (filePath) => {
        const safePath = assertPathSecurity(filePath, 'read');

        const buffer = await fs.readFile(safePath);
        const arrayBuffer = buffer.buffer.slice(
          buffer.byteOffset,
          buffer.byteOffset + buffer.byteLength
        );
        return arrayBuffer as ArrayBuffer;
      },

      // VSCode-style write with conflict detection
      [IpcChannel.File_Write]: async (filePath, content, expectedMtime?: number) => {
        const safePath = assertPathSecurity(filePath, 'write');
        const fileCache = getFileCacheService();
        const fileExists = await fs.pathExists(safePath);

        // VSCode-style conflict detection
        if (expectedMtime !== undefined && fileExists) {
          try {
            const currentStats = await fs.stat(safePath);
            const currentMtime = currentStats.mtimeMs;

            if (Math.abs(currentMtime - expectedMtime) > 100) {
              logger.info('[FileWrite] Conflict detected:', {
                path: filePath,
                expectedMtime,
                currentMtime,
                diff: currentMtime - expectedMtime,
              });

              return {
                success: false,
                conflict: true,
                currentMtime,
              };
            }
          } catch {
            // Continue save if mtime unavailable
          }
        }

        const tempPath = `${safePath}.tmp.${Date.now()}`;

        try {
          await fs.writeFile(tempPath, content, 'utf-8');

          const backupPath = `${safePath}.backup`;
          if (fileExists) {
            try {
              await fs.copy(safePath, backupPath, { overwrite: true });
            } catch {
              // Ignore backup errors
            }
          }

          await fs.rename(tempPath, safePath);

          const stats = await fs.stat(safePath);
          const newMtime = stats.mtimeMs;
          fileSystemService.updateFileMtime(safePath, newMtime);
          await fileCache.set(safePath, content);

          if (fileExists) {
            try {
              await fs.remove(backupPath);
            } catch {
              // Ignore cleanup errors
            }
          }

          return { success: true, currentMtime: newMtime };
        } catch (error) {
          try {
            await fs.remove(tempPath);
          } catch {
            // Ignore cleanup errors
          }
          throw error;
        }
      },

      [IpcChannel.File_Create]: async (filePath, content = '') => {
        const safePath = assertPathSecurity(filePath, 'write');

        await fs.ensureFile(safePath);
        await fs.writeFile(safePath, content, 'utf-8');
        return true;
      },

      [IpcChannel.Folder_Create]: async (folderPath) => {
        const safePath = assertPathSecurity(folderPath, 'write');

        await fs.ensureDir(safePath);
        return true;
      },

      // ============ File Lifecycle ============
      [IpcChannel.File_Delete]: async (filePath) => {
        const safePath = assertPathSecurity(filePath, 'delete');

        await fs.remove(safePath);
        return true;
      },

      // Move file to trash (recoverable delete, VS Code default behavior)
      [IpcChannel.File_Trash]: async (filePath: string) => {
        const safePath = assertPathSecurity(filePath, 'delete');

        try {
          await shell.trashItem(safePath);
          logger.info('Moved to trash:', safePath);
          return true;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error(`Failed to move to trash: ${safePath} - ${errorMessage}`);
          throw new Error(`Failed to move to trash: ${errorMessage}`);
        }
      },

      [IpcChannel.File_Rename]: async (oldPath, newPath) => {
        const safeOldPath = assertPathSecurity(oldPath, 'read');
        const safeNewPath = assertPathSecurity(newPath, 'write');

        await fs.rename(safeOldPath, safeNewPath);
        return true;
      },

      [IpcChannel.File_Copy]: async (srcPath, destPath) => {
        const safeSrcPath = assertPathSecurity(srcPath, 'read');
        const safeDestPath = assertPathSecurity(destPath, 'write');

        await fs.copy(safeSrcPath, safeDestPath);
        return true;
      },

      [IpcChannel.File_Move]: async (srcPath, destPath) => {
        const safeSrcPath = assertPathSecurity(srcPath, 'read');
        const safeDestPath = assertPathSecurity(destPath, 'write');

        await fs.move(safeSrcPath, safeDestPath);
        return true;
      },
    },
    { logErrors: true }
  ).registerAll();
}
