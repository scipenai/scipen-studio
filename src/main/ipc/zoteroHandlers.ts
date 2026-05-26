/**
 * @file Zotero IPC handlers — settings / 安全 API key / 环境探测 / canonical
 *       bib index 快照与诊断
 * @sideeffect 持久化到 electron-store 与 OS keychain;通过 Zotero_SettingsChanged
 *             广播 settings 变化;不在 handler 内做隐式 cache(wizard finish()
 *             是唯一写 path / localApiEnabled / integrationEnabled 的位置)。
 */

import { BrowserWindow } from 'electron';
import { IpcChannel } from '../../../shared/ipc/channels';
import type { ZoteroSettingsDTO, ZoteroSettingsPatchDTO } from '../../../shared/types/zotero';
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
import { getZoteroOrchestrator } from '../services/zotero/ZoteroOrchestrator';
import { getBibTexSyncService } from '../services/zotero/BibTexSyncService';
import { registerHandler } from './typedIpc';

const logger = createLogger('ZoteroHandlers');

const VALID_EMBEDDING_PROVIDERS = ['zhipu', 'aliyun', 'openai'] as const;
type ValidEmbeddingProvider = (typeof VALID_EMBEDDING_PROVIDERS)[number];

function isValidEmbeddingProvider(value: unknown): value is ValidEmbeddingProvider {
  return typeof value === 'string' && (VALID_EMBEDDING_PROVIDERS as readonly string[]).includes(value);
}

function readSettings(): ZoteroSettingsDTO {
  const provider = configManager.get<string>(ConfigKeys.ZoteroEmbeddingProvider, 'zhipu');
  return {
    integrationEnabled: configManager.get<boolean>(ConfigKeys.ZoteroIntegrationEnabled, false),
    path: configManager.get<string>(ConfigKeys.ZoteroPath, ''),
    localApiEnabled: configManager.get<boolean>(ConfigKeys.ZoteroLocalApiEnabled, false),
    embeddingProvider: isValidEmbeddingProvider(provider) ? provider : 'zhipu',
    activeRecommendation: configManager.get<boolean>(
      ConfigKeys.ZoteroActiveRecommendation,
      false
    ),
    hasMinerUApiKey: secureHas(SecureStorageKeys.ZoteroMinerUApiKey),
    hasEmbeddingApiKey: secureHas(SecureStorageKeys.ZoteroEmbeddingApiKey),
    bibTexSync: {
      enabled: configManager.get<boolean>(ConfigKeys.ZoteroBibTexSyncEnabled, true),
      fileName: configManager.get<string>(
        ConfigKeys.ZoteroBibTexSyncFileName,
        '.scipen/zotero_library.bib'
      ),
      translator: configManager.get<string>(
        ConfigKeys.ZoteroBibTexSyncTranslator,
        'BetterBibLaTeX'
      ),
    },
  };
}

function broadcastSettingsChanged(settings: ZoteroSettingsDTO): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IpcChannel.Zotero_SettingsChanged, settings);
    }
  }
}

function applySettingsPatch(patch: ZoteroSettingsPatchDTO): { success: boolean } {
  if (typeof patch.integrationEnabled === 'boolean') {
    configManager.set(ConfigKeys.ZoteroIntegrationEnabled, patch.integrationEnabled);
  }
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
  if (patch.bibTexSync) {
    configManager.set(ConfigKeys.ZoteroBibTexSyncEnabled, patch.bibTexSync.enabled);
    configManager.set(ConfigKeys.ZoteroBibTexSyncFileName, patch.bibTexSync.fileName);
    configManager.set(ConfigKeys.ZoteroBibTexSyncTranslator, patch.bibTexSync.translator);
    // 配置变更同步通知 sync service —— 让其立即生效(enable 翻 true 时立刻同步)。
    getBibTexSyncService().setConfig(patch.bibTexSync);
  }

  broadcastSettingsChanged(readSettings());
  logger.info('[Zotero] Settings updated', { patchKeys: Object.keys(patch) });
  return { success: true };
}

export function registerZoteroHandlers(): void {
  // ---- Settings ----
  registerHandler(IpcChannel.Zotero_GetSettings, () => readSettings());
  registerHandler(IpcChannel.Zotero_SetSettings, (patch) => applySettingsPatch(patch));

  // ---- Secure API keys ----
  registerHandler(IpcChannel.Zotero_SetMinerUApiKey, (token) => {
    const ok = setZoteroMinerUApiKey(token);
    if (ok) broadcastSettingsChanged(readSettings());
    return { success: ok };
  });
  registerHandler(IpcChannel.Zotero_ClearMinerUApiKey, () => {
    deleteZoteroMinerUApiKey();
    broadcastSettingsChanged(readSettings());
    return { success: true };
  });
  registerHandler(IpcChannel.Zotero_SetEmbeddingApiKey, (token) => {
    const ok = setZoteroEmbeddingApiKey(token);
    if (ok) broadcastSettingsChanged(readSettings());
    return { success: ok };
  });
  registerHandler(IpcChannel.Zotero_ClearEmbeddingApiKey, () => {
    deleteZoteroEmbeddingApiKey();
    broadcastSettingsChanged(readSettings());
    return { success: true };
  });

  // ---- 探测 / 探活(无副作用,wizard 自己根据返回再决定是否 finish) ----
  registerHandler(IpcChannel.Zotero_DetectInstallation, () =>
    getZoteroDiscoveryService().detect()
  );
  registerHandler(IpcChannel.Zotero_PingLocalApi, () => getZoteroLocalApiClient().ping());

  // ---- Main-canonical bib index(方案 D / D-1) ----
  // 三个 read 通道是 renderer 读 index 的唯一入口;renderer 镜像本地命中,
  // 不存在 per-hover / per-keystroke 的 RPC 风暴。
  registerHandler(IpcChannel.Zotero_GetSnapshot, (req) =>
    getZoteroOrchestrator().getIndex().buildSnapshotSince(req.since)
  );
  registerHandler(IpcChannel.Zotero_RequestRefresh, () =>
    getZoteroOrchestrator().refresh('manual')
  );
  registerHandler(IpcChannel.Zotero_GetDiagnostics, () =>
    getZoteroOrchestrator().getDiagnostics()
  );

  // ---- references.bib 同步(M2 Phase 2)----
  registerHandler(IpcChannel.Zotero_SyncBibTex, () => getBibTexSyncService().syncNow());
  registerHandler(IpcChannel.Zotero_GetBibTexSyncStatus, () =>
    getBibTexSyncService().getStatus()
  );

  logger.info('[IPC] Zotero handlers registered');
}
