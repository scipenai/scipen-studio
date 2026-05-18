/**
 * IPC Channel Validation Schemas
 *
 * Pure data declaration file: Zod validation schemas for every IPC channel.
 * Framework code (registerTypedHandler, etc.) lives in typedIpc.ts.
 */

import { z } from 'zod';
import { IpcChannel } from '../../../shared/ipc/channels';

// ==================== Schema Helpers ====================

/**
 * Path validation helper - checks for path traversal and sensitive paths
 *
 * Security policy:
 * 1. Prohibit path traversal attacks (..)
 * 2. Prohibit access to system sensitive directories (/etc, /proc, Windows, Program Files, etc.)
 * 3. Prohibit access to user AppData directory (protect privacy data)
 * 4. Exception: Allow access to application's own data directory (scipen-studio)
 */
const safePathSchema = z.string().refine(
  (pathStr) => {
    const normalized = pathStr.replace(/\\/g, '/').toLowerCase();

    // ========== 1. Prohibit path traversal ==========
    if (/\.\.[/\\]/.test(normalized)) {
      return false;
    }

    // ========== 2. Whitelist: Application's own data directory ==========
    // Path format: C:/Users/xxx/AppData/Roaming/scipen-studio/...
    //              C:/Users/xxx/AppData/Local/scipen-studio/...
    //              C:/Users/xxx/AppData/Local/Temp/scipen-... (temporary files)
    const appDataWhitelist =
      /^[a-z]:\/users\/[^/]+\/appdata\/(roaming|local)\/(scipen-studio|temp\/scipen)/i;
    if (appDataWhitelist.test(normalized)) {
      return true; // Allow access to application's own data directory
    }

    // ========== 3. Sensitive path blocking ==========
    const sensitivePatterns = [
      /^\/?etc\//i,
      /^\/?proc\//i,
      /^\/?sys\//i,
      /^\/?(windows|winnt)\//i,
      /^[a-z]:[\\/](windows|winnt|program files|programdata|users[\\/][^\\/]+[\\/](appdata|ntuser))/i,
    ];

    return !sensitivePatterns.some((pattern) => pattern.test(normalized));
  },
  { message: 'Path contains potentially dangerous patterns' }
);

/**
 * 🔒 Safe string schema with size limit (default 1MB)
 * Prevents memory exhaustion attacks
 */
const safeStringSchema = (maxLength: number = 1024 * 1024) =>
  z.string().max(maxLength, { message: `String exceeds maximum length of ${maxLength}` });

const otProjectFileContentSchema = safeStringSchema(8 * 1024 * 1024);

/**
 * 🔒 Safe ID schema (for database IDs, project IDs, etc.)
 */
const safeIdSchema = z
  .string()
  .min(1, { message: 'ID cannot be empty' })
  .max(256, { message: 'ID too long' })
  .regex(/^[a-zA-Z0-9_-]+$/, { message: 'ID contains invalid characters' });

const imCollaborationContextSchema = z.object({
  provider: z.enum(['im-local', 'scipen-ot', 'overleaf']).optional(),
  mode: z.enum(['im-local', 'ot-project']).optional(),
  project_id: safeIdSchema.optional(),
  doc_id: safeIdSchema.optional(),
  file_id: safeIdSchema.optional(),
  file_path: safeStringSchema(4000).nullish(),
  root_path: safeStringSchema(4000).nullish(),
  project_name: safeStringSchema(500).nullish(),
  workspace_id: z.string().max(100).nullish(),
  scope_type: z.enum(['global', 'project']).nullish(),
  can_collaborate: z.boolean().nullish(),
  capabilities: z
    .object({
      propose_edit: z.boolean(),
      collaborative_tree: z.boolean(),
      collaborative_read: z.boolean(),
      collaborative_edit: z.boolean(),
    })
    .optional(),
  file_tree: z.array(z.string().max(1000)).max(2000).optional(),
  active_file_content: z.string().max(50000).optional(),
});
const imMessageMetadataSchema = z.object({
  collaboration: imCollaborationContextSchema.nullish(),
  streaming: z.boolean().optional(),
  proposals: z
    .array(
      z.object({
        file_path: z.string().max(4000),
        old_string: z.string().max(200000),
        new_string: z.string().max(200000),
        description: z.string().max(2000).optional(),
      })
    )
    .max(200)
    .optional(),
});

/**
 * 🔒 Safe URL schema (for server URLs)
 */
const safeUrlSchema = z
  .string()
  .url({ message: 'Invalid URL format' })
  .refine(
    (url) => {
      try {
        const parsed = new URL(url);
        return ['http:', 'https:'].includes(parsed.protocol);
      } catch {
        return false;
      }
    },
    { message: 'URL must use http or https protocol' }
  );

const projectConversationScopeSchema = z.enum(['global', 'project']);
const collaborationBackendSchema = z.enum(['scipen-ot', 'overleaf']);
const imConfigForProjectConversationSchema = z.object({
  baseUrl: safeUrlSchema,
  token: z.string().max(512),
});

// ==================== Channel Schema Registry ====================

/**
 * Registry of validation schemas for IPC channels
 * Channels not in this registry will skip runtime validation
 *
 * 🔒 Security: All user-input channels should have schemas
 *
 * @example
 * To add a new validated channel:
 * channelSchemas.set(IpcChannel.Some_Channel, z.tuple([z.string(), z.number()]));
 */
export const channelSchemas = new Map<string, z.ZodSchema>([
  // ==================== File Operations ====================
  [IpcChannel.File_Read, z.tuple([safePathSchema])],
  [IpcChannel.File_ReadBinary, z.tuple([safePathSchema])],
  [IpcChannel.File_Write, z.tuple([safePathSchema, safeStringSchema(), z.number().optional()])],
  [IpcChannel.File_Create, z.tuple([safePathSchema, safeStringSchema().optional()])],
  [IpcChannel.File_Delete, z.tuple([safePathSchema, z.string().optional(), z.string().optional()])],
  [
    IpcChannel.File_Rename,
    z.tuple([safePathSchema, safePathSchema, z.string().optional(), z.string().optional()]),
  ],
  [IpcChannel.File_Copy, z.tuple([safePathSchema, safePathSchema])],
  [IpcChannel.File_Move, z.tuple([safePathSchema, safePathSchema])],
  [IpcChannel.File_Exists, z.tuple([safePathSchema])],
  [IpcChannel.File_Stats, z.tuple([safePathSchema])],
  [IpcChannel.File_ShowInFolder, z.tuple([safePathSchema])],
  [IpcChannel.Folder_Create, z.tuple([safePathSchema])],
  // 🔒 P1 fix: Supplement missing File/Project schemas
  [IpcChannel.File_Trash, z.tuple([safePathSchema])],
  [IpcChannel.File_OpenPath, z.tuple([safePathSchema])],
  [IpcChannel.File_RefreshTree, z.tuple([safePathSchema])],
  [IpcChannel.File_ResolveChildren, z.tuple([safePathSchema])], // Lazy load: resolve directory children
  [IpcChannel.File_ScanPaths, z.tuple([safePathSchema])], // Scan file paths (@ completion index)
  [IpcChannel.Project_Open, z.tuple([])], // No parameters, use dialog to select
  [IpcChannel.Project_OpenByPath, z.tuple([safePathSchema])],
  [IpcChannel.Project_GetRecent, z.tuple([])], // No parameters

  // 🔒 P1 fix: Supplement FileWatcher/FileCache schemas
  [IpcChannel.FileWatcher_Start, z.tuple([safePathSchema])],
  [IpcChannel.FileWatcher_Stop, z.tuple([])],
  [IpcChannel.FileCache_Stats, z.tuple([])],
  [IpcChannel.FileCache_Clear, z.tuple([])],
  [IpcChannel.FileCache_Warmup, z.tuple([z.array(safePathSchema).max(100)])],
  [IpcChannel.FileCache_Invalidate, z.tuple([safePathSchema])],

  // Batch file operations
  [IpcChannel.File_BatchRead, z.tuple([z.array(safePathSchema).max(100)])],
  [IpcChannel.File_BatchStat, z.tuple([z.array(safePathSchema).max(100)])],
  [IpcChannel.File_BatchExists, z.tuple([z.array(safePathSchema).max(100)])],
  [
    IpcChannel.File_BatchWrite,
    z.tuple([
      z
        .array(
          z.object({
            path: safePathSchema,
            content: safeStringSchema(),
          })
        )
        .max(50),
    ]),
  ],
  [IpcChannel.File_BatchDelete, z.tuple([z.array(safePathSchema).max(100)])],

  // ==================== LSP Operations ====================
  [
    IpcChannel.LSP_Start,
    z.tuple([safePathSchema, z.object({ virtual: z.boolean().optional() }).optional()]),
  ],
  [
    IpcChannel.LSP_OpenDocument,
    z.tuple([safePathSchema, safeStringSchema(), z.string().optional()]),
  ],
  [IpcChannel.LSP_UpdateDocument, z.tuple([safePathSchema, safeStringSchema()])],
  // 🔒 P1 fix: Supplement LSP_UpdateDocumentIncremental schema
  [
    IpcChannel.LSP_UpdateDocumentIncremental,
    z.tuple([
      safePathSchema,
      z.array(
        z.object({
          range: z.object({
            start: z.object({ line: z.number().int().min(0), character: z.number().int().min(0) }),
            end: z.object({ line: z.number().int().min(0), character: z.number().int().min(0) }),
          }),
          text: safeStringSchema(),
        })
      ),
    ]),
  ],
  [IpcChannel.LSP_CloseDocument, z.tuple([safePathSchema])],
  [IpcChannel.LSP_SaveDocument, z.tuple([safePathSchema])],
  // 🔒 P1 fix: Supplement LSP completion/hover/definition/references/symbols schemas
  [
    IpcChannel.LSP_GetCompletions,
    z.tuple([safePathSchema, z.number().int().min(0), z.number().int().min(0)]),
  ],
  [
    IpcChannel.LSP_GetHover,
    z.tuple([safePathSchema, z.number().int().min(0), z.number().int().min(0)]),
  ],
  [
    IpcChannel.LSP_GetDefinition,
    z.tuple([safePathSchema, z.number().int().min(0), z.number().int().min(0)]),
  ],
  [
    IpcChannel.LSP_GetReferences,
    z.tuple([
      safePathSchema,
      z.number().int().min(0),
      z.number().int().min(0),
      z.boolean().optional(),
    ]),
  ],
  [IpcChannel.LSP_GetSymbols, z.tuple([safePathSchema])],
  [IpcChannel.LSP_GetSemanticTokens, z.tuple([safePathSchema])],
  [IpcChannel.LSP_Build, z.tuple([safePathSchema])],
  [IpcChannel.LSP_ForwardSearch, z.tuple([safePathSchema, z.number().int().min(0)])],
  // 🔒 P1 fix: Supplement LSP extension channel schemas
  [
    IpcChannel.LSP_StartAll,
    z.tuple([safePathSchema, z.object({ virtual: z.boolean().optional() }).optional()]),
  ],
  [
    IpcChannel.LSP_StartTexLab,
    z.tuple([safePathSchema, z.object({ virtual: z.boolean().optional() }).optional()]),
  ],
  [
    IpcChannel.LSP_StartTinymist,
    z.tuple([safePathSchema, z.object({ virtual: z.boolean().optional() }).optional()]),
  ],
  [
    IpcChannel.LSP_StartMarksman,
    z.tuple([safePathSchema, z.object({ virtual: z.boolean().optional() }).optional()]),
  ],
  [IpcChannel.LSP_ExportTypstPdf, z.tuple([safePathSchema])],
  [IpcChannel.LSP_FormatTypst, z.tuple([safePathSchema])],

  // ==================== Compile Operations ====================
  // 🔒 Limit content size to prevent memory exhaustion
  [
    IpcChannel.Compile_LaTeX,
    z.tuple([
      safeStringSchema(10 * 1024 * 1024), // 10MB
      z
        .object({
          mainFile: safePathSchema.optional(),
          outputDir: safePathSchema.optional(),
          engine: z.enum(['pdflatex', 'xelatex', 'lualatex', 'latexmk', 'tectonic']).optional(),
          synctex: z.boolean().optional(),
        })
        .optional(),
    ]),
  ],
  [
    IpcChannel.Compile_Typst,
    z.tuple([
      safeStringSchema(10 * 1024 * 1024), // 10MB
      z
        .object({
          mainFile: safePathSchema.optional(),
          projectPath: safePathSchema.optional(),
          engine: z.enum(['typst', 'tinymist']).optional(),
        })
        .optional(),
    ]),
  ],
  [IpcChannel.Compile_Cancel, z.tuple([z.enum(['latex', 'typst']).optional()])],
  [
    IpcChannel.SyncTeX_Forward,
    z.tuple([
      safePathSchema, // texFile
      z
        .number()
        .int()
        .min(0)
        .max(1000000), // line
      z
        .number()
        .int()
        .min(0)
        .max(1000000), // column
      safePathSchema, // pdfFile
    ]),
  ],
  [
    IpcChannel.SyncTeX_Backward,
    z.tuple([
      safePathSchema, // pdfFile
      z
        .number()
        .int()
        .min(1)
        .max(10000), // page
      z
        .number()
        .min(0), // x
      z
        .number()
        .min(0), // y
    ]),
  ],

  // ==================== AI Operations ====================
  [
    IpcChannel.AI_UpdateConfig,
    z.tuple([
      z.object({
        provider: z.enum(['openai', 'anthropic', 'deepseek', 'dashscope', 'ollama', 'custom']),
        apiKey: z.string().max(500),
        baseUrl: safeUrlSchema.or(z.literal('')),
        model: z.string().max(100),
        temperature: z.number().min(0).max(2),
        maxTokens: z.number().int().positive().max(128000),
        completionModel: z.string().max(100).optional(),
        completionApiKey: z.string().max(500).optional(), // NEW: Independent completion API key
        completionBaseUrl: safeUrlSchema.or(z.literal('')).optional(), // NEW: Independent completion base URL
      }),
    ]),
  ],
  [
    IpcChannel.AI_ChatStream,
    z.tuple([
      z
        .array(
          z.object({
            role: z.enum(['user', 'assistant', 'system']),
            content: safeStringSchema(100000), // 100KB per message
          })
        )
        .max(100), // Max 100 messages
    ]),
  ],
  [IpcChannel.AI_Completion, z.tuple([safeStringSchema(50000)])],

  // ==================== Overleaf Operations ====================
  [
    IpcChannel.OverleafAuth_Init,
    z.tuple([
      z.object({
        serverUrl: safeUrlSchema,
        email: z.string().email().optional(),
        password: z.string().max(500).optional(),
        cookies: z.string().max(10000).optional(),
        projectId: z.string().max(100).optional(),
      }),
    ]),
  ],
  [IpcChannel.OverleafAuth_TestConnection, z.tuple([safeUrlSchema])],
  [
    IpcChannel.OverleafAuth_Login,
    z.tuple([
      z.object({
        serverUrl: safeUrlSchema,
        email: z.string().email().optional(),
        password: z.string().max(500).optional(),
        cookies: z.string().max(10000).optional(),
      }),
    ]),
  ],
  // ==================== Auto Update ====================
  [IpcChannel.App_CheckUpdate, z.tuple([])],
  [IpcChannel.App_DownloadUpdate, z.tuple([])],
  [IpcChannel.App_InstallUpdate, z.tuple([])],

  [IpcChannel.OverleafProject_GetDetails, z.tuple([safeIdSchema])],
  // ==================== Overleaf Project Sync ====================
  [IpcChannel.OverleafProject_Download, z.tuple([safeIdSchema, safeStringSchema()])],
  [IpcChannel.OverleafProject_FindLocalPath, z.tuple([safeIdSchema])],
  [IpcChannel.OverleafProject_GetMeta, z.tuple([safePathSchema])],
  [
    IpcChannel.OverleafProject_UpdateDocIdMap,
    z.tuple([safePathSchema, z.record(z.string(), z.string())]),
  ],
  [
    IpcChannel.OverleafProject_SyncFile,
    z.tuple([safeIdSchema, safeIdSchema, z.string(), safePathSchema]),
  ],
  [
    IpcChannel.OverleafProject_SyncProject,
    z.tuple([safeIdSchema, z.record(z.string(), z.string()), safePathSchema]),
  ],
  [
    IpcChannel.OverleafProject_SyncFileByPath,
    z.tuple([
      safeIdSchema,
      safeStringSchema(),
      z.string(),
      safePathSchema,
      z.record(z.string(), z.string()),
    ]),
  ],
  [
    IpcChannel.OverleafProject_CreateAndSync,
    z.tuple([safeIdSchema, safeStringSchema(), safeIdSchema, z.string(), safePathSchema]),
  ],
  [
    IpcChannel.OverleafLive_Configure,
    z.tuple([
      z.object({
        serverUrl: safeUrlSchema,
        cookies: z.string().max(20000),
        projectId: safeIdSchema,
        clientInstanceId: safeIdSchema.optional(),
        sessionType: z.enum(['user', 'bot']).optional(),
      }),
    ]),
  ],
  [IpcChannel.OverleafLive_Disconnect, z.tuple([])],
  [IpcChannel.OverleafLive_GetState, z.tuple([])],
  [
    IpcChannel.OverleafLive_JoinDoc,
    z.tuple([
      z.object({
        projectId: safeIdSchema,
        docId: safeIdSchema,
        fromVersion: z.number().int().min(-1).optional(),
      }),
    ]),
  ],
  [
    IpcChannel.OverleafLive_SubmitPatches,
    z.tuple([
      z.object({
        projectId: safeIdSchema,
        docId: safeIdSchema,
        baseVersion: z.number().int().min(0),
        requestId: safeIdSchema.optional(),
        patches: z.array(
          z.object({
            offset: z.number().int().min(0),
            deleteCount: z.number().int().min(0),
            insertText: safeStringSchema(2 * 1024 * 1024),
          })
        ),
      }),
    ]),
  ],
  [
    IpcChannel.OverleafLive_CreateEntity,
    z.tuple([
      z.object({
        projectId: safeIdSchema,
        entityType: z.enum(['doc', 'folder']),
        parentFolderId: safeIdSchema,
        name: safeStringSchema(500),
        content: safeStringSchema(2 * 1024 * 1024).optional(),
      }),
    ]),
  ],
  [
    IpcChannel.OverleafLive_RenameEntity,
    z.tuple([
      z.object({
        projectId: safeIdSchema,
        entityType: z.enum(['doc', 'file', 'folder']),
        entityId: safeIdSchema,
        newName: safeStringSchema(500),
      }),
    ]),
  ],
  [
    IpcChannel.OverleafLive_MoveEntity,
    z.tuple([
      z.object({
        projectId: safeIdSchema,
        entityType: z.enum(['doc', 'file', 'folder']),
        entityId: safeIdSchema,
        targetFolderId: safeIdSchema,
      }),
    ]),
  ],
  [
    IpcChannel.OverleafLive_DeleteEntity,
    z.tuple([
      z.object({
        projectId: safeIdSchema,
        entityType: z.enum(['doc', 'file', 'folder']),
        entityId: safeIdSchema,
      }),
    ]),
  ],
  [
    IpcChannel.OverleafLive_UploadFile,
    z.tuple([
      z.object({
        projectId: safeIdSchema,
        parentFolderId: safeIdSchema,
        fileName: safeStringSchema(500),
        mimeType: safeStringSchema(200),
        data: z.instanceof(Uint8Array),
      }),
    ]),
  ],

  // ==================== External Links ====================
  // 🔒 P0 fix: Use safeUrlSchema, only allow http/https protocol
  [IpcChannel.App_OpenExternal, z.tuple([safeUrlSchema])],

  // ==================== Settings (P0 fix) ====================
  // 🔒 Settings module - contains API Key + BaseURL, high risk
  [IpcChannel.Settings_GetAIProviders, z.tuple([])],
  [
    IpcChannel.Settings_SetAIProviders,
    z.tuple([
      z
        .array(
          z.object({
            id: z.string().max(100),
            name: z.string().max(200),
            apiKey: z.string().max(500),
            apiHost: safeUrlSchema.or(z.literal('')),
            defaultApiHost: safeUrlSchema.or(z.literal('')).optional(),
            enabled: z.boolean(),
            isSystem: z.boolean().optional(),
            models: z.array(z.unknown()).max(500),
            website: safeUrlSchema.or(z.literal('')).optional(),
            anthropicApiHost: safeUrlSchema.or(z.literal('')).optional(),
            timeout: z.number().int().positive().max(300000).optional(),
            rateLimit: z.number().int().positive().max(10000).optional(),
          })
        )
        .max(100),
    ]),
  ],
  [IpcChannel.Settings_GetSelectedModels, z.tuple([])],
  [
    IpcChannel.Settings_SetSelectedModels,
    z.tuple([
      z.object({
        chat: z
          .object({ providerId: z.string().max(100), modelId: z.string().max(200) })
          .optional(),
        completion: z
          .object({ providerId: z.string().max(100), modelId: z.string().max(200) })
          .optional(),
        formula: z
          .object({ providerId: z.string().max(100), modelId: z.string().max(200) })
          .optional(),
        review: z
          .object({ providerId: z.string().max(100), modelId: z.string().max(200) })
          .optional(),
        rewrite: z
          .object({ providerId: z.string().max(100), modelId: z.string().max(200) })
          .optional(),
      }),
    ]),
  ],
  [IpcChannel.Settings_GetAIConfig, z.tuple([])],
  [
    IpcChannel.Settings_SetAIConfig,
    z.tuple([
      z.object({
        providers: z.array(z.unknown()).max(100), // Detailed validation handled by SetAIProviders
        selectedModels: z.unknown(), // Detailed validation handled by SetSelectedModels
      }),
    ]),
  ],

  // ==================== AI Supplement (P0 fix) ====================
  // 🔒 AI_FetchModels - contains URL + API Key
  [
    IpcChannel.AI_FetchModels,
    z.tuple([
      safeUrlSchema, // baseUrl
      z
        .string()
        .max(500)
        .optional(), // apiKey
    ]),
  ],
  // AI channels with no parameters or simple parameters
  [IpcChannel.AI_IsConfigured, z.tuple([])],
  [IpcChannel.AI_StopGeneration, z.tuple([])],
  [IpcChannel.AI_IsGenerating, z.tuple([])],
  [IpcChannel.AI_TestConnection, z.tuple([])],

  // Ctrl+K Inline Edit. Selection capped at 100KB to mirror chat message size.
  [
    IpcChannel.AI_InlineEditStart,
    z.tuple([
      z.object({
        instruction: safeStringSchema(2000),
        selectedText: safeStringSchema(100_000),
        language: z.string().max(64),
        fileLabel: z.string().max(1024).optional(),
        surroundingContext: safeStringSchema(20_000).optional(),
      }),
    ]),
  ],
  [IpcChannel.AI_InlineEditCancel, z.tuple([z.string().min(1).max(128)])],

  // SNACA flush_unsaved reverse-RPC reply (renderer → main).
  [
    IpcChannel.Agent_ContextFlushResponse,
    z.tuple([
      z.object({
        requestId: z.string().min(1).max(128),
        flushedFiles: z.array(z.string().max(4096)).max(512),
      }),
    ]),
  ],

  // ==================== Config (P0 fix) ====================
  // 🔒 Config_Get/Set - can read/write arbitrary configuration
  [IpcChannel.Config_Get, z.tuple([z.string().max(256)])],
  [
    IpcChannel.Config_Set,
    z.tuple([
      z
        .string()
        .max(256), // key
      z.unknown(), // value - validated internally by ConfigManager
      z
        .boolean()
        .optional(), // notify
    ]),
  ],

  // ==================== Studio IM / OT ====================
  [
    IpcChannel.IM_Connect,
    z.tuple([
      z.object({
        baseUrl: safeUrlSchema,
        token: z.string().max(512),
        conversationId: safeIdSchema,
      }),
    ]),
  ],
  [IpcChannel.IM_Disconnect, z.tuple([])],
  [IpcChannel.IM_GetSnapshot, z.tuple([])],
  [
    IpcChannel.IM_ListConversations,
    z.tuple([
      z.object({
        baseUrl: safeUrlSchema,
        token: z.string().max(512),
      }),
    ]),
  ],
  [
    IpcChannel.IM_CreateConversation,
    z.tuple([
      z.object({
        baseUrl: safeUrlSchema,
        token: z.string().max(512),
        type: z.enum(['direct', 'group']),
        memberIds: z.array(safeIdSchema).min(1).max(100),
        title: safeStringSchema(200).optional(),
      }),
    ]),
  ],
  [
    IpcChannel.IM_GetConversationMembers,
    z.tuple([safeUrlSchema, z.string().max(512), safeIdSchema]),
  ],
  [IpcChannel.IM_GetBotUserId, z.tuple([safeUrlSchema, z.string().max(512)])],
  [
    IpcChannel.IM_SendMessage,
    z.tuple([
      z.object({
        conversationId: safeIdSchema,
        // 2MB upper bound: a single message can carry the user's text plus any
        // @-attached file contents inlined as <attachments><file>...</file></attachments>.
        // AtMentionResolver caps total attachment bytes at 1MB; extra headroom
        // here covers wrapper tags, surrounding prose, and UTF-8 expansion.
        content: safeStringSchema(2 * 1024 * 1024),
        contentType: z.enum(['text', 'image', 'file']).optional(),
        quotedMessageId: safeIdSchema.optional(),
        fileUrl: safeUrlSchema.optional(),
        fileName: safeStringSchema(500).optional(),
        fileSize: z.number().int().nonnegative().optional(),
        thumbnailUrl: safeUrlSchema.optional(),
        metadata: imMessageMetadataSchema.optional(),
      }),
    ]),
  ],
  [
    IpcChannel.IM_UploadAttachment,
    z.tuple([
      z.object({
        name: safeStringSchema(500),
        mimeType: safeStringSchema(200),
        data: z.instanceof(Uint8Array),
      }),
    ]),
  ],
  [IpcChannel.IM_SendTyping, z.tuple([safeIdSchema])],
  [
    IpcChannel.CollaborationOwner_SetActive,
    z.tuple([
      z.object({
        backend: collaborationBackendSchema,
        projectId: safeIdSchema.nullish(),
        rootPath: safePathSchema.nullish(),
        fileId: safeIdSchema.nullish(),
      }),
    ]),
  ],
  [
    IpcChannel.CollaborationOwner_Clear,
    z.tuple([
      z.object({
        backend: collaborationBackendSchema,
      }),
    ]),
  ],
  [
    IpcChannel.OT_Configure,
    z.tuple([
      z.object({
        baseUrl: safeUrlSchema,
        token: z.string().max(512),
      }),
    ]),
  ],
  [IpcChannel.OT_SetBotUserId, z.tuple([z.string().max(128)])],
  [IpcChannel.OT_Disconnect, z.tuple([])],
  [
    IpcChannel.OT_OpenLocalProject,
    z.tuple([
      z.object({
        root_path: safePathSchema,
        name: safeStringSchema(200).optional(),
        files: z
          .array(
            z.object({ file_path: safeStringSchema(1000), content: otProjectFileContentSchema })
          )
          .max(5000),
        folders: z.array(safeStringSchema(1000)).max(5000).optional(),
        workspace: z.string().max(50).optional(),
      }),
    ]),
  ],
  [IpcChannel.OT_GetProjectSnapshot, z.tuple([safeIdSchema])],
  [IpcChannel.OT_GetProjectFile, z.tuple([safeIdSchema, safeIdSchema])],
  [IpcChannel.OT_JoinFile, z.tuple([z.object({ projectId: safeIdSchema, fileId: safeIdSchema })])],
  [
    IpcChannel.OT_SubmitFileOp,
    z.tuple([
      z.object({
        projectId: safeIdSchema,
        fileId: safeIdSchema,
        version: z.number().int().nonnegative(),
        ops: z
          .array(
            z.object({
              retain: z.number().int().nonnegative().optional(),
              insert: safeStringSchema(200000).optional(),
              delete: z.number().int().nonnegative().optional(),
            })
          )
          .max(1000),
      }),
    ]),
  ],
  [
    IpcChannel.OT_ApplyBotEdit,
    z.tuple([
      z.object({
        projectId: safeIdSchema,
        fileId: safeIdSchema,
        newContent: safeStringSchema(8 * 1024 * 1024),
        originalContent: safeStringSchema(8 * 1024 * 1024).optional(),
        pollTimeoutMs: z.number().int().positive().max(60000).optional(),
        pollIntervalMs: z.number().int().positive().max(5000).optional(),
      }),
    ]),
  ],
  [
    IpcChannel.OT_CreateFile,
    z.tuple([
      z.object({
        projectId: safeIdSchema,
        file_path: safeStringSchema(1000),
        content: safeStringSchema(2 * 1024 * 1024).optional(),
      }),
    ]),
  ],
  [
    IpcChannel.OT_CreateFolder,
    z.tuple([z.object({ projectId: safeIdSchema, folder_path: safeStringSchema(1000) })]),
  ],
  [
    IpcChannel.OT_RenameFile,
    z.tuple([
      z.object({
        projectId: safeIdSchema,
        fileId: safeIdSchema,
        file_path: safeStringSchema(1000),
      }),
    ]),
  ],
  [
    IpcChannel.OT_RenameFolder,
    z.tuple([
      z.object({
        projectId: safeIdSchema,
        folderId: safeIdSchema,
        folder_path: safeStringSchema(1000),
      }),
    ]),
  ],
  [IpcChannel.OT_DeleteFile, z.tuple([safeIdSchema, safeIdSchema])],
  [IpcChannel.OT_DeleteFolder, z.tuple([safeIdSchema, safeIdSchema])],
  [IpcChannel.OT_ListProjects, z.tuple([z.string().max(100).nullable()])],
  [
    IpcChannel.OT_UpdateProject,
    z.tuple([
      safeIdSchema,
      z.object({ name: z.string().max(200).optional(), workspace: z.string().max(50).optional() }),
    ]),
  ],
  [
    IpcChannel.ProjectConversation_Resolve,
    z.tuple([
      z.object({
        runtime: z.literal('openclaw'),
        scopeType: projectConversationScopeSchema,
        projectId: safeIdSchema.nullish(),
        localRootPath: safePathSchema.nullish(),
        workspaceId: z.string().max(100).nullish(),
        title: z.string().max(200).nullish(),
        createIfMissing: z.boolean().optional(),
        imConfig: imConfigForProjectConversationSchema,
      }),
    ]),
  ],
  [
    IpcChannel.ProjectConversation_List,
    z.tuple([
      z.object({
        runtime: z.literal('openclaw'),
        scopeType: projectConversationScopeSchema,
        projectId: safeIdSchema.nullish(),
        localRootPath: safePathSchema.nullish(),
      }),
    ]),
  ],
  [
    IpcChannel.ProjectConversation_Create,
    z.tuple([
      z.object({
        runtime: z.literal('openclaw'),
        scopeType: projectConversationScopeSchema,
        projectId: safeIdSchema.nullish(),
        localRootPath: safePathSchema.nullish(),
        workspaceId: z.string().max(100).nullish(),
        title: z.string().max(200).nullish(),
        imConfig: imConfigForProjectConversationSchema,
      }),
    ]),
  ],
  [
    IpcChannel.ProjectConversation_SetDefault,
    z.tuple([
      z.object({
        bindingId: safeIdSchema,
      }),
    ]),
  ],
  // ==================== Selection (P0 fix) ====================
  [IpcChannel.Selection_SetEnabled, z.tuple([z.boolean()])],
  [IpcChannel.Selection_IsEnabled, z.tuple([])],
  [IpcChannel.Selection_GetConfig, z.tuple([])],
  [
    IpcChannel.Selection_SetConfig,
    z.tuple([
      z.object({
        enabled: z.boolean().optional(),
        triggerMode: z.enum(['shortcut', 'hook']).optional(),
        shortcutKey: z.string().max(50).optional(),
      }),
    ]),
  ],
  [IpcChannel.Selection_GetText, z.tuple([])],

  // ==================== File Supplement (P1 fix) ====================
  [
    IpcChannel.File_Select,
    z.tuple([
      z
        .object({
          filters: z
            .array(
              z.object({
                name: z.string().max(100),
                extensions: z.array(z.string().max(20)).max(50),
              })
            )
            .max(20)
            .optional(),
          multiple: z.boolean().optional(),
          directory: z.boolean().optional(),
        })
        .optional(),
    ]),
  ],
  [IpcChannel.Clipboard_GetFiles, z.tuple([])],

  // ==================== Window/Dialog (P1 fix) ====================
  [
    IpcChannel.Window_New,
    z.tuple([
      z
        .object({
          projectPath: safePathSchema.optional(),
        })
        .optional(),
    ]),
  ],
  [IpcChannel.Window_GetAll, z.tuple([])],
  [IpcChannel.Window_Close, z.tuple([])],
  [IpcChannel.Window_Focus, z.tuple([z.number().int().optional()])],
  [
    IpcChannel.Dialog_Confirm,
    z.tuple([
      z.object({
        message: z.string().max(2000),
        title: z.string().max(200).optional(),
        confirmText: z.string().max(100).optional(),
        cancelText: z.string().max(100).optional(),
        type: z.enum(['info', 'warning', 'error', 'question']).optional(),
      }),
    ]),
  ],
  [
    IpcChannel.Dialog_Message,
    z.tuple([
      z.object({
        message: z.string().max(5000),
        title: z.string().max(200).optional(),
        type: z.enum(['info', 'warning', 'error', 'none']).optional(),
        detail: z.string().max(5000).optional(),
      }),
    ]),
  ],

  // ==================== Log/Trace (P1 fix) ====================
  [IpcChannel.Log_GetPath, z.tuple([])],
  [IpcChannel.Log_OpenFolder, z.tuple([])],
  [
    IpcChannel.Log_Write,
    z.tuple([
      z
        .array(
          z.object({
            level: z.enum(['debug', 'info', 'warn', 'error']),
            message: safeStringSchema(10000),
            timestamp: z.number().optional(),
            category: z.string().max(100).optional(),
            details: z.unknown().optional(),
          })
        )
        .max(100),
    ]),
  ],
  [IpcChannel.Log_ExportDiagnostics, z.tuple([])],
  [IpcChannel.Log_Clear, z.tuple([])],
  [
    IpcChannel.Log_FromRenderer,
    z.tuple([
      z.object({
        process: z.literal('renderer'),
        window: z.string().max(100).optional(),
        module: z.string().max(100).optional(),
      }), // source
      z.enum(['debug', 'info', 'warn', 'error']), // level
      safeStringSchema(10000), // message
      z
        .array(z.unknown())
        .optional(), // data
    ]),
  ],
  [
    IpcChannel.Trace_Start,
    z.tuple([
      z
        .string()
        .max(256), // name
      z
        .record(z.string(), z.unknown())
        .optional(), // metadata
    ]),
  ],
  [
    IpcChannel.Trace_End,
    z.tuple([
      z
        .string()
        .max(256), // traceId
      z
        .record(z.string(), z.unknown())
        .optional(), // metadata
    ]),
  ],
  [IpcChannel.Trace_Get, z.tuple([z.string().max(256)])], // traceId

  // ==================== App Info (P1 fix) ====================
  [IpcChannel.App_GetVersion, z.tuple([])],
  [IpcChannel.App_GetHomeDir, z.tuple([])],
  [IpcChannel.App_GetAppDataDir, z.tuple([])],

  // ==================== LSP Supplement (P1 fix) ====================
  [IpcChannel.LSP_GetProcessInfo, z.tuple([])],
  [IpcChannel.LSP_IsAvailable, z.tuple([])],
  [IpcChannel.LSP_GetVersion, z.tuple([])],
  [IpcChannel.LSP_Stop, z.tuple([])],
  [IpcChannel.LSP_IsRunning, z.tuple([])],
  [IpcChannel.LSP_IsVirtualMode, z.tuple([])],
  [IpcChannel.LSP_IsTexLabAvailable, z.tuple([])],
  [IpcChannel.LSP_IsTinymistAvailable, z.tuple([])],
  [IpcChannel.LSP_CheckAvailability, z.tuple([])],
  [IpcChannel.LSP_GetTexLabVersion, z.tuple([])],
  [IpcChannel.LSP_GetTinymistVersion, z.tuple([])],
  [IpcChannel.LSP_IsMarksmanAvailable, z.tuple([])],
  [IpcChannel.LSP_GetMarksmanVersion, z.tuple([])],
  [IpcChannel.LSP_RequestDirectChannel, z.tuple([])],

  // ==================== Overleaf Supplement (P1 fix) ====================
  [IpcChannel.OverleafAuth_IsLoggedIn, z.tuple([])],
  [IpcChannel.OverleafAuth_GetCookies, z.tuple([])],
  [IpcChannel.OverleafProject_GetProjects, z.tuple([])],

  // ==================== Typst (P1 fix) ====================
  [IpcChannel.Typst_Available, z.tuple([])],
  [IpcChannel.Compile_GetStatus, z.tuple([])],

  // ==================== Project Binding ====================
  [
    IpcChannel.ProjectBinding_Import,
    z.tuple([
      z.object({
        localRootPath: safePathSchema,
        projectName: safeStringSchema().optional(),
        customIgnorePatterns: z.array(safeStringSchema()).optional(),
      }),
    ]),
  ],
  [IpcChannel.ProjectBinding_Unbind, z.tuple([safeIdSchema])],
  [IpcChannel.ProjectBinding_GetByPath, z.tuple([safePathSchema])],
  [IpcChannel.ProjectBinding_GetByProjectId, z.tuple([safeIdSchema])],
  [IpcChannel.ProjectBinding_Resolve, z.tuple([safePathSchema])],
  [
    IpcChannel.ProjectBinding_EnsureBootstrap,
    z.tuple([
      z.object({
        localRootPath: safePathSchema,
        remoteProjectId: safeIdSchema,
        projectName: safeStringSchema().optional(),
        backend: z.enum(['scipen-ot', 'overleaf']).optional(),
      }),
    ]),
  ],
  [IpcChannel.ProjectBinding_SetEnabled, z.tuple([safeIdSchema, z.boolean()])],
  [
    IpcChannel.ExternalChange_Resolve,
    z.tuple([
      z.object({
        batchId: safeStringSchema(),
        projectRootPath: safePathSchema,
        resolutions: z.array(
          z.object({
            relativePath: safeStringSchema(),
            choice: z.enum(['keep_cloud', 'skip']),
          })
        ),
      }),
    ]),
  ],
  [
    IpcChannel.ProjectBinding_Rebuild,
    z.tuple([
      z.object({
        localRootPath: safePathSchema,
      }),
    ]),
  ],
  [
    IpcChannel.ProjectBinding_Rebind,
    z.tuple([
      z.object({
        localRootPath: safePathSchema,
        remoteProjectId: safeIdSchema,
        backend: z.enum(['scipen-ot', 'overleaf']).optional(),
      }),
    ]),
  ],
  [
    IpcChannel.ProjectBinding_ExportSnapshot,
    z.tuple([
      z.object({
        remoteProjectId: safeIdSchema,
        exportPath: safePathSchema,
      }),
    ]),
  ],
]);
