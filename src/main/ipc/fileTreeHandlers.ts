/**
 * @file File tree, project open, and file watcher IPC handlers
 * @description Handles Project_GetRecent, Project_OpenByPath, Project_Open,
 *              File_Exists, File_Stats, File_RefreshTree, File_ResolveChildren,
 *              File_ScanPaths, FileWatcher_Start, FileWatcher_Stop, and file-changed event forwarding.
 * @security All path operations go through assertPathSecurity.
 */

import { app, dialog } from 'electron';
import fs from 'fs-extra';
import path from 'node:path';
import { IpcChannel } from '../../../shared/ipc/channels';
import type { ProjectTemplateDTO } from '../../../shared/ipc/file-contract';
import { addAllowedDirectory, clearAllowedDirectories } from '../services/LocalFileProtocol';
import { getBibTexSyncService } from '../services/zotero/BibTexSyncService';
import { createTypedHandlers } from './typedIpc';
import {
  type FileHandlersDeps,
  PathSecurityService,
  assertPathSecurity,
  logger,
  resolveProjectOpenRoot,
} from './fileHandlerHelpers';

// ============ Registration ============

/**
 * Locate the bundled templates directory. Mirrors `resolveBundledSkillsDir`
 * in agentHandlers: packaged builds put extraResources under
 * `process.resourcesPath`, dev runs read them from the repo.
 */
function resolveBundledTemplatesDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'templates')
    : path.join(app.getAppPath(), 'resources', 'templates');
}

/**
 * Read the template manifest. Returns an empty list (never throws) when the
 * manifest is missing or malformed — a broken bundle should degrade to "no
 * templates offered", not break the welcome screen.
 */
async function readTemplateManifest(): Promise<ProjectTemplateDTO[]> {
  const manifestPath = path.join(resolveBundledTemplatesDir(), 'manifest.json');
  try {
    const raw = await fs.readFile(manifestPath, 'utf-8');
    const parsed = JSON.parse(raw) as { templates?: unknown };
    if (!Array.isArray(parsed.templates)) return [];
    return parsed.templates.flatMap((entry) => {
      const t = entry as Partial<ProjectTemplateDTO> & { dir?: string };
      if (typeof t.id !== 'string' || typeof t.mainFile !== 'string') return [];
      return [
        {
          id: t.id,
          mainFile: t.mainFile,
          engine: t.engine === 'typst' ? ('typst' as const) : ('latex' as const),
          offline: t.offline !== false,
        },
      ];
    });
  } catch (error) {
    logger.warn('Template manifest unreadable', {
      manifestPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Test-only access to the manifest reader. Exported (rather than the reader
 * itself) so the name states its purpose and production callers are not
 * tempted to reach past the IPC handler.
 */
export const __readTemplateManifestForTests = readTemplateManifest;

export function registerFileTreeHandlers(deps: FileHandlersDeps): void {
  const { fileSystemService, getMainWindow, getWindows, addRecentProject, loadRecentProjects } =
    deps;

  createTypedHandlers(
    {
      // ============ Project ============
      [IpcChannel.Project_ListTemplates]: async () => readTemplateManifest(),

      [IpcChannel.Project_CreateFromTemplate]: async (templateId, projectName) => {
        const mainWindow = getMainWindow();
        if (!mainWindow) return { ok: false as const, error: 'No window available' };

        const template = (await readTemplateManifest()).find((t) => t.id === templateId);
        if (!template) return { ok: false as const, error: `Unknown template: ${templateId}` };

        const templateDir = path.join(resolveBundledTemplatesDir(), templateId);
        if (!(await fs.pathExists(templateDir))) {
          return { ok: false as const, error: `Template files missing: ${templateId}` };
        }

        const picked = await dialog.showOpenDialog(mainWindow, {
          properties: ['openDirectory', 'createDirectory'],
          title: 'Choose where to create the project',
        });
        if (picked.canceled || picked.filePaths.length === 0) {
          return { ok: false as const, cancelled: true as const };
        }

        const parentDir = picked.filePaths[0];
        const projectPath = path.join(parentDir, projectName);
        // Defence in depth: the Zod schema already rejects separators and
        // traversal, but re-derive the containment here so a future schema
        // change cannot silently widen where we write.
        if (path.dirname(path.resolve(projectPath)) !== path.resolve(parentDir)) {
          return { ok: false as const, error: 'Invalid project name' };
        }
        if (await fs.pathExists(projectPath)) {
          return { ok: false as const, error: `"${projectName}" already exists in that folder` };
        }

        try {
          // The destination is outside any open project, so the standard
          // write guard would reject it. The user picked this directory in a
          // native dialog, which is exactly the consent this authorization
          // records (same pattern as fileDialogHandlers).
          PathSecurityService.authorizePathsTemporarily([parentDir, projectPath]);
          await fs.copy(templateDir, projectPath, { errorOnExist: true });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error('Template scaffold failed', { templateId, projectPath, error: message });
          return { ok: false as const, error: message };
        }

        // Reuse the open-by-path tail verbatim: watcher, recent list, path
        // sandbox root and BibTeX sync all have to be (re)pointed at the new
        // project, and re-implementing that list is how it drifts.
        const fileTree = await fileSystemService.buildFileTree(projectPath);
        fileSystemService.startWatching(projectPath);
        await addRecentProject(projectPath);
        PathSecurityService.setProjectPath(projectPath);
        clearAllowedDirectories();
        addAllowedDirectory(projectPath);
        getBibTexSyncService().setProjectPath(projectPath);

        logger.info('Project created from template', { templateId, projectPath });
        return {
          ok: true as const,
          projectPath,
          mainFile: template.mainFile,
          fileTree,
        };
      },

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

          fileSystemService.startWatching(effectivePath);

          await addRecentProject(effectivePath);

          PathSecurityService.setProjectPath(effectivePath);
          clearAllowedDirectories();
          addAllowedDirectory(effectivePath);
          getBibTexSyncService().setProjectPath(effectivePath);

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
          getBibTexSyncService().setProjectPath(projectPath);

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
