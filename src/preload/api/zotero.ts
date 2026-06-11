/**
 * @file Zotero API — renderer-side Zotero integration entry
 * @description Settings get/set + secret token setters + detection/ping + settings change listener +
 *              main-process canonical bib index access (getSnapshot/requestRefresh/getDiagnostics)
 *              + bib event subscription (onEvent). API keys flow through dedicated channels;
 *              renderer never receives plaintext.
 * @depends electron.ipcRenderer
 */

import { ipcRenderer } from 'electron';
import { IpcChannel } from '../../../shared/ipc/channels';
import type {
  ZoteroAnnotationDTO,
  ZoteroDetectionResultDTO,
  ZoteroFullTextResultDTO,
  ZoteroPingResultDTO,
  ZoteroSettingsDTO,
  ZoteroSettingsPatchDTO,
} from '../../../shared/types/zotero';
import type { MinerUContentList, MinerUParseStatusDTO } from '../../../shared/types/zotero-mineru';
import type {
  EmbeddingIndexStatusDTO,
  RecommendRequestDTO,
  ZoteroEmbeddingResultDTO,
} from '../../../shared/types/zotero-embedding';
import type {
  BibTexSyncStatusDTO,
  GetSnapshotRequestDTO,
  GetSnapshotResultDTO,
  RefreshResultDTO,
  ZoteroDiagnosticsDTO,
  ZoteroEventDTO,
} from '../../../shared/types/zotero-events';
import { createSafeListener } from './_shared';

export const zoteroApi = {
  /** Read all Zotero settings (API key returned only as a boolean presence flag, never plaintext). */
  getSettings: (): Promise<ZoteroSettingsDTO> => ipcRenderer.invoke(IpcChannel.Zotero_GetSettings),

  /**
   * Write non-sensitive Zotero settings.
   * @sideeffect Persists to electron-store and broadcasts `Zotero_SettingsChanged`.
   */
  setSettings: (patch: ZoteroSettingsPatchDTO): Promise<{ success: boolean }> =>
    ipcRenderer.invoke(IpcChannel.Zotero_SetSettings, patch),

  /**
   * Write the MinerU API token to the OS keychain.
   * @sideeffect Persisted via safeStorage; the renderer can never retrieve plaintext afterwards.
   */
  setMinerUApiKey: (token: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke(IpcChannel.Zotero_SetMinerUApiKey, token),

  /** Delete the stored MinerU API token. */
  clearMinerUApiKey: (): Promise<{ success: boolean }> =>
    ipcRenderer.invoke(IpcChannel.Zotero_ClearMinerUApiKey),

  /**
   * Write the embedding provider's API key to the OS keychain.
   * @sideeffect Persisted via safeStorage.
   */
  setEmbeddingApiKey: (token: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke(IpcChannel.Zotero_SetEmbeddingApiKey, token),

  /** Delete the stored embedding API key. */
  clearEmbeddingApiKey: (): Promise<{ success: boolean }> =>
    ipcRenderer.invoke(IpcChannel.Zotero_ClearEmbeddingApiKey),

  /** Auto-detect the local Zotero installation. Called by the setup wizard. */
  detectInstallation: (): Promise<ZoteroDetectionResultDTO> =>
    ipcRenderer.invoke(IpcChannel.Zotero_DetectInstallation),

  /** Ping `localhost:23119` to verify the user has enabled the Zotero Local API. */
  pingLocalApi: (): Promise<ZoteroPingResultDTO> =>
    ipcRenderer.invoke(IpcChannel.Zotero_PingLocalApi),

  /**
   * Pull a snapshot of the main-process canonical bib index.
   * - Omit `since` -> full snapshot (BibResetDTO)
   * - Pass `since=lastEtag` -> incremental patch (BibPatchDTO); falls back to full when cursor expired
   */
  getSnapshot: (req: GetSnapshotRequestDTO = {}): Promise<GetSnapshotResultDTO> =>
    ipcRenderer.invoke(IpcChannel.Zotero_GetSnapshot, req),

  /**
   * Trigger a refresh (focus/manual/error-recovery). Cooldown debounce lives inside the main process.
   * Only returns the trigger status; actual changes are pushed via `Zotero_Event`.
   */
  requestRefresh: (): Promise<RefreshResultDTO> =>
    ipcRenderer.invoke(IpcChannel.Zotero_RequestRefresh),

  /** Fetch the diagnostics snapshot (state / data-source health / itemCount / etag / lastSyncedAt). */
  getDiagnostics: (): Promise<ZoteroDiagnosticsDTO> =>
    ipcRenderer.invoke(IpcChannel.Zotero_GetDiagnostics),

  /** Force a `references.bib` sync (bypasses the enabled gate and debounce). */
  syncBibTex: (): Promise<BibTexSyncStatusDTO> => ipcRenderer.invoke(IpcChannel.Zotero_SyncBibTex),

  /** Read the current BibTeX sync status (idle / syncing / ok / conflict / error). */
  getBibTexSyncStatus: (): Promise<BibTexSyncStatusDTO> =>
    ipcRenderer.invoke(IpcChannel.Zotero_GetBibTexSyncStatus),

  /** Fetch annotations attached to one Zotero item (PDF attachment). */
  getItemAnnotations: (itemKey: string): Promise<ZoteroAnnotationDTO[]> =>
    ipcRenderer.invoke(IpcChannel.Zotero_GetItemAnnotations, itemKey),

  /** Extract + cache one item's PDF full text (tier-1 local). */
  getFullText: (itemKey: string): Promise<ZoteroFullTextResultDTO> =>
    ipcRenderer.invoke(IpcChannel.Zotero_GetFullText, itemKey),

  /** Load one item's PDF attachment bytes for in-app rendering. */
  loadPdf: (itemKey: string): Promise<ArrayBuffer> =>
    ipcRenderer.invoke(IpcChannel.Zotero_LoadPdf, itemKey),

  /** Start MinerU precise-parse (fire-and-forget; progress via onMinerUProgress). */
  parseWithMinerU: (itemKey: string): Promise<{ started: boolean }> =>
    ipcRenderer.invoke(IpcChannel.Zotero_ParseWithMinerU, itemKey),

  /** Query current MinerU parse status for one item. */
  getMinerUStatus: (itemKey: string): Promise<MinerUParseStatusDTO> =>
    ipcRenderer.invoke(IpcChannel.Zotero_GetMinerUStatus, itemKey),

  /** Read an item's MinerU-parsed markdown + parsed dir (human MD view). */
  getParsedMarkdown: (itemKey: string): Promise<{ markdown: string; parsedDir: string } | null> =>
    ipcRenderer.invoke(IpcChannel.Zotero_GetParsedMarkdown, itemKey),

  /** Read an item's MinerU content_list.json (paragraph bbox) for cite-hover shots. */
  getContentList: (itemKey: string): Promise<MinerUContentList | null> =>
    ipcRenderer.invoke(IpcChannel.Zotero_GetContentList, itemKey),

  /** Subscribe to MinerU parse progress broadcasts. */
  onMinerUProgress: createSafeListener<MinerUParseStatusDTO>(IpcChannel.Zotero_MinerUProgress),

  /** Read embedding index status (M3 active recommendation). */
  getEmbeddingStatus: (): Promise<EmbeddingIndexStatusDTO> =>
    ipcRenderer.invoke(IpcChannel.Zotero_GetEmbeddingStatus),

  /** Force a full embedding index rebuild (fire-and-forget; progress via event). */
  rebuildEmbeddingIndex: (): Promise<{ started: boolean }> =>
    ipcRenderer.invoke(IpcChannel.Zotero_RebuildEmbeddingIndex),

  /** Query active citation recommendations for the current paragraph. */
  queryRecommendation: (req: RecommendRequestDTO): Promise<ZoteroEmbeddingResultDTO> =>
    ipcRenderer.invoke(IpcChannel.Zotero_QueryRecommendation, req),

  /** Subscribe to embedding index status broadcasts. */
  onEmbeddingProgress: createSafeListener<EmbeddingIndexStatusDTO>(
    IpcChannel.Zotero_EmbeddingProgress
  ),

  /**
   * Subscribe to Zotero settings change events.
   * @returns Unsubscribe function.
   * @sideeffect Registers an IPC listener that must be cleaned up explicitly.
   */
  onSettingsChanged: createSafeListener<ZoteroSettingsDTO>(IpcChannel.Zotero_SettingsChanged),

  /**
   * Subscribe to main-process bib index broadcasts (initial/patch/status/invalidated discriminated union).
   * The renderer mirror layer listens here and maintains local items + trigram.
   * @returns Unsubscribe function.
   */
  onEvent: createSafeListener<ZoteroEventDTO>(IpcChannel.Zotero_Event),
};
