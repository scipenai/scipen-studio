/**
 * @file Zotero IPC Handlers — settings, secure API keys, environment probes
 * @description M1 skeleton: settings get/set + secure key setters work end-to-end.
 *              `Zotero_DetectInstallation` and `Zotero_PingLocalApi` are placeholders
 *              for the M1 wizard work that lands in `ZoteroDiscoveryService` /
 *              `ZoteroLocalApiClient`.
 * @sideeffect Persists to electron-store and OS keychain; broadcasts settings changes.
 */

import { BrowserWindow, ipcMain } from 'electron';
import { IpcChannel } from '../../../shared/ipc/channels';
import type {
  ZoteroDetectionResultDTO,
  ZoteroPingResultDTO,
  ZoteroSettingsDTO,
  ZoteroSettingsPatchDTO,
} from '../../../shared/types/zotero';
import { ConfigKeys } from '../../../shared/types/config-keys';
import { configManager } from '../services/ConfigManager';
import { createLogger } from '../services/LoggerService';
import {
  deleteZoteroEmbeddingApiKey,
  deleteZoteroMinerUApiKey,
  secureHas,
  SecureStorageKeys,
  setZoteroEmbeddingApiKey,
  setZoteroMinerUApiKey,
} from '../services/SecureStorageService';
import { getZoteroDiscoveryService } from '../services/zotero/ZoteroDiscoveryService';
import { getZoteroLocalApiClient } from '../services/zotero/ZoteroLocalApiClient';

const logger = createLogger('ZoteroHandlers');

const VALID_EMBEDDING_PROVIDERS = ['zhipu', 'aliyun', 'openai'] as const;
type ValidEmbeddingProvider = (typeof VALID_EMBEDDING_PROVIDERS)[number];

function isValidEmbeddingProvider(value: unknown): value is ValidEmbeddingProvider {
  return typeof value === 'string' && (VALID_EMBEDDING_PROVIDERS as readonly string[]).includes(value);
}

function readSettings(): ZoteroSettingsDTO {
  const provider = configManager.get<string>(ConfigKeys.ZoteroEmbeddingProvider, 'zhipu');
  return {
    path: configManager.get<string>(ConfigKeys.ZoteroPath, ''),
    localApiEnabled: configManager.get<boolean>(ConfigKeys.ZoteroLocalApiEnabled, false),
    embeddingProvider: isValidEmbeddingProvider(provider) ? provider : 'zhipu',
    activeRecommendation: configManager.get<boolean>(
      ConfigKeys.ZoteroActiveRecommendation,
      false
    ),
    hasMinerUApiKey: secureHas(SecureStorageKeys.ZoteroMinerUApiKey),
    hasEmbeddingApiKey: secureHas(SecureStorageKeys.ZoteroEmbeddingApiKey),
  };
}

function broadcastSettingsChanged(settings: ZoteroSettingsDTO): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IpcChannel.Zotero_SettingsChanged, settings);
    }
  }
}

export function registerZoteroHandlers(): void {
  ipcMain.handle(IpcChannel.Zotero_GetSettings, (): ZoteroSettingsDTO => readSettings());

  ipcMain.handle(
    IpcChannel.Zotero_SetSettings,
    (_event, rawPatch: unknown): { success: boolean } => {
      const patch = (rawPatch ?? {}) as ZoteroSettingsPatchDTO;

      if (typeof patch.path === 'string') {
        configManager.set(ConfigKeys.ZoteroPath, patch.path);
      }
      if (typeof patch.localApiEnabled === 'boolean') {
        configManager.set(ConfigKeys.ZoteroLocalApiEnabled, patch.localApiEnabled);
      }
      if (isValidEmbeddingProvider(patch.embeddingProvider)) {
        configManager.set(ConfigKeys.ZoteroEmbeddingProvider, patch.embeddingProvider);
      }
      if (typeof patch.activeRecommendation === 'boolean') {
        configManager.set(ConfigKeys.ZoteroActiveRecommendation, patch.activeRecommendation);
      }

      broadcastSettingsChanged(readSettings());
      logger.info('[Zotero] Settings updated', { patchKeys: Object.keys(patch) });
      return { success: true };
    }
  );

  ipcMain.handle(
    IpcChannel.Zotero_SetMinerUApiKey,
    (_event, rawToken: unknown): { success: boolean } => {
      if (typeof rawToken !== 'string' || rawToken.length === 0) {
        return { success: false };
      }
      const ok = setZoteroMinerUApiKey(rawToken);
      if (ok) {
        broadcastSettingsChanged(readSettings());
      }
      return { success: ok };
    }
  );

  ipcMain.handle(IpcChannel.Zotero_ClearMinerUApiKey, (): { success: boolean } => {
    deleteZoteroMinerUApiKey();
    broadcastSettingsChanged(readSettings());
    return { success: true };
  });

  ipcMain.handle(
    IpcChannel.Zotero_SetEmbeddingApiKey,
    (_event, rawToken: unknown): { success: boolean } => {
      if (typeof rawToken !== 'string' || rawToken.length === 0) {
        return { success: false };
      }
      const ok = setZoteroEmbeddingApiKey(rawToken);
      if (ok) {
        broadcastSettingsChanged(readSettings());
      }
      return { success: ok };
    }
  );

  ipcMain.handle(IpcChannel.Zotero_ClearEmbeddingApiKey, (): { success: boolean } => {
    deleteZoteroEmbeddingApiKey();
    broadcastSettingsChanged(readSettings());
    return { success: true };
  });

  ipcMain.handle(
    IpcChannel.Zotero_DetectInstallation,
    async (): Promise<ZoteroDetectionResultDTO> => {
      const result = await getZoteroDiscoveryService().detect();
      if (result.found && result.path && !configManager.get<string>(ConfigKeys.ZoteroPath, '')) {
        // Cache the detected path so subsequent sessions skip the FS scan.
        configManager.set(ConfigKeys.ZoteroPath, result.path);
        broadcastSettingsChanged(readSettings());
      }
      return result;
    }
  );

  ipcMain.handle(
    IpcChannel.Zotero_PingLocalApi,
    async (): Promise<ZoteroPingResultDTO> => getZoteroLocalApiClient().ping()
  );

  logger.info('[IPC] Zotero handlers registered');
}
