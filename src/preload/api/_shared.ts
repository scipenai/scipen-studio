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
  IpcChannel.LSP_Build,
  IpcChannel.LSP_ForwardSearch,
  IpcChannel.LSP_RequestDirectChannel,
  IpcChannel.LSP_IsTexLabAvailable,
  IpcChannel.LSP_IsTinymistAvailable,
  IpcChannel.LSP_CheckAvailability,
  IpcChannel.LSP_GetTexLabVersion,
  IpcChannel.LSP_GetTinymistVersion,
  IpcChannel.LSP_StartAll,
  IpcChannel.LSP_StartTexLab,
  IpcChannel.LSP_StartTinymist,
  IpcChannel.LSP_ExportTypstPdf,
  IpcChannel.LSP_FormatTypst,

  // ====== AI Services ======
  IpcChannel.AI_UpdateConfig,
  IpcChannel.AI_IsConfigured,
  IpcChannel.AI_Completion,
  IpcChannel.AI_Polish,
  IpcChannel.AI_Chat,
  IpcChannel.AI_ChatStream,
  IpcChannel.AI_GenerateFormula,
  IpcChannel.AI_Review,
  IpcChannel.AI_TestConnection,
  IpcChannel.AI_StopGeneration,
  IpcChannel.AI_IsGenerating,
  IpcChannel.AI_FetchModels,

  // ====== Knowledge Base ======
  IpcChannel.Knowledge_Initialize,
  IpcChannel.Knowledge_UpdateConfig,
  IpcChannel.Knowledge_CreateLibrary,
  IpcChannel.Knowledge_GetLibraries,
  IpcChannel.Knowledge_GetLibrary,
  IpcChannel.Knowledge_UpdateLibrary,
  IpcChannel.Knowledge_DeleteLibrary,
  IpcChannel.Knowledge_AddDocument,
  IpcChannel.Knowledge_AddText,
  IpcChannel.Knowledge_GetDocument,
  IpcChannel.Knowledge_GetDocuments,
  IpcChannel.Knowledge_DeleteDocument,
  IpcChannel.Knowledge_ReprocessDocument,
  IpcChannel.Knowledge_Search,
  IpcChannel.Knowledge_SearchEnhanced,
  IpcChannel.Knowledge_Query,
  IpcChannel.Knowledge_GetTask,
  IpcChannel.Knowledge_GetQueueStats,
  IpcChannel.Knowledge_TestEmbedding,
  IpcChannel.Knowledge_Diagnostics,
  IpcChannel.Knowledge_RebuildFTS,
  IpcChannel.Knowledge_GenerateEmbeddings,
  IpcChannel.Knowledge_GetAdvancedConfig,
  IpcChannel.Knowledge_SetAdvancedConfig,
  IpcChannel.Knowledge_SelectFiles,

  // ====== Selection Assistant ======
  IpcChannel.Selection_SetEnabled,
  IpcChannel.Selection_IsEnabled,
  IpcChannel.Selection_GetText,
  IpcChannel.Selection_ShowActionWindow,
  IpcChannel.Selection_HideActionWindow,
  IpcChannel.Selection_HideToolbar,
  IpcChannel.Selection_AddToKnowledge,
  IpcChannel.Selection_GetConfig,
  IpcChannel.Selection_SetConfig,

  // ====== Overleaf Integration ======
  IpcChannel.Overleaf_Init,
  IpcChannel.Overleaf_TestConnection,
  IpcChannel.Overleaf_Login,
  IpcChannel.Overleaf_IsLoggedIn,
  IpcChannel.Overleaf_GetCookies,
  IpcChannel.Overleaf_GetProjects,
  IpcChannel.Overleaf_GetProjectDetails,
  IpcChannel.Overleaf_UpdateSettings,
  IpcChannel.Overleaf_Compile,
  IpcChannel.Overleaf_StopCompile,
  IpcChannel.Overleaf_GetBuildId,
  IpcChannel.Overleaf_SyncCode,
  IpcChannel.Overleaf_SyncPdf,
  IpcChannel.Overleaf_GetDoc,
  IpcChannel.Overleaf_UpdateDoc,
  IpcChannel.Overleaf_UpdateDocDebounced,
  IpcChannel.Overleaf_FlushUpdates,
  IpcChannel.Overleaf_GetDocCached,
  IpcChannel.Overleaf_ClearCache,

  // ====== Local Replica ======
  IpcChannel.LocalReplica_Init,
  IpcChannel.LocalReplica_GetConfig,
  IpcChannel.LocalReplica_SetEnabled,
  IpcChannel.LocalReplica_SyncFromRemote,
  IpcChannel.LocalReplica_SyncToRemote,
  IpcChannel.LocalReplica_StartWatching,
  IpcChannel.LocalReplica_StopWatching,
  IpcChannel.LocalReplica_IsWatching,

  // ====== Agent Tools ======
  IpcChannel.Agent_GetAvailable,
  IpcChannel.Agent_PDF2LaTeX,
  IpcChannel.Agent_Review,
  IpcChannel.Agent_Paper2Beamer,
  IpcChannel.Agent_ListTemplates,
  IpcChannel.Agent_Kill,
  IpcChannel.Agent_SyncVLMConfig,
  IpcChannel.Agent_CreateTempFile,

  // ====== Chat ======
  IpcChannel.Chat_SendMessage,
  IpcChannel.Chat_Cancel,
  IpcChannel.Chat_GetSessions,
  IpcChannel.Chat_GetMessages,
  IpcChannel.Chat_DeleteSession,
  IpcChannel.Chat_RenameSession,
  IpcChannel.Chat_CreateSession,

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
  IpcChannel.Chat_Stream,
  IpcChannel.Agent_Progress,
  IpcChannel.Knowledge_Event,
  IpcChannel.Knowledge_TaskProgress,
  IpcChannel.AI_StreamChunk,
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
  // Config
  IpcChannel.Config_Changed,
  // Selection Assistant
  IpcChannel.Selection_TextCaptured,
  // Local Replica
  IpcChannel.LocalReplica_SyncProgress,
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
