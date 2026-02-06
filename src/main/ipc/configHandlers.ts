/**
 * @file Config IPC handlers (Type-Safe)
 * @description Handles configuration get/set with optional broadcast to all windows.
 * @depends ConfigManager
 */

import { BrowserWindow } from 'electron';
import { IpcChannel } from '../../../shared/ipc/channels';
import { type ConfigKeys, configManager } from '../services/ConfigManager';
import { createLogger } from '../services/LoggerService';
import { createTypedHandlers } from './typedIpc';

const logger = createLogger('ConfigHandlers');

// ====== Helpers ======

/** Broadcast config change to all windows */
function broadcastConfigChanged(key: string, value: unknown): void {
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send(IpcChannel.Config_Changed, { key, value });
    }
  }
}

// ====== Handler Registration ======

/**
 * Register configuration-related IPC handlers.
 * @sideeffect Registers handlers on ipcMain for config operations
 */
export function registerConfigHandlers(): void {
  const handlers = createTypedHandlers(
    {
      [IpcChannel.Config_Get]: (key) => {
        return configManager.get(key as ConfigKeys);
      },

      [IpcChannel.Config_Set]: (key, value, notify = false) => {
        if (notify) {
          configManager.setAndNotify(key as ConfigKeys, value);
          broadcastConfigChanged(key as string, value);
        } else {
          configManager.set(key as ConfigKeys, value);
        }
      },
    },
    { logErrors: true }
  );

  handlers.registerAll();
  logger.info('[IPC] Config handlers registered (type-safe)');
}
