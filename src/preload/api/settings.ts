/**
 * @file Settings API - Settings API Module
 * @description Provides IPC interfaces for AI Provider, model selection, configuration change listeners
 * @depends electron.ipcRenderer
 */

import { ipcRenderer } from 'electron';
import { IpcChannel } from '../../../shared/ipc/channels';
import type { AIConfigDTO, AIProviderDTO, SelectedModels } from '../../../shared/ipc/types';
import { createSafeListener } from './_shared';

// ====== Settings API ======
export const settingsApi = {
  getAIProviders: (): Promise<AIProviderDTO[]> =>
    ipcRenderer.invoke(IpcChannel.Settings_GetAIProviders),

  /**
   * Set AI provider list
   * @sideeffect Persists provider configuration to disk
   */
  setAIProviders: (providers: AIProviderDTO[]): Promise<{ success: boolean }> =>
    ipcRenderer.invoke(IpcChannel.Settings_SetAIProviders, providers),

  getSelectedModels: (): Promise<SelectedModels> =>
    ipcRenderer.invoke(IpcChannel.Settings_GetSelectedModels),

  /**
   * Set selected model configuration
   * @sideeffect Persists model selection to disk
   */
  setSelectedModels: (models: SelectedModels): Promise<{ success: boolean }> =>
    ipcRenderer.invoke(IpcChannel.Settings_SetSelectedModels, models),

  getAIConfig: (): Promise<AIConfigDTO> => ipcRenderer.invoke(IpcChannel.Settings_GetAIConfig),

  /**
   * Set complete AI configuration
   * @sideeffect Persists configuration to disk and may trigger service reinitialization
   */
  setAIConfig: (config: AIConfigDTO): Promise<{ success: boolean }> =>
    ipcRenderer.invoke(IpcChannel.Settings_SetAIConfig, config),

  /**
   * Listen to AI configuration change events
   * @returns Unsubscribe function
   * @sideeffect Registers IPC event listener that must be cleaned up
   */
  onAIConfigChanged: createSafeListener<AIConfigDTO>(IpcChannel.Settings_AIConfigChanged),
};
