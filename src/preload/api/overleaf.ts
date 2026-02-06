/**
 * @file Overleaf API - Overleaf Integration API Module
 * @description Provides IPC interfaces for Overleaf login, project retrieval, compilation, document sync
 * @depends electron.ipcRenderer
 */

import { ipcRenderer } from 'electron';
import { IpcChannel } from '../../../shared/ipc/channels';

export const overleafApi = {
  // ====== Initialization & Authentication ======
  init: (config: { serverUrl: string; email?: string; password?: string; cookies?: string }) =>
    ipcRenderer.invoke(IpcChannel.Overleaf_Init, config),
  testConnection: (serverUrl: string) =>
    ipcRenderer.invoke(IpcChannel.Overleaf_TestConnection, serverUrl),
  login: (config: { serverUrl: string; email?: string; password?: string; cookies?: string }) =>
    ipcRenderer.invoke(IpcChannel.Overleaf_Login, config),
  isLoggedIn: () => ipcRenderer.invoke(IpcChannel.Overleaf_IsLoggedIn),
  getCookies: () => ipcRenderer.invoke(IpcChannel.Overleaf_GetCookies),

  // ====== Project Management ======
  getProjects: () => ipcRenderer.invoke(IpcChannel.Overleaf_GetProjects),
  getProjectDetails: (projectId: string) =>
    ipcRenderer.invoke(IpcChannel.Overleaf_GetProjectDetails, projectId),
  updateSettings: (projectId: string, settings: { compiler?: string; rootDocId?: string }) =>
    ipcRenderer.invoke(IpcChannel.Overleaf_UpdateSettings, projectId, settings),

  // ====== Compilation ======
  compile: (
    projectId: string,
    options?: { compiler?: string; draft?: boolean; stopOnFirstError?: boolean }
  ) => ipcRenderer.invoke(IpcChannel.Overleaf_Compile, projectId, options),
  stopCompile: (projectId: string) =>
    ipcRenderer.invoke(IpcChannel.Overleaf_StopCompile, projectId),
  getBuildId: () => ipcRenderer.invoke(IpcChannel.Overleaf_GetBuildId),

  // ====== SyncTeX ======
  syncCode: (projectId: string, file: string, line: number, column: number, buildId?: string) =>
    ipcRenderer.invoke(IpcChannel.Overleaf_SyncCode, projectId, file, line, column, buildId),
  syncPdf: (projectId: string, page: number, h: number, v: number, buildId?: string) =>
    ipcRenderer.invoke(IpcChannel.Overleaf_SyncPdf, projectId, page, h, v, buildId),

  // ====== Document Operations ======
  /**
   * Get document (supports docId or filePath)
   */
  getDoc: (projectId: string, docIdOrPath: string, isPath?: boolean) =>
    ipcRenderer.invoke(IpcChannel.Overleaf_GetDoc, projectId, docIdOrPath, isPath),
  updateDoc: (projectId: string, docId: string, content: string) =>
    ipcRenderer.invoke(IpcChannel.Overleaf_UpdateDoc, projectId, docId, content),

  // ====== Optimized Document Operations (Debounced + Cached) ======
  /**
   * Update document with debouncing (reduces API calls during rapid edits)
   * @sideeffect Queues update for debounced batch processing
   */
  updateDocDebounced: (projectId: string, docId: string, content: string) =>
    ipcRenderer.invoke(IpcChannel.Overleaf_UpdateDocDebounced, projectId, docId, content),
  /**
   * Flush pending debounced updates
   * @sideeffect Sends all queued updates to Overleaf
   */
  flushUpdates: (projectId?: string) =>
    ipcRenderer.invoke(IpcChannel.Overleaf_FlushUpdates, projectId),
  /**
   * Get document from cache (faster than getDoc for recently accessed documents)
   */
  getDocCached: (projectId: string, docId: string) =>
    ipcRenderer.invoke(IpcChannel.Overleaf_GetDocCached, projectId, docId),
  clearCache: (projectId?: string, docId?: string) =>
    ipcRenderer.invoke(IpcChannel.Overleaf_ClearCache, projectId, docId),
};
