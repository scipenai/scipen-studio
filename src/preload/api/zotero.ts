/**
 * @file Zotero API —— renderer 侧 Zotero 集成入口
 * @description 设置 get/set + 私密 token setters + detection/ping + 设置变更监听 +
 *              主进程 canonical bib 索引访问(getSnapshot/requestRefresh/getDiagnostics)
 *              + bib 事件订阅(onEvent)。API key 走专属通道,renderer 永不获取明文。
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
  /** 读取全部 Zotero 设置(API key 仅返回存在性 boolean,不出明文)。 */
  getSettings: (): Promise<ZoteroSettingsDTO> => ipcRenderer.invoke(IpcChannel.Zotero_GetSettings),

  /**
   * 写入非敏感 Zotero 设置。
   * @sideeffect 持久化到 electron-store 并广播 `Zotero_SettingsChanged`。
   */
  setSettings: (patch: ZoteroSettingsPatchDTO): Promise<{ success: boolean }> =>
    ipcRenderer.invoke(IpcChannel.Zotero_SetSettings, patch),

  /**
   * 把 MinerU API token 写入操作系统 keychain。
   * @sideeffect safeStorage 持久化,renderer 之后永远拿不到明文。
   */
  setMinerUApiKey: (token: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke(IpcChannel.Zotero_SetMinerUApiKey, token),

  /** 删除已存的 MinerU API token。 */
  clearMinerUApiKey: (): Promise<{ success: boolean }> =>
    ipcRenderer.invoke(IpcChannel.Zotero_ClearMinerUApiKey),

  /**
   * 把 embedding provider 的 API key 写入操作系统 keychain。
   * @sideeffect safeStorage 持久化。
   */
  setEmbeddingApiKey: (token: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke(IpcChannel.Zotero_SetEmbeddingApiKey, token),

  /** 删除已存的 embedding API key。 */
  clearEmbeddingApiKey: (): Promise<{ success: boolean }> =>
    ipcRenderer.invoke(IpcChannel.Zotero_ClearEmbeddingApiKey),

  /** 自动检测本地 Zotero 安装。设置向导调用。 */
  detectInstallation: (): Promise<ZoteroDetectionResultDTO> =>
    ipcRenderer.invoke(IpcChannel.Zotero_DetectInstallation),

  /** Ping `localhost:23119`,验证用户已开启 Zotero Local API。 */
  pingLocalApi: (): Promise<ZoteroPingResultDTO> =>
    ipcRenderer.invoke(IpcChannel.Zotero_PingLocalApi),

  /**
   * 拉取主进程 canonical bib 索引快照。
   * - 不传 `since` → 全量(BibResetDTO)
   * - 传 `since=lastEtag` → 增量 patch(BibPatchDTO);若 cursor 过期则回落为全量
   */
  getSnapshot: (req: GetSnapshotRequestDTO = {}): Promise<GetSnapshotResultDTO> =>
    ipcRenderer.invoke(IpcChannel.Zotero_GetSnapshot, req),

  /**
   * 触发一次刷新(focus/manual/error-recovery)。主进程内部做 cooldown 防抖。
   * 仅返回触发状态,实际变更通过 `Zotero_Event` 推送。
   */
  requestRefresh: (): Promise<RefreshResultDTO> =>
    ipcRenderer.invoke(IpcChannel.Zotero_RequestRefresh),

  /** 取诊断快照(状态/数据源健康/itemCount/etag/lastSyncedAt 等)。 */
  getDiagnostics: (): Promise<ZoteroDiagnosticsDTO> =>
    ipcRenderer.invoke(IpcChannel.Zotero_GetDiagnostics),

  /** 强制触发一次 `references.bib` 同步(穿透 enabled 网关与 debounce)。 */
  syncBibTex: (): Promise<BibTexSyncStatusDTO> => ipcRenderer.invoke(IpcChannel.Zotero_SyncBibTex),

  /** 读当前 BibTeX 同步状态(idle / syncing / ok / conflict / error)。 */
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
   * 订阅 Zotero 设置变更事件。
   * @returns 取消订阅函数。
   * @sideeffect 注册 IPC 监听,必须显式清理。
   */
  onSettingsChanged: createSafeListener<ZoteroSettingsDTO>(IpcChannel.Zotero_SettingsChanged),

  /**
   * 订阅主进程 bib 索引广播(initial/patch/status/invalidated 判别联合)。
   * Renderer 镜像层在此监听并维护本地 items + trigram。
   * @returns 取消订阅函数。
   */
  onEvent: createSafeListener<ZoteroEventDTO>(IpcChannel.Zotero_Event),
};
