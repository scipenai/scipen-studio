/**
 * @file Zotero API - Renderer-facing Zotero integration surface
 * @description Settings get/set + secure API key setters + detection/ping + settings-changed listener.
 *              API keys go through dedicated channels and are NEVER returned in plaintext.
 * @depends electron.ipcRenderer
 */

import { ipcRenderer } from 'electron';
import { IpcChannel } from '../../../shared/ipc/channels';
import type {
  ZoteroDetectionResultDTO,
  ZoteroPingResultDTO,
  ZoteroSettingsDTO,
  ZoteroSettingsPatchDTO,
} from '../../../shared/types/zotero';
import { createSafeListener } from './_shared';

export const zoteroApi = {
  /** Read all Zotero settings (API keys never returned in plaintext, only presence booleans). */
  getSettings: (): Promise<ZoteroSettingsDTO> => ipcRenderer.invoke(IpcChannel.Zotero_GetSettings),

  /**
   * Write non-sensitive Zotero settings.
   * @sideeffect Persists to electron-store and broadcasts `Zotero_SettingsChanged`.
   */
  setSettings: (patch: ZoteroSettingsPatchDTO): Promise<{ success: boolean }> =>
    ipcRenderer.invoke(IpcChannel.Zotero_SetSettings, patch),

  /**
   * Store the MinerU API token in OS keychain.
   * @sideeffect Persists to safeStorage; renderer never sees the plaintext after this call.
   */
  setMinerUApiKey: (token: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke(IpcChannel.Zotero_SetMinerUApiKey, token),

  /** Remove the stored MinerU API token. */
  clearMinerUApiKey: (): Promise<{ success: boolean }> =>
    ipcRenderer.invoke(IpcChannel.Zotero_ClearMinerUApiKey),

  /**
   * Store the embedding-provider API key in OS keychain.
   * @sideeffect Persists to safeStorage.
   */
  setEmbeddingApiKey: (token: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke(IpcChannel.Zotero_SetEmbeddingApiKey, token),

  /** Remove the stored embedding-provider API key. */
  clearEmbeddingApiKey: (): Promise<{ success: boolean }> =>
    ipcRenderer.invoke(IpcChannel.Zotero_ClearEmbeddingApiKey),

  /** Auto-detect a local Zotero installation. Used by the setup wizard. */
  detectInstallation: (): Promise<ZoteroDetectionResultDTO> =>
    ipcRenderer.invoke(IpcChannel.Zotero_DetectInstallation),

  /** Ping the Zotero Local API at localhost:23119 to verify the user has enabled it. */
  pingLocalApi: (): Promise<ZoteroPingResultDTO> =>
    ipcRenderer.invoke(IpcChannel.Zotero_PingLocalApi),

  /**
   * Subscribe to Zotero settings change events.
   * @returns Unsubscribe function.
   * @sideeffect Registers an IPC event listener that must be cleaned up.
   */
  onSettingsChanged: createSafeListener<ZoteroSettingsDTO>(IpcChannel.Zotero_SettingsChanged),
};
