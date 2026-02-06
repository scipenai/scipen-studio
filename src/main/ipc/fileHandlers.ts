/**
 * @file File operation IPC handlers (Type-Safe)
 * @description Handles file read/write, directory scanning, and file dialogs via IPC.
 * @security Integrates PathSecurityService for all path operations.
 * @depends PathSecurityService, FileCacheService, IFileSystemService, Overleaf services
 */

import path from 'path';
import { type BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { IpcChannel } from '../../../shared/ipc/channels';
import { getFileCacheService } from '../services/FileCacheService';
import { addAllowedDirectory, clearAllowedDirectories } from '../services/LocalFileProtocol';
import { createLogger } from '../services/LoggerService';
import {
  type PathAccessMode,
  PathSecurityService,
  checkPathSecurity,
} from '../services/PathSecurityService';
import type {
  IFileSystemService,
  IOverleafFileSystemService,
  IOverleafService,
} from '../services/interfaces';
import fs from '../services/knowledge/utils/fsCompat';
import { createTypedHandlers } from './typedIpc';

// ============ Dependencies & Logger ============

const logger = createLogger('FileHandlers');

// ============ Path Helpers ============

/**
 * @remarks Treats both `overleaf://` and legacy `overleaf:` prefixes as remote paths.
 */
export const isRemotePath = (filePath: string): boolean => {
  return filePath?.startsWith('overleaf://') || filePath?.startsWith('overleaf:');
};

/** @security Validate path security, throws if unsafe */
function assertPathSecurity(
  filePath: string,
  mode: PathAccessMode = 'read',
  options?: { allowOutsideProject?: boolean }
): string {
  if (isRemotePath(filePath)) {
    return filePath;
  }

  const context = options?.allowOutsideProject ? 'user-selected' : 'project';
  const result = checkPathSecurity(filePath, mode, context);

  if (!result.allowed) {
    console.error(`[PathSecurity] Access denied: ${result.reason}`);
    throw new Error(result.reason || 'Access denied');
  }

  return result.sanitizedPath || filePath;
}

/**
 * @remarks Returns null when not an Overleaf path or when project ID cannot be parsed.
 */
export const getProjectIdFromPath = (filePath: string): string | null => {
  if (!isRemotePath(filePath)) return null;
  let match = filePath.match(/^overleaf:\/\/([^/]+)/);
  if (match) return match[1];
  match = filePath.match(/^overleaf:[\\/]?([^\\/]+)/);
  return match ? match[1] : null;
};

/**
 * @remarks Returns original path for non-Overleaf URIs; strips project prefix otherwise.
 */
export const getRelativePathFromRemote = (filePath: string): string => {
  const projectId = getProjectIdFromPath(filePath);
  if (!projectId) return filePath;
  return filePath.replace(/^overleaf:\/\/[^/]+\//, '').replace(/^overleaf:[\\/]?[^\\/]+[\\/]/, '');
};

/**
 * @remarks Empty or root paths resolve to root folder ID; returns null if not found.
 */
export const findFolderIdByPath = (
  rootFolder: { _id: string; name?: string; folders?: unknown[] },
  targetPath: string
): string | null => {
  if (!targetPath || targetPath === '' || targetPath === '/') {
    return rootFolder._id;
  }

  const pathParts = targetPath.split('/').filter((p: string) => p);

  const searchInFolder = (
    folder: { _id: string; folders?: unknown[] },
    pathIndex: number
  ): string | null => {
    if (pathIndex >= pathParts.length) {
      return folder._id;
    }

    const targetName = pathParts[pathIndex];

    if (folder.folders) {
      for (const subFolder of folder.folders as Array<{
        _id: string;
        name: string;
        folders?: unknown[];
      }>) {
        if (subFolder.name === targetName) {
          return searchInFolder(subFolder, pathIndex + 1);
        }
      }
    }

    return null;
  };

  return searchInFolder(rootFolder, 0);
};

// ============ Types ============

/**
 * Dependencies required for IPC handler registration.
 * @remarks Callers should provide live services; handlers are long-lived.
 */
export interface FileHandlersDeps {
  fileSystemService: IFileSystemService;
  getOverleafCompiler: () => IOverleafService | null;
  getOverleafFileSystem: () => IOverleafFileSystemService | null;
  getMainWindow: () => BrowserWindow | null;
  getWindows: () => Map<number, BrowserWindow>;
  addRecentProject: (projectPath: string, isRemote?: boolean) => Promise<void>;
  loadRecentProjects: () => Promise<
    Array<{
      id: string;
      name: string;
      path: string;
      lastOpened: string;
      isRemote?: boolean;
    }>
  >;
}

// ============ IPC Registration ============

/**
 * Register IPC handlers for file operations.
 * @sideeffect Registers ipcMain handlers and forwards file watcher events to windows.
 */
export function registerFileHandlers(deps: FileHandlersDeps): void {
  const {
    fileSystemService,
    getOverleafCompiler,
    getOverleafFileSystem,
    getMainWindow,
    getWindows,
    addRecentProject,
    loadRecentProjects,
  } = deps;

  const handlers = createTypedHandlers(
    {
      // ============ Project ============
      [IpcChannel.Project_GetRecent]: async () => {
        const projects = await loadRecentProjects();
        return projects.map((p) => ({
          path: p.path,
          name: p.name,
          lastOpened: new Date(p.lastOpened).getTime() || Date.now(),
        }));
      },

      [IpcChannel.Project_OpenByPath]: async (projectPath) => {
        try {
          const safePath = assertPathSecurity(projectPath, 'read', { allowOutsideProject: true });

          if (!(await fs.pathExists(safePath))) {
            console.error('Project path does not exist:', safePath);
            return null;
          }

          const fileTree = await fileSystemService.buildFileTree(safePath);
          await addRecentProject(safePath);

          PathSecurityService.setProjectPath(safePath);
          clearAllowedDirectories();
          addAllowedDirectory(safePath);

          return { projectPath: safePath, fileTree };
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

        const projectPath = result.filePaths[0];

        try {
          const fileTree = await fileSystemService.buildFileTree(projectPath);

          if (!projectPath.startsWith('overleaf://') && !projectPath.startsWith('overleaf:')) {
            fileSystemService.startWatching(projectPath);
          }

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

      // ============ File Read/Write ============
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
        if (isRemotePath(filePath)) {
          throw new Error('Remote files cannot be saved via local filesystem, use Overleaf API');
        }

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
        if (isRemotePath(filePath)) {
          const overleafCompiler = getOverleafCompiler();
          if (!overleafCompiler) throw new Error('Please login to Overleaf first');

          const projectId = getProjectIdFromPath(filePath);
          if (!projectId) throw new Error('Cannot get remote project ID');

          const relativePath = getRelativePathFromRemote(filePath);
          const pathParts = relativePath.split('/').filter((p: string) => p);
          const fileName = pathParts.pop() || relativePath;
          const parentPath = pathParts.join('/');

          const projectDetails = await overleafCompiler.getProjectDetailsViaSocket(projectId);
          if (!projectDetails?.rootFolder?.[0]) throw new Error('Cannot get project root folder');

          const rootFolder = projectDetails.rootFolder[0] as {
            _id: string;
            name?: string;
            folders?: unknown[];
          };
          const parentFolderId = findFolderIdByPath(rootFolder, parentPath);
          if (!parentFolderId) throw new Error(`Cannot find parent folder: ${parentPath}`);

          const result = await overleafCompiler.createDoc(projectId, parentFolderId, fileName);
          if (!result.success) throw new Error('Failed to create remote file');

          return true;
        }

        const safePath = assertPathSecurity(filePath, 'write');

        await fs.ensureFile(safePath);
        await fs.writeFile(safePath, content, 'utf-8');
        return true;
      },

      [IpcChannel.Folder_Create]: async (folderPath) => {
        if (isRemotePath(folderPath)) {
          const overleafCompiler = getOverleafCompiler();
          if (!overleafCompiler) throw new Error('Please login to Overleaf first');

          const projectId = getProjectIdFromPath(folderPath);
          if (!projectId) throw new Error('Cannot get remote project ID');

          const relativePath = getRelativePathFromRemote(folderPath);
          const pathParts = relativePath.split('/').filter((p: string) => p);
          const folderName = pathParts.pop() || relativePath;
          const parentPath = pathParts.join('/');

          const projectDetails = await overleafCompiler.getProjectDetailsViaSocket(projectId);
          if (!projectDetails?.rootFolder?.[0]) throw new Error('Cannot get project root folder');

          const rootFolder = projectDetails.rootFolder[0] as {
            _id: string;
            name?: string;
            folders?: unknown[];
          };
          const parentFolderId = findFolderIdByPath(rootFolder, parentPath);
          if (!parentFolderId) throw new Error(`Cannot find parent folder: ${parentPath}`);

          const result = await overleafCompiler.createFolder(projectId, parentFolderId, folderName);
          if (!result.success) throw new Error('Failed to create remote folder');

          return true;
        }

        const safePath = assertPathSecurity(folderPath, 'write');

        await fs.ensureDir(safePath);
        return true;
      },

      // ============ File Lifecycle ============
      [IpcChannel.File_Delete]: async (filePath, entityType, entityId) => {
        if (isRemotePath(filePath)) {
          const overleafCompiler = getOverleafCompiler();
          if (!overleafCompiler) throw new Error('Please login to Overleaf first');

          const overleafFS = getOverleafFileSystem();
          if (!overleafFS) throw new Error('Overleaf file system service unavailable');

          const projectId = getProjectIdFromPath(filePath);
          if (!projectId) throw new Error('Cannot get remote project ID');

          if (!entityId || !entityType) {
            const srcRelativePath = getRelativePathFromRemote(filePath);
            const entity = await overleafFS.resolvePathToEntity(projectId, srcRelativePath);
            if (!entity) throw new Error(`Cannot resolve source entity: ${srcRelativePath}`);
            entityType = entity.type;
            entityId = entity.id;
          }

          const success = await overleafCompiler.deleteEntity(
            projectId,
            entityType as 'doc' | 'file' | 'folder',
            entityId
          );
          if (!success) throw new Error('Failed to delete remote file');

          return true;
        }

        const safePath = assertPathSecurity(filePath, 'delete');

        await fs.remove(safePath);
        return true;
      },

      // Move file to trash (recoverable delete, VS Code default behavior)
      [IpcChannel.File_Trash]: async (filePath: string) => {
        if (isRemotePath(filePath)) {
          throw new Error('Remote projects do not support trash, use permanent delete');
        }

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

      [IpcChannel.File_Rename]: async (oldPath, newPath, entityType, entityId) => {
        if (isRemotePath(oldPath)) {
          const overleafCompiler = getOverleafCompiler();
          if (!overleafCompiler) throw new Error('Please login to Overleaf first');

          const overleafFS = getOverleafFileSystem();
          if (!overleafFS) throw new Error('Overleaf file system service unavailable');

          const projectId = getProjectIdFromPath(oldPath);
          if (!projectId) throw new Error('Cannot get remote project ID');

          if (!entityId || !entityType) {
            const srcRelativePath = getRelativePathFromRemote(oldPath);
            const entity = await overleafFS.resolvePathToEntity(projectId, srcRelativePath);
            if (!entity) throw new Error(`Cannot resolve source entity: ${srcRelativePath}`);
            entityType = entity.type;
            entityId = entity.id;
          }

          const newName = newPath.split('/').pop() || newPath.split('\\').pop() || newPath;

          const success = await overleafCompiler.renameEntity(
            projectId,
            entityType as 'doc' | 'file' | 'folder',
            entityId,
            newName
          );
          if (!success) throw new Error('Failed to rename remote file');

          return true;
        }

        const safeOldPath = assertPathSecurity(oldPath, 'read');
        const safeNewPath = assertPathSecurity(newPath, 'write');

        await fs.rename(safeOldPath, safeNewPath);
        return true;
      },

      [IpcChannel.File_Copy]: async (srcPath, destPath, options) => {
        if (isRemotePath(srcPath) || isRemotePath(destPath)) {
          const isSrcRemote = isRemotePath(srcPath);
          const isDestRemote = isRemotePath(destPath);
          if (!isSrcRemote || !isDestRemote) {
            throw new Error('Copy between local and remote is not supported');
          }

          const overleafFS = getOverleafFileSystem();
          if (!overleafFS) {
            throw new Error('Please login to Overleaf first');
          }

          const projectId = getProjectIdFromPath(srcPath);
          const destProjectId = getProjectIdFromPath(destPath);
          if (!projectId || !destProjectId) {
            throw new Error('Cannot get remote project ID');
          }
          if (projectId !== destProjectId) {
            throw new Error('Cross-project copy is not supported');
          }

          const srcRelativePath = getRelativePathFromRemote(srcPath);
          const destRelativePath = getRelativePathFromRemote(destPath);
          const destParts = destRelativePath.split('/').filter((p) => p.length > 0);
          const destName = destParts.pop() || destRelativePath;
          const destParentPath = destParts.join('/');

          let entityType = options?.entityType;
          let entityId = options?.entityId;
          let targetFolderId = options?.targetFolderId;

          if (!entityType || !entityId) {
            const entity = await overleafFS.resolvePathToEntity(projectId, srcRelativePath);
            if (!entity) {
              throw new Error(`Cannot resolve source entity: ${srcRelativePath}`);
            }
            entityType = entity.type;
            entityId = entity.id;
          }

          if (!targetFolderId) {
            const resolvedFolderId = await overleafFS.resolveFolderIdByPath(
              projectId,
              destParentPath
            );
            if (!resolvedFolderId) {
              throw new Error(`Cannot find target folder: ${destParentPath || '/'}`);
            }
            targetFolderId = resolvedFolderId;
          }

          const srcName = srcRelativePath.split('/').pop() || srcRelativePath;
          const newName = destName !== srcName ? destName : undefined;

          logger.info(
            `[File_Copy] Remote copy: ${entityType}/${entityId} -> folder/${targetFolderId}, newName=${newName || '(same)'}`
          );

          const result = await overleafFS.copyEntity(
            projectId,
            entityType,
            entityId,
            targetFolderId,
            newName
          );

          if (!result.success) {
            throw new Error(result.error || 'Remote copy failed');
          }

          return true;
        }

        const safeSrcPath = assertPathSecurity(srcPath, 'read');
        const safeDestPath = assertPathSecurity(destPath, 'write');

        await fs.copy(safeSrcPath, safeDestPath);
        return true;
      },

      [IpcChannel.File_Move]: async (srcPath, destPath, options) => {
        if (isRemotePath(srcPath) || isRemotePath(destPath)) {
          const isSrcRemote = isRemotePath(srcPath);
          const isDestRemote = isRemotePath(destPath);
          if (!isSrcRemote || !isDestRemote) {
            throw new Error('Move between local and remote is not supported');
          }

          const overleafFS = getOverleafFileSystem();
          if (!overleafFS) {
            throw new Error('Please login to Overleaf first');
          }

          const projectId = getProjectIdFromPath(srcPath);
          const destProjectId = getProjectIdFromPath(destPath);
          if (!projectId || !destProjectId) {
            throw new Error('Cannot get remote project ID');
          }
          if (projectId !== destProjectId) {
            throw new Error('Cross-project move is not supported');
          }

          const srcRelativePath = getRelativePathFromRemote(srcPath);
          const destRelativePath = getRelativePathFromRemote(destPath);
          const destParts = destRelativePath.split('/').filter((p) => p.length > 0);
          const destName = destParts.pop() || destRelativePath;
          const destParentPath = destParts.join('/');

          let entityType = options?.entityType;
          let entityId = options?.entityId;
          let targetFolderId = options?.targetFolderId;

          if (!entityType || !entityId) {
            const entity = await overleafFS.resolvePathToEntity(projectId, srcRelativePath);
            if (!entity) {
              throw new Error(`Cannot resolve source entity: ${srcRelativePath}`);
            }
            entityType = entity.type;
            entityId = entity.id;
          }

          if (!targetFolderId) {
            const resolvedFolderId = await overleafFS.resolveFolderIdByPath(
              projectId,
              destParentPath
            );
            if (!resolvedFolderId) {
              throw new Error(`Cannot find target folder: ${destParentPath || '/'}`);
            }
            targetFolderId = resolvedFolderId;
          }

          const srcName = srcRelativePath.split('/').pop() || srcRelativePath;
          const shouldRename = destName !== srcName;

          logger.info(
            `[File_Move] Remote move: ${entityType}/${entityId} -> folder/${targetFolderId}, rename=${shouldRename}`
          );

          const success = await overleafFS.moveEntity(
            projectId,
            entityType,
            entityId,
            targetFolderId
          );

          if (!success) {
            throw new Error('Remote move failed');
          }

          if (shouldRename) {
            const renamed = await overleafFS.renameEntity(
              projectId,
              entityType,
              entityId,
              destName
            );
            if (!renamed) {
              throw new Error('Remote rename failed');
            }
          }

          return true;
        }

        const safeSrcPath = assertPathSecurity(srcPath, 'read');
        const safeDestPath = assertPathSecurity(destPath, 'write');

        await fs.move(safeSrcPath, safeDestPath);
        return true;
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

      // ============ Shell & Dialogs ============
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
        const result = await dialog.showOpenDialog(mainWindow!, {
          properties: options?.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
          filters: options?.filters || [{ name: 'All Files', extensions: ['*'] }],
        });

        if (result.canceled) return null;

        PathSecurityService.authorizePathsTemporarily(result.filePaths);

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

      // ============ Batch Operations ============
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
          if (isRemotePath(file.path)) {
            results.push({
              path: file.path,
              success: false,
              error: 'Remote files cannot be saved via local filesystem',
            });
            continue;
          }

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
            if (isRemotePath(filePath)) {
              results.push({
                path: filePath,
                success: false,
                error: 'Use dedicated API to delete remote files',
              });
              return;
            }

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

      // ============ File Watcher ============
      [IpcChannel.FileWatcher_Start]: (projectPath) => {
        if (!projectPath.startsWith('overleaf://') && !projectPath.startsWith('overleaf:')) {
          const safePath = assertPathSecurity(projectPath, 'read');
          fileSystemService.startWatching(safePath);
          return { success: true };
        }
        return { success: false, reason: 'Remote projects are not watched' };
      },

      [IpcChannel.FileWatcher_Stop]: () => {
        fileSystemService.stopWatching();
        return { success: true };
      },
    },
    { logErrors: true }
  );

  handlers.registerAll();

  fileSystemService.on('file-changed', (event: { type: string; path: string; mtime?: number }) => {
    const windows = getWindows();
    for (const win of windows.values()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IpcChannel.FileWatcher_Changed, event);
      }
    }
  });

  registerFileCacheHandlers(fileSystemService);

  logger.info('[IPC] File handlers registered (type-safe)');
}

// ============ File Cache Handlers ============

/**
 * @sideeffect Registers ipcMain handlers for file cache operations.
 */
function registerFileCacheHandlers(_fileSystemService: IFileSystemService): void {
  ipcMain.handle(IpcChannel.FileCache_Stats, async () => {
    const fileCache = getFileCacheService();
    return fileCache.getStats();
  });

  ipcMain.handle(IpcChannel.FileCache_Clear, async () => {
    const fileCache = getFileCacheService();
    fileCache.clear();
    return { success: true };
  });

  ipcMain.handle(IpcChannel.FileCache_Warmup, async (_event, filePaths: string[]) => {
    const safePaths = filePaths.map((p) => assertPathSecurity(p, 'read'));
    const fileCache = getFileCacheService();
    const count = await fileCache.warmup(safePaths);
    return { success: true, cachedCount: count };
  });

  ipcMain.handle(IpcChannel.FileCache_Invalidate, async (_event, filePath: string) => {
    const safePath = assertPathSecurity(filePath, 'read');
    const fileCache = getFileCacheService();
    fileCache.invalidate(safePath);
    return { success: true };
  });
}
