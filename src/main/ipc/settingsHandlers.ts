/**
 * @file Settings IPC Handlers (Type-Safe)
 * @description Manages AI provider configuration and model selection settings.
 * @depends ConfigManager, createTypedHandlers
 * @sideeffect Broadcasts configuration changes to all windows via IPC
 */

import { BrowserWindow } from 'electron';
import { IpcChannel } from '../../../shared/ipc/channels';
import type { AIConfigDTO, AIProviderDTO, SelectedModels } from '../../../shared/ipc/types';
import { configManager } from '../services/ConfigManager';
import { createLogger } from '../services/LoggerService';
import { createTypedHandlers } from './typedIpc';

const logger = createLogger('SettingsHandlers');

/**
 * Broadcasts AI configuration changes to all open windows.
 * @sideeffect Sends IPC message to all non-destroyed windows
 */
function broadcastAIConfigChanged(config: AIConfigDTO): void {
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send(IpcChannel.Settings_AIConfigChanged, config);
    }
  }
}

/**
 * Registers all settings-related IPC handlers.
 * @sideeffect Registers ipcMain handlers for AI configuration management
 */
export function registerSettingsHandlers(): void {
  const handlers = createTypedHandlers(
    {
      // ====== AI Providers ======

      /** Gets the list of configured AI providers */
      [IpcChannel.Settings_GetAIProviders]: () => {
        logger.debug('[Settings] Getting AI providers');
        return configManager.getAIProviders();
      },

      /** Sets the list of AI providers */
      [IpcChannel.Settings_SetAIProviders]: (providers: AIProviderDTO[]) => {
        logger.info('[Settings] Setting AI providers', { count: providers.length });
        configManager.setAIProviders(providers);

        const fullConfig = configManager.getFullAIConfig();
        broadcastAIConfigChanged(fullConfig);

        return { success: true };
      },

      // ====== Model Selection ======

      /** Gets the currently selected models for each task type */
      [IpcChannel.Settings_GetSelectedModels]: () => {
        logger.debug('[Settings] Getting selected models');
        return configManager.getSelectedModels();
      },

      /** Sets the selected models for each task type */
      [IpcChannel.Settings_SetSelectedModels]: (models: SelectedModels) => {
        logger.info('[Settings] Setting selected models');
        configManager.setSelectedModels(models);

        const fullConfig = configManager.getFullAIConfig();
        broadcastAIConfigChanged(fullConfig);

        return { success: true };
      },

      // ====== Full Configuration ======

      /** Gets the complete AI configuration */
      [IpcChannel.Settings_GetAIConfig]: () => {
        logger.debug('[Settings] Getting full AI config');
        return configManager.getFullAIConfig();
      },

      /** Sets the complete AI configuration */
      [IpcChannel.Settings_SetAIConfig]: (config: AIConfigDTO) => {
        // Use debug level to avoid log spam during frequent saves
        logger.debug('[Settings] Setting full AI config', {
          providerCount: config.providers.length,
        });
        configManager.setFullAIConfig(config);

        broadcastAIConfigChanged(config);

        return { success: true };
      },
    },
    { logErrors: true }
  );

  handlers.registerAll();
  logger.info('[IPC] Settings handlers registered (type-safe)');
}
