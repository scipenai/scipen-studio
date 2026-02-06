/**
 * @file Window API - Window Management API Module
 * @description Provides IPC interfaces for window creation, closing, dialogs
 * @depends electron.ipcRenderer
 */

import { ipcRenderer } from 'electron';
import { IpcChannel } from '../../../shared/ipc/channels';
import { createSafeListener } from './_shared';

export const windowApi = {
  newWindow: (options?: { projectPath?: string }) =>
    ipcRenderer.invoke(IpcChannel.Window_New, options),
  getWindows: () => ipcRenderer.invoke(IpcChannel.Window_GetAll),
  closeWindow: () => ipcRenderer.invoke(IpcChannel.Window_Close),
  focusWindow: (windowId: number) => ipcRenderer.invoke(IpcChannel.Window_Focus, windowId),
  /**
   * Listen to project open events
   * @returns Unsubscribe function
   * @sideeffect Registers IPC event listener that must be cleaned up
   */
  onOpenProject: createSafeListener<string>(IpcChannel.Window_OpenProject),
  /**
   * Listen to file association open events (e.g., double-clicking .tex files)
   * @returns Unsubscribe function
   * @sideeffect Registers IPC event listener that must be cleaned up
   */
  onOpenFile: createSafeListener<string>(IpcChannel.Window_OpenFile),
};

// ====== Dialog API ======
export const dialogApi = {
  /**
   * Show confirmation dialog (uses Electron native dialog, won't cause focus loss)
   * @returns User confirmation status
   */
  confirm: (message: string, title?: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannel.Dialog_Confirm, { message, title }),

  message: (message: string, type?: 'info' | 'warning' | 'error', title?: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannel.Dialog_Message, { message, type, title }),
};
