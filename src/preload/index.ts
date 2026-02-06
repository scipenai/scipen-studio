/**
 * @file Preload Entry - Preload Script Entry
 * @description Type-safe IPC communication bridge layer, exposes APIs to renderer via contextBridge
 * @depends electron.contextBridge, api modules
 */

import { contextBridge, ipcRenderer } from 'electron';
import { IpcChannel } from '../../shared/ipc/channels';

// Import modular APIs
import {
  ALLOWED_EVENT_CHANNELS,
  ALLOWED_INVOKE_CHANNELS,
  agentApi,
  aiApi,
  appApi,
  chatApi,
  compileApi,
  configApi,
  createSafeListener,
  dialogApi,
  fileApi,
  fileWatcherApi,
  knowledgeApi,
  logApi,
  lspApi,
  overleafApi,
  projectApi,
  selectionApi,
  settingsApi,
  traceApi,
  windowApi,
} from './api';

try {
  /**
   * API exposed to renderer process
   *
   * Structure:
   * - Top-level: Common operations (project, file, compile)
   * - Namespaced: Domain-specific APIs (ai, knowledge, lsp, etc.)
   */
  const api = {
    // ====== Project Management ======
    openProject: projectApi.openProject,
    getRecentProjects: projectApi.getRecentProjects,
    openProjectByPath: projectApi.openProjectByPath,

    // ====== File Operations ======
    readFile: fileApi.readFile,
    readFileBinary: fileApi.readFileBinary,
    getLocalFileUrl: fileApi.getLocalFileUrl,
    writeFile: fileApi.writeFile,
    createFile: fileApi.createFile,
    createFolder: fileApi.createFolder,
    deleteFile: fileApi.deleteFile,
    renameFile: fileApi.renameFile,
    copyFile: fileApi.copyFile,
    moveFile: fileApi.moveFile,
    refreshFileTree: fileApi.refreshFileTree,
    pathExists: fileApi.pathExists,
    getFileStats: fileApi.getFileStats,
    showItemInFolder: fileApi.showItemInFolder,
    selectFiles: fileApi.selectFiles,
    getClipboardFiles: fileApi.getClipboardFiles,

    // Batch file operations
    batchReadFiles: fileApi.batchReadFiles,
    batchStatFiles: fileApi.batchStatFiles,
    batchPathExists: fileApi.batchPathExists,
    batchWriteFiles: fileApi.batchWriteFiles,
    batchDeleteFiles: fileApi.batchDeleteFiles,

    // ====== Compilation ======
    compileLatex: compileApi.compileLatex,
    compileTypst: compileApi.compileTypst,
    getTypstAvailability: compileApi.getTypstAvailability,
    synctexForward: compileApi.synctexForward,
    synctexBackward: compileApi.synctexBackward,

    // ====== App Info ======
    openExternal: appApi.openExternal,
    getAppVersion: appApi.getAppVersion,
    getHomeDir: appApi.getHomeDir,
    getAppDataDir: appApi.getAppDataDir,

    // ====== Namespaced APIs ======
    window: windowApi,
    chat: chatApi,
    agent: agentApi,
    overleaf: overleafApi,
    knowledge: knowledgeApi,
    ai: aiApi,
    fileWatcher: fileWatcherApi,
    log: logApi,
    config: configApi,
    trace: traceApi,
    lsp: lspApi,
    dialog: dialogApi,
    settings: settingsApi,
    selection: selectionApi,

    // Event listeners
    onMessage: createSafeListener<string>(IpcChannel.Message_FromMain),

    // ====== Low-level IPC API ======
    // Security: All channels are validated against whitelists
    ipcRenderer: {
      invoke: (channel: string, ...args: unknown[]) => {
        // Security: Only allow whitelisted channels
        if (!ALLOWED_INVOKE_CHANNELS.has(channel)) {
          console.error('[Preload] Blocked invoke to unauthorized channel:', channel);
          return Promise.reject(new Error(`Unauthorized IPC channel: ${channel}`));
        }
        return ipcRenderer.invoke(channel, ...args);
      },
      // Returns cleanup function to avoid reference inconsistency issues caused by contextBridge proxy
      on: (channel: string, listener: (...args: unknown[]) => void): (() => void) => {
        // Security: Only allow whitelisted event channels
        if (!ALLOWED_EVENT_CHANNELS.has(channel)) {
          console.error('[Preload] Blocked listener on unauthorized channel:', channel);
          return () => {}; // Return no-op cleanup function
        }
        const wrapper = (_event: Electron.IpcRendererEvent, ...args: unknown[]) =>
          listener(...args);
        ipcRenderer.on(channel, wrapper);
        // Return cleanup function directly, which captures the correct wrapper reference
        return () => ipcRenderer.removeListener(channel, wrapper);
      },
      // off is kept for backward compatibility but not recommended
      off: (_channel: string, _listener: (...args: unknown[]) => void) => {
        // This method cannot work correctly due to contextBridge proxy issues
        // Should use the cleanup function returned by on() instead
        console.warn(
          '[Preload] ipcRenderer.off is deprecated, use cleanup function returned by on() instead'
        );
      },
    },

    // Platform information
    platform: process.platform,
  };

  // Expose protected methods that allow the renderer process to use
  // the ipcRenderer without exposing the entire object
  contextBridge.exposeInMainWorld('electron', api);
} catch (error) {
  console.error('[Preload] Failed to expose electron API:', error);
}
