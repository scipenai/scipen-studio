/**
 * @file Selection API - Text Selection Assistant API Module
 * @description Provides IPC interfaces for text selection capture, action window management, adding to knowledge base
 * @depends electron.ipcRenderer
 */

import { ipcRenderer } from 'electron';
import { IpcChannel } from '../../../shared/ipc/channels';
import type {
  SelectionAddToKnowledgeDTO,
  SelectionCaptureDTO,
  SelectionConfigDTO,
} from '../../../shared/ipc/types';
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

  // ====== Window Control ======

  /**
   * Show selection action window
   * @sideeffect Creates/displays floating action window
   */
  showActionWindow: (data?: SelectionCaptureDTO): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IpcChannel.Selection_ShowActionWindow, data),

  /**
   * Hide selection action window
   * @sideeffect Closes floating action window
   */
  hideActionWindow: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IpcChannel.Selection_HideActionWindow),

  hideToolbar: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IpcChannel.Selection_HideToolbar),

  // ====== Knowledge Base Integration ======

  /**
   * Add selected text to knowledge base
   * @sideeffect Creates document in knowledge base and triggers processing
   */
  addToKnowledge: (
    dto: SelectionAddToKnowledgeDTO
  ): Promise<{ success: boolean; taskId?: string; error?: string }> =>
    ipcRenderer.invoke(IpcChannel.Selection_AddToKnowledge, dto),

  // ====== Event Listeners ======

  /**
   * Listen to text capture events
   * @returns Unsubscribe function
   * @sideeffect Registers IPC event listener that must be cleaned up
   */
  onTextCaptured: createSafeListener<SelectionCaptureDTO>(IpcChannel.Selection_TextCaptured),
};
