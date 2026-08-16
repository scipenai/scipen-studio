/**
 * @file Zotero IPC handlers — settings / secure API keys / environment probes / canonical
 *       bib index snapshots and diagnostics
 * @sideeffect Persists to electron-store and the OS keychain; broadcasts settings changes via
 *             Zotero_SettingsChanged; no implicit caching inside handlers (wizard finish()
 *             is the sole writer for path / localApiEnabled / integrationEnabled).
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
  deleteZoteroWebApiKey,
  secureHas,
  SecureStorageKeys,
  setZoteroEmbeddingApiKey,
  setZoteroMinerUApiKey,
  setZoteroWebApiKey,
} from '../services/SecureStorageService';
import { getZoteroDiscoveryService } from '../services/zotero/ZoteroDiscoveryService';
import { getMinerUParseService } from '../services/zotero/MinerUParseService';
import {
  getZoteroFullTextService,
  resolveZoteroPdfPath,
} from '../services/zotero/ZoteroFullTextService';
import { getZoteroLocalApiClient } from '../services/zotero/ZoteroLocalApiClient';
import {
  getZoteroOrchestrator,
  invalidateWebApiCredentials,
} from '../services/zotero/ZoteroOrchestrator';
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
  const dataSourceRaw = configManager.get<string>(ConfigKeys.ZoteroDataSource, 'local');
  const dataSource: 'local' | 'web' = dataSourceRaw === 'web' ? 'web' : 'local';
  return {
    integrationEnabled: configManager.get<boolean>(ConfigKeys.ZoteroIntegrationEnabled, false),
    path: configManager.get<string>(ConfigKeys.ZoteroPath, ''),
    localApiEnabled: configManager.get<boolean>(ConfigKeys.ZoteroLocalApiEnabled, false),
    embeddingProvider: isValidEmbeddingProvider(provider) ? provider : 'zhipu',
    activeRecommendation: configManager.get<boolean>(ConfigKeys.ZoteroActiveRecommendation, false),
    hasMinerUApiKey: secureHas(SecureStorageKeys.ZoteroMinerUApiKey),
    hasEmbeddingApiKey: secureHas(SecureStorageKeys.ZoteroEmbeddingApiKey),
    dataSource,
    webApiUserId: configManager.get<string>(ConfigKeys.ZoteroWebApiUserId, ''),
    hasWebApiKey: secureHas(SecureStorageKeys.ZoteroWebApiKey),
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
  let dataSourceChanged = false;
  if (typeof patch.integrationEnabled === 'boolean') {
    configManager.set(ConfigKeys.ZoteroIntegrationEnabled, patch.integrationEnabled);
  }
  if (typeof patch.path === 'string') {
    configManager.set(ConfigKeys.ZoteroPath, patch.path);
  }
  if (typeof patch.localApiEnabled === 'boolean') {
    configManager.set(ConfigKeys.ZoteroLocalApiEnabled, patch.localApiEnabled);
  }
  if (patch.dataSource === 'local' || patch.dataSource === 'web') {
    const prev = configManager.get<string>(ConfigKeys.ZoteroDataSource, 'local');
    if (prev !== patch.dataSource) {
      configManager.set(ConfigKeys.ZoteroDataSource, patch.dataSource);
      dataSourceChanged = true;
    }
  }
  if (typeof patch.webApiUserId === 'string') {
    configManager.set(ConfigKeys.ZoteroWebApiUserId, patch.webApiUserId.trim());
    // Treat userId edits as source config change too — orchestrator's WebApiClient
    // is constructed per refresh, so a fresh refresh will pick up the new ID.
    if (configManager.get<string>(ConfigKeys.ZoteroDataSource, 'local') === 'web') {
      dataSourceChanged = true;
    }
  }
  if (isValidEmbeddingProvider(patch.embeddingProvider)) {
    configManager.set(ConfigKeys.ZoteroEmbeddingProvider, patch.embeddingProvider);
    // provider change -> modelId change -> existing vectors invalidated; wipe and rebuild.
    getEmbeddingIndexService().invalidate('provider-change');
  }
  if (typeof patch.activeRecommendation === 'boolean') {
    configManager.set(ConfigKeys.ZoteroActiveRecommendation, patch.activeRecommendation);
    // Flip true -> lazy build; flip false -> ensureBuilt internally transitions to disabled.
    void getEmbeddingIndexService().ensureBuilt();
  }
  if (patch.bibTexSync) {
    configManager.set(ConfigKeys.ZoteroBibTexSyncEnabled, patch.bibTexSync.enabled);
    configManager.set(ConfigKeys.ZoteroBibTexSyncFileName, patch.bibTexSync.fileName);
    configManager.set(ConfigKeys.ZoteroBibTexSyncTranslator, patch.bibTexSync.translator);
    // Push config change to sync service immediately so flipping enable=true takes effect at once.
    getBibTexSyncService().setConfig(patch.bibTexSync);
  }

  broadcastSettingsChanged(readSettings());
  logger.info('[Zotero] Settings updated', { patchKeys: Object.keys(patch) });

  // When the user flips data source (local ↔ web) or edits web credentials
  // while in web mode, kick off an immediate refresh so the UI reflects the
  // new library instantly — otherwise they'd stare at stale items until the
  // next focus event. Fire-and-forget; orchestrator's own cooldown / error
  // handling gate the actual fetch, and the diagnostics push at the end
  // surfaces any failure to the renderer.
  if (dataSourceChanged) {
    triggerPostSettingsRefresh('manual', 'settings-patch');
  }
  return { success: true };
}

/**
 * Fire-and-forget refresh after a settings mutation. On failure, DON'T just
 * `log.warn` and vanish — also broadcast the updated diagnostics so the
 * renderer's ZoteroTab / StatusBadge can reflect the resulting error state
 * (previously the transition was invisible to the UI until the next explicit
 * `getDiagnostics` call). The refresh itself already runs `transition()`
 * inside orchestrator on error paths, so this is a belt-and-braces push for
 * cases where transition never fires (e.g. cooldown-suppressed refresh).
 */
function triggerPostSettingsRefresh(
  reason: 'manual' | 'focus' | 'error-recovery',
  origin: string
): void {
  void getZoteroOrchestrator()
    .refresh(reason)
    .then((result) => {
      if (result.status === 'error') {
        logger.warn('[Zotero] Post-settings refresh reported error', {
          origin,
          detail: result.detail,
        });
      }
    })
    .catch((err) => {
      logger.warn('[Zotero] Post-settings refresh threw', {
        origin,
        error: err instanceof Error ? err.message : String(err),
      });
      // Push the current diagnostics so the renderer sees the failure state
      // instead of assuming the refresh silently succeeded.
      try {
        broadcastSettingsChanged(readSettings());
      } catch {
        // Broadcast failure is not recoverable at this layer; the next
        // explicit renderer poll will still see updated state.
      }
    });
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
      getEmbeddingIndexService().invalidate('key-change'); // New key -> rebuild
    }
    return { success: ok };
  });
  registerHandler(IpcChannel.Zotero_ClearEmbeddingApiKey, () => {
    deleteZoteroEmbeddingApiKey();
    broadcastSettingsChanged(readSettings());
    getEmbeddingIndexService().invalidate('key-change');
    return { success: true };
  });

  // ---- Web API credential + probe ----
  registerHandler(IpcChannel.Zotero_SetWebApiKey, (token) => {
    const ok = setZoteroWebApiKey(token);
    if (ok) {
      // Bump orchestrator's memoized WebApiClient BEFORE broadcasting/refresh,
      // else the next refresh would reuse a stale client built from the old key.
      invalidateWebApiCredentials();
      broadcastSettingsChanged(readSettings());
      // Web-mode active: rebuild source snapshot with new key immediately.
      if (configManager.get<string>(ConfigKeys.ZoteroDataSource, 'local') === 'web') {
        triggerPostSettingsRefresh('manual', 'set-web-api-key');
      }
    }
    return { success: ok };
  });
  registerHandler(IpcChannel.Zotero_ClearWebApiKey, () => {
    deleteZoteroWebApiKey();
    invalidateWebApiCredentials();
    broadcastSettingsChanged(readSettings());
    if (configManager.get<string>(ConfigKeys.ZoteroDataSource, 'local') === 'web') {
      // Web mode now un-authenticated — trigger refresh so orchestrator surfaces
      // the "not configured" error rather than silently serving stale data.
      triggerPostSettingsRefresh('error-recovery', 'clear-web-api-key');
    }
    return { success: true };
  });
  registerHandler(IpcChannel.Zotero_PingWebApi, async ({ userId, apiKey }) =>
    getZoteroDiscoveryService().probeWebApi(userId, apiKey)
  );

  // ---- Discovery / liveness probes (side-effect free; wizard decides whether to finish() based on the return value) ----
  registerHandler(IpcChannel.Zotero_DetectInstallation, () => getZoteroDiscoveryService().detect());
  registerHandler(IpcChannel.Zotero_PingLocalApi, () => getZoteroLocalApiClient().ping());

  // ---- Main-canonical bib index (scheme D / D-1) ----
  // These three read channels are the renderer's sole entry into the index; the renderer
  // hits its local mirror, so per-hover / per-keystroke RPC storms cannot happen.
  registerHandler(IpcChannel.Zotero_GetSnapshot, (req) =>
    getZoteroOrchestrator().getIndex().buildSnapshotSince(req.since)
  );
  registerHandler(IpcChannel.Zotero_RequestRefresh, () =>
    getZoteroOrchestrator().refresh('manual')
  );
  registerHandler(IpcChannel.Zotero_GetDiagnostics, () => getZoteroOrchestrator().getDiagnostics());

  // ---- references.bib sync (M2 Phase 2) ----
  registerHandler(IpcChannel.Zotero_SyncBibTex, () => getBibTexSyncService().syncNow());
  registerHandler(IpcChannel.Zotero_GetBibTexSyncStatus, () => getBibTexSyncService().getStatus());

  // The three read handlers below route through `orchestrator.getActiveSource()`
  // — the facade layer that hides mode (local vs web) from IPC callers.
  // Handlers stay mode-agnostic; if we ever add a third data source, only
  // the facade grows a new impl, these handlers are untouched.
  registerHandler(IpcChannel.Zotero_GetCslByKey, async (rawKey): Promise<unknown | null> => {
    if (typeof rawKey !== 'string' || rawKey.length === 0) return null;
    const source = getZoteroOrchestrator().getActiveSource();
    if (!source) return null;
    return source.getCslByCitationKey(rawKey);
  });

  registerHandler(
    IpcChannel.Zotero_GetItemAnnotations,
    async (rawItemKey): Promise<ZoteroAnnotationDTO[]> => {
      if (typeof rawItemKey !== 'string' || rawItemKey.length === 0) return [];
      const source = getZoteroOrchestrator().getActiveSource();
      if (!source) return [];
      try {
        return await source.getItemAnnotations(rawItemKey);
      } catch (err) {
        logger.warn('[Zotero] getItemAnnotations failed', {
          itemKey: rawItemKey,
          sourceKind: source.kind,
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
      const source = getZoteroOrchestrator().getActiveSource();
      if (!source) return { text: '', truncated: false, tier: 'none' };
      return source.getFullText(rawItemKey);
    }
  );

  // PDF binary for renderer-side rendering. The path comes from the trusted Zotero API + dataDir
  // (outside the project root), so we bypass assertPathSecurity. Missing PDF / read failures throw;
  // the renderer distinguishes them by error code.
  registerHandler(IpcChannel.Zotero_LoadPdf, async (rawItemKey): Promise<ArrayBuffer> => {
    if (typeof rawItemKey !== 'string' || rawItemKey.length === 0) {
      throw new Error('invalid itemKey');
    }
    const pdfPath = await resolveZoteroPdfPath(rawItemKey);
    if (!pdfPath) throw new Error('NO_PDF_ATTACHMENT');
    const buf = await fs.readFile(pdfPath);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  });

  // MinerU precise parse: fire-and-forget start; progress flows over the Zotero_MinerUProgress event.
  // Internal try/catch + broadcast failed handle errors; here we only ACK "started".
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

  // ---- Embedding active recommendation (M3 yardstick 5) ----
  // Index status changes are broadcast to every window (build progress / no-key / error);
  // renderers update their UI accordingly.
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
