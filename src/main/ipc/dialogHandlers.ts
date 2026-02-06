/**
 * @file Dialog IPC Handlers (Type-Safe)
 * @description Provides native Electron dialog APIs to avoid focus issues with window.confirm().
 * @depends Electron dialog, BrowserWindow
 */

import { BrowserWindow, dialog } from 'electron';
import { IpcChannel } from '../../../shared/ipc/channels';
import { createLogger } from '../services/LoggerService';
import { createTypedHandlers } from './typedIpc';

const logger = createLogger('DialogHandlers');

/**
 * Registers all dialog-related IPC handlers.
 * @sideeffect Registers ipcMain handlers for native dialogs
 */
export function registerDialogHandlers(): void {
  const handlers = createTypedHandlers(
    {
      /**
       * Shows a confirmation dialog.
       * @returns true if user clicked confirm, false if cancelled
       */
      [IpcChannel.Dialog_Confirm]: async (options) => {
        const { message, title } = options;

        const focusedWindow = BrowserWindow.getFocusedWindow();

        const result = await dialog.showMessageBox(
          focusedWindow ?? (undefined as unknown as BrowserWindow),
          {
            type: 'question',
            buttons: ['取消', '确认'],
            defaultId: 1,
            cancelId: 0,
            title: title || '确认',
            message: message,
          }
        );

        return result.response === 1;
      },

      /** Shows a message dialog (info/warning/error) */
      [IpcChannel.Dialog_Message]: async (options) => {
        const { message, type = 'info', title } = options;

        const focusedWindow = BrowserWindow.getFocusedWindow();

        await dialog.showMessageBox(focusedWindow ?? (undefined as unknown as BrowserWindow), {
          type,
          buttons: ['确定'],
          title: title || (type === 'error' ? '错误' : type === 'warning' ? '警告' : '提示'),
          message: message,
        });
      },
    },
    { logErrors: true }
  );

  handlers.registerAll();
  logger.info('[IPC] Dialog handlers registered (type-safe)');
}
