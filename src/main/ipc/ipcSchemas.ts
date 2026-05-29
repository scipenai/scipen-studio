/**
 * IPC Channel Validation Schemas
 *
 * Pure data declaration file: Zod validation schemas for every IPC channel.
 * Framework code (registerTypedHandler, etc.) lives in typedIpc.ts.
 */

import path from 'node:path';
import { z } from 'zod';
import { IpcChannel } from '../../../shared/ipc/channels';

// ==================== Schema Helpers ====================

/**
 * Path validation helper at the IPC perimeter.
 *
 * Hard rules (any violation rejected at the boundary, never reaches fs):
 * 1. Must be absolute. Relative paths have no anchor at the IPC layer —
 *    Node's fs would silently resolve them against process.cwd(), which
 *    in a packaged Electron app is the install directory. Callers passing
 *    agent-supplied data MUST absolutize against the workspace root first
 *    (see SNACA `resolve_within` / `AgentEditProposalBridge.resolveAbsolute`).
 * 2. No path traversal (`..`).
 * 3. No sensitive system directories (/etc, Windows, Program Files, AppData...).
 *    Exception: the app's own data directory is whitelisted.
 */
const safePathSchema = z.string().refine(
  (pathStr) => {
    if (!path.isAbsolute(pathStr)) {
      return false;
    }

    const normalized = pathStr.replace(/\\/g, '/').toLowerCase();

    if (/\.\.[/\\]/.test(normalized)) {
      return false;
    }

    const appDataWhitelist =
      /^[a-z]:\/users\/[^/]+\/appdata\/(roaming|local)\/(scipen-studio|temp\/scipen)/i;
    if (appDataWhitelist.test(normalized)) {
      return true;
    }

    const sensitivePatterns = [
      /^\/?etc\//i,
      /^\/?proc\//i,
      /^\/?sys\//i,
      /^\/?(windows|winnt)\//i,
      /^[a-z]:[\\/](windows|winnt|program files|programdata|users[\\/][^\\/]+[\\/](appdata|ntuser))/i,
    ];

    return !sensitivePatterns.some((pattern) => pattern.test(normalized));
  },
  { message: 'Path must be absolute and outside sensitive system directories' }
);

/**
 * 🔒 Safe string schema with size limit (default 1MB)
 * Prevents memory exhaustion attacks
 */
const safeStringSchema = (maxLength: number = 1024 * 1024) =>
  z.string().max(maxLength, { message: `String exceeds maximum length of ${maxLength}` });

/**
 * 🔒 Safe ID schema (for database IDs, project IDs, etc.)
 */
const safeIdSchema = z
  .string()
  .min(1, { message: 'ID cannot be empty' })
  .max(256, { message: 'ID too long' })
  .regex(/^[a-zA-Z0-9_-]+$/, { message: 'ID contains invalid characters' });

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

const collaborationBackendSchema = z.enum(['scipen-ot', 'overleaf']);

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
  // SNACA zotero_* reverse-RPC reply (renderer → main).
  [
    IpcChannel.Agent_ContextZoteroResponse,
    z.tuple([
      z.object({
        requestId: z.string().min(1).max(128),
        ok: z.boolean(),
        data: z.unknown().optional(),
        error: z.string().max(2048).optional(),
      }),
    ]),
  ],

  // ==================== Memory / Skills viewer (P6-C) ====================
  // The renderer-facing IPC takes only a payload object; session_id is
  // joined in main from the live AgentSessionState. Schemas here mirror
  // those in agentHandlers.ts as a defense-in-depth check.
  [
    IpcChannel.Agent_MemoryList,
    z.tuple([
      z
        .object({
          scope: z.enum(['user', 'feedback', 'project', 'reference']).optional(),
        })
        .optional(),
    ]),
  ],
  [
    IpcChannel.Agent_MemoryGet,
    z.tuple([
      z.object({
        scope: z.enum(['user', 'feedback', 'project', 'reference']),
        name: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-z0-9_-]+$/),
      }),
    ]),
  ],
  [
    IpcChannel.Agent_MemoryWrite,
    z.tuple([
      z.object({
        scope: z.enum(['user', 'feedback', 'project', 'reference']),
        name: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-z0-9_-]+$/),
        content: z.string().max(100_000),
      }),
    ]),
  ],
  [
    IpcChannel.Agent_MemoryDelete,
    z.tuple([
      z.object({
        scope: z.enum(['user', 'feedback', 'project', 'reference']),
        name: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-z0-9_-]+$/),
      }),
    ]),
  ],
  [
    IpcChannel.Agent_MemoryReveal,
    z.tuple([
      z
        .object({
          scope: z.enum(['user', 'feedback', 'project', 'reference']).optional(),
          name: z
            .string()
            .min(1)
            .max(64)
            .regex(/^[a-z0-9_-]+$/)
            .optional(),
        })
        .optional(),
    ]),
  ],
  [IpcChannel.Agent_SkillsList, z.tuple([])],
  [
    IpcChannel.Agent_SkillsGet,
    z.tuple([z.object({ name: z.string().min(1).max(128) })]),
  ],
  [IpcChannel.Agent_SkillsReload, z.tuple([])],
  [
    IpcChannel.Agent_OpenMemoryViewer,
    z.tuple([
      z
        .object({
          initialTab: z.enum(['memory', 'skills']).optional(),
        })
        .optional(),
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

  // ==================== Collaboration Owner ====================
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

  // ==================== Zotero Integration ====================
  // 只读 / 无参通道
  [IpcChannel.Zotero_GetSettings, z.tuple([])],
  [IpcChannel.Zotero_DetectInstallation, z.tuple([])],
  [IpcChannel.Zotero_PingLocalApi, z.tuple([])],
  [IpcChannel.Zotero_ClearMinerUApiKey, z.tuple([])],
  [IpcChannel.Zotero_ClearEmbeddingApiKey, z.tuple([])],
  [IpcChannel.Zotero_RequestRefresh, z.tuple([])],
  [IpcChannel.Zotero_GetDiagnostics, z.tuple([])],
  [IpcChannel.Zotero_SyncBibTex, z.tuple([])],
  [IpcChannel.Zotero_GetBibTexSyncStatus, z.tuple([])],
  [IpcChannel.Zotero_GetCslByKey, z.tuple([z.string().min(1)])],
  [IpcChannel.Zotero_GetItemAnnotations, z.tuple([z.string().min(1)])],
  [IpcChannel.Zotero_GetFullText, z.tuple([z.string().min(1)])],
  // 部分更新 settings:strict 模式只接受白名单字段,未知字段被 IPC 边界拒绝
  // 而非静默持久化。integrationEnabled 是 D 方案主开关,必须在白名单内。
  [
    IpcChannel.Zotero_SetSettings,
    z.tuple([
      z
        .object({
          integrationEnabled: z.boolean().optional(),
          path: z.string().optional(),
          localApiEnabled: z.boolean().optional(),
          embeddingProvider: z.enum(['zhipu', 'aliyun', 'openai']).optional(),
          activeRecommendation: z.boolean().optional(),
          bibTexSync: z
            .object({
              enabled: z.boolean(),
              fileName: z.string().min(1),
              translator: z.string().min(1),
            })
            .strict()
            .optional(),
        })
        .strict(),
    ]),
  ],
  // API token 各 provider 没有长度契约,只要求非空字符串。真正的有效性校验在
  // 首次实际调用时由 provider 判定。
  [IpcChannel.Zotero_SetMinerUApiKey, z.tuple([z.string().min(1)])],
  [IpcChannel.Zotero_SetEmbeddingApiKey, z.tuple([z.string().min(1)])],
  // bib index 快照拉取:since 是上次落地的 etag,缺省表示"给我全量"。
  [
    IpcChannel.Zotero_GetSnapshot,
    z.tuple([
      z
        .object({
          since: z.string().optional(),
        })
        .strict(),
    ]),
  ],

  // ==================== Project Binding ==================== (removed in P3 cleanup)
]);
