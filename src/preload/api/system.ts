/**
 * @file System API - System Utilities API Module
 * @description Provides IPC interfaces for project management, compilation, logging, configuration, tracing
 * @depends electron.ipcRenderer
 */

import { ipcRenderer } from 'electron';
import { IpcChannel } from '../../../shared/ipc/channels';

// ====== Project Management ======
export const projectApi = {
  openProject: () => ipcRenderer.invoke(IpcChannel.Project_Open),
  getRecentProjects: () => ipcRenderer.invoke(IpcChannel.Project_GetRecent),
  openProjectByPath: (projectPath: string) =>
    ipcRenderer.invoke(IpcChannel.Project_OpenByPath, projectPath),
};

// ====== Compilation ======
export const compileApi = {
  // LaTeX compilation
  compileLatex: (content: string, options?: unknown) =>
    ipcRenderer.invoke(IpcChannel.Compile_LaTeX, content, options),

  // Typst compilation
  compileTypst: (
    content: string,
    options?: { engine?: 'typst' | 'tinymist'; mainFile?: string; projectPath?: string }
  ) => ipcRenderer.invoke(IpcChannel.Compile_Typst, content, options),
  getTypstAvailability: () => ipcRenderer.invoke(IpcChannel.Typst_Available),
  cancelCompile: (type?: 'latex' | 'typst') => ipcRenderer.invoke(IpcChannel.Compile_Cancel, type),

  // SyncTeX
  synctexForward: (texFile: string, line: number, column: number, pdfFile: string) =>
    ipcRenderer.invoke(IpcChannel.SyncTeX_Forward, texFile, line, column, pdfFile),
  synctexBackward: (pdfFile: string, page: number, x: number, y: number) =>
    ipcRenderer.invoke(IpcChannel.SyncTeX_Backward, pdfFile, page, x, y),
};

// ====== App Info ======
export const appApi = {
  openExternal: (url: string) => ipcRenderer.invoke(IpcChannel.App_OpenExternal, url),
  getAppVersion: () => ipcRenderer.invoke(IpcChannel.App_GetVersion),
  getHomeDir: () => ipcRenderer.invoke(IpcChannel.App_GetHomeDir),
  getAppDataDir: () => ipcRenderer.invoke(IpcChannel.App_GetAppDataDir),
};

// ====== Logging API ======
export const logApi = {
  getPath: () => ipcRenderer.invoke(IpcChannel.Log_GetPath),
  openFolder: () => ipcRenderer.invoke(IpcChannel.Log_OpenFolder),
  /**
   * Batch write log entries to file (Error/Warn level only)
   * @sideeffect Writes log entries to disk
   */
  write: (
    entries: Array<{
      level: 'debug' | 'info' | 'warn' | 'error';
      category: string;
      message: string;
      details?: unknown;
    }>
  ) => ipcRenderer.invoke(IpcChannel.Log_Write, entries),
  exportDiagnostics: () => ipcRenderer.invoke(IpcChannel.Log_ExportDiagnostics),
  /**
   * Clear log file
   * @sideeffect Deletes log file content
   */
  clear: () => ipcRenderer.invoke(IpcChannel.Log_Clear),
  /**
   * Send log from renderer process to main process
   * @sideeffect Logs entry in main process log system
   */
  toMain: (
    source: { process: 'renderer'; window?: string; module?: string },
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    data?: unknown[]
  ) => ipcRenderer.invoke(IpcChannel.Log_FromRenderer, source, level, message, data),
};

// ====== Config API ======
export const configApi = {
  get: <T>(key: string): Promise<T> => ipcRenderer.invoke(IpcChannel.Config_Get, key),
  set: (key: string, value: unknown, notify = false) =>
    ipcRenderer.invoke(IpcChannel.Config_Set, key, value, notify),
  /**
   * Listen to configuration change events (broadcast from main process)
   * @returns Unsubscribe function
   * @sideeffect Registers IPC event listener that must be cleaned up
   */
  onChanged: (callback: (data: { key: string; value: unknown }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { key: string; value: unknown }) => {
      callback(data);
    };
    ipcRenderer.on(IpcChannel.Config_Changed, handler);
    return () => {
      ipcRenderer.removeListener(IpcChannel.Config_Changed, handler);
    };
  },
};

// ====== Trace API ======
export const traceApi = {
  start: (name: string, parentContext?: { traceId: string; spanId: string }) =>
    ipcRenderer.invoke(IpcChannel.Trace_Start, name, parentContext),
  end: (spanId: string, result?: unknown) =>
    ipcRenderer.invoke(IpcChannel.Trace_End, spanId, result),
  get: (traceId: string) => ipcRenderer.invoke(IpcChannel.Trace_Get, traceId),
};
