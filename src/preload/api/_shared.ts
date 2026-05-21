/**
 * @file Preload Shared - Preload API Shared Utilities
 * @description IPC channel whitelist, path security validation, event listener factory
 * @depends electron.ipcRenderer
 */

import { ipcRenderer } from 'electron';
import { IpcChannel } from '../../../shared/ipc/channels';

// ====== Security: Allowed IPC Channels Whitelist ======
// Only channels in this set can be invoked via the low-level ipcRenderer.invoke API
// This prevents malicious code from calling arbitrary IPC handlers
//
// 🔒 Security Note:
// This whitelist is intentionally explicit. Only add channels that are:
// 1. Designed to be called from the renderer process
// 2. Have proper input validation in their handlers
// 3. Do not expose sensitive system operations without user interaction
//
// Channels NOT in this list cannot be invoked via the low-level API.
export const ALLOWED_INVOKE_CHANNELS: ReadonlySet<string> = new Set([
  // ====== Project Management ======
  IpcChannel.Project_Open,
  IpcChannel.Project_OpenByPath,
  IpcChannel.Project_GetRecent,

  // ====== File Operations (all have PathSecurityService checks) ======
  IpcChannel.File_Read,
  IpcChannel.File_ReadBinary,
  IpcChannel.File_Write,
  IpcChannel.File_Create,
  IpcChannel.File_Delete,
  IpcChannel.File_Trash,
  IpcChannel.File_Rename,
  IpcChannel.File_Copy,
  IpcChannel.File_Move,
  IpcChannel.File_Exists,
  IpcChannel.File_Stats,
  IpcChannel.File_ShowInFolder,
  IpcChannel.File_OpenPath,
  IpcChannel.File_Select,
  IpcChannel.File_RefreshTree,
  IpcChannel.File_ResolveChildren,
  IpcChannel.File_ScanPaths,
  IpcChannel.Folder_Create,
  IpcChannel.Clipboard_GetFiles,
  IpcChannel.File_BatchRead,
  IpcChannel.File_BatchStat,
  IpcChannel.File_BatchExists,
  IpcChannel.File_BatchWrite,
  IpcChannel.File_BatchDelete,

  // ====== File Watcher ======
  IpcChannel.FileWatcher_Start,
  IpcChannel.FileWatcher_Stop,

  // ====== File Cache ======
  // Note: FileCache channels are internal-only and not exposed to renderer

  // ====== Auto Update ======
  IpcChannel.App_CheckUpdate,
  IpcChannel.App_DownloadUpdate,
  IpcChannel.App_InstallUpdate,

  // ====== Compilation ======
  IpcChannel.Compile_LaTeX,
  IpcChannel.SyncTeX_Forward,
  IpcChannel.SyncTeX_Backward,
  IpcChannel.Compile_Typst,
  IpcChannel.Compile_Cancel,
  IpcChannel.Compile_GetStatus,
  IpcChannel.Typst_Available,

  // ====== LSP ======
  IpcChannel.LSP_GetProcessInfo,
  IpcChannel.LSP_IsAvailable,
  IpcChannel.LSP_GetVersion,
  IpcChannel.LSP_Start,
  IpcChannel.LSP_Stop,
  IpcChannel.LSP_IsRunning,
  IpcChannel.LSP_IsVirtualMode,
  IpcChannel.LSP_OpenDocument,
  IpcChannel.LSP_UpdateDocument,
  IpcChannel.LSP_UpdateDocumentIncremental,
  IpcChannel.LSP_CloseDocument,
  IpcChannel.LSP_SaveDocument,
  IpcChannel.LSP_GetCompletions,
  IpcChannel.LSP_GetHover,
  IpcChannel.LSP_GetDefinition,
  IpcChannel.LSP_GetReferences,
  IpcChannel.LSP_GetSymbols,
  IpcChannel.LSP_GetSemanticTokens,
  IpcChannel.LSP_Build,
  IpcChannel.LSP_ForwardSearch,
  IpcChannel.LSP_RequestDirectChannel,
  IpcChannel.LSP_IsTexLabAvailable,
  IpcChannel.LSP_IsTinymistAvailable,
  IpcChannel.LSP_IsMarksmanAvailable,
  IpcChannel.LSP_CheckAvailability,
  IpcChannel.LSP_GetTexLabVersion,
  IpcChannel.LSP_GetTinymistVersion,
  IpcChannel.LSP_GetMarksmanVersion,
  IpcChannel.LSP_StartAll,
  IpcChannel.LSP_StartTexLab,
  IpcChannel.LSP_StartTinymist,
  IpcChannel.LSP_StartMarksman,
  IpcChannel.LSP_ExportTypstPdf,
  IpcChannel.LSP_FormatTypst,

  // ====== AI Services ======
  IpcChannel.AI_UpdateConfig,
  IpcChannel.AI_IsConfigured,
  IpcChannel.AI_Completion,
  IpcChannel.AI_ChatStream,
  IpcChannel.AI_TestConnection,
  IpcChannel.AI_StopGeneration,
  IpcChannel.AI_IsGenerating,
  IpcChannel.AI_FetchModels,
  IpcChannel.AI_InlineEditStart,
  IpcChannel.AI_InlineEditCancel,

  // ====== Collaboration Owner (last-active backend marker) ======
  IpcChannel.CollaborationOwner_SetActive,
  IpcChannel.CollaborationOwner_Clear,

  // ====== Selection Assistant ======
  IpcChannel.Selection_SetEnabled,
  IpcChannel.Selection_IsEnabled,
  IpcChannel.Selection_GetText,

  IpcChannel.Selection_GetConfig,
  IpcChannel.Selection_SetConfig,

  // ====== Overleaf Integration ======
  IpcChannel.OverleafAuth_Init,
  IpcChannel.OverleafAuth_TestConnection,
  IpcChannel.OverleafAuth_Login,
  IpcChannel.OverleafAuth_IsLoggedIn,
  IpcChannel.OverleafAuth_GetCookies,
  IpcChannel.OverleafProject_GetProjects,
  IpcChannel.OverleafProject_GetDetails,
  IpcChannel.OverleafProject_Download,
  IpcChannel.OverleafProject_FindLocalPath,
  IpcChannel.OverleafProject_GetMeta,
  IpcChannel.OverleafProject_SyncFile,
  IpcChannel.OverleafProject_SyncProject,
  IpcChannel.OverleafProject_CreateAndSync,
  IpcChannel.OverleafProject_SyncFileByPath,
  IpcChannel.OverleafLive_Configure,
  IpcChannel.OverleafLive_Disconnect,
  IpcChannel.OverleafLive_GetState,
  IpcChannel.OverleafLive_JoinDoc,
  IpcChannel.OverleafLive_SubmitPatches,
  IpcChannel.OverleafLive_CreateEntity,
  IpcChannel.OverleafLive_RenameEntity,
  IpcChannel.OverleafLive_MoveEntity,
  IpcChannel.OverleafLive_DeleteEntity,
  IpcChannel.OverleafLive_UploadFile,

  // ====== Agent (SNACA sidecar bridge) ======
  IpcChannel.Agent_GetSidecarState,
  IpcChannel.Agent_GetSessionState,
  IpcChannel.Agent_StartProject,
  IpcChannel.Agent_NewThread,
  IpcChannel.Agent_SwitchThread,
  IpcChannel.Agent_ListThreads,
  IpcChannel.Agent_DeleteThread,
  IpcChannel.Agent_RenameThread,
  IpcChannel.Agent_GetMessages,
  IpcChannel.Agent_SendChat,
  IpcChannel.Agent_StartComposer,
  IpcChannel.Agent_ConfirmPlan,
  IpcChannel.Agent_CancelTurn,
  IpcChannel.Agent_ConfirmEdit,
  IpcChannel.Agent_ConfirmTool,
  IpcChannel.Agent_MemoryList,
  IpcChannel.Agent_MemoryGet,
  IpcChannel.Agent_MemoryWrite,
  IpcChannel.Agent_MemoryDelete,
  IpcChannel.Agent_MemoryReveal,
  IpcChannel.Agent_SkillsList,
  IpcChannel.Agent_SkillsGet,
  IpcChannel.Agent_SkillsReload,
  IpcChannel.Agent_OpenMemoryViewer,
  IpcChannel.Agent_ResolveEditProposal,
  IpcChannel.Agent_ContextFlushResponse,
  IpcChannel.Agent_ContextZoteroResponse,

  // ====== Zotero Integration ======
  IpcChannel.Zotero_GetSettings,
  IpcChannel.Zotero_SetSettings,
  IpcChannel.Zotero_SetMinerUApiKey,
  IpcChannel.Zotero_ClearMinerUApiKey,
  IpcChannel.Zotero_SetEmbeddingApiKey,
  IpcChannel.Zotero_ClearEmbeddingApiKey,
  IpcChannel.Zotero_DetectInstallation,
  IpcChannel.Zotero_PingLocalApi,

  // ====== Chat ======

  // ====== Window/Dialog ======
  IpcChannel.Window_New,
  IpcChannel.Window_GetAll,
  IpcChannel.Window_Close,
  IpcChannel.Window_Focus,
  IpcChannel.Dialog_Confirm,
  IpcChannel.Dialog_Message,

  // ====== App/System ======
  IpcChannel.App_OpenExternal,
  IpcChannel.App_GetVersion,
  IpcChannel.App_GetHomeDir,
  IpcChannel.App_GetAppDataDir,

  // ====== Log/Config/Trace ======
  IpcChannel.Log_GetPath,
  IpcChannel.Log_OpenFolder,
  IpcChannel.Log_Write,
  IpcChannel.Log_ExportDiagnostics,
  IpcChannel.Log_Clear,
  IpcChannel.Log_FromRenderer,
  IpcChannel.Config_Get,
  IpcChannel.Config_Set,
  IpcChannel.Trace_Start,
  IpcChannel.Trace_End,
  IpcChannel.Trace_Get,

  // ====== Settings ======
  IpcChannel.Settings_GetAIProviders,
  IpcChannel.Settings_SetAIProviders,
  IpcChannel.Settings_GetSelectedModels,
  IpcChannel.Settings_SetSelectedModels,
  IpcChannel.Settings_GetAIConfig,
  IpcChannel.Settings_SetAIConfig,
]);

// ====== Security: Allowed Event Channels Whitelist ======
// Only channels in this set can be listened to via the low-level ipcRenderer.on API
export const ALLOWED_EVENT_CHANNELS: ReadonlySet<string> = new Set([
  IpcChannel.Window_OpenProject,
  IpcChannel.Window_OpenFile,

  // ====== Agent streaming events ======
  IpcChannel.Agent_SidecarStateChanged,
  IpcChannel.Agent_TurnDelta,
  IpcChannel.Agent_EditPropose,
  IpcChannel.Agent_EditProposeDelta,
  IpcChannel.Agent_EditProposeComplete,
  IpcChannel.Agent_PlanUpdate,
  IpcChannel.Agent_ToolApprovalRequest,
  IpcChannel.Agent_UsageUpdate,
  IpcChannel.Agent_MemoryUpdated,
  IpcChannel.Agent_Error,
  IpcChannel.Agent_Log,
  IpcChannel.Agent_EditApplied,
  IpcChannel.Agent_ContextFlushRequest,
  IpcChannel.Agent_ContextZoteroRequest,
  IpcChannel.Zotero_SettingsChanged,

  IpcChannel.App_UpdateStatus,
  IpcChannel.AI_StreamChunk,
  IpcChannel.AI_InlineEditDelta,
  IpcChannel.AI_InlineEditComplete,
  IpcChannel.AI_InlineEditError,
  IpcChannel.Message_FromMain,
  IpcChannel.FileWatcher_Changed,
  IpcChannel.LSP_Diagnostics,
  IpcChannel.LSP_Initialized,
  IpcChannel.LSP_Exit,
  IpcChannel.LSP_Error,
  IpcChannel.LSP_ServiceStarted,
  IpcChannel.LSP_ServiceStopped,
  IpcChannel.LSP_ServiceRestarted,
  IpcChannel.LSP_DirectChannel,
  IpcChannel.LSP_DirectChannelClosed,
  IpcChannel.LSP_Recovered,
  IpcChannel.Settings_AIConfigChanged,
  IpcChannel.OverleafLive_ConnectionChanged,
  IpcChannel.OverleafLive_StateChanged,
  IpcChannel.OverleafLive_RemotePatch,
  IpcChannel.OverleafLive_TreeChanged,
  IpcChannel.OverleafLive_Error,
  // Config
  IpcChannel.Config_Changed,
  // Selection Assistant
  IpcChannel.Selection_TextCaptured,
]);

// ====== Security: Path Validation ======
// Sensitive system directories that should not be accessed via getLocalFileUrl
const SENSITIVE_PATH_PATTERNS = [
  /^\/?etc\//i,
  /^\/?proc\//i,
  /^\/?sys\//i,
  /^\/?(windows|winnt)\//i,
  /^[a-z]:[\\/](windows|winnt|program files|programdata|users[\\/][^\\/]+[\\/](appdata|ntuser))/i,
  /\.\.[/\\]/, // Path traversal
];

/**
 * Validates that a file path is safe to access
 * @param filePath The file path to validate
 * @returns true if the path is safe, false otherwise
 */
export function isPathSafe(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  return !SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

// ====== Utility: Safe Event Listener Factory ======
/**
 * Creates a safe event listener that returns a proper cleanup function.
 * Unlike removeAllListeners, this only removes the specific listener,
 * preventing interference with other listeners on the same channel.
 *
 * @param channel The IPC channel to listen on
 * @returns A function that creates event subscriptions with proper cleanup
 * @sideeffect Registers an IPC event listener that must be cleaned up
 */
export function createSafeListener<T>(channel: IpcChannel) {
  return (callback: (data: T) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: T) => callback(data);
    ipcRenderer.on(channel, handler);
    // Return a cleanup function that removes only this specific handler
    return () => ipcRenderer.removeListener(channel, handler);
  };
}

/**
 * Creates a safe event listener for events without data payload
 */
export function createSafeVoidListener(channel: IpcChannel) {
  return (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
}
