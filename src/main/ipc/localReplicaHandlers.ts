/**
 * @file Local Replica IPC Handlers
 * @description Handles local-remote file synchronization between Overleaf projects and local filesystem.
 * @depends ILocalReplicaService, PathSecurityService, LocalFileProtocol
 * @security All paths validated via PathSecurityService before filesystem operations
 */

import type { BrowserWindow } from 'electron';
import { IpcChannel } from '../../../shared/ipc/channels';
import { addAllowedDirectory, clearAllowedDirectories } from '../services/LocalFileProtocol';
import { createLogger } from '../services/LoggerService';
import {
  type PathAccessMode,
  PathSecurityService,
  checkPathSecurity,
} from '../services/PathSecurityService';
import type { ILocalReplicaService, SyncProgressEvent } from '../services/interfaces';
import { createTypedHandlers } from './typedIpc';

const logger = createLogger('LocalReplicaHandlers');

/**
 * Validates path security and throws if access is denied.
 * @security LocalReplica allows user-selected local paths
 * @throws {Error} When path access is denied
 */
function assertPathSecurity(filePath: string, mode: PathAccessMode = 'read'): string {
  const result = checkPathSecurity(filePath, mode, 'user-selected');
  if (!result.allowed) {
    logger.error(`[PathSecurity] Access denied: ${result.reason}`);
    throw new Error(result.reason || 'Access denied');
  }
  return result.sanitizedPath || filePath;
}

export interface LocalReplicaHandlersDeps {
  getLocalReplicaService: () => ILocalReplicaService | null;
  getMainWindow: () => BrowserWindow | null;
}

/**
 * Registers all Local Replica IPC handlers.
 * @sideeffect Registers ipcMain handlers for sync operations
 */
export function registerLocalReplicaHandlers(deps: LocalReplicaHandlersDeps): void {
  const { getLocalReplicaService } = deps;

  const handlers = createTypedHandlers(
    {
      // ====== Initialization ======

      /** Initializes Local Replica with the given configuration */
      [IpcChannel.LocalReplica_Init]: async (config) => {
        if (config.localPath) {
          assertPathSecurity(config.localPath, 'write');
        }

        const service = getLocalReplicaService();
        if (!service) {
          logger.error('LocalReplicaService not available');
          return false;
        }

        logger.info(`Initializing Local Replica: ${config.projectName}`);
        const success = await service.init(config);

        // Set project path for @ file references and security checks
        // Architecture note: assumes one project per window
        if (success && config.localPath) {
          PathSecurityService.setProjectPath(config.localPath);
          clearAllowedDirectories();
          addAllowedDirectory(config.localPath);
          logger.info(`[LocalReplica] Project path set: ${config.localPath}`);
        }

        return success;
      },

      // ====== Configuration ======

      /** Gets the current Local Replica configuration */
      [IpcChannel.LocalReplica_GetConfig]: () => {
        const service = getLocalReplicaService();
        if (!service) {
          return null;
        }
        return service.getConfig();
      },

      /** Sets the enabled state of Local Replica */
      [IpcChannel.LocalReplica_SetEnabled]: (enabled) => {
        const service = getLocalReplicaService();
        if (!service) {
          logger.error('LocalReplicaService not available');
          return;
        }
        service.setEnabled(enabled);

        // Clear project path when disabled to avoid stale references
        if (!enabled) {
          PathSecurityService.setProjectPath(null);
          clearAllowedDirectories();
          logger.info('[LocalReplica] Project path cleared');
        }
      },

      // ====== Synchronization ======

      /** Syncs files from remote Overleaf to local filesystem */
      [IpcChannel.LocalReplica_SyncFromRemote]: async () => {
        const service = getLocalReplicaService();
        if (!service) {
          return { synced: 0, skipped: 0, errors: ['Service not available'], conflicts: [] };
        }

        logger.info('Starting sync from remote...');
        return await service.syncFromRemote();
      },

      /** Syncs files from local filesystem to remote Overleaf */
      [IpcChannel.LocalReplica_SyncToRemote]: async () => {
        const service = getLocalReplicaService();
        if (!service) {
          return { synced: 0, skipped: 0, errors: ['Service not available'], conflicts: [] };
        }

        logger.info('Starting sync to remote...');
        return await service.syncToRemote();
      },

      // ====== File Watching ======

      /** Starts watching local filesystem for changes */
      [IpcChannel.LocalReplica_StartWatching]: () => {
        const service = getLocalReplicaService();
        if (!service) {
          logger.error('LocalReplicaService not available');
          return;
        }
        service.startWatching();
      },

      /** Stops watching local filesystem */
      [IpcChannel.LocalReplica_StopWatching]: () => {
        const service = getLocalReplicaService();
        if (!service) {
          return;
        }
        service.stopWatching();
      },

      /** Checks if file watching is active */
      [IpcChannel.LocalReplica_IsWatching]: () => {
        const service = getLocalReplicaService();
        if (!service) {
          return false;
        }
        return service.isWatching();
      },
    },
    { logErrors: true }
  );

  handlers.registerAll();

  logger.info('[IPC] Local Replica handlers registered');
}

/**
 * Sets up event forwarding from Local Replica service to renderer process.
 * @sideeffect Subscribes to service events and forwards them via IPC
 */
export function setupLocalReplicaEventForwarding(
  service: ILocalReplicaService,
  getMainWindow: () => BrowserWindow | null
): void {
  // Sync progress event
  service.on('sync:progress', (data: SyncProgressEvent) => {
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IpcChannel.LocalReplica_SyncProgress, data);
    }
  });

  // Sync completed event
  service.on('sync:completed', (result) => {
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IpcChannel.LocalReplica_SyncProgress, {
        progress: 100,
        message: `Sync completed: ${result.synced} succeeded`,
      });
    }
  });

  // Sync error event
  service.on('sync:error', (error) => {
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IpcChannel.LocalReplica_SyncProgress, {
        progress: -1,
        message: `Sync failed: ${error.message}`,
      });
    }
  });

  logger.info('[LocalReplica] Event forwarding configured');
}
