/**
 * @file Batch file operation IPC handlers
 * @description Handles File_BatchRead, File_BatchStat, File_BatchExists,
 *              File_BatchWrite, File_BatchDelete channels.
 * @security All path operations go through assertPathSecurity.
 */

import fs from 'fs-extra';
import { IpcChannel } from '../../../shared/ipc/channels';
import { createTypedHandlers } from './typedIpc';
import { type FileHandlersDeps, assertPathSecurity } from './fileHandlerHelpers';

// ============ Registration ============

export function registerFileBatchHandlers(deps: FileHandlersDeps): void {
  const { fileSystemService } = deps;

  createTypedHandlers(
    {
      [IpcChannel.File_BatchRead]: async (filePaths) => {
        const results: Array<{
          path: string;
          success: boolean;
          content?: string;
          error?: string;
        }> = [];

        await Promise.all(
          filePaths.map(async (filePath) => {
            try {
              const safePath = assertPathSecurity(filePath, 'read');
              const content = await fs.readFile(safePath, 'utf-8');
              await fileSystemService.recordFileMtime(safePath);
              results.push({ path: filePath, success: true, content });
            } catch (error) {
              results.push({
                path: filePath,
                success: false,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          })
        );

        return results;
      },

      [IpcChannel.File_BatchStat]: async (filePaths) => {
        const results: Array<{
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
        }> = [];

        await Promise.all(
          filePaths.map(async (filePath) => {
            try {
              const safePath = assertPathSecurity(filePath, 'read');
              const stats = await fs.stat(safePath);
              results.push({
                path: filePath,
                success: true,
                stats: {
                  isFile: stats.isFile(),
                  isDirectory: stats.isDirectory(),
                  size: stats.size,
                  mtime: stats.mtime.toISOString(),
                  ctime: stats.ctime.toISOString(),
                },
              });
            } catch (error) {
              results.push({
                path: filePath,
                success: false,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          })
        );

        return results;
      },

      [IpcChannel.File_BatchExists]: async (filePaths) => {
        const results: Array<{ path: string; exists: boolean }> = [];

        await Promise.all(
          filePaths.map(async (filePath) => {
            try {
              const safePath = assertPathSecurity(filePath, 'read');
              const exists = await fs.pathExists(safePath);
              results.push({ path: filePath, exists });
            } catch {
              results.push({ path: filePath, exists: false });
            }
          })
        );

        return results;
      },

      [IpcChannel.File_BatchWrite]: async (files) => {
        const results: Array<{
          path: string;
          success: boolean;
          error?: string;
        }> = [];

        for (const file of files) {
          try {
            const safePath = assertPathSecurity(file.path, 'write');
            const tempPath = `${safePath}.tmp.${Date.now()}`;

            await fs.writeFile(tempPath, file.content, 'utf-8');
            await fs.rename(tempPath, safePath);
            const stats = await fs.stat(safePath);
            fileSystemService.updateFileMtime(safePath, stats.mtimeMs);
            results.push({ path: file.path, success: true });
          } catch (error) {
            results.push({
              path: file.path,
              success: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        return results;
      },

      [IpcChannel.File_BatchDelete]: async (filePaths) => {
        const results: Array<{
          path: string;
          success: boolean;
          error?: string;
        }> = [];

        await Promise.all(
          filePaths.map(async (filePath) => {
            try {
              const safePath = assertPathSecurity(filePath, 'delete');
              await fs.remove(safePath);
              results.push({ path: filePath, success: true });
            } catch (error) {
              results.push({
                path: filePath,
                success: false,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          })
        );

        return results;
      },
    },
    { logErrors: true }
  ).registerAll();
}
