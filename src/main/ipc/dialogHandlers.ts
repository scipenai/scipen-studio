/**
 * @file Dialog IPC Handlers (type-safe)
 * @description Native Electron dialogs to avoid focus issues with window.confirm().
 *              Defaults are English; callers should pass i18n-resolved labels
 *              (`confirmText`/`cancelText`/`okText`/`title`) so the visible
 *              text follows the renderer's current locale. Main process has no
 *              i18n runtime — defaults exist only to keep the API ergonomic
 *              when a caller has nothing useful to say.
 * @depends Electron dialog, BrowserWindow
 */

import { BrowserWindow, dialog } from 'electron';
import { IpcChannel } from '../../../shared/ipc/channels';
import { createLogger } from '../services/LoggerService';
import { createTypedHandlers } from './typedIpc';

const logger = createLogger('DialogHandlers');

function defaultMessageTitle(type: 'info' | 'warning' | 'error' | 'none' | undefined): string {
  switch (type) {
    case 'error':
      return 'Error';
    case 'warning':
      return 'Warning';
    default:
      return 'Info';
  }
}

export function registerDialogHandlers(): void {
  const handlers = createTypedHandlers(
    {
      [IpcChannel.Dialog_Confirm]: async (options) => {
        const { message, title, confirmText, cancelText } = options;
        const focusedWindow = BrowserWindow.getFocusedWindow();

        const result = await dialog.showMessageBox(
          focusedWindow ?? (undefined as unknown as BrowserWindow),
          {
            type: 'question',
            buttons: [cancelText ?? 'Cancel', confirmText ?? 'Confirm'],
            defaultId: 1,
            cancelId: 0,
            title: title ?? 'Confirm',
            message,
          }
        );

        return result.response === 1;
      },

      [IpcChannel.Dialog_Message]: async (options) => {
        const { message, type = 'info', title, okText, detail } = options;
        const focusedWindow = BrowserWindow.getFocusedWindow();

        await dialog.showMessageBox(focusedWindow ?? (undefined as unknown as BrowserWindow), {
          type,
          buttons: [okText ?? 'OK'],
          title: title ?? defaultMessageTitle(type),
          message,
          detail,
        });
      },
    },
    { logErrors: true }
  );

  handlers.registerAll();
  logger.info('[IPC] Dialog handlers registered (type-safe)');
}
