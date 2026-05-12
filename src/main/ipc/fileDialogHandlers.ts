/**
 * @file Shell, dialog, and clipboard IPC handlers
 * @description Handles File_ShowInFolder, File_OpenPath, Clipboard_GetFiles, File_Select channels.
 * @security All path operations go through assertPathSecurity.
 */

import path from 'path';
import { dialog, shell } from 'electron';
import fs from 'fs-extra';
import { IpcChannel } from '../../../shared/ipc/channels';
import { PathSecurityService } from '../services/PathSecurityService';
import { createTypedHandlers } from './typedIpc';
import { type FileHandlersDeps, assertPathSecurity } from './fileHandlerHelpers';

// ============ Registration ============

export function registerFileDialogHandlers(deps: FileHandlersDeps): void {
  const { getMainWindow } = deps;

  createTypedHandlers(
    {
      [IpcChannel.File_ShowInFolder]: (filePath) => {
        const safePath = assertPathSecurity(filePath, 'read');
        shell.showItemInFolder(safePath);
      },

      [IpcChannel.File_OpenPath]: async (filePath: string) => {
        const safePath = assertPathSecurity(filePath, 'read');
        const result = await shell.openPath(safePath);
        if (result) {
          throw new Error(result);
        }
        return true;
      },

      [IpcChannel.Clipboard_GetFiles]: async () => {
        try {
          const { clipboard } = await import('electron');

          if (process.platform === 'win32') {
            const filePaths = clipboard.readBuffer('FileNameW');
            if (filePaths && filePaths.length > 0) {
              const pathStr = filePaths.toString('utf16le');
              const paths = pathStr.split('\0').filter((p) => p.trim().length > 0);
              if (paths.length > 0) return paths;
            }
          }

          if (process.platform === 'darwin') {
            const filePaths = clipboard.readBuffer('public.file-url');
            if (filePaths && filePaths.length > 0) {
              const urlStr = filePaths.toString('utf8');
              if (urlStr.startsWith('file://')) {
                const filePath = decodeURIComponent(urlStr.replace('file://', ''));
                return [filePath];
              }
            }
          }

          return null;
        } catch {
          return null;
        }
      },

      [IpcChannel.File_Select]: async (options) => {
        const mainWindow = getMainWindow();
        const properties: Electron.OpenDialogOptions['properties'] = options?.directory
          ? ['openDirectory']
          : options?.multiple
            ? ['openFile', 'multiSelections']
            : ['openFile'];
        const result = await dialog.showOpenDialog(mainWindow!, {
          properties,
          filters: options?.directory
            ? undefined
            : options?.filters || [{ name: 'All Files', extensions: ['*'] }],
        });

        if (result.canceled) return null;

        PathSecurityService.authorizePathsTemporarily(result.filePaths);

        // directory mode: return paths without reading file content
        if (options?.directory) {
          return result.filePaths.map((dirPath) => ({
            path: dirPath,
            name: path.basename(dirPath),
            ext: '',
            content: new Uint8Array(0),
          }));
        }

        const files = await Promise.all(
          result.filePaths.map(async (filePath) => {
            const content = await fs.readFile(filePath);
            const name = path.basename(filePath);
            const ext = path.extname(filePath);
            // Return raw Uint8Array - Electron IPC handles binary natively
            return { path: filePath, name, ext, content: new Uint8Array(content) };
          })
        );

        return files;
      },
    },
    { logErrors: true }
  ).registerAll();
}
