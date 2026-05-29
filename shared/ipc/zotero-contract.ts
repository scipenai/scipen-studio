/**
 * @file Zotero IPC contract — invoke channel args/results
 * @description 13 个 Zotero 域通道的类型契约(11 个 invoke + 2 个 event)。
 *              事件通道(SettingsChanged / Event)在 IPCEventContract 声明;
 *              此处仅声明 invoke。
 */

import { IpcChannel } from './channels';
import type {
  ZoteroAnnotationDTO,
  ZoteroDetectionResultDTO,
  ZoteroFullTextResultDTO,
  ZoteroPingResultDTO,
  ZoteroSettingsDTO,
  ZoteroSettingsPatchDTO,
} from '../types/zotero';
import type {
  BibTexSyncStatusDTO,
  GetSnapshotRequestDTO,
  GetSnapshotResultDTO,
  RefreshResultDTO,
  ZoteroDiagnosticsDTO,
} from '../types/zotero-events';

export interface IPCZoteroContract {
  [IpcChannel.Zotero_GetSettings]: {
    args: [];
    result: ZoteroSettingsDTO;
  };
  [IpcChannel.Zotero_SetSettings]: {
    args: [patch: ZoteroSettingsPatchDTO];
    result: { success: boolean };
  };
  [IpcChannel.Zotero_SetMinerUApiKey]: {
    args: [token: string];
    result: { success: boolean };
  };
  [IpcChannel.Zotero_ClearMinerUApiKey]: {
    args: [];
    result: { success: boolean };
  };
  [IpcChannel.Zotero_SetEmbeddingApiKey]: {
    args: [token: string];
    result: { success: boolean };
  };
  [IpcChannel.Zotero_ClearEmbeddingApiKey]: {
    args: [];
    result: { success: boolean };
  };
  [IpcChannel.Zotero_DetectInstallation]: {
    args: [];
    result: ZoteroDetectionResultDTO;
  };
  [IpcChannel.Zotero_PingLocalApi]: {
    args: [];
    result: ZoteroPingResultDTO;
  };
  [IpcChannel.Zotero_GetSnapshot]: {
    args: [req: GetSnapshotRequestDTO];
    result: GetSnapshotResultDTO;
  };
  [IpcChannel.Zotero_RequestRefresh]: {
    args: [];
    result: RefreshResultDTO;
  };
  [IpcChannel.Zotero_GetDiagnostics]: {
    args: [];
    result: ZoteroDiagnosticsDTO;
  };
  [IpcChannel.Zotero_SyncBibTex]: {
    args: [];
    result: BibTexSyncStatusDTO;
  };
  [IpcChannel.Zotero_GetBibTexSyncStatus]: {
    args: [];
    result: BibTexSyncStatusDTO;
  };
  [IpcChannel.Zotero_GetCslByKey]: {
    args: [citationKey: string];
    result: unknown | null;
  };
  [IpcChannel.Zotero_GetItemAnnotations]: {
    args: [itemKey: string];
    result: ZoteroAnnotationDTO[];
  };
  [IpcChannel.Zotero_GetFullText]: {
    args: [itemKey: string];
    result: ZoteroFullTextResultDTO;
  };
  [IpcChannel.Zotero_LoadPdf]: {
    args: [itemKey: string];
    result: ArrayBuffer;
  };
}
