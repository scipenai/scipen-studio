/**
 * @file Zotero IPC handlers — settings / 安全 API key / 环境探测 / canonical
 *       bib index 快照与诊断
 * @sideeffect 持久化到 electron-store 与 OS keychain;通过 Zotero_SettingsChanged
 *             广播 settings 变化;不在 handler 内做隐式 cache(wizard finish()
 *             是唯一写 path / localApiEnabled / integrationEnabled 的位置)。
 */

import { BrowserWindow } from 'electron';
import { promises as fs } from 'fs';
import { IpcChannel } from '../../../shared/ipc/channels';
import type {
  ZoteroAnnotationDTO,
  ZoteroFullTextResultDTO,
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
import { getBetterBibTexClient } from '../services/zotero/BetterBibTexClient';
import { getZoteroDiscoveryService } from '../services/zotero/ZoteroDiscoveryService';
import { getMinerUParseService } from '../services/zotero/MinerUParseService';
import {
  getZoteroFullTextService,
  resolveZoteroPdfPath,
} from '../services/zotero/ZoteroFullTextService';
import { getZoteroLocalApiClient } from '../services/zotero/ZoteroLocalApiClient';
import { getZoteroOrchestrator } from '../services/zotero/ZoteroOrchestrator';
import { getBibTexSyncService } from '../services/zotero/BibTexSyncService';
import { getEmbeddingIndexService } from '../services/zotero/EmbeddingIndexService';
import { registerHandler } from './typedIpc';

const logger = createLogger('ZoteroHandlers');

const VALID_EMBEDDING_PROVIDERS = ['zhipu', 'aliyun', 'openai'] as const;
type ValidEmbeddingProvider = (typeof VALID_EMBEDDING_PROVIDERS)[number];

function isValidEmbeddingProvider(value: unknown): value is ValidEmbeddingProvider {
  return (
    typeof value === 'string' && (VALID_EMBEDDING_PROVIDERS as readonly string[]).includes(value)
  );
}

/**
 * Flatten an error into a log-friendly object. Node's undici (`fetch
 * failed`) tucks the real socket-level reason on `err.cause` — without
 * surfacing it, every network glitch reads as the same opaque "fetch
 * failed", which made the M1 Zotero rollout hard to debug.
 */
function describeFetchError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { error: String(err) };
  const cause = (err as { cause?: unknown }).cause;
  const out: Record<string, unknown> = { error: err.message };
  if (cause instanceof Error) {
    out.causeMessage = cause.message;
    const code = (cause as { code?: unknown }).code;
    if (code !== undefined) out.causeCode = code;
    const errno = (cause as { errno?: unknown }).errno;
    if (errno !== undefined) out.causeErrno = errno;
    const syscall = (cause as { syscall?: unknown }).syscall;
    if (syscall !== undefined) out.causeSyscall = syscall;
    const address = (cause as { address?: unknown }).address;
    if (address !== undefined) out.causeAddress = address;
    const port = (cause as { port?: unknown }).port;
    if (port !== undefined) out.causePort = port;
  }
  return out;
}

function readSettings(): ZoteroSettingsDTO {
  const provider = configManager.get<string>(ConfigKeys.ZoteroEmbeddingProvider, 'zhipu');
  return {
    integrationEnabled: configManager.get<boolean>(ConfigKeys.ZoteroIntegrationEnabled, false),
    path: configManager.get<string>(ConfigKeys.ZoteroPath, ''),
    localApiEnabled: configManager.get<boolean>(ConfigKeys.ZoteroLocalApiEnabled, false),
    embeddingProvider: isValidEmbeddingProvider(provider) ? provider : 'zhipu',
    activeRecommendation: configManager.get<boolean>(ConfigKeys.ZoteroActiveRecommendation, false),
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
    // provider 变 → modelId 变 → 旧向量整体失效,清空重建。
    getEmbeddingIndexService().invalidate('provider-change');
  }
  if (typeof patch.activeRecommendation === 'boolean') {
    configManager.set(ConfigKeys.ZoteroActiveRecommendation, patch.activeRecommendation);
    // 翻 true → lazy 建库;翻 false → ensureBuilt 内部转 disabled。
    void getEmbeddingIndexService().ensureBuilt();
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
    if (ok) {
      broadcastSettingsChanged(readSettings());
      getEmbeddingIndexService().invalidate('key-change'); // 新 key → 重建
    }
    return { success: ok };
  });
  registerHandler(IpcChannel.Zotero_ClearEmbeddingApiKey, () => {
    deleteZoteroEmbeddingApiKey();
    broadcastSettingsChanged(readSettings());
    getEmbeddingIndexService().invalidate('key-change');
    return { success: true };
  });

  // ---- 探测 / 探活(无副作用,wizard 自己根据返回再决定是否 finish) ----
  registerHandler(IpcChannel.Zotero_DetectInstallation, () => getZoteroDiscoveryService().detect());
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
  registerHandler(IpcChannel.Zotero_GetDiagnostics, () => getZoteroOrchestrator().getDiagnostics());

  // ---- references.bib 同步(M2 Phase 2)----
  registerHandler(IpcChannel.Zotero_SyncBibTex, () => getBibTexSyncService().syncNow());
  registerHandler(IpcChannel.Zotero_GetBibTexSyncStatus, () => getBibTexSyncService().getStatus());

  registerHandler(IpcChannel.Zotero_GetCslByKey, async (rawKey): Promise<unknown | null> => {
    if (typeof rawKey !== 'string' || rawKey.length === 0) return null;
    return getBetterBibTexClient().getCslByKey(rawKey);
  });

  registerHandler(
    IpcChannel.Zotero_GetItemAnnotations,
    async (rawItemKey): Promise<ZoteroAnnotationDTO[]> => {
      if (typeof rawItemKey !== 'string' || rawItemKey.length === 0) return [];
      try {
        return await getZoteroLocalApiClient().getItemAnnotations(rawItemKey);
      } catch (err) {
        logger.warn('[Zotero] getItemAnnotations failed', {
          itemKey: rawItemKey,
          ...describeFetchError(err),
        });
        return [];
      }
    }
  );

  registerHandler(
    IpcChannel.Zotero_GetFullText,
    async (rawItemKey): Promise<ZoteroFullTextResultDTO> => {
      if (typeof rawItemKey !== 'string' || rawItemKey.length === 0) {
        return { text: '', truncated: false, tier: 'none' };
      }
      return getZoteroFullTextService().getFullText(rawItemKey);
    }
  );

  // PDF 二进制供 renderer 内嵌渲染。路径来源是受信的 Zotero API + dataDir
  // (项目目录外),不走 assertPathSecurity。无 PDF / 读失败均抛,renderer
  // 据错误码区分反馈。
  registerHandler(IpcChannel.Zotero_LoadPdf, async (rawItemKey): Promise<ArrayBuffer> => {
    if (typeof rawItemKey !== 'string' || rawItemKey.length === 0) {
      throw new Error('invalid itemKey');
    }
    const pdfPath = await resolveZoteroPdfPath(rawItemKey);
    if (!pdfPath) throw new Error('NO_PDF_ATTACHMENT');
    const buf = await fs.readFile(pdfPath);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  });

  // MinerU 精解析:fire-and-forget 启动,进度走 Zotero_MinerUProgress 事件;
  // 内部已 try/catch + broadcast failed,这里只回执"已启动"。
  registerHandler(IpcChannel.Zotero_ParseWithMinerU, async (rawItemKey) => {
    if (typeof rawItemKey !== 'string' || rawItemKey.length === 0) {
      throw new Error('invalid itemKey');
    }
    void getMinerUParseService().parse(rawItemKey);
    return { started: true };
  });

  registerHandler(IpcChannel.Zotero_GetMinerUStatus, async (rawItemKey) => {
    const key = typeof rawItemKey === 'string' ? rawItemKey : '';
    return getMinerUParseService().getStatus(key);
  });

  registerHandler(IpcChannel.Zotero_GetParsedMarkdown, async (rawItemKey) => {
    if (typeof rawItemKey !== 'string' || rawItemKey.length === 0) return null;
    return getZoteroFullTextService().getParsedMarkdown(rawItemKey);
  });

  registerHandler(IpcChannel.Zotero_GetContentList, async (rawItemKey) => {
    if (typeof rawItemKey !== 'string' || rawItemKey.length === 0) return null;
    return getZoteroFullTextService().getContentList(rawItemKey);
  });

  // ---- Embedding 主动推荐(M3 标尺5)----
  // 索引状态变化广播到所有窗口(建库进度 / no-key / error),renderer 据此更新 UI。
  getEmbeddingIndexService().setStatusListener((status) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IpcChannel.Zotero_EmbeddingProgress, status);
    }
  });
  registerHandler(IpcChannel.Zotero_GetEmbeddingStatus, () =>
    getEmbeddingIndexService().getStatus()
  );
  registerHandler(IpcChannel.Zotero_RebuildEmbeddingIndex, () => {
    getEmbeddingIndexService().invalidate('manual');
    return { started: true };
  });
  registerHandler(IpcChannel.Zotero_QueryRecommendation, (req) =>
    getEmbeddingIndexService().recommend(req)
  );

  logger.info('[IPC] Zotero handlers registered');
}
