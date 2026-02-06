/**
 * @file IKnowledgeService - Knowledge service contract
 * @description Public interface for knowledge base operations used by IPC
 * @depends KnowledgeService
 */

import type { IDisposable } from '../ServiceContainer';

/**
 * Knowledge base.
 */
export interface KnowledgeBase {
  id: string;
  name: string;
  description?: string;
  documentCount: number;
  chunkCount?: number;
  chunkingConfig?: ChunkingConfig;
  embeddingConfig?: EmbeddingConfig;
  retrievalConfig?: RetrievalConfig;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Document.
 * @note Field names align with types.ts and database column names
 */
export interface Document {
  id: string;
  libraryId: string;

  // File info
  filename: string;
  filePath: string;
  fileSize: number;
  fileHash: string;
  mediaType: 'pdf' | 'audio' | 'image' | 'markdown' | 'text' | 'latex' | 'url';
  mimeType: string;

  // Citation info
  bibKey?: string;
  citationText?: string;

  // Processing state
  processStatus: 'pending' | 'processing' | 'completed' | 'failed';
  processedAt?: number;
  errorMessage?: string;

  // Metadata
  metadata: DocumentMetadata;

  // Timestamps (Unix)
  createdAt: number;
  updatedAt: number;
}

/**
 * Document metadata.
 */
export interface DocumentMetadata {
  title?: string;
  authors?: string[];
  abstract?: string;
  year?: number;
  doi?: string;
  keywords?: string[];
  [key: string]: unknown;
}

/**
 * Chunking configuration.
 */
export interface ChunkingConfig {
  chunkSize?: number;
  chunkOverlap?: number;
  minChunkSize?: number;
}

/**
 * Embedding configuration.
 */
export interface EmbeddingConfig {
  model?: string;
  dimensions?: number;
}

/**
 * Retrieval configuration.
 */
export interface RetrievalConfig {
  topK?: number;
  scoreThreshold?: number;
  vectorWeight?: number;
  keywordWeight?: number;
}

/**
 * Search options.
 */
export interface SearchOptions {
  query: string;
  libraryIds?: string[];
  topK?: number;
  scoreThreshold?: number;
  retrieverType?: 'vector' | 'keyword' | 'hybrid';
}

/**
 * Enhanced search options.
 */
export interface EnhancedSearchOptions extends SearchOptions {
  enableQueryRewrite?: boolean;
  enableRerank?: boolean;
  enableContextRouting?: boolean;
  conversationHistory?: Array<{ role: string; content: string }>;
}

/**
 * Search result.
 */
export interface SearchResult {
  chunkId: string;
  documentId: string;
  libraryId: string;
  content: string;
  score: number;
  // Source info
  mediaType: MediaType;
  filename: string;
  bibKey?: string;
  citationText?: string;

  // Chunk metadata
  chunkMetadata: ChunkMetadata;

  // Highlight snippets (keyword search)
  highlights?: string[];

  // Legacy fields for backward compatibility
  metadata?: {
    filename?: string;
    pageNumber?: number;
    sectionTitle?: string;
    [key: string]: unknown;
  };
}

/**
 * Enhanced search result.
 */
export interface EnhancedSearchResult {
  results: SearchResult[];
  processingTime: number;
  rewrittenQuery?: string;
  appliedStrategies?: string[];
}

/**
 * RAG response.
 */
export interface RAGResponse {
  answer: string;
  sources: SearchResult[];
  citations: Citation[];
  context: string;
}

// ====== Supplemental Types ======

export type MediaType = 'pdf' | 'audio' | 'image' | 'markdown' | 'text' | 'latex' | 'url';

export interface ChunkMetadata {
  // PDF-specific
  page?: number;
  section?: string;

  // Audio-specific
  startTime?: number;
  endTime?: number;
  speaker?: string;

  // Image-specific
  imagePath?: string;

  // Extension fields
  extra?: Record<string, string | number | boolean | null>;
}

export interface Citation {
  id: string;
  bibKey: string;
  text: string;
  source: string;
  page?: number;
  timestamp?: number;
}

/**
 * Task status.
 */
export interface TaskStatus {
  taskId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress: number;
  message?: string;
  result?: unknown;
  error?: string;
}

/**
 * Queue statistics.
 */
export interface QueueStats {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
}

/**
 * Diagnostics info.
 */
export interface DiagnosticsInfo {
  initialized: boolean;
  libraryCount: number;
  documentCount: number;
  chunkCount: number;
  embeddingCount: number;
  storageSize?: number;
  errors?: string[];

  // Detailed stats
  ftsRecords?: number;
  embeddingDimensions?: number[];
  libraryStats?: Array<{ libraryId: string; chunks: number; embeddings: number }>;
}

/**
 * Advanced retrieval configuration.
 */
export interface AdvancedRetrievalConfig {
  enableQueryRewrite: boolean;
  enableRerank: boolean;
  enableContextRouting: boolean;
  enableBilingualRetrieval: boolean;
  rerankProvider:
    | 'dashscope'
    | 'cohere'
    | 'jina'
    | 'openai'
    | 'local'
    | 'siliconflow'
    | 'aihubmix'
    | 'custom';
  rerankModel?: string;
  rerankApiKey?: string;
  rerankBaseUrl?: string;
}

/**
 * Initialization options.
 */
export interface InitOptions {
  storagePath?: string;
  embeddingProvider?: 'openai' | 'ollama' | 'local';
  embeddingApiKey?: string;
  embeddingBaseUrl?: string;
  embeddingModel?: string;
  llmApiKey?: string;
  llmBaseUrl?: string;
  llmModel?: string;
  vlmProvider?: 'openai' | 'anthropic' | 'ollama' | 'custom';
  vlmApiKey?: string;
  vlmBaseUrl?: string;
  vlmModel?: string;
  whisperApiKey?: string;
  whisperBaseUrl?: string;
  whisperModel?: string;
  whisperLanguage?: string;
  visionApiKey?: string;
  visionBaseUrl?: string;
  advancedRetrieval?: Partial<AdvancedRetrievalConfig>;
}

/**
 * Create knowledge base parameters.
 */
export interface CreateLibraryParams {
  name: string;
  description?: string;
  chunkingConfig?: ChunkingConfig;
  embeddingConfig?: EmbeddingConfig;
  retrievalConfig?: RetrievalConfig;
}

/**
 * Add document options.
 */
export interface AddDocumentOptions {
  bibKey?: string;
  citationText?: string;
  metadata?: DocumentMetadata;
  processImmediately?: boolean;
}

/**
 * Selection clip data.
 * Used for monthly aggregation of selection excerpts.
 */
export interface ClipData {
  /** Selected text content. */
  text: string;
  /** Source application name (e.g., Chrome, Acrobat). */
  sourceApp?: string;
  /** Capture time (ISO 8601). */
  capturedAt: string;
  /** User note. */
  note?: string;
  /** Tags. */
  tags?: string[];
}

/**
 * Knowledge service interface.
 */
export interface IKnowledgeService extends Partial<IDisposable> {
  /**
   * Initializes service.
   */
  initialize(options: InitOptions): Promise<boolean>;

  /**
   * Checks whether service is initialized.
   */
  isInitialized(): boolean;

  /**
   * Updates configuration.
   * @sideeffect Reconfigures pipelines and providers
   */
  updateConfig(options: Partial<InitOptions>): Promise<void>;

  // ====== Knowledge Base Management ======

  /**
   * Creates a knowledge base.
   */
  createLibrary(params: CreateLibraryParams): Promise<KnowledgeBase>;

  /**
   * Returns all knowledge bases (sync snapshot).
   */
  getAllLibraries(): KnowledgeBase[];

  /**
   * Returns all knowledge bases (async).
   */
  getAllLibrariesAsync(): Promise<KnowledgeBase[]>;

  /**
   * Returns a knowledge base by id.
   */
  getLibrary(id: string): Promise<KnowledgeBase | null>;

  /**
   * Updates a knowledge base.
   */
  updateLibrary(id: string, updates: Partial<CreateLibraryParams>): Promise<KnowledgeBase>;

  /**
   * Deletes a knowledge base.
   */
  deleteLibrary(id: string): Promise<void>;

  // ====== Document Management ======

  /**
   * Adds a document.
   */
  addDocument(
    libraryId: string,
    filePath: string,
    options?: AddDocumentOptions
  ): Promise<{ documentId: string; taskId?: string }>;

  /**
   * Adds plain text.
   */
  addText(
    libraryId: string,
    content: string,
    options?: { title?: string; mediaType?: string; bibKey?: string; metadata?: DocumentMetadata }
  ): Promise<{ documentId: string; taskId?: string }>;

  /**
   * Adds a selection clip (monthly aggregation).
   * @sideeffect Appends to Clippings-YYYY-MM.md for the current month
   */
  addClip(libraryId: string, clip: ClipData): Promise<{ documentId: string; taskId?: string }>;

  /**
   * Returns a document by id.
   */
  getDocument(id: string): Promise<Document | null>;

  /**
   * Returns documents for a library (sync snapshot).
   */
  getDocumentsByLibrary(libraryId: string): Document[];

  /**
   * Returns documents for a library (async).
   */
  getDocumentsByLibraryAsync(libraryId: string): Promise<Document[]>;

  /**
   * Deletes a document.
   */
  deleteDocument(id: string): Promise<void>;

  /**
   * Reprocesses a document.
   */
  reprocessDocument(documentId: string): Promise<{ taskId: string }>;

  // ====== Retrieval ======

  /**
   * Runs basic search.
   */
  search(options: SearchOptions): Promise<SearchResult[]>;

  /**
   * Runs enhanced search (query rewrite, rerank, etc.).
   */
  searchEnhanced(options: EnhancedSearchOptions): Promise<EnhancedSearchResult>;

  /**
   * Executes a RAG query.
   */
  query(
    question: string,
    libraryIds?: string[],
    options?: { topK?: number; includeContext?: boolean }
  ): Promise<RAGResponse>;

  // ====== Task Management ======

  /**
   * Returns task status.
   */
  getTask(taskId: string): Promise<TaskStatus | null>;

  /**
   * Returns queue statistics.
   */
  getQueueStats(): Promise<QueueStats>;

  // ====== Maintenance ======

  /**
   * Tests embedding connectivity.
   */
  testEmbeddingConnection(): Promise<{ success: boolean; message: string }>;

  /**
   * Returns diagnostics info.
   */
  getDiagnostics(libraryId?: string): Promise<DiagnosticsInfo>;

  /**
   * Rebuilds FTS index.
   */
  rebuildFTSIndex(): Promise<{ success: boolean; recordCount: number }>;

  /**
   * Generates missing embeddings.
   */
  generateMissingEmbeddings(
    libraryId?: string
  ): Promise<{ success: boolean; generated: number; errors: number; remaining: number }>;

  /**
   * Returns advanced retrieval configuration.
   */
  getAdvancedRetrievalConfig(): AdvancedRetrievalConfig;

  /**
   * Sets advanced retrieval configuration.
   * @sideeffect Updates retrieval pipeline behavior
   */
  setAdvancedRetrievalConfig(config: Partial<AdvancedRetrievalConfig>): void;

  // ====== Events (EventEmitter) ======

  /**
   * Subscribes to an event.
   */
  on(event: string, listener: (...args: unknown[]) => void): this;

  /**
   * Removes an event listener.
   */
  off(event: string, listener: (...args: unknown[]) => void): this;

  /**
   * Emits an event.
   */
  emit(event: string, ...args: unknown[]): boolean;
}
