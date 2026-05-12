/**
 * @file File tree, project open, and file watcher IPC handlers
 * @description Handles Project_GetRecent, Project_OpenByPath, Project_Open,
 *              File_Exists, File_Stats, File_RefreshTree, File_ResolveChildren,
 *              File_ScanPaths, FileWatcher_Start, FileWatcher_Stop, and file-changed event forwarding.
 * @security All path operations go through assertPathSecurity.
 */

import { dialog } from 'electron';
import fs from 'fs-extra';
import { IpcChannel } from '../../../shared/ipc/channels';
import { addAllowedDirectory, clearAllowedDirectories } from '../services/LocalFileProtocol';
import { createTypedHandlers } from './typedIpc';
import {
  type FileHandlersDeps,
  PathSecurityService,
  assertPathSecurity,
  logger,
  resolveProjectOpenRoot,
} from './fileHandlerHelpers';

// ============ Registration ============

export function registerFileTreeHandlers(deps: FileHandlersDeps): void {
  const { fileSystemService, getMainWindow, getWindows, addRecentProject, loadRecentProjects } =
    deps;

  createTypedHandlers(
    {
      // ============ Project ============
      [IpcChannel.Project_GetRecent]: async () => {
        const projects = await loadRecentProjects();
        return projects.map((p) => ({
          path: p.path,
          name: p.name,
          lastOpened: new Date(p.lastOpened).getTime() || Date.now(),
          isRemote: p.isRemote,
        }));
      },

      [IpcChannel.Project_OpenByPath]: async (projectPath) => {
        try {
          const safePath = assertPathSecurity(projectPath, 'read', { allowOutsideProject: true });
          const effectivePath = await resolveProjectOpenRoot(safePath);

          if (!(await fs.pathExists(effectivePath))) {
            console.error('Project path does not exist:', effectivePath);
            return null;
          }

          const fileTree = await fileSystemService.buildFileTree(effectivePath);
          await addRecentProject(effectivePath);

          PathSecurityService.setProjectPath(effectivePath);
          clearAllowedDirectories();
          addAllowedDirectory(effectivePath);

          return { projectPath: effectivePath, fileTree };
        } catch (error) {
          // Ignore race condition errors from rapid project switching
          const errorMessage = error instanceof Error ? error.message : String(error);
          if (
            errorMessage === 'Scan superseded by newer request' ||
            errorMessage === 'Scan aborted'
          ) {
            return null;
          }

          console.error('Failed to open project by path:', error);
          return null;
        }
      },

      [IpcChannel.Project_Open]: async () => {
        const mainWindow = getMainWindow();
        const result = await dialog.showOpenDialog(mainWindow!, {
          properties: ['openDirectory'],
          title: 'Select Project Folder',
        });

        if (result.canceled || result.filePaths.length === 0) {
          return null;
        }

        const selectedPath = result.filePaths[0];
        const projectPath = await resolveProjectOpenRoot(selectedPath);

        try {
          const fileTree = await fileSystemService.buildFileTree(projectPath);

          fileSystemService.startWatching(projectPath);

          await addRecentProject(projectPath);

          PathSecurityService.setProjectPath(projectPath);
          clearAllowedDirectories();
          addAllowedDirectory(projectPath);

          return { projectPath, fileTree };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          if (
            errorMessage === 'Scan superseded by newer request' ||
            errorMessage === 'Scan aborted'
          ) {
            return null;
          }

          console.error('Failed to open project folder:', error);
          return null;
        }
      },

      // ============ File Metadata & Tree ============
      [IpcChannel.File_Exists]: async (filePath) => {
        try {
          const safePath = assertPathSecurity(filePath, 'read');
          return fs.pathExists(safePath);
        } catch (error) {
          logger.warn(`[FileHandlers] Path exists check denied: ${filePath}`, error);
          return false;
        }
      },

      [IpcChannel.File_Stats]: async (filePath) => {
        try {
          const safePath = assertPathSecurity(filePath, 'read');
          const stats = await fs.stat(safePath);
          return {
            isFile: stats.isFile(),
            isDirectory: stats.isDirectory(),
            size: stats.size,
            mtime: stats.mtime.toISOString(),
            ctime: stats.ctime.toISOString(),
          };
        } catch (error) {
          if (error instanceof Error && error.message.includes('Access denied')) {
            logger.warn(`[FileHandlers] File stats denied: ${filePath}`, error);
          }
          return null;
        }
      },

      [IpcChannel.File_RefreshTree]: async (projectPath: string) => {
        try {
          const safePath = assertPathSecurity(projectPath, 'read');
          const fileTree = await fileSystemService.buildFileTree(safePath);
          return { success: true, fileTree };
        } catch (error) {
          logger.error(`Failed to refresh file tree: ${error}`);
          return { success: false, error: String(error) };
        }
      },

      [IpcChannel.File_ResolveChildren]: async (dirPath: string) => {
        try {
          const safePath = assertPathSecurity(dirPath, 'read');
          const children = await fileSystemService.resolveChildren(safePath);
          return { success: true, children };
        } catch (error) {
          logger.error(`Failed to resolve children: ${error}`);
          return { success: false, error: String(error) };
        }
      },

      // Scan all file paths (flat list for @ completion index)
      [IpcChannel.File_ScanPaths]: async (projectPath: string) => {
        try {
          const safePath = assertPathSecurity(projectPath, 'read');
          const paths = await fileSystemService.scanFilePaths(safePath);
          return { success: true, paths };
        } catch (error) {
          logger.error(`Failed to scan file paths: ${error}`);
          return { success: false, error: String(error) };
        }
      },

      // ============ File Watcher ============
      [IpcChannel.FileWatcher_Start]: (projectPath) => {
        const safePath = assertPathSecurity(projectPath, 'read');
        fileSystemService.startWatching(safePath);
        return { success: true };
      },

      [IpcChannel.FileWatcher_Stop]: () => {
        fileSystemService.stopWatching();
        return { success: true };
      },
    },
    { logErrors: true }
  ).registerAll();

  // Forward file watcher events to all windows
  fileSystemService.on('file-changed', (event: { type: string; path: string; mtime?: number }) => {
    const windows = getWindows();
    for (const win of windows.values()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IpcChannel.FileWatcher_Changed, event);
      }
    }
  });
}
