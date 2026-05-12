import { BrowserWindow } from 'electron';
import { IpcChannel } from '../../../shared/ipc/channels';
import type {
  OTConnectionStateDTO,
  OTErrorDTO,
  OTFileEventDTO,
  OTRemoteUpdateDTO,
  OTStateChangedDTO,
} from '../../../shared/api-types';
import { createLogger } from '../services/LoggerService';
import { getCollaborationOwnerRegistry } from '../services/CollaborationOwnerRegistry';
import { getStudioOTService, getOfflineOpsManager } from '../services/ServiceRegistry';
import { createTypedHandlers } from './typedIpc';

const logger = createLogger('OTHandlers');
let subscribed = false;

/**
 * Broadcast project-level events (connection state, file tree changes, errors) to all windows.
 * These events are independent of the active file and must reach the renderer even when no tab is open.
 */
function broadcast(channel: IpcChannel, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, payload);
    }
  }
}

function ensureForwarding(): void {
  if (subscribed) return;
  subscribed = true;
  const service = getStudioOTService();
  const ownerRegistry = getCollaborationOwnerRegistry();

  // File-level edit events go only to the current owner window (avoid duplicate application across windows)
  const sendToOwner = (channel: IpcChannel, payload: unknown) => {
    if (!ownerRegistry.sendToOwner('scipen-ot', channel, payload)) {
      logger.warn(`[IPC] No OT owner window for ${channel}`);
    }
  };

  // Project-level events → broadcast (must arrive even without an active tab)
  service.onDidChangeConnection((payload: OTConnectionStateDTO) => {
    try {
      broadcast(IpcChannel.OT_ConnectionChanged, payload);
    } catch (e) {
      logger.error('[IPC] broadcast OT_ConnectionChanged error', e);
    }
  });
  service.onDidReceiveFileEvent((payload: OTFileEventDTO) => {
    try {
      broadcast(IpcChannel.OT_FileEvent, payload);
    } catch (e) {
      logger.error('[IPC] broadcast OT_FileEvent error', e);
    }
  });
  service.onDidError((payload: OTErrorDTO) => {
    try {
      broadcast(IpcChannel.OT_Error, payload);
    } catch (e) {
      logger.error('[IPC] broadcast OT_Error error', e);
    }
  });

  // File-level events → sendToOwner (precise routing to the editing window)
  service.onDidChangeState((payload: OTStateChangedDTO) => {
    try {
      sendToOwner(IpcChannel.OT_StateChanged, payload);
    } catch (e) {
      logger.error('[IPC] sendToOwner OT_StateChanged error', e);
    }
  });
  service.onDidReceiveRemoteUpdate((payload: OTRemoteUpdateDTO) => {
    try {
      sendToOwner(IpcChannel.OT_RemoteUpdate, payload);
    } catch (e) {
      logger.error('[IPC] sendToOwner OT_RemoteUpdate error', e);
    }
  });
}

export function registerOTHandlers(): void {
  ensureForwarding();
  const service = getStudioOTService();
  const handlers = createTypedHandlers(
    {
      [IpcChannel.OT_Configure]: async (config) => service.configure(config),
      [IpcChannel.OT_SetBotUserId]: (userId: string) => {
        service.setBotUserId(userId);
      },
      [IpcChannel.OT_Disconnect]: () => service.disconnect(),
      [IpcChannel.OT_ListProjects]: async (workspace) =>
        service.listProjects(workspace || undefined),
      [IpcChannel.OT_UpdateProject]: async (projectId, updates) => {
        return service.updateProject(projectId, updates);
      },
      [IpcChannel.OT_OpenLocalProject]: async (params) => {
        const snapshot = await service.openLocalProject(params);
        getOfflineOpsManager().setActiveProject(snapshot.project.id);
        return snapshot;
      },
      [IpcChannel.OT_GetProjectSnapshot]: async (projectId) =>
        service.getProjectSnapshot(projectId),
      [IpcChannel.OT_GetProjectFile]: async (projectId, fileId) =>
        service.getProjectFile(projectId, fileId),
      [IpcChannel.OT_JoinFile]: async (params) => service.joinFile(params),
      [IpcChannel.OT_SubmitFileOp]: async (params) => {
        // Fetch localContent from OT Core (used for the offline-storage content hash)
        const localContent = service.getContent();
        return getOfflineOpsManager().submitOps(
          params.projectId,
          params.fileId,
          params.version,
          params.ops,
          localContent
        );
      },
      [IpcChannel.OT_ApplyBotEdit]: async (params) => service.applyBotEdit(params),
      [IpcChannel.OT_CreateFile]: async (params) => service.createFile(params),
      [IpcChannel.OT_CreateFolder]: async (params) => service.createFolder(params),
      [IpcChannel.OT_RenameFile]: async (params) => service.renameFile(params),
      [IpcChannel.OT_RenameFolder]: async (params) => service.renameFolder(params),
      [IpcChannel.OT_DeleteFile]: async (projectId, fileId) =>
        service.deleteFile(projectId, fileId),
      [IpcChannel.OT_DeleteFolder]: async (projectId, folderId) =>
        service.deleteFolder(projectId, folderId),
    },
    { logErrors: true }
  );
  handlers.registerAll();
  logger.info('[IPC] OT handlers registered');
}
