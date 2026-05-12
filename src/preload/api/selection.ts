/**
 * @file Selection API - Text Selection Assistant API Module
 * @description Provides IPC interfaces for text selection capture, action window management
 * @depends electron.ipcRenderer
 */

import { ipcRenderer } from 'electron';
import { IpcChannel } from '../../../shared/ipc/channels';
import type { SelectionCaptureDTO, SelectionConfigDTO } from '../../../shared/ipc/types';
import { createSafeListener } from './_shared';

/**
 * Selection API exposed to renderer process
 */
export const selectionApi = {
  // ====== Configuration Management ======

  /**
   * Set selection assistant enabled state
   * @sideeffect Enables/disables global text selection monitoring
   */
  setEnabled: (enabled: boolean): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IpcChannel.Selection_SetEnabled, enabled),

  isEnabled: (): Promise<boolean> => ipcRenderer.invoke(IpcChannel.Selection_IsEnabled),

  getConfig: (): Promise<SelectionConfigDTO | null> =>
    ipcRenderer.invoke(IpcChannel.Selection_GetConfig),

  setConfig: (config: Partial<SelectionConfigDTO>): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IpcChannel.Selection_SetConfig, config),

  // ====== Selection Operations ======

  getText: (): Promise<SelectionCaptureDTO | null> =>
    ipcRenderer.invoke(IpcChannel.Selection_GetText),

  // ====== Event Listeners ======

  /**
   * Listen to text capture events
   * @returns Unsubscribe function
   * @sideeffect Registers IPC event listener that must be cleaned up
   */
  onTextCaptured: createSafeListener<SelectionCaptureDTO>(IpcChannel.Selection_TextCaptured),
};
