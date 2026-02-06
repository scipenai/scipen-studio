/**
 * Type-Safe IPC Handler Registration
 *
 * Provides type-safe IPC handler registration, ensuring:
 * 1. Channel names must be defined in IPCApiContract
 * 2. Handler parameter types are automatically inferred
 * 3. Return value types are automatically validated
 * 4. Runtime parameter validation (optional, using zod schema)
 *
 * @example
 * // Type-safe handler registration
 * registerTypedHandler(IpcChannel.Compile_LaTeX, async (content, options) => {
 *   // content: string, options: LaTeXCompileOptions | undefined (auto-inferred)
 *   return result; // Must match LaTeXCompileResult type
 * });
 *
 * // Batch registration
 * const handlers = createTypedHandlers({
 *   [IpcChannel.Compile_LaTeX]: async (content, options) => { ... },
 *   [IpcChannel.Compile_Typst]: async (content, options) => { ... },
 * });
 * handlers.registerAll();
 */

import { type IpcMainInvokeEvent, ipcMain } from 'electron';
import { z } from 'zod';
import type { IPCArgs, IPCInvokeChannel, IPCResult } from '../../../shared/api-types';
import { IpcChannel } from '../../../shared/ipc/channels';

// ==================== Validation Schemas ====================

/**
 * Error thrown when IPC parameter validation fails
 */
export class IPCValidationError extends Error {
  constructor(
    public readonly channel: string,
    public readonly validationErrors: z.ZodError
  ) {
    super(`Invalid arguments for IPC channel '${channel}': ${validationErrors.message}`);
    this.name = 'IPCValidationError';
  }
}

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

// ==================== Schema Helpers ====================

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
  [
    IpcChannel.File_Copy,
    z.tuple([
      safePathSchema,
      safePathSchema,
      z
        .object({
          entityType: z.enum(['doc', 'file', 'folder']).optional(),
          entityId: z.string().max(100).optional(),
          targetFolderId: z.string().max(100).optional(),
        })
        .optional(),
    ]),
  ],
  [
    IpcChannel.File_Move,
    z.tuple([
      safePathSchema,
      safePathSchema,
      z
        .object({
          entityType: z.enum(['doc', 'file', 'folder']).optional(),
          entityId: z.string().max(100).optional(),
          targetFolderId: z.string().max(100).optional(),
        })
        .optional(),
    ]),
  ],
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
    IpcChannel.AI_Chat,
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
  // 🔒 P1 fix: Supplement AI_ChatStream schema (same structure as AI_Chat)
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
  [
    IpcChannel.AI_Polish,
    z.tuple([
      safeStringSchema(100000), // text to polish
      z
        .string()
        .optional(), // knowledgeBaseId
    ]),
  ],
  [IpcChannel.AI_Completion, z.tuple([safeStringSchema(50000)])],
  [IpcChannel.AI_GenerateFormula, z.tuple([safeStringSchema(10000)])],
  [IpcChannel.AI_Review, z.tuple([safeStringSchema(500000)])], // Full document

  // ==================== Overleaf Operations ====================
  [
    IpcChannel.Overleaf_Init,
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
  [IpcChannel.Overleaf_TestConnection, z.tuple([safeUrlSchema])],
  [
    IpcChannel.Overleaf_Login,
    z.tuple([
      z.object({
        serverUrl: safeUrlSchema,
        email: z.string().email().optional(),
        password: z.string().max(500).optional(),
        cookies: z.string().max(10000).optional(),
      }),
    ]),
  ],
  [IpcChannel.Overleaf_GetProjectDetails, z.tuple([safeIdSchema])],
  [
    IpcChannel.Overleaf_UpdateSettings,
    z.tuple([
      safeIdSchema, // projectId
      z.object({
        compiler: z.enum(['pdflatex', 'xelatex', 'lualatex', 'latex']).optional(),
        rootDocId: z.string().max(100).optional(),
      }),
    ]),
  ],
  [
    IpcChannel.Overleaf_Compile,
    z.tuple([
      safeIdSchema, // projectId
      z
        .object({
          force: z.boolean().optional(),
          rootDocId: z.string().max(100).optional(),
        })
        .optional(),
    ]),
  ],
  [IpcChannel.Overleaf_StopCompile, z.tuple([safeIdSchema])],
  [
    IpcChannel.Overleaf_SyncCode,
    z.tuple([
      safeIdSchema, // projectId
      z
        .string()
        .max(1000), // file
      z
        .number()
        .int()
        .min(0), // line
      z
        .number()
        .int()
        .min(0), // column
      z
        .string()
        .max(100)
        .optional(), // buildId
    ]),
  ],
  [
    IpcChannel.Overleaf_SyncPdf,
    z.tuple([
      safeIdSchema, // projectId
      z
        .number()
        .int()
        .min(1), // page
      z
        .number()
        .min(0), // h
      z
        .number()
        .min(0), // v
      z
        .string()
        .max(100)
        .optional(), // buildId
    ]),
  ],
  [
    IpcChannel.Overleaf_GetDoc,
    z.tuple([
      safeIdSchema, // projectId
      z
        .string()
        .max(500), // docIdOrPath
      z
        .boolean()
        .optional(), // isPath
    ]),
  ],
  [
    IpcChannel.Overleaf_UpdateDoc,
    z.tuple([
      safeIdSchema, // projectId
      z
        .string()
        .max(100), // docId
      safeStringSchema(10 * 1024 * 1024), // content (10MB)
    ]),
  ],
  [
    IpcChannel.Overleaf_UpdateDocDebounced,
    z.tuple([safeIdSchema, z.string().max(100), safeStringSchema(10 * 1024 * 1024)]),
  ],
  [IpcChannel.Overleaf_FlushUpdates, z.tuple([safeIdSchema.optional()])],
  [IpcChannel.Overleaf_GetDocCached, z.tuple([safeIdSchema, z.string().max(100)])],
  [
    IpcChannel.Overleaf_ClearCache,
    z.tuple([safeIdSchema.optional(), z.string().max(100).optional()]),
  ],

  // ==================== Local Replica Operations ====================
  [
    IpcChannel.LocalReplica_Init,
    z.tuple([
      z.object({
        projectId: safeIdSchema,
        projectName: z.string().max(500),
        localPath: safePathSchema,
        enabled: z.boolean(),
        customIgnorePatterns: z.array(z.string().max(200)).optional(),
      }),
    ]),
  ],
  [IpcChannel.LocalReplica_GetConfig, z.tuple([])],
  [IpcChannel.LocalReplica_SetEnabled, z.tuple([z.boolean()])],
  [IpcChannel.LocalReplica_SyncFromRemote, z.tuple([])],
  [IpcChannel.LocalReplica_SyncToRemote, z.tuple([])],
  [IpcChannel.LocalReplica_StartWatching, z.tuple([])],
  [IpcChannel.LocalReplica_StopWatching, z.tuple([])],
  [IpcChannel.LocalReplica_IsWatching, z.tuple([])],

  // ==================== Knowledge Base Operations ====================
  [IpcChannel.Knowledge_GetLibrary, z.tuple([z.string().min(1)])],
  [IpcChannel.Knowledge_DeleteLibrary, z.tuple([z.string().min(1)])],
  [IpcChannel.Knowledge_GetDocument, z.tuple([z.string().min(1)])],
  [IpcChannel.Knowledge_DeleteDocument, z.tuple([z.string().min(1)])],
  [IpcChannel.Knowledge_GetDocuments, z.tuple([z.string().min(1)])],
  [
    IpcChannel.Knowledge_AddDocument,
    z.tuple([
      z
        .string()
        .min(1), // libraryId
      safePathSchema, // filePath
      z
        .object({
          bibKey: z.string().max(200).optional(),
          citationText: z.string().max(5000).optional(),
          metadata: z.record(z.string(), z.unknown()).optional(),
          processImmediately: z.boolean().optional(),
        })
        .optional(),
    ]),
  ],
  [
    IpcChannel.Knowledge_AddText,
    z.tuple([
      z
        .string()
        .min(1), // libraryId
      safeStringSchema(1024 * 1024), // content (1MB)
      z
        .object({
          title: z.string().max(500).optional(),
          mediaType: z.string().max(100).optional(),
          bibKey: z.string().max(200).optional(),
          metadata: z.record(z.string(), z.unknown()).optional(),
        })
        .optional(),
    ]),
  ],
  [
    IpcChannel.Knowledge_Search,
    z.tuple([
      z.object({
        query: z.string().min(1).max(10000),
        libraryIds: z.array(z.string()).max(50).optional(),
        topK: z.number().int().min(1).max(100).optional(),
        scoreThreshold: z.number().min(0).max(1).optional(),
      }),
    ]),
  ],
  [
    IpcChannel.Knowledge_Query,
    z.tuple([
      z
        .string()
        .min(1)
        .max(10000), // question
      z
        .array(z.string())
        .max(50)
        .optional(), // libraryIds
      z
        .object({
          topK: z.number().int().min(1).max(100).optional(),
          includeContext: z.boolean().optional(),
        })
        .optional(),
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
        polish: z
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
        rerank: z
          .object({ providerId: z.string().max(100), modelId: z.string().max(200) })
          .optional(),
        embedding: z
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

  // ==================== Knowledge Supplement (P0 fix) ====================
  // 🔒 Knowledge_Initialize/UpdateConfig - contains storagePath + API Key + BaseURL
  [
    IpcChannel.Knowledge_Initialize,
    z.tuple([
      z
        .object({
          storagePath: safePathSchema.optional(),
          embeddingProvider: z.string().max(50).optional(),
          embeddingApiKey: z.string().max(500).optional(),
          embeddingBaseUrl: safeUrlSchema.or(z.literal('')).optional(),
          embeddingModel: z.string().max(200).optional(),
          llmApiKey: z.string().max(500).optional(),
          llmBaseUrl: safeUrlSchema.or(z.literal('')).optional(),
          llmModel: z.string().max(200).optional(),
          vlmProvider: z.string().max(50).optional(),
          vlmApiKey: z.string().max(500).optional(),
          vlmBaseUrl: safeUrlSchema.or(z.literal('')).optional(),
          vlmModel: z.string().max(200).optional(),
          whisperApiKey: z.string().max(500).optional(),
          whisperBaseUrl: safeUrlSchema.or(z.literal('')).optional(),
          whisperModel: z.string().max(200).optional(),
          whisperLanguage: z.string().max(10).optional(),
          visionApiKey: z.string().max(500).optional(),
        })
        .optional(),
    ]),
  ],
  [
    IpcChannel.Knowledge_UpdateConfig,
    z.tuple([
      z.object({
        storagePath: safePathSchema.optional(),
        embeddingProvider: z.string().max(50).optional(),
        embeddingApiKey: z.string().max(500).optional(),
        embeddingBaseUrl: safeUrlSchema.or(z.literal('')).optional(),
        embeddingModel: z.string().max(200).optional(),
        llmApiKey: z.string().max(500).optional(),
        llmBaseUrl: safeUrlSchema.or(z.literal('')).optional(),
        llmModel: z.string().max(200).optional(),
        vlmProvider: z.string().max(50).optional(),
        vlmApiKey: z.string().max(500).optional(),
        vlmBaseUrl: safeUrlSchema.or(z.literal('')).optional(),
        vlmModel: z.string().max(200).optional(),
        whisperApiKey: z.string().max(500).optional(),
        whisperBaseUrl: safeUrlSchema.or(z.literal('')).optional(),
        whisperModel: z.string().max(200).optional(),
        whisperLanguage: z.string().max(10).optional(),
        visionApiKey: z.string().max(500).optional(),
      }),
    ]),
  ],
  [
    IpcChannel.Knowledge_CreateLibrary,
    z.tuple([
      z.object({
        name: z.string().min(1).max(200),
        description: z.string().max(2000).optional(),
        chunkingConfig: z
          .object({
            chunkSize: z.number().int().min(100).max(10000).optional(),
            chunkOverlap: z.number().int().min(0).max(1000).optional(),
            separators: z.array(z.string().max(100)).max(20).optional(),
            enableMultimodal: z.boolean().optional(),
          })
          .optional(),
        embeddingConfig: z
          .object({
            provider: z.enum(['openai', 'ollama', 'local']).optional(),
            model: z.string().max(200).optional(),
            dimensions: z.number().int().min(64).max(4096).optional(),
            baseUrl: safeUrlSchema.or(z.literal('')).optional(),
            apiKey: z.string().max(500).optional(),
          })
          .optional(),
        retrievalConfig: z
          .object({
            retrieverType: z.enum(['vector', 'keyword', 'hybrid']).optional(),
            vectorWeight: z.number().min(0).max(1).optional(),
            keywordWeight: z.number().min(0).max(1).optional(),
            topK: z.number().int().min(1).max(100).optional(),
            scoreThreshold: z.number().min(0).max(1).optional(),
            enableRerank: z.boolean().optional(),
          })
          .optional(),
      }),
    ]),
  ],
  [
    IpcChannel.Knowledge_UpdateLibrary,
    z.tuple([
      z
        .string()
        .min(1)
        .max(256), // id
      z.object({
        name: z.string().min(1).max(200).optional(),
        description: z.string().max(2000).optional(),
      }),
    ]),
  ],
  // Knowledge base channels with no parameters
  [IpcChannel.Knowledge_GetLibraries, z.tuple([])],
  [
    IpcChannel.Knowledge_ReprocessDocument,
    z.tuple([z.string().min(1).max(256)]), // documentId
  ],
  [
    IpcChannel.Knowledge_SearchEnhanced,
    z.tuple([
      z.object({
        query: z.string().min(1).max(10000),
        libraryIds: z.array(z.string().max(256)).max(50).optional(),
        topK: z.number().int().min(1).max(100).optional(),
        scoreThreshold: z.number().min(0).max(1).optional(),
        retrieverType: z.enum(['vector', 'keyword', 'hybrid']).optional(),
        enableQueryRewrite: z.boolean().optional(),
        enableRerank: z.boolean().optional(),
        enableContextRouting: z.boolean().optional(),
        conversationHistory: z
          .array(
            z.object({
              role: z.string().max(50),
              content: safeStringSchema(50000),
            })
          )
          .max(50)
          .optional(),
      }),
    ]),
  ],
  [IpcChannel.Knowledge_TestEmbedding, z.tuple([])],
  [
    IpcChannel.Knowledge_Diagnostics,
    z.tuple([z.string().max(256).optional()]), // libraryId
  ],
  [IpcChannel.Knowledge_RebuildFTS, z.tuple([])],
  [
    IpcChannel.Knowledge_GenerateEmbeddings,
    z.tuple([z.string().max(256).optional()]), // libraryId
  ],
  [IpcChannel.Knowledge_GetAdvancedConfig, z.tuple([])],
  [
    IpcChannel.Knowledge_SetAdvancedConfig,
    z.tuple([
      z.object({
        enableQueryRewrite: z.boolean().optional(),
        enableRerank: z.boolean().optional(),
        enableContextRouting: z.boolean().optional(),
        enableBilingualSearch: z.boolean().optional(),
        rerankProvider: z
          .enum([
            'dashscope',
            'openai',
            'cohere',
            'jina',
            'local',
            'siliconflow',
            'aihubmix',
            'custom',
          ])
          .optional(),
        rerankModel: z.string().max(200).optional(),
        rerankApiKey: z.string().max(500).optional(),
        rerankBaseUrl: safeUrlSchema.or(z.literal('')).optional(),
      }),
    ]),
  ],
  [
    IpcChannel.Knowledge_SelectFiles,
    z.tuple([
      z
        .object({
          mediaTypes: z.array(z.string().max(50)).max(10).optional(),
          multiple: z.boolean().optional(),
        })
        .optional(),
    ]),
  ],
  [
    IpcChannel.Knowledge_GetTask,
    z.tuple([z.string().min(1).max(256)]), // taskId
  ],
  [IpcChannel.Knowledge_GetQueueStats, z.tuple([])],

  // ==================== Agent Tools Operations ====================
  // 🔒 All path parameters must use safePathSchema validation
  [IpcChannel.Agent_GetAvailable, z.tuple([])],
  [
    IpcChannel.Agent_PDF2LaTeX,
    z.tuple([
      safePathSchema, // inputFile
      z
        .object({
          outputFile: safePathSchema.optional(),
          concurrent: z.number().int().min(1).max(16).optional(),
          timeout: z.number().int().min(1000).max(3600000).optional(), // 1s - 1h
        })
        .optional(),
    ]),
  ],
  [
    IpcChannel.Agent_Review,
    z.tuple([
      safePathSchema, // inputFile
      z
        .number()
        .int()
        .min(1000)
        .max(3600000)
        .optional(), // timeout: 1s - 1h
    ]),
  ],
  [
    IpcChannel.Agent_Paper2Beamer,
    z.tuple([
      safePathSchema, // inputFile
      z
        .object({
          duration: z.number().int().min(1).max(120).optional(), // 1-120 minutes
          template: z.string().max(256).optional(),
          output: safePathSchema.optional(),
          timeout: z.number().int().min(1000).max(3600000).optional(),
        })
        .optional(),
    ]),
  ],
  [IpcChannel.Agent_ListTemplates, z.tuple([])],
  [IpcChannel.Agent_Kill, z.tuple([])],
  [
    IpcChannel.Agent_SyncVLMConfig,
    z.tuple([
      z.object({
        provider: z.string().max(100),
        model: z.string().max(200),
        apiKey: z.string().max(500),
        baseUrl: safeUrlSchema.or(z.literal('')),
        timeout: z.number().int().positive().max(600000).optional(),
        maxTokens: z.number().int().positive().max(128000).optional(),
        temperature: z.number().min(0).max(2).optional(),
      }),
    ]),
  ],
  [
    IpcChannel.Agent_CreateTempFile,
    z.tuple([
      z
        .string()
        .min(1)
        .max(256)
        .regex(/^[a-zA-Z0-9._-]+$/), // safe file name
      safeStringSchema(10 * 1024 * 1024), // content: max 10MB
    ]),
  ],

  // ==================== Selection (P0 fix) ====================
  // 🔒 Selection_AddToKnowledge - can write arbitrary text to knowledge base
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
        defaultLibraryId: z.string().max(256).optional(),
      }),
    ]),
  ],
  [IpcChannel.Selection_GetText, z.tuple([])],
  [
    IpcChannel.Selection_ShowActionWindow,
    z.tuple([
      z
        .object({
          text: safeStringSchema(100000),
          sourceApp: z.string().max(200).optional(),
          capturedAt: z.string().max(50).optional(),
          cursorPosition: z
            .object({
              x: z.number(),
              y: z.number(),
            })
            .optional(),
        })
        .optional(),
    ]),
  ],
  [IpcChannel.Selection_HideActionWindow, z.tuple([])],
  [IpcChannel.Selection_HideToolbar, z.tuple([])],
  [
    IpcChannel.Selection_AddToKnowledge,
    z.tuple([
      z.object({
        libraryId: z.string().min(1).max(256),
        text: safeStringSchema(1024 * 1024), // 1MB
        note: z.string().max(10000).optional(),
        metadata: z
          .object({
            sourceApp: z.string().max(200).optional(),
            capturedAt: z.string().max(50).optional(),
            tags: z.array(z.string().max(100)).max(50).optional(),
          })
          .optional(),
      }),
    ]),
  ],

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
      z.enum(['debug', 'info', 'warn', 'error']), // level
      z
        .string()
        .max(100), // category
      safeStringSchema(10000), // message
      z
        .unknown()
        .optional(), // details
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
  [IpcChannel.LSP_RequestDirectChannel, z.tuple([])],

  // ==================== Overleaf Supplement (P1 fix) ====================
  [IpcChannel.Overleaf_IsLoggedIn, z.tuple([])],
  [IpcChannel.Overleaf_GetCookies, z.tuple([])],
  [IpcChannel.Overleaf_GetProjects, z.tuple([])],
  [IpcChannel.Overleaf_GetBuildId, z.tuple([safeIdSchema])], // projectId

  // ==================== Typst (P1 fix) ====================
  [IpcChannel.Typst_Available, z.tuple([])],
  [IpcChannel.Compile_GetStatus, z.tuple([])],
]);

// ==================== Type Definitions ====================

/**
 * IPC handler function type
 * Receives channel parameters, returns channel result
 */
export type IPCHandler<T extends IPCInvokeChannel> = (
  event: IpcMainInvokeEvent,
  ...args: IPCArgs<T>
) => Promise<IPCResult<T>> | IPCResult<T>;

/**
 * Handler type without event parameter (more concise API)
 */
export type IPCHandlerWithoutEvent<T extends IPCInvokeChannel> = (
  ...args: IPCArgs<T>
) => Promise<IPCResult<T>> | IPCResult<T>;

/**
 * Handler registration options
 */
export interface HandlerOptions {
  /** Whether to log errors when handler fails */
  logErrors?: boolean;
  /** Custom error handling */
  onError?: (channel: string, error: unknown) => void;
  /**
   * Custom validation schema for this handler
   * Overrides the schema in channelSchemas if provided
   */
  schema?: z.ZodSchema;
  /**
   * Skip runtime validation even if a schema exists
   * @default false
   */
  skipValidation?: boolean;
}

// ==================== Core Functions ====================

/**
 * Register type-safe IPC handler
 *
 * @param channel - IPC channel (must be defined in IPCApiContract)
 * @param handler - Handler function
 * @param options - Optional configuration
 *
 * @example
 * registerTypedHandler(IpcChannel.Compile_LaTeX, async (event, content, options) => {
 *   const result = await compileLatex(content, options);
 *   return result;
 * });
 *
 * // With custom validation schema
 * registerTypedHandler(IpcChannel.Custom_Channel, handler, {
 *   schema: z.tuple([z.string(), z.number()]),
 * });
 */
export function registerTypedHandler<T extends IPCInvokeChannel>(
  channel: T,
  handler: IPCHandler<T>,
  options?: HandlerOptions
): void {
  const { logErrors = true, onError, schema, skipValidation = false } = options ?? {};

  // Determine which schema to use: explicit > registry > none
  const validationSchema = schema ?? (skipValidation ? undefined : channelSchemas.get(channel));

  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    try {
      // Runtime parameter validation (if schema is defined)
      if (validationSchema) {
        const validationResult = validationSchema.safeParse(args);
        if (!validationResult.success) {
          const validationError = new IPCValidationError(channel, validationResult.error);
          console.error(
            `[IPC] Validation failed for '${channel}':`,
            validationResult.error.format()
          );
          throw validationError;
        }
      }

      // Execute handler with validated arguments
      return await handler(event, ...(args as IPCArgs<T>));
    } catch (error) {
      if (logErrors) {
        console.error(`[IPC] Error in handler '${channel}':`, error);
      }
      if (onError) {
        onError(channel, error);
      }
      throw error;
    }
  });
}

/**
 * Register type-safe IPC handler (version without event parameter)
 *
 * Most handlers don't need the event parameter, this version is more concise
 *
 * @example
 * registerHandler(IpcChannel.Compile_LaTeX, async (content, options) => {
 *   return await compileLatex(content, options);
 * });
 */
export function registerHandler<T extends IPCInvokeChannel>(
  channel: T,
  handler: IPCHandlerWithoutEvent<T>,
  options?: HandlerOptions
): void {
  registerTypedHandler(channel, (_event, ...args) => handler(...args), options);
}

// ==================== Batch Registration ====================

/**
 * Handler map type
 */
export type HandlersMap = {
  [K in IPCInvokeChannel]?: IPCHandlerWithoutEvent<K>;
};

/**
 * Create type-safe handler collection
 *
 * @example
 * const handlers = createTypedHandlers({
 *   [IpcChannel.Compile_LaTeX]: async (content, options) => {
 *     return await compileLatex(content, options);
 *   },
 *   [IpcChannel.Compile_Typst]: async (content, options) => {
 *     return await compileTypst(content, options);
 *   },
 * });
 *
 * // Register all handlers
 * handlers.registerAll();
 *
 * // Or register individually
 * handlers.register(IpcChannel.Compile_LaTeX);
 */
export function createTypedHandlers<T extends HandlersMap>(
  handlers: T,
  options?: HandlerOptions
): {
  /** Register all handlers */
  registerAll: () => void;
  /** Register single handler */
  register: <K extends keyof T & IPCInvokeChannel>(channel: K) => void;
  /** Get list of registered channels */
  channels: (keyof T)[];
} {
  const channels = Object.keys(handlers) as (keyof T)[];

  return {
    registerAll: () => {
      for (const channel of channels) {
        const handler = handlers[channel];
        if (handler) {
          registerHandler(
            channel as IPCInvokeChannel,
            handler as IPCHandlerWithoutEvent<IPCInvokeChannel>,
            options
          );
        }
      }
    },
    register: <K extends keyof T & IPCInvokeChannel>(channel: K) => {
      const handler = handlers[channel];
      if (handler) {
        registerHandler(channel, handler as IPCHandlerWithoutEvent<K>, options);
      }
    },
    channels,
  };
}

// ==================== Unregistration ====================

/**
 * Unregister IPC handler
 */
export function unregisterHandler(channel: IPCInvokeChannel): void {
  ipcMain.removeHandler(channel);
}

/**
 * Unregister multiple handlers
 */
export function unregisterHandlers(channels: IPCInvokeChannel[]): void {
  for (const channel of channels) {
    unregisterHandler(channel);
  }
}

// ==================== Factory Functions ====================

/**
 * Create handler factory with dependency injection
 *
 * @example
 * interface CompileDeps {
 *   latexCompiler: LaTeXCompiler;
 *   typstCompiler: TypstCompiler;
 * }
 *
 * const createCompileHandlers = createHandlerFactory<CompileDeps>((deps) => ({
 *   [IpcChannel.Compile_LaTeX]: async (content, options) => {
 *     return await deps.latexCompiler.compile(content, options);
 *   },
 *   [IpcChannel.Compile_Typst]: async (content, options) => {
 *     return await deps.typstCompiler.compile(content, options);
 *   },
 * }));
 *
 * // Usage
 * const handlers = createCompileHandlers({ latexCompiler, typstCompiler });
 * handlers.registerAll();
 */
export function createHandlerFactory<TDeps>(
  factory: (deps: TDeps) => HandlersMap
): (deps: TDeps, options?: HandlerOptions) => ReturnType<typeof createTypedHandlers> {
  return (deps: TDeps, options?: HandlerOptions) => {
    const handlers = factory(deps);
    return createTypedHandlers(handlers, options);
  };
}
