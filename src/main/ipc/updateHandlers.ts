/**
 * @file updateHandlers.ts — Auto-update IPC handlers
 * @description 3 invoke handlers + UpdateStatus event broadcast to all windows
 */

import type { BrowserWindow } from 'electron';
import { IpcChannel } from '../../../shared/ipc/channels';
import type { UpdateService } from '../services/UpdateService';
import { createTypedHandlers } from './typedIpc';
import { createLogger } from '../services/LoggerService';

const logger = createLogger('UpdateHandlers');

export interface UpdateHandlersDeps {
  getWindows: () => Map<number, BrowserWindow>;
  getUpdateService: () => UpdateService;
}

export function registerUpdateHandlers(deps: UpdateHandlersDeps): void {
  const { getWindows, getUpdateService } = deps;

  const handlers = createTypedHandlers(
    {
      [IpcChannel.App_CheckUpdate]: async () => {
        return await getUpdateService().checkForUpdates();
      },
      [IpcChannel.App_DownloadUpdate]: async () => {
        await getUpdateService().downloadUpdate();
      },
      [IpcChannel.App_InstallUpdate]: () => {
        getUpdateService().installUpdate();
      },
    },
    { logErrors: true }
  );
  handlers.registerAll();

  // Listen for UpdateService status changes and broadcast to all windows
  getUpdateService().onDidChangeStatus((status) => {
    for (const [, win] of getWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IpcChannel.App_UpdateStatus, status);
      }
    }
  });

  logger.info('[IPC] Update handlers registered');
}
