/**
 * @file IPC Type Definitions
 * @description Type-safe IPC communication types for main/renderer processes
 * @depends types/provider, types/chat
 *
 * Naming conventions:
 * - *DTO suffix for Data Transfer Objects
 * - Dates use ISO 8601 string format (e.g., "2024-01-10T12:00:00.000Z")
 */

// ====== Base Types ======

export type IPCChannel = keyof IPCHandlers;
export type IPCEventChannel = keyof IPCEvents;

// ====== File Operations ======

export interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileTreeNode[];
  /** Whether directory children have been resolved (lazy loading flag) */
  isResolved?: boolean;
}

export interface FileStats {
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  mtime: string;
  ctime: string;
}

export interface SelectedFile {
  path: string;
  name: string;
  ext: string;
  content: Uint8Array;
}

export interface FileFilter {
  name: string;
  extensions: string[];
}

// ====== LaTeX Compilation ======

export interface LaTeXCompileOptions {
  engine?: 'tectonic' | 'pdflatex' | 'xelatex' | 'lualatex';
  outputDir?: string;
  synctex?: boolean;
  mainFile?: string;
  projectPath?: string;
}

export interface LaTeXCompileResult {
  success: boolean;
  pdfPath?: string;
  pdfData?: string;
  synctexPath?: string;
  errors?: LaTeXError[];
  warnings?: LaTeXWarning[];
  log?: string;
}

export interface LaTeXError {
  line?: number;
  column?: number;
  file?: string;
  message: string;
  severity: 'error' | 'fatal';
}

export interface LaTeXWarning {
  line?: number;
  column?: number;
  file?: string;
  message: string;
  type: 'underfull' | 'overfull' | 'citation' | 'reference' | 'other';
}

// ====== SyncTeX ======

export interface SyncTeXForwardResult {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SyncTeXBackwardResult {
  file: string;
  line: number;
  column: number;
}

// ====== Agent Tools ======

export type AgentToolId = 'pdf2latex' | 'review' | 'paper2beamer';

export interface AgentAvailability {
  pdf2latex: boolean;
  reviewer: boolean;
  paper2beamer: boolean;
}

export interface AgentResult {
  success: boolean;
  message: string;
  data?: AgentResultData;
  error?: string;
}

export interface AgentResultData {
  outputPath?: string;
  outputDir?: string;
  reviewPath?: string;
  texPath?: string;
  templates?: string[];
  [key: string]: unknown;
}

export interface AgentProgress {
  type: AgentToolId;
  message: string;
  progress: number;
}

export interface Pdf2LatexConfig {
  outputFile?: string;
  concurrent?: number;
  timeout?: number;
}

export interface Paper2BeamerConfig {
  duration?: number;
  template?: string;
  output?: string;
  timeout?: number;
}

// ====== Knowledge Base ======

export interface KnowledgeBaseInfo {
  id: string;
  name: string;
  description?: string;
  documentCount: number;
  createdAt: string;
  updatedAt: string;
  provider: 'local' | 'autorag';
}

// ====== Overleaf ======

export interface OverleafConfig {
  serverUrl: string;
  email?: string;
  password?: string;
  cookies?: string;
}

export interface OverleafProjectDTO {
  id: string;
  name: string;
  lastUpdated?: string;
  accessLevel?: string;
}

export interface OverleafCompileOptions {
  compiler?: string;
  draft?: boolean;
}

export interface ParsedLogEntry {
  line: number | null;
  file: string;
  level: 'error' | 'warning' | 'info';
  message: string;
  content: string;
  raw: string;
}

export interface OverleafCompileResultDTO {
  success: boolean;
  status: string;
  pdfData?: string;
  pdfUrl?: string;
  logUrl?: string;
  logContent?: string;
  buildId?: string;
  errors?: string[];
  parsedErrors?: ParsedLogEntry[];
  parsedWarnings?: ParsedLogEntry[];
  parsedInfo?: ParsedLogEntry[];
}

// ====== Knowledge Base V2 ======

export type MediaType = 'pdf' | 'audio' | 'image' | 'markdown' | 'text' | 'latex' | 'url';
export type ProcessStatus = 'pending' | 'processing' | 'completed' | 'failed';
export type RetrieverType = 'vector' | 'keyword' | 'hybrid';
export type EmbeddingProvider = 'openai' | 'ollama' | 'local';

export interface ChunkingConfigDTO {
  chunkSize: number;
  chunkOverlap: number;
  separators: string[];
  enableMultimodal: boolean;
}

export interface EmbeddingConfigDTO {
  provider: EmbeddingProvider;
  model: string;
  dimensions: number;
  baseUrl?: string;
  apiKey?: string;
}

export interface RetrievalConfigDTO {
  retrieverType: RetrieverType;
  vectorWeight: number;
  keywordWeight: number;
  topK: number;
  scoreThreshold: number;
  enableRerank: boolean;
}

export interface KnowledgeLibraryDTO {
  id: string;
  name: string;
  description?: string;
  chunkingConfig: ChunkingConfigDTO;
  embeddingConfig: EmbeddingConfigDTO;
  retrievalConfig: RetrievalConfigDTO;
  documentCount: number;
  chunkCount: number;
  totalSize: number;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeDocumentDTO {
  id: string;
  libraryId: string;
  filename: string;
  filePath: string;
  fileSize: number;
  fileHash: string;
  mediaType: MediaType;
  mimeType: string;
  bibKey?: string;
  citationText?: string;
  processStatus: ProcessStatus;
  processedAt?: string;
  errorMessage?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/**
 * Metadata for a document chunk
 * Uses typed `extra` field for additional properties instead of open index signature
 */
export interface ChunkMetadataDTO {
  page?: number;
  section?: string;
  startTime?: number;
  endTime?: number;
  speaker?: string;
  imagePath?: string;
  extra?: Record<string, string | number | boolean | null>;
}

export interface KnowledgeSearchResultDTO {
  chunkId: string;
  documentId: string;
  libraryId: string;
  content: string;
  score: number;
  mediaType: MediaType;
  filename: string;
  bibKey?: string;
  citationText?: string;
  chunkMetadata: ChunkMetadataDTO;
  highlights?: string[];
}

export interface KnowledgeCitationDTO {
  id: string;
  bibKey: string;
  text: string;
  source: string;
  page?: number;
  timestamp?: number;
}

export interface KnowledgeRAGResponseDTO {
  answer: string;
  sources: KnowledgeSearchResultDTO[];
  citations: KnowledgeCitationDTO[];
  context: string;
}

export interface AdvancedRetrievalConfigDTO {
  enableQueryRewrite: boolean;
  enableRerank: boolean;
  enableContextRouting: boolean;
  enableBilingualSearch: boolean;
  rerankProvider?:
    | 'dashscope'
    | 'openai'
    | 'cohere'
    | 'jina'
    | 'local'
    | 'siliconflow'
    | 'aihubmix'
    | 'custom';
  rerankModel?: string;
  rerankApiKey?: string;
  rerankBaseUrl?: string;
}

export interface RewrittenQueryDTO {
  original: string;
  english: string;
  chinese: string;
  keywords: string[];
  originalLanguage: 'en' | 'zh' | 'mixed';
}

export interface ContextDecisionDTO {
  contextType: 'full' | 'partial' | 'none';
  reason: string;
  suggestedChunkCount: number;
  needsMultiDocument: boolean;
}

export interface EnhancedSearchResultDTO {
  results: KnowledgeSearchResultDTO[];
  rewrittenQuery?: RewrittenQueryDTO;
  contextDecision?: ContextDecisionDTO;
  processingTime: number;
}

export interface KnowledgeInitOptions {
  storagePath?: string;
  embeddingProvider?: string;
  embeddingApiKey?: string;
  embeddingBaseUrl?: string;
  embeddingModel?: string;
  llmApiKey?: string;
  llmBaseUrl?: string;
  llmModel?: string;
  vlmProvider?: string;
  vlmApiKey?: string;
  vlmBaseUrl?: string;
  vlmModel?: string;
  whisperApiKey?: string;
  whisperBaseUrl?: string;
  whisperModel?: string;
  whisperLanguage?: string;
  /** @deprecated Use vlmApiKey instead */
  visionApiKey?: string;
}

export interface KnowledgeTaskStatusDTO {
  id: string;
  type: string;
  status: string;
  progress: number;
  message?: string;
  error?: string;
}

export interface KnowledgeQueueStatsDTO {
  pending: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
}

export interface KnowledgeDiagnosticsDTO {
  totalChunks: number;
  totalEmbeddings: number;
  ftsRecords: number;
  embeddingDimensions: number[];
  libraryStats: Array<{ libraryId: string; chunks: number; embeddings: number }>;
}

// ====== AI Provider Configuration ======

import type { ModelInfo, ModelSelection, ProviderId, SelectedModels } from '../types/provider';

export interface AIProviderDTO {
  id: ProviderId;
  name: string;
  apiKey: string;
  apiHost: string;
  defaultApiHost?: string;
  enabled: boolean;
  isSystem?: boolean;
  models: ModelInfo[];
  website?: string;
  anthropicApiHost?: string;
  timeout?: number;
  rateLimit?: number;
}

export interface AIConfigDTO {
  providers: AIProviderDTO[];
  selectedModels: SelectedModels;
}

export type { ModelInfo, ModelSelection, ProviderId, SelectedModels };

// ====== IPC Events ======

export interface KnowledgeEventDTO {
  type: string;
  timestamp: number;
  data: unknown;
}

// ====== IPC Handlers ======

export interface IPCHandlers {
  // Project Management
  'open-project': {
    params: [];
    result: { projectPath: string; fileTree: FileTreeNode } | null;
  };

  // File Operations
  'read-file': {
    params: [filePath: string];
    result: string;
  };
  'write-file': {
    params: [filePath: string, content: string];
    result: void;
  };
  'create-file': {
    params: [filePath: string, content?: string];
    result: { success: boolean; path: string };
  };
  'create-folder': {
    params: [folderPath: string];
    result: { success: boolean; path: string };
  };
  'delete-file': {
    params: [filePath: string];
    result: { success: boolean };
  };
  'rename-file': {
    params: [oldPath: string, newPath: string];
    result: { success: boolean; newPath: string };
  };
  'copy-file': {
    params: [srcPath: string, destPath: string];
    result: { success: boolean; destPath: string };
  };
  'move-file': {
    params: [srcPath: string, destPath: string];
    result: { success: boolean; destPath: string };
  };
  'refresh-file-tree': {
    params: [projectPath: string];
    result: { success: boolean; fileTree: FileTreeNode };
  };
  'path-exists': {
    params: [filePath: string];
    result: boolean;
  };
  'get-file-stats': {
    params: [filePath: string];
    result: FileStats;
  };
  'show-item-in-folder': {
    params: [filePath: string];
    result: { success: boolean };
  };
  'select-files': {
    params: [options?: { filters?: FileFilter[]; multiple?: boolean }];
    result: SelectedFile[] | null;
  };

  // LaTeX Compilation
  'compile-latex': {
    params: [content: string, options?: LaTeXCompileOptions];
    result: LaTeXCompileResult;
  };

  // SyncTeX
  'synctex-forward': {
    params: [texFile: string, line: number, column: number, pdfFile: string];
    result: SyncTeXForwardResult | null;
  };
  'synctex-backward': {
    params: [pdfFile: string, page: number, x: number, y: number];
    result: SyncTeXBackwardResult | null;
  };

  // External Links
  'open-external': {
    params: [url: string];
    result: void;
  };

  // App Info
  'get-app-version': {
    params: [];
    result: string;
  };
  'get-platform': {
    params: [];
    result: NodeJS.Platform;
  };

  // Overleaf
  'overleaf:init': {
    params: [config: OverleafConfig];
    result: { success: boolean };
  };
  'overleaf:test-connection': {
    params: [serverUrl: string];
    result: { success: boolean; message: string };
  };
  'overleaf:login': {
    params: [config: OverleafConfig];
    result: { success: boolean; message: string; userId?: string };
  };
  'overleaf:get-projects': {
    params: [];
    result: { success: boolean; projects?: OverleafProjectDTO[]; message?: string };
  };
  'overleaf:compile': {
    params: [projectId: string, options?: OverleafCompileOptions];
    result: OverleafCompileResultDTO;
  };
  'overleaf:stop-compile': {
    params: [projectId: string];
    result: boolean;
  };
  'overleaf:is-logged-in': {
    params: [];
    result: boolean;
  };
  'overleaf:get-cookies': {
    params: [];
    result: string | null;
  };

  // Knowledge Base
  'knowledge:initialize': {
    params: [options: KnowledgeInitOptions];
    result: boolean;
  };
  'knowledge:update-config': {
    params: [options: Partial<KnowledgeInitOptions>];
    result: { success: boolean; error?: string };
  };
  'knowledge:create-library': {
    params: [
      params: {
        name: string;
        description?: string;
        chunkingConfig?: Partial<ChunkingConfigDTO>;
        embeddingConfig?: Partial<EmbeddingConfigDTO>;
        retrievalConfig?: Partial<RetrievalConfigDTO>;
      },
    ];
    result: KnowledgeLibraryDTO;
  };
  'knowledge:get-libraries': {
    params: [];
    result: KnowledgeLibraryDTO[];
  };
  'knowledge:get-library': {
    params: [id: string];
    result: KnowledgeLibraryDTO | null;
  };
  'knowledge:update-library': {
    params: [id: string, updates: Partial<KnowledgeLibraryDTO>];
    result: boolean;
  };
  'knowledge:delete-library': {
    params: [id: string];
    result: boolean;
  };
  'knowledge:add-document': {
    params: [
      libraryId: string,
      filePath: string,
      options?: {
        bibKey?: string;
        citationText?: string;
        metadata?: Record<string, unknown>;
        processImmediately?: boolean;
      },
    ];
    result: KnowledgeDocumentDTO;
  };
  'knowledge:add-text': {
    params: [
      libraryId: string,
      content: string,
      options?: {
        title?: string;
        mediaType?: MediaType;
        bibKey?: string;
        metadata?: Record<string, unknown>;
      },
    ];
    result: KnowledgeDocumentDTO;
  };
  'knowledge:get-document': {
    params: [id: string];
    result: KnowledgeDocumentDTO | null;
  };
  'knowledge:get-documents': {
    params: [libraryId: string];
    result: KnowledgeDocumentDTO[];
  };
  'knowledge:delete-document': {
    params: [id: string];
    result: boolean;
  };
  'knowledge:reprocess-document': {
    params: [documentId: string];
    result: { success: boolean; taskId?: string };
  };
  'knowledge:search': {
    params: [
      options: {
        query: string;
        libraryIds?: string[];
        topK?: number;
        scoreThreshold?: number;
        retrieverType?: RetrieverType;
      },
    ];
    result: KnowledgeSearchResultDTO[];
  };
  'knowledge:query': {
    params: [
      question: string,
      libraryIds?: string[],
      options?: {
        topK?: number;
        includeContext?: boolean;
      },
    ];
    result: KnowledgeRAGResponseDTO;
  };
  'knowledge:get-task': {
    params: [taskId: string];
    result: KnowledgeTaskStatusDTO | undefined;
  };
  'knowledge:get-queue-stats': {
    params: [];
    result: KnowledgeQueueStatsDTO;
  };
  'knowledge:test-embedding': {
    params: [];
    result: { success: boolean; message: string; dimensions?: number };
  };
  'knowledge:diagnostics': {
    params: [libraryId?: string];
    result: KnowledgeDiagnosticsDTO;
  };
  'knowledge:rebuild-fts': {
    params: [];
    result: { success: boolean; recordCount: number };
  };
  'knowledge:generate-embeddings': {
    params: [libraryId?: string];
    result: { success: boolean; generated: number; errors: number };
  };
  'knowledge:get-advanced-config': {
    params: [];
    result: AdvancedRetrievalConfigDTO;
  };
  'knowledge:set-advanced-config': {
    params: [config: Partial<AdvancedRetrievalConfigDTO>];
    result: { success: boolean };
  };
  'knowledge:search-enhanced': {
    params: [
      options: {
        query: string;
        libraryIds?: string[];
        topK?: number;
        scoreThreshold?: number;
        retrieverType?: RetrieverType;
        enableQueryRewrite?: boolean;
        enableRerank?: boolean;
        enableContextRouting?: boolean;
        conversationHistory?: Array<{ role: string; content: string }>;
      },
    ];
    result: EnhancedSearchResultDTO;
  };
  'knowledge:select-files': {
    params: [options?: { mediaTypes?: string[]; multiple?: boolean }];
    result: string[] | null;
  };
}

// ====== IPC Events ======

export interface IPCEvents {
  'main-process-message': string;
  'knowledge:event': KnowledgeEventDTO;
}

// ====== Type Utilities ======

export type IPCParams<T extends IPCChannel> = IPCHandlers[T]['params'];
export type IPCResult<T extends IPCChannel> = IPCHandlers[T]['result'];
export type IPCEventData<T extends IPCEventChannel> = IPCEvents[T];

// ====== Backward Compatibility Aliases ======

/** @deprecated Use KnowledgeLibraryDTO instead */
export type KnowledgeLibrary = KnowledgeLibraryDTO;
/** @deprecated Use KnowledgeDocumentDTO instead */
export type KnowledgeDocument = KnowledgeDocumentDTO;
/** @deprecated Use OverleafProjectDTO instead */
export type OverleafProject = OverleafProjectDTO;
/** @deprecated Use OverleafCompileResultDTO instead */
export type OverleafCompileResult = OverleafCompileResultDTO;
/** @deprecated Use KnowledgeSearchResultDTO instead */
export type KnowledgeSearchResult = KnowledgeSearchResultDTO;
/** @deprecated Use KnowledgeTaskStatusDTO instead */
export type KnowledgeTaskStatus = KnowledgeTaskStatusDTO;
/** @deprecated Use ChunkingConfigDTO instead */
export type ChunkingConfig = ChunkingConfigDTO;
/** @deprecated Use EmbeddingConfigDTO instead */
export type EmbeddingConfig = EmbeddingConfigDTO;
/** @deprecated Use RetrievalConfigDTO instead */
export type RetrievalConfig = RetrievalConfigDTO;
/** @deprecated Use ChunkMetadataDTO instead */
export type ChunkMetadata = ChunkMetadataDTO;
/** @deprecated Use KnowledgeQueueStatsDTO instead */
export type KnowledgeQueueStats = KnowledgeQueueStatsDTO;
/** @deprecated Use KnowledgeDiagnosticsDTO instead */
export type KnowledgeDiagnostics = KnowledgeDiagnosticsDTO;
/** @deprecated Use KnowledgeRAGResponseDTO instead */
export type KnowledgeRAGResponse = KnowledgeRAGResponseDTO;
/** @deprecated Use EnhancedSearchResultDTO instead */
export type EnhancedSearchResult = EnhancedSearchResultDTO;
/** @deprecated Use AdvancedRetrievalConfigDTO instead */
export type AdvancedRetrievalConfig = AdvancedRetrievalConfigDTO;
/** @deprecated Use KnowledgeEventDTO instead */
export type KnowledgeEvent = KnowledgeEventDTO;
/** @deprecated Use KnowledgeCitationDTO instead */
export type KnowledgeCitation = KnowledgeCitationDTO;
/** @deprecated Use RewrittenQueryDTO instead */
export type RewrittenQuery = RewrittenQueryDTO;
/** @deprecated Use ContextDecisionDTO instead */
export type ContextDecision = ContextDecisionDTO;

// ====== Selection Assistant Types ======

export type SelectionTriggerMode = 'shortcut' | 'hook';

export interface SelectionCaptureDTO {
  text: string;
  sourceApp?: string;
  capturedAt: string;
  cursorPosition?: { x: number; y: number };
}

export interface SelectionAddToKnowledgeDTO {
  libraryId: string;
  text: string;
  note?: string;
  metadata?: {
    sourceApp?: string;
    capturedAt?: string;
    tags?: string[];
  };
}

export interface SelectionConfigDTO {
  enabled: boolean;
  triggerMode: SelectionTriggerMode;
  shortcutKey: string;
  defaultLibraryId?: string;
}
