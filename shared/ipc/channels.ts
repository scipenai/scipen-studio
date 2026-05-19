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
  LSP_GetSemanticTokens = 'lsp:get-semantic-tokens',
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
  LSP_IsMarksmanAvailable = 'lsp:is-marksman-available',
  LSP_CheckAvailability = 'lsp:check-availability',
  LSP_GetTexLabVersion = 'lsp:get-texlab-version',
  LSP_GetTinymistVersion = 'lsp:get-tinymist-version',
  LSP_GetMarksmanVersion = 'lsp:get-marksman-version',
  LSP_StartAll = 'lsp:start-all',
  LSP_StartTexLab = 'lsp:start-texlab',
  LSP_StartTinymist = 'lsp:start-tinymist',
  LSP_StartMarksman = 'lsp:start-marksman',
  LSP_ExportTypstPdf = 'lsp:export-typst-pdf',
  LSP_FormatTypst = 'lsp:format-typst',

  // ====== AI Services ======
  AI_UpdateConfig = 'ai:update-config',
  AI_IsConfigured = 'ai:is-configured',
  AI_Completion = 'ai:completion',
  AI_ChatStream = 'ai:chat-stream',
  AI_StreamChunk = 'ai:stream-chunk',
  AI_TestConnection = 'ai:test-connection',
  AI_StopGeneration = 'ai:stop-generation',
  AI_IsGenerating = 'ai:is-generating',
  AI_FetchModels = 'ai:fetch-models',
  /**
   * Ctrl+K inline edit — start a streaming single-shot replacement.
   * Renderer → main invoke; returns `{ turnId }`. Deltas / completion /
   * errors flow back as `AI_InlineEdit{Delta,Complete,Error}` events.
   */
  AI_InlineEditStart = 'ai:inline-edit-start',
  /** Renderer → main: abort a turn started via `AI_InlineEditStart`. */
  AI_InlineEditCancel = 'ai:inline-edit-cancel',
  /** Streaming chunk for an inline edit turn. */
  AI_InlineEditDelta = 'ai:inline-edit-delta',
  /** Inline edit turn completed cleanly. Payload carries the sanitised full text. */
  AI_InlineEditComplete = 'ai:inline-edit-complete',
  /** Inline edit turn failed or was aborted. */
  AI_InlineEditError = 'ai:inline-edit-error',

  // ====== Selection Assistant ======
  Selection_SetEnabled = 'selection:set-enabled',
  Selection_IsEnabled = 'selection:is-enabled',
  Selection_GetText = 'selection:get-text',
  Selection_TextCaptured = 'selection:text-captured',
  Selection_GetConfig = 'selection:get-config',
  Selection_SetConfig = 'selection:set-config',

  // ====== Overleaf Auth ======
  OverleafAuth_Init = 'overleaf-auth:init',
  OverleafAuth_TestConnection = 'overleaf-auth:test-connection',
  OverleafAuth_Login = 'overleaf-auth:login',
  OverleafAuth_IsLoggedIn = 'overleaf-auth:is-logged-in',
  OverleafAuth_GetCookies = 'overleaf-auth:get-cookies',

  // ====== Overleaf Project ======
  OverleafProject_GetProjects = 'overleaf-project:get-projects',
  OverleafProject_GetDetails = 'overleaf-project:get-details',
  /** Download an Overleaf project to the local disk. */
  OverleafProject_Download = 'overleaf-project:download',
  /** Look up the local path of an already-downloaded project. */
  OverleafProject_FindLocalPath = 'overleaf-project:find-local-path',
  /** Read metadata for a downloaded project. */
  OverleafProject_GetMeta = 'overleaf-project:get-meta',
  /** Update the docIdMap metadata for a downloaded project. */
  OverleafProject_UpdateDocIdMap = 'overleaf-project:update-doc-id-map',
  /** Sync a single file to Overleaf. */
  OverleafProject_SyncFile = 'overleaf-project:sync-file',
  /** Sync the entire project to Overleaf. */
  OverleafProject_SyncProject = 'overleaf-project:sync-project',
  /** Create a new document on Overleaf and sync it. */
  OverleafProject_CreateAndSync = 'overleaf-project:create-and-sync',
  /** Sync a file by relative path, auto-resolving/creating the docId. */
  OverleafProject_SyncFileByPath = 'overleaf-project:sync-file-by-path',

  // ====== Overleaf Live Collaboration ======
  OverleafLive_Configure = 'overleaf-live:configure',
  OverleafLive_Disconnect = 'overleaf-live:disconnect',
  OverleafLive_GetState = 'overleaf-live:get-state',
  OverleafLive_JoinDoc = 'overleaf-live:join-doc',
  OverleafLive_SubmitPatches = 'overleaf-live:submit-patches',
  OverleafLive_CreateEntity = 'overleaf-live:create-entity',
  OverleafLive_RenameEntity = 'overleaf-live:rename-entity',
  OverleafLive_MoveEntity = 'overleaf-live:move-entity',
  OverleafLive_DeleteEntity = 'overleaf-live:delete-entity',
  OverleafLive_UploadFile = 'overleaf-live:upload-file',
  OverleafLive_ConnectionChanged = 'overleaf-live:connection-changed',
  OverleafLive_StateChanged = 'overleaf-live:state-changed',
  OverleafLive_RemotePatch = 'overleaf-live:remote-patch',
  OverleafLive_TreeChanged = 'overleaf-live:tree-changed',
  OverleafLive_Error = 'overleaf-live:error',

  // ====== Studio IM ====== (removed in P3 cleanup)

  // ====== Collaboration Owner ======
  CollaborationOwner_SetActive = 'collaboration-owner:set-active',
  CollaborationOwner_Clear = 'collaboration-owner:clear',

  // ====== Studio OT ====== (removed in P3 cleanup)

  // ====== Project Binding (Cloud Collaboration) ====== (removed in P3 cleanup)

  // ====== Project Conversation Scope ====== (removed in P3 cleanup)

  // ====== Agent (SNACA editor-protocol bridge) ======
  Agent_GetSidecarState = 'agent:get-sidecar-state',
  Agent_GetSessionState = 'agent:get-session-state',
  Agent_StartProject = 'agent:start-project',
  Agent_NewThread = 'agent:new-thread',
  Agent_SwitchThread = 'agent:switch-thread',
  Agent_ListThreads = 'agent:list-threads',
  Agent_DeleteThread = 'agent:delete-thread',
  Agent_RenameThread = 'agent:rename-thread',
  Agent_GetMessages = 'agent:get-messages',
  Agent_SendChat = 'agent:send-chat',
  Agent_StartComposer = 'agent:start-composer',
  Agent_ConfirmPlan = 'agent:confirm-plan',
  Agent_CancelTurn = 'agent:cancel-turn',
  Agent_ConfirmEdit = 'agent:confirm-edit',
  Agent_ConfirmTool = 'agent:confirm-tool',
  // Memory viewer
  Agent_MemoryList = 'agent:memory-list',
  Agent_MemoryGet = 'agent:memory-get',
  Agent_MemoryWrite = 'agent:memory-write',
  Agent_MemoryDelete = 'agent:memory-delete',
  Agent_MemoryReveal = 'agent:memory-reveal',
  // Skills viewer
  Agent_SkillsList = 'agent:skills-list',
  Agent_SkillsGet = 'agent:skills-get',
  Agent_SkillsReload = 'agent:skills-reload',
  // Memory / skills viewer secondary window
  Agent_OpenMemoryViewer = 'agent:open-memory-viewer',
  /**
   * Renderer-decided resolution of an `edit.propose` event. Main reads the
   * file, validates `base_hash`, applies the (possibly partial) hunks, and
   * forwards `editConfirm` to SNACA. Differs from `Agent_ConfirmEdit` which
   * is a thin passthrough — this one is the host-applies workflow.
   */
  Agent_ResolveEditProposal = 'agent:resolve-edit-proposal',
  /**
   * Renderer's reply to a `Agent_ContextFlushRequest` event (invoke).
   * Carries `{ requestId, flushedFiles }` so the main-side
   * `ContextRequestService` can resolve the pending reverse-RPC promise that
   * blocks SNACA's `context.request { kind: 'flush_unsaved' }`.
   */
  Agent_ContextFlushResponse = 'agent:context-flush-response',
  /** Streaming events pushed from main to renderer. */
  Agent_SidecarStateChanged = 'agent:sidecar-state-changed',
  Agent_TurnDelta = 'agent:turn-delta',
  Agent_EditPropose = 'agent:edit-propose',
  Agent_EditProposeDelta = 'agent:edit-propose-delta',
  Agent_EditProposeComplete = 'agent:edit-propose-complete',
  Agent_PlanUpdate = 'agent:plan-update',
  Agent_ToolApprovalRequest = 'agent:tool-approval-request',
  Agent_UsageUpdate = 'agent:usage-update',
  Agent_MemoryUpdated = 'agent:memory-updated',
  Agent_Error = 'agent:error',
  Agent_Log = 'agent:log',
  /**
   * Fires after host_applies-mode `Agent_ResolveEditProposal` succeeds with
   * `accept`. Payload carries the post-edit `{ file, content, applied_hash }`
   * so the renderer can sync the Monaco model + EditorService state without
   * round-tripping through fs watcher.
   */
  Agent_EditApplied = 'agent:edit-applied',
  /**
   * Reverse-RPC from main to renderer: SNACA asked for fresh context (e.g.
   * `flush_unsaved` before a `Read` tool call). Renderer must do the work
   * (save dirty tabs) and reply via `Agent_ContextFlushResponse`. If the
   * renderer fails to respond within the timeout, main auto-replies
   * `{ ok: false }` to SNACA so the LLM doesn't hang.
   */
  Agent_ContextFlushRequest = 'agent:context-flush-request',

  // ====== Chat ======

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

  // ====== Auto Update ======
  App_CheckUpdate = 'app:check-update',
  App_DownloadUpdate = 'app:download-update',
  App_InstallUpdate = 'app:install-update',
  App_UpdateStatus = 'app:update-status',

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
