/**
 * @file System API - System Utilities API Module
 * @description Provides IPC interfaces for project management, compilation, logging, configuration, tracing
 * @depends electron.ipcRenderer
 */

import { ipcRenderer } from 'electron';
import { IpcChannel } from '../../../shared/ipc/channels';
import type { CompileProgressPayload } from '../../../shared/ipc/compile-contract';
import { createSafeListener } from './_shared';

// ====== Project Management ======
export const projectApi = {
  openProject: () => ipcRenderer.invoke(IpcChannel.Project_Open),
  getRecentProjects: () => ipcRenderer.invoke(IpcChannel.Project_GetRecent),
  openProjectByPath: (projectPath: string) =>
    ipcRenderer.invoke(IpcChannel.Project_OpenByPath, projectPath),
  listTemplates: () => ipcRenderer.invoke(IpcChannel.Project_ListTemplates),
  createFromTemplate: (templateId: string, projectName: string) =>
    ipcRenderer.invoke(IpcChannel.Project_CreateFromTemplate, templateId, projectName),
};

// ====== Compilation ======
export const compileApi = {
  // LaTeX compilation
  compileLatex: (content: string, options?: unknown) =>
    ipcRenderer.invoke(IpcChannel.Compile_LaTeX, content, options),
  getLaTeXCapabilities: () => ipcRenderer.invoke(IpcChannel.LaTeX_GetCapabilities),

  /** Latency probe for a TeX Live remote endpoint (runs in main). */
  testTexliveEndpoint: (endpoint: string) =>
    ipcRenderer.invoke(IpcChannel.Compile_TestTexliveEndpoint, endpoint),

  // BusyTeX engine process (runs in an Electron UtilityProcess).
  busyTeXPrepare: () => ipcRenderer.invoke(IpcChannel.Compile_BusyTeX_Prepare),
  busyTeXCompile: (request: unknown) =>
    ipcRenderer.invoke(IpcChannel.Compile_BusyTeX_Compile, request),
  busyTeXCancel: () => ipcRenderer.invoke(IpcChannel.Compile_BusyTeX_Cancel),

  /** Live CLI compile progress (main → renderer push). Zod-validated at the boundary. */
  onProgress: createSafeListener<CompileProgressPayload>(IpcChannel.Compile_Progress),

  // Typst compilation
  compileTypst: (
    content: string,
    options?: {
      engine?: 'typst' | 'tinymist' | 'wasm-typst';
      mainFile?: string;
      projectPath?: string;
    }
  ) => ipcRenderer.invoke(IpcChannel.Compile_Typst, content, options),
  getTypstAvailability: () => ipcRenderer.invoke(IpcChannel.Typst_Available),
  getTypstCapabilities: () => ipcRenderer.invoke(IpcChannel.Typst_GetCapabilities),
  cancelCompile: (type?: 'latex' | 'typst') => ipcRenderer.invoke(IpcChannel.Compile_Cancel, type),
};

// ====== App Info ======
// Note: auto-update channels (checkUpdate / downloadUpdate / installUpdate / onUpdateStatus)
// are wired from the renderer through the generic `window.electron.ipcRenderer` bridge
// (adapted with boundary validation by `renderer/src/api/index.ts`) — not exposed here on appApi.
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
