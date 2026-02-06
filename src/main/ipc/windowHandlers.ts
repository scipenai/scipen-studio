/**
 * @file Window and app IPC handlers (Type-Safe)
 * @description Handles window control (minimize, close, fullscreen) and app events.
 */

import { BrowserWindow, app, dialog, shell } from 'electron';
import log from 'electron-log';
import { IpcChannel } from '../../../shared/ipc/channels';
import { createLogger } from '../services/LoggerService';
import fs from '../services/knowledge/utils/fsCompat';
import { createTypedHandlers, registerTypedHandler } from './typedIpc';

const logger = createLogger('WindowHandlers');

// ====== Types ======

export interface WindowHandlersDeps {
  getMainWindow: () => BrowserWindow | null;
  getWindows: () => Map<number, BrowserWindow>;
  createWindow: (options?: { projectPath?: string }) => number;
}

export function registerWindowHandlers(deps: WindowHandlersDeps): void {
  const { getMainWindow, getWindows, createWindow } = deps;

  const handlers = createTypedHandlers(
    {
      // Open external link
      [IpcChannel.App_OpenExternal]: async (url) => {
        await shell.openExternal(url);
      },

      // Get app version
      [IpcChannel.App_GetVersion]: () => {
        return app.getVersion();
      },

      // Get user home directory
      [IpcChannel.App_GetHomeDir]: () => {
        return app.getPath('home');
      },

      // Get app data directory
      [IpcChannel.App_GetAppDataDir]: () => {
        return app.getPath('userData');
      },

      // Create new window
      [IpcChannel.Window_New]: async (options) => {
        const windowId = createWindow(options);
        return windowId;
      },

      // Get all window info
      [IpcChannel.Window_GetAll]: () => {
        const windows = getWindows();
        return Array.from(windows.entries()).map(([id, win]) => ({
          id,
          title: win.getTitle(),
          projectPath: undefined, // Can be retrieved from state if needed
        }));
      },

      // Focus specified window
      [IpcChannel.Window_Focus]: (windowId) => {
        const windows = getWindows();
        const win = windows.get(windowId);
        if (win) {
          win.focus();
        }
      },

      // Get log file path
      [IpcChannel.Log_GetPath]: () => {
        const logFile = log.transports.file.getFile();
        return logFile?.path || '';
      },

      // Open log folder
      [IpcChannel.Log_OpenFolder]: () => {
        const logFile = log.transports.file.getFile();
        if (logFile?.path) {
          shell.showItemInFolder(logFile.path);
        }
      },

      // Write renderer logs (batch)
      [IpcChannel.Log_Write]: (entries) => {
        for (const entry of entries) {
          const prefix = `[Renderer][${entry.category}]`;
          const args = entry.details
            ? [prefix, entry.message, entry.details]
            : [prefix, entry.message];

          switch (entry.level) {
            case 'debug':
              log.debug(...args);
              break;
            case 'info':
              log.info(...args);
              break;
            case 'warn':
              log.warn(...args);
              break;
            case 'error':
              log.error(...args);
              break;
          }
        }
      },

      // Export diagnostics report
      [IpcChannel.Log_ExportDiagnostics]: async () => {
        try {
          const mainWindow = getMainWindow();
          const logFile = log.transports.file.getFile();
          const logPath = logFile?.path;

          if (!logPath || !(await fs.pathExists(logPath))) {
            return '';
          }

          const result = await dialog.showSaveDialog(mainWindow!, {
            title: '导出诊断报告',
            defaultPath: `scipen-diagnostics-${new Date().toISOString().slice(0, 10)}.log`,
            filters: [{ name: '日志文件', extensions: ['log', 'txt'] }],
          });

          if (result.canceled || !result.filePath) {
            return '';
          }

          await fs.copy(logPath, result.filePath);
          shell.showItemInFolder(result.filePath);

          return result.filePath;
        } catch (error) {
          log.error('导出诊断报告失败:', error);
          return '';
        }
      },

      // Clear log file
      [IpcChannel.Log_Clear]: async () => {
        try {
          const logFile = log.transports.file.getFile();
          if (logFile?.path && (await fs.pathExists(logFile.path))) {
            await fs.writeFile(logFile.path, '');
            log.info('[Main] 日志文件已清除');
          }
        } catch (error) {
          log.error('清除日志失败:', error);
        }
      },

      // Note: Log_FromRenderer is registered in LoggerService to avoid duplicate registration
    },
    { logErrors: true }
  );

  handlers.registerAll();

  // Close current window - requires event.sender, registered separately
  registerTypedHandler(
    IpcChannel.Window_Close,
    (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win) {
        win.close();
      }
    },
    { logErrors: true }
  );

  logger.info('[IPC] Window handlers registered (type-safe)');
}
