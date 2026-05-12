/**
 * @file Overleaf IPC handlers (Type-Safe)
 * @description Handles Overleaf project import and sync.
 * @depends OverleafProjectMetaService (project metadata), OverleafAuthService (auth)
 * @security Cookies encrypted via safeStorage; actual cookie values never exposed via IPC
 */

import { IpcChannel } from '@shared/ipc/channels';
import { createLogger } from '../services/LoggerService';
import { OverleafProjectMetaService } from '../services/OverleafProjectMetaService';
import { OverleafFileSystemService } from '../services/OverleafFileSystemService';
import { OverleafProjectDownloader } from '../services/OverleafProjectDownloader';
import * as MetaStore from '../services/OverleafProjectMetaStore';
import { OverleafSyncService } from '../services/OverleafSyncService';
import { getStudioOverleafLiveService } from '../services/ServiceRegistry';
import type { OverleafAuthService } from '../services/OverleafAuthService';
import type { IOverleafFileSystemService } from '../services/interfaces';
import { createTypedHandlers } from './typedIpc';

const logger = createLogger('OverleafHandlers');

// ====== Types ======

export interface OverleafHandlersDeps {
  getProjectMetaService: () => OverleafProjectMetaService | null;
  setProjectMetaService: (svc: OverleafProjectMetaService | null) => void;
  getOverleafFileSystem: () => IOverleafFileSystemService | null;
  setOverleafFileSystem: (fs: IOverleafFileSystemService | null) => void;
  getAuthService: () => OverleafAuthService;
}

// ====== Handler Registration ======

/**
 * Register Overleaf-related IPC handlers.
 * @sideeffect Registers handlers on ipcMain for Overleaf operations
 */
export function registerOverleafHandlers(deps: OverleafHandlersDeps): void {
  const { getProjectMetaService, setProjectMetaService, setOverleafFileSystem, getAuthService } =
    deps;

  /** Dispose previous dependent service instances */
  function disposeOldServices(): void {
    const oldMeta = getProjectMetaService();
    if (oldMeta) oldMeta.dispose();
    // OverleafFileSystemService is stateless; just null it out
    setOverleafFileSystem(null);
    setProjectMetaService(null);
  }

  /** Create all dependent services after a successful login */
  function createDependentServices(
    authService: OverleafAuthService,
    metaService: OverleafProjectMetaService
  ): void {
    const liveService = getStudioOverleafLiveService();
    // LiveService holds an AuthService reference so it can establish the bridge connection on its own
    liveService.setAuthService(authService);
    const fs = new OverleafFileSystemService(metaService, liveService, authService);
    setOverleafFileSystem(fs);
  }

  const handlers = createTypedHandlers(
    {
      [IpcChannel.OverleafAuth_Init]: async (config) => {
        const authService = getAuthService();
        const result = await authService.login(
          config as { serverUrl: string; email?: string; password?: string; cookies?: string }
        );
        if (!result.success) {
          return { success: false, message: result.message };
        }
        // Only dispose old services and create new instances after a successful login
        disposeOldServices();
        const liveService = getStudioOverleafLiveService();
        const metaService = new OverleafProjectMetaService(authService, liveService);
        setProjectMetaService(metaService);
        createDependentServices(authService, metaService);
        return { success: true };
      },

      [IpcChannel.OverleafAuth_TestConnection]: async (serverUrl) => {
        return getAuthService().testConnection(serverUrl);
      },

      [IpcChannel.OverleafAuth_Login]: async (config) => {
        const authService = getAuthService();
        const result = await authService.login(
          config as { serverUrl: string; email?: string; password?: string; cookies?: string }
        );
        if (!result.success) {
          return result;
        }
        // Only dispose old services and create new instances after a successful login
        disposeOldServices();
        const liveService = getStudioOverleafLiveService();
        const metaService = new OverleafProjectMetaService(authService, liveService);
        setProjectMetaService(metaService);
        createDependentServices(authService, metaService);
        return result;
      },

      [IpcChannel.OverleafAuth_IsLoggedIn]: () => {
        return getAuthService().isLoggedIn();
      },

      // Cookies are never exposed to the renderer — only report presence
      [IpcChannel.OverleafAuth_GetCookies]: () => {
        return getAuthService().isLoggedIn() ? '[encrypted]' : null;
      },

      [IpcChannel.OverleafProject_GetProjects]: async () => {
        const metaService = getProjectMetaService();
        if (!metaService) {
          return [];
        }
        try {
          // getProjects() returns {id, name, lastUpdated: string}, already matching the DTO shape
          return await metaService.getProjects();
        } catch {
          return [];
        }
      },

      // Get project details
      [IpcChannel.OverleafProject_GetDetails]: async (projectId) => {
        const metaService = getProjectMetaService();
        if (!metaService) {
          return { success: false, error: 'Please login to Overleaf first' };
        }
        try {
          const details = await metaService.getProjectDetailsCached(projectId);
          if (details) {
            return { success: true, details };
          }
          return { success: false, error: 'Failed to get project details' };
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to get project details',
          };
        }
      },

      // ====== Project download (local-first) ======

      [IpcChannel.OverleafProject_Download]: async (projectId, projectName) => {
        const authService = getAuthService();
        if (!authService.isLoggedIn()) {
          return { success: false, error: 'Please login first' };
        }
        const liveService = getStudioOverleafLiveService();
        const overleafFS = deps.getOverleafFileSystem();
        if (!overleafFS) {
          return { success: false, error: 'OverleafFileSystemService not available' };
        }
        try {
          const downloader = new OverleafProjectDownloader(liveService, overleafFS);
          const result = await downloader.downloadProject(
            projectId,
            projectName,
            authService.getServerUrl()!
          );
          return {
            success: true,
            localPath: result.localPath,
            files: result.files,
            folders: result.folders,
            meta: result.meta,
          };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          const stack = error instanceof Error ? error.stack : undefined;
          logger.error(`OverleafProject_Download failed: ${msg}`, stack || error);
          return { success: false, error: msg };
        }
      },

      [IpcChannel.OverleafProject_FindLocalPath]: async (projectId) => {
        return await MetaStore.findLocalPath(projectId);
      },

      [IpcChannel.OverleafProject_GetMeta]: async (localPath) => {
        return await MetaStore.getProjectMeta(localPath);
      },

      [IpcChannel.OverleafProject_UpdateDocIdMap]: async (localPath, docIdMap) => {
        await MetaStore.updateDocIdMap(localPath, docIdMap);
        return true;
      },

      [IpcChannel.OverleafProject_SyncFile]: async (
        overleafProjectId,
        docId,
        localContent,
        baseCachePath
      ) => {
        const liveService = getStudioOverleafLiveService();
        const syncService = new OverleafSyncService(liveService);
        try {
          return await syncService.syncFile(overleafProjectId, docId, localContent, baseCachePath);
        } finally {
          syncService.dispose();
        }
      },

      [IpcChannel.OverleafProject_SyncProject]: async (overleafProjectId, docIdMap, localRoot) => {
        const liveService = getStudioOverleafLiveService();
        const syncService = new OverleafSyncService(liveService);
        try {
          const results = await syncService.syncProject(overleafProjectId, docIdMap, localRoot);
          // Map → plain object (for IPC serialization)
          const serialized: Record<
            string,
            { status: string; remoteContent?: string; error?: string }
          > = {};
          for (const [k, v] of results) {
            serialized[k] = v;
          }
          return serialized;
        } finally {
          syncService.dispose();
        }
      },

      [IpcChannel.OverleafProject_SyncFileByPath]: async (
        overleafProjectId,
        relativePath,
        localContent,
        localRoot,
        docIdMapJson
      ) => {
        const liveService = getStudioOverleafLiveService();
        const metaService = deps.getProjectMetaService();
        const syncService = new OverleafSyncService(liveService, metaService);
        try {
          const result = await syncService.syncFileByPath(
            overleafProjectId,
            relativePath,
            localContent,
            localRoot,
            docIdMapJson || {}
          );
          // After a new file is created, persist newDocId into .overleaf/project.json
          if (result.newDocId && localRoot) {
            const meta = await MetaStore.getProjectMeta(localRoot);
            if (meta) {
              meta.docIdMap[relativePath] = result.newDocId;
              await MetaStore.updateDocIdMap(localRoot, meta.docIdMap).catch((err) =>
                logger.warn(`Failed to persist docIdMap: ${err}`)
              );
            }
          }
          return result;
        } finally {
          syncService.dispose();
        }
      },

      [IpcChannel.OverleafProject_CreateAndSync]: async (
        overleafProjectId,
        fileName,
        parentFolderId,
        localContent,
        baseCachePath
      ) => {
        const liveService = getStudioOverleafLiveService();
        const syncService = new OverleafSyncService(liveService);
        try {
          return await syncService.createAndSyncNewFile(
            overleafProjectId,
            fileName,
            parentFolderId,
            localContent,
            baseCachePath
          );
        } finally {
          syncService.dispose();
        }
      },
    },
    { logErrors: true }
  );

  handlers.registerAll();
  logger.info('[IPC] Overleaf handlers registered (type-safe with mappers)');
}
