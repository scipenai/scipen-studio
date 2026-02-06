/**
 * @file IPC Channel Definitions
 * @description Single source of truth for all IPC channels
 * @depends None (pure enum definitions)
 *
 * Naming convention: Domain_Action (e.g., File_Read, AI_Chat)
 */

export enum IpcChannel {
  // ====== Project Management ======
  Project_Open = 'open-project',
  Project_OpenByPath = 'open-project-by-path',
  Project_GetRecent = 'get-recent-projects',

  // ====== File Operations ======
  File_Read = 'read-file',
  File_ReadBinary = 'read-file-binary',
  File_Write = 'write-file',
  File_Create = 'create-file',
  File_Delete = 'delete-file',
  File_Trash = 'trash-file',
  File_Rename = 'rename-file',
  File_Copy = 'copy-file',
  File_Move = 'move-file',
  File_Exists = 'path-exists',
  File_Stats = 'get-file-stats',
  File_ShowInFolder = 'show-item-in-folder',
  File_OpenPath = 'open-path',
  File_Select = 'select-files',
  File_RefreshTree = 'refresh-file-tree',
  File_ResolveChildren = 'resolve-children',
  File_ScanPaths = 'scan-file-paths',
  Folder_Create = 'create-folder',
  Clipboard_GetFiles = 'get-clipboard-files',
  File_BatchRead = 'batch-read-files',
  File_BatchStat = 'batch-stat-files',
  File_BatchExists = 'batch-path-exists',
  File_BatchWrite = 'batch-write-files',
  File_BatchDelete = 'batch-delete-files',

  // ====== File Watcher ======
  FileWatcher_Start = 'file-watcher:start',
  FileWatcher_Stop = 'file-watcher:stop',
  FileWatcher_Changed = 'file-changed-externally',

  // ====== File Cache ======
  FileCache_Stats = 'file-cache:stats',
  FileCache_Clear = 'file-cache:clear',
  FileCache_Warmup = 'file-cache:warmup',
  FileCache_Invalidate = 'file-cache:invalidate',

  // ====== Compilation ======
  Compile_LaTeX = 'compile-latex',
  Compile_Typst = 'compile-typst',
  Compile_Cancel = 'compile-cancel',
  Compile_GetStatus = 'compile-get-status',
  Typst_Available = 'typst-available',
  SyncTeX_Forward = 'synctex-forward',
  SyncTeX_Backward = 'synctex-backward',

  // ====== LSP (Language Server Protocol) ======
  LSP_GetProcessInfo = 'lsp:get-process-info',
  LSP_IsAvailable = 'lsp:is-available',
  LSP_GetVersion = 'lsp:get-version',
  LSP_Start = 'lsp:start',
  LSP_Stop = 'lsp:stop',
  LSP_IsRunning = 'lsp:is-running',
  LSP_IsVirtualMode = 'lsp:is-virtual-mode',
  LSP_OpenDocument = 'lsp:open-document',
  LSP_UpdateDocument = 'lsp:update-document',
  LSP_UpdateDocumentIncremental = 'lsp:update-document-incremental',
  LSP_CloseDocument = 'lsp:close-document',
  LSP_SaveDocument = 'lsp:save-document',
  LSP_GetCompletions = 'lsp:get-completions',
  LSP_GetHover = 'lsp:get-hover',
  LSP_GetDefinition = 'lsp:get-definition',
  LSP_GetReferences = 'lsp:get-references',
  LSP_GetSymbols = 'lsp:get-document-symbols',
  LSP_Build = 'lsp:build',
  LSP_ForwardSearch = 'lsp:forward-search',
  LSP_Diagnostics = 'lsp:diagnostics',
  LSP_Initialized = 'lsp:initialized',
  LSP_Exit = 'lsp:exit',
  LSP_Error = 'lsp:error',
  LSP_ServiceStarted = 'lsp:service-started',
  LSP_ServiceStopped = 'lsp:service-stopped',
  LSP_ServiceRestarted = 'lsp:service-restarted',
  LSP_RequestDirectChannel = 'lsp:request-direct-channel',
  LSP_DirectChannel = 'lsp:direct-channel',
  LSP_DirectChannelClosed = 'lsp:direct-channel-closed',
  LSP_Recovered = 'lsp:recovered',
  LSP_IsTexLabAvailable = 'lsp:is-texlab-available',
  LSP_IsTinymistAvailable = 'lsp:is-tinymist-available',
  LSP_CheckAvailability = 'lsp:check-availability',
  LSP_GetTexLabVersion = 'lsp:get-texlab-version',
  LSP_GetTinymistVersion = 'lsp:get-tinymist-version',
  LSP_StartAll = 'lsp:start-all',
  LSP_StartTexLab = 'lsp:start-texlab',
  LSP_StartTinymist = 'lsp:start-tinymist',
  LSP_ExportTypstPdf = 'lsp:export-typst-pdf',
  LSP_FormatTypst = 'lsp:format-typst',

  // ====== AI Services ======
  AI_UpdateConfig = 'ai:update-config',
  AI_IsConfigured = 'ai:is-configured',
  AI_Completion = 'ai:completion',
  AI_Polish = 'ai:polish',
  AI_Chat = 'ai:chat',
  AI_ChatStream = 'ai:chat-stream',
  AI_StreamChunk = 'ai:stream-chunk',
  AI_GenerateFormula = 'ai:generate-formula',
  AI_Review = 'ai:review',
  AI_TestConnection = 'ai:test-connection',
  AI_StopGeneration = 'ai:stop-generation',
  AI_IsGenerating = 'ai:is-generating',
  AI_FetchModels = 'ai:fetch-models',

  // ====== Knowledge Base ======
  Knowledge_Initialize = 'knowledge:initialize',
  Knowledge_UpdateConfig = 'knowledge:update-config',
  Knowledge_CreateLibrary = 'knowledge:create-library',
  Knowledge_GetLibraries = 'knowledge:get-libraries',
  Knowledge_GetLibrary = 'knowledge:get-library',
  Knowledge_UpdateLibrary = 'knowledge:update-library',
  Knowledge_DeleteLibrary = 'knowledge:delete-library',
  Knowledge_AddDocument = 'knowledge:add-document',
  Knowledge_AddText = 'knowledge:add-text',
  Knowledge_GetDocument = 'knowledge:get-document',
  Knowledge_GetDocuments = 'knowledge:get-documents',
  Knowledge_DeleteDocument = 'knowledge:delete-document',
  Knowledge_ReprocessDocument = 'knowledge:reprocess-document',
  Knowledge_Search = 'knowledge:search',
  Knowledge_SearchEnhanced = 'knowledge:search-enhanced',
  Knowledge_Query = 'knowledge:query',
  Knowledge_GetTask = 'knowledge:get-task',
  Knowledge_GetQueueStats = 'knowledge:get-queue-stats',
  Knowledge_TestEmbedding = 'knowledge:test-embedding',
  Knowledge_Diagnostics = 'knowledge:diagnostics',
  Knowledge_RebuildFTS = 'knowledge:rebuild-fts',
  Knowledge_GenerateEmbeddings = 'knowledge:generate-embeddings',
  Knowledge_GetAdvancedConfig = 'knowledge:get-advanced-config',
  Knowledge_SetAdvancedConfig = 'knowledge:set-advanced-config',
  Knowledge_SelectFiles = 'knowledge:select-files',
  Knowledge_Event = 'knowledge:event',
  Knowledge_TaskProgress = 'knowledge:task-progress',

  // ====== Selection Assistant ======
  Selection_SetEnabled = 'selection:set-enabled',
  Selection_IsEnabled = 'selection:is-enabled',
  Selection_GetText = 'selection:get-text',
  Selection_ShowActionWindow = 'selection:show-action-window',
  Selection_HideActionWindow = 'selection:hide-action-window',
  Selection_HideToolbar = 'selection:hide-toolbar',
  Selection_AddToKnowledge = 'selection:add-to-knowledge',
  Selection_TextCaptured = 'selection:text-captured',
  Selection_GetConfig = 'selection:get-config',
  Selection_SetConfig = 'selection:set-config',

  // ====== Local Replica ======
  LocalReplica_Init = 'local-replica:init',
  LocalReplica_GetConfig = 'local-replica:get-config',
  LocalReplica_SetEnabled = 'local-replica:set-enabled',
  LocalReplica_SyncFromRemote = 'local-replica:sync-from-remote',
  LocalReplica_SyncToRemote = 'local-replica:sync-to-remote',
  LocalReplica_StartWatching = 'local-replica:start-watching',
  LocalReplica_StopWatching = 'local-replica:stop-watching',
  LocalReplica_IsWatching = 'local-replica:is-watching',
  LocalReplica_SyncProgress = 'local-replica:sync-progress',

  // ====== Overleaf Integration ======
  Overleaf_Init = 'overleaf:init',
  Overleaf_TestConnection = 'overleaf:test-connection',
  Overleaf_Login = 'overleaf:login',
  Overleaf_IsLoggedIn = 'overleaf:is-logged-in',
  Overleaf_GetCookies = 'overleaf:get-cookies',
  Overleaf_GetProjects = 'overleaf:get-projects',
  Overleaf_GetProjectDetails = 'overleaf:get-project-details',
  Overleaf_UpdateSettings = 'overleaf:update-settings',
  Overleaf_Compile = 'overleaf:compile',
  Overleaf_StopCompile = 'overleaf:stop-compile',
  Overleaf_GetBuildId = 'overleaf:get-build-id',
  Overleaf_SyncCode = 'overleaf:sync-code',
  Overleaf_SyncPdf = 'overleaf:sync-pdf',
  Overleaf_GetDoc = 'overleaf:get-doc',
  Overleaf_UpdateDoc = 'overleaf:update-doc',
  Overleaf_UpdateDocDebounced = 'overleaf:update-doc-debounced',
  Overleaf_FlushUpdates = 'overleaf:flush-updates',
  Overleaf_GetDocCached = 'overleaf:get-doc-cached',
  Overleaf_ClearCache = 'overleaf:clear-cache',

  // ====== Agent Tools ======
  Agent_GetAvailable = 'agent:get-available',
  Agent_PDF2LaTeX = 'agent:pdf2latex',
  Agent_Review = 'agent:review',
  Agent_Paper2Beamer = 'agent:paper2beamer',
  Agent_ListTemplates = 'agent:list-templates',
  Agent_Kill = 'agent:kill',
  Agent_SyncVLMConfig = 'agent:sync-vlm-config',
  Agent_CreateTempFile = 'agent:create-temp-file',
  Agent_Progress = 'agent:progress',

  // ====== Chat ======
  Chat_SendMessage = 'chat:send-message',
  Chat_Stream = 'chat:stream',
  Chat_Cancel = 'chat:cancel',
  Chat_GetSessions = 'chat:get-sessions',
  Chat_GetMessages = 'chat:get-messages',
  Chat_DeleteSession = 'chat:delete-session',
  Chat_RenameSession = 'chat:rename-session',
  Chat_CreateSession = 'chat:create-session',

  // ====== Window Management ======
  Window_New = 'new-window',
  Window_GetAll = 'get-windows',
  Window_Close = 'close-window',
  Window_Focus = 'focus-window',
  Window_OpenProject = 'open-project-path',
  Window_OpenFile = 'open-file',

  // ====== App Info ======
  App_GetVersion = 'get-app-version',
  App_GetHomeDir = 'get-home-dir',
  App_GetAppDataDir = 'get-app-data-dir',
  App_OpenExternal = 'open-external',

  // ====== Logging ======
  Log_GetPath = 'log:get-path',
  Log_OpenFolder = 'log:open-folder',
  Log_Write = 'log:write',
  Log_ExportDiagnostics = 'log:export-diagnostics',
  Log_Clear = 'log:clear',
  Log_FromRenderer = 'log:from-renderer',

  // ====== Config ======
  Config_Get = 'config:get',
  Config_Set = 'config:set',
  Config_Changed = 'config:changed',

  // ====== Settings (AI Providers) ======
  Settings_GetAIProviders = 'settings:get-ai-providers',
  Settings_SetAIProviders = 'settings:set-ai-providers',
  Settings_GetSelectedModels = 'settings:get-selected-models',
  Settings_SetSelectedModels = 'settings:set-selected-models',
  Settings_GetAIConfig = 'settings:get-ai-config',
  Settings_SetAIConfig = 'settings:set-ai-config',
  Settings_AIConfigChanged = 'settings:ai-config-changed',

  // ====== Trace ======
  Trace_Start = 'trace:start',
  Trace_End = 'trace:end',
  Trace_Get = 'trace:get',

  // ====== Messages ======
  Message_FromMain = 'main-process-message',

  // ====== Dialog ======
  Dialog_Confirm = 'dialog:confirm',
  Dialog_Message = 'dialog:message',
}

export type IpcChannelType = `${IpcChannel}`;
